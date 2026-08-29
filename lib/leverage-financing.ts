import type { LedgerEntry } from "@/lib/ledger-store"
import { accruedInterest } from "@/lib/leverage-interest"
import { debitInterestRateFor } from "@/lib/leverage-rates"
import { type LeverageRequest } from "@/lib/leverage-requests-store"
import { dueMonthEnds, round2, yearMonthKey } from "@/lib/interest-accrual"

/**
 * Leverage line -> balance integration (monthly debit interest).
 *
 * When a leverage line is activated, its borrowed funds are credited to the
 * client's balance. Those borrowed funds carry a debit interest set by the
 * risk-based scale (higher leverage → higher rate; see lib/leverage-rates.ts)
 * and must be charged MONTHLY from the activation date so the balance reflects
 * the accruing cost over time — not only as a single lump at switch-off.
 *
 * This module builds the due monthly interest charges for every active line,
 * with deterministic ids so the client-side reconciler never double-posts. The
 * per-month amount is derived from the audited, modification-aware
 * `accruedInterest` engine (difference of cumulative accrual across the charged
 * window), so ratio changes are billed fairly across every window they applied
 * to, and the funding + settlement months are pro-rated to the millisecond.
 */

/** A single pending leverage interest ledger post (always a debit). */
export interface PendingLeveragePost {
  direction: "debit"
  entry: Omit<LedgerEntry, "direction">
}

/** Deterministic ledger id for a month's leverage interest charge on a line. */
export function leverageInterestChargeId(lineId: string, yearMonth: string): string {
  return `LEV-INT-${lineId}-${yearMonth}`
}

/**
 * A line is currently live and accruing monthly interest when it has been
 * activated and not yet closed. `switchoff_pending` lines are still live (the
 * borrowed funds are still outstanding) until the admin settles the switch-off.
 */
function isAccruingLine(line: LeverageRequest): boolean {
  return (line.status === "approved" || line.status === "switchoff_pending") && !!line.activatedAt && !line.closedAt
}

/**
 * Build every monthly leverage-interest charge that has come due but is not yet
 * on the ledger (checked against `existingIds`). One charge stream per active
 * line, accruing from its activation date with a pro-rated first month. Oldest
 * charge first for chronological ledger order.
 */
export function buildLeverageInterestPosts(
  requests: LeverageRequest[] | null | undefined,
  existingIds: Set<string>,
  now: Date = new Date(),
): PendingLeveragePost[] {
  const posts: PendingLeveragePost[] = []
  if (!Array.isArray(requests)) return posts

  for (const line of requests) {
    if (!isAccruingLine(line)) continue
    const start = new Date(line.activatedAt as string)
    if (Number.isNaN(start.getTime())) continue

    for (const monthEnd of dueMonthEnds(start, now)) {
      const yearMonth = yearMonthKey(monthEnd)
      const chargeId = leverageInterestChargeId(line.id, yearMonth)
      if (existingIds.has(chargeId)) continue

      // Segment-aware month charge = cumulative accrual to this month-end minus
      // cumulative accrual to the start of the charged window (max of the line
      // activation and the first of the month). Reuses the modification-aware
      // accrual engine so every ratio window is billed correctly.
      const monthStart = new Date(monthEnd.getFullYear(), monthEnd.getMonth(), 1, 0, 0, 0, 0)
      const windowStartMs = Math.max(start.getTime(), monthStart.getTime())
      const amount = round2(accruedInterest(line, monthEnd.getTime()) - accruedInterest(line, windowStartMs))
      if (amount <= 0) continue

      const prorated = windowStartMs > monthStart.getTime()
      const proNote = prorated ? " (pro-rated — accrual began on the activation date)" : ""
      posts.push({
        direction: "debit",
        entry: {
          id: chargeId,
          amount,
          currency: line.currency,
          status: "completed",
          date: monthEnd.toISOString(),
          counterparty: "MCC Capital — Leverage Financing Interest",
          reference: line.id,
          category: "Leverage Interest",
          comment: `Monthly debit interest (${(debitInterestRateFor(line.leverageRatio) * 100).toFixed(2)}% p.a. ÷ 12) on ${line.accountLabel} 1:${line.leverageRatio} borrowed funds for ${yearMonth}${proNote}.`,
        },
      })
    }
  }

  return posts.sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime())
}

/**
 * Total leverage interest already posted month-by-month for a line, summed from
 * the ledger by matching the deterministic charge-id prefix. Used at switch-off
 * so the settlement charges only the interest NOT already collected monthly,
 * preventing a double charge.
 */
export function postedLeverageInterest(lineId: string, entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>): number {
  const prefix = `LEV-INT-${lineId}-`
  let sum = 0
  for (const e of entries) {
    if (typeof e.id === "string" && e.id.startsWith(prefix)) sum += e.amount
  }
  return round2(sum)
}
