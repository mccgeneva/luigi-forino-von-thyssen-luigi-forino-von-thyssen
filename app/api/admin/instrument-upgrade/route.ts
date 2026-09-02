import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import { getApprovalById, updateApprovalPayload, listAllApprovals, listApprovalsForUsers } from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { resolveDataOwnerIdFor, resolveAccountProfileById, resolveEnvironmentMemberIds } from "@/lib/session-user"
import { isLiveRequest } from "@/lib/live-request"
import { upsertLedgerEntry } from "@/lib/ledger-db"
import { partnerBankByKey } from "@/lib/partner-banks"
import { logActivity } from "@/app/actions/log-activity"
import { KIND_HREF } from "@/lib/approval-kinds"
import {
  INSTRUMENT_UPGRADE_FEE_RATE,
  INSTRUMENT_UPGRADE_FEE_LABEL,
  instrumentUpgradeFee,
  type InstrumentUpgrade,
} from "@/lib/instrument-upgrade"

export const runtime = "nodejs"

// -----------------------------------------------------------------------------
// Administrator "transformation / upgrade" API for bank instruments.
//
// Non-proxied /api route (NOT a Server Action) so the admin's instrument + client
// lists load reliably in the preview iframe / resumed PWA, and it imports the
// lib/* DATA modules directly rather than the "use server" wrappers. Gated once
// per call by adminActionAuthorized(pin).
//
// Ops:
//  - list:   every ACTIVE instrument holding across clients (+ any upgrade state).
//  - start:  PROPOSE a negotiated new-instrument deal — no block, no fee. Writes
//            `payload.upgrade = { status: "negotiating", ... }`. The customer
//            discusses / counter-offers; the fee is charged only when they
//            confirm (customer-side accept action).
//  - revise: update an in-negotiation deal (new value / bank / type / note),
//            e.g. after the customer's counter-offer.
//  - cancel: withdraw an open deal. If a legacy fee was already charged
//            (old "proposed" flow), it is refunded.
// -----------------------------------------------------------------------------

type InstrumentVM = {
  id?: string
  type?: string
  typeFull?: string
  issuer?: string
  faceValue?: number
  currency?: string
  isin?: string
  [k: string]: unknown
}

type Payload = {
  record?: InstrumentVM
  instrument?: InstrumentVM
  issuedByAdmin?: boolean
  upgrade?: InstrumentUpgrade
  transferredTo?: string
  /**
   * When set, an administrator has manually removed this instrument from the
   * upgrade waiting list (e.g. the customer no longer effectively holds it, or
   * it should not be offered for transformation). Hides it from the `list` op.
   * Reversible via the `restore` op. This is a LIST-VISIBILITY flag only — it
   * never touches the instrument, the ledger, or any facility.
   */
  upgradeListDismissedAt?: string
  upgradeListDismissedBy?: string
}

function baseInstrument(p: Payload): InstrumentVM {
  const base = p?.issuedByAdmin ? p?.instrument : (p?.record ?? p?.instrument)
  return (base ?? {}) as InstrumentVM
}

// Which live facility, if any, this instrument is pledged / reserved / funding —
// so it can NEVER be transformed while committed (a pledged MT760 backing a
// leverage line invested into the Treuhand fund, PPP funding, loan collateral,
// or monetization). Mirrors the client-side `instrumentPledgedElsewhere` /
// `instrumentEngagementReason` guards, but lib-safe for this API route. Scans the
// holder + their linked environment members. FAILS CLOSED (returns a blocking
// reason) on a read error, so an unverifiable pledge can never be upgraded away.
// Returns a human reason, or null when the instrument is free.
async function instrumentEngagementReason(instrumentId: string, userId: string): Promise<string | null> {
  if (!instrumentId) return null
  let ids = [userId]
  try {
    ids = Array.from(new Set([userId, ...(await resolveEnvironmentMemberIds(userId))]))
  } catch {
    ids = [userId]
  }
  const checks: Array<{ kind: "leverage" | "internal_loan" | "monetization" | "ppp" | "trading_fund"; fields: string[]; reason: string }> = [
    { kind: "leverage", fields: ["pledgedInstrumentId"], reason: "pledged to an active leverage line (its borrowed funds are deployed — e.g. reserved into the Treuhand AG Hedge Fund)" },
    { kind: "internal_loan", fields: ["collateralInstrumentId"], reason: "pledged as collateral on an active internal loan" },
    { kind: "monetization", fields: ["instrumentId"], reason: "committed to an active monetization facility" },
    { kind: "ppp", fields: ["fundingInstrumentId"], reason: "funding an active yield / PPP program" },
    { kind: "trading_fund", fields: ["fundingInstrumentId", "pledgedInstrumentId", "instrumentId"], reason: "reserved into an active Treuhand AG Hedge Fund position" },
  ]
  for (const { kind, fields, reason } of checks) {
    let rows: Awaited<ReturnType<typeof listApprovalsForUsers>> = []
    try {
      rows = await listApprovalsForUsers(ids, kind)
    } catch {
      return "its current pledges could not be verified — please try again shortly"
    }
    for (const row of rows) {
      if (row.status === "rejected") continue
      const rec = ((row.payload ?? {}) as { record?: Record<string, unknown> }).record ?? {}
      if (!fields.some((f) => rec[f] === instrumentId)) continue
      if (isLiveRequest(rec)) return reason
    }
  }
  return null
}

// Whether this instrument has been MONETIZED (sold/discounted for proceeds) and
// not reversed — in which case the customer no longer holds it and it must NOT
// appear in the upgrade waiting list at all. This is DIFFERENT from the pledge
// checks above: monetization is permanent (the instrument is consumed for cash),
// so a CLOSED monetization still means "gone" — unlike a leverage/loan/PPP pledge
// that returns when the facility closes. Mirrors the client rule (a monetization
// with status not in rejected/reversed keeps the instrument locked/consumed).
// FAILS CLOSED (treats as sold) on a read error so a stale row can't reappear.
async function instrumentMonetizedAway(instrumentId: string, userId: string): Promise<boolean> {
  if (!instrumentId) return false
  let ids = [userId]
  try {
    ids = Array.from(new Set([userId, ...(await resolveEnvironmentMemberIds(userId))]))
  } catch {
    ids = [userId]
  }
  let rows: Awaited<ReturnType<typeof listApprovalsForUsers>> = []
  try {
    rows = await listApprovalsForUsers(ids, "monetization")
  } catch {
    return true
  }
  for (const row of rows) {
    // Approval-level status has no "reversed" state; a reversed monetization is
    // recorded on payload.record.status, which is checked just below.
    if (row.status === "rejected") continue
    const rec = ((row.payload ?? {}) as { record?: Record<string, unknown> }).record ?? {}
    const recStatus = String(rec.status ?? "")
    if (recStatus === "rejected" || recStatus === "reversed") continue
    if (rec.instrumentId === instrumentId) return true
  }
  return false
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
      const mapped = approvals
        .map((a) => {
          const payload = (a.payload ?? {}) as Payload
          const inst = baseInstrument(payload)
          const who = clientMap.get(a.userId)
          return {
            approvalId: a.id,
            userId: a.userId,
            holderLabel: who?.label ?? "",
            holderEmail: who?.email ?? "",
            instrument: inst,
            upgrade: payload.upgrade ?? null,
            dismissed: Boolean(payload.upgradeListDismissedAt),
          }
        })
        // Drop instruments an admin has manually removed from the list, and any
        // with no resolvable id.
        .filter((i) => !!i.instrument.id && !i.dismissed)
      // Annotate each with whether it is currently pledged/reserved to a live
      // facility, so the UI can disable "Propose upgrade" up-front. Also resolve
      // the holder's real name/email when they are NOT in the active
      // dynamic-users map (a sub/joint account, a non-"active" status, or a
      // static account) — otherwise the admin sees the instrument's issuer BIC
      // (e.g. "DEUTDEDD" for a customer-uploaded MT760) or a raw user id instead
      // of the customer who requested the upgrade.
      const instruments = await Promise.all(
        mapped.map(async (i) => {
          let holderLabel = i.holderLabel
          let holderEmail = i.holderEmail
          if (!holderLabel) {
            try {
              const p = await resolveAccountProfileById(i.userId)
              const name = (p.fullName ?? "").trim()
              const company = ((p as { company?: string }).company ?? "").trim()
              holderLabel = company ? `${name || i.userId} · ${company}` : name || i.userId
              holderEmail = holderEmail || (p.email ?? "")
            } catch {
              holderLabel = i.userId
            }
          }
          const instrumentId = String(i.instrument.id ?? "")
          const [engagedReason, monetizedAway] = await Promise.all([
            instrumentEngagementReason(instrumentId, i.userId),
            instrumentMonetizedAway(instrumentId, i.userId),
          ])
          return { ...i, holderLabel, holderEmail, engagedReason, monetizedAway }
        }),
      )
      // Drop instruments the customer no longer holds because they were
      // monetized/sold (permanent) — they should never sit in the upgrade
      // waiting list. Pledged-but-returnable instruments (leverage/loan/PPP)
      // stay, shown disabled via `engagedReason`.
      const held = instruments
        .filter((i) => !i.monetizedAway)
        .map((i) => ({
          approvalId: i.approvalId,
          userId: i.userId,
          holderLabel: i.holderLabel,
          holderEmail: i.holderEmail,
          instrument: i.instrument,
          upgrade: i.upgrade,
          engagedReason: i.engagedReason,
        }))
      return NextResponse.json({ ok: true, instruments: held, clients, feeRate: INSTRUMENT_UPGRADE_FEE_RATE }, { status: 200 })
    }

    if (op === "start" || op === "revise") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "instrument" || existing.status !== "approved") {
        return NextResponse.json({ ok: false, error: "Active instrument not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as Payload
      const current = payload.upgrade
      if (op === "start" && current && (current.status === "negotiating" || current.status === "proposed")) {
        return NextResponse.json({ ok: false, error: "An upgrade is already open for this instrument." }, { status: 200 })
      }
      if (op === "revise" && (!current || (current.status !== "negotiating" && current.status !== "proposed"))) {
        return NextResponse.json({ ok: false, error: "There is no open upgrade to revise." }, { status: 200 })
      }
      const inst = baseInstrument(payload)

      // AUTHORITATIVE ENGAGEMENT GUARD — an instrument that is pledged/reserved
      // to a live facility (leverage line whose funds are deployed into the
      // Treuhand fund, loan collateral, monetization, PPP) can NEVER be
      // transformed, even by the administrator: upgrading it would swap out
      // collateral that is actively securing borrowed funds. Only blocks a NEW
      // proposal; an already-open negotiation may still be revised/withdrawn.
      if (op === "start") {
        const engaged = await instrumentEngagementReason(String(inst.id ?? ""), existing.userId)
        if (engaged) {
          return NextResponse.json(
            {
              ok: false,
              error: `This instrument can't be upgraded — it is ${engaged}. Release it (close/settle the facility) before proposing a transformation.`,
            },
            { status: 200 },
          )
        }
      }

      const oldFaceValue = Number(inst.faceValue ?? existing.amount) || 0
      const oldCurrency = String(inst.currency ?? existing.currency ?? "USD")

      // Negotiated new instrument
      const bankKey = String(body.newBankKey ?? "")
      const bank = partnerBankByKey(bankKey)
      const newIssuer = (bank?.name || String(body.newIssuer ?? current?.newIssuer ?? "")).trim()
      const newType = String(body.newType ?? current?.newType ?? inst.type ?? "SBLC").trim()
      const newTypeFull = String(body.newTypeFull ?? body.newType ?? current?.newTypeFull ?? inst.typeFull ?? "Bank Instrument").trim()
      const newFaceValue = Number(body.newFaceValue ?? current?.newFaceValue ?? 0)
      const newCurrency = String(body.newCurrency ?? current?.newCurrency ?? oldCurrency).trim()
      const terms = String(body.terms ?? current?.terms ?? "").trim() || undefined
      const note = String(body.note ?? current?.note ?? "").trim() || undefined

      if (!newIssuer) return NextResponse.json({ ok: false, error: "Select a reputable partner bank for the new instrument." }, { status: 200 })
      if (!Number.isFinite(newFaceValue) || newFaceValue <= 0) {
        return NextResponse.json({ ok: false, error: "Enter a valid negotiated face value for the new instrument." }, { status: 200 })
      }

      // The expertise & upgrade fee is 0.08% of the NEGOTIATED new face value
      // (what the customer is actually receiving), charged in the new currency —
      // NOT the original instrument's value. Recomputed on every start/revise so
      // it always tracks the latest negotiated figure.
      const fee = instrumentUpgradeFee(newFaceValue)
      const feeCurrency = newCurrency

      // Record the deal WITHOUT charging or blocking — the fee is taken only when
      // the customer confirms. A revise keeps any legacy `proposed`/fee state and
      // clears the customer's stale counter-offer.
      const upgrade: InstrumentUpgrade = {
        status: current?.status === "proposed" ? "proposed" : "negotiating",
        proposedAt: current?.proposedAt ?? new Date().toISOString(),
        feeRate: INSTRUMENT_UPGRADE_FEE_RATE,
        fee,
        feeCurrency,
        oldFaceValue,
        feeCharged: current?.feeCharged ?? current?.status === "proposed",
        newType,
        newTypeFull,
        newIssuer,
        newIssuerCountry: bank?.country ?? current?.newIssuerCountry,
        newIssuerBic: bank?.bic ?? current?.newIssuerBic,
        newFaceValue,
        newCurrency,
        terms,
        note,
      }
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), upgrade })

      try {
        await insertNotification({
          userId: existing.userId,
          tone: "info",
          title: op === "revise" ? "Upgrade offer revised" : "Instrument upgrade proposed",
          body:
            op === "revise"
              ? `The administrator revised your upgrade offer: a ${newCurrency} ${newFaceValue.toLocaleString("en-US")} ${newTypeFull} by ${newIssuer}. Review it in Bank Instruments.`
              : `The administrator proposes transforming your ${inst.typeFull ?? "instrument"} into a fresh ${newCurrency} ${newFaceValue.toLocaleString("en-US")} ${newTypeFull} by ${newIssuer}. Discuss the value and confirm the deal in Bank Instruments — no fee until you accept.`,
          href: KIND_HREF.instrument ?? "/dashboard/instruments",
        })
      } catch {
        /* best-effort */
      }

      try {
        const target = await resolveAccountProfileById(existing.userId)
        await logActivity({
          action: `Administrator ${op === "revise" ? "revised" : "proposed"} an instrument upgrade for ${target.fullName}`,
          category: "Administration / Instruments",
          user: "Administrator",
          details: {
            referenceId: String(inst.id ?? approvalId),
            targetAccount: `${target.fullName} — ${target.email}`,
            summary: `${op === "revise" ? "Revised" : "Proposed"} upgrade of ${inst.typeFull ?? "instrument"} (${feeCurrency} ${oldFaceValue.toLocaleString("en-US")}) → new ${newCurrency} ${newFaceValue.toLocaleString("en-US")} ${newTypeFull} from ${newIssuer}. Fee (${INSTRUMENT_UPGRADE_FEE_LABEL}) charged only on customer confirm.`,
            action: op === "revise" ? "Upgrade revised" : "Upgrade proposed",
          },
        })
      } catch {
        /* best-effort */
      }

      return NextResponse.json({ ok: true, fee, feeCurrency }, { status: 200 })
    }

    if (op === "cancel") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "instrument") {
        return NextResponse.json({ ok: false, error: "Instrument not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as Payload
      const current = payload.upgrade
      if (!current || (current.status !== "negotiating" && current.status !== "proposed")) {
        return NextResponse.json({ ok: false, error: "There is no open upgrade to withdraw." }, { status: 200 })
      }
      const inst = baseInstrument(payload)

      // Refund the fee only if it was actually charged (legacy proposed flow).
      let refunded = 0
      if (current.feeCharged || current.status === "proposed") {
        if (current.fee > 0) {
          const ownerId = await resolveDataOwnerIdFor(existing.userId)
          await upsertLedgerEntry(ownerId, {
            id: `INSTR-UPGRADE-REFUND-${approvalId}`,
            direction: "credit",
            amount: current.fee,
            currency: current.feeCurrency,
            status: "completed",
            date: new Date().toISOString(),
            counterparty: `${inst.typeFull ?? "Instrument"} ${inst.id ?? ""}`.trim(),
            reference: approvalId,
            category: `Bank Instrument — Upgrade Fee Refund`,
            comment: `Refund of the ${INSTRUMENT_UPGRADE_FEE_LABEL} upgrade fee — offer withdrawn by the administrator.`,
          })
          refunded = current.fee
        }
      }

      const upgrade: InstrumentUpgrade = { ...current, status: "declined", decidedAt: new Date().toISOString() }
      await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), upgrade })

      try {
        await insertNotification({
          userId: existing.userId,
          tone: "info",
          title: "Upgrade offer withdrawn",
          body: `The administrator withdrew the upgrade offer for your ${inst.typeFull ?? "instrument"}.${refunded > 0 ? ` The ${current.feeCurrency} ${refunded.toLocaleString("en-US")} fee was refunded.` : ""} Your instrument is fully available.`,
          href: KIND_HREF.instrument ?? "/dashboard/instruments",
        })
      } catch {
        /* best-effort */
      }

      return NextResponse.json({ ok: true, refunded, currency: current.feeCurrency }, { status: 200 })
    }

    // Manually remove an instrument from the upgrade waiting list (or put it
    // back). List-visibility only — never touches the instrument, ledger, or any
    // facility. Use this to clear a stale row the customer no longer effectively
    // holds, without a risky auto-hide heuristic.
    if (op === "dismiss" || op === "restore") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "instrument") {
        return NextResponse.json({ ok: false, error: "Instrument not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as Payload
      const current = payload.upgrade
      if (op === "dismiss" && current && (current.status === "negotiating" || current.status === "proposed")) {
        return NextResponse.json(
          { ok: false, error: "This instrument has an open upgrade offer. Withdraw it first, then remove it from the list." },
          { status: 200 },
        )
      }
      const inst = baseInstrument(payload)
      const next: Payload = { ...payload }
      if (op === "dismiss") {
        next.upgradeListDismissedAt = new Date().toISOString()
        next.upgradeListDismissedBy = "Administrator"
      } else {
        delete next.upgradeListDismissedAt
        delete next.upgradeListDismissedBy
      }
      await updateApprovalPayload(approvalId, next)

      try {
        const target = await resolveAccountProfileById(existing.userId)
        await logActivity({
          action: `Administrator ${op === "dismiss" ? "removed" : "restored"} an instrument ${op === "dismiss" ? "from" : "to"} the upgrade list for ${target.fullName}`,
          category: "Administration / Instruments",
          user: "Administrator",
          details: {
            referenceId: String(inst.id ?? approvalId),
            targetAccount: `${target.fullName} — ${target.email}`,
            summary: `${op === "dismiss" ? "Removed" : "Restored"} ${inst.typeFull ?? "instrument"} (${String(inst.currency ?? existing.currency ?? "")} ${(Number(inst.faceValue ?? existing.amount) || 0).toLocaleString("en-US")}) ${op === "dismiss" ? "from" : "to"} the upgrade waiting list.`,
            action: op === "dismiss" ? "Removed from upgrade list" : "Restored to upgrade list",
          },
        })
      } catch {
        /* best-effort */
      }

      return NextResponse.json({ ok: true }, { status: 200 })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    console.log("[v0] admin instrument-upgrade api failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be completed." }, { status: 200 })
  }
}
