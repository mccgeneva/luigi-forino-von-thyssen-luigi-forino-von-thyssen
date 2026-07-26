// ---------------------------------------------------------------------------
// Adaptive Composite (tiered / marginal) debit-interest engine.
//
// Loans and non-recourse credit facilities (all monetization structures) are
// priced with a PROGRESSIVE debit interest rate — exactly like income-tax
// brackets. Interest is applied only to the portion of the facility that falls
// within each tier, so the client never pays the highest rate on the whole
// facility, only on the excess above each threshold. As the facility grows, the
// blended (effective) annual rate rises gradually toward the top tier but never
// reaches it.
//
//   Facility portion        Annual rate
//   0 – 5M                   1.80%
//   5M – 10M                 2.00%
//   10M – 50M                2.40%
//   50M – 100M               2.60%
//   100M – 500M              3.00%
//   above 500M               3.50%
//
// This module is pure and framework-free so it can be unit-reasoned about and
// reused by the financing builder, the reconciler, the client dialog and the
// admin views. Amounts are treated in the facility's own currency unit (the
// same numeric thresholds apply per currency, per the product spec's
// "€/$/£ 5M" tier definition).
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (currency minor units). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** A single bracket in the progressive schedule. `upTo: null` = unbounded top tier. */
export interface DebitInterestTier {
  /** Inclusive lower bound of the tranche (facility amount). */
  from: number
  /** Exclusive upper bound, or null for the unbounded top tier. */
  upTo: number | null
  /** Annual debit interest rate applied to the portion within this tranche. */
  annualRate: number
}

/**
 * Authoritative tier table. Kept as a single exported constant so the schedule
 * can be adjusted in one maintainable place without touching the math. Tiers
 * MUST be contiguous and ordered; the top tier is unbounded (`upTo: null`).
 */
export const DEBIT_INTEREST_TIERS: readonly DebitInterestTier[] = [
  { from: 0, upTo: 5_000_000, annualRate: 0.018 },
  { from: 5_000_000, upTo: 10_000_000, annualRate: 0.02 },
  { from: 10_000_000, upTo: 50_000_000, annualRate: 0.024 },
  { from: 50_000_000, upTo: 100_000_000, annualRate: 0.026 },
  { from: 100_000_000, upTo: 500_000_000, annualRate: 0.03 },
  { from: 500_000_000, upTo: null, annualRate: 0.035 },
] as const

/** The realized interest for one tranche of a specific facility. */
export interface TrancheBreakdown {
  /** Lower bound of the tranche. */
  from: number
  /** Upper bound of the tranche (null = unbounded top tier). */
  upTo: number | null
  /** Annual rate applied to this tranche. */
  annualRate: number
  /** Portion of THIS facility that falls within the tranche (0 if none). */
  portion: number
  /** Annual interest contributed by this tranche (portion × annualRate). */
  annualInterest: number
}

/** Full result of pricing a facility under the progressive schedule. */
export interface TieredInterestResult {
  /** The facility amount that was priced (gross proceeds / outstanding debit). */
  amount: number
  /** Total annual debit interest across all tranches. */
  totalAnnualInterest: number
  /** Blended effective annual rate = totalAnnualInterest / amount (0 if amount ≤ 0). */
  effectiveRate: number
  /** 1/12 of the total annual interest — the standard monthly charge. */
  monthlyInterest: number
  /** Per-tranche breakdown, INCLUDING only tranches this facility actually reaches. */
  tranches: TrancheBreakdown[]
  /** Marginal (top) annual rate the facility reaches — the rate on its last unit. */
  marginalRate: number
}

/**
 * Price a facility of `amount` under the progressive schedule (pure marginal
 * calculation). Returns total annual interest, the blended effective rate, the
 * 1/12 monthly charge and the full tranche breakdown. Amounts ≤ 0 yield zeros.
 */
export function computeTieredInterest(
  amount: number,
  tiers: readonly DebitInterestTier[] = DEBIT_INTEREST_TIERS,
): TieredInterestResult {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0
  const tranches: TrancheBreakdown[] = []
  let totalAnnualInterest = 0
  let marginalRate = 0

  for (const tier of tiers) {
    if (safeAmount <= tier.from) break // facility doesn't reach this tranche
    const tierCeiling = tier.upTo ?? safeAmount
    const portion = Math.min(safeAmount, tierCeiling) - tier.from
    if (portion <= 0) continue
    const annualInterest = round2(portion * tier.annualRate)
    totalAnnualInterest = round2(totalAnnualInterest + annualInterest)
    marginalRate = tier.annualRate
    tranches.push({
      from: tier.from,
      upTo: tier.upTo,
      annualRate: tier.annualRate,
      portion,
      annualInterest,
    })
  }

  const effectiveRate = safeAmount > 0 ? totalAnnualInterest / safeAmount : 0
  return {
    amount: safeAmount,
    totalAnnualInterest,
    effectiveRate,
    monthlyInterest: round2(totalAnnualInterest / 12),
    tranches,
    marginalRate,
  }
}

/**
 * Blended effective annual rate for a facility of `amount`. Convenience wrapper
 * used by the accrual engine, which needs a single flat rate to feed into the
 * shared month-walk (blendedRate × amount === totalAnnualInterest, so monthly
 * and pro-rata math are identical to the tranche sum).
 */
export function blendedAnnualRate(
  amount: number,
  tiers: readonly DebitInterestTier[] = DEBIT_INTEREST_TIERS,
): number {
  return computeTieredInterest(amount, tiers).effectiveRate
}

/** Format a tier bound for display, e.g. 5_000_000 -> "5M", 500_000_000 -> "500M". */
export function formatTierBound(n: number | null): string {
  if (n === null) return "∞"
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/**
 * Compact human-readable tranche breakdown for notifications and statements,
 * e.g. "0–5M @ 1.80%; 5–10M @ 2.00%; 10M–15M @ 2.40%". Only the tranches the
 * facility actually reaches are included.
 */
export function describeTranches(result: TieredInterestResult): string {
  return result.tranches
    .map((t) => {
      const upper = t.upTo === null ? "∞" : formatTierBound(Math.min(t.from + t.portion, t.upTo))
      // For the reached top of the facility inside a tranche, show the actual
      // upper edge of the used portion rather than the tier ceiling.
      const usedUpper = formatTierBound(t.from + t.portion)
      const bound = t.upTo === null ? `${formatTierBound(t.from)}+` : `${formatTierBound(t.from)}–${usedUpper}`
      void upper
      return `${bound} @ ${(t.annualRate * 100).toFixed(2)}%`
    })
    .join("; ")
}
