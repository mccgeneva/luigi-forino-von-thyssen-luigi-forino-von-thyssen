// ---------------------------------------------------------------------------
// SKR Expertise / Evaluation / Audit engine (pure, client-safe).
//
// A customer holding an SKR may apply for an official expertise, evaluation or
// audit of the goods held under it. The administrator sets the ASSESSED VALUE of
// the goods and returns a professional outcome; the service COST is computed
// deterministically from the SKR face value and the customer's trade score:
//
//   Cost = ( SKR Face Value × 0.075% × (Customer Trade Score + 1) ) / 1.50
//
// where the Customer Trade Score is the Guarantees Accumulator risk score
// (`finalScore` — a small non-negative number; higher = riskier = dearer).
//
// On acceptance the cost is charged to the Master Account and the SKR becomes
// blocked collateral treated exactly like a SWIFT MT760 (materialised as a
// pledgeable bank instrument), usable for monetization, instrument upgrade,
// leverage and loan/investment collateral.
// ---------------------------------------------------------------------------

/** The three kinds of assessment a customer can request for an SKR. */
export type SkrExpertiseKind = "Expertise" | "Evaluation" | "Audit"

export const SKR_EXPERTISE_KINDS: SkrExpertiseKind[] = ["Expertise", "Evaluation", "Audit"]

/**
 * Lifecycle:
 *  - requested : customer applied; awaiting the custody desk's valuation.
 *  - assessed  : admin set the assessed value + outcome; cost quoted to the client.
 *  - accepted  : client accepted; cost charged and SKR blocked as collateral.
 *  - declined  : client declined the assessed outcome/cost (nothing charged).
 */
export type SkrExpertiseStatus = "requested" | "assessed" | "accepted" | "declined"

/** Fee rate applied to the SKR face value (0.075%). */
export const SKR_EXPERTISE_RATE = 0.00075
/** Divisor in the cost formula. */
export const SKR_EXPERTISE_DIVISOR = 1.5

export interface SkrExpertise {
  kind: SkrExpertiseKind
  status: SkrExpertiseStatus
  requestedAt: string
  requestNote?: string

  // --- Administrator valuation (set when status → "assessed") --------------
  /** Admin-assessed value of the goods covered by the SKR. */
  assessedValue?: number
  /** Currency of the assessed value (defaults to the SKR currency). */
  assessedCurrency?: string
  /** Professional outcome / findings returned to the client. */
  outcomeNote?: string
  /** Customer trade score snapshot used in the cost calculation. */
  tradeScore?: number
  /** Calculated service cost (before cashback), in the SKR face-value currency. */
  cost?: number
  /** Currency the cost is charged in (the SKR face-value currency). */
  costCurrency?: string
  /** When the administrator returned the valuation (ISO). */
  assessedAt?: string

  // --- Acceptance ----------------------------------------------------------
  acceptedAt?: string
  declinedAt?: string
  /** Net cost actually charged after any cashback (audit trail). */
  chargedAmount?: number
  /** Ledger entry id of the charge (deterministic, idempotent). */
  chargeEntryId?: string
  /** Id of the pledgeable collateral instrument materialised on acceptance. */
  instrumentId?: string
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

/**
 * Cost = ( faceValue × 0.075% × (tradeScore + 1) ) / 1.50.
 * A negative/NaN score is treated as 0 so the base cost (÷1.5) always applies.
 */
export function skrExpertiseCost(faceValue: number, tradeScore: number): number {
  if (!Number.isFinite(faceValue) || faceValue <= 0) return 0
  const score = Number.isFinite(tradeScore) && tradeScore > 0 ? tradeScore : 0
  return round2((faceValue * SKR_EXPERTISE_RATE * (score + 1)) / SKR_EXPERTISE_DIVISOR)
}

export const SKR_EXPERTISE_STATUS_LABELS: Record<SkrExpertiseStatus, string> = {
  requested: "Awaiting valuation",
  assessed: "Valuation returned",
  accepted: "Accepted — collateral",
  declined: "Declined",
}
