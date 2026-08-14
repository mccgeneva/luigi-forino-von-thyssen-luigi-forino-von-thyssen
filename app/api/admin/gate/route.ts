import { NextResponse } from "next/server"
import { isCurrentSessionAdmin, adminActionAuthorized } from "@/lib/admin-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Administrator gate verification via a plain API route.
 *
 * Why an API route and not the `verifyAdminGate` Server Action: this endpoint is
 * NOT behind the `/dashboard` proxy (the proxy matcher only covers
 * `/dashboard/:path*` and `/login`), and a route handler ALWAYS returns a real
 * HTTP response with a JSON body — never a 307 redirect to `/login` that a
 * Server Action's fetch would silently follow and then fail to deserialize.
 * That redirect-follow was surfacing on the client as the opaque
 * "Could not verify administrator access" / "session expired" errors even when
 * the passcode was correct. Here the client always gets a deterministic
 * `{ ok, reason }` JSON payload it can act on, and the endpoint self-checks the
 * session (both factors) server-side so it cannot be bypassed.
 */
export async function POST(request: Request) {
  let pin = ""
  try {
    const body = (await request.json()) as { pin?: unknown }
    pin = typeof body?.pin === "string" ? body.pin : ""
  } catch {
    // no/invalid body → treat as empty pin
  }

  try {
    // Factor 1: the caller must be an authorized admin ACCOUNT. If the session
    // cookie was not delivered/recognized (e.g. expired), this is false and we
    // report "unauthenticated" so the client can prompt a clean re-login rather
    // than blaming the passcode.
    const isAdmin = await isCurrentSessionAdmin()
    if (!isAdmin) {
      return NextResponse.json(
        { ok: false, reason: "unauthenticated" as const },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      )
    }

    // Factor 2: correct PIN (verified server-side; the browser never compares
    // the secret). Accepts the baseline passkey or a configured ADMIN_PIN.
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json(
        { ok: false, reason: "pin" as const },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      )
    }

    return NextResponse.json(
      { ok: true as const },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    )
  } catch {
    // Unexpected server error — report as a retryable PIN rejection so the admin
    // gets an actionable message (and never an opaque thrown error).
    return NextResponse.json(
      { ok: false, reason: "error" as const },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    )
  }
}
