import "server-only"
import { query } from "@/lib/db"
import { convertCurrency } from "@/lib/fx"
import { readLedgerEntries, upsertLedgerEntry } from "@/lib/ledger-db"
import type { LedgerEntry } from "@/lib/ledger-store"

/**
 * Controlled Master Account Overdraft.
 *
 * A Master Account may go negative (aggregate, EUR-equivalent) up to a ceiling
 * of OVERDRAFT_RATE × the customer's SECURED Treasury Security Deposit (paid-in
 * contribution + SKR collateral + financed portion), so that
 * automatic PLATFORM CHARGES & FEES can still be debited when positive funds are
 * exhausted. Ordinary outgoing money movement (payments, exchanges, transfers)
 * still requires positive funds via assertOwnerSolvent — the overdraft is for
 * charges only.
 *
 * The overdraft ceiling is derived DYNAMICALLY from the treasury deposit, and a
 * negative balance feeds the Guarantees Accumulator (higher risk) + hard-blocks
 * new leverage/financing.
 */

/** Overdraft ceiling as a fraction of the secured treasury security deposit. */
export const OVERDRAFT_RATE = 0.08

/** All overdraft math is done in this base currency. */
const BASE = "EUR"

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export interface OverdraftStatus {
  /** Secured treasury security deposit (contribution + SKR collateral + financed), EUR. */
  depositBaseEur: number
  /** Maximum the account may go negative = OVERDRAFT_RATE × depositBaseEur. */
  limitEur: number
  /** Current aggregate settled balance across all currencies, EUR-equivalent. */
  balanceEur: number
  /** How negative the account currently is (0 when positive). */
  negativeEur: number
  /** Remaining overdraft headroom before the ceiling is reached. */
  remainingEur: number
  /** Fraction of the ceiling currently used (0..1, for the display bar). */
  usageRatio: number
  /**
   * Negative balance relative to the ceiling, UNCLAMPED. 0 when positive, 1.0
   * exactly at the ceiling, and >1 when the account has BREACHED the authorized
   * overdraft (e.g. 5.0 = five times the ceiling). Drives risk escalation so a
   * deep, illogical overdraft is reflected instead of saturating at the ceiling.
   */
  breachRatio: number
  /** True when the account is currently overdrawn (settled balance < 0). */
  inOverdraft: boolean
  /** True when an overdraft facility exists at all (a deposit is posted). */
  available: boolean
}

/**
 * Pure overdraft status from a deposit base and the current settled balance
 * (both EUR). Deterministic — used by the readers below and unit-testable.
 */
export function computeOverdraftStatus(depositBaseEur: number, balanceEur: number): OverdraftStatus {
  const base = Math.max(0, depositBaseEur || 0)
  const limitEur = round2(base * OVERDRAFT_RATE)
  const bal = round2(balanceEur || 0)
  const negativeEur = bal < 0 ? round2(-bal) : 0
  const remainingEur = round2(Math.max(0, limitEur - negativeEur))
  const usageRatio = limitEur > 0 ? Math.min(1, Math.max(0, negativeEur / limitEur)) : negativeEur > 0 ? 1 : 0
  // Unclamped: how many times the ceiling the account is negative by. A value
  // above 1 means the authorized overdraft has been BREACHED. When there is no
  // ceiling (no deposit) any negative counts as a full breach.
  const breachRatio = negativeEur <= 0 ? 0 : limitEur > 0 ? round2(negativeEur / limitEur) : 1
  return {
    depositBaseEur: base,
    limitEur,
    balanceEur: bal,
    negativeEur,
    remainingEur,
    usageRatio: round2(usageRatio),
    breachRatio,
    inOverdraft: bal < -0.01,
    available: limitEur > 0,
  }
}

/**
 * Secured treasury security deposit for an owner, in EUR. This is the base the
 * overdraft ceiling is 8% of: the FULL security deposit securing the facility —
 * the customer's paid-in contribution + SKR collateral + the financed/leveraged
 * portion. A deposit that is financed still secures the account, so it is
 * authorized for overdraft on the whole secured amount (per policy). A
 * closed/none treasury has no secured deposit and therefore no overdraft
 * facility.
 */
export async function getTreasuryDepositBaseEur(ownerId: string): Promise<number> {
  try {
    const { rows } = await query(
      `SELECT currency, customer_contribution, skr_collateral, financed_amount, status
         FROM treasury_accounts WHERE user_id = $1`,
      [ownerId],
    )
    if (!rows.length) return 0
    const r = rows[0] as Record<string, unknown>
    const status = (r.status as string) ?? ""
    if (status === "closed" || status === "none") return 0
    const cur = ((r.currency as string) || BASE).toUpperCase()
    // The SECURED security deposit = everything actually securing the facility:
    // paid-in contribution + SKR collateral + the financed/leveraged portion.
    // Financed deposits are authorized for overdraft on the full secured amount.
    const securedDeposit =
      (Number(r.customer_contribution) || 0) +
      (Number(r.skr_collateral) || 0) +
      (Number(r.financed_amount) || 0)
    if (securedDeposit <= 0) return 0
    return round2(convertCurrency(securedDeposit, cur, BASE))
  } catch {
    return 0
  }
}

/**
 * Aggregate SETTLED (completed) balance for an owner across all currencies,
 * EUR-equivalent. Holds (reservations) are excluded — the overdraft measures a
 * real settled deficit, not a pending block. Sub-account-tagged rows are
 * excluded (isolated compartments, not the shared master pool). Value-neutral
 * FX-cover rows net to ~0 so they do not distort the aggregate.
 */
export async function getSettledBalanceEur(ownerId: string): Promise<number> {
  const entries = await readLedgerEntries(ownerId)
  const perCur: Record<string, number> = {}
  for (const e of entries) {
    if (e.status !== "completed") continue
    if (e.subAccountId) continue
    const c = (e.currency || "USD").toUpperCase()
    perCur[c] = (perCur[c] ?? 0) + (e.direction === "credit" ? e.amount : -e.amount)
  }
  let sum = 0
  for (const [c, v] of Object.entries(perCur)) sum += convertCurrency(v, c, BASE)
  return round2(sum)
}

/** Full overdraft status for an owner (deposit base + current settled balance). */
export async function getOverdraftStatusForOwner(ownerId: string): Promise<OverdraftStatus> {
  const [base, bal] = await Promise.all([getTreasuryDepositBaseEur(ownerId), getSettledBalanceEur(ownerId)])
  return computeOverdraftStatus(base, bal)
}

/**
 * Would posting an additional charge of `chargeEur` keep the account within its
 * controlled overdraft ceiling? Pure. A charge is allowed when the projected
 * balance stays at or above −limit (one-cent tolerance).
 */
export function chargeWithinOverdraft(status: OverdraftStatus, chargeEur: number): boolean {
  const projected = status.balanceEur - Math.max(0, chargeEur)
  return projected >= -status.limitEur - 0.01
}

export interface PostChargeResult {
  ok: boolean
  /** Set when the charge was refused because it would breach the 8% ceiling. */
  overLimit?: boolean
  status: OverdraftStatus
}

/**
 * Post a platform CHARGE/FEE to a Master Account, honouring the controlled
 * overdraft ceiling. The charge may drive the account negative, but only within
 * OVERDRAFT_RATE × the treasury deposit. If it would breach the ceiling the
 * charge is REFUSED (not posted) and { ok:false, overLimit:true } is returned so
 * the caller can surface/defer it. `entry` must be a completed debit; `amount`
 * is in `entry.currency`. Idempotent via the entry id (upsert).
 */
export async function postChargeWithinOverdraft(ownerId: string, entry: LedgerEntry): Promise<PostChargeResult> {
  const status = await getOverdraftStatusForOwner(ownerId)
  const chargeEur = convertCurrency(Math.max(0, entry.amount || 0), (entry.currency || BASE).toUpperCase(), BASE)
  if (!chargeWithinOverdraft(status, chargeEur)) {
    return { ok: false, overLimit: true, status }
  }
  await upsertLedgerEntry(ownerId, entry)
  return { ok: true, status: computeOverdraftStatus(status.depositBaseEur, status.balanceEur - chargeEur) }
}
