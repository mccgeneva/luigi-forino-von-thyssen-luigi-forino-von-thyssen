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

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { getVisitorLink } from "@/lib/visitor-link-db"
import { getSubAccountById, listAllSubAccounts } from "@/lib/sub-account-db"
import { readLedgerEntries, upsertLedgerEntry, deleteLedgerEntry, assertOwnerSolvent } from "@/lib/ledger-db"
import type { LedgerEntry } from "@/lib/ledger-store"
import { insertApproval, seedApproval, listApprovalsForUser } from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { transferFeeFor, TRANSFER_FEE_RATE } from "@/lib/sub-account-fees"
import { generateUetr } from "@/lib/swift-gpi"
import type { SubAccount } from "@/lib/sub-account-types"
import { query } from "@/lib/db"
import { listDynamicUsers } from "@/lib/admin-users-db"
import { extractBankingCoordinates } from "@/lib/banking-coordinates"
import { validateIban } from "@/lib/iban-swift"

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

/** Strip an IBAN/account string down to comparable A–Z0–9 (uppercase). */
function normIban(raw: string | undefined | null): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * A platform account whose IBAN matches a beneficiary — i.e. the payment stays
 * INSIDE NAFTAhub and settles in real time as an intra-user transfer.
 */
interface InternalMatch {
  /** Data-owner ledger to credit (a sub-account's balance lives on its master). */
  recipientOwnerId: string
  /** When set, credit that isolated compartment; otherwise the main account. */
  recipientSubAccountId?: string
  /** Human label for the audit trail / notification (never shown to the payer). */
  recipientLabel: string
  /** The kind of account matched, for the audit note. */
  kind: "sub_account" | "gateway_account" | "master_account"
}

/**
 * Resolve a beneficiary IBAN to a platform account, if any. Checks — in order —
 * every active sub-account IBAN, every active gateway (registered bank) account
 * IBAN, and every active user's master-account IBAN. A single unambiguous match
 * means the payment is INTERNAL (settles instantly); no match means it leaves
 * the platform and must be handled by the administrator.
 *
 * The compartment the payment is remitted FROM is excluded so a visitor can
 * never "pay" money straight back into the very same sub-account.
 */
async function resolveInternalIban(iban: string, payerSubId: string): Promise<InternalMatch | null> {
  const target = normIban(iban)
  if (!target) return null

  // 1) Active sub-accounts (credit the exact compartment the IBAN represents).
  try {
    const subs = await listAllSubAccounts("active")
    const sub = subs.find((s) => s.iban && normIban(s.iban) === target && s.id !== payerSubId)
    if (sub) {
      return {
        recipientOwnerId: await resolveDataOwnerIdFor(sub.userId),
        recipientSubAccountId: sub.id,
        recipientLabel: sub.label || "Sub-account",
        kind: "sub_account",
      }
    }
  } catch (err) {
    console.log("[v0] resolveInternalIban sub-accounts failed:", (err as Error).message)
  }

  // 2) Active gateway (registered bank) accounts → credit the owner's master.
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS gateway_accounts (
         user_id text NOT NULL, request_id text NOT NULL, status text NOT NULL,
         submitted_at timestamptz, decided_at timestamptz,
         updated_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
         PRIMARY KEY (user_id, request_id))`,
    )
    const { rows } = await query(`SELECT user_id, payload FROM gateway_accounts WHERE status = 'active'`)
    for (const row of rows as Array<{ user_id: string; payload: Record<string, unknown> }>) {
      const payload = (row.payload ?? {}) as {
        userId?: string
        currency?: string
        coordinates?: { iban?: string; partnerBankName?: string }
      }
      if (payload.coordinates?.iban && normIban(payload.coordinates.iban) === target) {
        const ownerId = payload.userId || row.user_id
        return {
          recipientOwnerId: await resolveDataOwnerIdFor(ownerId),
          recipientLabel: payload.coordinates.partnerBankName || "Registered account",
          kind: "gateway_account",
        }
      }
    }
  } catch (err) {
    console.log("[v0] resolveInternalIban gateway failed:", (err as Error).message)
  }

  // 3) Active users' master-account IBANs (set by the administrator).
  try {
    const users = await listDynamicUsers()
    for (const u of users) {
      if (u.status !== "active") continue
      const coords = extractBankingCoordinates(u.profile.banking)
      if (coords.iban && normIban(coords.iban) === target) {
        return {
          recipientOwnerId: await resolveDataOwnerIdFor(u.id),
          recipientLabel: u.profile.fullName || u.profile.company || "NAFTAhub account",
          kind: "master_account",
        }
      }
    }
  } catch (err) {
    console.log("[v0] resolveInternalIban master failed:", (err as Error).message)
  }

  return null
}

/**
 * Called live by the payout form as the visitor types an IBAN. Returns whether
 * the (valid) IBAN belongs to a NAFTAhub account — so the UI can tell the user
 * the transfer will arrive INSTANTLY (internal) or go through administrator
 * authorization (external). Never reveals the counterparty's identity.
 */
export async function resolveLinkedBeneficiary(
  iban: string,
): Promise<{ ok: true; internal: boolean } | { ok: false; error: string }> {
  const ctx = await requireMyLink()
  if (!ctx) return { ok: false, error: "You are not linked to a sub-account." }
  const clean = normIban(iban)
  if (clean.length < 8) return { ok: true, internal: false }
  // Only IBAN-scheme values can be matched against stored IBANs.
  if (!validateIban(clean).valid) return { ok: true, internal: false }
  try {
    const match = await resolveInternalIban(clean, ctx.subId)
    return { ok: true, internal: !!match }
  } catch (err) {
    console.log("[v0] resolveLinkedBeneficiary failed:", (err as Error).message)
    return { ok: true, internal: false }
  }
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
      .filter((r) => {
        const recSub = (r.payload?.record as { subAccountId?: string } | undefined)?.subAccountId
        // Match by the record's compartment tag (set on every linked payout,
        // internal or external) OR the ledger effect's tag (external only, for
        // legacy rows written before internal settlement existed).
        return (recSub || r.ledgerEffect?.subAccountId || undefined) === subId
      })
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
}): Promise<LinkedResult<{ id: string; settlement: "instant" | "pending" }>> {
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
    const swiftCode = (input.swiftCode || "").trim().toUpperCase()

    // Decide the rail: if the beneficiary IBAN belongs to a NAFTAhub account the
    // transfer stays INSIDE the platform and settles in real time; otherwise it
    // leaves the platform and must be authorized by an administrator.
    const internal = await resolveInternalIban(iban, subId)

    // Shared PaymentRequest-shaped record so the admin queue + owner payments
    // view + the linked payouts list all render it consistently.
    const record: Record<string, unknown> = {
      id: localId,
      uetr,
      beneficiary,
      beneficiaryCountry: (input.beneficiaryCountry || "").trim(),
      iban,
      swiftCode,
      reference,
      notes: (input.notes || "").trim(),
      currency,
      amount,
      fee,
      total,
      payeeSource: sub.label,
      subAccountId: subId,
      subAccountLabel: sub.label,
      submittedAt: new Date().toISOString(),
    }

    // -----------------------------------------------------------------------
    // INTERNAL — instant intra-platform transfer (no administrator step).
    // -----------------------------------------------------------------------
    if (internal) {
      record.status = "approved"
      record.settledAt = new Date().toISOString()
      record.internal = true
      record.settlement = "instant"

      const nowIso = new Date().toISOString()
      const ref = reference || uetr

      // 1) Debit the paying compartment: principal to the beneficiary…
      await upsertLedgerEntry(ownerId, {
        id: `${localId}-OUT`,
        direction: "debit",
        amount,
        currency,
        status: "completed",
        date: nowIso,
        counterparty: beneficiary,
        account: iban,
        reference: ref,
        category: "Outgoing Payment",
        comment: `Instant NAFTAhub transfer to ${beneficiary} from "${sub.label}"${reference ? ` · ${reference}` : ""}.`,
        subAccountId: subId,
      })
      // …plus the 2% platform fee, charged from the same compartment.
      if (fee > 0) {
        await upsertLedgerEntry(ownerId, {
          id: `${localId}-FEE`,
          direction: "debit",
          amount: fee,
          currency,
          status: "completed",
          date: nowIso,
          counterparty: "NAFTAhub",
          reference: ref,
          category: "Payment Fee",
          comment: `${(PAYMENT_FEE_RATE * 100).toFixed(0)}% platform fee on ${fmt(amount)} (payment to ${beneficiary}).`,
          subAccountId: subId,
        })
      }
      // 2) Credit the recipient's account in real time (their compartment when
      //    the IBAN is a sub-account, otherwise their main account).
      await upsertLedgerEntry(internal.recipientOwnerId, {
        id: `${localId}-IN`,
        direction: "credit",
        amount,
        currency,
        status: "completed",
        date: nowIso,
        counterparty: initiatorName,
        account: iban,
        reference: ref,
        category: "Inbound Transfer",
        comment: `Instant NAFTAhub transfer received from ${initiatorName}${reference ? ` · ${reference}` : ""}.`,
        subAccountId: internal.recipientSubAccountId,
      })

      // 3) Guard the payer's overall solvency; unwind everything on failure.
      try {
        await assertOwnerSolvent(ownerId)
        if (internal.recipientOwnerId !== ownerId) await assertOwnerSolvent(internal.recipientOwnerId)
      } catch {
        await deleteLedgerEntry(ownerId, `${localId}-OUT`)
        await deleteLedgerEntry(ownerId, `${localId}-FEE`)
        await deleteLedgerEntry(internal.recipientOwnerId, `${localId}-IN`)
        return { ok: false, error: "The transfer could not be completed. Please try again." }
      }

      // 4) Record a settled payment for the audit trail / payouts list (no
      //    ledger effect — the ledger is posted directly above).
      await seedApproval({
        id: `APPR-${localId}`,
        userId: ownerId,
        kind: "payment",
        status: "approved",
        decidedAt: nowIso,
        title: `Payment to ${beneficiary}`,
        summary: `${fmt(amount)} to ${beneficiary}${reference ? ` · ${reference}` : ""} — instant NAFTAhub transfer from "${sub.label}" (linked user)`,
        amount: total,
        currency,
        payload: { localId, uetr, iban, swiftCode, internal: true, record },
      })

      // 5) Notify both sides.
      await insertNotification({
        userId: internal.recipientOwnerId,
        tone: "success",
        title: "Payment received",
        body: `${fmt(amount)} received from ${initiatorName}${reference ? ` · ${reference}` : ""}.`,
        href: "/dashboard",
      }).catch(() => {})
      if (internal.recipientOwnerId !== ownerId) {
        await insertNotification({
          userId: ownerId,
          tone: "info",
          title: "Instant transfer sent",
          body: `${fmt(amount)} sent to ${beneficiary} from "${sub.label}" — settled instantly to a NAFTAhub account.`,
          href: "/dashboard",
        }).catch(() => {})
      }

      return { ok: true, data: { id: `APPR-${localId}`, settlement: "instant" } }
    }

    // -----------------------------------------------------------------------
    // EXTERNAL — leaves the platform: administrator-authorized outgoing payment.
    // -----------------------------------------------------------------------
    record.status = "pending"

    const request = await insertApproval({
      userId: ownerId,
      kind: "payment",
      title: `Payment to ${beneficiary}`,
      summary: `${fmt(amount)} to ${beneficiary}${reference ? ` · ${reference}` : ""} — from "${sub.label}" (linked user)`,
      amount: total,
      currency,
      payload: { localId, uetr, iban, swiftCode, record },
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

    return { ok: true, data: { id: request.id, settlement: "pending" } }
  } catch (err) {
    console.log("[v0] linkedPayout failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be submitted. Please try again." }
  }
}
