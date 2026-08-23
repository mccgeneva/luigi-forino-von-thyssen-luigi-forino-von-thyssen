/**
 * Guarantees Accumulator — pure, client-safe trust/risk scoring engine.
 *
 * NO "server-only" / DB imports live here so the SAME math is used by:
 *  - the authoritative server gate in submitApproval (app/actions/approvals.ts),
 *  - the admin Guarantees Manager, and
 *  - the client trust-score card.
 *
 * ---------------------------------------------------------------------------
 * FORMULA (locked with the customer)
 * ---------------------------------------------------------------------------
 * Four risk factors are each expressed as "risk points" (0..soft-cap):
 *   1. Security Deposit Coefficient — how UNDER-collateralised the account is.
 *        secDepShortfall = clamp(1 − guarantees / (exposure × targetCoverage))
 *        points = secDepShortfall × 100           (0 when fully collateralised)
 *   2. Leverage Load — leverage borrowed relative to spare capacity.
 *        points = clamp(leverageLoad / capacity × 100)
 *   3. Exposure Factor — ALL outstanding financing relative to capacity.
 *        points = clamp(totalExposure / capacity × 100)
 *   4. Payment Penalty — auto-derived arrears.
 *        points = overdueCharges × penaltyPerOverdue
 *
 * They are combined as a WEIGHTED SUM, then the SQUARE ROOT is the risk score:
 *        weightedSum = w1·f1 + w2·f2 + w3·f3 + w4·f4
 *        riskScore   = sqrt(weightedSum)
 *
 * The account earns a positive time credit that IMPROVES the result — it is
 * SUBTRACTED from the risk score:
 *        ageCredit  = min(ageCreditMax, accountAgeYears × ageCreditPerYear)
 *        finalScore = max(0, riskScore − ageCredit)
 *
 * An account is HIGH RISK when finalScore > highRiskThreshold (default 10).
 * Because each factor tops out around 100 points and default weights are 1.0,
 * a single elevated factor yields sqrt(100)=10 (borderline) and any genuine
 * combination of stress clears the >10 gate — so the threshold is meaningful.
 * ---------------------------------------------------------------------------
 */

/** Round to 2 decimals. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Tunable configuration for the engine (admin-editable, one global row). */
export interface GuaranteeConfig {
  /** Weight on the Security Deposit Coefficient factor. */
  weightSecurityDeposit: number
  /** Weight on the Leverage Load factor. */
  weightLeverageLoad: number
  /** Weight on the Exposure factor. */
  weightExposure: number
  /** Weight on the Payment Penalty factor. */
  weightPaymentPenalty: number
  /** finalScore strictly above this is HIGH RISK (blocks new financing). */
  highRiskThreshold: number
  /** Risk-score points removed per full year of good standing. */
  ageCreditPerYear: number
  /** Maximum age credit that can ever be subtracted. */
  ageCreditMax: number
  /** Risk points added per overdue monthly financing charge. */
  penaltyPerOverdue: number
  /**
   * Target collateral coverage: guarantees/deposits should cover this multiple
   * of exposure for the Security Deposit Coefficient to reach zero risk.
   */
  targetCoverage: number
  /** Master switch — when false the engine scores but NEVER blocks. */
  enforce: boolean
}

export const DEFAULT_GUARANTEE_CONFIG: GuaranteeConfig = {
  weightSecurityDeposit: 1,
  weightLeverageLoad: 1,
  weightExposure: 1,
  weightPaymentPenalty: 1,
  highRiskThreshold: 10,
  ageCreditPerYear: 1.5,
  ageCreditMax: 6,
  penaltyPerOverdue: 25,
  targetCoverage: 1,
  enforce: true,
}

/** Real-world inputs, all monetary values in ONE common currency (EUR base). */
export interface GuaranteeInputs {
  /** Security deposits + pledged guarantee instruments held (collateral). */
  guarantees: number
  /** Outstanding leverage borrowed. */
  leverageLoad: number
  /** ALL outstanding financing (leverage + monetization + funding + treasury). */
  totalExposure: number
  /** Spendable balance available to service financing. */
  availableBalance: number
  /** Count of monthly financing charges currently in arrears (auto-derived). */
  overdueCharges: number
  /** Account age in days (drives the time credit). */
  accountAgeDays: number
  /** Common currency the figures are expressed in. */
  currency: string
}

export interface GuaranteeFactors {
  securityDeposit: number
  leverageLoad: number
  exposure: number
  paymentPenalty: number
}

export type RiskBand = "low" | "moderate" | "high"

export interface GuaranteeScore {
  factors: GuaranteeFactors
  weightedSum: number
  riskScore: number
  ageCredit: number
  finalScore: number
  /** 0–100 creditworthiness for display (higher = healthier). */
  creditScore: number
  band: RiskBand
  highRisk: boolean
  inputs: GuaranteeInputs
}

/** Soft cap so one runaway ratio cannot dominate the whole score. */
const FACTOR_SOFT_CAP = 150
const PENALTY_SOFT_CAP = 200

/**
 * Compute the full guarantee score from real inputs and the (tunable) config.
 * Pure and deterministic.
 */
export function computeGuaranteeScore(inputs: GuaranteeInputs, config: GuaranteeConfig): GuaranteeScore {
  const guarantees = Math.max(0, inputs.guarantees || 0)
  const leverageLoad = Math.max(0, inputs.leverageLoad || 0)
  const totalExposure = Math.max(0, inputs.totalExposure || 0)
  const available = Math.max(0, inputs.availableBalance || 0)
  const overdue = Math.max(0, Math.floor(inputs.overdueCharges || 0))
  const ageDays = Math.max(0, inputs.accountAgeDays || 0)

  // Capacity to carry risk = spendable balance + posted collateral (+ε).
  const capacity = available + guarantees + 1

  // 1. Security Deposit Coefficient — under-collateralisation of exposure.
  const targetCoverage = config.targetCoverage > 0 ? config.targetCoverage : 1
  const required = totalExposure * targetCoverage
  const secDepShortfall = required > 0 ? clamp(1 - guarantees / required, 0, 1) : 0
  const fSecurityDeposit = clamp(secDepShortfall * 100, 0, 100)

  // 2. Leverage Load — leverage relative to capacity.
  const fLeverageLoad = clamp((leverageLoad / capacity) * 100, 0, FACTOR_SOFT_CAP)

  // 3. Exposure — all outstanding financing relative to capacity.
  const fExposure = clamp((totalExposure / capacity) * 100, 0, FACTOR_SOFT_CAP)

  // 4. Payment Penalty — arrears.
  const fPaymentPenalty = clamp(overdue * config.penaltyPerOverdue, 0, PENALTY_SOFT_CAP)

  const factors: GuaranteeFactors = {
    securityDeposit: round2(fSecurityDeposit),
    leverageLoad: round2(fLeverageLoad),
    exposure: round2(fExposure),
    paymentPenalty: round2(fPaymentPenalty),
  }

  const weightedSum =
    config.weightSecurityDeposit * fSecurityDeposit +
    config.weightLeverageLoad * fLeverageLoad +
    config.weightExposure * fExposure +
    config.weightPaymentPenalty * fPaymentPenalty

  const riskScore = Math.sqrt(Math.max(0, weightedSum))

  const ageYears = ageDays / 365
  const ageCredit = clamp(ageYears * config.ageCreditPerYear, 0, config.ageCreditMax)

  const finalScore = Math.max(0, riskScore - ageCredit)

  const threshold = config.highRiskThreshold > 0 ? config.highRiskThreshold : 10
  const highRisk = finalScore > threshold
  const band: RiskBand = finalScore > threshold ? "high" : finalScore > threshold * 0.5 ? "moderate" : "low"

  // Creditworthiness for display: map a finalScore of 0 → 100, threshold → 50,
  // 2× threshold → 0. Purely presentational.
  const creditScore = clamp(100 - (finalScore / threshold) * 50, 0, 100)

  return {
    factors,
    weightedSum: round2(weightedSum),
    riskScore: round2(riskScore),
    ageCredit: round2(ageCredit),
    finalScore: round2(finalScore),
    creditScore: Math.round(creditScore),
    band,
    highRisk,
    inputs: {
      guarantees: round2(guarantees),
      leverageLoad: round2(leverageLoad),
      totalExposure: round2(totalExposure),
      availableBalance: round2(available),
      overdueCharges: overdue,
      accountAgeDays: Math.round(ageDays),
      currency: inputs.currency,
    },
  }
}

export function riskBandLabel(band: RiskBand): string {
  return band === "high" ? "High Risk" : band === "moderate" ? "Moderate" : "Low Risk"
}

/**
 * The message shown when a high-risk account is blocked from opening new
 * financing/exposure.
 */
export function guaranteeBlockMessage(score: GuaranteeScore, threshold: number, productLabel: string): string {
  return (
    `This request cannot be opened because your account is currently classified as HIGH RISK ` +
    `by the Guarantees Accumulator (risk score ${score.finalScore.toFixed(2)}, above the high-risk ` +
    `threshold of ${threshold.toFixed(0)}). New ${productLabel} increases exposure and is not available ` +
    `while your account is high risk. Reduce outstanding exposure or leverage, add security deposits/` +
    `guarantees, or clear any overdue financing charges to lower your risk score, then try again.`
  )
}
