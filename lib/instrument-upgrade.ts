// ---------------------------------------------------------------------------
// Bank instrument "transformation / upgrade" scheme (server-safe, no React).
//
// An Administrator can take a bank instrument a customer holds and apply for a
// transformation upgrade into a fresh, better instrument issued by a reputable
// partner bank.
//
// The deal is NEGOTIATED first: the Administrator proposes a new instrument +
// face value; the customer can discuss it (chat) and submit a counter-offer;
// the Administrator can revise the proposal or withdraw it. During negotiation
// the OLD instrument stays fully usable and NO fee is charged.
//
// Only when the customer CONFIRMS the agreed deal is the one-time 0.08%
// expertise + upgrade fee charged (balance checked first), the OLD instrument
// retired, and the fresh instrument published into the customer's portfolio.
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

/**
 * Lifecycle of an instrument upgrade.
 * - `negotiating` — admin proposed a deal; old instrument stays usable, NO fee
 *   charged. Customer can counter / discuss; admin can revise / withdraw.
 * - `proposed` — LEGACY: old flow where the fee was charged and the instrument
 *   blocked at proposal time. Still supported for accept/decline/refund.
 * - `accepted` — customer confirmed; fee charged, new instrument published,
 *   old one retired.
 * - `declined` — offer withdrawn/declined; any charged fee refunded.
 */
export type InstrumentUpgradeStatus = "negotiating" | "proposed" | "accepted" | "declined"

/**
 * The upgrade deal stored on the OLD instrument approval's `payload.upgrade`.
 */
export interface InstrumentUpgrade {
  status: InstrumentUpgradeStatus
  /** ISO timestamp the Administrator started the upgrade. */
  proposedAt: string
  /** Fee rate that WILL apply / did apply (e.g. 0.0008 = 0.08%). */
  feeRate: number
  /** The fee (charged on accept, or already charged for legacy `proposed`). */
  fee: number
  /** Currency the fee is charged in (the old instrument's currency). */
  feeCurrency: string
  /** Face value of the old instrument the fee is based on. */
  oldFaceValue: number
  /** Whether the upfront fee has actually been charged yet. */
  feeCharged?: boolean

  // --- Customer counter-offer (during negotiation) --------------------------
  /** Face value the customer proposed back to the administrator, if any. */
  customerCounterFaceValue?: number
  /** ISO timestamp of the customer's latest counter-offer. */
  customerCounterAt?: string
  /** Optional customer note accompanying the counter-offer. */
  customerCounterNote?: string

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

/** True when the deal is still open (customer can act on it). */
export function isUpgradeOpen(u?: InstrumentUpgrade | null): boolean {
  return !!u && (u.status === "negotiating" || u.status === "proposed")
}

/**
 * True when the deal currently BLOCKS the old instrument from any use.
 * Only the legacy `proposed` (fee-charged) flow blocks; `negotiating` does not.
 */
export function upgradeBlocksInstrument(u?: InstrumentUpgrade | null): boolean {
  return !!u && u.status === "proposed"
}
