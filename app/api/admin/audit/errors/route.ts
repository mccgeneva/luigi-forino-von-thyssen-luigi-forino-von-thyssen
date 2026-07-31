import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { buildErrorLog } from "@/lib/security-audit-service"
import { captureServerError, type DebugSeverity, type DebugSource } from "@/lib/debug-log-db"

// Admin Security Audit — automatically-captured Errors & Debug log.
//
// Route Handler (NOT a Server Action) on purpose — Server Action Origin/Host
// validation silently rejects calls on this app's production domains.
export const dynamic = "force-dynamic"

const SEVERITIES: DebugSeverity[] = ["critical", "error", "warning", "info"]
const SOURCES: DebugSource[] = ["client", "server", "edge"]

export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  const sevParam = req.nextUrl.searchParams.get("severity") ?? ""
  const severity = SEVERITIES.includes(sevParam as DebugSeverity) ? (sevParam as DebugSeverity) : undefined
  const srcParam = req.nextUrl.searchParams.get("source") ?? ""
  const source = SOURCES.includes(srcParam as DebugSource) ? (srcParam as DebugSource) : undefined

  try {
    const data = await buildErrorLog({ severity, source, limit: 200 })
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] /api/admin/audit/errors failed:", err instanceof Error ? err.message : err)
    void captureServerError(err, { kind: "api.admin.audit.errors", path: "/api/admin/audit/errors" })
    return NextResponse.json({ ok: false, error: "Could not load the error log." }, { status: 500 })
  }
}
