// ---------------------------------------------------------------------------
// Tier capabilities — what a given platform tier is allowed to do.
//
// The Visitor tier is a pre-subscription test account: it can READ everything
// and RECEIVE incoming top-ups, but it has no operational power — no outgoing
// transfers, no trading, no instrument issuance, and no treasury payout. PRO
// and Avant-Garde (and any unknown/legacy badge, which normalises to PRO) keep
// full operational rights.
//
// This is a plain, synchronous, client-safe module (no server-only imports) so
// the SAME source of truth can gate both server actions and UI. The server
// enforcement is authoritative; the UI uses it purely for affordances.
// ---------------------------------------------------------------------------

import { resolvePlatformTier, type PlatformTierId } from "@/lib/platform-tier"
import { effectivePlatformTier, type MembershipRecord } from "@/lib/membership"

export interface TierCapabilities {
  /** Whether the account is restricted to read-only + incoming credits only. */
  readOnly: boolean
  /** Send outgoing money (P2P, SWIFT, wires, standing orders). */
  canSendMoney: boolean
  /** Place trades / use the exchange. */
  canTrade: boolean
  /** Create or issue instruments (SKR, guarantees, certificates, deals). */
  canCreateInstruments: boolean
  /** Request a treasury payout / withdrawal. */
  canRequestPayout: boolean
  /** Receive incoming payments / top-ups. Always allowed, including Visitor. */
  canReceiveFunds: boolean
}

const FULL_ACCESS: TierCapabilities = {
  readOnly: false,
  canSendMoney: true,
  canTrade: true,
  canCreateInstruments: true,
  canRequestPayout: true,
  canReceiveFunds: true,
}

const VISITOR_ACCESS: TierCapabilities = {
  readOnly: true,
  canSendMoney: false,
  canTrade: false,
  canCreateInstruments: false,
  canRequestPayout: false,
  canReceiveFunds: true,
}

/** Capabilities for a resolved platform tier id. */
export function capabilitiesForTierId(tierId: PlatformTierId): TierCapabilities {
  return tierId === "visitor" ? VISITOR_ACCESS : FULL_ACCESS
}

/**
 * Capabilities for an account, resolved from its badge and (optionally) an
 * active membership grant. An active PRO/Avant-Garde grant lifts a Visitor into
 * full access even if their stored badge still reads "Visitor" — so an upgraded
 * user is never trapped in read-only.
 */
export function capabilitiesForAccount(
  accountBadge: string | undefined | null,
  membership?: MembershipRecord | null,
): TierCapabilities {
  const tier = membership
    ? effectivePlatformTier(accountBadge, membership)
    : resolvePlatformTier(accountBadge)
  return capabilitiesForTierId(tier.id)
}

/** Standard user-facing message when a Visitor attempts a blocked action. */
export const VISITOR_RESTRICTION_MESSAGE =
  "Your Visitor account is read-only. Upgrade to PRO or Avant-Garde to unlock payments, trading and treasury operations. You can still receive incoming top-ups."
