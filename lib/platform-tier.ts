import { Crown, Star, BadgeCheck, Eye, type LucideIcon } from "lucide-react"

/**
 * The platform membership tier a client is on. Derived from the user's
 * `accountBadge` (the field admins set to "PRO Account" / "Avant-garde Account"
 * in the user manager), so it stays correct for both static and admin-created
 * accounts without duplicating state.
 */
export type PlatformTierId = "visitor" | "pro" | "avantgarde" | "other"

export interface PlatformTier {
  id: PlatformTierId
  /** Short display name, e.g. "PRO" or "Avant-Garde". */
  label: string
  /** One-line description of who the tier is for. */
  tagline: string
  icon: LucideIcon
  /** True for the premium (top) membership. */
  premium: boolean
}

/**
 * Normalise a free-text account badge into a known platform tier.
 *
 * Avant-Garde is the institutional / high-net-worth membership, so badges that
 * read "Institutional" map to it as well. Anything we don't recognise is shown
 * verbatim under a neutral style so no client ever sees a blank tier.
 */
export function resolvePlatformTier(accountBadge: string | undefined | null): PlatformTier {
  const badge = (accountBadge ?? "").trim()
  const normalized = badge.toLowerCase()

  if (normalized.includes("avant") || normalized.includes("institutional")) {
    return {
      id: "avantgarde",
      label: "Avant-Garde",
      tagline: "Institutional & high-net-worth membership",
      icon: Crown,
      premium: true,
    }
  }

  if (normalized.includes("visitor")) {
    return {
      id: "visitor",
      label: "Visitor",
      tagline: "Read-only trial — upgrade to PRO or Avant-Garde anytime",
      icon: Eye,
      premium: false,
    }
  }

  if (normalized.includes("pro")) {
    return {
      id: "pro",
      label: "PRO",
      tagline: "For active private investors & SMEs",
      icon: Star,
      premium: false,
    }
  }

  return {
    id: "other",
    label: badge || "Standard",
    tagline: "Platform membership",
    icon: BadgeCheck,
    premium: false,
  }
}
