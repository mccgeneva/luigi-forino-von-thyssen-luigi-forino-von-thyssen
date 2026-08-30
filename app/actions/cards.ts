"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveAccountProfileById } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { insertNotification } from "@/lib/notifications-db"
import {
  insertApproval,
  getApprovalById,
  decideApproval,
  updateApprovalPayload,
  type ApprovalRequest,
} from "@/lib/approvals-db"
import { adminDecideApproval } from "@/app/actions/approvals"
import { addLedgerEntryForUserAdmin } from "@/app/actions/ledger"
import type { LedgerEntry } from "@/lib/ledger-store"
import { KIND_HREF } from "@/lib/approval-kinds"

async function adminOk(passcode: string): Promise<boolean> {
  return adminActionAuthorized(passcode)
}

export type CardActionResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

function describeCard(card: Record<string, unknown>): string {
  const network = String(card?.network ?? "Card")
  const tier = String(card?.tier ?? "")
  const tierLabel = tier ? tier.replace(/_/g, " ") : ""
  const format = String(card?.format ?? "")
  return `${network}${tierLabel ? ` ${tierLabel}` : ""}${format ? ` ${format}` : ""}`.trim()
}

/**
 * Decide a client's card request. On approval the administrator may pass a
 * customized `finalCard` (network, tier, limit, features, etc.); it is written
 * into the approval payload so the client materializes the exact card that was
 * authorized. Reuses the shared approvals decision pipeline for notification
 * and audit, so a card decision behaves like every other approval.
 */
export async function adminDecideCardRequest(
  passcode: string,
  id: string,
  decision: "approved" | "rejected",
  finalCard?: Record<string, unknown>,
  note?: string,
): Promise<CardActionResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }

  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Request not found." }
    if (existing.kind !== "card") return { ok: false, error: "This request is not a card request." }

    // Persist the administrator's finalized/customized card before the decision
    // so the approved payload carries the authoritative card the client will see.
    if (decision === "approved" && finalCard) {
      await updateApprovalPayload(id, { ...existing.payload, card: finalCard, finalized: true })
    }

    const res = await adminDecideApproval(passcode, id, decision, note)
    return res
  } catch (err) {
    console.log("[v0] adminDecideCardRequest failed:", (err as Error).message)
    return { ok: false, error: "The decision could not be recorded. Please try again." }
  }
}

/**
 * Issue a premium card directly into a client's wallet (no client request
 * needed). Born pending, then immediately approved so it shares the exact same
 * audit + notification path as any other decision. The full card travels in the
 * payload (`issuedByAdmin`) so the client materializes it across devices.
 */
export async function adminIssueCard(
  passcode: string,
  userId: string,
  card: Record<string, unknown>,
): Promise<CardActionResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!userId) return { ok: false, error: "Select a client to issue to." }

  const id = String(card?.id ?? "").trim()
  if (!id) return { ok: false, error: "The card is missing an identifier." }
  const label = describeCard(card)
  const currency = String(card?.currency ?? "EUR")
  const monthlyLimit = Number(card?.monthlyLimit ?? 0)

  try {
    const created = await insertApproval({
      userId,
      kind: "card",
      title: `${label} card`,
      summary: `${label} card issued directly with a ${currency} ${monthlyLimit.toLocaleString("en-US")} monthly limit (administrator issuance).`,
      amount: monthlyLimit || null,
      currency,
      payload: { issuedByAdmin: true, finalized: true, card },
    })

    const decided = await decideApproval(created.id, "approved", "Administrator")
    const request = decided ?? created

    try {
      await insertNotification({
        userId,
        tone: "success",
        title: "New card issued",
        body: `MCC Capital issued a ${label} card to your wallet. It is active and ready to manage.`,
        href: KIND_HREF.card ?? "/dashboard/cards",
      })
    } catch (err) {
      console.log("[v0] card issue notification failed:", (err as Error).message)
    }

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator issued a ${label} card to ${target.fullName}`,
      category: "Administration / Cards",
      user: "Administrator",
      details: {
        referenceId: id,
        targetAccount: `${target.fullName} — ${target.email}`,
        card: label,
        monthlyLimit: `${currency} ${monthlyLimit.toLocaleString("en-US")}`,
        action: "Issued",
      },
    })

    return { ok: true, request }
  } catch (err) {
    console.log("[v0] adminIssueCard failed:", (err as Error).message)
    return { ok: false, error: "The card could not be issued. Please try again." }
  }
}

/** The platform fee applied to every recorded card transaction. */
export const CARD_TRANSACTION_FEE_RATE = 0.02
export const CARD_TRANSACTION_FEE_LABEL = "2%"

const round2 = (n: number) => Math.round(n * 100) / 100

export type RecordCardTransactionResult =
  | { ok: true; amount: number; fee: number; total: number; currency: string }
  | { ok: false; error: string }

/**
 * Record a card transaction (typically read from an uploaded receipt) against a
 * client's Master Account. Posts TWO settled debits to the master ledger via
 * the shared admin ledger poster: the transaction amount, plus a separate 2%
 * platform fee — so the client is charged amount + 2% and it reflects on their
 * balance on the next ledger read (no client action needed). The fee is always
 * computed server-side; the client never supplies it.
 */
export async function adminRecordCardTransaction(
  passcode: string,
  userId: string,
  input: {
    amount: number
    currency: string
    merchant?: string
    date?: string
    last4?: string
    reference?: string
    network?: string
  },
): Promise<RecordCardTransactionResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!userId) return { ok: false, error: "Select a client to charge." }

  const amount = round2(Number(input.amount))
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid transaction amount." }

  const currency = String(input.currency || "EUR").toUpperCase().slice(0, 3)
  const fee = round2(amount * CARD_TRANSACTION_FEE_RATE)
  const merchant = (input.merchant || "").trim() || "Card transaction"
  const cardTag = input.last4 ? ` ····${input.last4}` : ""
  const date = input.date && !Number.isNaN(Date.parse(input.date)) ? new Date(input.date).toISOString() : new Date().toISOString()
  const baseId = `CARDTXN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()

  try {
    // 1) The transaction amount.
    const txnEntry: LedgerEntry = {
      id: baseId,
      direction: "debit",
      amount,
      currency,
      status: "completed",
      date,
      counterparty: `${merchant}${input.network ? ` (${input.network})` : ""}`,
      reference: input.reference || baseId,
      category: `Card Transaction${cardTag}`,
      comment: `Card transaction recorded by administrator${input.reference ? ` — ref ${input.reference}` : ""}.`,
    }
    const txnRes = await addLedgerEntryForUserAdmin(passcode, userId, txnEntry)
    if (!txnRes.ok) return { ok: false, error: txnRes.error }

    // 2) The 2% platform fee, as a separate itemized debit.
    const feeEntry: LedgerEntry = {
      id: `${baseId}-FEE`,
      direction: "debit",
      amount: fee,
      currency,
      status: "completed",
      date,
      counterparty: "MCC Capital — Card Transaction Fee",
      reference: baseId,
      category: `Card Transaction Fee (${CARD_TRANSACTION_FEE_LABEL})`,
      comment: `${CARD_TRANSACTION_FEE_LABEL} platform fee on a ${currency} ${amount.toLocaleString("en-US")} card transaction (${merchant}).`,
    }
    const feeRes = await addLedgerEntryForUserAdmin(passcode, userId, feeEntry)
    if (!feeRes.ok) {
      // The transaction debit already posted; surface the fee failure clearly.
      return { ok: false, error: `Transaction posted, but the ${CARD_TRANSACTION_FEE_LABEL} fee could not be charged: ${feeRes.error}` }
    }

    try {
      await insertNotification({
        userId,
        tone: "info",
        title: "Card transaction recorded",
        body: `A ${currency} ${amount.toLocaleString("en-US")} card transaction${input.last4 ? ` on card ····${input.last4}` : ""} at ${merchant} was charged to your Master Account, plus a ${CARD_TRANSACTION_FEE_LABEL} fee (${currency} ${fee.toLocaleString("en-US")}).`,
        href: KIND_HREF.card ?? "/dashboard/cards",
      })
    } catch (err) {
      console.log("[v0] card txn notification failed:", (err as Error).message)
    }

    return { ok: true, amount, fee, total: round2(amount + fee), currency }
  } catch (err) {
    console.log("[v0] adminRecordCardTransaction failed:", (err as Error).message)
    return { ok: false, error: "The transaction could not be recorded. Please try again." }
  }
}
