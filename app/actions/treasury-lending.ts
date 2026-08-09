"use server"

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import {
  getApprovalById,
  listApprovalsForUser,
  updateApprovalPayload,
  cancelApproval,
  revokeApprovedApproval,
} from "@/lib/approvals-db"
import { submitApproval } from "@/app/actions/approvals"
import { quoteDebitSettlement, terminateDebitFacility } from "@/app/actions/debit-settlement"
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
import type { TreasuryProfileKey, TreasuryTransaction } from "@/lib/treasury-store"
import {
  TREASURY_LENDING_ANNUAL_RATE,
  TREASURY_LENDING_COST_RATE,
  treasuryLendingAmount,
  treasuryLendingCost,
} from "@/lib/treasury-lending"

// ---------------------------------------------------------------------------
// Internal Treasury Capital Lending — customer self-service application.
//
// A client borrows their FULL security-deposit capital (PRO €500k /
// Avant-Garde €1m) internally. The lifecycle is:
//
//   apply  → administrator approves → client pays a one-time 1.88% lending
//   cost → the borrowed capital is drawn down (credited to the master account)
//   and, from that moment, carries a 3% p.a. debit interest.
//
// The money only moves at the PAYMENT step — approval alone credits nothing
// (the `treasury_lending` kind is deliberately absent from the approvals
// backbone's CREDIT_KINDS and carries no ledgerEffect). Every operation is
// server-authoritative: amounts are recomputed from the stored approval, the
// 1.88% cost is balance-gated against the master account, and a hard solvency
// assertion rolls back any overdraft. The drawdown is written as a "Treasury
// Financing" transaction so the existing 3% engine, reconciler and display
// pick it up automatically (see lib/treasury-financing.ts).
// ---------------------------------------------------------------------------

const TREASURY_HREF = "/dashboard/treasury"
const LENDING_CURRENCY = "EUR"

const PROFILE_LABELS: Record<TreasuryProfileKey, string> = {
  pro: "PRO Account",
  avantgarde: "Avant-Garde Account",
}

/** A light, client-serializable view of a treasury-lending request. */
export interface TreasuryLendingView {
  id: string
  status: string
  profile: TreasuryProfileKey
  profileLabel: string
  amount: number
  currency: string
  lendingCost: number
  lendingCostRate: number
  annualRate: number
  /** Set once the client has paid the lending cost and the capital is drawn. */
  fundedAt: string | null
  lendingCostPaidAt: string | null
  /** Set once the client has repaid the facility (principal + interest) and closed it. */
  closedAt: string | null
  createdAt: string
  decisionNote: string | null
}

interface LendingPayload {
  profile?: TreasuryProfileKey
  amount?: number
  lendingCost?: number
  lendingCostRate?: number
  annualRate?: number
  fundedAt?: string
  lendingCostPaidAt?: string
  drawdownTxnId?: string
  feeEntryId?: string
  creditEntryId?: string
  closedAt?: string
  repayPayoff?: number
}

/**
 * Total treasury financing principal still OUTSTANDING on the account (sum of
 * unsettled "Treasury Financing" deposit transactions — from either an admin
 * Treasury Financing or a prior internal lending drawdown). Used to refuse
 * financing a security deposit that is already financed, so the two channels
 * can never stack into a double principal.
 */
async function outstandingTreasuryFinancing(accountId: string): Promise<number> {
  try {
    const { rows } = await query(`SELECT transactions FROM treasury_accounts WHERE user_id = $1`, [accountId])
    if (!rows.length || !Array.isArray(rows[0].transactions)) return 0
    const txns = rows[0].transactions as Array<Record<string, unknown>>
    let total = 0
    for (const t of txns) {
      const label = t.label
      const amount = t.amount
      if (
        t.type === "deposit" &&
        typeof label === "string" &&
        label.startsWith("Treasury Financing") &&
        !t.settledAt &&
        typeof amount === "number" &&
        amount > 0
      ) {
        total += amount
      }
    }
    return round2(total)
  } catch (err) {
    console.log("[v0] outstandingTreasuryFinancing failed:", (err as Error).message)
    return 0
  }
}

/** Read the signed-in user's treasury account row (keyed by account id). */
async function readOwnTreasury(accountId: string): Promise<{ profile: TreasuryProfileKey; status: string } | null> {
  try {
    const { rows } = await query(`SELECT profile, status FROM treasury_accounts WHERE user_id = $1`, [accountId])
    if (rows.length === 0) return null
    const row = rows[0] as Record<string, unknown>
    return {
      profile: (row.profile as TreasuryProfileKey) ?? "pro",
      status: (row.status as string) ?? "none",
    }
  } catch {
    return null
  }
}

function toView(req: {
  id: string
  status: string
  amount: number | null
  currency: string | null
  payload: Record<string, unknown> | null
  createdAt: string
  decisionNote: string | null
}): TreasuryLendingView {
  const payload = (req.payload ?? {}) as LendingPayload
  const profile: TreasuryProfileKey = payload.profile === "avantgarde" ? "avantgarde" : "pro"
  const amount = Number(req.amount ?? payload.amount ?? treasuryLendingAmount(profile))
  return {
    id: req.id,
    status: req.status,
    profile,
    profileLabel: PROFILE_LABELS[profile],
    amount,
    currency: req.currency || LENDING_CURRENCY,
    lendingCost: Number(payload.lendingCost ?? treasuryLendingCost(amount)),
    lendingCostRate: Number(payload.lendingCostRate ?? TREASURY_LENDING_COST_RATE),
    annualRate: Number(payload.annualRate ?? TREASURY_LENDING_ANNUAL_RATE),
    fundedAt: payload.fundedAt ?? null,
    lendingCostPaidAt: payload.lendingCostPaidAt ?? null,
    closedAt: payload.closedAt ?? null,
    createdAt: req.createdAt,
    decisionNote: req.decisionNote,
  }
}

/** The signed-in user's treasury-lending requests (newest first). */
export async function getMyTreasuryLending(): Promise<TreasuryLendingView[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    const rows = await listApprovalsForUser(session.id, "treasury_lending")
    return rows
      .map((r) => toView(r))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  } catch (err) {
    console.log("[v0] getMyTreasuryLending failed:", (err as Error).message)
    return []
  }
}

export type ApplyLendingResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Apply to borrow the full security-deposit capital. The amount is fixed by the
 * client's treasury profile (server-authoritative). Refuses if there is no
 * established treasury account or a lending facility is already live.
 */
export async function applyForTreasuryLending(): Promise<ApplyLendingResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const treasury = await readOwnTreasury(session.id)
  if (!treasury || treasury.status === "none" || treasury.status === "closed") {
    return {
      ok: false,
      error: "A treasury account must be established before you can borrow its capital.",
    }
  }

  const profile = treasury.profile
  const label = PROFILE_LABELS[profile]
  const amount = treasuryLendingAmount(profile)
  const cost = treasuryLendingCost(amount)

  // Refuse if the security deposit is already financed (by an administrator
  // Treasury Financing or a prior internal lending). The deposit can only be
  // financed once up to its full amount — the two channels must never stack.
  const outstanding = await outstandingTreasuryFinancing(session.id)
  if (outstanding > 0.01) {
    return {
      ok: false,
      error:
        `Your ${label} security deposit is already financed ` +
        `(${LENDING_CURRENCY} ${outstanding.toLocaleString("en-US")} outstanding). ` +
        `It can't be borrowed again until the existing financing is repaid or settled.`,
    }
  }

  // Refuse a second facility while one is already pending or live (approved).
  try {
    const existing = await listApprovalsForUser(session.id, "treasury_lending")
    // A facility is "live" while pending, or approved and not yet repaid/closed.
    // A repaid (closedAt) or rejected facility no longer blocks a new request.
    const live = existing.find((r) => {
      if (r.status === "pending") return true
      if (r.status === "approved") return !((r.payload ?? {}) as LendingPayload).closedAt
      return false
    })
    if (live) {
      return {
        ok: false,
        error:
          live.status === "pending"
            ? "You already have a lending application under review."
            : "You already have an active capital lending facility.",
      }
    }
  } catch (err) {
    console.log("[v0] applyForTreasuryLending duplicate check failed:", (err as Error).message)
  }

  const res = await submitApproval({
    kind: "treasury_lending",
    title: `Treasury Capital Lending — ${label}`,
    summary: `Full internal lending of the ${label} security deposit (${LENDING_CURRENCY} ${amount.toLocaleString(
      "en-US",
    )}). One-time lending cost ${(TREASURY_LENDING_COST_RATE * 100).toFixed(2)}% = ${LENDING_CURRENCY} ${cost.toLocaleString(
      "en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}; borrowed capital carries ${(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest once funded.`,
    amount,
    currency: LENDING_CURRENCY,
    payload: {
      profile,
      amount,
      lendingCost: cost,
      lendingCostRate: TREASURY_LENDING_COST_RATE,
      annualRate: TREASURY_LENDING_ANNUAL_RATE,
    },
  })
  if (!res.ok) return { ok: false, error: res.error }

  void logActivity({
    action: `Applied for treasury capital lending (${label})`,
    category: "Treasury",
    userId: session.id,
    details: {
      facility: label,
      amount: `${LENDING_CURRENCY} ${amount.toLocaleString("en-US")}`,
      lendingCost: `${LENDING_CURRENCY} ${cost.toLocaleString("en-US")}`,
      decision: "Applied",
    },
  }).catch(() => {})

  return { ok: true, id: res.request.id }
}

export type PayLendingResult =
  | { ok: true; amount: number; cost: number }
  | { ok: false; error: string }

/**
 * Pay the one-time 1.88% lending cost and DRAW DOWN the borrowed capital. Only
 * valid on an APPROVED, not-yet-funded facility. Balance-gated on the master
 * account for the lending cost; on success it debits the cost, credits the
 * borrowed principal, and writes a "Treasury Financing" drawdown transaction
 * dated now so the 3% p.a. debit interest begins accruing from this moment.
 */
export async function payTreasuryLendingCost(approvalId: string): Promise<PayLendingResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const approval = await getApprovalById(approvalId)
  if (!approval || approval.kind !== "treasury_lending") {
    return { ok: false, error: "This lending facility could not be found." }
  }

  const ledgerOwnerId = session.dataOwnerId || (await resolveDataOwnerIdFor(session.id))
  if (approval.userId !== session.id && approval.userId !== ledgerOwnerId) {
    return { ok: false, error: "This lending facility could not be found." }
  }
  if (approval.status !== "approved") {
    return { ok: false, error: "The lending facility must be approved before the lending cost can be paid." }
  }

  const payload = (approval.payload ?? {}) as LendingPayload
  if (payload.fundedAt) {
    return { ok: false, error: "This lending facility has already been funded." }
  }

  const profile: TreasuryProfileKey = payload.profile === "avantgarde" ? "avantgarde" : "pro"
  const label = PROFILE_LABELS[profile]
  const amount = Number(approval.amount ?? payload.amount ?? treasuryLendingAmount(profile))
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "The lending amount is invalid." }
  }
  const cost = treasuryLendingCost(amount)

  // Re-assert the deposit is not already financed (e.g. an administrator
  // executed a Treasury Financing between application and payment). This
  // facility's own drawdown does not exist yet, so it never self-triggers.
  const outstanding = await outstandingTreasuryFinancing(session.id)
  if (outstanding > 0.01) {
    return {
      ok: false,
      error:
        `Your security deposit is already financed ` +
        `(${LENDING_CURRENCY} ${outstanding.toLocaleString("en-US")} outstanding), ` +
        `so this internal lending can't be drawn down. Nothing was charged.`,
    }
  }

  // Balance gate: the client must be able to pay the one-time lending cost.
  const entries = await readLedgerEntries(ledgerOwnerId)
  const availableEur = round2(availableByCurrency(entries)[LENDING_CURRENCY] ?? 0)
  if (availableEur + 0.01 < cost) {
    const shortfall = round2(cost - availableEur)
    const fmt = (n: number) =>
      `${LENDING_CURRENCY} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    return {
      ok: false,
      error:
        `Your master account balance can't cover the lending cost. ` +
        `The one-time cost is ${fmt(cost)}, available is ${fmt(Math.max(0, availableEur))} ` +
        `(short by ${fmt(shortfall)}). Nothing was charged.`,
    }
  }

  const now = new Date().toISOString()
  const feeEntryId = `TRYLEND-FEE-${approvalId}`
  const creditEntryId = `TRYLEND-${approvalId}`
  const drawdownTxnId = `TRYLEND-DRAW-${approvalId}`

  const feeEntry: LedgerEntry = {
    id: feeEntryId,
    direction: "debit",
    amount: cost,
    currency: LENDING_CURRENCY,
    status: "completed",
    date: now,
    counterparty: "MCC Capital — Treasury Lending Cost",
    reference: approvalId,
    category: "Treasury Lending Cost",
    comment: `One-time lending cost (${(TREASURY_LENDING_COST_RATE * 100).toFixed(
      2,
    )}%) on internal treasury capital lending of ${LENDING_CURRENCY} ${amount.toLocaleString("en-US")} (${label}).`,
  }
  const creditEntry: LedgerEntry = {
    id: creditEntryId,
    direction: "credit",
    amount,
    currency: LENDING_CURRENCY,
    status: "completed",
    date: now,
    counterparty: "MCC Capital — Treasury Capital Lending",
    reference: approvalId,
    category: "Treasury Financing",
    comment: `Internal treasury capital lending (${label}) drawn down to the master account. Carries ${(
      TREASURY_LENDING_ANNUAL_RATE * 100
    ).toFixed(0)}% p.a. debit interest from ${now}.`,
  }

  const written: string[] = []
  try {
    await upsertLedgerEntry(ledgerOwnerId, feeEntry)
    written.push(feeEntry.id)
    await upsertLedgerEntry(ledgerOwnerId, creditEntry)
    written.push(creditEntry.id)
    await assertOwnerSolvent(ledgerOwnerId)
  } catch (err) {
    for (const id of written) {
      try {
        await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, id])
      } catch {
        /* best-effort rollback */
      }
    }
    const msg = (err as Error).message
    if (msg.startsWith("INSUFFICIENT_FUNDS")) {
      return { ok: false, error: "Your master account balance can't cover the lending cost. Nothing was charged." }
    }
    console.log("[v0] payTreasuryLendingCost ledger post failed:", msg)
    return { ok: false, error: "The lending cost could not be charged. Please try again." }
  }

  // Write the drawdown as a "Treasury Financing" transaction so the existing 3%
  // engine, reconciler and treasury display all pick it up automatically. Dated
  // NOW so debit-interest accrues from the payment moment, per the spec.
  try {
    const { rows } = await query(`SELECT transactions FROM treasury_accounts WHERE user_id = $1`, [session.id])
    const txns: TreasuryTransaction[] = rows.length && Array.isArray(rows[0].transactions)
      ? (rows[0].transactions as TreasuryTransaction[])
      : []
    if (!txns.some((t) => t.id === drawdownTxnId)) {
      const drawdown: TreasuryTransaction = {
        id: drawdownTxnId,
        date: now,
        type: "deposit",
        label: `Treasury Financing — ${label}`,
        amount,
        currency: LENDING_CURRENCY,
        note: `Internal capital lending drawn down after paying the ${(
          TREASURY_LENDING_COST_RATE * 100
        ).toFixed(2)}% lending cost. Carries ${(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest.`,
      }
      const next = [...txns, drawdown]
      await query(`UPDATE treasury_accounts SET transactions = $2::jsonb, updated_at = $3 WHERE user_id = $1`, [
        session.id,
        JSON.stringify(next),
        now,
      ])
    }
  } catch (err) {
    // The money has already moved correctly; the drawdown record is for the 3%
    // accrual display. Roll back the ledger posts so state stays consistent.
    console.log("[v0] payTreasuryLendingCost drawdown write failed:", (err as Error).message)
    for (const id of written) {
      try {
        await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, id])
      } catch {
        /* best-effort */
      }
    }
    return { ok: false, error: "The drawdown could not be recorded. Please try again." }
  }

  // Mark the facility funded so it can't be paid twice and the UI shows it live.
  await updateApprovalPayload(approvalId, {
    ...payload,
    profile,
    amount,
    lendingCost: cost,
    lendingCostRate: TREASURY_LENDING_COST_RATE,
    annualRate: TREASURY_LENDING_ANNUAL_RATE,
    lendingCostPaidAt: now,
    fundedAt: now,
    drawdownTxnId,
    feeEntryId,
    creditEntryId,
  })

  try {
    await insertNotification({
      userId: session.id,
      tone: "success",
      title: "Treasury capital lending activated",
      body: `Your lending cost of ${LENDING_CURRENCY} ${cost.toLocaleString(
        "en-US",
      )} was paid and ${LENDING_CURRENCY} ${amount.toLocaleString(
        "en-US",
      )} was credited to your master account. It now carries ${(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(
        0,
      )}% p.a. debit interest.`,
      href: TREASURY_HREF,
    })
  } catch {
    /* notification is best-effort */
  }
  void logActivity({
    action: `Paid treasury lending cost and drew down capital (${label})`,
    category: "Treasury",
    userId: session.id,
    details: {
      facility: label,
      lendingCost: `${LENDING_CURRENCY} ${cost.toLocaleString("en-US")}`,
      borrowed: `${LENDING_CURRENCY} ${amount.toLocaleString("en-US")}`,
      annualInterest: `${(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a.`,
      decision: "Funded (client self-service)",
    },
  }).catch(() => {})

  return { ok: true, amount, cost }
}

// ---------------------------------------------------------------------------
// Repay & close — client self-service settlement of a live lending facility.
//
// A funded facility carries 3% p.a. debit interest until it is repaid. The
// payoff (borrowed principal + outstanding interest that has accrued but is not
// yet billed) is computed and settled by the SAME audited debit-settlement
// engine used on the Debits & Financing page — we key it on the drawdown
// transaction id so the quote, the master-balance gate, and the ledger posts
// all agree to the cent, and the drawdown is stamped `settledAt` so no further
// interest accrues. This is additive: the facility also remains settleable from
// /dashboard/debits, which shares the exact same engine.
// ---------------------------------------------------------------------------

/** Resolve a funded, not-yet-closed lending facility owned by the session. */
async function resolveLiveLending(
  approvalId: string,
): Promise<{ ok: true; drawdownTxnId: string } | { ok: false; error: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const approval = await getApprovalById(approvalId)
  if (!approval || approval.kind !== "treasury_lending") {
    return { ok: false, error: "This lending facility could not be found." }
  }
  const ledgerOwnerId = session.dataOwnerId || (await resolveDataOwnerIdFor(session.id))
  if (approval.userId !== session.id && approval.userId !== ledgerOwnerId) {
    return { ok: false, error: "This lending facility could not be found." }
  }
  const payload = (approval.payload ?? {}) as LendingPayload
  if (!payload.fundedAt || !payload.drawdownTxnId) {
    return { ok: false, error: "This facility has not been funded yet." }
  }
  if (payload.closedAt) {
    return { ok: false, error: "This lending facility is already closed." }
  }
  return { ok: true, drawdownTxnId: payload.drawdownTxnId }
}

export type LendingRepayQuoteResult =
  | {
      ok: true
      principal: number
      interest: number
      payoff: number
      currency: string
      available: number
      covered: boolean
      shortfall: number
    }
  | { ok: false; error: string }

/**
 * Read-only payoff to repay & close a funded facility: borrowed principal +
 * all outstanding 3% interest, and whether the master balance covers it.
 */
export async function quoteTreasuryLendingRepay(approvalId: string): Promise<LendingRepayQuoteResult> {
  const live = await resolveLiveLending(approvalId)
  if (!live.ok) return live
  const res = await quoteDebitSettlement("treasury", live.drawdownTxnId)
  if (!res.ok) return { ok: false, error: res.error }
  return {
    ok: true,
    principal: res.quote.principal,
    interest: round2(res.quote.interestTail + res.quote.dueNow),
    payoff: res.quote.payoff,
    currency: res.quote.currency,
    available: res.available,
    covered: res.covered,
    shortfall: res.shortfall,
  }
}

export type RepayLendingResult =
  | { ok: true; payoff: number; principal: number; interest: number; currency: string }
  | { ok: false; error: string }

/**
 * Repay & close a funded facility: settle principal + outstanding interest from
 * the master balance (blocked with a shortfall notice if it can't cover the
 * payoff), stop the 3% accrual, and mark the lending approval closed so the
 * client can borrow again in future.
 */
export async function repayTreasuryLending(approvalId: string): Promise<RepayLendingResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const live = await resolveLiveLending(approvalId)
  if (!live.ok) return { ok: false, error: live.error }

  const term = await terminateDebitFacility("treasury", live.drawdownTxnId)
  if (!term.ok) return { ok: false, error: term.error }

  const now = new Date().toISOString()
  const payload = ((await getApprovalById(approvalId))?.payload ?? {}) as LendingPayload
  await updateApprovalPayload(approvalId, {
    ...payload,
    closedAt: now,
    repayPayoff: term.quote.payoff,
  })

  const interest = round2(term.quote.interestTail + term.quote.dueNow)
  void logActivity({
    action: `Repaid & closed treasury capital lending (payoff ${term.quote.currency} ${term.quote.payoff.toLocaleString("en-US")})`,
    category: "Treasury",
    userId: session.id,
    details: {
      principal: `${term.quote.currency} ${term.quote.principal.toLocaleString("en-US")}`,
      interest: `${term.quote.currency} ${interest.toLocaleString("en-US")}`,
      totalPayoff: `${term.quote.currency} ${term.quote.payoff.toLocaleString("en-US")}`,
      decision: "Repaid & closed (client self-service)",
    },
  }).catch(() => {})

  return {
    ok: true,
    payoff: term.quote.payoff,
    principal: term.quote.principal,
    interest,
    currency: term.quote.currency,
  }
}

// ---------------------------------------------------------------------------
// Revoke — client self-service cancellation of a lending facility on which NO
// money has moved yet. Two safe cases:
//   • a PENDING application still under administrator review → withdrawn; and
//   • an APPROVED but NOT-yet-funded facility → declined before drawdown.
// In both cases the client has paid nothing and nothing was credited (the money
// only moves at the pay/drawdown step), so cancelling simply frees them to
// apply again. A FUNDED facility can never be revoked here — it must be settled
// through "Repay & close" — and a closed one is already done.
// ---------------------------------------------------------------------------

export type RevokeLendingResult =
  | { ok: true; wasApproved: boolean }
  | { ok: false; error: string }

export async function revokeTreasuryLending(approvalId: string): Promise<RevokeLendingResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const approval = await getApprovalById(approvalId)
  if (!approval || approval.kind !== "treasury_lending") {
    return { ok: false, error: "This lending facility could not be found." }
  }

  const ledgerOwnerId = session.dataOwnerId || (await resolveDataOwnerIdFor(session.id))
  if (approval.userId !== session.id && approval.userId !== ledgerOwnerId) {
    return { ok: false, error: "This lending facility could not be found." }
  }

  const payload = (approval.payload ?? {}) as LendingPayload
  if (payload.fundedAt && !payload.closedAt) {
    return {
      ok: false,
      error: "This facility is already funded. Use “Repay & close” to settle and close it.",
    }
  }
  if (payload.closedAt) {
    return { ok: false, error: "This lending facility is already closed." }
  }

  const profile: TreasuryProfileKey = payload.profile === "avantgarde" ? "avantgarde" : "pro"
  const label = PROFILE_LABELS[profile]

  let wasApproved: boolean
  if (approval.status === "pending") {
    const res = await cancelApproval(approvalId, approval.userId)
    if (!res) return { ok: false, error: "This application can no longer be withdrawn." }
    wasApproved = false
  } else if (approval.status === "approved") {
    const res = await revokeApprovedApproval(
      approvalId,
      approval.userId,
      "Lending facility declined by the client before drawdown.",
    )
    if (!res) return { ok: false, error: "This facility can no longer be declined." }
    wasApproved = true
  } else {
    return { ok: false, error: "This facility can no longer be revoked." }
  }

  void logActivity({
    action: wasApproved
      ? `Declined an approved treasury capital lending before drawdown (${label})`
      : `Withdrew a treasury capital lending application (${label})`,
    category: "Treasury",
    userId: session.id,
    details: {
      facility: label,
      decision: wasApproved ? "Declined before drawdown (client self-service)" : "Withdrawn (client self-service)",
    },
  }).catch(() => {})

  return { ok: true, wasApproved }
}
