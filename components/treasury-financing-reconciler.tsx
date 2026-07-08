"use client"

import { useEffect, useRef } from "react"
import { useLedger } from "@/lib/ledger-store"
import { useTreasury, getProfile } from "@/lib/treasury-store"
import { buildTreasuryFinancingLedgerPosts, TREASURY_FINANCING_CURRENCY } from "@/lib/treasury-financing"
import { nextMonthEndAfter } from "@/lib/interest-accrual"
import { notifyTreasuryInterestDebit } from "@/app/actions/notifications"

/**
 * Headless reconciler that keeps the master account ledger in sync with the
 * 3% p.a. debit interest on Special Treasury Financing.
 *
 * On every dashboard mount (and whenever the treasury record or ledger change)
 * it posts any monthly treasury-financing interest charges that have come due
 * since the financing date. All posts are idempotent (deterministic ids), so
 * this never double-posts. It mirrors FundingCapitalReconciler exactly,
 * including the `attemptedRef` loop-breaker that prevents the write →
 * revalidate → refetch storm that a transient ledger refetch could otherwise
 * trigger (see that component for the full rationale).
 */
export function TreasuryFinancingReconciler() {
  const { account, hydrated: treasuryHydrated } = useTreasury()
  const { entries, addDebit, balanceFor, hydrated: ledgerHydrated } = useLedger()

  // Ids posted (or attempted) this session — the loop breaker. Tracking
  // attempts in a ref (not state) guarantees each id is posted at most once per
  // session regardless of what `entries` momentarily contains; server upserts
  // are idempotent so durability is unaffected.
  const attemptedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!treasuryHydrated || !ledgerHydrated) return

    const existingIds = new Set(entries.map((e) => e.id))
    for (const id of attemptedRef.current) existingIds.add(id)

    const posts = buildTreasuryFinancingLedgerPosts(account, existingIds)
    if (posts.length === 0) return

    // Running EUR balance so each per-charge notice reports the balance
    // remaining immediately AFTER that specific debit. balanceFor() reflects
    // the pre-post balance (this pass's writes haven't re-rendered yet), so we
    // subtract each debit cumulatively as we post them.
    let runningBalance = balanceFor(TREASURY_FINANCING_CURRENCY)
    const tierLabel = account ? getProfile(account.profile).label : undefined
    const nextDeductionAt = nextMonthEndAfter(new Date()).toISOString()

    for (const post of posts) {
      // Mark attempted BEFORE writing so a re-render mid-flight cannot re-post.
      attemptedRef.current.add(post.entry.id)
      addDebit(post.entry)
      runningBalance = Math.round((runningBalance - post.entry.amount + Number.EPSILON) * 100) / 100

      // Emit one notification per newly-posted charge. The action dedupes on the
      // charge id, so even if a post is retried the client sees it only once.
      void notifyTreasuryInterestDebit({
        chargeId: post.entry.id,
        amount: post.entry.amount,
        remainingBalance: runningBalance,
        nextDeductionAt,
        tierLabel,
      })
    }
  }, [account, entries, treasuryHydrated, ledgerHydrated, addDebit, balanceFor])

  return null
}
