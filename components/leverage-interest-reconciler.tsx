"use client"

import { useEffect, useRef } from "react"
import { useLedger } from "@/lib/ledger-store"
import { useLeverageRequests, debitInterestRateFor } from "@/lib/leverage-requests-store"
import { buildLeverageInterestPosts } from "@/lib/leverage-financing"
import { nextMonthEndAfter } from "@/lib/interest-accrual"
import { notifyLeverageInterestDebit } from "@/app/actions/notifications"

/**
 * Headless reconciler that keeps the client's ledger in sync with the monthly
 * debit interest on active leverage lines (borrowed funds).
 *
 * On every dashboard mount (and whenever the leverage lines or ledger change)
 * it posts any monthly leverage-interest charges that have come due since each
 * line's activation date. All posts are idempotent (deterministic ids), so it
 * never double-posts. It mirrors TreasuryFinancingReconciler exactly, including
 * the `attemptedRef` loop-breaker that prevents the write -> revalidate ->
 * refetch storm a transient ledger refetch could otherwise trigger.
 */
export function LeverageInterestReconciler() {
  const { requests, hydrated: leverageHydrated } = useLeverageRequests()
  const { entries, addDebit, balanceFor, hydrated: ledgerHydrated } = useLedger()

  // Ids posted (or attempted) this session — the loop breaker. Tracking
  // attempts in a ref (not state) guarantees each id posts at most once per
  // session regardless of what `entries` momentarily contains; server upserts
  // are idempotent so durability is unaffected.
  const attemptedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!leverageHydrated || !ledgerHydrated) return

    const existingIds = new Set(entries.map((e) => e.id))
    for (const id of attemptedRef.current) existingIds.add(id)

    const posts = buildLeverageInterestPosts(requests, existingIds)
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

      // Look up the originating line (entry.reference === line.id) for the
      // ratio and rate shown in the notification copy.
      const line = requests.find((r) => r.id === post.entry.reference)
      void notifyLeverageInterestDebit({
        chargeId: post.entry.id,
        amount: post.entry.amount,
        currency,
        remainingBalance: remaining,
        nextDeductionAt,
        leverageRatio: line?.leverageRatio ?? 0,
        annualRate: line ? debitInterestRateFor(line.leverageRatio) : 0,
      })
    }
  }, [requests, entries, leverageHydrated, ledgerHydrated, addDebit, balanceFor])

  return null
}
