// ---------------------------------------------------------------------------
// Bank Instrument Audit Engine — independent valuation & risk certification.
//
// When a bank instrument is received into a client's account, this engine
// inspects it and produces an institutional audit that assigns a REALISTIC
// assessed value (distinct from the stated face value), a risk score, a
// Moody's-style classification rating (BBB → AAA+), the allowed percentage for
// investing / monetization, and whether PPI (Payment Protection Insurance) is
// required to trade it.
//
// The engine is deterministic (same inputs → same audit) and dependency-free so
// it can be imported from both server routes and client components. The
// Administrator reviews, may override any field (with a logged justification),
// and controls publication; only a PUBLISHED audit is shown to the client.
// ---------------------------------------------------------------------------

/** Engine revision, stamped on every generated audit for the audit trail. */
export const AUDIT_ENGINE_VERSION = "AE-1.0"

/**
 * Classification taxonomy, low → high. Kept as a configurable ordered list so
 * the rating scale can be extended without touching the scoring logic.
 */
export const AUDIT_RATING_SCALE = [
  "BBB",
  "BBB+",
  "A-",
  "A",
  "A+",
  "AA-",
  "AA",
  "AA+",
  "AAA",
  "AAA+",
] as const

export type AuditRating = (typeof AUDIT_RATING_SCALE)[number]

export type AuditStatus = "draft" | "published" | "rejected"

export type FactorImpact = "positive" | "neutral" | "negative"

export interface AuditFactor {
  label: string
  detail: string
  impact: FactorImpact
}

/**
 * The audit record stored on the instrument approval's `payload.audit`. All
 * monetary figures are in the instrument's own currency.
 */
export interface InstrumentAudit {
  status: AuditStatus

  // --- Valuation ------------------------------------------------------------
  faceValue: number
  currency: string
  /** Independent assessed worth of the instrument (≤ face in almost all cases). */
  realisticValue: number
  /** realisticValue / faceValue, 0..1. */
  realisticPct: number

  // --- Risk & classification ------------------------------------------------
  /** 0 (safest) → 100 (riskiest). */
  riskScore: number
  /** Classification on the BBB → AAA+ scale. */
  rating: AuditRating

  // --- Eligibility ----------------------------------------------------------
  investingEligible: boolean
  monetizationEligible: boolean
  /** Allowed loan-to-value for monetization, 0..1 (0 when not monetizable). */
  allowedMonetizationPct: number
  /** PPI (Payment Protection Insurance) required before the instrument trades. */
  ppiRequired: boolean

  // --- Narrative ------------------------------------------------------------
  factors: AuditFactor[]
  summary: string

  // --- Provenance & admin control ------------------------------------------
  engineVersion: string
  /** ISO timestamp the engine produced this assessment. */
  generatedAt: string
  /** True once an administrator changed any engine-assessed field. */
  overridden?: boolean
  /** Required justification captured when the administrator overrides. */
  overrideJustification?: string
  reviewedBy?: string
  reviewedAt?: string
  publishedAt?: string
  publishedBy?: string
  /** Reason captured when an administrator rejects the audit. */
  rejectionReason?: string
}

/** Minimal instrument shape the engine needs (works with the full VM too). */
export interface AuditableInstrument {
  type?: string
  typeFull?: string
  issuer?: string
  faceValue?: number
  currency?: string
  rating?: string
  daysRemaining?: number
  monetizable?: boolean
  purpose?: string
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Per-instrument-type profile: the base valuation ratio (assessed worth vs.
 * face) and the base monetization LTV, before credit-quality and tenor
 * adjustments. Cash-equivalent instruments value near par; documentary /
 * transactional ones are discounted more; proof-of-funds is not monetizable.
 */
const TYPE_PROFILE: Record<string, { valuation: number; ltv: number; monetizable: boolean }> = {
  CD: { valuation: 0.98, ltv: 0.9, monetizable: true },
  POF: { valuation: 0.95, ltv: 0, monetizable: false },
  SBLC: { valuation: 0.92, ltv: 0.7, monetizable: true },
  BG: { valuation: 0.9, ltv: 0.68, monetizable: true },
  MTN: { valuation: 0.88, ltv: 0.62, monetizable: true },
  EMTN: { valuation: 0.88, ltv: 0.62, monetizable: true },
  DLC: { valuation: 0.85, ltv: 0.55, monetizable: true },
  LC: { valuation: 0.83, ltv: 0.52, monetizable: true },
}
const DEFAULT_PROFILE = { valuation: 0.8, ltv: 0.5, monetizable: true }

/**
 * Map a free-form issuer credit-rating string (e.g. "AAA", "AA-", "A+", "BBB")
 * to a 0..1 credit-quality score. Unknown / missing ratings fall to a
 * conservative mid-low value so an unrated issuer is never treated as pristine.
 */
export function creditQualityFromRating(rating: string | undefined): number {
  const r = (rating ?? "").toUpperCase().replace(/\s+/g, "")
  const table: Record<string, number> = {
    "AAA+": 1.0,
    AAA: 0.95,
    "AA+": 0.9,
    AA: 0.85,
    "AA-": 0.8,
    "A+": 0.75,
    A: 0.7,
    "A-": 0.65,
    "BBB+": 0.6,
    BBB: 0.55,
    "BBB-": 0.5,
    BB: 0.4,
    B: 0.3,
  }
  if (table[r] != null) return table[r]
  // Coarse fallback by leading letters when an exact tier is not listed.
  if (r.startsWith("AAA")) return 0.95
  if (r.startsWith("AA")) return 0.85
  if (r.startsWith("A")) return 0.7
  if (r.startsWith("BBB")) return 0.55
  if (r.startsWith("BB")) return 0.4
  if (r.startsWith("B")) return 0.3
  return 0.5
}

/** Map a 0..1 composite quality to a rating on AUDIT_RATING_SCALE. */
export function ratingFromQuality(quality: number): AuditRating {
  const q = clamp(quality, 0, 1)
  const idx = Math.round(q * (AUDIT_RATING_SCALE.length - 1))
  return AUDIT_RATING_SCALE[clamp(idx, 0, AUDIT_RATING_SCALE.length - 1)]
}

/**
 * Produce a DRAFT audit for an instrument. Deterministic: identical inputs
 * always yield the same assessment. The Administrator reviews and publishes it
 * (optionally overriding fields) before the client can see it.
 */
export function buildInstrumentAudit(inst: AuditableInstrument): InstrumentAudit {
  const faceValue = Number(inst.faceValue ?? 0) || 0
  const currency = String(inst.currency ?? "USD")
  const typeCode = String(inst.type ?? "").toUpperCase()
  const profile = TYPE_PROFILE[typeCode] ?? DEFAULT_PROFILE
  const creditQuality = creditQualityFromRating(inst.rating)
  const daysRemaining = Number.isFinite(inst.daysRemaining) ? Number(inst.daysRemaining) : 365

  const factors: AuditFactor[] = []

  // --- Valuation ------------------------------------------------------------
  // Credit quality lifts the assessed value toward par; a lower-rated issuer
  // is discounted further. Near-expiry instruments are marked down as they are
  // harder to place.
  let valuation = profile.valuation * (0.85 + 0.15 * creditQuality)
  let ltv = profile.ltv * (0.8 + 0.2 * creditQuality)

  factors.push({
    label: "Instrument class",
    detail: `${inst.typeFull ?? (typeCode || "Instrument")} — base assessed ratio ${(profile.valuation * 100).toFixed(0)}% of face.`,
    impact: profile.valuation >= 0.9 ? "positive" : profile.valuation >= 0.85 ? "neutral" : "negative",
  })
  factors.push({
    label: "Issuer credit standing",
    detail: `Issuer rating ${inst.rating ?? "unrated"} → credit-quality index ${(creditQuality * 100).toFixed(0)}%.`,
    impact: creditQuality >= 0.85 ? "positive" : creditQuality >= 0.6 ? "neutral" : "negative",
  })

  let tenorRisk = 0
  if (daysRemaining < 30) {
    valuation *= 0.9
    ltv *= 0.85
    tenorRisk = 15
    factors.push({
      label: "Tenor",
      detail: `Only ${daysRemaining} day(s) to expiry — reduced placement value and monetization headroom.`,
      impact: "negative",
    })
  } else if (daysRemaining < 90) {
    tenorRisk = 5
    factors.push({
      label: "Tenor",
      detail: `${daysRemaining} days to expiry — short remaining tenor.`,
      impact: "neutral",
    })
  } else {
    factors.push({
      label: "Tenor",
      detail: `${daysRemaining} days to expiry — healthy remaining tenor.`,
      impact: "positive",
    })
  }

  valuation = clamp(valuation, 0, 0.99)
  const realisticValue = round2(faceValue * valuation)

  // --- Risk score (0 safe → 100 risky) -------------------------------------
  const creditRisk = (1 - creditQuality) * 50
  const typeRisk: Record<string, number> = {
    CD: 5,
    POF: 10,
    SBLC: 15,
    BG: 15,
    MTN: 20,
    EMTN: 20,
    DLC: 25,
    LC: 25,
  }
  const riskScore = Math.round(clamp(creditRisk + (typeRisk[typeCode] ?? 30) + tenorRisk, 1, 99))

  // --- Classification -------------------------------------------------------
  const compositeQuality = creditQuality * (1 - riskScore / 200)
  const rating = ratingFromQuality(compositeQuality)

  // --- Eligibility ----------------------------------------------------------
  const monetizationEligible = profile.monetizable && inst.monetizable !== false && ltv > 0
  const allowedMonetizationPct = monetizationEligible ? round2(clamp(ltv, 0, 0.95)) : 0
  const investingEligible = typeCode !== "POF" && realisticValue > 0
  const ppiRequired = monetizationEligible && (riskScore >= 30 || allowedMonetizationPct >= 0.6)

  factors.push({
    label: "Monetization / investing",
    detail: monetizationEligible
      ? `Eligible up to ${(allowedMonetizationPct * 100).toFixed(0)}% LTV of assessed value.`
      : typeCode === "POF"
        ? "Proof-of-funds instrument — informational only, not monetizable."
        : "Not eligible for monetization under current parameters.",
    impact: monetizationEligible && allowedMonetizationPct >= 0.6 ? "positive" : "neutral",
  })
  factors.push({
    label: "Payment Protection Insurance (PPI)",
    detail: ppiRequired
      ? "PPI cover is required before this instrument may be traded or monetized."
      : "PPI cover is not required for this instrument.",
    impact: ppiRequired ? "neutral" : "positive",
  })

  const summary =
    `Independent assessment values this ${inst.typeFull ?? (typeCode || "instrument")} at ` +
    `${currency} ${realisticValue.toLocaleString("en-US")} (${(valuation * 100).toFixed(1)}% of the ` +
    `${currency} ${faceValue.toLocaleString("en-US")} stated face value), classified ${rating} with a risk score of ` +
    `${riskScore}/100. ` +
    (monetizationEligible
      ? `Eligible for monetization up to ${(allowedMonetizationPct * 100).toFixed(0)}% LTV${ppiRequired ? "; PPI cover required." : "."}`
      : `Not eligible for monetization.`)

  return {
    status: "draft",
    faceValue,
    currency,
    realisticValue,
    realisticPct: round2(valuation),
    riskScore,
    rating,
    investingEligible,
    monetizationEligible,
    allowedMonetizationPct,
    ppiRequired,
    factors,
    summary,
    engineVersion: AUDIT_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
  }
}

/** Whether an audit is published (i.e. visible to the client). */
export function isAuditPublished(a?: InstrumentAudit | null): boolean {
  return !!a && a.status === "published"
}

/** Tailwind text-color class for a risk score, for compact badges. */
export function riskScoreTone(score: number): "positive" | "neutral" | "negative" {
  if (score <= 20) return "positive"
  if (score <= 40) return "neutral"
  return "negative"
}
