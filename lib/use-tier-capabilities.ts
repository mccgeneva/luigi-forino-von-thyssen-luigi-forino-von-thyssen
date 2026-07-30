"use client"

import { useMemo } from "react"
import { useCurrentUser } from "@/lib/use-current-user"
import { capabilitiesForAccount, type TierCapabilities } from "@/lib/tier-capabilities"

/**
 * Client hook exposing what the signed-in user's tier is allowed to do.
 *
 * Resolved from the authoritative session identity's `accountBadge` (shared via
 * CurrentUserProvider), so it's consistent everywhere without extra fetches.
 * Use it to disable money-out / trading / instrument affordances for Visitor
 * accounts. Server actions still enforce the same rules authoritatively.
 */
export function useTierCapabilities(): TierCapabilities {
  const user = useCurrentUser()
  return useMemo(() => capabilitiesForAccount(user.accountBadge), [user.accountBadge])
}
