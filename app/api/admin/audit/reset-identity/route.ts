import { NextResponse } from "next/server"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { clearEnrollment } from "@/lib/biometric-db"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { logActivity } from "@/app/actions/log-activity"

export const dynamic = "force-dynamic"

/**
 * ADMIN-ONLY: require a client to re-verify their identity on next login.
 *
 * Clears biometric enrollment AND the identity record (clearEnrollment nulls
 * identity_verified + all identity_* columns), so the client's next login runs
 * the full passport + selfie flow again — which captures the full passport
 * number and passport image under the current retention rules.
 *
 * Implemented as a Route Handler (not a Server Action) because Server Actions
 * are silently rejected on this app's production domains. Passcode via `x-admin-
 * passcode` header or `?p=` query; returns 401 on mismatch.
 */
export async function POST(req: Request) {
  const url = new URL(req.url)
  const passcode = req.headers.get("x-admin-passcode") || url.searchParams.get("p") || ""
  if (String(passcode) !== ADMIN_PASSCODE) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  let userId = url.searchParams.get("userId") || ""
  if (!userId) {
    const body = (await req.json().catch(() => null)) as { userId?: string } | null
    userId = body?.userId || ""
  }
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Missing userId." }, { status: 400 })
  }

  const target = await getDynamicUserById(userId)
  if (!target) {
    return NextResponse.json({ ok: false, error: "User not found." }, { status: 404 })
  }

  await clearEnrollment(userId)
  await logActivity({
    action: "Administrator required client re-verification",
    category: "Authentication / Security",
    user: "Administrator",
    details: {
      account: target.profile.fullName || target.email,
      email: target.email,
      result: "identity + biometric enrollment cleared — full KYC re-capture required on next login",
    },
  })

  return NextResponse.json({ ok: true })
}
