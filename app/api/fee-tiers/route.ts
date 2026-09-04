import { NextResponse } from "next/server"
import { resolveCurrentSession } from "@/lib/session-user"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { getFeeTiers, saveFeeTiers } from "@/lib/tiered-fees-db"
import { DEFAULT_FEE_TIERS, type FeeTier } from "@/lib/tiered-fees"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Marginal tiered transaction-fee table API.
 *
 * A plain API route (NOT behind the /dashboard proxy) so client payment
 * previews can always load the LIVE tiers, and a stale meta cookie can't
 * silently 401 it.
 *
 *   • GET  — any signed-in user reads the current tier table (non-sensitive;
 *            it is disclosed in Terms & Costs anyway). Falls back to defaults.
 *   • POST — admin (PIN + server-side admin-session) replaces the tier table.
 */
export async function GET() {
  try {
    const session = await resolveCurrentSession()
    if (!session?.id) {
      // Not signed in — still return the public default table so nothing breaks.
      return NextResponse.json({ ok: true, tiers: DEFAULT_FEE_TIERS }, { status: 200 })
    }
    const tiers = await getFeeTiers()
    return NextResponse.json({ ok: true, tiers }, { status: 200 })
  } catch {
    return NextResponse.json({ ok: true, tiers: DEFAULT_FEE_TIERS }, { status: 200 })
  }
}

export async function POST(req: Request) {
  let body: { pin?: string; tiers?: FeeTier[] }
  try {
    body = (await req.json()) as { pin?: string; tiers?: FeeTier[] }
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""
  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 200 })
    }
    if (!Array.isArray(body.tiers)) {
      return NextResponse.json({ ok: false, error: "Missing tier table." }, { status: 200 })
    }
    const saved = await saveFeeTiers(body.tiers)
    return NextResponse.json({ ok: true, tiers: saved }, { status: 200 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "Save failed." }, { status: 200 })
  }
}
