import { NextResponse } from "next/server"
import { generateText } from "ai"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers, getDynamicUserById } from "@/lib/admin-users-db"
import { getGuaranteeConfig, saveGuaranteeConfig } from "@/lib/guarantees-config-db"
import { gatherGuaranteeProfile } from "@/lib/guarantees-profile"
import { nqaiChatModel } from "@/lib/ai-models"
import { DEFAULT_GUARANTEE_CONFIG, riskBandLabel, type GuaranteeConfig } from "@/lib/guarantees-accumulator"

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
type DraftPayload = {
  op: "draft-message"
  pin: string
  userId: string
  decision: "approve" | "decline"
  amount?: string
  note?: string
}
type Payload = SavePayload | LoadPayload | DraftPayload

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
    equityCreditFull: Math.max(1, numOr(c.equityCreditFull, DEFAULT_GUARANTEE_CONFIG.equityCreditFull)),
    equityCreditMax: Math.max(0, numOr(c.equityCreditMax, DEFAULT_GUARANTEE_CONFIG.equityCreditMax)),
    penaltyPerOverdue: Math.max(0, numOr(c.penaltyPerOverdue, DEFAULT_GUARANTEE_CONFIG.penaltyPerOverdue)),
    targetCoverage: Math.max(0.1, numOr(c.targetCoverage, DEFAULT_GUARANTEE_CONFIG.targetCoverage)),
    weightTrackRecord: Math.max(0, numOr(c.weightTrackRecord, DEFAULT_GUARANTEE_CONFIG.weightTrackRecord)),
    newAccountRisk: Math.max(0, numOr(c.newAccountRisk, DEFAULT_GUARANTEE_CONFIG.newAccountRisk)),
    seasoningDays: Math.max(1, numOr(c.seasoningDays, DEFAULT_GUARANTEE_CONFIG.seasoningDays)),
    provenCapital: Math.max(1, numOr(c.provenCapital, DEFAULT_GUARANTEE_CONFIG.provenCapital)),
    weightOverdraft: Math.max(0, numOr(c.weightOverdraft, DEFAULT_GUARANTEE_CONFIG.weightOverdraft)),
    overdraftRiskFull: Math.max(0, numOr(c.overdraftRiskFull, DEFAULT_GUARANTEE_CONFIG.overdraftRiskFull)),
    enforce: c.enforce === undefined ? DEFAULT_GUARANTEE_CONFIG.enforce : !!c.enforce,
  }
}

export async function POST(req: Request) {
  let body: Payload
  try {
    body = (await req.json()) as Payload
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
            const { score, overdraft } = await gatherGuaranteeProfile(u.id, config)
            return {
              id: u.id,
              fullName: u.profile.fullName,
              company: u.profile.company,
              email: u.email,
              score,
              overdraft,
            }
          } catch {
            return {
              id: u.id,
              fullName: u.profile.fullName,
              company: u.profile.company,
              email: u.email,
              score: null,
              overdraft: null,
            }
          }
        }),
      )
      // High-risk first, then by descending final score.
      scored.sort((a, b) => (b.score?.finalScore ?? -1) - (a.score?.finalScore ?? -1))
      return NextResponse.json({ ok: true, config, users: scored })
    }

    if (body.op === "draft-message") {
      const userId = typeof body.userId === "string" ? body.userId : ""
      const decision = body.decision === "approve" ? "approve" : "decline"
      if (!userId) {
        return NextResponse.json({ ok: false, error: "Missing client." }, { status: 200 })
      }
      const user = await getDynamicUserById(userId)
      if (!user) {
        return NextResponse.json({ ok: false, error: "Client not found." }, { status: 200 })
      }
      const config = await getGuaranteeConfig()
      // Re-gather server-side so the drafted message reflects the client's TRUE
      // current position, never client-supplied figures.
      const { score } = await gatherGuaranteeProfile(userId, config)
      const clientName = user.profile.fullName || user.profile.company || "the client"
      const company = user.profile.company || ""

      const fmtEur = (n: number) =>
        `EUR ${Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`

      // A plain-language snapshot for the model — NOT the raw internal formula.
      const facts = score
        ? [
            `Client: ${clientName}${company ? ` (${company})` : ""}`,
            `Decision the administrator has taken: ${decision === "approve" ? "APPROVE the facility" : "DECLINE the facility"}`,
            body.amount ? `Requested facility amount: ${body.amount}` : "",
            `Internal risk score: ${score.finalScore.toFixed(2)} (band: ${riskBandLabel(score.band)}, high-risk threshold ${config.highRiskThreshold})`,
            `High risk flag: ${score.highRisk ? "YES — outside current treasury risk appetite" : "no"}`,
            `Outstanding exposure / borrowing: ${fmtEur(score.inputs.totalExposure)}`,
            `Posted guarantees / collateral: ${fmtEur(score.inputs.guarantees)}`,
            `Client's own available (unborrowed) funds: ${fmtEur(score.inputs.availableBalance)}`,
            (score.inputs.equitySavings ?? 0) > 0 ? `Equity saving committed: ${fmtEur(score.inputs.equitySavings ?? 0)}` : "",
            score.inputs.overdueCharges > 0
              ? `Overdue items on the account: ${score.inputs.overdueCharges}`
              : "No overdue items.",
            body.note ? `Administrator's private context (do not quote verbatim): ${body.note}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : `Client: ${clientName}${company ? ` (${company})` : ""}\nDecision: ${decision === "approve" ? "APPROVE" : "DECLINE"}\n(Risk profile could not be computed.)`

      const system = [
        "You are NQAi, the relationship desk assistant for NAFTAhub / MCC Capital.",
        "Write a short, warm, PROFESSIONAL message that a relationship manager can copy and paste directly into a chat/email with the client about their loan / credit-facility request.",
        "Rules:",
        "- Address the client by name. Keep it 90–160 words, plain paragraphs, no markdown headings, no bullet symbols, no emojis.",
        "- Never expose internal jargon: do NOT mention 'risk score', numeric scores, weights, 'Guarantees Accumulator', thresholds, or any raw internal figure. Translate the drivers into plain business language.",
        "- If DECLINING: be kind and respectful, explain that the request currently falls outside the bank's treasury risk appetite, and give the real reasons in soft terms (e.g. high outstanding exposure relative to the client's own free funds, limited unencumbered equity, or an overdue item that must be cleared). Offer constructive, concrete next steps to become eligible (reduce outstanding exposure, clear the overdue item, add their own equity or additional collateral) and warmly invite them to resubmit afterwards.",
        "- If APPROVING: congratulate them, confirm the facility is approved (mention the requested amount if provided), and note it remains subject to the standard documentation and terms.",
        "- Sign off politely as the NAFTAhub Relationship Team. Do not invent specific figures that were not provided.",
        "- Output ONLY the message body, ready to paste. No preamble like 'Here is the message'.",
      ].join("\n")

      try {
        const { text } = await generateText({
          model: nqaiChatModel(),
          system,
          prompt: `Draft the client message based on this decision and profile:\n\n${facts}`,
          maxOutputTokens: 700,
          temperature: 0.6,
        })
        const message = (text || "").trim()
        if (!message) {
          return NextResponse.json({ ok: false, error: "NQAi returned an empty draft. Try again." }, { status: 200 })
        }
        return NextResponse.json({ ok: true, message, decision, clientName })
      } catch (err) {
        return NextResponse.json(
          { ok: false, error: (err as Error)?.message || "NQAi draft failed." },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "Request failed." }, { status: 200 })
  }
}
