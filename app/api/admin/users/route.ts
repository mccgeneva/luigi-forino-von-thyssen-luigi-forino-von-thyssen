import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { normalizeAccountBadge } from "@/lib/account-tier"
import { effectiveRelationship } from "@/lib/account-hierarchy"
import { listDynamicUsers, type DynamicUserRecord } from "@/lib/admin-users-db"
import {
  createUser,
  editUser,
  resetUserPassword,
  updateUserStatus,
  removeUser,
  listMasterCandidates,
  type AdminUserView,
} from "@/app/actions/admin-users"
import { adminResetUserFace } from "@/app/actions/biometric"

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
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  try {
    // `?candidates=1` returns the Master-account picker options instead of the
    // full user list (used by the create/edit relationship selector).
    if (req.nextUrl.searchParams.get("candidates") === "1") {
      const excludeId = req.nextUrl.searchParams.get("excludeId") || undefined
      const masters = await listMasterCandidates(passcode, excludeId)
      return NextResponse.json({ ok: true, masters })
    }
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

// Mutations (create / edit / reset password / status / delete) go through this
// POST dispatcher instead of Server Actions. Server Action POSTs are silently
// rejected on this app's production domains + mobile in-app webviews, which left
// admin "Save changes" (and create/reset/status/delete) spinning forever. The
// underlying business logic still lives in app/actions/admin-users.ts (each fn
// is passcode-gated) — we just invoke it from a Route Handler that works on
// every domain. The action field selects the operation.
export async function POST(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }

  const action = String(body.action || "")

  try {
    switch (action) {
      case "create":
        return NextResponse.json(await createUser({ ...(body.input as object), passcode } as never))
      case "edit":
        return NextResponse.json(await editUser({ ...(body.input as object), passcode } as never))
      case "resetPassword":
        return NextResponse.json(
          await resetUserPassword(passcode, String(body.id), (body.newPassword as string) || undefined, "Administrator"),
        )
      case "status":
        return NextResponse.json(
          await updateUserStatus(passcode, String(body.id), body.status as never, "Administrator"),
        )
      case "delete":
        return NextResponse.json(await removeUser(passcode, String(body.id), "Administrator"))
      case "resetFace":
        return NextResponse.json(await adminResetUserFace(passcode, String(body.id), "Administrator"))
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    console.log("[v0] /api/admin/users POST failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "The request could not be completed. Please try again." },
      { status: 500 },
    )
  }
}
