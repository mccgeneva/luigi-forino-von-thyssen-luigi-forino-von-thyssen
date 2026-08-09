/**
 * Risk-based inverse debit-interest scale for leverage.
 *
 * Higher leverage signals higher trust / lower credit risk, so it carries a
 * LOWER annual debit interest; lower leverage carries a HIGHER rate. The scale
 * is the single source of truth for every leverage product (trading lines and
 * the treasury security-deposit facility).
 *
 *   Leverage   Annual debit interest
 *   1:2        14%
 *   1:5        10%
 *   1:10        8%
 *   1:15        7%
 *   1:20        6%
 *   1:25        4%
 *   1:30        3%
 *
 * Interest is calculated annually and charged monthly as 1/12 of the annual
 * rate, accruing from the day the funds are credited (handled by the accrual
 * engine + monthly reconcilers, not here). This module is a pure, configurable
 * rate table so the economics can be tuned in one place.
 */

export interface LeverageRateAnchor {
  /** Leverage multiple, e.g. 5 for 1:5. */
  ratio: number
  /** Annual debit interest rate as a decimal, e.g. 0.10 for 10%. */
  rate: number
}

/**
 * Configurable anchor table (ascending by ratio). Adjust here to retune the
 * scale. Intermediate ratios are linearly interpolated between anchors and
 * clamped to the table's ends.
 */
export const DEBIT_INTEREST_SCALE: LeverageRateAnchor[] = [
  { ratio: 2, rate: 0.14 },
  { ratio: 5, rate: 0.1 },
  { ratio: 10, rate: 0.08 },
  { ratio: 15, rate: 0.07 },
  { ratio: 20, rate: 0.06 },
  { ratio: 25, rate: 0.04 },
  { ratio: 30, rate: 0.03 },
]

/** Full ladder of selectable leverage ratios (the anchor points): 1:2 … 1:30. */
export const LEVERAGE_RATIOS: number[] = DEBIT_INTEREST_SCALE.map((a) => a.ratio)

/** Highest leverage the platform offers (1:30). */
export const MAX_LEVERAGE_LADDER = LEVERAGE_RATIOS[LEVERAGE_RATIOS.length - 1]

/** Treasury financing offers the full ladder (1:2 … 1:30), same as trading lines. */
export const TREASURY_LEVERAGE_RATIOS: number[] = [...LEVERAGE_RATIOS]

/**
 * Annual debit interest rate for a given leverage ratio under the risk-based
 * inverse scale. Exact anchor ratios return their table value; intermediate
 * ratios are linearly interpolated; out-of-range values clamp to the ends.
 * Rounded to 6 dp to avoid float noise.
 */
export function debitInterestRateFor(leverageRatio: number): number {
  const r = Number.isFinite(leverageRatio) ? leverageRatio : 0
  const table = DEBIT_INTEREST_SCALE
  if (table.length === 0) return 0

  const first = table[0]
  const last = table[table.length - 1]
  if (r <= first.ratio) return first.rate
  if (r >= last.ratio) return last.rate

  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i]
    const b = table[i + 1]
    if (r >= a.ratio && r <= b.ratio) {
      const t = (r - a.ratio) / (b.ratio - a.ratio)
      const rate = a.rate + t * (b.rate - a.rate)
      return Math.round(rate * 1e6) / 1e6
    }
  }
  return last.rate
}
