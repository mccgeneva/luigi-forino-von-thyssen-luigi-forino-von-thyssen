import { type NextRequest, NextResponse } from "next/server"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { normalizeAccountBadge } from "@/lib/account-tier"
import { effectiveRelationship } from "@/lib/account-hierarchy"
import { listDynamicUsers, type DynamicUserRecord } from "@/lib/admin-users-db"
import type { AdminUserView } from "@/app/actions/admin-users"

// Read-only listing of client accounts for the admin User Management panel.
//
// IMPORTANT: this is a Route Handler, NOT a Server Action, by design. Next.js
// validates Server Action requests against the forwarded Origin/Host, and on
// this app's production domains (apex -> www redirect, custom domains, in-app
// webviews) that check can SILENTLY reject the action — which made the admin
// user list come back empty even though the data was perfectly safe. Route
// Handlers are exempt from that check, so this works identically on every
// domain. This mirrors the same fix already applied to activity logging.
export const dynamic = "force-dynamic"

function toView(rec: DynamicUserRecord): AdminUserView {
  return {
    id: rec.id,
    email: rec.email,
    password: rec.password,
    status: rec.status,
    fullName: rec.profile.fullName,
    company: rec.profile.company,
    role: rec.profile.role,
    accountBadge: normalizeAccountBadge(rec.profile.accountBadge),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    createdBy: rec.createdBy,
    relationship: effectiveRelationship(rec.profile.relationship),
    masterId: rec.profile.masterId,
    masterName: rec.profile.masterName,
    masterEmail: rec.profile.masterEmail,
  }
}

export async function GET(req: NextRequest) {
  // Passcode gate — same shared client passcode the Server Action used. Accepts
  // either an x-admin-passcode header or a ?p= query param.
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (String(passcode) !== ADMIN_PASSCODE) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  try {
    const users = (await listDynamicUsers()).map(toView)
    return NextResponse.json({ ok: true, users })
  } catch (err) {
    console.log("[v0] /api/admin/users failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "Could not load client accounts. Please try again." },
      { status: 500 },
    )
  }
}
