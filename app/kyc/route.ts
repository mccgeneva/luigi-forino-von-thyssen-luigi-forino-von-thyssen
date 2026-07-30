// ---------------------------------------------------------------------------
// GET /kyc  — KYC status for the account behind the caller's key
//
// NQAi.cloud reads `https://mcc-btp.app/kyc` to sync verification state. KYC is
// scoped to the account's OWN id (not the shared financial pool), matching the
// rest of the platform. For a user-bound key the target is its own account.
//
// Auth: Authorization: Bearer <api key> with the "read" scope.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { authenticateApiRequest, resolveApiTargetUser } from "@/lib/api-request-auth"
import { getNqaiSnapshotForUserId } from "@/lib/nqai-user-context"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const auth = await authenticateApiRequest(req, "read")
  if (!auth.ok) return auth.response

  const email = new URL(req.url).searchParams.get("email")
  const target = await resolveApiTargetUser(auth.key, email)
  if (!target.ok) return target.response

  try {
    const snapshot = await getNqaiSnapshotForUserId(target.user.id)
    if (!snapshot) {
      return NextResponse.json(
        { ok: false, error: { code: "snapshot_unavailable", message: "KYC data could not be loaded." } },
        { status: 404 },
      )
    }

    return NextResponse.json({
      ok: true,
      kyc: {
        accountId: snapshot.userId,
        email: target.user.email,
        fullName: snapshot.fullName,
        complete: snapshot.kycComplete,
        documentsOnFile: snapshot.kycOnFile,
        status: snapshot.kycComplete ? "verified" : "incomplete",
      },
    })
  } catch (err) {
    console.log("[v0] GET /kyc failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: "Could not retrieve KYC status." } },
      { status: 500 },
    )
  }
}
