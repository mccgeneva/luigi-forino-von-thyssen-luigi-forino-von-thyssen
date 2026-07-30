// ---------------------------------------------------------------------------
// /api/v1/customer
//
// GET   ?email=<customer email>
//   Retrieves a snapshot of a specific mcc-btp.app customer — profile summary,
//   balances per currency, recent transactions, KYC state, certificates, SKR
//   and beneficiaries. Requires the "read" scope.
//
// PATCH { phone?, address?, fullName?, company? }
//   Updates the customer's CONTACT DETAILS only. Email, password, status,
//   balance, KYC and relationship can never be changed here. Requires "write".
//
// For a user-bound key the target is always its own account (email optional);
// for a global/admin key the email selects the customer.
//
// Auth: Authorization: Bearer <api key>.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { authenticateApiRequest, resolveApiTargetUser } from "@/lib/api-request-auth"
import { updateDynamicUserProfile } from "@/lib/admin-users-db"
import { persistActivityEvent } from "@/lib/activity-persist"
import { getNqaiSnapshotForUserId } from "@/lib/nqai-user-context"
import type { SerializableUserProfile, SerializableProfileItem } from "@/lib/profile-types"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const auth = await authenticateApiRequest(req, "read")
  if (!auth.ok) return auth.response

  // A user-bound key targets its own account (email optional); a global key
  // still requires ?email= to choose the customer.
  const email = new URL(req.url).searchParams.get("email")
  const target = await resolveApiTargetUser(auth.key, email)
  if (!target.ok) return target.response
  const user = target.user

  try {
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

// Contact fields live as label/value items inside `profile.principal`. Upsert a
// value onto the first item whose label matches one of `matchers`; if none
// exists, append a new item with `defaultLabel`. Returns a NEW array (no
// mutation of the stored profile until we persist).
function upsertContactItem(
  items: SerializableProfileItem[],
  matchers: RegExp[],
  defaultLabel: string,
  value: string,
): SerializableProfileItem[] {
  const next = items.map((i) => ({ ...i }))
  const idx = next.findIndex((i) => matchers.some((re) => re.test(i.label)))
  if (idx >= 0) next[idx].value = value
  else next.push({ label: defaultLabel, value })
  return next
}

export async function PATCH(req: Request) {
  const auth = await authenticateApiRequest(req, "write")
  if (!auth.ok) return auth.response

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: { code: "invalid_json", message: "Body must be valid JSON." } }, { status: 400 })
  }

  const target = await resolveApiTargetUser(auth.key, typeof body.email === "string" ? body.email : null)
  if (!target.ok) return target.response
  const user = target.user

  // Whitelist of updatable CONTACT fields. Anything else in the body is ignored.
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined)
  const phone = str(body.phone)
  const address = str(body.address)
  const fullName = str(body.fullName)
  const company = str(body.company)

  if (phone === undefined && address === undefined && fullName === undefined && company === undefined) {
    return NextResponse.json(
      { ok: false, error: { code: "no_updatable_fields", message: "Provide at least one of: phone, address, fullName, company." } },
      { status: 400 },
    )
  }

  try {
    const profile: SerializableUserProfile = { ...user.profile }
    const changed: Record<string, string> = {}

    if (fullName !== undefined && fullName) {
      profile.fullName = fullName
      changed.fullName = fullName
    }
    if (company !== undefined) {
      profile.company = company
      changed.company = company
    }
    if (phone !== undefined) {
      profile.principal = upsertContactItem(profile.principal ?? [], [/mobile/i, /phone/i, /\btel\b/i], "Mobile", phone)
      changed.phone = phone
    }
    if (address !== undefined) {
      profile.principal = upsertContactItem(
        profile.principal ?? [],
        [/registered address/i, /residential address/i, /^address$/i, /mailing address/i],
        "Registered Address",
        address,
      )
      changed.address = address
    }

    // Persist ONLY the profile — email/password/status are left untouched, so
    // the login binding and account state can never be altered via this route.
    const updated = await updateDynamicUserProfile(user.id, { profile })
    if (!updated) {
      return NextResponse.json({ ok: false, error: { code: "update_failed", message: "The account could not be updated." } }, { status: 500 })
    }

    await persistActivityEvent(
      {
        action: `NQAi updated contact details for ${updated.profile.fullName || updated.email}`,
        category: "Account Update",
        user: `API key ${auth.key.name} (${auth.key.keyPrefix})`,
        userId: user.id,
        details: { apiKeyId: auth.key.id, fields: Object.keys(changed).join(", "), ...changed },
      },
      { ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent") },
    ).catch(() => {})

    return NextResponse.json({
      ok: true,
      updated: {
        id: user.id,
        email: updated.email,
        fullName: updated.profile.fullName,
        company: updated.profile.company,
        fieldsChanged: Object.keys(changed),
      },
    })
  } catch (err) {
    console.log("[v0] PATCH /api/v1/customer failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: { code: "server_error", message: "Could not update the customer." } }, { status: 500 })
  }
}
