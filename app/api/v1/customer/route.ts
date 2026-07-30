// ---------------------------------------------------------------------------
// GET /api/v1/customer?email=<customer email>
//
// Retrieves a snapshot of a specific mcc-btp.app customer — profile summary,
// balances per currency, recent transactions, KYC state, certificates, SKR and
// beneficiaries. Consumed by NQAi.cloud to display the customer's position and
// decide subscription billing.
//
// Auth: Authorization: Bearer <api key> with the "read" scope.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { authenticateApiRequest } from "@/lib/api-request-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { getNqaiSnapshotForUserId } from "@/lib/nqai-user-context"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const auth = await authenticateApiRequest(req, "read")
  if (!auth.ok) return auth.response

  const email = new URL(req.url).searchParams.get("email")?.trim()
  if (!email) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_email", message: "Provide the customer email as ?email=" } },
      { status: 400 },
    )
  }

  try {
    const user = await getDynamicUserByEmail(email)
    if (!user) {
      return NextResponse.json(
        { ok: false, error: { code: "customer_not_found", message: `No customer found for ${email}.` } },
        { status: 404 },
      )
    }

    const snapshot = await getNqaiSnapshotForUserId(user.id)
    if (!snapshot) {
      return NextResponse.json(
        { ok: false, error: { code: "snapshot_unavailable", message: "Customer data could not be loaded." } },
        { status: 404 },
      )
    }

    return NextResponse.json({
      ok: true,
      customer: {
        id: snapshot.userId,
        email: user.email,
        fullName: snapshot.fullName,
        company: snapshot.company,
        role: snapshot.role,
        accountBadge: snapshot.accountBadge,
        relationship: snapshot.relationship,
        status: user.status,
        kyc: { documentsOnFile: snapshot.kycOnFile, complete: snapshot.kycComplete },
        balances: snapshot.balances,
        recentTransactions: snapshot.recentTransactions,
        certificates: snapshot.certificates,
        skr: { total: snapshot.skrCount, pending: snapshot.skrPendingCount },
        beneficiaries: snapshot.beneficiaries,
      },
    })
  } catch (err) {
    console.log("[v0] GET /api/v1/customer failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: "Could not retrieve the customer." } },
      { status: 500 },
    )
  }
}
