"use server"

import { resolveCurrentSession } from "@/lib/session-user"
import { getMyMembership } from "@/app/actions/membership"
import { capabilitiesForAccount } from "@/lib/tier-capabilities"
import { logActivity } from "@/app/actions/log-activity"
import {
  insertSubAccount,
  listSubAccountsForUser,
  getSubAccountById,
  updateSubAccountBeneficiary,
} from "@/lib/sub-account-db"
import { readLedgerEntries, upsertLedgerEntry, assertOwnerSolvent, deleteLedgerEntry } from "@/lib/ledger-db"
import { MAIN_ACCOUNT_ID, type SubAccount, type SubAccountDoc } from "@/lib/sub-account-types"
import type { LedgerEntry } from "@/lib/ledger-store"

/**
 * Client-facing server actions for self-managed SUB-ACCOUNTS.
 *
 * A sub-account is an isolated compartment of the SAME user's money — no other
 * person, no separate login. Creating one is a PRO / Avant-Garde capability
 * (Visitors are blocked). An administrator later assigns the IBAN/BIC and
 * activates it. Funds move between the Main account and any active sub-account
 * via instant, zero-sum internal transfers that are solvency-checked per
 * compartment on the server.
 */

const MAX_SUB_ACCOUNTS = 20

export type SubAccountResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Net balance of a compartment (main = undefined subId) in one currency. */
function compartmentBalance(entries: LedgerEntry[], currency: string, subId?: string): number {
  let total = 0
  for (const e of entries) {
    if (e.currency !== currency) continue
    const tag = e.subAccountId || undefined
    if (tag !== subId) continue
    if (e.status === "hold") {
      if (e.direction === "debit") total -= e.amount
    } else {
      total += e.direction === "credit" ? e.amount : -e.amount
    }
  }
  return total
}

/** List the signed-in user's sub-accounts (scoped to the data-owner id). */
export async function listMySubAccounts(): Promise<SubAccount[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    return await listSubAccountsForUser(session.dataOwnerId)
  } catch (err) {
    console.log("[v0] listMySubAccounts failed:", (err as Error).message)
    return []
  }
}

/** Open a new sub-account request. PRO / Avant-Garde only. */
export async function requestSubAccount(input: {
  label: string
  currency: string
  purpose?: string
  beneficiaryName?: string
  beneficiaryDetails?: string
  /** Uploaded UBO identity documents (passport + KYC). When both are present the
   *  sub-account is a DECLARED UBO; otherwise it is flagged as an alias. */
  kycDocuments?: SubAccountDoc[]
  /** Required acceptance of personal legal responsibility for an alias account. */
  legalResponsibilityAccepted?: boolean
}): Promise<SubAccountResult<SubAccount>> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  // Tier gate: sub-accounts are a PRO / Avant-Garde feature. Visitors are asked
  // to upgrade (the section UI is also gated, this is the authoritative check).
  const membership = await getMyMembership()
  if (capabilitiesForAccount(session.profile.accountBadge, membership).isVisitor) {
    return {
      ok: false,
      error: "Sub-accounts are available on PRO and Avant-Garde plans. Upgrade your account to open one.",
    }
  }

  const label = (input.label || "").trim()
  const currency = (input.currency || "EUR").trim().toUpperCase()
  const purpose = (input.purpose || "").trim()
  const beneficiaryName = (input.beneficiaryName || "").trim()
  const beneficiaryDetails = (input.beneficiaryDetails || "").trim()
  if (label.length < 2) return { ok: false, error: "Enter a name for the sub-account (at least 2 characters)." }
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Choose a valid currency." }

  // UBO verification: keep only stored (blob-backed) docs, then require BOTH a
  // passport AND a KYC document to count as a DECLARED sub-account. Anything
  // less is an ALIAS, which is allowed only if the holder explicitly accepts
  // personal legal responsibility for all activity under it.
  const docs = (input.kycDocuments || []).filter(
    (d) => d && (d.kind === "passport" || d.kind === "kyc") && typeof d.pathname === "string" && d.pathname.length > 0,
  )
  const hasPassport = docs.some((d) => d.kind === "passport")
  const hasKyc = docs.some((d) => d.kind === "kyc")
  const isDeclared = hasPassport && hasKyc
  const verification: "declared" | "alias" = isDeclared ? "declared" : "alias"
  if (!isDeclared && input.legalResponsibilityAccepted !== true) {
    return {
      ok: false,
      error:
        "Upload the beneficiary's passport and a KYC document to declare the UBO, or accept legal responsibility to continue as an alias sub-account.",
    }
  }
  const legalResponsibilityAcceptedAt = !isDeclared ? new Date().toISOString() : undefined

  const ownerId = session.dataOwnerId
  try {
    const existing = await listSubAccountsForUser(ownerId)
    const openCount = existing.filter((s) => s.status === "pending" || s.status === "active").length
    if (openCount >= MAX_SUB_ACCOUNTS) {
      return { ok: false, error: `You have reached the maximum of ${MAX_SUB_ACCOUNTS} sub-accounts.` }
    }

    const id = `SUB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const created = await insertSubAccount({
      id,
      userId: ownerId,
      label,
      currency,
      purpose: purpose || undefined,
      beneficiaryName: beneficiaryName || undefined,
      beneficiaryDetails: beneficiaryDetails || undefined,
      verification,
      kycDocuments: docs.length ? docs : undefined,
      legalResponsibilityAcceptedAt,
    })

    await logActivity({
      action: `Requested a new ${currency} sub-account "${label}"`,
      category: "Accounts",
      details: {
        summary: `Client opened sub-account request ${id} ("${label}", ${currency}, ${verification === "declared" ? "UBO declared with KYC + passport" : "alias — holder accepted legal responsibility"}). Awaiting administrator IBAN assignment.`,
        referenceId: id,
        purpose: purpose || "(none)",
        verification,
      },
    })

    return { ok: true, data: created }
  } catch (err) {
    console.log("[v0] requestSubAccount failed:", (err as Error).message)
    return { ok: false, error: "Could not open the sub-account. Please try again." }
  }
}

/** Update a sub-account's own beneficiary. Owner-scoped; PRO / Avant-Garde. */
export async function updateMySubAccountBeneficiary(input: {
  id: string
  beneficiaryName?: string
  beneficiaryDetails?: string
}): Promise<SubAccountResult<SubAccount>> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const membership = await getMyMembership()
  if (capabilitiesForAccount(session.profile.accountBadge, membership).isVisitor) {
    return { ok: false, error: "Sub-accounts are available on PRO and Avant-Garde plans." }
  }

  const beneficiaryName = (input.beneficiaryName || "").trim()
  const beneficiaryDetails = (input.beneficiaryDetails || "").trim()
  const ownerId = session.dataOwnerId
  try {
    const existing = await getSubAccountById(input.id)
    if (!existing || existing.userId !== ownerId) return { ok: false, error: "Sub-account not found." }
    const updated = await updateSubAccountBeneficiary(input.id, ownerId, {
      beneficiaryName: beneficiaryName || undefined,
      beneficiaryDetails: beneficiaryDetails || undefined,
    })
    if (!updated) return { ok: false, error: "Could not update the beneficiary." }
    await logActivity({
      action: `Updated the beneficiary of sub-account "${existing.label}"`,
      category: "Accounts",
      details: {
        summary: `Beneficiary for sub-account ${existing.id} set to "${beneficiaryName || "(none)"}".`,
        referenceId: existing.id,
      },
    })
    return { ok: true, data: updated }
  } catch (err) {
    console.log("[v0] updateMySubAccountBeneficiary failed:", (err as Error).message)
    return { ok: false, error: "Could not update the beneficiary. Please try again." }
  }
}

/**
 * Instant internal transfer between the Main account and a sub-account (either
 * direction) or between two sub-accounts. Zero-sum on the owner's ledger and
 * solvency-checked against the SOURCE compartment's own balance.
 */
export async function transferToSubAccount(input: {
  fromId: string
  toId: string
  amount: number
  currency: string
  note?: string
}): Promise<SubAccountResult<{ reference: string }>> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const membership = await getMyMembership()
  if (capabilitiesForAccount(session.profile.accountBadge, membership).isVisitor) {
    return { ok: false, error: "Sub-accounts are available on PRO and Avant-Garde plans." }
  }

  const amount = Number(input.amount)
  const currency = (input.currency || "EUR").trim().toUpperCase()
  const fromId = input.fromId
  const toId = input.toId
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid amount greater than 0." }
  if (fromId === toId) return { ok: false, error: "Choose two different accounts." }

  const ownerId = session.dataOwnerId

  try {
    // Validate that any sub-account leg is an ACTIVE sub-account the user owns,
    // in the same currency as the transfer.
    const resolveLeg = async (id: string): Promise<{ tag?: string; label: string } | { error: string }> => {
      if (id === MAIN_ACCOUNT_ID) return { tag: undefined, label: "Main account" }
      const sub = await getSubAccountById(id)
      if (!sub || sub.userId !== ownerId) return { error: "Sub-account not found." }
      if (sub.status !== "active") return { error: `"${sub.label}" is not active yet.` }
      if (sub.currency !== currency) {
        return { error: `"${sub.label}" operates in ${sub.currency}, not ${currency}.` }
      }
      return { tag: sub.id, label: sub.label }
    }

    const from = await resolveLeg(fromId)
    if ("error" in from) return { ok: false, error: from.error }
    const to = await resolveLeg(toId)
    if ("error" in to) return { ok: false, error: to.error }

    // Source solvency: the source compartment must hold the funds.
    const entries = await readLedgerEntries(ownerId)
    const available = compartmentBalance(entries, currency, from.tag)
    if (amount > available + 0.001) {
      return {
        ok: false,
        error: `Insufficient funds in ${from.label}. Available ${currency} ${available.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}.`,
      }
    }

    const ref = `SAT-${Date.now().toString().slice(-8)}`
    const nowIso = new Date().toISOString()
    const note = (input.note || "").trim()

    // Debit the source compartment.
    await upsertLedgerEntry(ownerId, {
      id: `${ref}-OUT`,
      direction: "debit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: to.label,
      reference: ref,
      comment: note || `Internal transfer to ${to.label}.`,
      category: "Sub-account Transfer",
      subAccountId: from.tag,
    })
    // Credit the destination compartment.
    await upsertLedgerEntry(ownerId, {
      id: `${ref}-IN`,
      direction: "credit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: from.label,
      reference: ref,
      comment: note || `Internal transfer from ${from.label}.`,
      category: "Sub-account Transfer",
      subAccountId: to.tag,
    })

    // Non-negativity guard on the whole owner ledger. The transfer is zero-sum
    // so this always holds, but roll back both legs on any surprise.
    try {
      await assertOwnerSolvent(ownerId)
    } catch {
      await deleteLedgerEntry(ownerId, `${ref}-OUT`)
      await deleteLedgerEntry(ownerId, `${ref}-IN`)
      return { ok: false, error: "The transfer could not be completed. Please try again." }
    }

    await logActivity({
      action: `Moved ${currency} ${amount.toLocaleString("en-US")} from ${from.label} to ${to.label}`,
      category: "Accounts",
      details: {
        summary: `Instant internal sub-account transfer of ${currency} ${amount.toLocaleString("en-US")} (${from.label} → ${to.label}). Reference ${ref}.`,
        referenceId: ref,
        note: note || "(none)",
      },
    })

    return { ok: true, data: { reference: ref } }
  } catch (err) {
    console.log("[v0] transferToSubAccount failed:", (err as Error).message)
    return { ok: false, error: "The transfer could not be completed. Please try again." }
  }
}
