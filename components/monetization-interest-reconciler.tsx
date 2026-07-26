"use client"

import { useEffect, useRef } from "react"
import { useLedger } from "@/lib/ledger-store"
import { useMonetizationRequests } from "@/lib/monetization-requests-store"
import { buildMonetizationInterestPosts } from "@/lib/monetization-financing"
import { computeTieredInterest, describeTranches } from "@/lib/tiered-debit-interest"
import { nextMonthEndAfter } from "@/lib/interest-accrual"
import { notifyMonetizationInterestDebit } from "@/app/actions/notifications"

/**
 * Headless reconciler that keeps the client's ledger in sync with the monthly
 * tiered debit interest on APPROVED monetization facilities (loans /
 * non-recourse credits).
 *
 * On every dashboard mount (and whenever the monetization requests or ledger
 * change) it posts any monthly credit-facility interest charges that have come
 * due since each facility's approval (funding) date. All posts are idempotent
 * (deterministic ids) so it never double-posts. It mirrors
 * LeverageInterestReconciler exactly, including the `attemptedRef` loop-breaker
 * that prevents a write -> revalidate -> refetch storm.
 */
export function MonetizationInterestReconciler() {
  const { requests, hydrated: monetizationHydrated } = useMonetizationRequests()
  const { entries, addDebit, balanceFor, hydrated: ledgerHydrated } = useLedger()

  // Ids posted (or attempted) this session — the loop breaker. Tracking
  // attempts in a ref (not state) guarantees each id posts at most once per
  // session regardless of what `entries` momentarily contains; server upserts
  // are idempotent so durability is unaffected.
  const attemptedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!monetizationHydrated || !ledgerHydrated) return

    const existingIds = new Set(entries.map((e) => e.id))
    for (const id of attemptedRef.current) existingIds.add(id)

    const posts = buildMonetizationInterestPosts(requests, existingIds)
    if (posts.length === 0) return

    // Running balance PER CURRENCY so each per-charge notice reports the balance
    // remaining immediately AFTER that specific debit. balanceFor() reflects the
    // pre-post balance (this pass's writes haven't re-rendered yet), so we
    // subtract each debit cumulatively as we post them.
    const runningBalance = new Map<string, number>()
    const nextDeductionAt = nextMonthEndAfter(new Date()).toISOString()

    for (const post of posts) {
      // Mark attempted BEFORE writing so a re-render mid-flight cannot re-post.
      attemptedRef.current.add(post.entry.id)
      addDebit(post.entry)

      const currency = post.entry.currency
      const prev = runningBalance.has(currency) ? (runningBalance.get(currency) as number) : balanceFor(currency)
      const remaining = Math.round((prev - post.entry.amount + Number.EPSILON) * 100) / 100
      runningBalance.set(currency, remaining)

      // Look up the originating facility (entry.reference === request.id) for the
      // blended rate and tranche breakdown shown in the notification copy.
      const req = requests.find((r) => r.id === post.entry.reference)
      const priced = req ? computeTieredInterest(req.grossProceeds) : null
      void notifyMonetizationInterestDebit({
        chargeId: post.entry.id,
        amount: post.entry.amount,
        currency,
        remainingBalance: remaining,
        nextDeductionAt,
        effectiveRate: priced?.effectiveRate ?? 0,
        facilityRef: req ? `${req.instrumentType} ${req.instrumentId}` : post.entry.reference ?? post.entry.id,
        trancheSummary: priced ? describeTranches(priced) : undefined,
      })
    }
  }, [requests, entries, monetizationHydrated, ledgerHydrated, addDebit, balanceFor])

  return null
}
