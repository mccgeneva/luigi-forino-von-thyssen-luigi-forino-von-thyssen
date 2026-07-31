import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { buildGlobalStream, type EventSeverity } from "@/lib/security-audit-service"
import { captureServerError } from "@/lib/debug-log-db"

// Admin Security Audit — GLOBAL cross-user activity stream (Logs & Debug).
//
// Route Handler (NOT a Server Action) on purpose — Server Action Origin/Host
// validation silently rejects calls on this app's production domains.
export const dynamic = "force-dynamic"

const SEVERITIES: EventSeverity[] = ["critical", "error", "warning", "info"]

export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  const categoryParam = req.nextUrl.searchParams.get("category") ?? ""
  const category = categoryParam && categoryParam !== "All" ? categoryParam : undefined
  const sevParam = req.nextUrl.searchParams.get("severity") ?? ""
  const severity = SEVERITIES.includes(sevParam as EventSeverity) ? (sevParam as EventSeverity) : undefined

  try {
    const data = await buildGlobalStream({ category, severity, limit: 300 })
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] /api/admin/audit/stream failed:", err instanceof Error ? err.message : err)
    void captureServerError(err, { kind: "api.admin.audit.stream", path: "/api/admin/audit/stream" })
    return NextResponse.json({ ok: false, error: "Could not load the global log stream." }, { status: 500 })
  }
}
