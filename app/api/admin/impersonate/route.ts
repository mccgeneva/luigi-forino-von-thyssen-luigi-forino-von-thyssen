import { type NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
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
  impersonationCookieOptions,
  expiredCookieOptions,
} from "@/lib/auth"
import { USER_COOKIE } from "@/lib/user-scope"
import { signSessionMeta, signImpersonation, verifyImpersonation } from "@/lib/session-token"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { resolveCurrentSession } from "@/lib/session-user"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { logActivity } from "@/app/actions/log-activity"

// ---------------------------------------------------------------------------
// Administrator "Sign in as" (impersonation) as a ROUTE HANDLER.
//
// This logic used to live in the Server Actions `startImpersonation` /
// `stopImpersonation`, but Server Action POSTs are silently rejected on this
// app's production domains + mobile in-app webviews (same root cause as the
// admin user list and Face ID enroll). That left the "Sign in as" button
// spinning forever. Route Handlers are exempt from that Origin/Host check.
//
// The handler sets the same cookies and returns a JSON `{ ok, redirect }` — the
// client performs a hard navigation so the new session cookie takes effect.
// ---------------------------------------------------------------------------

/** Issue a fresh signed session-metadata cookie (8h absolute cap from now). */
async function issueFreshMeta(): Promise<void> {
  const cookieStore = await cookies()
  const nowMs = Date.now()
  const metaToken = await signSessionMeta({
    iat: nowMs,
    exp: nowMs + SESSION_MAX_AGE * 1000,
    seen: nowMs,
  })
  cookieStore.set(SESSION_META_COOKIE, metaToken, sessionMetaCookieOptions)
  cookieStore.set(FRESH_LOGIN_COOKIE, "1", freshLoginCookieOptions)
}

function readPasscode(req: NextRequest, body: unknown): string {
  const fromHeader = req.headers.get("x-admin-passcode")
  if (fromHeader) return fromHeader
  if (body && typeof body === "object" && "passcode" in body) {
    return String((body as { passcode?: unknown }).passcode ?? "")
  }
  return req.nextUrl.searchParams.get("p") ?? ""
}

/** POST — begin impersonating a client. Body: `{ passcode, targetUserId }`. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { passcode?: string; targetUserId?: string }
    | null
  const passcode = readPasscode(req, body)
  const targetUserId = String(body?.targetUserId ?? "")

  if (passcode !== ADMIN_PASSCODE) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  if (!targetUserId) {
    return NextResponse.json({ ok: false, error: "No target account specified." }, { status: 400 })
  }

  const cookieStore = await cookies()

  // Refuse to nest: the admin must return to their own session before stepping
  // into another account, otherwise the saved "admin token" would be a client's.
  const existing = await verifyImpersonation(cookieStore.get(IMPERSONATION_COOKIE)?.value)
  if (existing) {
    return NextResponse.json(
      { ok: false, error: "You are already signed in as a client. Return to admin first." },
      { status: 409 },
    )
  }

  // The acting administrator's OWN session (not yet impersonating).
  const adminSession = await resolveCurrentSession()
  const adminToken = cookieStore.get(SESSION_COOKIE)?.value
  if (!adminSession || !adminToken) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Please sign in again." },
      { status: 401 },
    )
  }

  const target = await getDynamicUserById(targetUserId)
  if (!target) {
    return NextResponse.json({ ok: false, error: "That client account could not be found." }, { status: 404 })
  }
  if (target.id === adminSession.id) {
    return NextResponse.json({ ok: false, error: "You are already signed in as this account." }, { status: 400 })
  }

  const adminName = adminSession.profile.fullName || adminSession.profile.company || adminSession.id
  const targetName = target.profile.fullName || target.profile.company || target.email

  // Swap the session over to the target account.
  cookieStore.set(SESSION_COOKIE, target.sessionToken, sessionCookieOptions)
  cookieStore.set(USER_COOKIE, target.id, userCookieOptions)
  await issueFreshMeta()

  const nowMs = Date.now()
  const impToken = await signImpersonation({
    adminId: adminSession.id,
    adminToken,
    adminName,
    targetId: target.id,
    targetName,
    iat: nowMs,
    exp: nowMs + SESSION_MAX_AGE * 1000,
  })
  cookieStore.set(IMPERSONATION_COOKIE, impToken, impersonationCookieOptions)

  await logActivity({
    action: `Administrator signed in as ${targetName} for maintenance`,
    category: "Administration / Security",
    user: adminName,
    details: {
      summary: `${adminName} started an impersonation session as ${targetName} (${target.email}).`,
      admin: adminSession.id,
      target: `${targetName} — ${target.email}`,
      targetStatus: target.status,
    },
  })

  return NextResponse.json({ ok: true, redirect: "/dashboard?fresh=1" })
}

/**
 * DELETE — end impersonation and restore the original admin session. No
 * passcode required: the signed impersonation cookie is itself the proof of who
 * to restore, so this stays a one-click "Return to admin".
 */
export async function DELETE() {
  const cookieStore = await cookies()
  const imp = await verifyImpersonation(cookieStore.get(IMPERSONATION_COOKIE)?.value)

  if (!imp) {
    // Nothing to restore — clear any stray marker and go back to the dashboard.
    cookieStore.set(IMPERSONATION_COOKIE, "", expiredCookieOptions)
    return NextResponse.json({ ok: true, redirect: "/dashboard" })
  }

  // Restore the administrator's own session and drop the impersonation marker.
  cookieStore.set(SESSION_COOKIE, imp.adminToken, sessionCookieOptions)
  cookieStore.set(USER_COOKIE, imp.adminId, userCookieOptions)
  await issueFreshMeta()
  cookieStore.set(IMPERSONATION_COOKIE, "", expiredCookieOptions)

  await logActivity({
    action: `Administrator ended maintenance session as ${imp.targetName}`,
    category: "Administration / Security",
    user: imp.adminName,
    details: {
      summary: `${imp.adminName} returned to their administrator session from ${imp.targetName}.`,
      admin: imp.adminId,
      target: imp.targetName,
    },
  })

  return NextResponse.json({ ok: true, redirect: "/dashboard/admin" })
}
