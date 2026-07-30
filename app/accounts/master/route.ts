// ---------------------------------------------------------------------------
// GET /accounts/master  — the Master account behind the caller's key
//
// NQAi.cloud reads the "master account" from `https://mcc-btp.app/accounts/master`
// to sync the shared environment. For a user-bound key the target is its own
// account; if that account is a Sub/Joint holder, the returned snapshot is the
// MASTER whose balance pool it shares (resolved via `resolveDataOwnerIdFor`), so
// NQAi always syncs against the authoritative account.
//
// Auth: Authorization: Bearer <api key> with the "read" scope.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { authenticateApiRequest, resolveApiTargetUser } from "@/lib/api-request-auth"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { resolveDataOwnerIdFor } from "@/lib/session-user"
import { getNqaiSnapshotForUserId } from "@/lib/nqai-user-context"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const auth = await authenticateApiRequest(req, "read")
  if (!auth.ok) return auth.response

  const email = new URL(req.url).searchParams.get("email")
  const target = await resolveApiTargetUser(auth.key, email)
  if (!target.ok) return target.response

  try {
    // Resolve the shared-environment owner (the Master for a Sub/Joint account).
    const masterId = (await resolveDataOwnerIdFor(target.user.id)) || target.user.id
    const master = await getDynamicUserById(masterId).catch(() => undefined)
    const snapshot = await getNqaiSnapshotForUserId(masterId)
    if (!snapshot || !master) {
      return NextResponse.json(
        { ok: false, error: { code: "snapshot_unavailable", message: "Master account data could not be loaded." } },
        { status: 404 },
      )
    }

    return NextResponse.json({
      ok: true,
      account: {
        id: snapshot.userId,
        email: master.email,
        fullName: snapshot.fullName,
        company: snapshot.company,
        role: snapshot.role,
        accountBadge: snapshot.accountBadge,
        relationship: snapshot.relationship,
        status: master.status,
        // The requesting account (may be a Sub/Joint sharing this Master's pool).
        requestedBy: { id: target.user.id, email: target.user.email, isMaster: target.user.id === snapshot.userId },
        kyc: { documentsOnFile: snapshot.kycOnFile, complete: snapshot.kycComplete },
        balances: snapshot.balances,
        recentTransactions: snapshot.recentTransactions,
        certificates: snapshot.certificates,
        skr: { total: snapshot.skrCount, pending: snapshot.skrPendingCount },
        beneficiaries: snapshot.beneficiaries,
      },
    })
  } catch (err) {
    console.log("[v0] GET /accounts/master failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: "Could not retrieve the master account." } },
      { status: 500 },
    )
  }
}
