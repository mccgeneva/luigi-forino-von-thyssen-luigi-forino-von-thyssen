// ---------------------------------------------------------------------------
// POST /api/v1/sso  — mint a one-time sign-in link (scope: "sso")
//
// Lets NQAi.cloud (which has already authenticated its own user) hand that user
// straight into their EXISTING mcc-btp.app account. The mcc-btp login identity
// is INHERITED from the bank-platform account — no second email or password is
// ever created, and NQAi never sees an mcc-btp password.
//
//   Request  (JSON):
//     { "email": "customer@example.com", "redirectPath"?: "/dashboard" }
//   Response (JSON, 200):
//     { "ok": true, "url": "https://mcc-btp.app/sso?token=...", "expiresAt": "..." }
//
// The account MUST already exist and be active — this endpoint never creates
// bank accounts. Unknown/suspended emails return 404 so NQAi can react.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { authenticateApiRequest } from "@/lib/api-request-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { createSsoToken } from "@/lib/sso-tokens-db"
import { logActivity } from "@/app/actions/log-activity"

export const dynamic = "force-dynamic"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function err(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}

export async function POST(req: Request) {
  const auth = await authenticateApiRequest(req, "sso")
  if (!auth.ok) return auth.response

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return err(400, "invalid_body", "Request body must be valid JSON.")
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email || !EMAIL_RE.test(email)) {
    return err(400, "invalid_email", "Provide the customer's email as 'email'.")
  }

  // The account must already exist — SSO inherits an existing bank identity and
  // never provisions a new one.
  const account = await getDynamicUserByEmail(email).catch(() => undefined)
  if (!account) {
    return err(404, "customer_not_found", "No mcc-btp.app account exists for that email.")
  }
  if (account.status !== "active") {
    return err(403, "account_inactive", "That mcc-btp.app account is not active.")
  }

  // Optional in-app landing path; only same-site relative paths are honoured.
  let redirectPath = "/dashboard"
  if (typeof body.redirectPath === "string" && body.redirectPath.startsWith("/") && !body.redirectPath.startsWith("//")) {
    redirectPath = body.redirectPath
  }

  const { token, expiresAt } = await createSsoToken(account.id, email, { createdBy: auth.key.name })

  // Build the hand-off URL on mcc-btp's own origin (the host that received this
  // call), so it is correct in both preview and production without extra config.
  const origin = new URL(req.url).origin
  const url = new URL("/sso", origin)
  url.searchParams.set("token", token)
  if (redirectPath !== "/dashboard") url.searchParams.set("next", redirectPath)

  await logActivity({
    action: "SSO sign-in link issued",
    category: "Authentication",
    user: `${account.profile.fullName} (${account.profile.company})`,
    userId: account.id,
    details: { email, via: auth.key.name, result: "issued" },
  }).catch(() => {})

  return NextResponse.json({ ok: true, url: url.toString(), expiresAt })
}
