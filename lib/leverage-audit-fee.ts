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
