// Server-safe leverage debit-interest math.
//
// This lives OUTSIDE the "use client" leverage store so it can be called from
// server actions (settlement / termination) as well as client components. It
// was previously defined in `lib/leverage-requests-store.tsx` ("use client"),
// which made every server-side call to `accruedInterest` throw
// "Attempted to call accruedInterest() from the server but it is on the client"
// — that broke `terminateDebitFacility` / `quoteDebitSettlement` for leverage
// lines. Keep this module free of any client-only imports.
import { debitInterestRateFor } from "@/lib/leverage-rates"
import type { LeverageRequest } from "@/lib/leverage-requests-store"

export const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

// Compute the debit interest accrued on a line's borrowed amount between
// activation and the given point in time (defaults to now). For closed lines
// the accrual stops at the close timestamp. Returns 0 for lines that were
// never activated.
//
// When an admin has modified the ratio, interest accrues in segments: each
// segment runs at the borrowed amount that was in force during that window, so
// the position is charged fairly across every ratio it has carried.
export function accruedInterest(request: LeverageRequest, asOf: number = Date.now()): number {
  if (!request.activatedAt) return 0
  const start = new Date(request.activatedAt).getTime()
  const end = request.closedAt ? new Date(request.closedAt).getTime() : asOf
  if (end <= start) return 0

  const mods = (request.modifications ?? [])
    .slice()
    .sort((a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime())

  let total = 0
  let cursor = start
  let borrowed = mods.length > 0 ? mods[0].fromBorrowed : request.borrowedAmount
  let ratio = mods.length > 0 ? mods[0].fromRatio : request.leverageRatio

  for (const mod of mods) {
    const boundary = Math.min(new Date(mod.appliedAt).getTime(), end)
    if (boundary > cursor) {
      total += borrowed * debitInterestRateFor(ratio) * ((boundary - cursor) / MS_PER_YEAR)
      cursor = boundary
    }
    borrowed = mod.toBorrowed
    ratio = mod.toRatio
    if (cursor >= end) break
  }

  if (end > cursor) {
    total += borrowed * debitInterestRateFor(ratio) * ((end - cursor) / MS_PER_YEAR)
  }
  return total
}
