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
 *   5. Track Record — a NEW/unproven account carries provisional risk that
 *      decays to zero as it seasons with clean standing. This is what stops a
 *      brand-new customer (no history, no posted collateral) scoring 0 and
 *      taking a first high-leverage line for free. BUT posted, UNENCUMBERED
 *      guarantees accumulate to offset it: a new account that has put up real
 *      capital (paid-in deposit + net balance, i.e. NOT borrowed collateral) is
 *      not a thin-file risk. A financed deposit (e.g. a 1:5 lent deposit) nets
 *      to ~zero equity and earns no offset.
 *        seasoning        = clamp(1 − accountAgeDays / seasoningDays)  (1=new, 0=seasoned)
 *        netEquity        = guarantees + availableBalance − totalExposure
 *        guaranteeStrength= clamp(netEquity / provenCapital, 0, 1)     (1=fully proven)
 *        points           = newAccountRisk × seasoning × (1 − guaranteeStrength)
 *
 * They are combined as a WEIGHTED SUM, then the SQUARE ROOT is the risk score:
 *        weightedSum = w1·f1 + w2·f2 + w3·f3 + w4·f4 + w5·f5
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
  /** Weight on the Track Record (new/unproven account) factor. */
  weightTrackRecord: number
  /** Weight on the Overdraft (negative-balance) factor. */
  weightOverdraft: number
  /**
   * Risk points a FULLY-used controlled overdraft (100% of the 8% ceiling)
   * contributes. Default 144 so a fully overdrawn account scores sqrt(144)=12 on
   * this factor alone — above the default high-risk threshold of 10. Scaled
   * linearly by how much of the overdraft ceiling is currently used.
   */
  overdraftRiskFull: number
  /**
   * Provisional risk points a brand-new account starts with (before seasoning
   * decay). Default 144 so a fresh account with no other stress scores
   * sqrt(144)=12 — clearly above the default high-risk threshold of 10.
   */
  newAccountRisk: number
  /** Days over which the new-account risk decays linearly to zero. */
  seasoningDays: number
  /**
   * Net equity (paid-in guarantees + balance − outstanding exposure, in EUR)
   * at which a new account is considered fully proven by capital, fully
   * cancelling the new-account risk. Borrowed/financed collateral nets out and
   * earns no offset, so a leveraged deposit stays high risk.
   */
  provenCapital: number
  /** finalScore strictly above this is HIGH RISK (blocks new financing). */
  highRiskThreshold: number
  /** Risk-score points removed per full year of good standing. */
  ageCreditPerYear: number
  /** Maximum age credit that can ever be subtracted. */
  ageCreditMax: number
  /**
   * Segregated EQUITY SAVING (in EUR) at which the maximum equity credit is
   * granted. Equity savings are fully-blocked collateral the customer commits
   * from their Master Account; committing them is a strong positive signal, so
   * beyond boosting collateral coverage they earn a direct risk-score credit
   * that scales linearly up to this amount.
   */
  equityCreditFull: number
  /** Maximum risk-score points the equity-saving credit can ever subtract. */
  equityCreditMax: number
  /**
   * Genuine EXTERNAL incoming funds (in EUR, over the trailing inflow window)
   * at which the maximum inflow credit is granted. "Real money" brought in from
   * outside the platform — incoming payments/SWIFT/gateway/inbound transfers —
   * is a strong positive signal and earns a direct risk-score credit that scales
   * linearly up to this amount. Borrowed proceeds (loan/leverage), ROI and
   * internal moves are DELIBERATELY excluded: they raise exposure and worsen the
   * score instead of improving it.
   */
  inflowCreditFull: number
  /** Maximum risk-score points the incoming-funds credit can ever subtract. */
  inflowCreditMax: number
  /** Rolling window (in days) over which genuine external inflows are summed. */
  inflowWindowDays: number
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
  weightTrackRecord: 1,
  weightOverdraft: 1,
  overdraftRiskFull: 144,
  newAccountRisk: 144,
  seasoningDays: 365,
  provenCapital: 250_000,
  highRiskThreshold: 10,
  ageCreditPerYear: 1.5,
  ageCreditMax: 6,
  equityCreditFull: 250_000,
  equityCreditMax: 8,
  inflowCreditFull: 1_000_000,
  inflowCreditMax: 6,
  inflowWindowDays: 365,
  penaltyPerOverdue: 25,
  targetCoverage: 1,
  enforce: true,
}

/** Real-world inputs, all monetary values in ONE common currency (EUR base). */
export interface GuaranteeInputs {
  /** Security deposits + pledged guarantee instruments held (collateral). */
  guarantees: number
  /**
   * Segregated equity-saving collateral (EUR) the customer has blocked from
   * their Master Account. Drives the equity credit (and is already folded into
   * `guarantees` by the profile gatherer, so it is NOT re-added here).
   */
  equitySavings: number
  /** Outstanding leverage borrowed. */
  leverageLoad: number
  /** ALL outstanding financing (leverage + monetization + funding + treasury). */
  totalExposure: number
  /** Spendable balance available to service financing. */
  availableBalance: number
  /**
   * Genuine EXTERNAL incoming funds (EUR) received over the trailing inflow
   * window — real money brought in (incoming payments/SWIFT/gateway/inbound
   * transfers), NEVER borrowed proceeds/ROI/internal moves. Drives the inflow
   * credit.
   */
  incomingInflow: number
  /** Count of monthly financing charges currently in arrears (auto-derived). */
  overdueCharges: number
  /** Account age in days (drives the time credit). */
  accountAgeDays: number
  /**
   * Fraction (0..1) of the controlled overdraft ceiling currently used — i.e.
   * how deep the Master Account is negative relative to its 8% limit. 0 when
   * positive, 1 at the ceiling.
   */
  overdraftUsageRatio: number
  /** Common currency the figures are expressed in. */
  currency: string
}

export interface GuaranteeFactors {
  securityDeposit: number
  leverageLoad: number
  exposure: number
  paymentPenalty: number
  trackRecord: number
  overdraft: number
}

export type RiskBand = "low" | "moderate" | "high"

export interface GuaranteeScore {
  factors: GuaranteeFactors
  weightedSum: number
  riskScore: number
  ageCredit: number
  /** Risk-score points removed by committed equity savings (0 when none). */
  equityCredit: number
  /** Risk-score points removed by genuine external incoming funds (0 when none). */
  inflowCredit: number
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
 * How many times the authorized overdraft ceiling a breach can escalate the
 * overdraft risk factor. At the ceiling the factor equals `overdraftRiskFull`
 * (default 144 → sqrt≈12); at ≥ ~2.25× it clears an 18-point high-risk gate; and
 * it caps at 6× so an extreme negative balance cannot make the score infinite.
 */
const OVERDRAFT_BREACH_CAP = 6

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
  // overdraftUsageRatio is now the UNCLAMPED breach ratio (0 = positive, 1 = at
  // the ceiling, >1 = beyond the authorized overdraft). Allow it to escalate the
  // risk factor well past the ceiling (capped at 6× so one runaway figure can't
  // be infinite) so a deep, illogical overdraft is properly reflected instead of
  // saturating at the ceiling.
  const overdraftUsage = clamp(inputs.overdraftUsageRatio || 0, 0, OVERDRAFT_BREACH_CAP)

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

  // 5. Track Record — provisional risk for a NEW/unproven account that decays
  // to zero as the account seasons. A fresh account (no history, no collateral)
  // must not sit at zero risk; it starts elevated and earns its way down.
  // BUT real, UNENCUMBERED capital offsets it: net equity = posted guarantees +
  // available balance − outstanding exposure. A financed deposit (borrowed
  // collateral) nets out and earns no offset, so it stays high risk; a paid-in
  // deposit / real balance proves the account and cancels the new-account risk.
  const seasoningDays = config.seasoningDays > 0 ? config.seasoningDays : 365
  const seasoning = clamp(1 - ageDays / seasoningDays, 0, 1)
  const newAccountRisk = Math.max(0, config.newAccountRisk || 0)
  const provenCapital = config.provenCapital > 0 ? config.provenCapital : 250_000
  const netEquity = guarantees + available - totalExposure
  const guaranteeStrength = clamp(netEquity / provenCapital, 0, 1)
  const fTrackRecord = clamp(newAccountRisk * seasoning * (1 - guaranteeStrength), 0, FACTOR_SOFT_CAP)

  // 6. Overdraft — a negative Master Account balance is a live risk, scaled by
  // how deep the account is relative to its controlled overdraft ceiling. Zero
  // when positive; overdraftRiskFull at exactly the ceiling; and it ESCALATES
  // linearly beyond that when the ceiling is breached (up to OVERDRAFT_BREACH_CAP
  // × the ceiling), so a deeply negative account is driven firmly into high risk
  // instead of scoring the same as a mild, within-ceiling overdraft.
  const overdraftRiskFull = Math.max(0, config.overdraftRiskFull || 0)
  const fOverdraft = clamp(overdraftRiskFull * overdraftUsage, 0, overdraftRiskFull * OVERDRAFT_BREACH_CAP)

  const factors: GuaranteeFactors = {
    securityDeposit: round2(fSecurityDeposit),
    leverageLoad: round2(fLeverageLoad),
    exposure: round2(fExposure),
    paymentPenalty: round2(fPaymentPenalty),
    trackRecord: round2(fTrackRecord),
    overdraft: round2(fOverdraft),
  }

  const weightedSum =
    config.weightSecurityDeposit * fSecurityDeposit +
    config.weightLeverageLoad * fLeverageLoad +
    config.weightExposure * fExposure +
    config.weightPaymentPenalty * fPaymentPenalty +
    config.weightTrackRecord * fTrackRecord +
    config.weightOverdraft * fOverdraft

  const riskScore = Math.sqrt(Math.max(0, weightedSum))

  const ageYears = ageDays / 365
  const ageCredit = clamp(ageYears * config.ageCreditPerYear, 0, config.ageCreditMax)

  // Equity-saving credit — committed, fully-blocked equity is a strong positive
  // that directly lowers the risk score (on top of improving collateral
  // coverage). Scales linearly with the blocked amount up to `equityCreditFull`.
  const equitySavings = Math.max(0, inputs.equitySavings || 0)
  const equityCreditFull = config.equityCreditFull > 0 ? config.equityCreditFull : 250_000
  const equityCreditMax = Math.max(0, config.equityCreditMax || 0)
  const equityCredit = clamp((equitySavings / equityCreditFull) * equityCreditMax, 0, equityCreditMax)

  // Incoming-funds credit — genuine EXTERNAL money brought into the Master
  // Account over the trailing window directly lowers the risk score. Scales
  // linearly with the inflow up to `inflowCreditFull`. Borrowed proceeds/ROI/
  // internal moves are NOT counted here (the profile gatherer only sums real
  // external inflows) and they separately RAISE exposure — the opposite effect.
  const incomingInflow = Math.max(0, inputs.incomingInflow || 0)
  const inflowCreditFull = config.inflowCreditFull > 0 ? config.inflowCreditFull : 1_000_000
  const inflowCreditMax = Math.max(0, config.inflowCreditMax || 0)
  const inflowCredit = clamp((incomingInflow / inflowCreditFull) * inflowCreditMax, 0, inflowCreditMax)

  const finalScore = Math.max(0, riskScore - ageCredit - equityCredit - inflowCredit)

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
    equityCredit: round2(equityCredit),
    inflowCredit: round2(inflowCredit),
    finalScore: round2(finalScore),
    creditScore: Math.round(creditScore),
    band,
    highRisk,
    inputs: {
      guarantees: round2(guarantees),
      equitySavings: round2(equitySavings),
      leverageLoad: round2(leverageLoad),
      totalExposure: round2(totalExposure),
      availableBalance: round2(available),
      incomingInflow: round2(incomingInflow),
      overdueCharges: overdue,
      accountAgeDays: Math.round(ageDays),
      overdraftUsageRatio: round2(overdraftUsage),
      currency: inputs.currency,
    },
  }
}

export function riskBandLabel(band: RiskBand): string {
  return band === "high" ? "High Risk" : band === "moderate" ? "Moderate" : "Low Risk"
}

/**
 * Administrator manual override of a single account's trust score. The admin
 * drags a bar to force the displayed risk score to an EXACT number; this is
 * applied silently on top of the computed score — the customer only ever sees
 * the resulting gauge/score, never that it was set by hand. Money `inputs` are
 * left untouched (so the borrowed-funds ring-fence and other money gates stay
 * accurate); only the risk verdict is forced.
 *
 * `forcedScore` is the exact number the admin dragged to (0..100). Band,
 * highRisk and creditScore are derived from it with the SAME formulas as
 * computeGuaranteeScore, so the card, the gauge and every financing gate treat
 * the account as that score. A lower number silently ALLOWS new financing; a
 * number above the high-risk threshold silently BLOCKS it.
 */
export function applyGuaranteeOverride(
  score: GuaranteeScore,
  forcedScore: number,
  threshold: number,
): GuaranteeScore {
  const t = threshold > 0 ? threshold : 10
  const s = round2(clamp(Number.isFinite(forcedScore) ? forcedScore : 0, 0, 100))
  // weightedSum so √(weighted) = s keeps the admin's "√(weighted) = risk" line
  // self-consistent (ageCredit/equityCredit are zeroed under an override).
  const sum = round2(s * s)

  // Illustrative factor spread that grows with the forced score, so the factor
  // rows never look empty on a forced-high account (they are informational and
  // are NOT summed on the customer card). Overdraft stays 0 — no false
  // "you are overdrawn" tell.
  const order: Array<[keyof GuaranteeFactors, number]> = [
    ["exposure", 300],
    ["leverageLoad", 300],
    ["trackRecord", 300],
    ["securityDeposit", 200],
    ["paymentPenalty", 300],
  ]
  const factors: GuaranteeFactors = {
    securityDeposit: 0,
    leverageLoad: 0,
    exposure: 0,
    paymentPenalty: 0,
    trackRecord: 0,
    overdraft: 0,
  }
  let remaining = sum
  for (const [key, cap] of order) {
    const v = Math.max(0, Math.min(cap, remaining))
    factors[key] = round2(v)
    remaining -= v
  }

  const highRisk = s > t
  const band: RiskBand = s > t ? "high" : s > t * 0.5 ? "moderate" : "low"
  const creditScore = Math.round(clamp(100 - (s / t) * 50, 0, 100))

  return {
    ...score,
    factors,
    weightedSum: sum,
    riskScore: s,
    ageCredit: 0,
    equityCredit: 0,
    inflowCredit: 0,
    finalScore: s,
    creditScore,
    band,
    highRisk,
  }
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
