"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  resolveCurrentSession,
  resolveAccountProfileById,
  resolveDataOwnerIdFor,
  resolveEnvironmentMemberIds,
} from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import {
  upsertLedgerEntry,
  readLedgerEntries,
  availableByCurrency,
  deleteLedgerEntry,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
import { getAccountLimits } from "@/lib/account-limits-db"
import {
  limitCap,
  assessPaymentAgainstLimits,
  limitBlockMessage,
} from "@/lib/account-limits-eval"
import { planReservation, formatMoney, type ReservationPlan } from "@/lib/fund-reservation"
import { cardFeeFor, formatCardFee, CARD_FEE_CURRENCY } from "@/lib/card-fees"
import { buildTradingFundPosts, TRADING_FUND_MONTHLY_ROI, type TradingFundPauseWindow } from "@/lib/trading-fund"
import { buildPppRoiPosts } from "@/lib/ppp-yield"
import { buildInternalLoanPosts } from "@/lib/internal-loan"
import type { LedgerEntry } from "@/lib/ledger-store"
import { insertNotification } from "@/lib/notifications-db"
import {
  insertApproval,
  listApprovalsForUser,
  listApprovalsForUsers,
  listAllApprovals,
  listApprovalsForMaster,
  countPendingByKind,
  decideApproval,
  recordAdminDecision,
  recordMasterDecision,
  cancelApproval,
  revokeApprovedApproval,
  adminRevokeApprovedApproval,
  markApprovalTransferred,
  markApprovalDelivered,
  getApprovalById,
  updateApprovalPayload,
  updateApprovalTerms,
  deleteApproval,
  deleteApprovalForUser,
  type ApprovalRequest,
  type ApprovalStatus,
  type LedgerEffect,
} from "@/lib/approvals-db"
import { KIND_LABELS, KIND_HREF, type ApprovalKind } from "@/lib/approval-kinds"
import { parseQuantityString } from "@/lib/petroleum-products"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { getVessel as dbGetVessel } from "@/lib/spot-deals-db"
import { fetchVesselByImo, screenVesselImo } from "@/lib/vessel-providers"
import { isValidImo, VESSEL_TYPE_LABELS, type Vessel } from "@/lib/spot-deals-shared"
import {
  recordGatewayDepositForApproval,
  backfillGatewayDepositsForUser,
  reverseGatewayDepositForApproval,
  recordRegisteredAccountDepositForApproval,
  backfillRegisteredAccountDepositsForUser,
  reverseRegisteredAccountDepositForApproval,
} from "@/app/actions/reconciliation"
import { MASTER_CONSENT_KINDS, requiresMasterConsent } from "@/lib/account-hierarchy"

// The platform's base / master-account settlement currency. Every master
// balance check in the app (admin, payments, accounts) is denominated in EUR
// (`MASTER_ACCOUNT_CURRENCY = "EUR"`), so a ledger posting whose currency is
// missing MUST fall back to EUR — not USD. Defaulting to USD routed currency-
// less credits (e.g. leverage borrowed funds) into a phantom USD bucket that
// the EUR-based master account never reflects, which is why a leverage line
// appeared to credit USD instead of the master EUR balance.
const BASE_CURRENCY = "EUR"

// --- Auth helpers -----------------------------------------------------------

// Server-side admin gate: the caller must be an authorized admin ACCOUNT and
// present the correct PIN. Async because it resolves the session on the server.
async function adminOk(passcode: string): Promise<boolean> {
  return adminActionAuthorized(passcode)
}

// --- Client-facing ----------------------------------------------------------

export interface SubmitApprovalInput {
  kind: ApprovalKind
  title: string
  summary: string
  amount?: number | null
  currency?: string | null
  payload?: Record<string, unknown>
  /** Optional ledger effect applied to the owner's balance on approval. */
  ledgerEffect?: LedgerEffect | null
}

export type SubmitApprovalResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

/** Submit a new request for administrator decision (status = pending). */
export async function submitApproval(input: SubmitApprovalInput): Promise<SubmitApprovalResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  if (!input.kind || !KIND_LABELS[input.kind]) {
    return { ok: false, error: "Unknown request type." }
  }

  // Server-authoritative duplicate guard for monetizations. An instrument that
  // already has a LIVE (pending OR approved) monetization is pledged and cannot
  // be monetized again — otherwise the same bond can be advanced against twice
  // (the "two Authorized monetizations on one bond" bug). The client UI also
  // gates this, but a client-only check is bypassable by stale dialog state, a
  // second tab, or another device, so the authoritative check lives here where
  // every submission (mirrored via /api/approvals) must pass. A rejected or
  // reversed/cancelled monetization frees the instrument to be monetized again.
  if (input.kind === "monetization") {
    const instrumentId = (input.payload?.record as { instrumentId?: string } | undefined)?.instrumentId
    if (instrumentId) {
      try {
        const memberIds = await resolveEnvironmentMemberIds(session.id)
        const existingMonetizations = await listApprovalsForUsers(memberIds, "monetization")
        const clash = existingMonetizations.find((r) => {
          const rid = (r.payload?.record as { instrumentId?: string } | undefined)?.instrumentId
          return rid === instrumentId && (r.status === "pending" || r.status === "approved")
        })
        if (clash) {
          return {
            ok: false,
            error: `${instrumentId} already has ${
              clash.status === "approved" ? "an active" : "a pending"
            } monetization request. Reverse or reject it before monetizing this instrument again.`,
          }
        }
      } catch (err) {
        console.log("[v0] monetization duplicate guard check failed:", (err as Error).message)
      }
    }
  }

  // Trading-fund subscriptions RESERVE (block) their capital on the master
  // account the moment they are submitted (a pending `hold`). You cannot reserve
  // funds you do not have, so this gate refuses an application whose capital
  // exceeds the available balance — otherwise the reservation would drive the
  // balance negative (the "allocated tokens with no funds" bug). This is the
  // authoritative check: the client UI also blocks it, but a UI-only guard is
  // bypassable by stale state or another device, so it must live here where
  // every mirrored submission passes.
  if (input.kind === "trading_fund") {
    const capital = Number(input.amount)
    if (!Number.isFinite(capital) || capital <= 0) {
      return { ok: false, error: "The subscription amount is invalid." }
    }
    try {
      const ownerId = await resolveDataOwnerIdFor(session.id)
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const reqCurrency = input.currency || BASE_CURRENCY
      // Total spendable balance, every currency converted into the subscription
      // currency (mirrors the approval gate's capped cross-currency FX funding).
      const totalAvailable = Object.entries(available).reduce(
        (sum, [cur, amt]) => sum + convertCurrency(amt, cur, reqCurrency),
        0,
      )
      if (capital > totalAvailable + 0.01) {
        const fmt = (n: number) =>
          `${reqCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        return {
          ok: false,
          error: `Insufficient funds to allocate these tokens. This subscription reserves ${fmt(
            capital,
          )} but only ${fmt(
            Math.max(0, totalAvailable),
          )} is available on your master account. Fund the account before applying.`,
        }
      }
    } catch (err) {
      console.log("[v0] trading_fund solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your available balance could not be verified. Please try again." }
    }
  }

  // Requesting a new card carries a one-time issuance fee charged to the Master
  // Account (virtual €300 / physical €1,000). This gate REJECTS the request in
  // real time if the balance can't cover the fee, so no card and no charge are
  // created. Authoritative (a client-only check is bypassable). The actual debit
  // is posted after the approval row is inserted (see below).
  if (input.kind === "card") {
    const format = (input.payload?.card as { format?: string } | undefined)?.format
    const fee = cardFeeFor(format)
    try {
      const ownerId = await resolveDataOwnerIdFor(session.id)
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const availableEur = Object.entries(available).reduce(
        (sum, [cur, amt]) => sum + convertCurrency(amt, cur, CARD_FEE_CURRENCY),
        0,
      )
      if (fee > availableEur + 0.01) {
        return {
          ok: false,
          error: `Requesting a ${
            format === "virtual" ? "virtual" : "physical"
          } card carries a one-time ${formatCardFee(
            fee,
          )} issuance fee, but your Master Account has only ${formatCardFee(
            Math.max(0, availableEur),
          )} available. Please fund your account and try again.`,
        }
      }
    } catch (err) {
      console.log("[v0] card fee solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your available balance could not be verified. Please try again." }
    }
  }

  // Outgoing payments must respect the administrator-configured account limits
  // (Daily Limit + Monthly Volume). This is the AUTHORITATIVE hard block — the
  // Payments page also pre-checks for a friendly message, but a client-only
  // guard is bypassable (stale state, another device, a direct mirror call), so
  // enforcement must live here where every submission passes. The value counted
  // is the payment PRINCIPAL (what is sent to the beneficiary), converted into
  // the limit's currency; the 2% platform fee is not counted toward the cap.
  // Unlimited (or an unset 0) figure = no cap, so this never blocks by default.
  if (input.kind === "payment") {
    try {
      const limits = await getAccountLimits(session.id)
      const dailyCap = limitCap(limits.dailyLimitAmount, limits.dailyLimitUnlimited)
      const monthlyCap = limitCap(limits.monthlyVolumeAmount, limits.monthlyVolumeUnlimited)
      // Only do the (slightly costlier) window summation when a cap is actually set.
      if (dailyCap != null || monthlyCap != null) {
        const principalOf = (amount: number | null, payload?: Record<string, unknown>): number => {
          const rec = payload?.record as { amount?: number } | undefined
          if (typeof rec?.amount === "number" && Number.isFinite(rec.amount)) return rec.amount
          return Number(amount) || 0
        }
        const attempted = convertCurrency(
          principalOf(input.amount ?? null, input.payload),
          input.currency || BASE_CURRENCY,
          limits.currency,
        )
        const now = new Date()
        const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
        const prior = await listApprovalsForUser(session.id, "payment")
        let priorDaily = 0
        let priorMonthly = 0
        for (const r of prior) {
          // Rejected / cancelled payments never left the account, so they don't count.
          if (r.status === "rejected" || r.status === "cancelled") continue
          const t = Date.parse(r.createdAt)
          if (Number.isNaN(t)) continue
          const value = convertCurrency(
            principalOf(r.amount, r.payload),
            r.currency || BASE_CURRENCY,
            limits.currency,
          )
          if (t >= monthStart) priorMonthly += value
          if (t >= dayStart) priorDaily += value
        }
        const assessment = assessPaymentAgainstLimits({
          limits,
          priorDailyTotal: priorDaily,
          priorMonthlyTotal: priorMonthly,
          amount: attempted,
        })
        if (!assessment.ok) {
          return { ok: false, error: limitBlockMessage(assessment) }
        }
      }
    } catch (err) {
      // Fail OPEN on an unexpected error: the account limit is a policy control,
      // not the solvency guard (balance is separately enforced by
      // assertOwnerSolvent at approval), so a transient DB blip must not block
      // all payments. The failure is logged for investigation.
      console.log("[v0] payment limit guard failed:", (err as Error).message)
    }
  }

  // When an outgoing payment is remitted FROM a specific sub-account
  // compartment, the funds must come out of THAT compartment's isolated
  // balance — so it must hold enough to cover the full debit (principal + fee)
  // in the payment currency. `assertOwnerSolvent` only guards the aggregate
  // (main + all compartments), so a compartment-scoped check is required here
  // to stop one compartment overdrawing while another has funds. Absent a
  // sub-account tag this is skipped and the main-account behaviour is unchanged.
  if (input.kind === "payment" && input.ledgerEffect?.subAccountId && input.ledgerEffect.direction === "debit") {
    try {
      const subId = input.ledgerEffect.subAccountId
      const cur = input.ledgerEffect.currency || input.currency || BASE_CURRENCY
      const need = Number(input.ledgerEffect.amount) || 0
      const ownerId = await resolveDataOwnerIdFor(session.id)
      const rows = await readLedgerEntries(ownerId)
      // Net balance of just this compartment in the payment currency: settled
      // credits − settled debits − held debits tagged with this sub-account id.
      const available = rows.reduce((sum, e) => {
        if (e.currency !== cur || (e.subAccountId || undefined) !== subId) return sum
        if (e.status === "hold") return e.direction === "debit" ? sum - e.amount : sum
        return sum + (e.direction === "credit" ? e.amount : -e.amount)
      }, 0)
      if (need > available + 0.01) {
        return {
          ok: false,
          error: `Insufficient funds in the selected sub-account. This transfer needs ${cur} ${need.toLocaleString(
            "en-US",
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          )} but only ${cur} ${Math.max(0, available).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} is available in that compartment.`,
        }
      }
    } catch (err) {
      console.log("[v0] sub-account payment solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your sub-account balance could not be verified. Please try again." }
    }
  }

  // A Sub-account's outgoing payments must clear a second gate: their Master's
  // consent (in addition to administrator approval). Detected here from the
  // authoritative session, so no client can opt out of the Master gate. Joint
  // (J) accounts are deliberately NOT gated — they act with the Master's full
  // authority — which `requiresMasterConsent` encodes (sub only).
  const requiresMasterApproval =
    requiresMasterConsent(session.relationship) && !!session.masterId && MASTER_CONSENT_KINDS.has(input.kind)

  try {
    const request = await insertApproval({
      userId: session.id,
      kind: input.kind,
      title: input.title?.trim() || KIND_LABELS[input.kind],
      summary: input.summary?.trim() || "",
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      payload: input.payload ?? {},
      ledgerEffect: input.ledgerEffect ?? null,
      requiresMasterApproval,
      masterId: requiresMasterApproval ? session.masterId : null,
      initiatedById: requiresMasterApproval ? session.id : null,
      initiatedByName: requiresMasterApproval ? session.profile.fullName : null,
    })

    // Charge the one-time card issuance fee to the Master Account. The solvency
    // gate above already verified affordability; here we post the debit with a
    // DETERMINISTIC id (`CARD-FEE-<approvalId>`) so a retry can never double-
    // charge. If the debit fails we roll back the just-created request so the
    // client is never left with a card they weren't charged for.
    if (input.kind === "card") {
      const format = (input.payload?.card as { format?: string } | undefined)?.format ?? "physical"
      const fee = cardFeeFor(format)
      try {
        const ownerId = await resolveDataOwnerIdFor(session.id)
        await upsertLedgerEntry(ownerId, {
          id: `CARD-FEE-${request.id}`,
          direction: "debit",
          amount: fee,
          currency: CARD_FEE_CURRENCY,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: "MCC Capital — Card Issuance",
          bank: "MCC Capital",
          reference: request.id,
          comment: `One-time issuance fee for the requested ${format} card (${request.id}).`,
          category: "Card Issuance Fee",
        })
        try {
          await insertNotification({
            userId: ownerId,
            tone: "info",
            title: "Card issuance fee charged",
            body: `A one-time ${formatCardFee(fee)} fee was charged for your new ${format} card request (${request.id}), now pending approval.`,
            href: "/dashboard/cards",
          })
        } catch {
          // notification is non-critical
        }
      } catch (feeErr) {
        await deleteApprovalForUser(request.id, session.id).catch(() => {})
        console.log("[v0] card issuance fee charge failed:", (feeErr as Error).message)
        return { ok: false, error: "The card issuance fee could not be processed. Please try again." }
      }
    }

    // Let the Master know one of their Sub-accounts needs their consent.
    if (requiresMasterApproval && session.masterId) {
      try {
        await insertNotification({
          userId: session.masterId,
          tone: "warning",
          title: "Sub-account payment needs your approval",
          body: `${session.profile.fullName} requested an outgoing payment ("${
            input.title?.trim() || KIND_LABELS[input.kind]
          }") that requires your consent.`,
          href: "/dashboard/network",
        })
      } catch (err) {
        console.log("[v0] master consent notification failed:", (err as Error).message)
      }
    }

    // NOTE: We intentionally do NOT emit an activity-log email here. The
    // client flow that mirrors the submission (e.g. the Payments page) already
    // logs the activity with the correct signed-in user. Logging again here
    // produced a duplicate email — and, because this server context passes no
    // `user`, it fell back to a hardcoded demo name, misattributing the action
    // to the wrong client. The approvals backbone's role is DB persistence for
    // administrator review, not activity notification.

    return { ok: true, request }
  } catch (err) {
    console.log("[v0] submitApproval failed:", (err as Error).message)
    return { ok: false, error: "Your request could not be submitted. Please try again." }
  }
}

/** The signed-in user's own requests (optionally filtered by kind). */
export async function listMyApprovals(kind?: ApprovalKind): Promise<ApprovalRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    // A Joint account shares its Master's ENTIRE environment, so it sees the
    // whole environment's requests. For every other account this resolves to
    // just its own id, so the behaviour is unchanged.
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    return await listApprovalsForUsers(memberIds, kind)
  } catch (err) {
    console.log("[v0] listMyApprovals failed:", (err as Error).message)
    return []
  }
}

/** Cancel one of the user's own still-pending requests. */
export async function cancelMyApproval(id: string): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const cancelled = await cancelApproval(id, session.id)
    if (!cancelled) return { ok: false, error: "This request can no longer be cancelled." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] cancelMyApproval failed:", (err as Error).message)
    return { ok: false, error: "The request could not be cancelled. Please try again." }
  }
}

/**
 * Persist a client-owned change to the view-model stored under `payload.record`
 * of one of the signed-in user's OWN approvals. Used for post-approval state
 * that the client manages locally but that must follow them across devices —
 * e.g. a card's spending limit, block/unblock, or usage controls. Ownership is
 * enforced against the session, and only `payload.record` is merged so the
 * lifecycle / decision fields and admin-set values are never overwritten here.
 */
export async function updateMyApprovalRecord(
  approvalId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This record could not be found." }
    }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be edited." }
    }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    // A suspended (paused) or frozen (locked) commodity deal cannot take
    // workflow changes — stage advances, document uploads/versions — until it is
    // resumed/unfrozen via setMyCommodityDealHold. Enforced server-side so the
    // pause is authoritative, not just a disabled button.
    if (existing.kind === "commodity") {
      const holdState = (prevRecord.hold as { state?: string } | undefined)?.state
      if (holdState === "suspended") {
        return { ok: false, error: "This deal is suspended. Resume it before making changes." }
      }
      if (holdState === "frozen") {
        return { ok: false, error: "This deal is frozen. Unfreeze it before making changes." }
      }
    }
    const nextPayload = { ...prevPayload, record: { ...prevRecord, ...patch } }
    const updated = await updateApprovalPayload(approvalId, nextPayload)
    if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] updateMyApprovalRecord failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Administrator-scoped merge into the view-model stored under `payload.record`
 * of ANY user's approval. Used for admin-driven changes to a client's record
 * that must follow the client across devices — e.g. commodity document
 * verification/rejection and stage advances, or leverage ratio modifications and
 * switch-off settlement. Passcode-guarded; only `payload.record` is merged so
 * the DB lifecycle and decision fields are never overwritten here.
 */
export async function adminUpdateApprovalRecord(
  passcode: string,
  approvalId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This record could not be found." }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    const nextPayload = { ...prevPayload, record: { ...prevRecord, ...patch } }
    const updated = await updateApprovalPayload(approvalId, nextPayload)
    if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminUpdateApprovalRecord failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Revoke one of the signed-in client's APPROVED commodity deals before it has
 * been delivered, and REFUND the reserved funds. The DB guard refuses to revoke
 * a delivered deal, so once the administrator flags delivery the deal is locked.
 *
 * Refund semantics: only the reservation hold (`APPR-<id>`) is released, which
 * unfreezes the blocked money back into the client's available balance. Any FX
 * conversion executed to fund the deal (the settled `-fx-sell` / `-fx-buy`
 * legs) is intentionally LEFT IN PLACE — per policy the bought currency stays
 * available in that currency's account rather than being converted back.
 */
export async function revokeMyCommodityDeal(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be revoked here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be revoked." }
    }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be revoked." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be revoked." }
    }
    if (
      ((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen"
    ) {
      return { ok: false, error: "This deal is frozen. Unfreeze it before revoking to release the funds." }
    }

    const revoked = await revokeApprovedApproval(approvalId, session.id)
    if (!revoked) {
      return { ok: false, error: "This deal can no longer be revoked." }
    }

    // Release the reservation hold → unfreeze the blocked funds. The hold posts
    // to the shared-data owner (Master for a sub-account), mirroring how the
    // hold was created in applyLedgerEffect.
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${approvalId}`)
    } catch (err) {
      console.log("[v0] hold release failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal revoked",
        body: `Your commodity deal "${existing.title}" was revoked. The reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] revoke notification failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Client revoked commodity deal "${existing.title}" and released reserved funds`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Revoked",
        },
      })
    } catch (err) {
      console.log("[v0] revoke activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] revokeMyCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be revoked. Please try again." }
  }
}

/**
 * Request a RECALL of one of the signed-in client's already-approved (sent)
 * payments. A recall is a SWIFT-style return request: it must clear the same
 * administrator gate as a payment before any money moves. On approval the
 * reversal (a) refunds the sender the full debited amount and (b) reverses any
 * gateway/recipient credit the payment produced — see `adminDecideApproval`.
 *
 * Security: takes ONLY the original approval id, re-loads it server-side, and
 * verifies the caller owns it. Every monetary value is derived from the stored,
 * already-approved record — never from client input.
 */
export async function requestPaymentRecall(
  originalApprovalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const original = await getApprovalById(originalApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This payment could not be found." }
    }
    if (original.kind !== "payment") {
      return { ok: false, error: "Only outgoing payments can be recalled." }
    }
    if (original.status !== "approved") {
      return { ok: false, error: "Only an approved (sent) payment can be recalled." }
    }

    const payload = (original.payload ?? {}) as {
      iban?: string
      recalled?: boolean
      recallStatus?: string
      record?: Record<string, unknown>
    }
    if (payload.recalled === true || payload.recallStatus === "pending" || payload.recallStatus === "recalled") {
      return { ok: false, error: "A recall for this payment has already been requested." }
    }

    const record = (payload.record ?? {}) as {
      beneficiary?: string
      iban?: string
      reference?: string
      total?: number
      uetr?: string
    }
    // The sender was debited the TOTAL (amount + 2% platform fee); a full recall
    // makes them whole by refunding exactly that.
    const refundAmount = Number(original.amount ?? record.total ?? 0)
    const refundCurrency = original.currency ?? "EUR"
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return { ok: false, error: "This payment's amount could not be determined." }
    }

    const beneficiary = record.beneficiary ?? original.title
    const reference = record.reference || record.uetr || originalApprovalId

    const recall = await insertApproval({
      userId: session.id,
      kind: "payment_recall",
      title: `Recall — Payment to ${beneficiary}`,
      summary: `Request to recall ${refundCurrency} ${refundAmount.toLocaleString("en-US")} sent to ${beneficiary}${reference ? ` · ${reference}` : ""}`,
      amount: refundAmount,
      currency: refundCurrency,
      payload: {
        originalApprovalId,
        originalLocalId: (record as { id?: string }).id ?? null,
        beneficiary,
        iban: payload.iban ?? record.iban ?? null,
        reference,
      },
      // On approval this credit refunds the sender's data-owner ledger.
      ledgerEffect: {
        direction: "credit",
        amount: refundAmount,
        currency: refundCurrency,
        status: "completed",
        counterparty: beneficiary,
        reference,
        category: "Payment Recall — Refund",
      },
    })

    // Stamp the original so the matcher stops re-funding it and the client list
    // can surface a "recall requested" state (recordFromApproval spreads
    // payload.record into the view model).
    try {
      const newPayload = {
        ...payload,
        recallStatus: "pending",
        recallApprovalId: recall.id,
        record: { ...(payload.record ?? {}), recallStatus: "pending" },
      }
      await updateApprovalPayload(originalApprovalId, newPayload)
    } catch (err) {
      console.log("[v0] recall stamp failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Requested recall of payment ${originalApprovalId} (${refundCurrency} ${refundAmount.toLocaleString("en-US")} to ${beneficiary})`,
        category: "Payments",
        user: profile.fullName,
        details: {
          summary: `Client requested a recall of approved payment ${originalApprovalId} to ${beneficiary} for ${refundCurrency} ${refundAmount.toLocaleString("en-US")}. The recall is pending Administrator approval; on approval the funds are refunded to the sender and any recipient credit is reversed. Reference: ${reference}.`,
          referenceId: recall.id,
          originalPaymentId: originalApprovalId,
          amount: `${refundCurrency} ${refundAmount.toLocaleString("en-US")}`,
          decision: "Recall requested",
        },
      })
    } catch (err) {
      console.log("[v0] recall activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] requestPaymentRecall failed:", (err as Error).message)
    return { ok: false, error: "The recall could not be submitted. Please try again." }
  }
}

// --- Commodity deal negotiation / amendment --------------------------------

/** The negotiable subset of a deal's terms, proposed by the client. */
export interface ProposedDealTerms {
  /**
   * The total deal value the client computed (unit price × quantity). This is
   * advisory only — when `unitPrice` is supplied the server recomputes the
   * authoritative total itself so a stale/buggy client can never persist a raw
   * per-unit price as the deal's total value.
   */
  approxValue: number
  quantity: string
  tradeStructure: string
  /** The renegotiated PER-UNIT price (per MT/BBL) — the figure traders edit. */
  unitPrice?: number
}

/**
 * Request an AMENDMENT to one of the signed-in client's approved commodity
 * deals. Renegotiating price/quantity/incoterms changes the reserved hold, so
 * the change must clear the same administrator gate as the original deal: this
 * files a `commodity_amendment` approval and stamps the original deal with a
 * `pendingAmendment` (the diff). The deal's terms are NOT changed until the
 * admin approves the amendment (see adminDecideApproval).
 *
 * Security: takes only the deal's approval id, reloads it server-side, and
 * verifies ownership; the "previous" terms are read from the stored record, not
 * from the client.
 */
export async function requestDealAmendment(
  dealApprovalId: string,
  proposed: ProposedDealTerms,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const original = await getApprovalById(dealApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (original.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be amended." }
    }
    if ((original.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be amended." }
    }
    if (original.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be amended." }
    }

    const payload = (original.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
    if (payload.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be amended." }
    }
    const record = (payload.record ?? {}) as Record<string, unknown>
    if ((record.pendingAmendment as { status?: string } | undefined)?.status === "pending") {
      return { ok: false, error: "An amendment is already pending approval for this deal." }
    }
    const holdState = (record.hold as { state?: string } | undefined)?.state
    if (holdState === "suspended") {
      return { ok: false, error: "This deal is suspended. Resume it before proposing an amendment." }
    }
    if (holdState === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before proposing an amendment." }
    }

    // The total deal value is ALWAYS unit price × quantity. When the client
    // supplies the renegotiated per-unit price (the figure traders actually
    // edit), the server recomputes the authoritative total from it and the
    // proposed quantity — never trusting the client's `approxValue`, which a
    // stale/buggy bundle could send as the raw per-unit price (the historical
    // "USD 138M → USD 685" corruption). When no unit price is given (legacy
    // clients) we fall back to the client total.
    const proposedUnitPrice = Number(proposed.unitPrice)
    const proposedQty = parseQuantityString(proposed.quantity)
    let newValue: number
    let unitPrice: number | null = null
    if (Number.isFinite(proposedUnitPrice) && proposedUnitPrice > 0 && proposedQty) {
      unitPrice = Math.round(proposedUnitPrice * 100) / 100
      newValue = Math.round(proposedUnitPrice * proposedQty.amount * 100) / 100
    } else {
      newValue = Math.round(Number(proposed.approxValue) * 100) / 100
    }
    if (!Number.isFinite(newValue) || newValue <= 0) {
      return { ok: false, error: "Enter a valid amended value." }
    }
    if (!reason?.trim()) {
      return { ok: false, error: "A reason for the amendment is required." }
    }

    const currency = original.currency ?? (record.currency as string) ?? "USD"
    const prevValue = Number(original.amount ?? (record.approxValue as number) ?? 0)
    const prevQty = parseQuantityString((record.quantity as string) ?? "")
    const previous = {
      approxValue: prevValue,
      quantity: (record.quantity as string) ?? "",
      tradeStructure: (record.tradeStructure as string) ?? "FOB",
      unitPrice:
        prevQty && prevValue > 0 ? Math.round((prevValue / prevQty.amount) * 100) / 100 : undefined,
    }
    const amendmentId = `AMD-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
    const commodity = (record.commodity as string) ?? original.title

    // File the amendment approval. It carries NO ledger effect of its own — the
    // reserved hold is adjusted in place on the ORIGINAL deal at approval time.
    const amendment = await insertApproval({
      userId: session.id,
      kind: "commodity_amendment",
      title: `Amendment — ${commodity}`,
      summary: `Amend ${commodity}: ${previous.quantity} → ${proposed.quantity}, ${currency} ${previous.approxValue.toLocaleString("en-US")} → ${currency} ${newValue.toLocaleString("en-US")} (${previous.tradeStructure} → ${proposed.tradeStructure})`,
      amount: newValue,
      currency,
      payload: {
        dealApprovalId,
        dealLocalId: (record.id as string) ?? null,
        commodity,
        reason: reason.trim(),
        previous,
        proposed: {
          approxValue: newValue,
          quantity: proposed.quantity,
          tradeStructure: proposed.tradeStructure,
          unitPrice: unitPrice ?? undefined,
        },
      },
      ledgerEffect: null,
    })

    // Stamp the deal record with the pending amendment so the client/admin see
    // the diff immediately (the deal view-model lives under payload.record).
    const pendingAmendment = {
      id: amendmentId,
      approvalId: amendment.id,
      status: "pending" as const,
      reason: reason.trim(),
      previous,
      proposed: {
        approxValue: newValue,
        quantity: proposed.quantity,
        tradeStructure: proposed.tradeStructure,
        unitPrice: unitPrice ?? undefined,
      },
      requestedAt: new Date().toISOString(),
    }
    try {
      await updateApprovalPayload(dealApprovalId, {
        ...payload,
        record: { ...record, pendingAmendment },
      })
    } catch (err) {
      console.log("[v0] amendment stamp failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Requested amendment of deal ${dealApprovalId} (${commodity})`,
        category: "Commodity Desk",
        user: profile.fullName,
        details: {
          referenceId: amendment.id,
          dealId: dealApprovalId,
          summary: `Client requested to renegotiate deal ${commodity}: value ${currency} ${previous.approxValue.toLocaleString("en-US")} → ${currency} ${newValue.toLocaleString("en-US")}, quantity ${previous.quantity} → ${proposed.quantity}, terms ${previous.tradeStructure} → ${proposed.tradeStructure}. Pending Administrator approval before the reserved funds adjust. Reason: ${reason.trim()}.`,
          decision: "Amendment requested",
        },
      })
    } catch (err) {
      console.log("[v0] amendment activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] requestDealAmendment failed:", (err as Error).message)
    return { ok: false, error: "The amendment could not be submitted. Please try again." }
  }
}

/**
 * Append a note to a deal's negotiation log (and optionally update the recorded
 * counterparty position). Authored server-side from the authoritative session,
 * so attribution cannot be spoofed by the client.
 */
export async function addDealNegotiationNote(
  dealApprovalId: string,
  message: string,
  counterpartyPosition?: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (!message?.trim() && !counterpartyPosition?.trim()) {
    return { ok: false, error: "Enter a note or a counterparty position." }
  }
  try {
    const original = await getApprovalById(dealApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (original.kind !== "commodity") {
      return { ok: false, error: "Notes can only be added to commodity deals." }
    }
    if ((original.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be annotated." }
    }

    const payload = (original.payload ?? {}) as { record?: Record<string, unknown> }
    const record = (payload.record ?? {}) as Record<string, unknown>
    const profile = await resolveAccountProfileById(session.id)
    const existingNotes = Array.isArray(record.negotiationNotes)
      ? (record.negotiationNotes as Record<string, unknown>[])
      : []

    const nextNotes = message?.trim()
      ? [
          ...existingNotes,
          {
            id: `NOTE-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
            author: profile.fullName,
            authorRole: "client" as const,
            message: message.trim(),
            createdAt: new Date().toISOString(),
          },
        ]
      : existingNotes

    await updateApprovalPayload(dealApprovalId, {
      ...payload,
      record: {
        ...record,
        negotiationNotes: nextNotes,
        ...(counterpartyPosition?.trim() ? { counterpartyPosition: counterpartyPosition.trim() } : {}),
      },
    })

    return { ok: true }
  } catch (err) {
    console.log("[v0] addDealNegotiationNote failed:", (err as Error).message)
    return { ok: false, error: "The note could not be saved. Please try again." }
  }
}

// --- Deal management tools (delete / hold / edit) ---------------------------

/** A reversible pause/lock placed on a commodity deal by the client or admin. */
export type DealHoldState = "suspended" | "frozen"

/** The subset of a commodity deal's terms editable via the direct edit tool. */
export interface EditableDealTerms {
  title?: string
  commodity?: string
  quantity?: string
  unitPrice?: number
  approxValue?: number
  tradeStructure?: string
  originCountry?: string
  destinationCountry?: string
  buyerName?: string
  sellerName?: string
  sendingBank?: string
  sendingBankBic?: string
  receivingBank?: string
  receivingBankBic?: string
  instrumentType?: string
  notes?: string
}

/**
 * Recompute the authoritative total deal value from a terms patch. The total is
 * ALWAYS unit price × quantity when a unit price is supplied (the figure traders
 * edit), so a stale client can never persist a raw per-unit price as the total.
 * Falls back to the supplied `approxValue`, then the existing value.
 */
function resolveEditedValue(
  patch: EditableDealTerms,
  existingValue: number,
): { value: number; unitPrice: number | null } {
  const unitPrice = Number(patch.unitPrice)
  const qty = parseQuantityString(patch.quantity ?? "")
  if (Number.isFinite(unitPrice) && unitPrice > 0 && qty) {
    return {
      value: Math.round(unitPrice * qty.amount * 100) / 100,
      unitPrice: Math.round(unitPrice * 100) / 100,
    }
  }
  const approx = Number(patch.approxValue)
  if (Number.isFinite(approx) && approx > 0) return { value: Math.round(approx * 100) / 100, unitPrice: null }
  return { value: existingValue, unitPrice: null }
}

/** Build the sanitized record patch (only defined string/number fields). */
function buildTermsRecordPatch(patch: EditableDealTerms, value: number): Record<string, unknown> {
  const out: Record<string, unknown> = { approxValue: value }
  const strFields: (keyof EditableDealTerms)[] = [
    "title",
    "commodity",
    "quantity",
    "tradeStructure",
    "originCountry",
    "destinationCountry",
    "buyerName",
    "sellerName",
    "sendingBank",
    "sendingBankBic",
    "receivingBank",
    "receivingBankBic",
    "instrumentType",
    "notes",
  ]
  for (const f of strFields) {
    const v = patch[f]
    if (typeof v === "string") out[f] = v.trim()
  }
  return out
}

/**
 * Core applier for a direct terms edit. Recomputes the authoritative value,
 * updates the stored record + the approval's amount/currency, and keeps the
 * on-approval reservation effect in sync so a pending deal reserves the amended
 * value when it is later approved. Only ever applied to non-approved,
 * non-delivered, non-frozen deals (approved deals must go through amendment).
 */
async function applyDealTermsEdit(
  existing: ApprovalRequest,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  const payload = (existing.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
  if (payload.delivered === true) {
    return { ok: false, error: "This deal has been delivered and can no longer be edited." }
  }
  const record = (payload.record ?? {}) as Record<string, unknown>
  if ((record.hold as { state?: string } | undefined)?.state === "frozen") {
    return { ok: false, error: "This deal is frozen. Unfreeze it before editing its terms." }
  }
  if (existing.status === "approved") {
    return {
      ok: false,
      error: "Approved deals hold reserved funds — change them via an amendment for administrator sign-off.",
    }
  }
  if (existing.status !== "pending" && existing.status !== "rejected" && existing.status !== "cancelled") {
    return { ok: false, error: "This deal can no longer be edited." }
  }

  const existingValue = Number(existing.amount ?? (record.approxValue as number) ?? 0)
  const { value } = resolveEditedValue(patch, existingValue)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Enter a valid deal value." }
  }
  const currency = existing.currency ?? (record.currency as string) ?? "USD"
  const recordPatch = buildTermsRecordPatch(patch, value)
  const nextRecord = { ...record, ...recordPatch }

  // Keep the on-approval reservation hold in step with the amended value so the
  // correct amount is blocked when a pending deal is approved.
  const prevEffect = existing.ledgerEffect
  const nextEffect: LedgerEffect | null =
    prevEffect != null
      ? {
          ...prevEffect,
          amount: value,
          currency,
          counterparty: (recordPatch.sellerName as string) || prevEffect.counterparty,
        }
      : value > 0
        ? {
            direction: "debit",
            amount: value,
            currency,
            status: "hold",
            counterparty: (nextRecord.sellerName as string) || "Commodity supplier",
            reference: (nextRecord.uetr as string) || (nextRecord.id as string) || existing.id,
            category: "Commodity Trade — Reserved Funds",
          }
        : null

  const updated = await updateApprovalTerms(existing.id, {
    amount: value,
    currency,
    ledgerEffect: nextEffect,
    payload: { ...payload, record: nextRecord },
  })
  if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
  return { ok: true }
}

/**
 * Apply / lift a suspend or freeze hold on a commodity deal, stamped onto the
 * stored record so it is authoritative and visible cross-client. `hold=null`
 * clears the hold. `by` records who placed it for the audit trail.
 */
async function applyDealHold(
  existing: ApprovalRequest,
  hold: DealHoldState | null,
  by: "client" | "admin",
  byName: string,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const payload = (existing.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
  if (payload.delivered === true) {
    return { ok: false, error: "This deal has been delivered and is finalized — it cannot be held." }
  }
  const record = (payload.record ?? {}) as Record<string, unknown>
  const nextRecord = {
    ...record,
    hold: hold
      ? { state: hold, by, byName, note: note?.trim() || undefined, at: new Date().toISOString() }
      : null,
  }
  const updated = await updateApprovalPayload(existing.id, { ...payload, record: nextRecord })
  if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
  return { ok: true }
}

/**
 * Release any reserved-funds hold for a deal, back to the owner's available
 * balance. Safe no-op when there is no hold (e.g. a pending / rejected deal).
 */
async function releaseDealHoldFunds(existing: ApprovalRequest): Promise<void> {
  try {
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    await deleteLedgerEntry(ownerId, `APPR-${existing.id}`)
  } catch (err) {
    console.log("[v0] deal fund release failed:", (err as Error).message)
  }
}

/** Client: suspend / freeze / resume one of their OWN commodity deals. */
export async function setMyCommodityDealHold(
  approvalId: string,
  hold: DealHoldState | null,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals support this action." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only." }
    }
    const profile = await resolveAccountProfileById(session.id)
    const res = await applyDealHold(existing, hold, "client", profile.fullName, note)
    if (res.ok) {
      void logActivity({
        action: hold
          ? `Client ${hold === "frozen" ? "froze" : "suspended"} commodity deal ${approvalId}`
          : `Client resumed commodity deal ${approvalId}`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.title, decision: hold ?? "Resumed" },
      }).catch(() => {})
    }
    return res
  } catch (err) {
    console.log("[v0] setMyCommodityDealHold failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Admin: suspend / freeze / resume ANY client's commodity deal (passcode-gated). */
export async function adminSetCommodityDealHold(
  passcode: string,
  approvalId: string,
  hold: DealHoldState | null,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals support this action." }
    return await applyDealHold(existing, hold, "admin", "Administrator", note)
  } catch (err) {
    console.log("[v0] adminSetCommodityDealHold failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Client: edit the terms of one of their OWN non-approved commodity deals. */
export async function editMyCommodityDealTerms(
  approvalId: string,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be edited here." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be edited." }
    }
    const res = await applyDealTermsEdit(existing, patch)
    if (res.ok) {
      const profile = await resolveAccountProfileById(session.id)
      void logActivity({
        action: `Client edited commodity deal ${approvalId} terms`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.title, decision: "Edited" },
      }).catch(() => {})
    }
    return res
  } catch (err) {
    console.log("[v0] editMyCommodityDealTerms failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Admin: edit the terms of ANY client's non-approved commodity deal (passcode-gated). */
export async function adminEditCommodityDealTerms(
  passcode: string,
  approvalId: string,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be edited here." }
    return await applyDealTermsEdit(existing, patch)
  } catch (err) {
    console.log("[v0] adminEditCommodityDealTerms failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Client: permanently DELETE one of their OWN commodity deals, releasing any
 * reserved funds back to the available balance first. A frozen deal must be
 * unfrozen before it can be deleted.
 */
export async function deleteMyCommodityDeal(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be deleted here." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be deleted." }
    }
    if (((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before deleting." }
    }
    await releaseDealHoldFunds(existing)
    const deleted = await deleteApprovalForUser(approvalId, session.id)
    if (!deleted) return { ok: false, error: "This deal could not be deleted." }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Client deleted commodity deal "${existing.title}" and released any reserved funds`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.summary || existing.title, decision: "Deleted" },
      })
    } catch (err) {
      console.log("[v0] delete activity log failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] deleteMyCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be deleted. Please try again." }
  }
}

/**
 * Client: permanently DELETE one of their OWN bank instruments from their
 * portfolio. Ownership and kind are enforced here; the calling UI additionally
 * gates the option on the instrument not being pledged to a leverage line or
 * referenced by a monetization request (i.e. "not in use by the account"). The
 * acquisition fee is a settled, non-refundable debit and is intentionally NOT
 * refunded on deletion.
 */
export async function deleteMyInstrument(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This instrument could not be found." }
    }
    if (existing.kind !== "instrument") {
      return { ok: false, error: "Only bank instruments can be deleted here." }
    }
    const deleted = await deleteApprovalForUser(approvalId, session.id)
    if (!deleted) return { ok: false, error: "This instrument could not be deleted." }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Client removed bank instrument "${existing.title}" from their portfolio`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: existing.summary || existing.title,
          decision: "Deleted",
        },
      })
    } catch (err) {
      console.log("[v0] instrument delete activity log failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] deleteMyInstrument failed:", (err as Error).message)
    return { ok: false, error: "The instrument could not be deleted. Please try again." }
  }
}

/**
 * Admin: permanently DELETE ANY client's commodity deal (passcode-gated),
 * releasing any reserved funds back to the owner's available balance first. A
 * frozen deal must be unfrozen before deletion.
 */
export async function adminDeleteCommodityDeal(
  passcode: string,
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be deleted here." }
    if (((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before deleting." }
    }
    await releaseDealHoldFunds(existing)
    const deleted = await deleteApproval(approvalId)
    if (!deleted) return { ok: false, error: "This deal could not be deleted." }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal removed",
        body: `Your commodity deal "${existing.title}" was removed by the administrator. Any reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] admin delete notification failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminDeleteCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be deleted. Please try again." }
  }
}

// --- Admin (cross-client) ---------------------------------------------------

export type AdminApprovalsResult =
  | { ok: true; requests: ApprovalRequest[] }
  | { ok: false; error: string }

export async function adminListApprovals(
  passcode: string,
  filters?: { status?: ApprovalStatus; kind?: ApprovalKind; userId?: string },
): Promise<AdminApprovalsResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const requests = await listAllApprovals(filters)
    return { ok: true, requests }
  } catch (err) {
    console.log("[v0] adminListApprovals failed:", (err as Error).message)
    return { ok: false, error: "Could not load requests. Please try again." }
  }
}

export async function adminCountPending(passcode: string): Promise<Record<string, number>> {
  if (!(await adminOk(passcode))) return {}
  try {
    return await countPendingByKind()
  } catch (err) {
    console.log("[v0] adminCountPending failed:", (err as Error).message)
    return {}
  }
}

// Approval kinds that, when approved, CREDIT the owner's balance. These are
// surfaced as available funds (e.g. monetization proceeds, downloaded funds,
// project funding draws). Used as a fallback when an approval was created
// before an explicit `ledgerEffect` was attached, so the amount/currency stored
// on the approval itself still posts to the client's ledger on approval.
// NOTE: `project_funding` is intentionally NOT here. An approved AES facility's
// capital credit — and its ongoing 1.8% monthly cost-of-capital debits — are
// posted onto the client's ledger by the client-side FundingCapitalReconciler
// using deterministic `FND-CAP-*` / `FND-ROI-*` ids. Crediting it here too
// (as `APPR-<id>`) would DOUBLE the facility on the client's balance.
const CREDIT_KINDS = new Set<ApprovalKind>(["monetization", "dof"])

// Approval kinds that, when approved, RESERVE (place a hold/block on) the
// owner's balance — funds earmarked to settle the underlying transaction (e.g.
// a commodity purchase reserving the contract value to pay the supplier). Used
// as a fallback so the amount/currency stored on the approval still places a
// hold on approval even when no explicit `ledgerEffect` was attached (e.g. a
// deal registered before ledger effects were wired in).
const HOLD_KINDS = new Set<ApprovalKind>(["commodity"])

/**
 * Resolve the ledger entry an approved request should post (or null if none).
 * Prefers an explicit `ledgerEffect`; otherwise falls back to the approval's
 * own amount/currency for known crediting kinds. Idempotent id (`APPR-<id>`)
 * means re-applying never double-posts.
 */
function ledgerEntryForApproval(req: ApprovalRequest): LedgerEntry | null {
  // A read-only SHARED copy (an admin showed this deal to another client for
  // visibility only) must NEVER touch the recipient's balance — no hold, no
  // credit, no settlement — on approval, reconcile or backfill. Returning null
  // here is the single chokepoint that guarantees zero financial effect.
  if ((req.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
    return null
  }
  // A delivered commodity deal has been PAID OUT to the supplier: its reservation
  // must settle (a permanent `completed` debit), never remain a `hold`. Because
  // this builder also runs on every reconcile/backfill, leaving it as a hold here
  // would re-block delivered funds after delivery already settled them — exactly
  // the bug where "reserved" reappears for a delivered deal.
  const isDelivered = (req.payload as { delivered?: boolean } | undefined)?.delivered === true

  const fx = req.ledgerEffect
  if (fx) {
    const amount = Number(fx.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    const baseStatus = fx.status ?? "completed"
    // A held (reserved) effect that has been delivered is now settled.
    const settledByDelivery = baseStatus === "hold" && isDelivered
    return {
      id: `APPR-${req.id}`,
      direction: fx.direction,
      amount,
      currency: fx.currency || req.currency || BASE_CURRENCY,
      status: settledByDelivery ? "completed" : baseStatus,
      date: new Date().toISOString(),
      counterparty: fx.counterparty ?? req.title,
      account: fx.account,
      bank: fx.bank,
      reference: fx.reference ?? req.id,
      comment: settledByDelivery
        ? `Delivered & settled — funds paid out for ${KIND_LABELS[req.kind]} "${req.title}"`
        : `Approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: settledByDelivery
        ? "Commodity Trade — Settled (Delivered)"
        : (fx.category ?? KIND_LABELS[req.kind]),
      // Tag the debit/credit to a sub-account compartment when the client
      // remitted the payment FROM one, so it moves only that isolated balance.
      subAccountId: fx.subAccountId || undefined,
    }
  }
  // Fallback: credit the stored amount for known crediting kinds (e.g. a
  // monetization approved before ledger effects were attached).
  if (CREDIT_KINDS.has(req.kind)) {
    const amount = Number(req.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "credit",
      amount,
      currency: req.currency || BASE_CURRENCY,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: req.title,
      reference: req.id,
      comment: `Approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: KIND_LABELS[req.kind],
    }
  }
  // Leverage: on approval the BORROWED funds (equity × (ratio − 1)) are credited
  // to the client's balance, multiplying their buying power. The amount stored
  // on the approval itself is the *equity*, not the borrowed sum, so we read the
  // borrowed amount (and currency) from the full record in `payload.record`.
  //
  // We credit the INITIAL borrowed amount — i.e. the value at activation. If an
  // admin later modifies the ratio, that delta is settled by its own balancing
  // ledger entry (`adjustmentEntryId`), so this base credit must NOT track the
  // current borrowed amount or the idempotent reconcile would double-count the
  // modification. The initial value is recoverable from the first modification's
  // `fromBorrowed`, mirroring the interest-accrual logic.
  if (req.kind === "leverage") {
    const record = (req.payload?.record ?? {}) as {
      borrowedAmount?: number
      currency?: string
      modifications?: { fromBorrowed?: number }[]
      accountLabel?: string
      status?: string
    }
    // A switched-off / closed line has had its borrowed principal repaid, so it
    // must no longer credit the balance (and reconcile must not re-credit it).
    if (record.status === "closed") return null
    const mods = record.modifications
    const initialBorrowed =
      Array.isArray(mods) && mods.length > 0 && Number.isFinite(Number(mods[0]?.fromBorrowed))
        ? Number(mods[0].fromBorrowed)
        : Number(record.borrowedAmount)
    if (!Number.isFinite(initialBorrowed) || initialBorrowed <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "credit",
      amount: initialBorrowed,
      currency: record.currency || req.currency || BASE_CURRENCY,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: record.accountLabel || req.title,
      reference: req.id,
      comment: `Borrowed funds credited — approved ${KIND_LABELS[req.kind]} (${req.title})`,
      category: "Leverage — Borrowed Funds",
    }
  }
  // Fallback: reserve (hold) the stored amount for known reserving kinds (e.g. a
  // commodity deal approved before ledger effects were attached) so the funds
  // are blocked on the client's balance to settle the supplier.
  if (HOLD_KINDS.has(req.kind)) {
    const amount = Number(req.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "debit",
      amount,
      currency: req.currency || BASE_CURRENCY,
      // Delivered → settled (paid out, leaves the balance); otherwise → hold
      // (reserved/blocked). This keeps the backfill consistent with delivery.
      status: isDelivered ? "completed" : "hold",
      date: new Date().toISOString(),
      counterparty: req.title,
      reference: req.id,
      comment: isDelivered
        ? `Delivered & settled — funds paid out for ${KIND_LABELS[req.kind]} "${req.title}"`
        : `Reserved for approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: isDelivered
        ? "Commodity Trade — Settled (Delivered)"
        : "Commodity Trade — Reserved Funds",
    }
  }
  return null
}

/** Thrown when an approval's reservation cannot be covered by available funds. */
class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InsufficientFundsError"
  }
}

/**
 * Available balance per currency, EXCLUDING this approval's own prior ledger
 * postings (`APPR-<id>*`). This gives reservation planning a stable baseline so
 * re-runs (idempotent backfill / reconcile / amendment) never see the hold they
 * themselves placed as a reason to re-fund or to fail a feasibility check.
 */
function availableExcludingApproval(entries: LedgerEntry[], reqId: string): Record<string, number> {
  const prefix = `APPR-${reqId}`
  return availableByCurrency(entries.filter((e) => !e.id.startsWith(prefix)))
}

export interface ReservationAssessment {
  /** True when this approval reserves funds (posts a debit hold). */
  required: boolean
  /** True when the full reservation can be covered with no negative balance. */
  feasible: boolean
  plan: ReservationPlan | null
  ownerId: string
  /** Client/admin-facing explanation when not feasible. */
  message: string
}

/**
 * Real-time fund-availability check for a (possibly) reserving approval, run
 * BEFORE the decision is committed. Resolves the balance owner (the Master for a
 * Sub-account), computes the prospective hold, and asks the planner whether it
 * can be funded — directly or via capped cross-currency FX. Non-reserving
 * approvals (credits, no ledger effect) are always "feasible".
 */
async function assessReservation(req: ApprovalRequest): Promise<ReservationAssessment> {
  const entry = ledgerEntryForApproval(req)
  const ownerId = await resolveDataOwnerIdFor(req.userId)
  // A "hold" debit always reserves; a `gate:true` effect is a SETTLED debit
  // (e.g. an instrument acquisition fee) that must still be pre-checked for
  // affordability and funded via FX before it posts, so it is assessed too.
  const gated = entry?.direction === "debit" && (entry.status === "hold" || req.ledgerEffect?.gate === true)
  if (!entry || !gated) {
    return { required: false, feasible: true, plan: null, ownerId, message: "" }
  }
  const existing = await readLedgerEntries(ownerId)
  const available = availableExcludingApproval(existing, req.id)
  const plan = planReservation(available, entry.currency, entry.amount)
  const message = plan.feasible
    ? ""
    : `Insufficient available funds to reserve ${formatMoney(entry.amount, entry.currency)} for this ` +
      `${KIND_LABELS[req.kind].toLowerCase()}. Total spendable balance is ` +
      `${formatMoney(plan.totalAvailableInNeedCurrency, entry.currency)} (short by ` +
      `${formatMoney(entry.amount - plan.totalAvailableInNeedCurrency, entry.currency)}).`
  return { required: true, feasible: plan.feasible, plan, ownerId, message }
}

/**
 * Apply the financial effect (if any) of an approved request to the SHARED-data
 * owner's ledger. For a Sub-account the balance lives under its Master, so the
 * debit/credit must post to the Master's id — not the sub's own (empty) ledger.
 * Idempotent on the entry id so re-running never double-posts.
 */
async function applyLedgerEffect(req: ApprovalRequest): Promise<void> {
  const entry = ledgerEntryForApproval(req)
  if (!entry) return
  const ownerId = await resolveDataOwnerIdFor(req.userId)

  // Reservation (debit hold) with cross-currency funding: a deal is priced in
  // the deal currency (e.g. USD) but the client may fund it from balances in
  // other currencies (e.g. EUR). Funds are taken first from the deal currency;
  // any shortfall is covered by REAL FX conversions, each leg CAPPED at the
  // source currency's available balance so NO balance can be driven negative.
  // The FX legs are SETTLED (permanent): if the deal is later cancelled, only
  // the hold (`APPR-<id>`) is released, so converted funds remain available. If
  // the full amount cannot be covered, we throw instead of posting a partial or
  // overdrawn reservation — callers pre-check and auto-reject, this is the last
  // line of defense.
  const postedIds: string[] = []
  // Fund both reservations ("hold" debits) and gated SETTLED debits (e.g. an
  // instrument acquisition fee) the same way: take from the deal/fee currency
  // first, cover any shortfall with capped cross-currency FX, and never overdraw.
  const gatedDebit = entry.direction === "debit" && (entry.status === "hold" || req.ledgerEffect?.gate === true)
  if (gatedDebit) {
    const existing = await readLedgerEntries(ownerId)
    const available = availableExcludingApproval(existing, req.id)
    const plan = planReservation(available, entry.currency, entry.amount)

    if (!plan.feasible) {
      throw new InsufficientFundsError(
        `Cannot reserve ${formatMoney(entry.amount, entry.currency)} — only ` +
          `${formatMoney(plan.totalAvailableInNeedCurrency, entry.currency)} available across all currencies.`,
      )
    }

    const ref = entry.reference || req.id
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i]
      // Leg A — sell the source currency (settled, permanent debit), capped at
      // its balance by the planner.
      const sellId = `APPR-${req.id}-fx${i}-sell`
      await upsertLedgerEntry(ownerId, {
        id: sellId,
        direction: "debit",
        amount: leg.sellAmount,
        currency: leg.fromCurrency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "FX Treasury",
        reference: ref,
        category: "FX Conversion — Commodity Funding",
        comment: `Sold ${formatMoney(leg.sellAmount, leg.fromCurrency)} to buy ${formatMoney(leg.buyAmount, entry.currency)} for settlement (${leg.rateLabel})`,
      })
      postedIds.push(sellId)

      // Leg B — buy the deal currency (settled, permanent credit).
      const buyId = `APPR-${req.id}-fx${i}-buy`
      await upsertLedgerEntry(ownerId, {
        id: buyId,
        direction: "credit",
        amount: leg.buyAmount,
        currency: entry.currency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "FX Treasury",
        reference: ref,
        category: "FX Conversion — Commodity Funding",
        comment: `Bought ${formatMoney(leg.buyAmount, entry.currency)} from ${formatMoney(leg.sellAmount, leg.fromCurrency)} for settlement (${leg.rateLabel})`,
      })
      postedIds.push(buyId)
    }

    if (plan.legs.length > 0) {
      entry.comment =
        `${entry.comment ? entry.comment + " · " : ""}Reserved ${formatMoney(entry.amount, entry.currency)} ` +
        `(funded via FX from ${plan.legs.map((l) => l.fromCurrency).join(", ")})`
    }
  }

  await upsertLedgerEntry(ownerId, entry)
  postedIds.push(entry.id)

  // DB-level non-negativity enforcement (defense in depth). If this posting
  // overdrew ANY currency, roll back every entry we just wrote and surface the
  // failure rather than leaving a negative balance committed.
  if (entry.direction === "debit") {
    try {
      await assertOwnerSolvent(ownerId)
    } catch (err) {
      for (const id of postedIds) {
        await deleteLedgerEntry(ownerId, id).catch(() => {})
      }
      throw new InsufficientFundsError((err as Error).message)
    }
  }
}

/**
 * Back-fill ledger credits for the signed-in client's already-approved
 * requests. Safe to call on every dashboard load: posting is idempotent on
 * `APPR-<id>`, so an entry that already exists is simply overwritten with the
 * same values. This guarantees that any approved monetization (including ones
 * approved before ledger effects existed) reflects in the master account
 * balance the next time the ledger hydrates. Returns the number of credit
 * entries reconciled.
 */
export async function reconcileMyApprovedCredits(): Promise<{ ok: boolean; applied: number }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, applied: 0 }
  try {
  // Collect-funds deposits RECEIVED from other parties: sweep any approved
  // payment addressed to one of this user's gateway IBANs into a credit on
  // their ledger, so collected funds reflect on the Master Account balance and
  // the matching currency card from any screen — not only the gateway page.
  // Idempotent (keyed on GWD-<approvalId>), so it never double-credits.
  await backfillGatewayDepositsForUser(session.id).catch(() => {})

  // Same sweep for registered external bank accounts: any approved payment
  // addressed to one of this user's registered account IBANs is credited to
  // their Master Account (and per-bank sub-balance). Idempotent (RAD-<id>).
  await backfillRegisteredAccountDepositsForUser(session.id).catch(() => {})

  const mine = await listApprovalsForUser(session.id)
  const approved = mine.filter((r) => r.status === "approved")
    let applied = 0
    for (const req of approved) {
      const entry = ledgerEntryForApproval(req)
      if (!entry) continue
      // A DELIVERED commodity deal must settle: its reservation becomes a
      // permanent `completed` debit (funds paid out to the supplier). Without
      // this, a stale `hold` left behind by delivery (e.g. when a post-delivery
      // amendment re-created the hold, or the one-time delivery settlement was
      // bypassed) would stay frozen forever, because the credit/hold-only
      // filter below would never overwrite it. `ledgerEntryForApproval` already
      // returns this as a `completed` debit for delivered deals, so re-posting
      // it (idempotent on `APPR-<id>`) unblocks the reserved funds on the next
      // ledger hydration, cross-device.
      const isDeliveredSettlement =
        entry.direction === "debit" &&
        entry.status === "completed" &&
        HOLD_KINDS.has(req.kind) &&
        (req.payload as { delivered?: boolean } | undefined)?.delivered === true
      // Back-fill credits (incoming proceeds), holds (reserved funds for approved
      // commodity deals) and delivered-settlement debits so the balance reflects
      // them on the same ledger it is read from, even for requests approved
      // before the effect was wired in. Idempotent on `APPR-<id>`, so re-posting
      // never doubles up.
      if (entry.direction === "credit" || entry.status === "hold" || isDeliveredSettlement) {
        // Post to the shared-data owner (Master for a sub) so the entry lands
        // on the same ledger the balance is read from.
        const ownerId = await resolveDataOwnerIdFor(req.userId)
        await upsertLedgerEntry(ownerId, entry)
        applied += 1
      }
    }

    // Treuhand trading fund lifecycle on the ledger, driven off the approval
    // status (no scheduler — runs on every ledger read, self-healing/cross-
    // device). Deterministic ids keep every post idempotent:
    //   • PENDING   → RESERVE the capital as a `hold` debit `APPR-<id>` so the
    //                 funds are BLOCKED on the master account while the
    //                 administrator reviews the application.
    //   • APPROVED  → SETTLE that same `APPR-<id>` into a `completed` debit
    //                 (capital deducted, reflecting on the master account) plus
    //                 matured 25% monthly ROI credits and any capital-return.
    //   • REJECTED/CANCELLED → RELEASE the reservation hold (unfreeze funds).
    const tradingFundReqs = mine.filter((r) => r.kind === "trading_fund")
    const ownerLedgerRows = new Map<string, Map<string, LedgerEntry>>()
    const loadOwnerRows = async (ownerId: string) => {
      let rows = ownerLedgerRows.get(ownerId)
      if (!rows) {
        const list = await readLedgerEntries(ownerId)
        rows = new Map(list.map((r) => [r.id, r]))
        ownerLedgerRows.set(ownerId, rows)
      }
      return rows
    }
    for (const req of tradingFundReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)

      // A decided-against application must not keep funds frozen: drop the
      // reservation hold if one is still present.
      if (req.status === "rejected" || req.status === "cancelled") {
        const capId = `APPR-${req.id}`
        const cur = rows.get(capId)
        if (cur && cur.status === "hold") {
          await deleteLedgerEntry(ownerId, capId)
          rows.delete(capId)
          applied += 1
        }
        continue
      }

      const posts = buildTradingFundPosts(req)
      for (const post of posts) {
        const cur = rows.get(post.id)
        // Post when missing OR when the entry must change (the pending `hold`
        // becoming the approved `completed` settlement). Re-running with an
        // identical entry is a no-op, so this never double-posts.
        if (cur && cur.status === post.status && cur.direction === post.direction && cur.amount === post.amount) {
          continue
        }
        await upsertLedgerEntry(ownerId, post)
        rows.set(post.id, post)
        applied += 1
      }
    }

    // Yield / PPP automatic ROI on the ledger. Once an application is APPROVED,
    // the program pays ROI in arrears on its cycle (weekly / monthly / …): each
    // matured period is CREDITED to the master account. When the investment is
    // funded by an MCC HOLDING SA-owned instrument, only the client's 25% share
    // is credited (the 75% is alienated to MCC HOLDING SA). No scheduler — this
    // runs on every ledger read, self-healing/cross-device, and deterministic
    // ids (`PPP-ROI-<id>-P<n>`) keep every credit idempotent.
    const pppReqs = mine.filter((r) => r.kind === "ppp" && r.status === "approved")
    for (const req of pppReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)
      const posts = buildPppRoiPosts(req)
      for (const post of posts) {
        if (rows.has(post.id)) continue
        await upsertLedgerEntry(ownerId, post)
        rows.set(post.id, post)
        applied += 1
      }
    }

    // Internal-loan lifecycle on the ledger, driven off the approval status
    // (self-contained like trading_fund; no scheduler — runs on every ledger
    // read, self-healing/cross-device). Deterministic ids keep every post
    // idempotent:
    //   • APPROVED → CREDIT the principal to the master (`ILOAN-<id>`), DEBIT any
    //                one-time arrangement fee (`ILOAN-FEE-<id>`), and DEBIT each
    //                matured monthly interest charge (`ILOAN-INT-<id>-<YYYY-MM>`,
    //                default 3% p.a., admin-overridable; first month pro-rated).
    //   • SETTLED  → `settledAt` stops further monthly interest (the repayment
    //                action posts the final interest stub exactly once).
    // Nothing posts while PENDING/REJECTED — an internal loan never moves money
    // until the administrator approves it.
    const internalLoanReqs = mine.filter((r) => r.kind === "internal_loan" && r.status === "approved")
    for (const req of internalLoanReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)
      const posts = buildInternalLoanPosts(req, new Set(rows.keys()))
      for (const post of posts) {
        const entry: LedgerEntry = { ...post.entry, direction: post.direction }
        if (rows.has(entry.id)) continue
        await upsertLedgerEntry(ownerId, entry)
        rows.set(entry.id, entry)
        applied += 1
      }
    }

    return { ok: true, applied }
  } catch (err) {
    console.log("[v0] reconcileMyApprovedCredits failed:", (err as Error).message)
    return { ok: false, applied: 0 }
  }
}

export type DecideResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

/**
 * Post any missing trading-fund ledger entries (capital debit, matured ROI, and
 * the capital-return credit once closed) for ONE approved subscription to its
 * balance owner (Master for a sub). Idempotent — skips ids already present.
 * Used by the admin position-control actions so the effect reflects for the
 * client immediately, without waiting for their next ledger read.
 */
async function syncTradingFundLedger(req: ApprovalRequest): Promise<void> {
  const posts = buildTradingFundPosts(req)
  if (posts.length === 0) return
  const ownerId = await resolveDataOwnerIdFor(req.userId)
  const rows = await readLedgerEntries(ownerId)
  const existing = new Set(rows.map((r) => r.id))
  for (const post of posts) {
    if (existing.has(post.id)) continue
    await upsertLedgerEntry(ownerId, post)
  }
}

/** Current lifecycle state of a Treuhand position, derived from its payload. */
export type TradingFundPositionStatus = "active" | "paused" | "closed"

function tradingFundStatus(payload: Record<string, unknown> | null | undefined): TradingFundPositionStatus {
  const p = (payload ?? {}) as { closedAt?: string; exitedAt?: string; pauseWindows?: TradingFundPauseWindow[] }
  if (p.closedAt || p.exitedAt) return "closed"
  if (Array.isArray(p.pauseWindows) && p.pauseWindows.some((w) => w && w.from && !w.to)) return "paused"
  return "active"
}

/** Load an approved trading_fund position and guard it, for an admin action. */
async function loadOpenPosition(
  id: string,
): Promise<{ ok: true; req: ApprovalRequest; payload: Record<string, unknown> } | { ok: false; error: string }> {
  const existing = await getApprovalById(id)
  if (!existing) return { ok: false, error: "Position not found." }
  if (existing.kind !== "trading_fund") return { ok: false, error: "This is not a Treuhand fund position." }
  if (existing.status !== "approved") return { ok: false, error: "Only an authorized position can be managed." }
  return { ok: true, req: existing, payload: (existing.payload ?? {}) as Record<string, unknown> }
}

async function notifyPositionChange(req: ApprovalRequest, title: string, body: string): Promise<void> {
  try {
    await insertNotification({
      userId: req.userId,
      tone: "info",
      title,
      body,
      href: KIND_HREF.trading_fund ?? "/dashboard/trading",
    })
  } catch (err) {
    console.log("[v0] trading-fund notification failed:", (err as Error).message)
  }
}

async function logPositionChange(req: ApprovalRequest, action: string, decision: string, note?: string): Promise<void> {
  try {
    const target = await resolveAccountProfileById(req.userId)
    await logActivity({
      action,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: req.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: req.summary || req.title,
        decision,
        reason: note?.trim() || "(none)",
      },
    })
  } catch (err) {
    console.log("[v0] trading-fund activity log failed:", (err as Error).message)
  }
}

/**
 * Administrator PAUSES a live Treuhand position. Opens a pause window so ROI
 * stops maturing and every future anniversary is deferred by the paused time.
 * The capital stays deployed (debit untouched). Client cannot do this.
 */
export async function pauseTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { req, payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is closed." }
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    if (windows.some((w) => w && w.from && !w.to)) return { ok: false, error: "This position is already paused." }
    windows.push({ from: new Date().toISOString() })
    const updated = await updateApprovalPayload(id, { ...payload, pauseWindows: windows, positionStatus: "paused" })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    await notifyPositionChange(
      updated,
      "Treuhand position paused",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was paused by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. Monthly ROI is on hold until it is reactivated.`,
    )
    await logPositionChange(updated, `Administrator paused Treuhand position "${updated.title}"`, "Paused", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] pauseTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be paused. Please try again." }
  }
}

/**
 * Administrator RESUMES a paused Treuhand position. Closes the open pause window
 * so ROI accrual continues from where it left off.
 */
export async function resumeTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is closed." }
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (!open) return { ok: false, error: "This position is not paused." }
    open.to = new Date().toISOString()
    const updated = await updateApprovalPayload(id, { ...payload, pauseWindows: windows, positionStatus: "active" })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    await notifyPositionChange(
      updated,
      "Treuhand position reactivated",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was reactivated by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. Monthly ROI accrual has resumed.`,
    )
    await logPositionChange(updated, `Administrator reactivated Treuhand position "${updated.title}"`, "Reactivated", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] resumeTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be reactivated. Please try again." }
  }
}

/**
 * Administrator CLOSES / EXITS a Treuhand position. ROI stops maturing and the
 * deployed capital (the tokens) is CREDITED BACK to the master account, netting
 * the original debit to zero. Matured ROI already earned stays paid. The
 * capital return + any final matured ROI are posted immediately.
 */
export async function closeTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is already closed." }
    const nowIso = new Date().toISOString()
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (open) open.to = nowIso
    const updated = await updateApprovalPayload(id, {
      ...payload,
      pauseWindows: windows,
      closedAt: nowIso,
      positionStatus: "closed",
    })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    // Post the capital-return credit (and any final matured ROI) right away.
    await syncTradingFundLedger(updated)
    const capital = Number(updated.amount ?? (updated.payload as { capital?: number })?.capital)
    const capitalLabel = Number.isFinite(capital) ? formatMoney(capital, updated.currency ?? "EUR") : "the deployed capital"
    await notifyPositionChange(
      updated,
      "Treuhand position closed",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was closed by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. ${capitalLabel} (your tokens) has been credited back to your Master Account and monthly ROI has stopped.`,
    )
    await logPositionChange(updated, `Administrator closed Treuhand position "${updated.title}" and returned capital`, "Closed", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] closeTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be closed. Please try again." }
  }
}

/**
 * CLIENT requests an anticipated termination (early resignation) of one of their
 * OWN Treuhand positions. This only records the request on the payload and
 * notifies the administrator — it moves NO money and does NOT close the position.
 * The administrator evaluates it and, if agreed, runs the reconciliation
 * (`reconcileTradingFundTermination`) which is where the fees are applied and the
 * capital is returned. Ownership is enforced against the caller's environment.
 */
export async function requestTradingFundTermination(
  id: string,
  reason?: string,
): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(id)
    if (!existing || existing.kind !== "trading_fund") return { ok: false, error: "Position not found." }
    if (existing.status !== "approved") return { ok: false, error: "Only an active position can be terminated." }
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (!memberIds.includes(existing.userId)) return { ok: false, error: "You cannot manage this position." }
    const payload = (existing.payload ?? {}) as Record<string, unknown>
    if (payload.closedAt || payload.exitedAt) return { ok: false, error: "This position is already closed." }
    if (payload.terminationRequestedAt) return { ok: false, error: "A termination request is already under review." }

    const updated = await updateApprovalPayload(id, {
      ...payload,
      terminationRequestedAt: new Date().toISOString(),
      terminationReason: reason?.trim() || null,
    })
    if (!updated) return { ok: false, error: "The request could not be recorded. Please try again." }

    // Surface to the administrator via the activity log (the admin panel reads
    // the flag directly from the position, so this is the audit trail).
    await logPositionChange(
      updated,
      `Client requested early termination of Treuhand position "${updated.title}"`,
      "Termination requested",
      reason,
    )
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] requestTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The request could not be submitted. Please try again." }
  }
}

/** CLIENT withdraws a pending early-termination request on their own position. */
export async function withdrawTradingFundTermination(id: string): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(id)
    if (!existing || existing.kind !== "trading_fund") return { ok: false, error: "Position not found." }
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (!memberIds.includes(existing.userId)) return { ok: false, error: "You cannot manage this position." }
    const payload = (existing.payload ?? {}) as Record<string, unknown>
    if (!payload.terminationRequestedAt) return { ok: false, error: "There is no pending request to withdraw." }
    if (payload.closedAt || payload.exitedAt) return { ok: false, error: "This position is already closed." }

    const { terminationRequestedAt: _r, terminationReason: _n, ...rest } = payload
    const updated = await updateApprovalPayload(id, rest)
    if (!updated) return { ok: false, error: "The request could not be withdrawn. Please try again." }
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] withdrawTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The request could not be withdrawn. Please try again." }
  }
}

/**
 * ADMINISTRATOR reconciles and closes a Treuhand position in ONE step — used to
 * grant an anticipated (early) termination the client requested, or to settle a
 * normal exit. Records the agreed early-resignation `penalty` and any additional
 * `charges` on the payload, sets `closedAt`, then posts the whole settlement to
 * the ledger: capital returned, the 2% platform commission, and the penalty /
 * charges. The client then sees the capital credited MINUS all fees.
 */
export async function reconcileTradingFundTermination(
  passcode: string,
  id: string,
  input: { penaltyAmount?: number; chargesAmount?: number; chargesNote?: string; note?: string },
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is already closed." }

    const penalty = Math.max(0, Number(input.penaltyAmount) || 0)
    const charges = Math.max(0, Number(input.chargesAmount) || 0)
    if (!Number.isFinite(penalty) || !Number.isFinite(charges)) {
      return { ok: false, error: "Penalty and charges must be valid amounts." }
    }

    const nowIso = new Date().toISOString()
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (open) open.to = nowIso

    const updated = await updateApprovalPayload(id, {
      ...payload,
      pauseWindows: windows,
      closedAt: nowIso,
      positionStatus: "closed",
      earlyPenaltyAmount: penalty,
      exitChargesAmount: charges,
      exitChargesNote: input.chargesNote?.trim() || null,
      terminationHandledAt: nowIso,
      terminationRequestedAt: null,
    })
    if (!updated) return { ok: false, error: "The position could not be updated." }

    // Post the full settlement (capital return + commission + penalty + charges).
    await syncTradingFundLedger(updated)

    const currency = updated.currency ?? "EUR"
    const capital = Number(updated.amount ?? (updated.payload as { capital?: number })?.capital) || 0
    const commission = Math.round(capital * 0.02 * 100) / 100
    const net = Math.max(0, capital - commission - penalty - charges)
    const feeLine = [
      `${formatMoney(commission, currency)} commission`,
      penalty > 0 ? `${formatMoney(penalty, currency)} penalty` : null,
      charges > 0 ? `${formatMoney(charges, currency)} charges` : null,
    ]
      .filter(Boolean)
      .join(", ")

    await notifyPositionChange(
      updated,
      "Treuhand termination reconciled",
      `Your Treuhand AG Hedge Fund position "${updated.title}" has been terminated and reconciled by MCC Capital${input.note?.trim() ? ` — ${input.note.trim()}` : ""}. ${formatMoney(capital, currency)} capital was returned, less ${feeLine}. Net credited to your Master Account: ${formatMoney(net, currency)}.`,
    )
    await logPositionChange(
      updated,
      `Administrator reconciled and closed Treuhand position "${updated.title}"`,
      "Reconciled & closed",
      `Capital ${formatMoney(capital, currency)}, commission ${formatMoney(commission, currency)}, penalty ${formatMoney(penalty, currency)}, charges ${formatMoney(charges, currency)}, net ${formatMoney(net, currency)}. ${input.note?.trim() ?? ""}`,
    )
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] reconcileTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The termination could not be reconciled. Please try again." }
  }
}

/** A Treuhand position summarized for the administrator control panel. */
export interface AdminTradingFundPosition {
  id: string
  userId: string
  accountName: string
  accountEmail: string
  title: string
  tokens: number | null
  capital: number
  currency: string
  monthlyRoi: number
  activatedAt: string
  status: TradingFundPositionStatus
  pausedAt: string | null
  closedAt: string | null
  pauseWindows: TradingFundPauseWindow[]
  terminationRequestedAt: string | null
  terminationReason: string | null
}

/** Every authorized Treuhand position across all accounts, for the admin panel. */
export async function adminListTradingFundPositions(
  passcode: string,
): Promise<{ ok: true; positions: AdminTradingFundPosition[] } | { ok: false; error: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const reqs = await listAllApprovals({ kind: "trading_fund", status: "approved" })
    const positions: AdminTradingFundPosition[] = []
    for (const req of reqs) {
      const payload = (req.payload ?? {}) as {
        capital?: number
        tokens?: number
        pauseWindows?: TradingFundPauseWindow[]
        closedAt?: string
        exitedAt?: string
        terminationRequestedAt?: string
        terminationReason?: string
      }
      const capital = Number(req.amount ?? payload.capital)
      if (!Number.isFinite(capital) || capital <= 0) continue
      const profile = await resolveAccountProfileById(req.userId)
      const status = tradingFundStatus(payload)
      const windows = Array.isArray(payload.pauseWindows) ? payload.pauseWindows : []
      const openPause = windows.find((w) => w && w.from && !w.to)
      positions.push({
        id: req.id,
        userId: req.userId,
        accountName: profile.fullName,
        accountEmail: profile.email,
        title: req.title,
        tokens: Number.isFinite(Number(payload.tokens)) ? Number(payload.tokens) : null,
        capital,
        currency: req.currency || "EUR",
        monthlyRoi: Math.round(capital * TRADING_FUND_MONTHLY_ROI * 100) / 100,
        activatedAt: req.decidedAt || req.createdAt,
        status,
        pausedAt: openPause?.from ?? null,
        closedAt: payload.closedAt ?? payload.exitedAt ?? null,
        pauseWindows: windows,
        terminationRequestedAt: payload.terminationRequestedAt ?? null,
        terminationReason: payload.terminationReason ?? null,
      })
    }
    return { ok: true, positions }
  } catch (err) {
    console.log("[v0] adminListTradingFundPositions failed:", (err as Error).message)
    return { ok: false, error: "Positions could not be loaded. Please try again." }
  }
}

export async function adminDecideApproval(
  passcode: string,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, error: "A reason is required to reject a request." }
  }

  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Request not found." }
    if (existing.status !== "pending" && existing.status !== "awaiting_master") {
      return { ok: false, error: "This request has already been decided." }
    }

    // HARD fund-availability gate. Before committing an APPROVAL that reserves
    // funds, verify the balance owner can actually cover it in the deal currency
    // (including capped cross-currency FX). If it cannot, AUTO-REJECT the
    // request, notify the client, log the reason, and tell the admin — money is
    // never moved and no negative balance can be created.
    if (decision === "approved") {
      const assessment = await assessReservation(existing)
      if (assessment.required && !assessment.feasible) {
        const reason = assessment.message
        const rejected = await recordAdminDecision(id, "rejected", "Administrator (auto)", reason)
        const finalReq = rejected ?? existing
        try {
          await insertNotification({
            userId: finalReq.userId,
            tone: "warning",
            title: `${KIND_LABELS[finalReq.kind]} declined — insufficient funds`,
            body: `Your ${KIND_LABELS[finalReq.kind].toLowerCase()} "${finalReq.title}" was automatically declined: the account lacks sufficient available balance to reserve the required funds. ${reason}`,
            href: KIND_HREF[finalReq.kind] ?? null,
          })
        } catch (err) {
          console.log("[v0] insufficient-funds notification failed:", (err as Error).message)
        }
        try {
          const target = await resolveAccountProfileById(finalReq.userId)
          await logActivity({
            action: `Auto-declined a ${KIND_LABELS[finalReq.kind]} request for ${target.fullName} — insufficient funds`,
            category: "Administration / Approvals",
            user: "Administrator",
            details: {
              referenceId: finalReq.id,
              targetAccount: `${target.fullName} — ${target.email}`,
              summary: finalReq.summary || finalReq.title,
              amount: finalReq.amount != null ? formatMoney(finalReq.amount, finalReq.currency ?? "") : "(n/a)",
              decision: "rejected (insufficient funds)",
              reason,
            },
          })
        } catch (err) {
          console.log("[v0] insufficient-funds audit log failed:", (err as Error).message)
        }
        return { ok: false, error: reason }
      }
    }

    // Record the administrator's verdict (first gate). For a Sub-account
    // payment this lands the request on "awaiting_master" rather than
    // "approved" until the Master also consents.
    let updated = await recordAdminDecision(id, decision, "Administrator", note)
    if (!updated) return { ok: false, error: "This request has already been decided." }

    // Money only moves once ALL required gates clear (final status approved).
    if (updated.status === "approved") {
      // A leverage line must be marked ACTIVE on approval: stamp activatedAt
      // (interest accrual start) and the borrowed-funds credit entry id into the
      // record, so the line shows live and accrues interest regardless of which
      // admin surface approved it. Done before applyLedgerEffect so the stored
      // creditEntryId matches the entry that is about to be posted.
      if (updated.kind === "leverage") {
        try {
          const rec = (updated.payload?.record ?? {}) as Record<string, unknown>
          if (!rec.activatedAt) {
            const activatedAt = updated.decidedAt ?? new Date().toISOString()
            const newPayload = {
              ...(updated.payload ?? {}),
              record: {
                ...rec,
                status: "approved",
                decidedAt: activatedAt,
                activatedAt,
                creditEntryId: `APPR-${updated.id}`,
              },
            }
            const persisted = await updateApprovalPayload(updated.id, newPayload)
            if (persisted) updated = persisted
          }
        } catch (err) {
          console.log("[v0] leverage activation stamp failed:", (err as Error).message)
        }
      }
      try {
        await applyLedgerEffect(updated)
      } catch (err) {
        console.log("[v0] applyLedgerEffect failed:", (err as Error).message)
      }

      // If this approved outgoing payment is addressed to a Collect-funds
      // gateway IBAN, record it as a received deposit on that account and credit
      // the gateway owner's Master Account. Idempotent and self-validating.
      if (updated.kind === "payment") {
        let matchedGateway = false
        try {
          const res = await recordGatewayDepositForApproval(updated.id)
          matchedGateway = res.matched
        } catch (err) {
          console.log("[v0] gateway IBAN auto-match failed:", (err as Error).message)
        }
        // Otherwise, if the beneficiary IBAN matches a client's registered
        // external bank account, auto-credit that owner's Master Account (and
        // the per-bank sub-balance). Only when no gateway matched, so a given
        // IBAN can never be credited twice. Idempotent on `RAD-<id>`.
        if (!matchedGateway) {
          try {
            await recordRegisteredAccountDepositForApproval(updated.id)
          } catch (err) {
            console.log("[v0] registered-account IBAN auto-match failed:", (err as Error).message)
          }
        }
      }

      // An approved RECALL fully unwinds the original payment. applyLedgerEffect
      // above already credited the sender's refund (the recall's ledgerEffect);
      // here we (a) reverse any recipient gateway credit and (b) stamp the
      // original payment as recalled so the idempotent backfill never re-funds
      // it. All monetary effects are keyed deterministically, so this is safe to
      // re-run.
      if (updated.kind === "payment_recall") {
        const originalApprovalId = (updated.payload as { originalApprovalId?: string })?.originalApprovalId
        if (originalApprovalId) {
          try {
            await reverseGatewayDepositForApproval(originalApprovalId)
          } catch (err) {
            console.log("[v0] recall recipient reversal failed:", (err as Error).message)
          }
          try {
            await reverseRegisteredAccountDepositForApproval(originalApprovalId)
          } catch (err) {
            console.log("[v0] recall registered-account reversal failed:", (err as Error).message)
          }
          try {
            const original = await getApprovalById(originalApprovalId)
            if (original) {
              const op = (original.payload ?? {}) as Record<string, unknown>
              const orec = (op.record ?? {}) as Record<string, unknown>
              await updateApprovalPayload(originalApprovalId, {
                ...op,
                recalled: true,
                recallStatus: "recalled",
                record: { ...orec, recallStatus: "recalled" },
              })
            }
          } catch (err) {
            console.log("[v0] original recall stamp failed:", (err as Error).message)
          }
        }
      }

      // An approved AMENDMENT renegotiates the original deal. Update the deal's
      // value, currency and reservation effect, then re-run its ledger effect so
      // the reserved hold (`APPR-<dealId>`) auto-adjusts to the new amount
      // (auto-FX funds any increase). The amendment is moved into the deal's
      // history and the pending flag cleared. The amendment approval itself
      // carries no ledger effect, so applyLedgerEffect(updated) above was a no-op.
      if (updated.kind === "commodity_amendment") {
        try {
          await applyApprovedAmendment(updated)
        } catch (err) {
          console.log("[v0] apply amendment failed:", (err as Error).message)
        }
      }
    }

    // A REJECTED amendment leaves the deal untouched: just clear the pending flag
    // and file the rejected amendment in the deal's history for the audit trail.
    if (updated.kind === "commodity_amendment" && decision === "rejected") {
      try {
        await clearRejectedAmendment(updated, note?.trim())
      } catch (err) {
        console.log("[v0] clear rejected amendment failed:", (err as Error).message)
      }
    }

    // Notify the owning client.
    const label = KIND_LABELS[updated.kind]
    const awaitingMaster = updated.status === "awaiting_master"
    try {
      await insertNotification({
        userId: updated.userId,
        tone: decision === "approved" ? (awaitingMaster ? "info" : "success") : "warning",
        title:
          decision === "approved"
            ? awaitingMaster
              ? `${label} awaiting Master approval`
              : updated.kind === "payment"
                ? "Payment approved & initiated"
                : `${label} approved`
            : `${label} declined`,
        body:
          decision === "approved"
            ? awaitingMaster
              ? `Your ${label.toLowerCase()} request "${updated.title}" was approved by the administrator and now awaits your Master account's consent.`
              : updated.kind === "payment"
                ? `Your payment "${updated.title}" has been approved and initiated — the funds have left your account and are on their way to the beneficiary. You'll be notified once delivery is confirmed.`
                : `Your ${label.toLowerCase()} request "${updated.title}" was approved.`
            : `Your ${label.toLowerCase()} request "${updated.title}" was declined. Reason: ${note?.trim()}`,
        href: KIND_HREF[updated.kind] ?? null,
      })
    } catch (err) {
      console.log("[v0] approval notification failed:", (err as Error).message)
    }

    // When the admin gate clears but a Master gate remains, nudge the Master.
    if (awaitingMaster && updated.masterId) {
      try {
        await insertNotification({
          userId: updated.masterId,
          tone: "warning",
          title: "Sub-account payment awaiting your approval",
          body: `${updated.initiatedByName ?? "A sub-account"}'s ${label.toLowerCase()} "${updated.title}" was approved by the administrator and needs your consent to execute.`,
          href: "/dashboard/network",
        })
      } catch (err) {
        console.log("[v0] master nudge notification failed:", (err as Error).message)
      }
    }

    // Audit trail.
    const target = await resolveAccountProfileById(updated.userId)
    await logActivity({
      action: `Administrator ${decision} a ${label} request for ${target.fullName}`,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: updated.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: updated.summary || updated.title,
        amount: updated.amount != null ? `${updated.currency ?? ""} ${updated.amount.toLocaleString("en-US")}` : "(n/a)",
        decision,
        reason: note?.trim() || "(none)",
      },
    })

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminDecideApproval failed:", (err as Error).message)
    return { ok: false, error: "The decision could not be recorded. Please try again." }
  }
}

interface AmendmentTerms {
  approxValue: number
  quantity: string
  tradeStructure: string
  unitPrice?: number
}

/**
 * Apply an APPROVED amendment to its parent deal: update the deal's stored value,
 * quantity and incoterms, rebuild its reservation effect at the new value, and
 * re-run the ledger effect so the reserved hold (`APPR-<dealId>`) auto-adjusts
 * (auto-FX funds any increase). The amendment is moved into the deal's
 * `amendmentHistory` and the `pendingAmendment` flag is cleared.
 */
async function applyApprovedAmendment(amendment: ApprovalRequest): Promise<void> {
  const ap = (amendment.payload ?? {}) as {
    dealApprovalId?: string
    proposed?: AmendmentTerms
    previous?: AmendmentTerms
    reason?: string
  }
  const dealApprovalId = ap.dealApprovalId
  const proposed = ap.proposed
  if (!dealApprovalId || !proposed) return

  const deal = await getApprovalById(dealApprovalId)
  if (!deal) return
  const payload = (deal.payload ?? {}) as { record?: Record<string, unknown>; [k: string]: unknown }
  const record = (payload.record ?? {}) as Record<string, unknown>

  // Defense-in-depth: the authoritative total is unit price × quantity. If a
  // unit price travelled with the amendment, recompute from it so the deal can
  // never inherit a stale client's raw per-unit price as its total value.
  const applyQty = parseQuantityString(proposed.quantity)
  const applyUnit = Number(proposed.unitPrice)
  const newValue =
    Number.isFinite(applyUnit) && applyUnit > 0 && applyQty
      ? Math.round(applyUnit * applyQty.amount * 100) / 100
      : Math.round(Number(proposed.approxValue) * 100) / 100
  const currency = deal.currency ?? (record.currency as string) ?? "USD"
  const sellerName = (record.sellerName as string) || "Commodity supplier"
  const uetr = (record.uetr as string) || (record.id as string) || deal.id

  // Move the (now decided) amendment from pending → history on the deal record.
  const pending = (record.pendingAmendment ?? {}) as Record<string, unknown>
  const decidedAmendment = {
    ...pending,
    status: "approved" as const,
    decidedAt: amendment.decidedAt ?? new Date().toISOString(),
  }
  const history = Array.isArray(record.amendmentHistory)
    ? (record.amendmentHistory as Record<string, unknown>[])
    : []

  const newUnitPrice =
    Number.isFinite(applyUnit) && applyUnit > 0
      ? Math.round(applyUnit * 100) / 100
      : applyQty && newValue > 0
        ? Math.round((newValue / applyQty.amount) * 100) / 100
        : (record.unitPrice as number | undefined)

  const newRecord = {
    ...record,
    approxValue: newValue,
    unitPrice: newUnitPrice,
    quantity: proposed.quantity,
    tradeStructure: proposed.tradeStructure,
    pendingAmendment: undefined,
    amendmentHistory: [decidedAmendment, ...history],
  }

  // Rebuild the deal's reservation effect at the amended value, then re-run it so
  // the hold tracks the new amount. Idempotent on `APPR-<dealId>`.
  const ledgerEffect: LedgerEffect = {
    direction: "debit",
    amount: newValue,
    currency,
    status: "hold",
    counterparty: sellerName,
    reference: uetr,
    category: "Commodity Trade — Reserved Funds",
  }

  const updatedDeal = await updateApprovalTerms(dealApprovalId, {
    amount: newValue,
    currency,
    ledgerEffect,
    payload: { ...payload, record: newRecord },
  })

  if (updatedDeal) {
    try {
      await applyLedgerEffect(updatedDeal)
    } catch (err) {
      console.log("[v0] amendment hold adjust failed:", (err as Error).message)
    }
  }

  try {
    const target = await resolveAccountProfileById(deal.userId)
    await logActivity({
      action: `Administrator approved an amendment to deal ${dealApprovalId}`,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: amendment.id,
        dealId: dealApprovalId,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: `Deal amended: value → ${currency} ${newValue.toLocaleString("en-US")}, quantity → ${proposed.quantity}, terms → ${proposed.tradeStructure}. Reserved funds adjusted to match. Reason: ${ap.reason ?? "(none)"}.`,
        decision: "approved",
      },
    })
  } catch (err) {
    console.log("[v0] amendment approval log failed:", (err as Error).message)
  }
}

/**
 * Clear a REJECTED amendment: the deal's terms are untouched, the
 * `pendingAmendment` flag is removed, and the rejected amendment is recorded in
 * the deal's `amendmentHistory` for the audit trail.
 */
async function clearRejectedAmendment(amendment: ApprovalRequest, note?: string): Promise<void> {
  const ap = (amendment.payload ?? {}) as { dealApprovalId?: string }
  const dealApprovalId = ap.dealApprovalId
  if (!dealApprovalId) return

  const deal = await getApprovalById(dealApprovalId)
  if (!deal) return
  const payload = (deal.payload ?? {}) as { record?: Record<string, unknown>; [k: string]: unknown }
  const record = (payload.record ?? {}) as Record<string, unknown>

  const pending = (record.pendingAmendment ?? {}) as Record<string, unknown>
  const decidedAmendment = {
    ...pending,
    status: "rejected" as const,
    decidedAt: amendment.decidedAt ?? new Date().toISOString(),
    decisionNote: note,
  }
  const history = Array.isArray(record.amendmentHistory)
    ? (record.amendmentHistory as Record<string, unknown>[])
    : []

  await updateApprovalPayload(dealApprovalId, {
    ...payload,
    record: { ...record, pendingAmendment: undefined, amendmentHistory: [decidedAmendment, ...history] },
  })
}

/**
 * Administrator flags an approved commodity deal as DELIVERED. This locks the
 * deal: the client can no longer revoke it (the revoke DB guard refuses any deal
 * whose payload is flagged delivered). The delivered state is stored on the
 * approval's payload so it is visible to the client cross-device.
 */
export async function adminMarkCommodityDelivered(
  passcode: string,
  id: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Deal not found." }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be marked delivered." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be marked delivered." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: true, request: existing }
    }

    const updated = await markApprovalDelivered(id)
    if (!updated) return { ok: false, error: "This deal can no longer be marked delivered." }

    // SETTLE the reserved funds: on delivery the blocked amount is paid out to
    // the supplier, so it must permanently LEAVE the client's balance — not stay
    // held nor return to available. The reservation lives as a `hold` debit under
    // entry id `APPR-<id>`; converting it to a `completed` debit (same id, upsert)
    // makes it reduce the settled balance too, so the amount disappears from the
    // client's balances entirely.
    try {
      const ownerId = await resolveDataOwnerIdFor(updated.userId)
      const entries = await readLedgerEntries(ownerId)
      const hold = entries.find((e) => e.id === `APPR-${id}` && e.status === "hold")
      if (hold) {
        await upsertLedgerEntry(ownerId, {
          ...hold,
          status: "completed",
          date: new Date().toISOString(),
          category: "Commodity Trade — Settled (Delivered)",
          comment: `Delivered & settled — funds paid out for ${KIND_LABELS[updated.kind]} "${updated.title}"`,
        })
      }
    } catch (err) {
      console.log("[v0] delivered settlement failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Commodity deal delivered",
        body: `Your commodity deal "${updated.title}" has been confirmed delivered by MCC Capital. The reserved funds have been paid out for settlement. The deal is now finalized and can no longer be revoked.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] delivered notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(updated.userId)
      await logActivity({
        action: `Administrator flagged commodity deal "${updated.title}" as delivered for ${target.fullName}`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: updated.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: updated.summary || updated.title,
          decision: "Delivered",
        },
      })
    } catch (err) {
      console.log("[v0] delivered activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminMarkCommodityDelivered failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be marked delivered. Please try again." }
  }
}

/**
 * Administrator confirms an approved outgoing PAYMENT (bank wire) has reached the
 * beneficiary account — the third and final stage of the payment lifecycle
 * ("Payment Completed — Funds Delivered"). The funds already left the sender's
 * balance when the payment was approved and initiated (stage 2), so this is a
 * DELIVERY CONFIRMATION only and performs NO further ledger movement.
 *
 * It stamps the delivery flag both at the payload top level (`delivered` /
 * `deliveredAt`, via `markApprovalDelivered`) and inside `payload.record` so the
 * client's payment store view-model — rebuilt from `payload.record` — reflects
 * the delivered state on its next poll. The transition is notified to the client
 * and written to the audit log with a timestamp and the responsible party.
 */
export async function adminMarkPaymentDelivered(
  passcode: string,
  id: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Payment not found." }
    if (existing.kind !== "payment") {
      return { ok: false, error: "Only outgoing payments can be marked delivered." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved & initiated payment can be marked delivered." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: true, request: existing }
    }

    // Stage the delivery flag at the payload top level (delivered / deliveredAt).
    const updated = await markApprovalDelivered(id)
    if (!updated) return { ok: false, error: "This payment can no longer be marked delivered." }

    // Mirror the confirmation into `payload.record` so the client payment store
    // (which rebuilds its view-model from payload.record) shows stage 3, and
    // record the responsible party for the audit trail. No funds move here — the
    // debit posted at approval — so there is no ledger effect.
    const deliveredAt = (updated.payload?.deliveredAt as string) ?? new Date().toISOString()
    try {
      const payload = (updated.payload ?? {}) as Record<string, unknown>
      const record = (payload.record ?? {}) as Record<string, unknown>
      const persisted = await updateApprovalPayload(updated.id, {
        ...payload,
        deliveredBy: "Administrator",
        record: {
          ...record,
          deliveryStatus: "delivered",
          deliveredAt,
          deliveredBy: "Administrator",
        },
      })
      if (persisted) Object.assign(updated, persisted)
    } catch (err) {
      console.log("[v0] payment delivery record stamp failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Payment delivered to beneficiary",
        body: `Your payment "${updated.title}" has been confirmed delivered — the funds have reached the beneficiary account. This payment is now complete.`,
        href: KIND_HREF.payment ?? "/dashboard/payments",
      })
    } catch (err) {
      console.log("[v0] payment delivered notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(updated.userId)
      await logActivity({
        action: `Administrator confirmed payment "${updated.title}" delivered to beneficiary for ${target.fullName}`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: updated.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: updated.summary || updated.title,
          amount: updated.amount != null ? formatMoney(updated.amount, updated.currency ?? "") : "(n/a)",
          decision: "Completed — Funds Delivered",
          deliveredAt,
        },
      })
    } catch (err) {
      console.log("[v0] payment delivered activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminMarkPaymentDelivered failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be marked delivered. Please try again." }
  }
}

/**
 * Administrator REVOKES an approved commodity deal (before delivery) and REFUNDS
 * the reserved funds. Refuses a delivered deal (it is finalized). Releases only
 * the reservation hold (`APPR-<id>`), unfreezing the blocked money back to the
 * owner's available balance; any FX conversion legs executed to fund the deal
 * are intentionally left in place, mirroring the client-revoke policy.
 */
export async function adminRevokeCommodityDeal(
  passcode: string,
  id: string,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Deal not found." }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be revoked here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be revoked." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be revoked." }
    }

    const revoked = await adminRevokeApprovedApproval(id, note)
    if (!revoked) return { ok: false, error: "This deal can no longer be revoked." }

    // Release the reservation hold → unfreeze the blocked funds for the owner.
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${id}`)
    } catch (err) {
      console.log("[v0] admin hold release failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal revoked",
        body: `Your commodity deal "${existing.title}" was revoked by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. The reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] admin revoke notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator revoked commodity deal "${existing.title}" for ${target.fullName} and released reserved funds`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: existing.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Revoked",
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] admin revoke activity log failed:", (err as Error).message)
    }

    return { ok: true, request: revoked }
  } catch (err) {
    console.log("[v0] adminRevokeCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be revoked. Please try again." }
  }
}

/**
 * Administrator REVERSES an authorized (approved) monetization. This fully
 * unwinds the facility:
 *   1. Flips the DB approval to `cancelled` (via adminRevokeApprovedApproval), so
 *      the reconcile/backfill sweep — which only re-posts `approved` records —
 *      will never re-credit the proceeds again.
 *   2. Deletes the `APPR-<id>` proceeds credit from the balance owner's ledger,
 *      debiting the advanced funds back out. Per policy this is allowed to push
 *      the currency balance negative (the proceeds may already be spent).
 *   3. Stops all FUTURE monthly debit interest — the monetization interest
 *      reconciler only charges facilities whose status is `approved`, so a
 *      `cancelled` one is skipped. Interest ALREADY charged for elapsed months is
 *      intentionally left in place, mirroring the commodity-revoke policy.
 *   4. Releases the instrument pledge — the client's `isMonetized` gate frees a
 *      `reversed` request, so the underlying bank instrument becomes
 *      transferable / re-monetizable again.
 */
export async function adminReverseMonetization(
  passcode: string,
  id: string,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Monetization not found." }
    if (existing.kind !== "monetization") {
      return { ok: false, error: "Only monetizations can be reversed here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an authorized monetization can be reversed." }
    }

    const reversed = await adminRevokeApprovedApproval(id, note)
    if (!reversed) return { ok: false, error: "This monetization can no longer be reversed." }

    // Debit the advanced proceeds back out by removing the approval credit from
    // the shared-data owner's ledger (Master for a sub-account).
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${id}`)
    } catch (err) {
      console.log("[v0] monetization proceeds reversal failed:", (err as Error).message)
    }

    const amountLabel =
      existing.amount != null ? formatMoney(existing.amount, existing.currency ?? "") : "the advanced proceeds"

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "warning",
        title: "Monetization reversed",
        body: `Your monetization "${existing.title}" was reversed by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. ${amountLabel} has been debited back from your Master Account and the underlying instrument has been released. Monthly debit interest has stopped; interest already charged remains.`,
        href: KIND_HREF.monetization ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] monetization reversal notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator reversed monetization "${existing.title}" for ${target.fullName} and debited back the advanced proceeds`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: existing.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Reversed",
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] monetization reversal activity log failed:", (err as Error).message)
    }

    return { ok: true, request: reversed }
  } catch (err) {
    console.log("[v0] adminReverseMonetization failed:", (err as Error).message)
    return { ok: false, error: "The monetization could not be reversed. Please try again." }
  }
}

// --- Admin: share a commodity deal (read-only) with other clients ----------

export interface ShareDealResult {
  ok: boolean
  error?: string
  sharedWith?: { name: string; email: string }[]
}

/**
 * Administrator SHARES an existing commodity deal with one or more other clients
 * for visibility only. Each recipient gets an independent, read-only COPY in
 * their own Commodity Transactions — born approved, marked `sharedReadOnly` so
 * `ledgerEntryForApproval` returns null and it NEVER touches their balance (no
 * hold, credit or settlement, ever, including on reconcile/backfill). The
 * original owner's deal is untouched apart from an append-only `sharedWith`
 * audit entry. Recipients cannot mutate the copy (guards below refuse it).
 */
export async function adminShareCommodityDeal(
  passcode: string,
  sourceId: string,
  recipientIds: string[],
): Promise<ShareDealResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const ids = Array.from(
    new Set((recipientIds ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)),
  )
  if (ids.length === 0) return { ok: false, error: "Select at least one recipient to share with." }

  try {
    const source = await getApprovalById(sourceId)
    if (!source) return { ok: false, error: "Deal not found." }
    if (source.kind !== "commodity") return { ok: false, error: "Only commodity deals can be shared." }

    const record = (source.payload?.record ?? {}) as Record<string, unknown>
    if (!record || typeof record !== "object" || !(record as { id?: unknown }).id) {
      return { ok: false, error: "This deal has no shareable detail record." }
    }

    const sourceOwnerId = await resolveDataOwnerIdFor(source.userId)
    const sharerName = "MCC Capital"
    const shared: { name: string; email: string }[] = []

    for (const rid of ids) {
      let recipientOwnerId: string
      try {
        recipientOwnerId = await resolveDataOwnerIdFor(rid)
      } catch {
        continue
      }
      // Never share a deal back onto its own owner.
      if (recipientOwnerId === sourceOwnerId) continue

      // Idempotency: skip if this recipient already holds a shared copy of this
      // exact source deal, so repeated shares never pile up duplicates.
      try {
        const existingForUser = await listApprovalsForUser(recipientOwnerId)
        const already = existingForUser.some(
          (a) =>
            a.kind === "commodity" &&
            (a.payload as { sourceApprovalId?: string } | undefined)?.sourceApprovalId === source.id,
        )
        if (already) continue
      } catch {
        // If the lookup fails, fall through and create the copy anyway.
      }

      const profile = await resolveAccountProfileById(recipientOwnerId)

      // Read-only snapshot of the deal record; the store detects these markers
      // and renders it non-interactive.
      const sharedRecord = { ...record, readOnly: true, shared: true, sharedFromName: sharerName }

      const created = await insertApproval({
        userId: recipientOwnerId,
        kind: "commodity",
        title: source.title,
        summary: `${source.summary || source.title} — shared with you by ${sharerName} for visibility (read-only).`,
        amount: source.amount,
        currency: source.currency,
        payload: {
          record: sharedRecord,
          sharedReadOnly: true,
          sharedFromUserId: source.userId,
          sharedFromName: sharerName,
          sourceApprovalId: source.id,
        },
      })
      await decideApproval(created.id, "approved", "Shared by administrator (read-only)")

      try {
        await insertNotification({
          userId: recipientOwnerId,
          tone: "info",
          title: "Commodity deal shared with you",
          body: `${sharerName} shared the commodity deal "${source.title}" with you for visibility. It appears in your Commodity Transactions as read-only.`,
          href: KIND_HREF.commodity ?? "/dashboard/commodity",
        })
      } catch (err) {
        console.log("[v0] share notification failed:", (err as Error).message)
      }

      shared.push({ name: profile.fullName || profile.email, email: profile.email })
    }

    if (shared.length === 0) {
      return { ok: false, error: "No new recipients received this deal (already shared or invalid)." }
    }

    // Append-only share audit on the source deal (owner-visible provenance).
    try {
      const prevShared = (source.payload?.sharedWith as unknown[] | undefined) ?? []
      const nowIso = new Date().toISOString()
      const additions = shared.map((s) => ({ name: s.name, email: s.email, at: nowIso }))
      await updateApprovalPayload(source.id, {
        ...(source.payload ?? {}),
        sharedWith: [...prevShared, ...additions],
      })
    } catch (err) {
      console.log("[v0] share source payload update failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(source.userId)
      await logActivity({
        action: `Administrator shared commodity deal "${source.title}" with ${shared.length} recipient(s)`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: source.id,
          owner: `${target.fullName} — ${target.email}`,
          recipients: shared.map((s) => `${s.name} — ${s.email}`).join("; "),
          effect: "Read-only visibility copy (no financial effect)",
          action: "Shared",
        },
      })
    } catch (err) {
      console.log("[v0] share activity log failed:", (err as Error).message)
    }

    return { ok: true, sharedWith: shared }
  } catch (err) {
    console.log("[v0] adminShareCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be shared. Please try again." }
  }
}

export interface SharedDealView {
  ok: boolean
  error?: string
  sharedApprovalId?: string
  sharedFromName?: string
  sharedAt?: string
  /** True when the owner's original deal can no longer be found: we fall back
   *  to the snapshot captured at share time. */
  sourceMissing?: boolean
  live?: {
    /** The deal record — LIVE from the owner's deal when available, so vessel
     *  stage, documents, SWIFT refs and settlement reflect the current state. */
    record: Record<string, unknown>
    status: string
    decidedAt?: string
    decisionNote?: string
    delivered: boolean
    deliveredAt?: string
    submittedAt?: string
  }
}

/**
 * Read a deal that an administrator shared (read-only) with the signed-in
 * client, resolving the LIVE state from the owner's original deal so the
 * recipient always sees the current documents, workflow/vessel stage, SWIFT
 * exchange and payment/settlement status — not a frozen copy.
 *
 * Security: the caller must own the shared copy (`shared.userId` maps to their
 * data owner) and it must actually be a `sharedReadOnly` commodity row. Only
 * then do we dereference `sourceApprovalId` to read the owner's live record.
 * Nothing here mutates state or touches any balance.
 */
export async function getSharedDealView(sharedApprovalId: string): Promise<SharedDealView> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "You must be signed in to view this deal." }

  try {
    const ownerId = await resolveDataOwnerIdFor(session.id)
    const shared = await getApprovalById(sharedApprovalId)
    if (!shared) return { ok: false, error: "This shared deal could not be found." }

    const sharedPayload = (shared.payload ?? {}) as {
      sharedReadOnly?: boolean
      sharedFromName?: string
      sourceApprovalId?: string
      record?: Record<string, unknown>
    }

    // Must be the recipient of this shared copy, and it must be a shared row.
    if (shared.userId !== ownerId || sharedPayload.sharedReadOnly !== true) {
      return { ok: false, error: "You do not have access to this deal." }
    }

    const sharedFromName = sharedPayload.sharedFromName || "MCC Capital"
    const sharedAt = shared.decidedAt ?? shared.createdAt

    // Prefer the owner's LIVE deal; fall back to the shared snapshot if the
    // original has since been removed.
    const source = sharedPayload.sourceApprovalId
      ? await getApprovalById(sharedPayload.sourceApprovalId)
      : null

    if (source) {
      const srcPayload = (source.payload ?? {}) as {
        record?: Record<string, unknown>
        delivered?: boolean
        deliveredAt?: string
      }
      return {
        ok: true,
        sharedApprovalId: shared.id,
        sharedFromName,
        sharedAt,
        live: {
          record: srcPayload.record ?? {},
          status: source.status,
          decidedAt: source.decidedAt ?? undefined,
          decisionNote: source.decisionNote ?? undefined,
          delivered: srcPayload.delivered === true,
          deliveredAt: srcPayload.deliveredAt,
          submittedAt: source.createdAt,
        },
      }
    }

    // Snapshot fallback.
    return {
      ok: true,
      sharedApprovalId: shared.id,
      sharedFromName,
      sharedAt,
      sourceMissing: true,
      live: {
        record: sharedPayload.record ?? {},
        status: shared.status,
        decidedAt: shared.decidedAt ?? undefined,
        decisionNote: shared.decisionNote ?? undefined,
        delivered: (shared.payload as { delivered?: boolean } | undefined)?.delivered === true,
        deliveredAt: (shared.payload as { deliveredAt?: string } | undefined)?.deliveredAt,
        submittedAt: shared.createdAt,
      },
    }
  } catch (err) {
    console.log("[v0] getSharedDealView failed:", (err as Error).message)
    return { ok: false, error: "This deal could not be loaded. Please try again." }
  }
}

// --- Admin: deal documents (real PDFs) + vessel ----------------------------

/** Minimal shape of a stored deal-document version (mirrors the client store). */
interface StoredDocVersion {
  version: number
  fileName: string
  reference: string
  issuedBy: string
  issueDate: string
  notes: string
  uploadedAt: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}
interface StoredDoc {
  id: string
  module: "POP" | "POF" | "DEAL"
  docType: string
  status: "submitted" | "verified" | "rejected"
  currentVersion: number
  versions: StoredDocVersion[]
  swiftRef?: string
  decidedAt?: string
  decisionNote?: string
}

export interface DealDocInput {
  docType: string
  reference?: string
  issuedBy?: string
  issueDate?: string
  notes?: string
  swiftRef?: string
  fileName: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}

/**
 * Load an approved commodity deal for admin document/vessel management, refusing
 * shared read-only copies (those are visibility-only mirrors — never mutate them,
 * always operate on the owner's source deal).
 */
async function loadCommodityForAdmin(
  id: string,
): Promise<{ ok: true; req: ApprovalRequest; record: Record<string, unknown> } | { ok: false; error: string }> {
  const existing = await getApprovalById(id)
  if (!existing) return { ok: false, error: "Deal not found." }
  if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals are supported here." }
  if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
    return { ok: false, error: "This is a shared read-only copy. Manage the original deal instead." }
  }
  const record = ((existing.payload?.record ?? {}) as Record<string, unknown>) || {}
  return { ok: true, req: existing, record }
}

async function persistRecord(req: ApprovalRequest, record: Record<string, unknown>): Promise<void> {
  await updateApprovalPayload(req.id, { ...(req.payload ?? {}), record })
}

async function notifyOwnerDoc(req: ApprovalRequest, title: string, body: string): Promise<void> {
  try {
    await insertNotification({
      userId: req.userId,
      tone: "info",
      title,
      body,
      href: KIND_HREF.commodity ?? "/dashboard/commodity",
    })
  } catch (err) {
    console.log("[v0] deal-doc notification failed:", (err as Error).message)
  }
}

async function logDeal(req: ApprovalRequest, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    const target = await resolveAccountProfileById(req.userId)
    await logActivity({
      action,
      category: "Administration / Approvals",
      user: "Administrator",
      details: { referenceId: req.id, owner: `${target.fullName} — ${target.email}`, ...details },
    })
  } catch (err) {
    console.log("[v0] deal activity log failed:", (err as Error).message)
  }
}

/**
 * Administrator adds (or re-versions) a DEAL document on an approved commodity
 * deal. The PDF binary lives in private Blob; here we persist its metadata +
 * pathname onto the owner's deal record so it surfaces live (read-only) to the
 * deal owner and any shared-deal recipients. No balance/ledger effect.
 */
export async function adminAddDealDocument(
  passcode: string,
  id: string,
  input: DealDocInput,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!input?.docType?.trim()) return { ok: false, error: "A document type is required." }
  if (!input?.fileName?.trim()) return { ok: false, error: "A file is required." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const now = new Date().toISOString()
    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const version: StoredDocVersion = {
      version: 1,
      fileName: input.fileName.trim(),
      reference: (input.reference ?? "").trim(),
      issuedBy: (input.issuedBy ?? "").trim(),
      issueDate: (input.issueDate ?? "").trim(),
      notes: (input.notes ?? "").trim(),
      uploadedAt: now,
      blobPathname: input.blobPathname,
      fileSize: input.fileSize,
      contentType: input.contentType,
    }
    const doc: StoredDoc = {
      id: `DDOC-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      module: "DEAL",
      docType: input.docType.trim(),
      status: "submitted",
      currentVersion: 1,
      versions: [version],
      swiftRef: input.swiftRef?.trim() || undefined,
    }
    record.documents = [...docs, doc]
    await persistRecord(req, record)

    await notifyOwnerDoc(
      req,
      "New deal document available",
      `MCC Capital added "${doc.docType}" to your commodity deal "${req.title}". Open the deal to view the document.`,
    )
    await logDeal(req, `Administrator added deal document "${doc.docType}" to "${req.title}"`, {
      document: doc.docType,
      fileName: version.fileName,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be saved." }
  } catch (err) {
    console.log("[v0] adminAddDealDocument failed:", (err as Error).message)
    return { ok: false, error: "The document could not be added. Please try again." }
  }
}

/** Administrator sets a deal document's verification status. */
export async function adminSetDealDocumentStatus(
  passcode: string,
  id: string,
  documentId: string,
  status: "submitted" | "verified" | "rejected",
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const idx = docs.findIndex((d) => d.id === documentId)
    if (idx === -1) return { ok: false, error: "Document not found on this deal." }
    docs[idx] = { ...docs[idx], status, decidedAt: new Date().toISOString(), decisionNote: note?.trim() || undefined }
    record.documents = docs
    await persistRecord(req, record)

    await logDeal(req, `Administrator marked deal document "${docs[idx].docType}" as ${status} on "${req.title}"`, {
      document: docs[idx].docType,
      status,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be updated." }
  } catch (err) {
    console.log("[v0] adminSetDealDocumentStatus failed:", (err as Error).message)
    return { ok: false, error: "The document status could not be updated. Please try again." }
  }
}

/** Administrator removes a deal document from an approved commodity deal. */
export async function adminRemoveDealDocument(
  passcode: string,
  id: string,
  documentId: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const removed = docs.find((d) => d.id === documentId)
    if (!removed) return { ok: false, error: "Document not found on this deal." }
    record.documents = docs.filter((d) => d.id !== documentId)
    await persistRecord(req, record)

    await logDeal(req, `Administrator removed deal document "${removed.docType}" from "${req.title}"`, {
      document: removed.docType,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be removed." }
  } catch (err) {
    console.log("[v0] adminRemoveDealDocument failed:", (err as Error).message)
    return { ok: false, error: "The document could not be removed. Please try again." }
  }
}

/**
 * Administrator attaches (and verifies) a vessel to an approved commodity deal.
 * Reuses the existing IMO check-digit validation + free OFAC sanctions screening
 * and the vessel catalogue. A denormalised snapshot (with its compliance verdict)
 * is stored on the deal so it surfaces live/read-only to the owner and shared
 * recipients. No balance effect.
 */
export async function adminAttachDealVessel(
  passcode: string,
  id: string,
  imo: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const clean = (imo ?? "").trim()
  if (!/^\d{7}$/.test(clean)) return { ok: false, error: "IMO number must be exactly 7 digits." }
  if (!isValidImo(clean)) {
    return { ok: false, error: "That IMO fails the official check-digit validation — it is not a real IMO number." }
  }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    // Prefer the catalogue record (richer identity data) and refresh its OFAC
    // screening; otherwise resolve via public registry + screening.
    let snapshot: Vessel
    const existing = await dbGetVessel(clean)
    if (existing) {
      const compliance = await screenVesselImo(clean)
      snapshot = { ...existing, compliance, updatedAt: new Date().toISOString() }
    } else {
      const res = await fetchVesselByImo(clean)
      if ("error" in res) return { ok: false, error: res.error }
      snapshot = res.vessel
    }

    record.vessel = snapshot
    await persistRecord(req, record)

    const verdict =
      snapshot.compliance?.status === "flagged"
        ? "FLAGGED on sanctions screening"
        : snapshot.compliance?.status === "unverified"
          ? "screening unverified"
          : "clear on sanctions screening"

    await notifyOwnerDoc(
      req,
      "Vessel assigned to your deal",
      `MCC Capital assigned the vessel "${snapshot.name}" (IMO ${snapshot.imo}) to your commodity deal "${req.title}".`,
    )
    await logDeal(req, `Administrator assigned vessel ${snapshot.name} (IMO ${snapshot.imo}) to "${req.title}"`, {
      vessel: snapshot.name,
      imo: snapshot.imo,
      vesselType: VESSEL_TYPE_LABELS[snapshot.type],
      compliance: verdict,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The vessel could not be assigned." }
  } catch (err) {
    console.log("[v0] adminAttachDealVessel failed:", (err as Error).message)
    return { ok: false, error: "The vessel could not be assigned. Please try again." }
  }
}

/** Administrator detaches the vessel from an approved commodity deal. */
export async function adminDetachDealVessel(passcode: string, id: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded
    const prev = record.vessel as Vessel | undefined
    delete record.vessel
    await persistRecord(req, record)
    if (prev) {
      await logDeal(req, `Administrator removed vessel ${prev.name} (IMO ${prev.imo}) from "${req.title}"`, {
        vessel: prev.name,
        imo: prev.imo,
      })
    }
    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The vessel could not be removed." }
  } catch (err) {
    console.log("[v0] adminDetachDealVessel failed:", (err as Error).message)
    return { ok: false, error: "The vessel could not be removed. Please try again." }
  }
}

/**
 * The signed-in Master's consent queue: Sub-account requests routed to them for
 * a second-gate decision. `pendingOnly` returns just those still awaiting the
 * Master's verdict (used for the badge/queue), otherwise the full history.
 */
export async function getMyMasterApprovalQueue(opts?: { pendingOnly?: boolean }): Promise<ApprovalRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    return await listApprovalsForMaster(session.id, opts)
  } catch (err) {
    console.log("[v0] getMyMasterApprovalQueue failed:", (err as Error).message)
    return []
  }
}

/**
 * Record the signed-in MASTER's verdict (second gate) for a Sub-account
 * request. The money movement applies here when the Master's approval is the
 * final gate (the admin already approved). The caller must be the request's
 * designated Master — enforced from the session, not the client.
 */
export async function masterDecideApproval(
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, error: "A reason is required to reject a request." }
  }

  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Request not found." }
    if (existing.masterId !== session.id || !existing.requiresMasterApproval) {
      return { ok: false, error: "You are not authorized to decide this request." }
    }
    if (existing.status !== "pending" && existing.status !== "awaiting_master") {
      return { ok: false, error: "This request has already been decided." }
    }

    // HARD fund-availability gate at the Master's (final) approval — balances may
    // have changed since the administrator's gate. If the reservation can no
    // longer be covered, AUTO-REJECT, notify the sub-account, log it, and tell
    // the Master, so money never moves into a negative balance.
    if (decision === "approved") {
      const assessment = await assessReservation(existing)
      if (assessment.required && !assessment.feasible) {
        const reason = assessment.message
        const rejected = await recordMasterDecision(id, session.id, "rejected", reason)
        const finalReq = rejected ?? existing
        try {
          await insertNotification({
            userId: finalReq.userId,
            tone: "warning",
            title: `${KIND_LABELS[finalReq.kind]} declined — insufficient funds`,
            body: `Your ${KIND_LABELS[finalReq.kind].toLowerCase()} "${finalReq.title}" was automatically declined: the account lacks sufficient available balance to reserve the required funds. ${reason}`,
            href: KIND_HREF[finalReq.kind] ?? null,
          })
        } catch (err) {
          console.log("[v0] master insufficient-funds notification failed:", (err as Error).message)
        }
        try {
          const target = await resolveAccountProfileById(finalReq.userId)
          await logActivity({
            action: `Auto-declined a ${KIND_LABELS[finalReq.kind]} request from ${target.fullName} — insufficient funds`,
            category: "Account Hierarchy / Approvals",
            user: session.profile.fullName,
            details: {
              referenceId: finalReq.id,
              subAccount: `${target.fullName} — ${target.email}`,
              summary: finalReq.summary || finalReq.title,
              amount: finalReq.amount != null ? formatMoney(finalReq.amount, finalReq.currency ?? "") : "(n/a)",
              decision: "rejected (insufficient funds)",
              reason,
            },
          })
        } catch (err) {
          console.log("[v0] master insufficient-funds audit log failed:", (err as Error).message)
        }
        return { ok: false, error: reason }
      }
    }

    const updated = await recordMasterDecision(id, session.id, decision, note)
    if (!updated) return { ok: false, error: "This request has already been decided." }

    // Apply money movement only when BOTH gates have now cleared.
    if (updated.status === "approved") {
      try {
        await applyLedgerEffect(updated)
      } catch (err) {
        console.log("[v0] applyLedgerEffect (master gate) failed:", (err as Error).message)
      }
    }

    // Notify the initiating Sub-account of the Master's verdict.
    const label = KIND_LABELS[updated.kind]
    const fullyApproved = updated.status === "approved"
    try {
      await insertNotification({
        userId: updated.userId,
        tone: decision === "approved" ? (fullyApproved ? "success" : "info") : "warning",
        title:
          decision === "approved"
            ? fullyApproved
              ? `${label} approved`
              : `${label} awaiting administrator`
            : `${label} declined by Master`,
        body:
          decision === "approved"
            ? fullyApproved
              ? `Your ${label.toLowerCase()} "${updated.title}" was approved by your Master account and has been executed.`
              : `Your Master account approved "${updated.title}"; it now awaits administrator approval.`
            : `Your ${label.toLowerCase()} "${updated.title}" was declined by your Master account. Reason: ${note?.trim()}`,
        href: KIND_HREF[updated.kind] ?? null,
      })
    } catch (err) {
      console.log("[v0] master decision notification failed:", (err as Error).message)
    }

    // Audit trail.
    const target = await resolveAccountProfileById(updated.userId)
    await logActivity({
      action: `Master ${session.profile.fullName} ${decision} a ${label} request from ${target.fullName}`,
      category: "Account Hierarchy / Approvals",
      user: session.profile.fullName,
      details: {
        referenceId: updated.id,
        subAccount: `${target.fullName} — ${target.email}`,
        summary: updated.summary || updated.title,
        amount: updated.amount != null ? `${updated.currency ?? ""} ${updated.amount.toLocaleString("en-US")}` : "(n/a)",
        decision,
        reason: note?.trim() || "(none)",
      },
    })

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] masterDecideApproval failed:", (err as Error).message)
    return { ok: false, error: "The decision could not be recorded. Please try again." }
  }
}

/**
 * Issue a bank instrument directly into a client's portfolio (administrator
 * only). Clients can no longer self-create instruments; issuance is an
 * administrator-controlled act. This records an `instrument` approval for the
 * target client that is born already-approved and carries the full instrument
 * in its payload, so the client's instrument store can materialise it as an
 * active holding on its next reconcile — durable and visible cross-device.
 */
export type IssueInstrumentResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

export async function adminIssueInstrument(
  passcode: string,
  userId: string,
  instrument: Record<string, unknown>,
): Promise<IssueInstrumentResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!userId) return { ok: false, error: "Select a client to issue to." }

  const id = String(instrument?.id ?? "").trim()
  const issuer = String(instrument?.issuer ?? "").trim()
  const typeFull = String(instrument?.typeFull ?? instrument?.type ?? "Bank Instrument").trim()
  const currency = String(instrument?.currency ?? "USD").trim()
  const faceValue = Number(instrument?.faceValue ?? 0)
  if (!id) return { ok: false, error: "The instrument is missing an identifier." }
  if (!issuer) return { ok: false, error: "An issuing bank is required." }
  if (!Number.isFinite(faceValue) || faceValue <= 0) {
    return { ok: false, error: "Enter a valid face value greater than 0." }
  }

  try {
    // Born pending, then immediately decided approved by the administrator, so
    // it shares the exact same audit + notification path as any other decision.
    const created = await insertApproval({
      userId,
      kind: "instrument",
      title: `${typeFull} · ${issuer}`,
      summary: `${currency} ${faceValue.toLocaleString("en-US")} ${typeFull} issued by ${issuer} (administrator issuance).`,
      amount: faceValue,
      currency,
      // The full instrument travels in the payload so the client can materialise
      // it. `issuedByAdmin` marks it as a brand-new holding (not a reconcile of
      // a client-originated request).
      payload: { issuedByAdmin: true, instrument },
    })

    const decided = await decideApproval(created.id, "approved", "Administrator")
    const request = decided ?? created

    try {
      await insertNotification({
        userId,
        tone: "success",
        title: "Bank instrument issued",
        body: `MCC Capital issued a ${typeFull} of ${currency} ${faceValue.toLocaleString("en-US")} (${issuer}) to your portfolio.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] issue notification failed:", (err as Error).message)
    }

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator issued a ${typeFull} (${currency} ${faceValue.toLocaleString("en-US")}) to ${target.fullName}`,
      category: "Administration / Instruments",
      user: "Administrator",
      details: {
        referenceId: id,
        targetAccount: `${target.fullName} — ${target.email}`,
        instrument: `${typeFull} — ${issuer}`,
        faceValue: `${currency} ${faceValue.toLocaleString("en-US")}`,
        action: "Issued",
      },
    })

    return { ok: true, request }
  } catch (err) {
    console.log("[v0] adminIssueInstrument failed:", (err as Error).message)
    return { ok: false, error: "The instrument could not be issued. Please try again." }
  }
}

// --- Client-to-client instrument transfer ----------------------------------

export type TransferInstrumentResult =
  | { ok: true; recipientName: string; recipientEmail: string }
  | { ok: false; error: string }

/**
 * Transfer an ACTIVE bank instrument the signed-in client holds to another
 * platform account, identified by registered email. The instrument moves
 * immediately (no desk approval): it is issued into the recipient's portfolio
 * as an active holding (born pending → instantly approved, exactly like
 * administrator issuance) and removed from the sender's active holdings (marked
 * "Transferred"). This is a cross-user write, so every guard is enforced
 * server-side: the caller must own an active instrument, the recipient must be
 * a distinct active account, and the source record is moved race-safely so the
 * same instrument can never be duplicated across two concurrent transfers.
 */
export async function transferMyInstrument(
  approvalId: string,
  recipientEmail: string,
): Promise<TransferInstrumentResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const email = (recipientEmail ?? "").trim()
  if (!email) return { ok: false, error: "Enter the recipient's account email." }

  // The source must exist, be an instrument, belong to THIS holder's portfolio,
  // and be active (approved). Anything else is rejected.
  const senderOwnerId = session.dataOwnerId
  const record = await getApprovalById(approvalId)
  if (!record || record.kind !== "instrument") {
    return { ok: false, error: "Instrument not found." }
  }
  if (record.userId !== senderOwnerId) {
    return { ok: false, error: "You can only transfer instruments held in your own portfolio." }
  }
  if (record.status !== "approved") {
    return { ok: false, error: "Only active instruments can be transferred." }
  }

  // Resolve the recipient — must be an active account, and not the sender.
  const recipient = await getDynamicUserByEmail(email)
  if (!recipient || recipient.status !== "active") {
    return { ok: false, error: "No active account is registered with that email." }
  }
  const recipientOwnerId = await resolveDataOwnerIdFor(recipient.id)
  if (recipientOwnerId === senderOwnerId) {
    return { ok: false, error: "This instrument is already in that portfolio." }
  }

  // Pull the full instrument view-model out of the existing payload (admin-issued
  // instruments carry it under `instrument`; client-originated under `record`).
  const payload = (record.payload ?? {}) as {
    record?: Record<string, unknown>
    instrument?: Record<string, unknown>
    issuedByAdmin?: boolean
  }
  const base = (payload.issuedByAdmin ? payload.instrument : payload.record ?? payload.instrument) ?? {}
  const instrument = { ...base, status: "active" }
  const instrumentId = String((base as { id?: unknown }).id ?? approvalId)

  const recipientProfile = await resolveAccountProfileById(recipientOwnerId)
  const recipientLabel = recipientProfile.fullName || recipient.email
  const senderName = session.profile.fullName || session.profile.company || session.profile.email

  try {
    // 1) Issue into the recipient's portfolio (born pending → approved).
    const created = await insertApproval({
      userId: recipientOwnerId,
      kind: "instrument",
      title: record.title,
      summary: `${record.summary} — transferred from ${senderName}.`,
      amount: record.amount,
      currency: record.currency,
      payload: { issuedByAdmin: true, instrument, transferredFrom: senderName },
    })
    await decideApproval(created.id, "approved", "Instrument transfer")

    // 2) Remove from the sender's active holdings (marked Transferred). Race-safe
    //    and ownership-scoped — only acts while still approved and owned by sender.
    const moved = await markApprovalTransferred(approvalId, senderOwnerId, recipientLabel)
    if (!moved) {
      // The source changed under us (already transferred). Roll back the
      // recipient issuance so the instrument is never duplicated.
      await adminRevokeApprovedApproval(created.id, "Transfer rolled back — source no longer transferable.")
      return { ok: false, error: "This instrument is no longer available to transfer." }
    }

    // 3) Notify the recipient so it surfaces in their alerts.
    try {
      await insertNotification({
        userId: recipientOwnerId,
        tone: "success",
        title: "Bank instrument received",
        body: `${senderName} transferred a ${record.title} to your portfolio.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] transfer notification failed:", (err as Error).message)
    }

    await logActivity({
      action: `Transferred ${record.title} to ${recipientLabel}`,
      category: "Bank Instruments",
      user: senderName,
      details: {
        summary: `Client transferred the bank instrument ${instrumentId} (${record.currency ?? ""} ${(record.amount ?? 0).toLocaleString("en-US")}) to ${recipientLabel} — ${recipient.email}. The instrument left the sender's portfolio and is now active for the recipient.`,
        referenceId: instrumentId,
        recipient: `${recipientLabel} — ${recipient.email}`,
        faceValue: `${record.currency ?? ""} ${(record.amount ?? 0).toLocaleString("en-US")}`,
        action: "Transferred",
      },
    })

    return { ok: true, recipientName: recipientLabel, recipientEmail: recipient.email }
  } catch (err) {
    console.log("[v0] transferMyInstrument failed:", (err as Error).message)
    return { ok: false, error: "The transfer could not be completed. Please try again." }
  }
}

export interface BulkDecideResult {
  ok: boolean
  decided: number
  failed: number
}

/** Approve or reject many requests at once (e.g. from multi-select). */
export async function adminBulkDecide(
  passcode: string,
  ids: string[],
  decision: "approved" | "rejected",
  note?: string,
): Promise<BulkDecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, decided: 0, failed: ids.length }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, decided: 0, failed: ids.length }
  }
  let decided = 0
  let failed = 0
  for (const id of ids) {
    const res = await adminDecideApproval(passcode, id, decision, note)
    if (res.ok) decided++
    else failed++
  }
  return { ok: failed === 0, decided, failed }
}
