// ---------------------------------------------------------------------------
// MARGINAL TIERED TRANSACTION FEE ENGINE (single source of truth).
//
// A progressive, bracket-based fee: each PORTION of the payment amount is
// charged only at the rate of its own tier (like income-tax brackets), NOT one
// flat rate on the whole amount.
//
// Plain, dependency-free, CLIENT-SAFE module so it can be imported by:
//   - client payment/preview pages (live breakdown before confirmation)
//   - server charge paths (authoritative fee on incoming/outgoing/P2P)
//   - the admin editor + Terms & Costs catalogue
//
// Thresholds are expressed in NATIVE currency units (a "€100,000" tier boundary
// means 100,000 units of whatever currency the payment is in) — consistent with
// the product decision to bracket in the transaction currency, not EUR-equiv.
//
// The DEFAULT_FEE_TIERS table below is the fallback / seed. The live table is
// stored in the database (lib/tiered-fees-db.ts) and editable by an admin, so
// rates can change without a code change; every consumer that has the live
// tiers should pass them in, and everything falls back to DEFAULT_FEE_TIERS.
// ---------------------------------------------------------------------------

export interface FeeTier {
  /** Lower bound of the bracket (inclusive), in native currency units. */
  min: number
  /** Upper bound of the bracket (exclusive). `null` = no upper bound (top tier). */
  max: number | null
  /** Fee rate applied to the portion of the amount inside this bracket. */
  rate: number
}

/**
 * Default / seed tier table (matches the supplied reference function exactly).
 *   €0 – €100,000        2.00%
 *   €100,000 – €250,000  1.80%
 *   €250,000 – €500,000  1.60%
 *   €500,000 – €1,000,000 1.50%
 *   €1,000,000 – €5,000,000 1.20%
 *   €5,000,000 – €10,000,000 1.00%
 *   Above €10,000,000    0.10%
 */
export const DEFAULT_FEE_TIERS: FeeTier[] = [
  { min: 0, max: 100_000, rate: 0.02 },
  { min: 100_000, max: 250_000, rate: 0.018 },
  { min: 250_000, max: 500_000, rate: 0.016 },
  { min: 500_000, max: 1_000_000, rate: 0.015 },
  { min: 1_000_000, max: 5_000_000, rate: 0.012 },
  { min: 5_000_000, max: 10_000_000, rate: 0.01 },
  { min: 10_000_000, max: null, rate: 0.001 },
]

export interface FeeBreakdownRow {
  /** Bracket lower bound. */
  min: number
  /** Bracket upper bound (null = unbounded top tier). */
  max: number | null
  /** Rate applied to this bracket. */
  rate: number
  /** How much of the payment amount fell within this bracket. */
  amountInTier: number
  /** Fee charged on this bracket's portion (amountInTier * rate, rounded). */
  fee: number
}

export interface TieredFeeResult {
  /** The amount the fee was computed on. */
  amount: number
  /** Total fee across all brackets (sum of breakdown fees). */
  totalFee: number
  /** Blended effective rate = totalFee / amount (0 when amount <= 0). */
  effectiveRate: number
  /** Tier-by-tier breakdown, only including brackets that were actually hit. */
  breakdown: FeeBreakdownRow[]
}

/** Round to 2 decimals (currency-safe). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Sort + sanity-check a tier table (ascending by min). */
function normalizeTiers(tiers: FeeTier[]): FeeTier[] {
  return [...tiers].sort((a, b) => a.min - b.min)
}

/**
 * Compute the marginal tiered fee for a payment amount.
 *
 * Each bracket is charged only on the portion of `amount` that falls inside it:
 *   feeInTier = (min(amount, tier.max) - tier.min) * tier.rate
 *
 * Returns the total fee, blended effective rate, and the full tier-by-tier
 * breakdown (only brackets the amount actually reaches). Non-positive or
 * non-finite amounts yield a zero result.
 */
export function calculateTieredFee(amount: number, tiers: FeeTier[] = DEFAULT_FEE_TIERS): TieredFeeResult {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { amount: Number.isFinite(amount) && amount > 0 ? amount : 0, totalFee: 0, effectiveRate: 0, breakdown: [] }
  }

  const sorted = normalizeTiers(tiers)
  const breakdown: FeeBreakdownRow[] = []
  let totalFee = 0

  for (const tier of sorted) {
    if (amount <= tier.min) break // amount doesn't reach this bracket
    const upper = tier.max == null ? amount : Math.min(amount, tier.max)
    const amountInTier = upper - tier.min
    if (amountInTier <= 0) continue
    const fee = round2(amountInTier * tier.rate)
    totalFee = round2(totalFee + fee)
    breakdown.push({ min: tier.min, max: tier.max, rate: tier.rate, amountInTier: round2(amountInTier), fee })
    if (tier.max != null && amount <= tier.max) break // fully covered
  }

  return {
    amount,
    totalFee,
    effectiveRate: amount > 0 ? totalFee / amount : 0,
    breakdown,
  }
}

/** Convenience: just the total fee (for call sites that don't need the breakdown). */
export function tieredFee(amount: number, tiers: FeeTier[] = DEFAULT_FEE_TIERS): number {
  return calculateTieredFee(amount, tiers).totalFee
}
