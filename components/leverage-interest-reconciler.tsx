"use client"

import { useEffect, useRef } from "react"
import { useLedger } from "@/lib/ledger-store"
import { useLeverageRequests } from "@/lib/leverage-requests-store"
import { buildLeverageInterestPosts } from "@/lib/leverage-financing"

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
  const { entries, addDebit, hydrated: ledgerHydrated } = useLedger()

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

    for (const post of posts) {
      // Mark attempted BEFORE writing so a re-render mid-flight cannot re-post.
      attemptedRef.current.add(post.entry.id)
      addDebit(post.entry)
    }
  }, [requests, entries, leverageHydrated, ledgerHydrated, addDebit])

  return null
}
