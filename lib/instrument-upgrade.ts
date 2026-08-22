// ---------------------------------------------------------------------------
// Bank instrument "transformation / upgrade" scheme (server-safe, no React).
//
// An Administrator can take a bank instrument a customer holds and apply for a
// transformation upgrade into a fresh, better instrument issued by a reputable
// partner bank. While the upgrade is in progress the OLD instrument is BLOCKED
// (no monetization / leverage / yield / transfer / return) until the new one is
// delivered into the platform treasury and issued to the customer.
//
// The expertise + upgrade cost is a one-time 0.08% upfront fee on the OLD
// instrument's face value, charged to the customer's Master Account when the
// Administrator starts the upgrade (the customer's balance is checked first).
// The new instrument's face value is negotiated by the Administrator and
// proposed to the customer as a deal; on acceptance the fresh instrument is
// transferred into the customer's portfolio immediately.
//
// This module is intentionally dependency-free so it can be imported from both
// client components and server actions / API routes.
// ---------------------------------------------------------------------------

/** One-time expertise + upgrade fee, as a fraction of the OLD face value. */
export const INSTRUMENT_UPGRADE_FEE_RATE = 0.0008

/** Human label for the fee rate, e.g. "0.08%" (kept in sync with the rate). */
export const INSTRUMENT_UPGRADE_FEE_LABEL = `${(INSTRUMENT_UPGRADE_FEE_RATE * 100).toLocaleString("en-US", {
  maximumFractionDigits: 4,
})}%`

/** The upgrade fee on a given face value, rounded to 2 decimals. */
export function instrumentUpgradeFee(faceValue: number): number {
  if (!Number.isFinite(faceValue) || faceValue <= 0) return 0
  return Math.round(faceValue * INSTRUMENT_UPGRADE_FEE_RATE * 100) / 100
}

/** Lifecycle of a proposed instrument upgrade. */
export type InstrumentUpgradeStatus = "proposed" | "accepted" | "declined"

/**
 * The upgrade deal stored on the OLD instrument approval's `payload.upgrade`.
 * `status === "proposed"` means the old instrument is blocked and the customer
 * has a pending deal to accept or decline.
 */
export interface InstrumentUpgrade {
  status: InstrumentUpgradeStatus
  /** ISO timestamp the Administrator started the upgrade. */
  proposedAt: string
  /** Fee rate applied (e.g. 0.0008 = 0.08%). */
  feeRate: number
  /** The fee actually charged, in `feeCurrency`. */
  fee: number
  /** Currency the fee was charged in (the old instrument's currency). */
  feeCurrency: string
  /** Face value of the old instrument the fee was based on. */
  oldFaceValue: number

  // --- The negotiated NEW instrument proposed to the customer ---------------
  newType: string
  newTypeFull: string
  /** Reputable partner bank issuing the fresh instrument. */
  newIssuer: string
  newIssuerCountry?: string
  newIssuerBic?: string
  /** Negotiated face value of the new instrument. */
  newFaceValue: number
  newCurrency: string
  /** Terms & agreements presented with the deal. */
  terms?: string
  /** Optional Administrator note shown to the customer. */
  note?: string

  /** ISO timestamp the customer accepted / declined. */
  decidedAt?: string
  /** Id of the freshly issued instrument once accepted. */
  newInstrumentId?: string
}

/** A concise human summary of the proposed new instrument. */
export function describeUpgradeTarget(u: Pick<InstrumentUpgrade, "newTypeFull" | "newIssuer" | "newFaceValue" | "newCurrency">): string {
  const face = Number.isFinite(u.newFaceValue) ? u.newFaceValue.toLocaleString("en-US") : String(u.newFaceValue)
  return `${u.newCurrency} ${face} ${u.newTypeFull} — ${u.newIssuer}`
}
