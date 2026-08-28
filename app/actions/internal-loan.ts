"use server"

/**
 * Internal Lending — a plain internal loan a customer can request for ANY
 * amount, that the administrator evaluates (risk + repayment) and approves.
 *
 * This is DISTINCT from:
 *   - Treasury "Capital Lending" (which finances the security DEPOSIT), and
 *   - the AES / Treuhand private-investment scenario.
 *
 * On administrator approval the principal is credited IMMEDIATELY to the
 * borrower's Master Account. The loan carries 3% p.a. debit interest by default
 * (the administrator can override the rate) plus an optional one-time
 * arrangement fee set by the administrator. The borrower repays, partially or
 * in full, from their Master balance via `repayInternalLoan` (self-service).
 *
 * Design mirrors the self-contained `trading_fund` product: the loan lives in
 * `approval_requests`, and ALL money movement is posted to the ledger with
 * DETERMINISTIC, idempotent entry ids so retries / concurrent reads can never
 * double-post:
 *   - `ILOAN-<id>`            principal credit to the Master (on approval)
 *   - `ILOAN-FEE-<id>`        one-time arrangement fee debit (on approval)
 *   - `ILOAN-INT-<id>-M<n>`   monthly interest debit (reconciled server-side)
 *   - `ILOAN-REPAY-<id>-<k>`  a repayment debit (self-service)
 */

import {
  resolveCurrentSession,
  resolveDataOwnerIdFor,
  resolveEnvironmentMemberIds,
  resolveAccountProfileById,
} from "@/lib/session-user"
import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  getApprovalById,
  insertApproval,
  listAllApprovals,
  listApprovalsForUser,
  recordAdminDecision,
  updateApprovalPayload,
} from "@/lib/approvals-db"
import {
  readLedgerEntries,
  upsertLedgerEntry,
  availableByCurrency,
} from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
import { getOverdraftStatusForOwner } from "@/lib/overdraft"
import { insertNotification } from "@/lib/notifications-db"
import { logActivity } from "@/app/actions/log-activity"
import { getGuaranteeConfig } from "@/lib/guarantees-config-db"
import { gatherGuaranteeProfile } from "@/lib/guarantees-profile"
import { guaranteeBlockMessage } from "@/lib/guarantees-accumulator"
import {
  readInternalLoanTerms,
  outstandingInternalLoan,
  internalLoanCreditId,
  internalLoanFeeId,
  internalLoanRepayId,
  formatLoanMoney,
  INTERNAL_LOAN_DEFAULT_RATE,
  INTERNAL_LOAN_DEFAULT_CURRENCY,
  type InternalLoanTerms,
} from "@/lib/internal-loan"

/** An internal-loan approval as the administrator panel needs it. */
export interface AdminInternalLoan {
  approvalId: string
  userId: string
  holder: string
  company: string
  email: string
  status: string
  requestedAmount: number
  currency: string
  purpose: string
  repaymentPlan: string
  collateralNote: string
  /** Pledged bank instrument acting as collateral, if any (label + id). */
  collateralInstrumentId: string
  collateralInstrumentLabel: string
  createdAt: string
  decidedAt: string | null
  /**
   * When the administrator first opened the discussion with the borrower.
   * Funding is BLOCKED until this is set — negotiation is mandatory.
   */
  discussionOpenedAt: string | null
  /** Effective terms once approved (rate/fee/activation). */
  terms: InternalLoanTerms | null
  outstanding: number
}

// ---------------------------------------------------------------------------
// Client: apply for an internal loan
// ---------------------------------------------------------------------------

export type ApplyLoanResult =
  | { ok: true; approvalId: string }
  | { ok: false; error: string }

export async function applyForInternalLoan(input: {
  amount: number
  currency?: string
  purpose?: string
  repaymentPlan?: string
  collateralNote?: string
  /** Optional pledged bank instrument acting as collateral (locked while live). */
  collateralInstrumentId?: string
  collateralInstrumentLabel?: string
}): Promise<ApplyLoanResult> {
  const session = await resolveCurrentSession()
  if (!session?.id) return { ok: false, error: "Your session has expired. Please sign in again." }
  const holder = session.profile?.fullName ?? "Account holder"
  const companyName = session.profile?.company ?? "—"

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid loan amount greater than 0." }
  }
  const currency = (input.currency || INTERNAL_LOAN_DEFAULT_CURRENCY).toUpperCase()
  const purpose = (input.purpose || "").trim()
  const repaymentPlan = (input.repaymentPlan || "").trim()
  const collateralNote = (input.collateralNote || "").trim()
  const collateralInstrumentId = (input.collateralInstrumentId || "").trim()
  const collateralInstrumentLabel = (input.collateralInstrumentLabel || "").trim()

  // If a bank instrument is pledged as collateral, make sure it is not already
  // committed to another LIVE internal loan (a pledged instrument is locked
  // until that loan is repaid). This is the authoritative double-pledge guard;
  // the client picker also hides in-use instruments. Best-effort — a read
  // failure must not block a legitimate application.
  if (collateralInstrumentId) {
    try {
      const mine = await listApprovalsForUser(session.id, "internal_loan")
      const alreadyPledged = mine.some((r) => {
        const rec = (r.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}
        if (rec.collateralInstrumentId !== collateralInstrumentId) return false
        // Live = pending, or approved and not yet repaid/settled.
        if (r.status === "pending") return true
        if (r.status === "approved" && !rec.settledAt && rec.status !== "closed") return true
        return false
      })
      if (alreadyPledged) {
        return {
          ok: false,
          error:
            "That instrument is already pledged as collateral on another active internal loan. " +
            "Release it by repaying that loan before pledging it again.",
        }
      }
    } catch (err) {
      console.log("[v0] internal-loan collateral double-pledge check failed (allowing):", (err as Error).message)
    }
  }

  // Guarantees Accumulator — HIGH-RISK gate. An internal loan is new debt/
  // exposure, so it is refused in real time while the account is classified
  // High Risk. FAILS OPEN on any error (policy control, not the solvency guard).
  try {
    const config = await getGuaranteeConfig()
    if (config.enforce) {
      const { score, overdraft } = await gatherGuaranteeProfile(session.id, config)
      if (overdraft.inOverdraft) {
        const eur = (n: number) =>
          `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        return {
          ok: false,
          error:
            `An internal loan cannot be opened while your Master Account is in a controlled overdraft ` +
            `(currently ${eur(overdraft.negativeEur)} negative). Clear the overdraft by funding your account, then try again.`,
        }
      }
      if (score.highRisk) {
        return { ok: false, error: guaranteeBlockMessage(score, config.highRiskThreshold, "an internal loan") }
      }
    }
  } catch (err) {
    console.log("[v0] guarantees high-risk gate failed for internal loan (failing open):", (err as Error).message)
  }

  try {
    // Persist the request through the shared approvals backbone. Note we do NOT
    // attach a ledgerEffect and internal_loan is NOT a CREDIT_KIND — the
    // principal is credited by THIS module on approval (via ILOAN-<id>), so
    // there is exactly one crediting path and no double-credit.
    const id = `ILOAN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const record = {
      id,
      holder,
      amount,
      currency,
      annualRate: INTERNAL_LOAN_DEFAULT_RATE, // proposed default; admin may override on approval
      arrangementFee: 0,
      purpose,
      repaymentPlan,
      collateralNote,
      collateralInstrumentId: collateralInstrumentId || undefined,
      collateralInstrumentLabel: collateralInstrumentLabel || undefined,
    }
    await insertApproval({
      id,
      userId: session.id,
      kind: "internal_loan",
      title: `Internal loan — ${formatLoanMoney(amount, currency)}`,
      summary: `${holder} (${companyName}) requested an internal loan of ${formatLoanMoney(
        amount,
        currency,
      )}${purpose ? ` for ${purpose}` : ""}. Awaiting administrator risk evaluation and approval.`,
      amount,
      currency,
      payload: { record },
      requiresMasterApproval: false,
    })

    await logActivity({
      action: `Requested an internal loan of ${formatLoanMoney(amount, currency)}`,
      category: "Treasury",
      details: {
        summary: `Internal loan request ${id} for ${formatLoanMoney(amount, currency)}${
          purpose ? ` (${purpose})` : ""
        }. Pending administrator evaluation of risk and repayment guarantee.`,
        referenceId: id,
        amount: formatLoanMoney(amount, currency),
        purpose: purpose || "(not specified)",
      },
    })

    return { ok: true, approvalId: id }
  } catch (err) {
    console.log("[v0] applyForInternalLoan failed:", (err as Error).message)
    return { ok: false, error: "Your loan request could not be submitted. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Admin: list / approve / reject (passcode verified server-side)
// ---------------------------------------------------------------------------

async function adminOk(passcode: string): Promise<boolean> {
  return adminActionAuthorized(passcode)
}

export async function listInternalLoansAdmin(passcode: string): Promise<AdminInternalLoan[]> {
  if (!(await adminOk(passcode))) return []
  try {
    const rows = await listAllApprovals({ kind: "internal_loan" })
    const out: AdminInternalLoan[] = []
    for (const req of rows) {
      const record = (req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}
      const profile = await resolveAccountProfileById(req.userId).catch(() => null)
      const terms = readInternalLoanTerms(req)
      let outstanding = 0
      if (req.status === "approved" && terms) {
        const ownerId = await resolveDataOwnerIdFor(req.userId).catch(() => req.userId)
        outstanding = outstandingInternalLoan(req, await readLedgerEntries(ownerId))
      }
      out.push({
        approvalId: req.id,
        userId: req.userId,
        holder: profile?.fullName ?? (record.holder as string) ?? "—",
        company: profile?.company ?? "—",
        email: profile?.email ?? "—",
        status: req.status,
        requestedAmount: Number(record.amount ?? req.amount ?? 0),
        currency: (record.currency as string) ?? req.currency ?? INTERNAL_LOAN_DEFAULT_CURRENCY,
        purpose: (record.purpose as string) ?? "",
        repaymentPlan: (record.repaymentPlan as string) ?? "",
        collateralNote: (record.collateralNote as string) ?? "",
        collateralInstrumentId: (record.collateralInstrumentId as string) ?? "",
        collateralInstrumentLabel: (record.collateralInstrumentLabel as string) ?? "",
        createdAt: req.createdAt,
        decidedAt: req.decidedAt ?? null,
        discussionOpenedAt: (record.discussionOpenedAt as string) ?? null,
        terms,
        outstanding,
      })
    }
    return out
  } catch (err) {
    console.log("[v0] listInternalLoansAdmin failed:", (err as Error).message)
    return []
  }
}

export type AdminLoanResult = { ok: true } | { ok: false; error: string }

/**
 * Approve an internal loan: stamp the effective terms (rate + optional fee),
 * mark the approval approved, and IMMEDIATELY credit the principal to the
 * borrower's Master Account (plus post the one-time fee debit if any). All
 * ledger posts are idempotent by deterministic id.
 */
export async function approveInternalLoanAdmin(input: {
  passcode: string
  approvalId: string
  annualRatePct?: number // e.g. 3 for 3% p.a.
  arrangementFee?: number // one-time, in the loan currency
  note?: string
}): Promise<AdminLoanResult> {
  if (!(await adminOk(input.passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const req = await getApprovalById(input.approvalId)
    if (!req || req.kind !== "internal_loan") return { ok: false, error: "Loan request not found." }
    if (req.status === "approved") return { ok: true } // already funded — idempotent

    const record = (req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}

    // Negotiation is MANDATORY: you cannot fund a loan you never discussed.
    if (!record.discussionOpenedAt) {
      return {
        ok: false,
        error: "Open the discussion with the borrower before funding this loan.",
      }
    }

    const amount = Number(record.amount ?? req.amount ?? 0)
    if (!(amount > 0)) return { ok: false, error: "This request has no valid amount." }
    const currency = ((record.currency as string) ?? req.currency ?? INTERNAL_LOAN_DEFAULT_CURRENCY).toUpperCase()

    const ratePct = Number(input.annualRatePct)
    const annualRate = Number.isFinite(ratePct) && ratePct >= 0 ? ratePct / 100 : INTERNAL_LOAN_DEFAULT_RATE
    const arrangementFee = Math.max(0, Number(input.arrangementFee ?? 0)) || 0
    const activatedAt = new Date().toISOString()

    const ownerId = await resolveDataOwnerIdFor(req.userId).catch(() => req.userId)

    // -----------------------------------------------------------------------
    // UPFRONT ARRANGEMENT FEE GATE — the one-time fee must be PAID FIRST, from
    // the borrower's OWN funds (available balance + controlled-overdraft
    // allowance), BEFORE any principal is credited. If they cannot cover it,
    // NO loan is funded: nothing is credited and the approval fails so the
    // administrator can reject the request. This prevents funding a €250M loan
    // to a customer who cannot even pay its €48k arrangement fee.
    // -----------------------------------------------------------------------
    if (arrangementFee > 0) {
      try {
        const entries = await readLedgerEntries(ownerId)
        const avail = availableByCurrency(entries)
        let availableInFeeCcy = 0
        for (const [cur, amt] of Object.entries(avail)) {
          availableInFeeCcy += cur === currency ? amt : convertCurrency(amt, cur, currency)
        }
        const od = await getOverdraftStatusForOwner(ownerId)
        const overdraftInFeeCcy = od.remainingEur > 0 ? convertCurrency(od.remainingEur, "EUR", currency) : 0
        const spendable = availableInFeeCcy + overdraftInFeeCcy

        if (arrangementFee > spendable + 0.01) {
          try {
            await insertNotification({
              userId: ownerId,
              tone: "warning",
              title: "Internal loan not funded — arrangement fee unpaid",
              body: `Your internal loan could not be funded because the one-time ${formatLoanMoney(
                arrangementFee,
                currency,
              )} arrangement fee must be paid upfront and it exceeds your available funds and overdraft allowance. Add funds to your Master Account, then ask the administrator to approve again.`,
              href: "/dashboard/treasury",
            })
          } catch {
            // non-critical
          }
          await logActivity({
            action: `Internal loan ${req.id} NOT funded — ${formatLoanMoney(arrangementFee, currency)} arrangement fee unaffordable`,
            category: "Treasury",
            userId: req.userId,
            details: {
              summary: `Administrator tried to fund internal loan ${req.id} for ${formatLoanMoney(
                amount,
                currency,
              )} but the borrower could not pay the mandatory upfront ${formatLoanMoney(
                arrangementFee,
                currency,
              )} arrangement fee (available ${formatLoanMoney(
                Math.max(0, availableInFeeCcy),
                currency,
              )} + overdraft ${formatLoanMoney(Math.max(0, overdraftInFeeCcy), currency)}). No principal was credited.`,
              referenceId: req.id,
              decision: "Not funded — upfront fee unaffordable",
            },
          }).catch(() => undefined)
          return {
            ok: false,
            error: `The borrower cannot pay the mandatory upfront ${formatLoanMoney(
              arrangementFee,
              currency,
            )} arrangement fee (available ${formatLoanMoney(
              Math.max(0, availableInFeeCcy),
              currency,
            )} + overdraft ${formatLoanMoney(
              Math.max(0, overdraftInFeeCcy),
              currency,
            )}). The loan cannot be funded — ask them to fund their Master Account first, or reject the request.`,
          }
        }
      } catch (err) {
        // A blocked-funds check must NOT silently fund on an internal error:
        // treat an unverifiable balance as unaffordable (fail closed).
        console.log("[v0] internal-loan fee solvency check failed (blocking):", (err as Error).message)
        return {
          ok: false,
          error: "Could not verify the borrower can pay the upfront arrangement fee. Please retry.",
        }
      }
    }

    // 1) Charge the mandatory one-time arrangement fee FIRST (idempotent).
    if (arrangementFee > 0) {
      await upsertLedgerEntry(ownerId, {
        id: internalLoanFeeId(req.id),
        direction: "debit",
        amount: arrangementFee,
        currency,
        status: "completed",
        date: activatedAt,
        counterparty: "MCC Capital — Internal Lending",
        bank: "MCC Capital",
        reference: req.id,
        comment: `One-time upfront arrangement fee for internal loan ${req.id}.`,
        category: "Internal Loan Fee",
      })
    }

    // 2) Credit the principal to the Master (idempotent) — only after the fee.
    await upsertLedgerEntry(ownerId, {
      id: internalLoanCreditId(req.id),
      direction: "credit",
      amount,
      currency,
      status: "completed",
      date: activatedAt,
      counterparty: "MCC Capital — Internal Lending",
      bank: "MCC Capital",
      reference: req.id,
      comment: `Internal loan drawdown (${req.id}) at ${(annualRate * 100).toFixed(2)}% p.a.`,
      category: "Internal Loan Drawdown",
    })

    // 3) Persist the effective terms + mark approved.
    const nextRecord = {
      ...record,
      amount,
      currency,
      annualRate,
      arrangementFee,
      activatedAt,
    }
    await updateApprovalPayload(req.id, { ...(req.payload ?? {}), record: nextRecord })
    await recordAdminDecision(req.id, "approved", "administrator", input.note ?? undefined)

    // Resolve WHO this loan belongs to so the audit trail + email name the
    // borrower — never a hardcoded fallback (which would mislabel this
    // operation with an unrelated customer's identity).
    const borrowerProfile = await resolveAccountProfileById(req.userId).catch(() => null)
    const borrowerLabel = borrowerProfile
      ? `${borrowerProfile.fullName || borrowerProfile.email || req.userId}${
          borrowerProfile.company ? ` (${borrowerProfile.company})` : ""
        }`
      : req.userId

    // Best-effort notify + audit.
    try {
      await insertNotification({
        userId: ownerId,
        tone: "success",
        title: "Internal loan approved & funded",
        body: `Your internal loan of ${formatLoanMoney(amount, currency)} has been approved and credited to your Master Account at ${(annualRate * 100).toFixed(2)}% p.a.${
          arrangementFee > 0 ? ` A one-time ${formatLoanMoney(arrangementFee, currency)} arrangement fee was applied.` : ""
        }`,
        href: "/dashboard/treasury",
      })
    } catch {
      // non-critical
    }
    await logActivity({
      action: `Approved internal loan ${req.id} — ${formatLoanMoney(amount, currency)} funded`,
      category: "Treasury",
      user: borrowerLabel,
      userId: req.userId,
      details: {
        summary: `Administrator approved internal loan ${req.id} for ${formatLoanMoney(
          amount,
          currency,
        )} at ${(annualRate * 100).toFixed(2)}% p.a.${
          arrangementFee > 0 ? ` One-time arrangement fee ${formatLoanMoney(arrangementFee, currency)}.` : ""
        } Principal credited to the Master Account.`,
        referenceId: req.id,
        borrower: borrowerLabel,
        annualRate: `${(annualRate * 100).toFixed(2)}%`,
        arrangementFee: arrangementFee > 0 ? formatLoanMoney(arrangementFee, currency) : "none",
      },
    })

    return { ok: true }
  } catch (err) {
    console.log("[v0] approveInternalLoanAdmin failed:", (err as Error).message)
    return { ok: false, error: "The loan could not be approved. Please try again." }
  }
}

/**
 * Mark a loan as "in discussion". This is the mandatory gate before funding:
 * it stamps `discussionOpenedAt` on the request (idempotent — first open wins)
 * and notifies the borrower that the administrator has opened negotiations, so
 * they can reply and upload documents in their Bankeka chat. Actual messages
 * flow through Bankeka; this only records that the conversation has begun.
 */
export async function openInternalLoanDiscussionAdmin(input: {
  passcode: string
  approvalId: string
}): Promise<AdminLoanResult> {
  if (!(await adminOk(input.passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const req = await getApprovalById(input.approvalId)
    if (!req || req.kind !== "internal_loan") return { ok: false, error: "Loan request not found." }
    if (req.status !== "pending") return { ok: true } // decided already — nothing to open

    const record = (req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}
    if (record.discussionOpenedAt) return { ok: true } // already open — idempotent

    const openedAt = new Date().toISOString()
    await updateApprovalPayload(req.id, {
      ...(req.payload ?? {}),
      record: { ...record, discussionOpenedAt: openedAt },
    })

    const amount = Number(record.amount ?? req.amount ?? 0)
    const currency = ((record.currency as string) ?? req.currency ?? INTERNAL_LOAN_DEFAULT_CURRENCY).toUpperCase()
    try {
      await insertNotification({
        userId: req.userId,
        tone: "info",
        title: "Loan under discussion",
        body: `The administrator has opened a discussion about your ${formatLoanMoney(
          amount,
          currency,
        )} loan request. Reply and share any requested documents in your Bankeka chat.`,
        href: "/dashboard/bankeka",
      })
    } catch {
      // non-critical
    }
    const borrowerProfile = await resolveAccountProfileById(req.userId).catch(() => null)
    const borrowerLabel = borrowerProfile
      ? `${borrowerProfile.fullName || borrowerProfile.email || req.userId}${
          borrowerProfile.company ? ` (${borrowerProfile.company})` : ""
        }`
      : req.userId
    await logActivity({
      action: `Opened discussion on internal loan ${req.id}`,
      category: "Treasury",
      user: borrowerLabel,
      userId: req.userId,
      details: {
        summary: `Administrator opened negotiations on internal loan ${req.id} for ${formatLoanMoney(amount, currency)}.`,
        referenceId: req.id,
        borrower: borrowerLabel,
      },
    })
    return { ok: true }
  } catch (err) {
    console.log("[v0] openInternalLoanDiscussionAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not open the discussion. Please try again." }
  }
}

export async function rejectInternalLoanAdmin(input: {
  passcode: string
  approvalId: string
  reason?: string
}): Promise<AdminLoanResult> {
  if (!(await adminOk(input.passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const req = await getApprovalById(input.approvalId)
    if (!req || req.kind !== "internal_loan") return { ok: false, error: "Loan request not found." }
    if (req.status === "approved") {
      return { ok: false, error: "This loan is already funded and cannot be rejected here — use repayment/settlement instead." }
    }
    await recordAdminDecision(req.id, "rejected", "administrator", input.reason ?? undefined)
    try {
      await insertNotification({
        userId: req.userId,
        tone: "warning",
        title: "Internal loan declined",
        body: `Your internal loan request was not approved.${input.reason ? ` Reason: ${input.reason}` : ""}`,
        href: "/dashboard/treasury",
      })
    } catch {
      // non-critical
    }
    const borrowerProfile = await resolveAccountProfileById(req.userId).catch(() => null)
    const borrowerLabel = borrowerProfile
      ? `${borrowerProfile.fullName || borrowerProfile.email || req.userId}${
          borrowerProfile.company ? ` (${borrowerProfile.company})` : ""
        }`
      : req.userId
    await logActivity({
      action: `Rejected internal loan ${req.id}`,
      category: "Treasury",
      user: borrowerLabel,
      userId: req.userId,
      details: {
        summary: `Administrator declined internal loan ${req.id}.${input.reason ? ` Reason: ${input.reason}` : ""}`,
        referenceId: req.id,
        borrower: borrowerLabel,
      },
    })
    return { ok: true }
  } catch (err) {
    console.log("[v0] rejectInternalLoanAdmin failed:", (err as Error).message)
    return { ok: false, error: "The loan could not be rejected. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Client: self-service repayment from the Master balance
// ---------------------------------------------------------------------------

export type RepayResult =
  | { ok: true; repaid: number; outstanding: number }
  | { ok: false; error: string }

/**
 * Repay part or all of an internal loan from the borrower's Master balance.
 * Server-authoritative: the amount is clamped to the current outstanding, and
 * the repayment can only proceed if the Master balance covers it. The debit is
 * posted with a unique deterministic id per repayment so it shows in
 * statements and is idempotent-safe under retries within the same second.
 */
export async function repayInternalLoan(input: {
  approvalId: string
  amount: number
}): Promise<RepayResult> {
  const session = await resolveCurrentSession()
  if (!session?.id) return { ok: false, error: "Your session has expired. Please sign in again." }

  const pay = Number(input.amount)
  if (!Number.isFinite(pay) || pay <= 0) return { ok: false, error: "Enter a valid repayment amount." }

  try {
    const req = await getApprovalById(input.approvalId)
    if (!req || req.kind !== "internal_loan") return { ok: false, error: "Loan not found." }

    // Ownership: the loan must belong to the caller's environment (self, or a
    // sub/master in the same account family).
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (!memberIds.includes(req.userId)) return { ok: false, error: "You cannot repay this loan." }
    if (req.status !== "approved") return { ok: false, error: "Only a funded loan can be repaid." }

    const terms = readInternalLoanTerms(req)
    if (!terms) return { ok: false, error: "Loan terms are unavailable." }

    const ownerId = await resolveDataOwnerIdFor(req.userId).catch(() => req.userId)
    const entries = await readLedgerEntries(ownerId)
    const outstanding = outstandingInternalLoan(req, entries)
    if (outstanding <= 0.01) return { ok: false, error: "This loan is already fully repaid." }

    const repay = Math.min(pay, outstanding)

    // Solvency: convert available balances into the loan currency (mirrors the
    // approvals payment gate) and require coverage.
    const available = availableByCurrency(entries)
    const availableInCur = Object.entries(available).reduce(
      (sum, [cur, amt]) => sum + convertCurrency(amt, cur, terms.currency),
      0,
    )
    if (repay > availableInCur + 0.01) {
      return {
        ok: false,
        error: `Your Master Account has only ${formatLoanMoney(
          Math.max(0, availableInCur),
          terms.currency,
        )} available — not enough to repay ${formatLoanMoney(repay, terms.currency)}.`,
      }
    }

    // Count existing repayment legs to make a fresh unique id.
    const legCount = entries.filter((e) => e.id.startsWith(`ILOAN-REPAY-${req.id}-`)).length
    await upsertLedgerEntry(ownerId, {
      id: internalLoanRepayId(req.id, legCount + 1),
      direction: "debit",
      amount: repay,
      currency: terms.currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: "MCC Capital — Internal Lending",
      bank: "MCC Capital",
      reference: req.id,
      comment: `Repayment toward internal loan ${req.id}.`,
      category: "Internal Loan Repayment",
    })

    const nowOutstanding = Math.max(0, outstanding - repay)

    // If fully repaid, stamp the settlement so interest stops accruing AND mark
    // the record closed so the customer card stops showing it as a live "Funded"
    // loan (the store derives the "closed" sub-state from record.status/closedAt).
    if (nowOutstanding <= 0.01) {
      const record = (req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}
      const closedAt = new Date().toISOString()
      await updateApprovalPayload(req.id, {
        ...(req.payload ?? {}),
        record: { ...record, status: "closed", settledAt: closedAt, closedAt },
      })
    }

    const borrowerProfile = await resolveAccountProfileById(req.userId).catch(() => null)
    const borrowerLabel = borrowerProfile
      ? `${borrowerProfile.fullName || borrowerProfile.email || req.userId}${
          borrowerProfile.company ? ` (${borrowerProfile.company})` : ""
        }`
      : req.userId
    await logActivity({
      action: `Repaid ${formatLoanMoney(repay, terms.currency)} on internal loan ${req.id}`,
      category: "Treasury",
      user: borrowerLabel,
      userId: req.userId,
      details: {
        summary: `Repayment of ${formatLoanMoney(repay, terms.currency)} on internal loan ${req.id}. Outstanding now ${formatLoanMoney(
          nowOutstanding,
          terms.currency,
        )}.`,
        referenceId: req.id,
        borrower: borrowerLabel,
      },
    })

    return { ok: true, repaid: repay, outstanding: nowOutstanding }
  } catch (err) {
    console.log("[v0] repayInternalLoan failed:", (err as Error).message)
    return { ok: false, error: "The repayment could not be processed. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Client read: my loans (used by the store's server-list hook is separate; this
// helper backs any direct server read if needed)
// ---------------------------------------------------------------------------

export async function myInternalLoanOutstanding(): Promise<{ total: number; currency: string }> {
  const session = await resolveCurrentSession()
  if (!session?.id) return { total: 0, currency: INTERNAL_LOAN_DEFAULT_CURRENCY }
  try {
    const mine = await listApprovalsForUser(session.id, "internal_loan")
    const ownerId = await resolveDataOwnerIdFor(session.id).catch(() => session.id)
    const entries = await readLedgerEntries(ownerId)
    let total = 0
    let currency = INTERNAL_LOAN_DEFAULT_CURRENCY
    for (const req of mine) {
      if (req.status !== "approved") continue
      const terms = readInternalLoanTerms(req)
      if (!terms) continue
      currency = terms.currency
      total += outstandingInternalLoan(req, entries)
    }
    return { total, currency }
  } catch {
    return { total: 0, currency: INTERNAL_LOAN_DEFAULT_CURRENCY }
  }
}

/**
 * Per-loan outstanding balances for the signed-in environment, keyed by the
 * approval id. The client store merges these onto each loan record so the card
 * can show a live "still owed" figure without persisting it in the approval.
 */
export async function listMyInternalLoanOutstanding(): Promise<Record<string, number>> {
  const session = await resolveCurrentSession()
  if (!session?.id) return {}
  try {
    const mine = await listApprovalsForUser(session.id, "internal_loan")
    const ownerId = await resolveDataOwnerIdFor(session.id).catch(() => session.id)
    const entries = await readLedgerEntries(ownerId)
    const out: Record<string, number> = {}
    for (const req of mine) {
      if (req.status !== "approved") continue
      if (!readInternalLoanTerms(req)) continue
      out[req.id] = outstandingInternalLoan(req, entries)
    }
    return out
  } catch {
    return {}
  }
}
