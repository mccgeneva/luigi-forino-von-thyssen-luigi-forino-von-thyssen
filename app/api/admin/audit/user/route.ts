import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { buildUserAudit } from "@/lib/security-audit-service"

// Admin Security Audit — full per-account report (identity, login selfie,
// devices, geolocated IPs, activity timeline).
//
// Route Handler (NOT a Server Action) on purpose — see the overview route for
// the full explanation of why Server Actions fail on the production domains.
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get("userId") ?? ""
  if (!userId) {
    return NextResponse.json({ ok: false, error: "No account selected." }, { status: 400 })
  }
  const categoryParam = req.nextUrl.searchParams.get("category") ?? ""
  const category = categoryParam && categoryParam !== "All" ? categoryParam : undefined

  try {
    const data = await buildUserAudit(userId, { category })
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] /api/admin/audit/user failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "Could not load the audit report for this account." },
      { status: 500 },
    )
  }
}
