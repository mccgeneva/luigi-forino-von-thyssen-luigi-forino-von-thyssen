/**
 * Monetization equity-deposit pricing.
 *
 * A client can monetize a bank instrument at any Loan-to-Value (LTV) from 1% to
 * 100%. The upfront EQUITY DEPOSIT they must post scales LINEARLY with the LTV:
 *
 *   - at   1% LTV the equity rate is 0.75%
 *   - at 100% LTV the equity rate is 5.00%
 *
 * so a client asking for a mid-range LTV pays a proportionally interpolated
 * rate. On top of the equity, the deal carries PPI (Payment Protection
 * Insurance) worth 1% of the advance, funded from the same upfront deposit.
 *
 * Everything is expressed against the ADVANCE amount (the LTV proceeds =
 * faceValue × LTV%), consistent with how the reserve was always quoted.
 */

export const EQUITY_RATE_AT_MIN_LTV = 0.0075 // 0.75% at 1% LTV
export const EQUITY_RATE_AT_MAX_LTV = 0.05 // 5% at 100% LTV
export const MIN_LTV = 1
export const MAX_LTV = 100
/** PPI premium as a fraction of the advance amount. */
export const PPI_RATE = 0.01 // 1% of the adopted LTV advance

/**
 * Linear equity-deposit rate for a given LTV (in percent, 1..100).
 * Clamps out-of-range input to the 1..100 band before interpolating.
 */
export function equityRateForLtv(ltvPercent: number): number {
  const ltv = Math.min(MAX_LTV, Math.max(MIN_LTV, ltvPercent))
  const t = (ltv - MIN_LTV) / (MAX_LTV - MIN_LTV) // 0 at 1%, 1 at 100%
  return EQUITY_RATE_AT_MIN_LTV + (EQUITY_RATE_AT_MAX_LTV - EQUITY_RATE_AT_MIN_LTV) * t
}

export interface EquityQuote {
  /** LTV used (clamped to 1..100). */
  ltvPercent: number
  /** Interpolated equity rate as a fraction (e.g. 0.034975). */
  equityRate: number
  /** Equity deposit = equityRate × advance, rounded to whole units. */
  equityDeposit: number
  /** PPI premium = 1% × advance, rounded to whole units. */
  ppi: number
  /** Total upfront the client must hold = equityDeposit + ppi. */
  totalUpfront: number
}

/**
 * Full upfront cost breakdown for monetizing at a given LTV.
 * @param advanceAmount the LTV proceeds (faceValue × LTV%), in the instrument currency
 * @param ltvPercent    the adopted LTV in percent (1..100)
 */
export function computeMonetizationEquity(advanceAmount: number, ltvPercent: number): EquityQuote {
  const ltv = Math.min(MAX_LTV, Math.max(MIN_LTV, ltvPercent))
  const equityRate = equityRateForLtv(ltv)
  const advance = Math.max(0, advanceAmount)
  const equityDeposit = Math.round(advance * equityRate)
  const ppi = Math.round(advance * PPI_RATE)
  return {
    ltvPercent: ltv,
    equityRate,
    equityDeposit,
    ppi,
    totalUpfront: equityDeposit + ppi,
  }
}
