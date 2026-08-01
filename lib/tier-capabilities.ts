// ---------------------------------------------------------------------------
// Tier capabilities — what a given platform tier is allowed to do.
//
// The Visitor tier is a pre-subscription test account. It can READ everything,
// SEND outgoing payments and RECEIVE incoming payments/top-ups — but it still
// has no market or treasury power: no trading, no instrument issuance, and no
// treasury payout/withdrawal. PRO and Avant-Garde (and any unknown/legacy
// badge, which normalises to PRO) keep full operational rights.
//
// This is a plain, synchronous, client-safe module (no server-only imports) so
// the SAME source of truth can gate both server actions and UI. The server
// enforcement is authoritative; the UI uses it purely for affordances.
// ---------------------------------------------------------------------------

import { resolvePlatformTier, type PlatformTierId } from "@/lib/platform-tier"
import { effectivePlatformTier, type MembershipRecord } from "@/lib/membership"

export interface TierCapabilities {
  /** Whether the account is restricted to read-only (no money movement at all). */
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
  // Visitor is no longer read-only: it can move money in and out. It still
  // cannot trade, issue instruments, or request a treasury payout.
  readOnly: false,
  canSendMoney: true,
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

/** Standard user-facing message when a Visitor attempts a still-restricted action. */
export const VISITOR_RESTRICTION_MESSAGE =
  "Your Visitor account can send and receive payments, but trading, instrument issuance and treasury payouts are disabled. Upgrade to PRO or Avant-Garde to unlock them."
