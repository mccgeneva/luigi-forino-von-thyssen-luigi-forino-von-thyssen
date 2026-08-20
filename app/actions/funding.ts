"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  resolveAccountProfileById,
  resolveCurrentSession,
} from "@/lib/session-user"
import {
  getApprovalById,
  listAllApprovals,
  updateApprovalPayload,
} from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { addLedgerEntryForUserAdmin } from "@/app/actions/ledger"
import { logActivity } from "@/app/actions/log-activity"
import {
  buildFundingSettlementPosts,
  computeFundingSettlement,
} from "@/lib/funding-capital"
import type {
  FundingSettlementSnapshot,
  ProjectFundingRequest,
} from "@/lib/project-funding-store"

// ---------------------------------------------------------------------------
// Project Finance — early liquidation, recall/termination, and closure.
//
// Two entry points, both settling through the SAME deterministic ledger legs:
//   • A CLIENT requests early closure of one of their own facilities; the
//     administrator approves it, at which point the payoff is debited and the
//     facility is marked settled.
//   • An ADMINISTRATOR recalls / terminates / liquidates any facility directly
//     (clawback), debiting the payoff from the owner's balance immediately.
//
// The payoff = principal + outstanding interest tail + early-exit fee, computed
// by computeFundingSettlement(). Settlement debits use deterministic ids so the
// admin execution here and the client-side FundingCapitalReconciler converge on
// exactly the same rows (idempotent upserts — never doubled).
// ---------------------------------------------------------------------------

const FUNDING_HREF = "/dashboard/funding"

function readRecord(existing: {
  payload: Record<string, unknown>
}): ProjectFundingRequest | null {
  const record = existing.payload?.record as ProjectFundingRequest | undefined
  if (!record || typeof record !== "object" || !record.id) return null
  return record
}

// --- Admin: open the negotiation with the applicant ------------------------

export type FundingDiscussionResult = { ok: true } | { ok: false; error: string }

/**
 * Mark an AES project-funding application as "in discussion". Mirrors the
 * internal-loan flow: this is the mandatory gate before activation — it stamps
 * `discussionOpenedAt` on the record (idempotent — first open wins) and notifies
 * the applicant that the administrator has opened negotiations, so they can
 * reply and share documents in their Bankeka chat. Actual messages flow through
 * Bankeka; this only records that the conversation has begun.
 */
export async function openProjectFinanceDiscussionAdmin(input: {
  passcode: string
  approvalId: string
}): Promise<FundingDiscussionResult> {
  if (!(await adminActionAuthorized(input.passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  try {
    const existing = await getApprovalById(input.approvalId)
    if (!existing || existing.kind !== "project_funding") {
      return { ok: false, error: "Funding application not found." }
    }
    if (existing.status !== "pending") return { ok: true } // decided already — nothing to open

    const record = readRecord(existing)
    if (!record) return { ok: false, error: "Funding application not found." }
    if (record.discussionOpenedAt) return { ok: true } // already open — idempotent

    const openedAt = new Date().toISOString()
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    await updateApprovalPayload(input.approvalId, {
      ...prevPayload,
      record: { ...prevRecord, discussionOpenedAt: openedAt },
    })

    const facilityLabel = `${record.currency} ${Math.round(record.facility).toLocaleString("en-US")}`
    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Funding under discussion",
        body: `The administrator has opened a discussion about your ${facilityLabel} AES facility for "${record.projectName}". Reply and share any requested documents in your Bankeka chat.`,
        href: "/dashboard/bankeka",
      })
    } catch {
      // non-critical
    }

    const profile = await resolveAccountProfileById(existing.userId).catch(() => null)
    const applicantLabel = profile
      ? `${profile.fullName || profile.email || existing.userId}${profile.company ? ` (${profile.company})` : ""}`
      : existing.userId
    await logActivity({
      action: `Opened discussion on AES project funding ${record.id}`,
      category: "Project Funding",
      user: applicantLabel,
      userId: existing.userId,
      details: {
        summary: `Administrator opened negotiations on AES project funding ${record.id} ("${record.projectName}") for a facility of ${facilityLabel}.`,
        referenceId: record.id,
        applicant: applicantLabel,
      },
    })

    return { ok: true }
  } catch (err) {
    console.log("[v0] openProjectFinanceDiscussionAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not open the discussion. Please try again." }
  }
}

// --- Client: request / cancel early closure ---------------------------------

export type FundingClosureRequestResult =
  | { ok: true; quotedPayoff: number; currency: string }
  | { ok: false; error: string }

/**
 * The signed-in client requests early closure of one of their OWN approved
 * facilities. Records a closure request (with a payoff quote) on the facility
 * for the administrator to approve; it does NOT move money yet.
 */
export async function requestMyFundingClosure(
  approvalId: string,
  note?: string,
): Promise<FundingClosureRequestResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This facility could not be found." }
    // Ownership: the facility belongs to the signed-in account or its data owner.
    if (existing.userId !== session.id && existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "This facility could not be found." }
    }
    if (existing.kind !== "project_funding") {
      return { ok: false, error: "Only project finance facilities can be closed here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an active, funded facility can be closed early." }
    }

    const record = readRecord(existing)
    if (!record) return { ok: false, error: "This facility could not be found." }
    if (record.closedAt) return { ok: false, error: "This facility has already been settled." }
    if (record.closureRequest) {
      return { ok: false, error: "An early-closure request is already pending for this facility." }
    }

    const settlement = computeFundingSettlement(record, new Date())
    const closureRequest = {
      requestedAt: new Date().toISOString(),
      note: note?.trim() || undefined,
      quotedPayoff: settlement.total,
      quotedAsOf: settlement.closedAt,
      currency: settlement.currency,
    }

    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    const updated = await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: { ...prevRecord, closureRequest },
    })
    if (!updated) return { ok: false, error: "The request could not be submitted. Please try again." }

    try {
      const profile = session.profile
      await logActivity({
        action: `Requested early closure of project finance facility "${record.projectName}"`,
        category: "Project Funding",
        user: profile.fullName,
        details: {
          referenceId: record.id,
          facility: `${record.currency} ${record.facility.toLocaleString("en-US")}`,
          quotedPayoff: `${settlement.currency} ${settlement.total.toLocaleString("en-US")}`,
          note: closureRequest.note || "(none)",
          decision: "Closure requested",
        },
      })
    } catch (err) {
      console.log("[v0] closure request log failed:", (err as Error).message)
    }

    return { ok: true, quotedPayoff: settlement.total, currency: settlement.currency }
  } catch (err) {
    console.log("[v0] requestMyFundingClosure failed:", (err as Error).message)
    return { ok: false, error: "The request could not be submitted. Please try again." }
  }
}

/** The signed-in client withdraws a pending early-closure request. */
export async function cancelMyFundingClosureRequest(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This facility could not be found." }
    if (existing.userId !== session.id && existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "This facility could not be found." }
    }
    const record = readRecord(existing)
    if (!record) return { ok: false, error: "This facility could not be found." }
    if (record.closedAt) return { ok: false, error: "This facility has already been settled." }
    if (!record.closureRequest) return { ok: true }

    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    const updated = await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: { ...prevRecord, closureRequest: null },
    })
    if (!updated) return { ok: false, error: "The request could not be cancelled. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] cancelMyFundingClosureRequest failed:", (err as Error).message)
    return { ok: false, error: "The request could not be cancelled. Please try again." }
  }
}

// --- Admin: enriched facility list (with owner identity) --------------------

export interface AdminFundingFacility {
  approvalId: string
  status: "pending" | "approved" | "rejected"
  ownerUserId: string
  ownerName: string
  ownerEmail: string
  ownerCompany?: string
  record: ProjectFundingRequest
}

export type AdminFundingListResult =
  | { ok: true; facilities: AdminFundingFacility[] }
  | { ok: false; error: string }

/**
 * Administrator: every client's project finance facility, enriched with the
 * OWNER's identity (name + email) so a decision card shows exactly who a
 * facility belongs to — answering "who received this capital". Includes closure
 * lifecycle fields so the panel can surface pending closure requests and
 * settled facilities.
 */
export async function adminListProjectFinance(passcode: string): Promise<AdminFundingListResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  try {
    const requests = await listAllApprovals({ kind: "project_funding" })
    const profileCache = new Map<string, { fullName: string; email: string; company?: string }>()
    const facilities: AdminFundingFacility[] = []

    for (const req of requests) {
      const base = req.payload?.record as ProjectFundingRequest | undefined
      if (!base || typeof base !== "object") continue

      let profile = profileCache.get(req.userId)
      if (!profile) {
        try {
          const resolved = await resolveAccountProfileById(req.userId)
          profile = { fullName: resolved.fullName, email: resolved.email, company: resolved.company }
        } catch {
          profile = { fullName: "Unknown account", email: "" }
        }
        profileCache.set(req.userId, profile)
      }

      const status: AdminFundingFacility["status"] =
        req.status === "approved" ? "approved" : req.status === "rejected" ? "rejected" : "pending"

      facilities.push({
        approvalId: req.id,
        status,
        ownerUserId: req.userId,
        ownerName: profile.fullName,
        ownerEmail: profile.email,
        ownerCompany: profile.company,
        record: {
          ...base,
          approvalId: req.id,
          status,
          submittedAt: base.submittedAt ?? req.createdAt,
          decidedAt: req.decidedAt ?? base.decidedAt,
          decisionNote: req.decisionNote ?? base.decisionNote,
          ownerUserId: req.userId,
          ownerName: profile.fullName,
          ownerEmail: profile.email,
          ownerCompany: profile.company,
        },
      })
    }

    return { ok: true, facilities }
  } catch (err) {
    console.log("[v0] adminListProjectFinance failed:", (err as Error).message)
    return { ok: false, error: "Could not load project finance facilities. Please try again." }
  }
}

// --- Admin: execute closure (recall / terminate / liquidate) ----------------

export type AdminFundingClosureResult =
  | { ok: true; settlement: FundingSettlementSnapshot }
  | { ok: false; error: string }

/**
 * Administrator recalls / terminates / liquidates a facility (or approves a
 * client's early-closure request). Computes the payoff as of NOW, marks the
 * facility settled with an immutable snapshot, clears any pending request, and
 * debits the payoff legs from the OWNER's balance immediately (clawback — this
 * may push the balance negative, which is the intended recall behaviour).
 */
export async function adminExecuteFundingClosure(
  passcode: string,
  approvalId: string,
  opts?: { kind?: "admin_recall" | "client_early"; note?: string },
): Promise<AdminFundingClosureResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This facility could not be found." }
    if (existing.kind !== "project_funding") {
      return { ok: false, error: "Only project finance facilities can be closed here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an active, funded facility can be closed." }
    }
    const record = readRecord(existing)
    if (!record) return { ok: false, error: "This facility could not be found." }
    if (record.closedAt) return { ok: false, error: "This facility has already been settled." }

    const closedAt = new Date()
    const kind = opts?.kind === "client_early" ? "client_early" : "admin_recall"
    // Compute against the closure date so the snapshot and the deterministic
    // ledger legs (posted below) agree exactly.
    const closedRecord: ProjectFundingRequest = {
      ...record,
      closedAt: closedAt.toISOString(),
      closureKind: kind,
    }
    const settlement = computeFundingSettlement(closedRecord, closedAt)

    const note =
      opts?.note?.trim() ||
      (kind === "client_early"
        ? "Early closure approved by the Administrator at the client's request."
        : "Facility recalled and liquidated by the Administrator.")

    // 1) Persist closure on the facility record (settled state follows the
    //    client across devices; clears any pending closure request).
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    const updated = await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: {
        ...prevRecord,
        closedAt: closedRecord.closedAt,
        closureKind: kind,
        closureNote: note,
        settlement,
        closureRequest: null,
      },
    })
    if (!updated) return { ok: false, error: "The closure could not be saved. Please try again." }

    // 2) Post the settlement debit legs to the owner's balance immediately.
    //    Deterministic ids → idempotent with the client reconciler.
    const posts = buildFundingSettlementPosts(closedRecord)
    for (const post of posts) {
      const res = await addLedgerEntryForUserAdmin(passcode, existing.userId, {
        ...post.entry,
        direction: post.direction,
      })
      if (!res.ok) return { ok: false, error: res.error }
    }

    // 3) Notify the owner + audit trail.
    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: kind === "client_early" ? "Facility closed" : "Facility recalled",
        body: `Your project finance facility "${record.projectName}" has been settled. A payoff of ${settlement.currency} ${settlement.total.toLocaleString("en-US")} (principal, outstanding interest, and early-exit fee) was debited from your balance.`,
        href: FUNDING_HREF,
      })
    } catch (err) {
      console.log("[v0] closure notification failed:", (err as Error).message)
    }
    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator ${kind === "client_early" ? "approved early closure of" : "recalled"} project finance facility for ${target.fullName}`,
        category: "Project Funding",
        details: {
          referenceId: record.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          project: record.projectName,
          principal: `${settlement.currency} ${settlement.principal.toLocaleString("en-US")}`,
          interest: `${settlement.currency} ${settlement.interest.toLocaleString("en-US")}`,
          fee: `${settlement.currency} ${settlement.fee.toLocaleString("en-US")}`,
          totalPayoff: `${settlement.currency} ${settlement.total.toLocaleString("en-US")}`,
          decision: kind === "client_early" ? "Early closure approved" : "Recalled / liquidated",
        },
      })
    } catch (err) {
      console.log("[v0] closure activity log failed:", (err as Error).message)
    }

    return { ok: true, settlement }
  } catch (err) {
    console.log("[v0] adminExecuteFundingClosure failed:", (err as Error).message)
    return { ok: false, error: "The facility could not be closed. Please try again." }
  }
}

/** Administrator declines a client's pending early-closure request. */
export async function adminDeclineFundingClosure(
  passcode: string,
  approvalId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This facility could not be found." }
    const record = readRecord(existing)
    if (!record) return { ok: false, error: "This facility could not be found." }
    if (!record.closureRequest) return { ok: true }

    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown>) ?? {}
    const updated = await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: { ...prevRecord, closureRequest: null },
    })
    if (!updated) return { ok: false, error: "The request could not be updated. Please try again." }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "warning",
        title: "Early-closure request declined",
        body: `Your early-closure request for "${record.projectName}" was declined.${reason?.trim() ? ` Reason: ${reason.trim()}` : ""} The facility remains active.`,
        href: FUNDING_HREF,
      })
    } catch (err) {
      console.log("[v0] decline notification failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminDeclineFundingClosure failed:", (err as Error).message)
    return { ok: false, error: "The request could not be updated. Please try again." }
  }
}
