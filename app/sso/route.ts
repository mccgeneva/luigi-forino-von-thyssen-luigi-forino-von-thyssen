// ---------------------------------------------------------------------------
// GET /sso?token=<one-time-token>[&next=/path]
//
// Consumes a one-time hand-off token minted by POST /api/v1/sso and establishes
// the normal mcc-btp.app session for the EXISTING account the token points to.
// This is how an NQAi.cloud user lands signed into their own bank account with
// their inherited identity — no second password is involved.
//
// The token is single-use and short-lived (see lib/sso-tokens-db.ts). On any
// failure the user is bounced to /login with a reason, never left in limbo.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import {
  SESSION_COOKIE,
  SESSION_META_COOKIE,
  SESSION_MAX_AGE,
  FRESH_LOGIN_COOKIE,
  IMPERSONATION_COOKIE,
  sessionCookieOptions,
  sessionMetaCookieOptions,
  freshLoginCookieOptions,
  userCookieOptions,
  expiredCookieOptions,
} from "@/lib/auth"
import { USER_COOKIE } from "@/lib/user-scope"
import { signSessionMeta } from "@/lib/session-token"
import { consumeSsoToken } from "@/lib/sso-tokens-db"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { logActivity } from "@/app/actions/log-activity"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const requestUrl = new URL(req.url)
  const origin = requestUrl.origin
  const token = requestUrl.searchParams.get("token")

  const bounce = (reason: string) =>
    NextResponse.redirect(new URL(`/login?sso=${reason}`, origin))

  // Atomically consume the one-time token.
  const consumed = await consumeSsoToken(token).catch(() => null)
  if (!consumed) return bounce("invalid")

  // Resolve the target account for its per-user session token + identity.
  const account = await getDynamicUserById(consumed.userId).catch(() => undefined)
  if (!account || account.status !== "active") return bounce("account")

  // Land where the caller asked (same-site relative only), else the dashboard.
  const nextParam = requestUrl.searchParams.get("next")
  const landing =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard"
  // `fresh=1` tells SessionGuard this is a genuine login (not a reopened tab),
  // exactly like the password/face login redirect (POST_LOGIN_PATH).
  const dest = new URL(landing, origin)
  dest.searchParams.set("fresh", "1")

  const res = NextResponse.redirect(dest)

  // Establish the SAME session cookies a normal login sets (mirrors
  // establishSession in app/actions/auth.ts): the httpOnly session token, the
  // readable user id, the signed absolute-expiry metadata, and the fresh-login
  // marker. Any lingering impersonation marker is cleared.
  res.cookies.set(SESSION_COOKIE, account.sessionToken, sessionCookieOptions)
  res.cookies.set(USER_COOKIE, account.id, userCookieOptions)

  const nowMs = Date.now()
  const metaToken = await signSessionMeta({
    iat: nowMs,
    exp: nowMs + SESSION_MAX_AGE * 1000,
    seen: nowMs,
  })
  res.cookies.set(SESSION_META_COOKIE, metaToken, sessionMetaCookieOptions)
  res.cookies.set(FRESH_LOGIN_COOKIE, "1", freshLoginCookieOptions)
  res.cookies.set(IMPERSONATION_COOKIE, "", expiredCookieOptions)

  await logActivity({
    action: "SSO sign-in completed",
    category: "Authentication",
    user: `${account.profile.fullName} (${account.profile.company})`,
    userId: account.id,
    details: { email: consumed.email, result: "granted", method: "nqai-sso" },
  }).catch(() => {})

  return res
}
