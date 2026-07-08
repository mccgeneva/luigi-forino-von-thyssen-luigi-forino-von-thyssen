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
