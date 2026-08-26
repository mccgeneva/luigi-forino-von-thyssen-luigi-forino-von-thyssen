import { NextResponse } from "next/server"
import { resolveCurrentSession } from "@/lib/session-user"
import { getGuaranteeConfig } from "@/lib/guarantees-config-db"
import { gatherGuaranteeProfile } from "@/lib/guarantees-profile"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Customer-facing read of the signed-in user's own Guarantees Accumulator
 * trust/risk score. A plain API route (NOT behind the /dashboard proxy) so a
 * stale meta cookie can't silently 401 it. Returns the computed score plus the
 * high-risk threshold + enforce flag so the client card can explain the gate.
 */
export async function GET() {
  try {
    const session = await resolveCurrentSession()
    if (!session?.id) {
      return NextResponse.json({ ok: false, reason: "unauthenticated" }, { status: 200 })
    }
    const config = await getGuaranteeConfig()
    const { score, overdraft } = await gatherGuaranteeProfile(session.id, config)
    return NextResponse.json(
      { ok: true, score, overdraft, highRiskThreshold: config.highRiskThreshold, enforce: config.enforce },
      { status: 200 },
    )
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "Failed." }, { status: 200 })
  }
}
