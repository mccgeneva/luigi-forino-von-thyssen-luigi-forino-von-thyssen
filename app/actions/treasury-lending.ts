"use server"

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import {
  getApprovalById,
  listApprovalsForUser,
  updateApprovalPayload,
} from "@/lib/approvals-db"
import { submitApproval } from "@/app/actions/approvals"
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
  const amount = treasuryLendingAmount(profile)
  const cost = treasuryLendingCost(amount)

  // Refuse a second facility while one is already pending or live (approved).
  try {
    const existing = await listApprovalsForUser(session.id, "treasury_lending")
    const live = existing.find((r) => r.status === "pending" || r.status === "approved")
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

  const label = PROFILE_LABELS[profile]
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
