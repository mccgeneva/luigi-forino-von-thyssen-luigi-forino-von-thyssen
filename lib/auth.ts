// Credentials and per-user session tokens now live in the multi-user registry
// (lib/users.ts). This module only owns the cookie configuration shared by all
// users.

// Name of the httpOnly session cookie set after a successful login. Its value
// is the signed-in user's per-user session token.
export const SESSION_COOKIE = "mcc_session"

// httpOnly, HMAC-signed companion cookie holding the session metadata
// (issued-at / absolute-expiry / last-seen). This is what makes session expiry
// enforceable on the SERVER (Edge proxy + resolver) instead of relying on
// client-side JavaScript. See lib/session-token.ts.
export const SESSION_META_COOKIE = "mcc_sess_meta"

// Short-lived, client-readable cookie set by the login action to mark a genuine
// fresh login. Consumed once by the SessionGuard, then cleared.
export const FRESH_LOGIN_COOKIE = "mcc_fresh"

// httpOnly, HMAC-signed cookie set when an administrator "signs in as" a client
// for maintenance (impersonation). It records the ORIGINAL admin's id + session
// token (so the admin session can be restored in one click) and the impersonated
// target id. Because it is signed, the client cannot forge it; the server-side
// session resolver reads it to (a) resolve the session to the TARGET account —
// regardless of its status, so suspended/inactive accounts can be serviced — and
// (b) surface a "Return to admin" banner. See lib/session-token.ts.
export const IMPERSONATION_COOKIE = "mcc_imp"

// Absolute session lifetime in seconds (8 hours) — a hard cap that is never
// extended, even for an actively-used session.
export const SESSION_MAX_AGE = 60 * 60 * 8

// Idle (inactivity) window in seconds. The session must see at least one request
// within this window or it is rejected server-side. It also drives the cookie
// `maxAge`, so the browser itself drops the cookie after this much inactivity —
// which is what makes "closed the browser and came back later" log you out even
// when the browser tries to restore the cookie. The proxy slides this window
// forward on every authenticated request, so active users are never disrupted.
export const SESSION_IDLE_MAX_AGE = 60 * 15 // 15 minutes

// Cookie attributes. The v0 preview renders the app inside a cross-origin
// iframe, where browsers only store/send cookies marked `SameSite=None; Secure`.
// `SameSite=Lax` cookies are dropped in that third-party context, which made the
// session vanish right after login (blank page / redirect bounce) in preview
// even though it worked once published at the top level. `Secure` is valid here
// because the preview and production are both HTTPS, and browsers treat
// `http://localhost` as a secure context, so local development keeps working.
//
// SECURITY: `maxAge` is set to the IDLE window (not the full 8h) and is slid
// forward by the proxy on every authenticated request. This means:
//  - the browser drops the cookie after `SESSION_IDLE_MAX_AGE` of no requests,
//    so a browser that restores cookies on relaunch can no longer silently
//    restore a stale session after the user has been away, and
//  - the absolute 8h lifetime is enforced independently and server-side via the
//    signed metadata cookie (see SESSION_META_COOKIE), so it cannot be bypassed
//    by the client even if JavaScript never runs.
export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: SESSION_IDLE_MAX_AGE,
} as const

// httpOnly options for the signed session-metadata cookie. Same idle-bounded
// maxAge so it dies in lock step with the session cookie.
export const sessionMetaCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: SESSION_IDLE_MAX_AGE,
} as const

// Same cross-iframe-safe attributes for the short-lived, client-readable
// fresh-login marker.
export const freshLoginCookieOptions = {
  httpOnly: false,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 60,
} as const

// httpOnly options for the signed impersonation cookie. Given the full absolute
// session lifetime (8h) rather than the idle window, so a long maintenance
// session is never silently dropped while still inside the 8h cap. The idle /
// absolute-expiry rules are still enforced independently by the session-metadata
// cookie, and this cookie is always cleared on logout / fresh login / return.
export const impersonationCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: SESSION_MAX_AGE,
} as const

// Client-readable cookie holding the signed-in user's id. The client uses it to
// (a) display the right identity and (b) namespace that user's data. It is NOT
// a security boundary — access is gated by the httpOnly session token in the
// proxy; this cookie only selects which tenant's identity/data to show.
//
// Idle-bounded `maxAge` in lock step with the session cookie — it must never
// outlive the session and point a fresh visitor at the previous user's
// identity/data.
export const userCookieOptions = {
  httpOnly: false,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: SESSION_IDLE_MAX_AGE,
} as const

// Attributes for EXPIRING (clearing) a cookie. A cookie is only overwritten /
// removed by the browser when the clearing `Set-Cookie` matches the original on
// name + path + domain AND carries compatible attributes. Cookies set with
// `SameSite=None; Secure` (required so the session survives inside the
// cross-origin preview iframe) are NOT reliably removed by Next's bare
// `cookies().delete(name)`, because that emits a `Set-Cookie` without
// `SameSite=None; Secure` — so the original cookie lingers and a post-logout
// refresh silently re-authenticates. Always clear session cookies with these
// matching attributes and `maxAge: 0`.
export const expiredCookieOptions = {
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 0,
  expires: new Date(0),
} as const
