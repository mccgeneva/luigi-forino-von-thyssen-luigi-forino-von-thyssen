"use client"

import { useEffect } from "react"

// All client-side storage keys the app uses to track a session. Kept in sync
// with SessionGuard / login-form / user-scope.
const STORAGE_KEYS = [
  "mcc_tab_active",
  "mcc_login_handoff",
  "mcc_session_expiry",
  "mcc_last_activity",
  "mcc_heartbeat",
  // Administrator panel unlock flag — wiped on reaching /login so a logged-out
  // admin's unlock can never carry over to the next user on this device.
  "mcc.admin.unlocked.v1",
]

// Expires a cookie across every path/SameSite/Secure variant the app might have
// set it with, so nothing lingers between publishes or after sign-out.
function nukeCookie(name: string) {
  const attrs = [
    "path=/; max-age=0",
    "path=/; max-age=0; SameSite=Lax",
    "path=/; max-age=0; SameSite=None; Secure",
    `path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ]
  for (const a of attrs) {
    try {
      document.cookie = `${name}=; ${a}`
    } catch {
      // ignore
    }
  }
}

/**
 * Full client-side clean slate for the login screen.
 *
 * Reaching /login always means there is no valid server session (the proxy
 * redirects authenticated users away). This component wipes every client-
 * readable auth cookie and per-tab session marker so a freshly published build
 * — or a reopened browser — can never inherit a stale session that bounces the
 * user or shows the wrong identity. The httpOnly session cookie is already
 * cleared server-side by logout/expireSession.
 */
export function SessionReset() {
  useEffect(() => {
    // 1) Clear known auth cookies, plus defensively any other readable mcc_* cookie.
    const known = ["mcc_user", "mcc_fresh"]
    for (const name of known) nukeCookie(name)
    try {
      for (const pair of document.cookie.split(";")) {
        const name = pair.split("=")[0]?.trim()
        if (name && name.startsWith("mcc_")) nukeCookie(name)
      }
    } catch {
      // ignore
    }

    // 2) Clear per-tab/session storage markers.
    try {
      for (const key of STORAGE_KEYS) {
        localStorage.removeItem(key)
        sessionStorage.removeItem(key)
      }
    } catch {
      // ignore storage access errors (e.g. privacy mode)
    }
  }, [])

  return null
}
