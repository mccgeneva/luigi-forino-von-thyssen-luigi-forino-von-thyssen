/**
 * Trust-score-adjusted Payment Protection Insurance (PPI).
 *
 * Adopted formula (drives leverage AND monetization PPI):
 *
 *     IF Guarantees_Accumulator_Trust_Score == 0:
 *         ppi_multiplier = 0
 *         PPI = 0
 *     ELSE:
 *         PPI = (ppi_cost / 100) * ppi_multiplier
 *
 * where:
 *   - ppi_multiplier = the Guarantees Accumulator trust score (finalScore).
 *   - ppi_cost       = the standard PPI premium amount for the product
 *                      (leverage: 0.75% × buying power; monetization: 1% × advance).
 *
 * So a perfectly safe account (score 0) pays NO insurance, and the premium then
 * scales linearly with the account's risk score. The result is intentionally a
 * fraction of the base premium — the score acts as the percentage multiplier.
 */

/**
 * Apply the adopted PPI formula to a base premium and a trust score.
 * Returns 0 when the score is 0 (or non-positive), or when the base is invalid.
 */
export function ppiFromTrustScore(basePremium: number, trustScore: number): number {
  if (!Number.isFinite(basePremium) || basePremium <= 0) return 0
  if (!Number.isFinite(trustScore) || trustScore <= 0) return 0
  return (basePremium / 100) * trustScore
}

/**
 * Read a trust score that was stamped on an approval `record` at submission
 * (`record.ppiTrustScore`). Returns `undefined` when absent (legacy records) so
 * the PPI functions fall back to the base premium — i.e. legacy items keep the
 * exact premium they were originally charged, never silently re-priced to 0.
 */
export function readStampedTrustScore(record: unknown): number | undefined {
  if (!record || typeof record !== "object") return undefined
  const raw = (record as Record<string, unknown>).ppiTrustScore
  if (raw === undefined || raw === null) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}
