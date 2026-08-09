import type { LedgerEntry } from "@/lib/ledger-store"
import type { TreasuryAccount, TreasuryTransaction } from "@/lib/treasury-store"
import {
  accruedInterestToDate,
  monthlyInterestAmount,
  monthlyInterestCharges,
} from "@/lib/interest-accrual"

/**
 * Special Treasury Financing -> Master Account integration.
 *
 * When the Administrator executes a €500,000 (PRO) or €1,000,000 (Avant-Garde)
 * treasury financing on a client's behalf, the financed amount is credited to
 * the client's EUR balance and logged as a treasury deposit transaction.
 *
 * That financed principal carries a 3% annual debit interest, charged monthly
 * (3% / 12) from the EXACT day it was credited, with the first (and any
 * settlement) month pro-rated to the active days. As with project funding,
 * charges are posted lazily at each elapsed calendar month-end with
 * deterministic ids so reconciliation never double-posts.
 *
 * The financing principal & its start date are read from the treasury deposit
 * transaction(s) the admin action writes (label prefixed "Treasury Financing").
 */

/** Annual debit interest rate on special treasury financing (3%). */
export const TREASURY_FINANCING_ANNUAL_RATE = 0.03

/** Label prefix used by `adminTreasuryFinancing` for its deposit transaction. */
const TREASURY_FINANCING_LABEL_PREFIX = "Treasury Financing"

/** Currency of treasury financing (always EUR). */
export const TREASURY_FINANCING_CURRENCY = "EUR"

/** Whether a treasury transaction is an admin treasury financing drawdown. */
export function isTreasuryFinancingTxn(txn: TreasuryTransaction): boolean {
  return (
    txn.type === "deposit" &&
    typeof txn.label === "string" &&
    txn.label.startsWith(TREASURY_FINANCING_LABEL_PREFIX) &&
    txn.amount > 0
  )
}

/**
 * The effective accrual cut-off for a drawdown. Interest accrues from the
 * drawdown date up to `now`, UNLESS the client has reversed/terminated the
 * financing — in which case a `settledAt` marker caps accrual at the payoff
 * moment so no further monthly interest is charged after termination.
 */
function accrualCutoff(txn: TreasuryTransaction, now: Date): Date {
  const settled = (txn as { settledAt?: string }).settledAt
  if (settled) {
    const s = new Date(settled)
    if (!Number.isNaN(s.getTime()) && s.getTime() < now.getTime()) return s
  }
  return now
}

/** All treasury financing drawdowns on an account (each a financed principal). */
export function treasuryFinancingTxns(account: TreasuryAccount | null | undefined): TreasuryTransaction[] {
  if (!account || !Array.isArray(account.transactions)) return []
  return account.transactions.filter(isTreasuryFinancingTxn)
}

/** Total financed treasury principal currently outstanding. */
export function treasuryFinancingPrincipal(account: TreasuryAccount | null | undefined): number {
  return treasuryFinancingTxns(account).reduce((sum, t) => sum + Math.max(0, t.amount), 0)
}

/** Whether a financing drawdown has been settled (repaid / terminated). */
function isSettledFinancingTxn(txn: TreasuryTransaction): boolean {
  const settled = (txn as { settledAt?: string }).settledAt
  return typeof settled === "string" && settled.length > 0
}

/**
 * Treasury financing principal that is still OUTSTANDING (excludes drawdowns
 * that have already been repaid / terminated). This is the figure that caps how
 * much of the security deposit can still be financed: a deposit already financed
 * up to its full amount — whether by an administrator Treasury Financing or a
 * prior internal capital lending — must not be financed again.
 */
export function outstandingTreasuryFinancingPrincipal(account: TreasuryAccount | null | undefined): number {
  return treasuryFinancingTxns(account)
    .filter((t) => !isSettledFinancingTxn(t))
    .reduce((sum, t) => sum + Math.max(0, t.amount), 0)
}

/** One full month's treasury financing interest on a principal (3% ÷ 12). */
export function monthlyTreasuryInterest(principal: number): number {
  return monthlyInterestAmount(Math.max(0, principal), TREASURY_FINANCING_ANNUAL_RATE)
}

/** Deterministic ledger id for a month's treasury financing interest charge. */
export function treasuryInterestChargeId(txnId: string, yearMonth: string): string {
  return `TRY-INT-${txnId}-${yearMonth}`
}

/** Treasury financing interest accrued to date across all drawdowns. */
export function accruedTreasuryInterest(
  account: TreasuryAccount | null | undefined,
  asOf: Date = new Date(),
): number {
  let total = 0
  for (const txn of treasuryFinancingTxns(account)) {
    const start = new Date(txn.date)
    if (Number.isNaN(start.getTime())) continue
    total += accruedInterestToDate(txn.amount, TREASURY_FINANCING_ANNUAL_RATE, start, accrualCutoff(txn, asOf))
  }
  return Math.round((total + Number.EPSILON) * 100) / 100
}

export interface PendingLedgerPost {
  direction: "credit" | "debit"
  entry: Omit<LedgerEntry, "direction">
}

/**
 * Build every treasury financing interest charge that has come due but is not
 * yet on the ledger (checked against `existingIds`). One charge stream per
 * financing drawdown, accruing from that drawdown's date with pro-rata first
 * month. Oldest charge first for chronological ledger order.
 */
export function buildTreasuryFinancingLedgerPosts(
  account: TreasuryAccount | null | undefined,
  existingIds: Set<string>,
  now: Date = new Date(),
): PendingLedgerPost[] {
  const posts: PendingLedgerPost[] = []

  for (const txn of treasuryFinancingTxns(account)) {
    const start = new Date(txn.date)
    if (Number.isNaN(start.getTime())) continue

    for (const charge of monthlyInterestCharges(txn.amount, TREASURY_FINANCING_ANNUAL_RATE, start, accrualCutoff(txn, now))) {
      const chargeId = treasuryInterestChargeId(txn.id, charge.yearMonth)
      if (existingIds.has(chargeId)) continue
      const proNote = charge.prorated
        ? ` (pro-rated ${(charge.fraction * 100).toFixed(0)}% — accrual began on the financing date)`
        : ""
      posts.push({
        direction: "debit",
        entry: {
          id: chargeId,
          amount: charge.amount,
          currency: txn.currency || TREASURY_FINANCING_CURRENCY,
          status: "completed",
          date: charge.date.toISOString(),
          counterparty: "MCC Capital — Treasury Financing Interest",
          reference: txn.id,
          category: "Treasury Interest",
          comment: `Monthly debit interest (3% p.a. ÷ 12) on treasury financing for ${charge.yearMonth}${proNote}.`,
        },
      })
    }
  }

  return posts.sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime())
}
