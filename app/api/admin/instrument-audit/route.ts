import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import { getApprovalById, updateApprovalPayload, listAllApprovals } from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { resolveAccountProfileById } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { KIND_HREF } from "@/lib/approval-kinds"
import {
  buildInstrumentAudit,
  AUDIT_RATING_SCALE,
  AUDIT_ENGINE_VERSION,
  type AuditableInstrument,
  type AuditRating,
  type InstrumentAudit,
} from "@/lib/instrument-audit"

export const runtime = "nodejs"

// -----------------------------------------------------------------------------
// Administrator Bank Instrument Audit Engine API.
//
// Non-proxied /api route (NOT a Server Action) so the admin's instrument list
// loads reliably in the preview iframe / resumed PWA, and it imports the lib/*
// DATA modules directly (never the "use server" wrappers). Gated once per call
// by adminActionAuthorized(pin).
//
// Every ACTIVE held instrument is audited: `list` returns a DRAFT audit
// computed on the fly whenever none is stored yet, so the engine effectively
// "triggers on receipt" — the administrator always has an assessment ready to
// review. The audit is persisted to `payload.audit`.
//
// Ops:
//  - list:     all active instruments + their stored/draft audit + client roster.
//  - run:      (re)generate the engine draft and persist it (status "draft").
//  - override: persist administrator-edited valuation/risk/rating/eligibility
//              with a REQUIRED justification (status kept as draft, overridden).
//  - publish:  publish the audit → visible to the client + notify.
//  - reject:   mark the audit rejected with a reason (not shown to client).
// -----------------------------------------------------------------------------

type InstrumentVM = AuditableInstrument & { id?: string; isin?: string; [k: string]: unknown }

type Payload = {
  record?: InstrumentVM
  instrument?: InstrumentVM
  issuedByAdmin?: boolean
  audit?: InstrumentAudit
  [k: string]: unknown
}

function baseInstrument(p: Payload): InstrumentVM {
  const base = p?.issuedByAdmin ? p?.instrument : (p?.record ?? p?.instrument)
  return (base ?? {}) as InstrumentVM
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = String(body.pin ?? "")
  const op = String(body.op ?? "")

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", instruments: [], clients: [] }, { status: 200 })
    }

    const users = await listDynamicUsers()
    const clientMap = new Map<string, { label: string; email: string }>()
    const clients = users
      .filter((u) => u.status === "active")
      .map((u) => {
        const label = u.profile.company ? `${u.profile.fullName} · ${u.profile.company}` : u.profile.fullName
        clientMap.set(u.id, { label, email: u.email })
        return { id: u.id, fullName: u.profile.fullName, company: u.profile.company, email: u.email }
      })

    if (op === "list") {
      const approvals = await listAllApprovals({ kind: "instrument", status: "approved" })
      const instruments = approvals
        .map((a) => {
          const payload = (a.payload ?? {}) as Payload
          const inst = baseInstrument(payload)
          const who = clientMap.get(a.userId)
          // If no audit is stored yet, hand the reviewer a fresh engine draft so
          // every incoming instrument is auditable without a separate step.
          const audit = payload.audit ?? buildInstrumentAudit(inst)
          return {
            approvalId: a.id,
            userId: a.userId,
            holderLabel: who?.label ?? String(inst.issuer ?? a.userId),
            holderEmail: who?.email ?? "",
            instrument: inst,
            audit,
            stored: !!payload.audit,
          }
        })
        .filter((i) => !!i.instrument.id)
      return NextResponse.json(
        { ok: true, instruments, clients, ratingScale: AUDIT_RATING_SCALE, engineVersion: AUDIT_ENGINE_VERSION },
        { status: 200 },
      )
    }

    // All mutating ops target one approval.
    const approvalId = String(body.approvalId ?? "")
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument" || existing.status !== "approved") {
      return NextResponse.json({ ok: false, error: "Active instrument not found." }, { status: 200 })
    }
    const payload = (existing.payload ?? {}) as Payload
    const inst = baseInstrument(payload)
    const current = payload.audit

    if (op === "run") {
      // Regenerate the engine assessment from scratch, preserving publication
      // state only if it was already published (a re-run drops back to draft).
      const audit = buildInstrumentAudit(inst)
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), audit })
      await auditLog(existing.userId, inst, approvalId, "Ran audit engine", audit)
      return NextResponse.json({ ok: true, audit }, { status: 200 })
    }

    if (op === "override") {
      const justification = String(body.justification ?? "").trim()
      if (!justification) {
        return NextResponse.json({ ok: false, error: "A justification is required to override the engine assessment." }, { status: 200 })
      }
      const baseAudit = current ?? buildInstrumentAudit(inst)
      const faceValue = num(baseAudit.faceValue, num(inst.faceValue))
      const realisticValue = Math.max(0, num(body.realisticValue, baseAudit.realisticValue))
      const rating = (AUDIT_RATING_SCALE as readonly string[]).includes(String(body.rating))
        ? (String(body.rating) as AuditRating)
        : baseAudit.rating
      const riskScore = Math.round(Math.min(100, Math.max(0, num(body.riskScore, baseAudit.riskScore))))
      const allowedMonetizationPct = Math.min(1, Math.max(0, num(body.allowedMonetizationPct, baseAudit.allowedMonetizationPct)))
      const monetizationEligible = allowedMonetizationPct > 0 && body.monetizationEligible !== false
      const audit: InstrumentAudit = {
        ...baseAudit,
        faceValue,
        realisticValue,
        realisticPct: faceValue > 0 ? Math.round((realisticValue / faceValue) * 100) / 100 : 0,
        riskScore,
        rating,
        monetizationEligible,
        allowedMonetizationPct: monetizationEligible ? allowedMonetizationPct : 0,
        investingEligible: body.investingEligible !== false,
        ppiRequired: body.ppiRequired === true,
        summary: String(body.summary ?? baseAudit.summary).trim() || baseAudit.summary,
        overridden: true,
        overrideJustification: justification,
        reviewedAt: new Date().toISOString(),
        // An override resets to draft so it must be explicitly re-published.
        status: "draft",
        publishedAt: undefined,
        publishedBy: undefined,
        rejectionReason: undefined,
      }
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), audit })
      await auditLog(existing.userId, inst, approvalId, `Overrode audit — ${justification}`, audit)
      return NextResponse.json({ ok: true, audit }, { status: 200 })
    }

    if (op === "publish") {
      const audit: InstrumentAudit = {
        ...(current ?? buildInstrumentAudit(inst)),
        status: "published",
        publishedAt: new Date().toISOString(),
        publishedBy: "Administrator",
        rejectionReason: undefined,
      }
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), audit })
      try {
        await insertNotification({
          userId: existing.userId,
          tone: "success",
          title: "Instrument audit report published",
          body: `An independent audit & valuation report is now available for your ${inst.typeFull ?? "instrument"}: assessed value ${audit.currency} ${audit.realisticValue.toLocaleString("en-US")}, classification ${audit.rating}. Tap to open the full report.`,
          // Deep-link straight to the instrument's detail page, where the audit
          // report panel is shown — the generic list makes it hard to locate.
          href: inst.id
            ? `/dashboard/instruments/${encodeURIComponent(inst.id)}`
            : (KIND_HREF.instrument ?? "/dashboard/instruments"),
        })
      } catch {
        /* best-effort */
      }
      await auditLog(existing.userId, inst, approvalId, "Published audit report", audit)
      return NextResponse.json({ ok: true, audit }, { status: 200 })
    }

    if (op === "reject") {
      const reason = String(body.reason ?? "").trim()
      const audit: InstrumentAudit = {
        ...(current ?? buildInstrumentAudit(inst)),
        status: "rejected",
        rejectionReason: reason || "Rejected by the administrator.",
        reviewedAt: new Date().toISOString(),
        publishedAt: undefined,
        publishedBy: undefined,
      }
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), audit })
      await auditLog(existing.userId, inst, approvalId, `Rejected audit — ${audit.rejectionReason}`, audit)
      return NextResponse.json({ ok: true, audit }, { status: 200 })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    console.log("[v0] admin instrument-audit api failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be completed." }, { status: 200 })
  }
}

async function auditLog(
  userId: string,
  inst: InstrumentVM,
  approvalId: string,
  action: string,
  audit: InstrumentAudit,
): Promise<void> {
  try {
    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator: ${action}`,
      category: "Administration / Instruments",
      user: "Administrator",
      details: {
        referenceId: String(inst.id ?? approvalId),
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: `${action} for ${inst.typeFull ?? "instrument"} (${audit.currency} ${Number(inst.faceValue ?? 0).toLocaleString("en-US")} face). Assessed ${audit.currency} ${audit.realisticValue.toLocaleString("en-US")} · ${audit.rating} · risk ${audit.riskScore}/100 · LTV ${(audit.allowedMonetizationPct * 100).toFixed(0)}% · PPI ${audit.ppiRequired ? "required" : "not required"} · status ${audit.status}.`,
        action,
      },
    })
  } catch {
    /* best-effort audit trail */
  }
}
