"use server"

// ---------------------------------------------------------------------------
// Server actions for a VISITOR linked (by an administrator) to another user's
// sub-account. See lib/sub-account-types.ts `VisitorSubLink`.
//
// Security model: EVERY action resolves the caller's session, then the caller's
// single link, and derives the ownerId + subAccountId FROM THE LINK — never
// from client input. All money lives on the OWNER's ledger, tagged with
// `sub_account_id = <the linked sub>`; the visitor can only ever read/move/pay
// that one compartment. If the caller has no link, every action refuses.
// ---------------------------------------------------------------------------

import { resolveCurrentSession } from "@/lib/session-user"
import { getVisitorLink } from "@/lib/visitor-link-db"
import { getSubAccountById } from "@/lib/sub-account-db"
import {
  readLedgerEntries,
  upsertLedgerEntry,
  deleteLedgerEntry,
  assertOwnerSolvent,
  type LedgerEntry,
} from "@/lib/ledger-db"
import { insertApproval, listApprovalsForUser } from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { transferFeeFor, TRANSFER_FEE_RATE } from "@/lib/sub-account-fees"
import { generateUetr } from "@/lib/swift-gpi"
import type { SubAccount } from "@/lib/sub-account-types"

// Outgoing payments carry the standard 2% platform fee, charged from the same
// compartment the payment is remitted from.
const PAYMENT_FEE_RATE = 0.02

export interface LinkedAccountActivity {
  id: string
  date: string
  direction: "credit" | "debit"
  amount: number
  currency: string
  counterparty: string
  category?: string
  status: string
}

export interface LinkedAccountPayout {
  id: string
  beneficiary: string
  amount: number
  fee: number
  total: number
  currency: string
  reference: string
  status: string
  submittedAt: string
}

export interface LinkedAccountView {
  subAccountId: string
  label: string
  currency: string
  iban?: string
  bic?: string
  beneficiaryName?: string
  status: string
  balance: number
  activity: LinkedAccountActivity[]
  payouts: LinkedAccountPayout[]
}

export type LinkedResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Isolated compartment balance for (currency, subId) on an owner's ledger. */
function compartmentBalance(entries: LedgerEntry[], currency: string, subId: string): number {
  let total = 0
  for (const e of entries) {
    if (e.currency !== currency) continue
    if ((e.subAccountId || undefined) !== subId) continue
    if (e.status === "hold") {
      if (e.direction === "debit") total -= e.amount
    } else {
      total += e.direction === "credit" ? e.amount : -e.amount
    }
  }
  return total
}

/** Main-account (untagged) balance for a currency on an owner's ledger. */
function mainBalance(entries: LedgerEntry[], currency: string): number {
  let total = 0
  for (const e of entries) {
    if (e.currency !== currency) continue
    if (e.subAccountId) continue
    if (e.status === "hold") {
      if (e.direction === "debit") total -= e.amount
    } else {
      total += e.direction === "credit" ? e.amount : -e.amount
    }
  }
  return total
}

interface ResolvedLink {
  session: NonNullable<Awaited<ReturnType<typeof resolveCurrentSession>>>
  ownerId: string
  subId: string
  sub: SubAccount
}

/**
 * Resolve the caller's link + the linked sub-account, enforcing that the
 * caller is genuinely linked and the sub-account is active and owned by the
 * link's owner. Returns null when anything doesn't check out (caller not
 * linked, sub missing/closed, owner mismatch).
 */
async function requireMyLink(): Promise<ResolvedLink | null> {
  const session = await resolveCurrentSession()
  if (!session) return null
  const link = await getVisitorLink(session.id)
  if (!link) return null
  const sub = await getSubAccountById(link.subAccountId)
  if (!sub) return null
  // The link records the owner; the sub must still belong to that owner and be
  // active. A closed/rejected sub is not operable.
  if (sub.userId !== link.ownerId) return null
  if (sub.status !== "active") return null
  return { session, ownerId: link.ownerId, subId: link.subAccountId, sub }
}

/** Load the linked sub-account's compartment: balance, activity, payouts. */
export async function getMyLinkedAccount(): Promise<LinkedResult<LinkedAccountView>> {
  const ctx = await requireMyLink()
  if (!ctx) return { ok: false, error: "You are not linked to a sub-account." }
  const { ownerId, subId, sub } = ctx
  try {
    const entries = await readLedgerEntries(ownerId)
    const balance = compartmentBalance(entries, sub.currency, subId)
    const activity: LinkedAccountActivity[] = entries
      .filter((e) => (e.subAccountId || undefined) === subId && e.currency === sub.currency)
      .slice(0, 30)
      .map((e) => ({
        id: e.id,
        date: e.date,
        direction: e.direction,
        amount: e.amount,
        currency: e.currency,
        counterparty: e.counterparty,
        category: e.category,
        status: e.status,
      }))

    // Payments remitted FROM this compartment (owner-owned approvals tagged to
    // the sub via the ledger effect).
    const payments = await listApprovalsForUser(ownerId, "payment")
    const payouts: LinkedAccountPayout[] = payments
      .filter((r) => (r.ledgerEffect?.subAccountId || undefined) === subId)
      .map((r) => {
        const rec = (r.payload?.record as Record<string, unknown> | undefined) ?? {}
        const amount = typeof rec.amount === "number" ? rec.amount : Number(r.amount) || 0
        const fee = typeof rec.fee === "number" ? rec.fee : 0
        const total = typeof rec.total === "number" ? rec.total : amount + fee
        return {
          id: r.id,
          beneficiary: (rec.beneficiary as string) || r.title || "Beneficiary",
          amount,
          fee,
          total,
          currency: (rec.currency as string) || r.currency || sub.currency,
          reference: (rec.reference as string) || "",
          status: r.status,
          submittedAt: (rec.submittedAt as string) || r.createdAt,
        }
      })

    return {
      ok: true,
      data: {
        subAccountId: subId,
        label: sub.label,
        currency: sub.currency,
        iban: sub.iban,
        bic: sub.bic,
        beneficiaryName: sub.beneficiaryName,
        status: sub.status,
        balance,
        activity,
        payouts,
      },
    }
  } catch (err) {
    console.log("[v0] getMyLinkedAccount failed:", (err as Error).message)
    return { ok: false, error: "Your linked account could not be loaded. Please try again." }
  }
}

/**
 * Move funds between the linked sub-account and the owner's MAIN account.
 * `direction`:
 *  - "topup"    → Main → Sub (visitor pulls owner main funds into the compartment)
 *  - "withdraw" → Sub → Main (visitor returns compartment funds to owner main)
 * A 2% fee is always charged to the Main account (same rule as ordinary internal
 * transfers). Same-currency only (the compartment's currency).
 */
export async function linkedTransfer(input: {
  direction: "topup" | "withdraw"
  amount: number
  note?: string
}): Promise<LinkedResult<{ reference: string }>> {
  const ctx = await requireMyLink()
  if (!ctx) return { ok: false, error: "You are not linked to a sub-account." }
  const { ownerId, subId, sub, session } = ctx

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid amount." }
  const currency = sub.currency
  const fee = transferFeeFor(amount)
  const fmt = (n: number) =>
    `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // from/to compartments: undefined tag = Main.
  const fromTag = input.direction === "topup" ? undefined : subId
  const toTag = input.direction === "topup" ? subId : undefined
  const fromLabel = input.direction === "topup" ? "Main account" : sub.label
  const toLabel = input.direction === "topup" ? sub.label : "Main account"

  try {
    const entries = await readLedgerEntries(ownerId)
    const sourceAvailable = fromTag === undefined ? mainBalance(entries, currency) : compartmentBalance(entries, currency, subId)
    // When the source IS main it must cover amount + fee; otherwise main must
    // independently cover the fee.
    const sourceNeed = fromTag === undefined ? amount + fee : amount
    if (sourceNeed > sourceAvailable + 0.001) {
      return {
        ok: false,
        error:
          fromTag === undefined
            ? `This transfer needs ${fmt(amount)} plus a ${fmt(fee)} fee (${fmt(sourceNeed)}), but only ${fmt(
                sourceAvailable,
              )} is available.`
            : `Insufficient funds in ${fromLabel}. Available ${fmt(sourceAvailable)}.`,
      }
    }
    if (fromTag !== undefined && fee > 0) {
      const mainAvail = mainBalance(entries, currency)
      if (fee > mainAvail + 0.001) {
        return { ok: false, error: `The ${fmt(fee)} fee is charged to the Main account, which has only ${fmt(mainAvail)}.` }
      }
    }

    const ref = `LSAT-${Date.now().toString().slice(-8)}`
    const nowIso = new Date().toISOString()
    const note = (input.note || "").trim()

    await upsertLedgerEntry(ownerId, {
      id: `${ref}-OUT`,
      direction: "debit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: toLabel,
      reference: ref,
      comment: note || `Linked transfer to ${toLabel}.`,
      category: "Sub-account Transfer",
      subAccountId: fromTag,
    })
    await upsertLedgerEntry(ownerId, {
      id: `${ref}-IN`,
      direction: "credit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: fromLabel,
      reference: ref,
      comment: note || `Linked transfer from ${fromLabel}.`,
      category: "Sub-account Transfer",
      subAccountId: toTag,
    })
    if (fee > 0) {
      await upsertLedgerEntry(ownerId, {
        id: `${ref}-FEE`,
        direction: "debit",
        amount: fee,
        currency,
        status: "completed",
        date: nowIso,
        counterparty: "NAFTAhub",
        reference: ref,
        comment: `${(TRANSFER_FEE_RATE * 100).toFixed(0)}% transfer fee on ${fmt(amount)} (${fromLabel} → ${toLabel}).`,
        category: "Transfer Fee",
      })
    }

    try {
      await assertOwnerSolvent(ownerId)
    } catch {
      await deleteLedgerEntry(ownerId, `${ref}-OUT`)
      await deleteLedgerEntry(ownerId, `${ref}-IN`)
      await deleteLedgerEntry(ownerId, `${ref}-FEE`)
      return { ok: false, error: "The transfer could not be completed. Please try again." }
    }

    // Tell the owner their compartment moved (initiated by the linked visitor).
    await insertNotification({
      userId: ownerId,
      tone: "info",
      title: "Sub-account transfer",
      body: `${fmt(amount)} moved ${fromLabel} → ${toLabel} on "${sub.label}" by a linked user. A ${fmt(fee)} fee was applied to the Main account.`,
      href: "/dashboard/sub-accounts",
    }).catch(() => {})

    return { ok: true, data: { reference: ref } }
  } catch (err) {
    console.log("[v0] linkedTransfer failed:", (err as Error).message)
    return { ok: false, error: "The transfer could not be completed. Please try again." }
  }
}

/**
 * Request an outgoing payment FROM the linked sub-account. Creates a pending
 * payment approval attributed to the OWNER (so it appears in the administrator's
 * Outgoing Payments queue and settles onto the owner's ledger tagged to this
 * compartment on approval), initiated by the linked visitor for the audit
 * trail. A 2% fee is added; the compartment must cover principal + fee now.
 */
export async function linkedPayout(input: {
  beneficiary: string
  beneficiaryCountry?: string
  iban: string
  swiftCode?: string
  reference?: string
  notes?: string
  amount: number
}): Promise<LinkedResult<{ id: string }>> {
  const ctx = await requireMyLink()
  if (!ctx) return { ok: false, error: "You are not linked to a sub-account." }
  const { ownerId, subId, sub, session } = ctx

  const beneficiary = (input.beneficiary || "").trim()
  const iban = (input.iban || "").trim().replace(/\s+/g, "").toUpperCase()
  const amount = Number(input.amount)
  if (!beneficiary) return { ok: false, error: "Enter the beneficiary name." }
  if (iban.length < 8) return { ok: false, error: "Enter a valid beneficiary IBAN / account." }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid amount." }

  const currency = sub.currency
  const fee = Math.round(amount * PAYMENT_FEE_RATE * 100) / 100
  const total = Math.round((amount + fee) * 100) / 100
  const fmt = (n: number) =>
    `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  try {
    const entries = await readLedgerEntries(ownerId)
    const available = compartmentBalance(entries, currency, subId)
    if (total > available + 0.01) {
      return {
        ok: false,
        error: `This payment needs ${fmt(amount)} plus a ${fmt(fee)} fee (${fmt(total)}), but the "${sub.label}" sub-account has only ${fmt(
          available,
        )} available.`,
      }
    }

    const uetr = generateUetr()
    const localId = `LPAY-${Date.now().toString().slice(-9)}`
    const reference = (input.reference || "").trim()
    const initiatorName = session.profile.fullName || session.profile.company || "Linked user"

    // PaymentRequest-shaped record so the admin queue + owner payments view
    // render it exactly like an owner-initiated payment.
    const record = {
      id: localId,
      uetr,
      beneficiary,
      beneficiaryCountry: (input.beneficiaryCountry || "").trim(),
      iban,
      swiftCode: (input.swiftCode || "").trim().toUpperCase(),
      reference,
      notes: (input.notes || "").trim(),
      currency,
      amount,
      fee,
      total,
      payeeSource: sub.label,
      subAccountId: subId,
      subAccountLabel: sub.label,
      status: "pending",
      submittedAt: new Date().toISOString(),
    }

    const request = await insertApproval({
      userId: ownerId,
      kind: "payment",
      title: `Payment to ${beneficiary}`,
      summary: `${fmt(amount)} to ${beneficiary}${reference ? ` · ${reference}` : ""} — from "${sub.label}" (linked user)`,
      amount: total,
      currency,
      payload: { localId, uetr, iban, swiftCode: record.swiftCode, record },
      ledgerEffect: {
        direction: "debit",
        amount: total,
        currency,
        status: "completed",
        counterparty: beneficiary,
        account: iban,
        reference: reference || uetr,
        category: "Outgoing Payment",
        subAccountId: subId,
      },
      initiatedById: session.id,
      initiatedByName: initiatorName,
    })

    await insertNotification({
      userId: ownerId,
      tone: "info",
      title: "Payment requested from a sub-account",
      body: `A linked user requested ${fmt(amount)} to ${beneficiary} from "${sub.label}". It is awaiting administrator authorization.`,
      href: "/dashboard/payments",
    }).catch(() => {})

    return { ok: true, data: { id: request.id } }
  } catch (err) {
    console.log("[v0] linkedPayout failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be submitted. Please try again." }
  }
}
