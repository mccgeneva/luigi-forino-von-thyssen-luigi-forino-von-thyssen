import { type NextRequest, NextResponse } from "next/server"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { buildAuditOverview } from "@/lib/security-audit-service"

// Admin Security Audit — account picker overview.
//
// Route Handler (NOT a Server Action) on purpose: Server Action Origin/Host
// validation silently rejects calls on this app's production domains, which is
// why the panel showed "Could not load the audit overview". Route Handlers are
// exempt, so this works on apex, www, custom domains and in-app webviews.
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (String(passcode) !== ADMIN_PASSCODE) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  try {
    const data = await buildAuditOverview()
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] /api/admin/audit/overview failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not load the audit overview." }, { status: 500 })
  }
}
