import { type NextRequest, NextResponse } from "next/server"
import { captureDebugEvent, type DebugSeverity } from "@/lib/debug-log-db"
import { resolveCurrentSession } from "@/lib/session-user"

// Client-side error/anomaly ingest. Called fire-and-forget (keepalive) by the
// global browser error handlers and the React global-error boundary.
//
// Route Handler (NOT a Server Action) so it is exempt from the Server Action
// Origin/CSRF check and works on every domain/alias — the same reason the
// activity-log endpoint is a route handler.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SEVERITIES: DebugSeverity[] = ["critical", "error", "warning", "info"]

function resolveClientIp(req: NextRequest) {
  const h = req.headers
  const forwarded = h.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return h.get("x-real-ip") || h.get("x-vercel-forwarded-for") || "Unknown"
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const message = typeof body.message === "string" ? body.message : ""
  if (!message) return NextResponse.json({ ok: false }, { status: 400 })

  const severity = SEVERITIES.includes(body.severity as DebugSeverity)
    ? (body.severity as DebugSeverity)
    : "error"

  // Attach the acting account when a session is present. Best-effort — a very
  // early error (before hydration/login) is still captured anonymously.
  let userId: string | null = null
  let account: string | null = null
  try {
    const session = await resolveCurrentSession()
    if (session) {
      userId = session.id
      account = session.profile?.fullName || session.profile?.company || session.id
    }
  } catch {
    // ignore — capture anonymously
  }

  await captureDebugEvent({
    severity,
    source: "client",
    kind: typeof body.kind === "string" ? body.kind : "client.error",
    message,
    stack: typeof body.stack === "string" ? body.stack : null,
    userId,
    account,
    path: typeof body.path === "string" ? body.path : null,
    ipAddress: resolveClientIp(req),
    userAgent: req.headers.get("user-agent"),
    meta: body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : null,
  })

  return NextResponse.json({ ok: true })
}
