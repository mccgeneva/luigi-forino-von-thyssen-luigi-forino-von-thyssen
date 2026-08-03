import type { LedgerEntry } from "@/lib/ledger-store"
import type { MonetizationRequest } from "@/lib/monetization-requests-store"
import { dueMonthEnds, monthActiveFraction, round2, yearMonthKey } from "@/lib/interest-accrual"
import { blendedAnnualRate, computeTieredInterest } from "@/lib/tiered-debit-interest"

/**
 * Monetization facility -> balance integration (monthly tiered debit interest).
 *
 * When a monetization (loan / non-recourse credit) is APPROVED, its gross
 * proceeds are credited to the client's balance. Those proceeds are the
 * outstanding debit and carry a PROGRESSIVE (tiered) debit interest — priced
 * marginally per tranche (see `lib/tiered-debit-interest.ts`). The total annual
 * interest is fixed at approval by the facility size, so we derive a single
 * blended effective rate and charge 1/12 of the annual interest each calendar
 * month from the funding (approval) date, with the funding month pro-rated to
 * the millisecond.
 *
 * This mirrors `leverage-financing.ts`: it builds the due monthly charges with
 * deterministic ids so the client-side reconciler never double-posts.
 */

/** A single pending monetization interest ledger post (always a debit). */
export interface PendingMonetizationPost {
  direction: "debit"
  entry: Omit<LedgerEntry, "direction">
}

/** Deterministic ledger id for a month's monetization interest charge. */
export function monetizationInterestChargeId(requestId: string, yearMonth: string): string {
  return `MON-INT-${requestId}-${yearMonth}`
}

/**
 * A monetization is accruing monthly interest once it has been APPROVED (funds
 * credited) and NOT yet reversed/terminated. Accrual starts on `decidedAt` (the
 * approval / credit date) and stops on `closedAt` (client termination).
 */
function isAccruingMonetization(r: MonetizationRequest): boolean {
  return r.status === "approved" && !!r.decidedAt && r.grossProceeds > 0 && !r.closedAt
}

/**
 * Build every monthly monetization-interest charge that has come due but is not
 * yet on the ledger (checked against `existingIds`). One charge stream per
 * approved facility, accruing from its approval date with a pro-rated first
 * month. Oldest charge first for chronological ledger order.
 */
export function buildMonetizationInterestPosts(
  requests: MonetizationRequest[] | null | undefined,
  existingIds: Set<string>,
  now: Date = new Date(),
): PendingMonetizationPost[] {
  const posts: PendingMonetizationPost[] = []
  if (!Array.isArray(requests)) return posts

  for (const req of requests) {
    if (!isAccruingMonetization(req)) continue
    const start = new Date(req.decidedAt as string)
    if (Number.isNaN(start.getTime())) continue

    // Facility interest is fixed at approval by the gross proceeds. The blended
    // rate × proceeds === total annual interest, so a flat monthly amount of
    // (totalAnnualInterest / 12) reproduces the tranche sum exactly.
    const priced = computeTieredInterest(req.grossProceeds)
    if (priced.totalAnnualInterest <= 0) continue
    const monthlyAmount = priced.monthlyInterest
    const effRatePct = (priced.effectiveRate * 100).toFixed(3)

    for (const monthEnd of dueMonthEnds(start, now)) {
      const yearMonth = yearMonthKey(monthEnd)
      const chargeId = monetizationInterestChargeId(req.id, yearMonth)
      if (existingIds.has(chargeId)) continue

      const fraction = monthActiveFraction(monthEnd.getFullYear(), monthEnd.getMonth(), start)
      if (fraction <= 0) continue
      const amount = round2(monthlyAmount * fraction)
      if (amount <= 0) continue

      const prorated = fraction < 0.999
      const proNote = prorated ? " (pro-rated — accrual began on the funding date)" : ""
      posts.push({
        direction: "debit",
        entry: {
          id: chargeId,
          amount,
          currency: req.proceedsCurrency,
          status: "completed",
          date: monthEnd.toISOString(),
          counterparty: "MCC Capital — Credit Facility Interest",
          reference: req.id,
          category: "Monetization Interest",
          comment: `Monthly tiered debit interest (blended ${effRatePct}% p.a. ÷ 12) on ${req.instrumentType} ${req.instrumentId} credit facility for ${yearMonth}${proNote}.`,
        },
      })
    }
  }

  return posts.sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime())
}

/**
 * Total monetization interest already posted for a facility, summed from the
 * ledger by matching the deterministic charge-id prefix. Available for future
 * settlement/early-repayment flows so they never double-charge.
 */
export function postedMonetizationInterest(
  requestId: string,
  entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>,
): number {
  const prefix = `MON-INT-${requestId}-`
  let sum = 0
  for (const e of entries) {
    if (typeof e.id === "string" && e.id.startsWith(prefix)) sum += e.amount
  }
  return round2(sum)
}

/** Convenience re-export so callers have one import site for facility pricing. */
export { blendedAnnualRate }
