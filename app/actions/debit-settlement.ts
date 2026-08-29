"use server"

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import {
  getApprovalById,
  listApprovalsForUser,
  updateApprovalPayload,
} from "@/lib/approvals-db"
import {
  readLedgerEntries,
  availableByCurrency,
  upsertLedgerEntry,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import { query } from "@/lib/db"
import { logActivity } from "@/app/actions/log-activity"
import { insertNotification } from "@/lib/notifications-db"
import { round2 } from "@/lib/interest-accrual"
import type { LedgerEntry } from "@/lib/ledger-store"
import type { DebitKind } from "@/lib/debit-schedule"
import {
  buildTerminationPlan,
  buildReconcilePosts,
  quoteFacility,
  type SettlePost,
  type SettlementQuote,
} from "@/lib/debit-settlement"
import type { ProjectFundingRequest } from "@/lib/project-funding-store"
import type { MonetizationRequest } from "@/lib/monetization-requests-store"
import type { LeverageRequest } from "@/lib/leverage-requests-store"
import type { TreasuryAccount, TreasuryTransaction } from "@/lib/treasury-store"
import { treasuryFinancingTxns } from "@/lib/treasury-financing"
import type { InternalLoanRecordLike } from "@/lib/internal-loan"

// ---------------------------------------------------------------------------
// Client self-service debit-facility settlement (Debits & Financing page).
//
// A client may REVERSE / TERMINATE or RECONCILE any of their four financing
// products directly, with NO administrator step. Every operation is FULLY
// SERVER-AUTHORITATIVE:
//
//   • The facility's records are read from the database here (never trusted
//     from the client), so the payoff math cannot be tampered with.
//   • The payoff is gated against the MASTER ACCOUNT BALANCE: if the available
//     balance cannot cover it, the termination is BLOCKED with a shortfall
//     notice and NOTHING is posted.
//   • All ledger posts carry deterministic ids and are upserted, so a retry or
//     a reconcile-then-terminate can never double-charge.
//   • After posting, a hard DB-level solvency assertion runs; any violation
//     rolls the whole operation back.
//
// The heavy money math lives in lib/debit-settlement.ts (pure, shared with the
// client display) — this module only enforces identity, ownership, the balance
// gate, persistence, and audit.
// ---------------------------------------------------------------------------

const DEBITS_HREF = "/dashboard/debits"

/**
 * Run a database read with one short retry. Serverless cold starts and brief
 * connection blips are the usual cause of an otherwise-valid settlement quote
 * failing with "could not compute" — a single retry turns that dead-end into a
 * reliable read without masking a genuine logic error (the money math is pure
 * and unaffected). Throws the last error only if BOTH attempts fail.
 */
async function readWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.log(`[v0] ${label} read failed, retrying once:`, (err as Error).message)
    await new Promise((r) => setTimeout(r, 150))
    return await fn()
  }
}

/** The five-product record bundle the pure engine needs, read server-side. */
interface OwnerFacilities {
  funding: ProjectFundingRequest[]
  monetization: MonetizationRequest[]
  leverage: LeverageRequest[]
  treasury: TreasuryAccount | null
  internalLoans: InternalLoanRecordLike[]
}

interface ResolvedFacility {
  /** The account whose facility this is (session account). */
  accountId: string
  /** The ledger owner (Master) the payoff posts to. */
  ledgerOwnerId: string
  /** All four products for the account, for the pure engine. */
  facilities: OwnerFacilities
  /** The DB approval id (funding / monetization / leverage), if applicable. */
  approvalId?: string
}

function rebuildRecord<T extends { id: string }>(payload: Record<string, unknown> | null | undefined): T | null {
  const record = (payload?.record as T | undefined) ?? undefined
  return record && typeof record === "object" && record.id ? record : null
}

/** Read the treasury account (keyed by the account id, not the ledger owner). */
async function readTreasuryAccount(accountId: string): Promise<TreasuryAccount | null> {
  try {
    const { rows } = await query(`SELECT * FROM treasury_accounts WHERE user_id = $1`, [accountId])
    if (rows.length === 0) return null
    const row = rows[0] as Record<string, unknown>
    const txns = Array.isArray(row.transactions) ? (row.transactions as TreasuryTransaction[]) : []
    return {
      profile: (row.profile as TreasuryAccount["profile"]) ?? "pro",
      currency: (row.currency as string) ?? "EUR",
      requiredDeposit: Number(row.required_deposit) || 0,
      customerContribution: Number(row.customer_contribution) || 0,
      leverageEnabled: Boolean(row.leverage_enabled),
      leverageRatio: Number(row.leverage_ratio) || 1,
      financedAmount: Number(row.financed_amount) || 0,
      transactionExposure: Number(row.transaction_exposure) || 0,
      skrCollateral: Number(row.skr_collateral) || 0,
      feeRate: Number(row.fee_rate) || 0.018,
      status: (row.status as TreasuryAccount["status"]) ?? "pending",
      transactions: txns,
    }
  } catch {
    return null
  }
}

/**
 * Resolve one facility (by kind + id) to its owning account, the ledger owner,
 * and the full four-product record bundle — all read authoritatively from the
 * database and ownership-checked against the signed-in session.
 */
async function resolveFacility(
  kind: DebitKind,
  facilityId: string,
): Promise<{ ok: true; resolved: ResolvedFacility } | { ok: false; error: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const accountId = session.id
  const ledgerOwnerId = session.dataOwnerId || (await resolveDataOwnerIdFor(accountId))

  const empty: OwnerFacilities = { funding: [], monetization: [], leverage: [], treasury: null, internalLoans: [] }

  if (kind === "treasury") {
    const treasury = await readTreasuryAccount(accountId)
    const txn = treasuryFinancingTxns(treasury).find((t) => t.id === facilityId)
    if (!treasury || !txn) return { ok: false, error: "This financing could not be found." }
    return {
      ok: true,
      resolved: { accountId, ledgerOwnerId, facilities: { ...empty, treasury } },
    }
  }

  // Approval-backed products: load by approval id (facilityId IS the approval id
  // for these; the client passes the facility's approvalId).
  const approval = await readWithRetry(() => getApprovalById(facilityId), "getApprovalById")
  if (!approval) return { ok: false, error: "This facility could not be found." }
  // Ownership: the facility must belong to the signed-in account or its owner.
  if (approval.userId !== accountId && approval.userId !== ledgerOwnerId) {
    return { ok: false, error: "This facility could not be found." }
  }

  const kindToApprovalKind: Record<Exclude<DebitKind, "treasury">, string> = {
    funding: "project_funding",
    monetization: "monetization",
    leverage: "leverage",
    internal_loan: "internal_loan",
  }
  if (approval.kind !== kindToApprovalKind[kind]) {
    return { ok: false, error: "This facility could not be settled here." }
  }
  if (approval.status !== "approved") {
    return { ok: false, error: "Only an active, funded facility can be settled." }
  }

  const facilities: OwnerFacilities = { ...empty }
  if (kind === "funding") {
    const rec = rebuildRecord<ProjectFundingRequest>(approval.payload)
    if (!rec) return { ok: false, error: "This facility could not be found." }
    facilities.funding = [rec]
  } else if (kind === "monetization") {
    const rec = rebuildRecord<MonetizationRequest>(approval.payload)
    if (!rec) return { ok: false, error: "This facility could not be found." }
    facilities.monetization = [rec]
  } else if (kind === "internal_loan") {
    const rec = rebuildRecord<InternalLoanRecordLike>(approval.payload)
    if (!rec) return { ok: false, error: "This facility could not be found." }
    // Every internal-loan ledger id is keyed on the DB APPROVAL id (the server
    // reconciler posts with the real approval id), so stamp it onto the record
    // before it reaches the engine so the settlement legs net exactly.
    facilities.internalLoans = [{ ...rec, approvalId: approval.id }]
  } else {
    const rec = rebuildRecord<LeverageRequest>(approval.payload)
    if (!rec) return { ok: false, error: "This facility could not be found." }
    facilities.leverage = [rec]
  }

  return { ok: true, resolved: { accountId, ledgerOwnerId, facilities, approvalId: approval.id } }
}

/** The local id the pure engine keys a facility on (approval id ⇒ record.id). */
function engineFacilityId(resolved: ResolvedFacility, kind: DebitKind): string {
  if (kind === "funding") return resolved.facilities.funding[0]?.id ?? ""
  if (kind === "monetization") return resolved.facilities.monetization[0]?.id ?? ""
  if (kind === "leverage") return resolved.facilities.leverage[0]?.id ?? ""
  if (kind === "internal_loan") {
    const rec = resolved.facilities.internalLoans[0]
    return rec ? (rec.approvalId ?? rec.id) : ""
  }
  return "" // treasury sets it explicitly by txn id
}

// --- Public result shapes ---------------------------------------------------

export interface QuoteResult {
  ok: true
  quote: SettlementQuote
  /** Available master balance in the facility currency at quote time. */
  available: number
  /** True when the balance fully covers the termination payoff. */
  covered: boolean
  /** Shortfall (payoff − available), 0 when covered. */
  shortfall: number
}
export type SettlementActionResult =
  | QuoteResult
  | { ok: false; error: string }

export interface TerminateResult {
  ok: true
  quote: SettlementQuote
  /** Number of ledger rows posted (catch-up + settlement legs). */
  posted: number
}
export interface ReconcileResult {
  ok: true
  /** Amount posted to bring the facility current. */
  posted: number
  /** Number of ledger rows posted. */
  rows: number
}

// --- Quote (read-only) ------------------------------------------------------

/**
 * Compute the payoff to TERMINATE a facility and whether the master balance
 * covers it. Read-only: no ledger writes. Used to render the confirm dialog.
 */
export async function quoteDebitSettlement(
  kind: DebitKind,
  facilityId: string,
): Promise<SettlementActionResult> {
  try {
    const res = await resolveFacility(kind, facilityId)
    if (!res.ok) return res
    const { resolved } = res
    const entries = await readWithRetry(() => readLedgerEntries(resolved.ledgerOwnerId), "readLedgerEntries")
    const engId = kind === "treasury" ? facilityId : engineFacilityId(resolved, kind)

    const quote = quoteFacility({
      kind,
      facilityId: engId,
      ...resolved.facilities,
      entries,
    })
    if (!quote) return { ok: false, error: "This facility has already been settled." }

    const avail = availableByCurrency(entries)[quote.currency] ?? 0
    const available = round2(avail)
    const covered = available + 0.01 >= quote.payoff
    const shortfall = covered ? 0 : round2(quote.payoff - available)
    return { ok: true, quote, available, covered, shortfall }
  } catch (err) {
    console.log("[v0] quoteDebitSettlement failed:", kind, facilityId, (err as Error).message, (err as Error).stack)
    return { ok: false, error: "Could not compute the settlement. Please try again." }
  }
}

// --- Shared post writer -----------------------------------------------------

/**
 * Upsert a batch of settlement/reconcile posts to the ledger owner, then run a
 * hard solvency assertion. On any overdraft the whole batch is rolled back by
 * deleting exactly the rows we wrote and the error is surfaced. Deterministic
 * ids make the upserts idempotent.
 */
async function postAndAssert(
  ledgerOwnerId: string,
  posts: SettlePost[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const written: string[] = []
  for (const p of posts) {
    const entry: LedgerEntry = { ...p.entry, direction: p.direction }
    await upsertLedgerEntry(ledgerOwnerId, entry)
    written.push(entry.id)
  }
  try {
    await assertOwnerSolvent(ledgerOwnerId)
    return { ok: true }
  } catch (err) {
    // Roll back everything we just posted so no partial debit can remain.
    for (const id of written) {
      try {
        await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, id])
      } catch {
        /* best-effort rollback */
      }
    }
    const msg = (err as Error).message
    if (msg.startsWith("INSUFFICIENT_FUNDS")) {
      return { ok: false, error: "Your master account balance can't cover this. Nothing was charged." }
    }
    return { ok: false, error: "The settlement could not be completed. Please try again." }
  }
}

// --- Reconcile (post due charges only) --------------------------------------

/**
 * Bring a facility CURRENT: post every monthly debit-interest charge that has
 * come due but is not yet on the ledger. Balance-gated and idempotent. Does not
 * close the facility.
 */
export async function reconcileDebitFacility(
  kind: DebitKind,
  facilityId: string,
): Promise<ReconcileResult | { ok: false; error: string }> {
  try {
    const res = await resolveFacility(kind, facilityId)
    if (!res.ok) return res
    const { resolved } = res
    const entries = await readWithRetry(() => readLedgerEntries(resolved.ledgerOwnerId), "readLedgerEntries")
    const engId = kind === "treasury" ? facilityId : engineFacilityId(resolved, kind)

    const posts = buildReconcilePosts({
      kind,
      facilityId: engId,
      ...resolved.facilities,
      entries,
    })
    if (posts.length === 0) return { ok: true, posted: 0, rows: 0 }

    const posted = round2(posts.reduce((s, p) => s + p.entry.amount, 0))
    const write = await postAndAssert(resolved.ledgerOwnerId, posts)
    if (!write.ok) return write

    void logActivity({
      action: `Reconciled ${kind} facility (posted ${posts.length} due charge${posts.length === 1 ? "" : "s"})`,
      category: "Debits & Financing",
      userId: resolved.accountId,
      details: { facilityId, posted, rows: posts.length, decision: "Reconciled" },
    }).catch(() => {})

    return { ok: true, posted, rows: posts.length }
  } catch (err) {
    console.log("[v0] reconcileDebitFacility failed:", kind, facilityId, (err as Error).message, (err as Error).stack)
    return { ok: false, error: "The reconciliation could not be completed. Please try again." }
  }
}

// --- Terminate (reverse + settle from balance) ------------------------------

/**
 * REVERSE / TERMINATE a facility: post any due catch-up charges, then settle the
 * principal + outstanding interest tail (+ early-exit fee for AES funding) from
 * the master balance, and mark the facility closed so it stops accruing. Blocks
 * with a shortfall notice if the balance can't cover the full payoff.
 */
export async function terminateDebitFacility(
  kind: DebitKind,
  facilityId: string,
): Promise<TerminateResult | { ok: false; error: string }> {
  try {
    const res = await resolveFacility(kind, facilityId)
    if (!res.ok) return res
    const { resolved } = res
    const entries = await readWithRetry(() => readLedgerEntries(resolved.ledgerOwnerId), "readLedgerEntries")
    const engId = kind === "treasury" ? facilityId : engineFacilityId(resolved, kind)

    const plan = buildTerminationPlan({
      kind,
      facilityId: engId,
      ...resolved.facilities,
      entries,
    })
    if (!plan) return { ok: false, error: "This facility has already been settled." }

    // Server-authoritative balance gate: block (post nothing) on a shortfall.
    const available = availableByCurrency(entries)[plan.quote.currency] ?? 0
    if (round2(available) + 0.01 < plan.quote.payoff) {
      const shortfall = round2(plan.quote.payoff - available)
      return {
        ok: false,
        error:
          `Your master account balance can't cover this termination. ` +
          `Payoff is ${plan.quote.currency} ${plan.quote.payoff.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, ` +
          `available is ${plan.quote.currency} ${round2(available).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
          `(short by ${plan.quote.currency} ${shortfall.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). ` +
          `Nothing was charged.`,
      }
    }

    // Post catch-up + settlement legs together, then assert solvency (rolls back
    // on any overdraft). All ids deterministic ⇒ idempotent.
    const allPosts = [...plan.reconcilePosts, ...plan.settlementPosts]
    const write = await postAndAssert(resolved.ledgerOwnerId, allPosts)
    if (!write.ok) return write

    // Persist the closed state on the facility record so it stops accruing and
    // is reflected on every device.
    const persisted = await persistClosure(kind, facilityId, resolved, plan.closePatch)
    if (!persisted.ok) {
      // Roll the ledger posts back so we never leave a charge without a close.
      for (const p of allPosts) {
        try {
          await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [
            resolved.ledgerOwnerId,
            p.entry.id,
          ])
        } catch {
          /* best-effort */
        }
      }
      return persisted
    }

    try {
      await insertNotification({
        userId: resolved.accountId,
        tone: "info",
        title: "Financing terminated",
        body: `Your ${labelForKind(kind)} was reversed and settled. A payoff of ${plan.quote.currency} ${plan.quote.payoff.toLocaleString("en-US")} (principal, outstanding interest${plan.quote.fee > 0 ? ", and early-exit fee" : ""}) was debited from your master account.`,
        href: DEBITS_HREF,
      })
    } catch {
      /* notification is best-effort */
    }
    void logActivity({
      action: `Terminated ${kind} facility "${plan.quote.title}" (payoff ${plan.quote.currency} ${plan.quote.payoff.toLocaleString("en-US")})`,
      category: "Debits & Financing",
      userId: resolved.accountId,
      details: {
        facilityId,
        principal: `${plan.quote.currency} ${plan.quote.principal.toLocaleString("en-US")}`,
        interest: `${plan.quote.currency} ${round2(plan.quote.interestTail + plan.quote.dueNow).toLocaleString("en-US")}`,
        fee: `${plan.quote.currency} ${plan.quote.fee.toLocaleString("en-US")}`,
        totalPayoff: `${plan.quote.currency} ${plan.quote.payoff.toLocaleString("en-US")}`,
        decision: "Terminated (client self-service)",
      },
    }).catch(() => {})

    return { ok: true, quote: plan.quote, posted: allPosts.length }
  } catch (err) {
    console.log("[v0] terminateDebitFacility failed:", kind, facilityId, (err as Error).message, (err as Error).stack)
    return { ok: false, error: "The termination could not be completed. Please try again." }
  }
}

function labelForKind(kind: DebitKind): string {
  switch (kind) {
    case "funding":
      return "AES project finance facility"
    case "monetization":
      return "credit facility"
    case "leverage":
      return "leverage line"
    case "treasury":
      return "treasury financing"
    case "internal_loan":
      return "internal loan"
  }
}

/**
 * Persist the "closed" patch onto the facility's source record so it stops
 * accruing. Approval-backed products merge the patch into `payload.record`;
 * treasury sets `settledAt` on the drawdown transaction in `treasury_accounts`.
 */
async function persistClosure(
  kind: DebitKind,
  facilityId: string,
  resolved: ResolvedFacility,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (kind === "treasury") {
      const settledAt = (patch.settledAt as string) ?? new Date().toISOString()
      const { rows } = await query(`SELECT transactions FROM treasury_accounts WHERE user_id = $1`, [
        resolved.accountId,
      ])
      if (rows.length === 0) return { ok: false, error: "This financing could not be found." }
      const txns = Array.isArray(rows[0].transactions) ? (rows[0].transactions as TreasuryTransaction[]) : []
      const next = txns.map((t) => (t.id === facilityId ? { ...t, settledAt } : t))
      const upd = await query(
        `UPDATE treasury_accounts SET transactions = $2::jsonb, updated_at = $3 WHERE user_id = $1`,
        [resolved.accountId, JSON.stringify(next), new Date().toISOString()],
      )
      if ((upd.rowCount ?? 0) === 0) return { ok: false, error: "The termination could not be saved. Please try again." }
      return { ok: true }
    }

    // Approval-backed: merge into payload.record.
    const approvalId = resolved.approvalId ?? facilityId
    const approval = await getApprovalById(approvalId)
    if (!approval) return { ok: false, error: "This facility could not be found." }
    const prevPayload = approval.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    const updated = await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: { ...prevRecord, ...patch },
    })
    if (!updated) return { ok: false, error: "The termination could not be saved. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] persistClosure failed:", (err as Error).message)
    return { ok: false, error: "The termination could not be saved. Please try again." }
  }
}
