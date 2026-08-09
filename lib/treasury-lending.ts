import { round2 } from "@/lib/interest-accrual"
import type { TreasuryProfileKey } from "@/lib/treasury-store"

/**
 * Internal Treasury Capital Lending.
 *
 * A client may borrow their FULL security-deposit capital internally:
 *   • PRO         → €500,000
 *   • Avant-Garde → €1,000,000
 *
 * Lifecycle:
 *   1. Client applies (a `treasury_lending` approval request).
 *   2. Administrator approves.
 *   3. Client pays a ONE-TIME lending cost = borrowed amount × 1.88%.
 *   4. Only ONCE the lending cost is paid is the borrowed capital drawn down
 *      and credited to the master account, and from that moment the borrowed
 *      treasury carries a 3% p.a. debit interest.
 *
 * The 3% accrual is handled by the existing treasury-financing engine
 * (lib/treasury-financing.ts): the payment step writes a "Treasury Financing"
 * drawdown transaction dated at the payment moment, so the standard 3% monthly
 * accrual, reconciler and treasury display all apply with no extra wiring.
 */

/** One-time lending cost rate charged on the borrowed amount (1.88%). */
export const TREASURY_LENDING_COST_RATE = 0.0188

/** Annual debit interest on the borrowed treasury capital (3% p.a.). */
export const TREASURY_LENDING_ANNUAL_RATE = 0.03

/** Full security-deposit capital a client may borrow, by profile (EUR). */
export const TREASURY_LENDING_AMOUNTS: Record<TreasuryProfileKey, number> = {
  pro: 500_000,
  avantgarde: 1_000_000,
}

/** Borrowable capital for a treasury profile (defaults to PRO). */
export function treasuryLendingAmount(profile: TreasuryProfileKey): number {
  return TREASURY_LENDING_AMOUNTS[profile] ?? TREASURY_LENDING_AMOUNTS.pro
}

/** The one-time lending cost (1.88%) for a borrowed amount, rounded to cents. */
export function treasuryLendingCost(amount: number): number {
  return round2(Math.max(0, amount) * TREASURY_LENDING_COST_RATE)
}
