"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { getUserById, UNKNOWN_USER_ID, type UserProfile } from "@/lib/users"
import { hydrateProfile } from "@/lib/profile-types"
import { getMyIdentity, type MyIdentity } from "@/app/actions/admin-users"
import { USER_COOKIE } from "@/lib/user-scope"
import { SESSION_IDLE_MAX_AGE } from "@/lib/auth"
import type { SectionAccessMap } from "@/lib/dashboard-sections"

/**
 * Identity is resolved ONCE per session from the authoritative httpOnly session
 * cookie (server action `getMyIdentity`) and shared with every consumer through
 * React context.
 *
 * Why a provider instead of resolving inside the hook:
 *  - The dashboard renders many components that each need the current user
 *    (header, welcome banner, tier banner, cards, activity tracker, page
 *    bodies, ...). If every one called `getMyIdentity()` on mount we'd fire a
 *    dozen identical server actions per navigation. Next.js executes Server
 *    Actions SERIALLY, so that herd of redundant calls queues up behind (and
 *    ahead of) the real data fetches and any action triggered by a click —
 *    making the whole UI feel frozen / "nothing is clickable" on slower or
 *    higher-latency environments. Resolving once removes that contention.
 *
 * Security note: the client-readable `mcc_user` cookie is never trusted for
 * identity. We always confirm against the session, so a stale/overwritten
 * cookie can never display — or act as — another real account. Until the server
 * confirms, the neutral placeholder is shown.
 */

const CurrentUserContext = createContext<UserProfile | null>(null)

/** Whether the acting session is an authorized administrator. Resolved on the
 *  server (allowlist + impersonation-aware) and used purely to decide whether to
 *  SHOW admin navigation. Defaults to false so non-admins never see admin UI. */
const IsAdminContext = createContext<boolean>(false)

/** Per-user administrator section-access overrides for the signed-in account,
 *  resolved server-side with the identity. Consumed by the dashboard section
 *  gate. Defaults to an empty map (no overrides → tier defaults apply). */
const SectionAccessContext = createContext<SectionAccessMap>({})

/** Imperative actions that let UI update the shared identity in place. Kept in a
 *  separate context so the many read-only `useCurrentUser()` consumers don't
 *  need to change. */
interface CurrentUserActions {
  /** Reflect a newly uploaded / removed avatar immediately, before the next
   *  server re-confirm. Pass `null` to clear it. */
  setAvatarUrl: (url: string | null) => void
  /** Re-fetch the authoritative identity from the server. */
  refreshIdentity: () => void
}

const CurrentUserActionsContext = createContext<CurrentUserActions | null>(null)

function resolveNeutral(): UserProfile {
  return getUserById(UNKNOWN_USER_ID)
}

// Turn the authoritative server identity into a full client profile.
function identityToProfile(identity: MyIdentity | null | undefined): UserProfile {
  if (!identity) return resolveNeutral()
  if (identity.kind === "static") return getUserById(identity.id)
  return hydrateProfile(identity.profile)
}

// Force the client-readable `mcc_user` data-scope cookie to match the
// authoritative session identity. This is what guarantees the data the user
// sees (namespaced by this cookie) can never belong to a different account than
// the one their session resolves to — closing the identity/data desync.
function reconcileUserCookie(id: string | undefined) {
  if (typeof document === "undefined" || !id) return
  try {
    const current = document.cookie.match(new RegExp(`(?:^|; )${USER_COOKIE}=([^;]*)`))
    const value = current ? decodeURIComponent(current[1]) : ""
    if (value === id) return
    document.cookie = `${USER_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${SESSION_IDLE_MAX_AGE}; SameSite=None; Secure`
  } catch {
    // ignore — a cookie write failure must never break rendering
  }
}

export function CurrentUserProvider({
  initialIdentity,
  children,
}: {
  /** Authoritative identity resolved on the server (per request) and passed in
   *  by the dashboard layout. Seeding from this means the correct account is
   *  shown immediately on first paint — there is no neutral flash and no stale
   *  client-cached identity to flip to another user on refresh/navigation. */
  initialIdentity?: MyIdentity | null
  children: React.ReactNode
}) {
  // Seed synchronously from the server-resolved identity. The initializer also
  // reconciles the data-scope cookie BEFORE the inner store providers mount, so
  // both the displayed identity and the data namespace are locked to the same
  // authoritative account from the very first render.
  const [user, setUser] = useState<UserProfile>(() => {
    const profile = identityToProfile(initialIdentity)
    reconcileUserCookie(profile.id !== UNKNOWN_USER_ID ? profile.id : undefined)
    return profile
  })

  // Seed the admin flag from the server-resolved identity so the correct nav is
  // shown on first paint (no admin-link flash for non-admins).
  const [isAdmin, setIsAdmin] = useState<boolean>(() => initialIdentity?.isAdmin ?? false)

  // Seed the per-user section-access overrides from the server-resolved identity
  // so the gate enforces admin locks/unlocks from the very first render.
  const [sectionAccess, setSectionAccess] = useState<SectionAccessMap>(
    () => initialIdentity?.sectionAccess ?? {},
  )

  const initialId = initialIdentity?.id

  const refreshIdentity = useCallback(() => {
    getMyIdentity()
      .then((identity) => {
        const profile = identityToProfile(identity)
        reconcileUserCookie(profile.id !== UNKNOWN_USER_ID ? profile.id : undefined)
        setUser(profile)
        setIsAdmin(identity?.isAdmin ?? false)
        setSectionAccess(identity?.sectionAccess ?? {})
      })
      .catch(() => {
        // ignore — keep the current identity on a transient failure.
      })
  }, [])

  const setAvatarUrl = useCallback((url: string | null) => {
    setUser((prev) => ({ ...prev, avatarUrl: url ?? undefined }))
  }, [])

  useEffect(() => {
    // Re-confirm against the server after mount. The layout already provides the
    // correct identity per request, but this keeps a long-lived client session
    // (where the layout isn't re-rendered) in lock step with the session cookie.
    let cancelled = false

    getMyIdentity()
      .then((identity) => {
        if (cancelled) return
        const profile = identityToProfile(identity)
        reconcileUserCookie(profile.id !== UNKNOWN_USER_ID ? profile.id : undefined)
        setUser(profile)
        setIsAdmin(identity?.isAdmin ?? false)
        setSectionAccess(identity?.sectionAccess ?? {})
      })
      .catch(() => {
        // Network/transient error — keep the server-seeded identity rather than
        // dropping to neutral, so a hiccup never blanks a valid session.
      })

    return () => {
      cancelled = true
    }
  }, [initialId])

  const actions = useMemo<CurrentUserActions>(
    () => ({ setAvatarUrl, refreshIdentity }),
    [setAvatarUrl, refreshIdentity],
  )

  return (
    <CurrentUserContext.Provider value={user}>
      <IsAdminContext.Provider value={isAdmin}>
        <SectionAccessContext.Provider value={sectionAccess}>
          <CurrentUserActionsContext.Provider value={actions}>{children}</CurrentUserActionsContext.Provider>
        </SectionAccessContext.Provider>
      </IsAdminContext.Provider>
    </CurrentUserContext.Provider>
  )
}

/**
 * Returns the identity profile of the currently signed-in user.
 *
 * Reads from the shared CurrentUserProvider context. If used outside a provider
 * (defensive fallback) it returns the neutral placeholder rather than throwing,
 * so a stray consumer can never crash the tree or expose a real account.
 */
export function useCurrentUser(): UserProfile {
  const ctx = useContext(CurrentUserContext)
  return ctx ?? resolveNeutral()
}

/**
 * Imperative helpers to update the shared identity in place (e.g. after the
 * user changes their profile picture). No-ops when used outside a provider.
 */
export function useCurrentUserActions(): CurrentUserActions {
  const ctx = useContext(CurrentUserActionsContext)
  return ctx ?? { setAvatarUrl: () => {}, refreshIdentity: () => {} }
}

/**
 * Whether the currently signed-in session is an authorized administrator.
 * Server-resolved (allowlist + impersonation-aware). Use this to gate admin-only
 * UI such as the Administrator navigation entry. Defaults to `false` outside a
 * provider so admin UI is never shown by accident.
 */
export function useIsAdmin(): boolean {
  return useContext(IsAdminContext)
}

/**
 * Per-user administrator section-access overrides for the signed-in account.
 * Consumed by the dashboard section gate to enforce admin locks/unlocks on top
 * of the tier defaults. Empty map outside a provider (no overrides).
 */
export function useSectionAccess(): SectionAccessMap {
  return useContext(SectionAccessContext)
}
