"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { expireSession, type ExpireReason } from "@/app/actions/auth"
import { SESSION_MAX_AGE, FRESH_LOGIN_COOKIE } from "@/lib/auth"

// Per-tab marker. sessionStorage is automatically cleared when the tab/window
// is closed, which is what lets us detect a closed-then-reopened tab.
const TAB_FLAG = "mcc_tab_active"
// One-time flag written by the login form so a genuine login can be told apart
// from a reopened tab that still carries a valid cookie.
const HANDOFF = "mcc_login_handoff"
// Absolute timestamp (ms) at which the session must end.
const EXPIRY = "mcc_session_expiry"
// Shared last-activity timestamp (ms) so inactivity is tracked across tabs.
const LAST_ACTIVITY = "mcc_last_activity"
// Liveness heartbeat (ms). The app stamps this continuously while it is open.
// Unlike sessionStorage (which mobile Chrome/Safari restore when the browser is
// reopened), a heartbeat in localStorage cannot be "restored" — if it is stale
// on startup, the app demonstrably was NOT running, i.e. the browser was
// closed. This is what makes close=logout reliable on mobile.
const HEARTBEAT = "mcc_heartbeat"

// Keep the client-side idle window in lock step with the server-enforced
// SESSION_IDLE_MAX_AGE (15 minutes) in lib/auth.ts.
const INACTIVITY_LIMIT = 15 * 60 * 1000 // 15 minutes
const WARNING_BEFORE = 60 * 1000 // warn 60s before inactivity logout
const TICK = 1000

// Server-session keepalive. The server slides its idle window only on GET
// navigations, but single-page areas (e.g. the admin panel) interact via
// Server Action POSTs that never slide it — so an actively-used session would
// idle-expire server-side and lock the user out mid-task. While the user is
// active we periodically GET /dashboard/keepalive, which the proxy answers by
// re-issuing the session cookies with a fresh idle window. We throttle to well
// inside the 15-minute window.
const KEEPALIVE_URL = "/dashboard/keepalive"
const KEEPALIVE_MIN_INTERVAL = 4 * 60 * 1000 // ping at most every 4 minutes
// How long the heartbeat may lapse before we treat the gap as a browser
// close/reopen. This tolerates brief app-switches (answering a call, copying a
// code from another app) while still forcing re-login after a real close.
const HEARTBEAT_TOLERANCE = 90 * 1000 // 90 seconds

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"]

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

// Reads a cookie value by name (returns null if absent).
function readCookie(name: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

// Expires a cookie immediately.
function clearCookie(name: string) {
  try {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`
  } catch {
    // ignore
  }
}

// True when the app is rendered inside an iframe (e.g. the v0 preview). The
// sandboxed iframe restricts cookies/sessionStorage, which can make tab-close
// detection misfire. We relax only that check here; the published top-level
// deployment keeps the full security behavior.
function isEmbeddedPreview(): boolean {
  try {
    return window.self !== window.top
  } catch {
    // A cross-origin access error means we are inside an iframe.
    return true
  }
}

/**
 * Client-side security guard for authenticated areas. Automatically terminates
 * the session when:
 *  - the session lifetime expires,
 *  - the browser tab/window was closed and later reopened (detected via a
 *    liveness heartbeat that survives mobile sessionStorage restoration), or
 *  - the user has been inactive for 15 minutes.
 *
 * The auth cookie is httpOnly, so termination calls the `expireSession` server
 * action to actually delete it; this component handles detection and UX.
 */
export function SessionGuard() {
  const router = useRouter()
  const endedRef = useRef(false)
  const warnedRef = useRef(false)
  const lastKeepaliveRef = useRef(0)

  useEffect(() => {
    const now = Date.now()

    // Ping the server keepalive so it slides the session's idle window forward.
    // Throttled unless `force` is set (used on mount / resume). Best-effort:
    // failures are ignored — the SessionGuard's own logic handles real expiry.
    function pingKeepalive(force = false) {
      if (endedRef.current) return
      if (isEmbeddedPreview()) return // preview iframe: cookies are unreliable
      const t = Date.now()
      if (!force && t - lastKeepaliveRef.current < KEEPALIVE_MIN_INTERVAL) return
      lastKeepaliveRef.current = t
      try {
        void fetch(KEEPALIVE_URL, { method: "GET", credentials: "include", cache: "no-store" }).catch(
          () => {
            // ignore — network blip or expired session (handled elsewhere)
          },
        )
      } catch {
        // ignore
      }
    }

    // Refresh the server session as soon as the authenticated area mounts, so
    // simply opening a page (e.g. the admin gate) re-arms the full idle window
    // even if the shell was restored from a cached PWA/bfcache state.
    pingKeepalive(true)

    function endSession(reason: ExpireReason) {
      if (endedRef.current) return
      endedRef.current = true
      try {
        localStorage.removeItem(EXPIRY)
        localStorage.removeItem(LAST_ACTIVITY)
        localStorage.removeItem(HANDOFF)
        localStorage.removeItem(HEARTBEAT)
        sessionStorage.removeItem(TAB_FLAG)
      } catch {
        // ignore storage errors
      }

      const messages: Record<ExpireReason, string> = {
        expiry: "Your session has expired. Please sign in again.",
        "tab-close": "Session ended because the tab was closed. Please sign in again.",
        inactivity: "Signed out due to 15 minutes of inactivity. Please sign in again.",
      }
      toast.dismiss("inactivity-warning")
      toast.error(messages[reason], { id: "session-ended" })

      // Delete the httpOnly cookie server-side and redirect to /login.
      void expireSession(reason)
    }

    // --- Establish or validate this session ---
    //
    // The liveness heartbeat is the source of truth for "was the app actually
    // running just before this load?". sessionStorage alone is unreliable on
    // mobile because Chrome/Safari restore it (and its TAB_FLAG) when the
    // browser is reopened, which previously let a reopened browser slip back
    // into the dashboard. The heartbeat cannot be restored — it only advances
    // while the app runs — so a stale/missing heartbeat means the browser was
    // genuinely closed.
    const lastBeat = readNumber(HEARTBEAT)
    const beatFresh = lastBeat != null && now - lastBeat <= HEARTBEAT_TOLERANCE

    // A genuine fresh login is proven, in order of reliability, by:
    //  1. the `?fresh=1` URL param the login redirect adds (works everywhere,
    //     including sandboxed iframes and mobile Safari where cookies/storage
    //     may be partitioned or blocked),
    //  2. the server-set fresh-login cookie, or
    //  3. the localStorage handoff flag.
    let freshParam = false
    try {
      freshParam = new URLSearchParams(window.location.search).get("fresh") === "1"
    } catch {
      freshParam = false
    }
    const freshCookie = readCookie(FRESH_LOGIN_COOKIE) === "1"
    let handoff = false
    try {
      handoff = localStorage.getItem(HANDOFF) === "1"
    } catch {
      handoff = false
    }
    const freshLogin = freshParam || freshCookie || handoff

    if (freshLogin || isEmbeddedPreview()) {
      // Genuine fresh login (or running inside the preview iframe, where
      // tab-close detection is unreliable): establish session markers and start
      // the heartbeat fresh, ignoring any stale value left by a prior session.
      clearCookie(FRESH_LOGIN_COOKIE)
      if (freshParam) {
        // Strip the one-time param so a later reopen of this URL can't be
        // mistaken for a fresh login.
        router.replace("/dashboard")
      }
      try {
        localStorage.removeItem(HANDOFF)
        sessionStorage.setItem(TAB_FLAG, "1")
        localStorage.setItem(EXPIRY, String(now + SESSION_MAX_AGE * 1000))
        localStorage.setItem(LAST_ACTIVITY, String(now))
        localStorage.setItem(HEARTBEAT, String(now))
      } catch {
        // ignore storage errors
      }
    } else if (!beatFresh) {
      // No fresh-login signal and the heartbeat is stale/missing => the browser
      // was closed and reopened (or the page was opened directly) while a
      // cookie lingered. Terminate, even if sessionStorage was restored.
      endSession("tab-close")
      return
    } else {
      // Heartbeat is fresh: this is a real reload or in-app navigation of an
      // app that was running moments ago. Keep the existing markers and resume
      // the heartbeat without resetting expiry/activity.
      try {
        sessionStorage.setItem(TAB_FLAG, "1")
        if (readNumber(EXPIRY) == null) {
          localStorage.setItem(EXPIRY, String(now + SESSION_MAX_AGE * 1000))
        }
        if (readNumber(LAST_ACTIVITY) == null) {
          localStorage.setItem(LAST_ACTIVITY, String(now))
        }
        localStorage.setItem(HEARTBEAT, String(now))
      } catch {
        // ignore
      }
    }

    // --- Activity tracking (shared across tabs via localStorage) ---
    function markActivity() {
      if (endedRef.current) return
      warnedRef.current = false
      try {
        localStorage.setItem(LAST_ACTIVITY, String(Date.now()))
      } catch {
        // ignore
      }
      // Keep the SERVER session alive too (throttled). Client activity alone
      // does not slide the server idle window; this bridges the two so an
      // actively-used SPA session never idle-expires server-side.
      pingKeepalive()
      toast.dismiss("inactivity-warning")
    }

    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, markActivity, { passive: true }),
    )

    // --- Periodic checks for expiry and inactivity ---
    const interval = window.setInterval(() => {
      if (endedRef.current) return
      const t = Date.now()

      // Advance the liveness heartbeat. This proves the app is still running so
      // that a later browser reopen can distinguish "was open moments ago"
      // (reload) from "was closed" (force re-login).
      try {
        localStorage.setItem(HEARTBEAT, String(t))
      } catch {
        // ignore
      }

      const expiry = readNumber(EXPIRY)
      if (expiry != null && t >= expiry) {
        endSession("expiry")
        return
      }

      const last = readNumber(LAST_ACTIVITY) ?? t
      const idle = t - last

      if (idle >= INACTIVITY_LIMIT) {
        endSession("inactivity")
        return
      }

      if (idle >= INACTIVITY_LIMIT - WARNING_BEFORE && !warnedRef.current) {
        warnedRef.current = true
        toast.warning("You're about to be signed out", {
          id: "inactivity-warning",
          description: "For your security, you'll be logged out shortly due to inactivity.",
          duration: WARNING_BEFORE,
          action: { label: "Stay signed in", onClick: () => markActivity() },
        })
      }
    }, TICK)

    // --- Cross-tab sync: react when another tab ends the session ---
    function onStorage(e: StorageEvent) {
      if (endedRef.current) return
      if (e.key === EXPIRY && e.newValue == null) {
        endedRef.current = true
        toast.dismiss("inactivity-warning")
        router.replace("/login?expired=tab-close")
      }
    }
    window.addEventListener("storage", onStorage)

    // --- Resume check: when a frozen/backgrounded tab returns to the
    // foreground WITHOUT a full reload (common on mobile), the heartbeat
    // interval was suspended. If it lapsed beyond tolerance the browser was
    // effectively closed, so terminate; otherwise resume the heartbeat. ---
    function onResume() {
      if (endedRef.current) return
      if (document.visibilityState !== "visible") return
      if (isEmbeddedPreview()) return
      const t = Date.now()
      const beat = readNumber(HEARTBEAT)
      if (beat != null && t - beat > HEARTBEAT_TOLERANCE) {
        endSession("tab-close")
        return
      }
      try {
        localStorage.setItem(HEARTBEAT, String(t))
      } catch {
        // ignore
      }
      // Returning to the foreground: re-arm the server idle window right away so
      // the next Server Action (e.g. unlocking the admin panel) isn't rejected.
      pingKeepalive(true)
    }
    document.addEventListener("visibilitychange", onResume)
    window.addEventListener("pageshow", onResume)

    return () => {
      window.clearInterval(interval)
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, markActivity))
      window.removeEventListener("storage", onStorage)
      document.removeEventListener("visibilitychange", onResume)
      window.removeEventListener("pageshow", onResume)
    }
  }, [router])

  return null
}
