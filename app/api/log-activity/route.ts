import { type NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { deliverActivityEmailUnlessAdmin, type ActivityLog } from "@/lib/activity-email"
import { persistActivityEvent } from "@/lib/activity-persist"

// Route Handlers are NOT subject to the Server Action Origin/CSRF check, so this
// endpoint works identically on every domain (apex, www, custom aliases) and is
// unaffected by the mcc-btp.app -> www.mcc-btp.app redirect. Client-side activity
// logging posts here instead of invoking a Server Action.
export const runtime = "nodejs"

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
  let activity: ActivityLog
  try {
    activity = (await req.json()) as ActivityLog
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 })
  }

  if (!activity || typeof activity.action !== "string" || typeof activity.category !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_activity" }, { status: 400 })
  }

  const ipAddress = resolveClientIp(req)
  const userAgent = req.headers.get("user-agent")

  // Persist to the authoritative audit trail (best-effort, never throws) AND
  // deliver the email. Both run within the request lifecycle. The client posts
  // here fire-and-forget (`keepalive: true`), so it never waits on us — but
  // awaiting here guarantees both the row is written and the email is sent on
  // every Vercel region/domain. We do NOT use `after()` because its background
  // callbacks are not reliably executed across all runtimes.
  // `deliverActivityEmail` has its own 8s timeout and never throws.
  const [, result] = await Promise.all([
    persistActivityEvent(activity, { ipAddress, userAgent }),
    deliverActivityEmailUnlessAdmin(activity, ipAddress),
  ])

  return NextResponse.json({ ok: result.ok })
}
