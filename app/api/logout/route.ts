import { type NextRequest, NextResponse } from "next/server"
import {
  SESSION_COOKIE,
  SESSION_META_COOKIE,
  FRESH_LOGIN_COOKIE,
  IMPERSONATION_COOKIE,
  expiredCookieOptions,
} from "@/lib/auth"
import { USER_COOKIE } from "@/lib/user-scope"
import { logActivity } from "@/app/actions/log-activity"

// Logout is a Route Handler, NOT a Server Action. Server Action POSTs are
// silently rejected on this app's production domains + mobile in-app webviews;
// the `<form action={logout}>` Server Action therefore failed and bubbled into
// the app error boundary ("Something went wrong") — most visibly right after
// returning from an admin impersonation session. A native form POST to this
// route is an ordinary browser navigation that works on every domain.
//
// We clear cookies on the REDIRECT response with the exact attributes they were
// set with (SameSite=None; Secure; Path=/, maxAge:0). A bare cookie delete can't
// remove SameSite=None cookies, which would otherwise let the proxy silently
// re-authenticate on the redirect. IMPERSONATION_COOKIE is included so logging
// out never leaves a stale "act as client" cookie behind.
async function handleLogout(request: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", request.url), { status: 303 })
  for (const name of [
    SESSION_COOKIE,
    SESSION_META_COOKIE,
    USER_COOKIE,
    FRESH_LOGIN_COOKIE,
    IMPERSONATION_COOKIE,
  ]) {
    res.cookies.set(name, "", expiredCookieOptions)
  }
  // Best-effort audit log — never let a logging hiccup break sign-out.
  try {
    await logActivity({
      action: "Logout",
      category: "Authentication",
      details: { result: "session ended" },
    })
  } catch {
    /* non-fatal */
  }
  // Belt-and-suspenders: forbid caching this response so no intermediary can
  // replay an authenticated state after sign-out.
  res.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0")
  return res
}

export async function POST(request: NextRequest) {
  return handleLogout(request)
}

// Also allow GET so a direct link / hard navigation to /api/logout works.
export async function GET(request: NextRequest) {
  return handleLogout(request)
}
