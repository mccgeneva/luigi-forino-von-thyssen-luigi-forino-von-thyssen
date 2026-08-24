/**
 * Leverage audit & compliance fee.
 *
 * Applying for a leveraged trading line always triggers an audit / compliance
 * review and a verification handshake with the Treasury bank partner. The
 * partner bills the platform for this work whether the line is ultimately
 * ACCEPTED or REJECTED, so the cost is charged to the client at the moment they
 * confirm the application — not at approval.
 *
 * Fee = 0.001% × leverage multiplier × the FACE VALUE requested as leverage,
 * where the face value is the buying power (equity × ratio):
 *
 *     buyingPower = equity × ratio
 *     fee         = 0.00001 × ratio × buyingPower
 *                 = 0.00001 × equity × ratio²
 *
 * Worked example: €100,000 equity at 1:10 → buying power €1,000,000 →
 *     fee = 0.00001 × 10 × 1,000,000 = €100.00
 *
 * The fee is charged in the leverage line's own currency to the client's Master
 * Account. Supported multiplier range is 1:2 … 1:30.
 */

/** 0.001% = 0.00001 as a decimal. */
export const LEVERAGE_AUDIT_FEE_RATE = 0.00001

/** Round half-up to 2 decimals (currency-safe). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Compute the audit & compliance fee for a leverage application.
 *
 * @param equity  The client's own margin allocated to the line.
 * @param ratio   The leverage multiplier (e.g. 10 for 1:10).
 * @returns       The fee (>= 0), rounded to 2 decimals. Returns 0 for any
 *                non-finite or non-positive input so it can never produce a
 *                bogus charge.
 */
export function leverageAuditFee(equity: number, ratio: number): number {
  if (!Number.isFinite(equity) || !Number.isFinite(ratio)) return 0
  if (equity <= 0 || ratio <= 0) return 0
  const buyingPower = equity * ratio
  return round2(LEVERAGE_AUDIT_FEE_RATE * ratio * buyingPower)
}

/**
 * Payment Protection Insurance (PPI) premium.
 *
 * A leveraged position is insured at 0.1% of the FULL buying power (the
 * leveraged position being protected) — a leverage-specific rate set 10× lower
 * than the platform-standard 1% PPI to keep leverage affordable. Charged to the
 * Master Account together with the audit fee on confirmation.
 *
 * Worked example: €100,000 equity at 1:10 → buying power €1,000,000 →
 *     PPI = 0.1% × 1,000,000 = €1,000.00
 */
export const LEVERAGE_PPI_RATE = 0.001

/**
 * Compute the PPI premium for a leverage application (0.1% of buying power).
 * Returns 0 for any non-finite or non-positive input.
 */
export function leveragePpiPremium(equity: number, ratio: number): number {
  if (!Number.isFinite(equity) || !Number.isFinite(ratio)) return 0
  if (equity <= 0 || ratio <= 0) return 0
  const buyingPower = equity * ratio
  return round2(LEVERAGE_PPI_RATE * buyingPower)
}

/** The full set of upfront charges for a leverage application. */
export interface LeverageApplicationCharges {
  /** Buying power the charges are based on (equity × ratio). */
  buyingPower: number
  /** Audit & compliance / Treasury-partner verification fee. */
  auditFee: number
  /** Payment Protection Insurance premium. */
  ppi: number
  /** Combined amount debited to the Master Account on confirmation. */
  total: number
}

/**
 * Compute the complete upfront cost of a leverage application: the audit &
 * compliance fee plus the PPI premium, both charged immediately to the Master
 * Account on confirmation whether the line is accepted or rejected.
 */
export function leverageApplicationCharges(equity: number, ratio: number): LeverageApplicationCharges {
  const auditFee = leverageAuditFee(equity, ratio)
  const ppi = leveragePpiPremium(equity, ratio)
  const buyingPower = Number.isFinite(equity) && Number.isFinite(ratio) && equity > 0 && ratio > 0 ? equity * ratio : 0
  return { buyingPower, auditFee, ppi, total: round2(auditFee + ppi) }
}
