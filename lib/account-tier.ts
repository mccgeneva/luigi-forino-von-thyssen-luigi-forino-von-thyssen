// Client accounts can be one of three membership tiers. Anything else
// (legacy "Client Account", a blank value, "Institutional", etc.) is normalised
// so a client never sees an account type the platform does not offer.
//
// - "Visitor Account"    → pre-subscription test account: read-only, top-up only,
//                          no treasury payout. KYC is filled and ready to upgrade.
// - "PRO Account"        → default paid tier (also the fallback for unknown badges).
// - "Avant-garde Account"→ institutional / high-net-worth membership.
//
// This lives in a plain module (not a "use server" file) so it can be a regular
// synchronous helper shared by both server actions and client components.

export const ACCOUNT_TIERS = ["Visitor Account", "PRO Account", "Avant-garde Account"] as const

export type AccountTier = (typeof ACCOUNT_TIERS)[number]

export function normalizeAccountBadge(badge: string | undefined | null): AccountTier {
  const v = (badge ?? "").trim().toLowerCase()
  if (v.includes("avant") || v.includes("institutional")) return "Avant-garde Account"
  // Visitor must be explicitly assigned by an admin; PRO stays the default
  // fallback so existing/unclassified accounts keep their current access.
  if (v.includes("visitor")) return "Visitor Account"
  return "PRO Account"
}
