import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import { getApprovalById, updateApprovalPayload, listAllApprovals } from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { resolveDataOwnerIdFor, resolveAccountProfileById } from "@/lib/session-user"
import { readLedgerEntries, availableByCurrency, upsertLedgerEntry } from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
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
//  - list:  every ACTIVE instrument holding across clients (+ any upgrade state).
//  - start: block the old instrument, charge the 3% expertise+upgrade fee to the
//           customer's Master Account (balance checked FIRST — refused if it
//           can't be covered), and record the negotiated new-instrument deal as
//           `payload.upgrade = { status: "proposed", ... }` for the customer to
//           accept (customer-side action issues the fresh instrument).
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
}

function baseInstrument(p: Payload): InstrumentVM {
  const base = p?.issuedByAdmin ? p?.instrument : (p?.record ?? p?.instrument)
  return (base ?? {}) as InstrumentVM
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
          return {
            approvalId: a.id,
            userId: a.userId,
            holderLabel: who?.label ?? String(inst.issuer ?? a.userId),
            holderEmail: who?.email ?? "",
            instrument: inst,
            upgrade: payload.upgrade ?? null,
          }
        })
        .filter((i) => !!i.instrument.id)
      return NextResponse.json({ ok: true, instruments, clients, feeRate: INSTRUMENT_UPGRADE_FEE_RATE }, { status: 200 })
    }

    if (op === "start") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "instrument" || existing.status !== "approved") {
        return NextResponse.json({ ok: false, error: "Active instrument not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as Payload
      if (payload.upgrade && payload.upgrade.status === "proposed") {
        return NextResponse.json({ ok: false, error: "An upgrade is already in progress for this instrument." }, { status: 200 })
      }
      const inst = baseInstrument(payload)
      const oldFaceValue = Number(inst.faceValue ?? existing.amount) || 0
      const feeCurrency = String(inst.currency ?? existing.currency ?? "USD")
      const fee = instrumentUpgradeFee(oldFaceValue)

      // Negotiated new instrument
      const bankKey = String(body.newBankKey ?? "")
      const bank = partnerBankByKey(bankKey)
      const newIssuer = (bank?.name || String(body.newIssuer ?? "")).trim()
      const newType = String(body.newType ?? inst.type ?? "SBLC").trim()
      const newTypeFull = String(body.newTypeFull ?? body.newType ?? inst.typeFull ?? "Bank Instrument").trim()
      const newFaceValue = Number(body.newFaceValue ?? 0)
      const newCurrency = String(body.newCurrency ?? feeCurrency).trim()
      const terms = String(body.terms ?? "").trim() || undefined
      const note = String(body.note ?? "").trim() || undefined

      if (!newIssuer) return NextResponse.json({ ok: false, error: "Select a reputable partner bank for the new instrument." }, { status: 200 })
      if (!Number.isFinite(newFaceValue) || newFaceValue <= 0) {
        return NextResponse.json({ ok: false, error: "Enter a valid negotiated face value for the new instrument." }, { status: 200 })
      }

      // SOLVENCY: check the customer's Master Account can cover the 3% fee BEFORE
      // blocking or charging anything. All balances converted into the fee
      // currency (same pattern as the yield/card fee gates).
      const ownerId = await resolveDataOwnerIdFor(existing.userId)
      if (fee > 0) {
        const available = availableByCurrency(await readLedgerEntries(ownerId))
        const availableInCcy = Object.entries(available).reduce(
          (sum, [cur, amt]) => sum + convertCurrency(amt, cur, feeCurrency),
          0,
        )
        if (fee > availableInCcy + 0.01) {
          return NextResponse.json(
            {
              ok: false,
              error: `The customer cannot cover the ${INSTRUMENT_UPGRADE_FEE_LABEL} expertise & upgrade fee of ${feeCurrency} ${fee.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Nothing was blocked or charged.`,
            },
            { status: 200 },
          )
        }
      }

      // Charge the fee to the Master Account (deterministic id → idempotent).
      if (fee > 0) {
        await upsertLedgerEntry(ownerId, {
          id: `INSTR-UPGRADE-FEE-${approvalId}`,
          direction: "debit",
          amount: fee,
          currency: feeCurrency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: `${inst.typeFull ?? "Instrument"} ${inst.id ?? ""}`.trim(),
          reference: approvalId,
          category: `Bank Instrument — Expertise & Upgrade Fee (${INSTRUMENT_UPGRADE_FEE_LABEL})`,
          comment: `${INSTRUMENT_UPGRADE_FEE_LABEL} one-time upgrade fee on ${feeCurrency} ${oldFaceValue.toLocaleString("en-US")} ${inst.typeFull ?? "instrument"}.`,
        })
      }

      // Block the old instrument + record the proposed deal for the customer.
      const upgrade: InstrumentUpgrade = {
        status: "proposed",
        proposedAt: new Date().toISOString(),
        feeRate: INSTRUMENT_UPGRADE_FEE_RATE,
        fee,
        feeCurrency,
        oldFaceValue,
        newType,
        newTypeFull,
        newIssuer,
        newIssuerCountry: bank?.country,
        newIssuerBic: bank?.bic,
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
          title: "Instrument upgrade proposed",
          body: `Your ${inst.typeFull ?? "instrument"} is being transformed into a fresh ${newCurrency} ${newFaceValue.toLocaleString("en-US")} ${newTypeFull} by ${newIssuer}. Review and accept the deal in Bank Instruments.${fee > 0 ? ` A ${feeCurrency} ${fee.toLocaleString("en-US")} expertise & upgrade fee was charged.` : ""}`,
          href: KIND_HREF.instrument ?? "/dashboard/instruments",
        })
      } catch {
        /* best-effort */
      }

      try {
        const target = await resolveAccountProfileById(existing.userId)
        await logActivity({
          action: `Administrator started an instrument upgrade for ${target.fullName}`,
          category: "Administration / Instruments",
          user: "Administrator",
          details: {
            referenceId: String(inst.id ?? approvalId),
            targetAccount: `${target.fullName} — ${target.email}`,
            summary: `Blocked ${inst.typeFull ?? "instrument"} (${feeCurrency} ${oldFaceValue.toLocaleString("en-US")}), charged ${feeCurrency} ${fee.toLocaleString("en-US")} (${INSTRUMENT_UPGRADE_FEE_LABEL}), proposed new ${newCurrency} ${newFaceValue.toLocaleString("en-US")} ${newTypeFull} from ${newIssuer}.`,
            action: "Upgrade proposed",
          },
        })
      } catch {
        /* best-effort */
      }

      return NextResponse.json({ ok: true, fee, feeCurrency }, { status: 200 })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    console.log("[v0] admin instrument-upgrade api failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be completed." }, { status: 200 })
  }
}
