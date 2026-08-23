import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import { getGuaranteeConfig, saveGuaranteeConfig } from "@/lib/guarantees-config-db"
import { gatherGuaranteeProfile } from "@/lib/guarantees-profile"
import { DEFAULT_GUARANTEE_CONFIG, type GuaranteeConfig } from "@/lib/guarantees-accumulator"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admin Guarantees Accumulator API.
 *
 * Lives under /api (NOT the /dashboard proxy) and talks to the `lib/*` DATA
 * modules directly — same rationale as the account-limits route: a Server
 * Action would be silently 401'd by the proxy on a stale meta cookie and its
 * error swallowed, leaving the panel empty. Authorization is enforced here via
 * `adminActionAuthorized` (admin PIN + server-side admin-session check).
 *
 * Ops:
 *   • load  — global config + every active user's computed score breakdown.
 *   • save  — persist the tuned config.
 */

type SavePayload = { op: "save"; pin: string; config: GuaranteeConfig }
type LoadPayload = { op: "load"; pin: string }

function sanitizeConfig(input: Partial<GuaranteeConfig> | undefined): GuaranteeConfig {
  const c = input ?? {}
  const numOr = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    weightSecurityDeposit: Math.max(0, numOr(c.weightSecurityDeposit, DEFAULT_GUARANTEE_CONFIG.weightSecurityDeposit)),
    weightLeverageLoad: Math.max(0, numOr(c.weightLeverageLoad, DEFAULT_GUARANTEE_CONFIG.weightLeverageLoad)),
    weightExposure: Math.max(0, numOr(c.weightExposure, DEFAULT_GUARANTEE_CONFIG.weightExposure)),
    weightPaymentPenalty: Math.max(0, numOr(c.weightPaymentPenalty, DEFAULT_GUARANTEE_CONFIG.weightPaymentPenalty)),
    highRiskThreshold: Math.max(0.1, numOr(c.highRiskThreshold, DEFAULT_GUARANTEE_CONFIG.highRiskThreshold)),
    ageCreditPerYear: Math.max(0, numOr(c.ageCreditPerYear, DEFAULT_GUARANTEE_CONFIG.ageCreditPerYear)),
    ageCreditMax: Math.max(0, numOr(c.ageCreditMax, DEFAULT_GUARANTEE_CONFIG.ageCreditMax)),
    penaltyPerOverdue: Math.max(0, numOr(c.penaltyPerOverdue, DEFAULT_GUARANTEE_CONFIG.penaltyPerOverdue)),
    targetCoverage: Math.max(0.1, numOr(c.targetCoverage, DEFAULT_GUARANTEE_CONFIG.targetCoverage)),
    weightTrackRecord: Math.max(0, numOr(c.weightTrackRecord, DEFAULT_GUARANTEE_CONFIG.weightTrackRecord)),
    newAccountRisk: Math.max(0, numOr(c.newAccountRisk, DEFAULT_GUARANTEE_CONFIG.newAccountRisk)),
    seasoningDays: Math.max(1, numOr(c.seasoningDays, DEFAULT_GUARANTEE_CONFIG.seasoningDays)),
    provenCapital: Math.max(1, numOr(c.provenCapital, DEFAULT_GUARANTEE_CONFIG.provenCapital)),
    enforce: c.enforce === undefined ? DEFAULT_GUARANTEE_CONFIG.enforce : !!c.enforce,
  }
}

export async function POST(req: Request) {
  let body: SavePayload | LoadPayload
  try {
    body = (await req.json()) as SavePayload | LoadPayload
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", users: [] }, { status: 200 })
    }

    if (body.op === "save") {
      const config = sanitizeConfig(body.config)
      await saveGuaranteeConfig(config)
      return NextResponse.json({ ok: true, config })
    }

    if (body.op === "load") {
      const config = await getGuaranteeConfig()
      const users = await listDynamicUsers()
      const active = users.filter((u) => u.status === "active")
      // Score every active user. Each gather is defensive; a single failure
      // degrades to a zeroed score for that user rather than failing the load.
      const scored = await Promise.all(
        active.map(async (u) => {
          try {
            const { score } = await gatherGuaranteeProfile(u.id, config)
            return {
              id: u.id,
              fullName: u.profile.fullName,
              company: u.profile.company,
              email: u.email,
              score,
            }
          } catch {
            return {
              id: u.id,
              fullName: u.profile.fullName,
              company: u.profile.company,
              email: u.email,
              score: null,
            }
          }
        }),
      )
      // High-risk first, then by descending final score.
      scored.sort((a, b) => (b.score?.finalScore ?? -1) - (a.score?.finalScore ?? -1))
      return NextResponse.json({ ok: true, config, users: scored })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "Request failed." }, { status: 200 })
  }
}
