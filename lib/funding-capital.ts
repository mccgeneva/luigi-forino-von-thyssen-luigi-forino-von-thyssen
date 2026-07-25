import { AES_ANNUAL_COST_RATE, AES_EARLY_REDEMPTION_RATE, AES_STANDARD_TENOR_YEARS } from "@/lib/aes"
import type { LedgerEntry } from "@/lib/ledger-store"
import type { FundingSettlementSnapshot, ProjectFundingRequest } from "@/lib/project-funding-store"
import {
  accruedInterestToDate,
  monthlyInterestAmount,
  monthlyInterestCharges,
  round2,
} from "@/lib/interest-accrual"

/**
 * Project Funding -> Master Account integration.
 *
 * When an AES project funding application is APPROVED, two things must reflect
 * on the client's master account ledger:
 *
 *   1. The approved facility capital is CREDITED to the balance (once).
 *   2. The 1.8% annual debit interest (cost of capital) is CHARGED monthly —
 *      i.e. a DEBIT of `facility * 1.8% / 12` posted at the end of each calendar
 *      month for as long as the facility is active. Accrual begins on the EXACT
 *      day the capital is credited, so the first (and any settlement) month is
 *      PRO-RATED to the active days in that month.
 *
 * Because this is a client-side ledger with no scheduler, charges are accrued
 * lazily: every time the data is reconciled we post any month-end charges that
 * have come due since approval but are not yet on the ledger. All entries use
 * deterministic ids so reconciliation is fully idempotent (re-running never
 * double-posts).
 */

/** Annual debit interest rate on a project funding facility (1.8%). */
export const FUNDING_ANNUAL_RATE = AES_ANNUAL_COST_RATE

/** Monthly cost-of-capital rate: 1.8% annual, charged in twelfths. */
export const MONTHLY_COST_RATE = AES_ANNUAL_COST_RATE / 12

/** One full month's cost-of-capital charge on a facility. */
export function monthlyCostOfCapital(facility: number): number {
  return monthlyInterestAmount(Math.max(0, facility), FUNDING_ANNUAL_RATE)
}

/** Cost of capital accrued to date (continuous, includes the current month). */
export function accruedCostOfCapital(facility: number, start: Date, asOf: Date = new Date()): number {
  return accruedInterestToDate(Math.max(0, facility), FUNDING_ANNUAL_RATE, start, asOf)
}

/** Deterministic ledger id for an approved facility's capital credit. */
export function fundingCapitalCreditId(requestId: string): string {
  return `FND-CAP-${requestId}`
}

/** Deterministic ledger id for a single month's cost-of-capital charge. */
export function fundingChargeId(requestId: string, yearMonth: string): string {
  return `FND-ROI-${requestId}-${yearMonth}`
}

/** Deterministic ledger ids for the three settlement legs posted at closure. */
export function fundingSettlementPrincipalId(requestId: string): string {
  return `FND-SETTLE-PRIN-${requestId}`
}
export function fundingSettlementInterestId(requestId: string): string {
  return `FND-SETTLE-INT-${requestId}`
}
export function fundingSettlementFeeId(requestId: string): string {
  return `FND-SETTLE-FEE-${requestId}`
}

/** The date a request's capital is credited (and from which interest accrues). */
export function fundingCreditDate(r: ProjectFundingRequest): Date {
  return r.decidedAt ? new Date(r.decidedAt) : new Date(r.submittedAt)
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

/**
 * Compute the payoff required to close a facility early, as of `asOf`.
 *
 * The payoff has three parts:
 *   • principal — the drawn facility capital, clawed back to MCC;
 *   • interest  — cost of capital accrued to `asOf` but NOT yet posted at a
 *                 month-end (the pro-rata tail since the last charge). Interest
 *                 already charged month-by-month is left in place — it was the
 *                 cost of holding the money and is not refunded;
 *   • fee       — an early-exit settlement fee: the AES early-redemption rate
 *                 (70%) applied to the cost of capital that WOULD have accrued
 *                 over the remaining standard tenor.
 *
 * Pure and deterministic in (`facility`, credit date, `asOf`), so the quote
 * shown to the client, the snapshot stored at closure, and the ledger posts the
 * reconciler derives all agree to the cent.
 */
export function computeFundingSettlement(
  r: ProjectFundingRequest,
  asOf: Date = new Date(),
): FundingSettlementSnapshot {
  const facility = Math.max(0, r.facility || 0)
  const start = fundingCreditDate(r)
  const closedAt = asOf

  // Interest already posted (or due to be posted) at month-ends up to closedAt.
  const postedInterest = monthlyInterestCharges(facility, FUNDING_ANNUAL_RATE, start, closedAt).reduce(
    (sum, c) => sum + c.amount,
    0,
  )
  // Continuous interest to closedAt; the difference is the outstanding tail.
  const totalAccrued = accruedCostOfCapital(facility, start, closedAt)
  const interest = round2(Math.max(0, totalAccrued - postedInterest))

  const elapsedYears = Math.max(0, (closedAt.getTime() - start.getTime()) / MS_PER_YEAR)
  const remainingYears = Math.max(0, AES_STANDARD_TENOR_YEARS - elapsedYears)
  const fee = round2(AES_EARLY_REDEMPTION_RATE * facility * FUNDING_ANNUAL_RATE * remainingYears)

  const principal = round2(facility)
  const total = round2(principal + interest + fee)

  return {
    principal,
    interest,
    fee,
    total,
    currency: r.currency,
    closedAt: closedAt.toISOString(),
  }
}

export interface PendingLedgerPost {
  direction: LedgerDirectionLike
  entry: Omit<LedgerEntry, "direction">
}

type LedgerDirectionLike = "credit" | "debit"

/**
 * Build every ledger post that an approved funding request implies but that is
 * not yet present on the ledger (checked against `existingIds`).
 *
 * Returns capital credits and any due monthly charges, oldest charge first so
 * the resulting ledger reads chronologically.
 */
export function buildFundingLedgerPosts(
  requests: ProjectFundingRequest[],
  existingIds: Set<string>,
  now: Date = new Date(),
): PendingLedgerPost[] {
  const posts: PendingLedgerPost[] = []

  for (const r of requests) {
    if (r.status !== "approved" || !r.facility || r.facility <= 0) continue
    const approvedAt = fundingCreditDate(r)
    if (Number.isNaN(approvedAt.getTime())) continue

    // A closed facility stops accruing at its closure date: cost-of-capital
    // charges are only posted for month-ends up to `closedAt`, and the final
    // settlement (principal + interest tail + early-exit fee) is posted once.
    const closedAt = r.closedAt ? new Date(r.closedAt) : null
    const closedValid = closedAt && !Number.isNaN(closedAt.getTime())
    const chargeUntil = closedValid && closedAt < now ? closedAt : now

    // 1. Capital credit (once).
    const creditId = fundingCapitalCreditId(r.id)
    if (!existingIds.has(creditId)) {
      posts.push({
        direction: "credit",
        entry: {
          id: creditId,
          amount: r.facility,
          currency: r.currency,
          status: "completed",
          date: approvedAt.toISOString(),
          counterparty: "MCC Capital — AES Facility Drawdown",
          reference: r.id,
          category: "Project Funding",
          comment: `Approved AES facility for "${r.projectName}" credited to the master account.`,
        },
      })
    }

    // 2. Monthly cost-of-capital charges at each elapsed calendar month-end,
    //    accruing from the credit date with the first month pro-rated. Capped at
    //    the closure date for a settled facility so no interest accrues after it.
    for (const charge of monthlyInterestCharges(r.facility, FUNDING_ANNUAL_RATE, approvedAt, chargeUntil)) {
      const chargeId = fundingChargeId(r.id, charge.yearMonth)
      if (existingIds.has(chargeId)) continue
      const proNote = charge.prorated
        ? ` (pro-rated ${(charge.fraction * 100).toFixed(0)}% — accrual began on the funding date)`
        : ""
      posts.push({
        direction: "debit",
        entry: {
          id: chargeId,
          amount: charge.amount,
          currency: r.currency,
          status: "completed",
          date: charge.date.toISOString(),
          counterparty: "MCC Capital — AES Cost of Capital",
          reference: r.id,
          category: "Cost of Capital",
          comment: `Monthly debit interest (1.8% p.a. ÷ 12) on "${r.projectName}" facility for ${charge.yearMonth}${proNote}.`,
        },
      })
    }

    // 3. Settlement (once) when the facility has been closed early / recalled.
    if (closedValid) {
      for (const post of buildFundingSettlementPosts(r, existingIds)) posts.push(post)
    }
  }

  // Oldest first so chronological order is preserved when prepended/merged.
  return posts.sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime())
}

/**
 * Build the (up to three) settlement debit legs a CLOSED facility implies but
 * that are not yet on the ledger: the outstanding interest tail, the early-exit
 * fee, then the principal clawback. Deterministic ids so the admin execution
 * path and the client reconciler post identical rows (idempotent upserts).
 * Returns an empty array when the facility is not closed.
 */
export function buildFundingSettlementPosts(
  r: ProjectFundingRequest,
  existingIds: Set<string> = new Set(),
): PendingLedgerPost[] {
  const posts: PendingLedgerPost[] = []
  if (!r.closedAt) return posts
  const closedAt = new Date(r.closedAt)
  if (Number.isNaN(closedAt.getTime())) return posts
  if (!r.facility || r.facility <= 0) return posts

  const s = computeFundingSettlement(r, closedAt)
  const dateIso = closedAt.toISOString()
  const kindNote = r.closureKind === "client_early" ? "early closure" : "recall"

  const intId = fundingSettlementInterestId(r.id)
  if (s.interest > 0 && !existingIds.has(intId)) {
    posts.push({
      direction: "debit",
      entry: {
        id: intId,
        amount: s.interest,
        currency: r.currency,
        status: "completed",
        date: dateIso,
        counterparty: "MCC Capital — AES Cost of Capital",
        reference: r.id,
        category: "Cost of Capital",
        comment: `Outstanding cost of capital settled on ${kindNote} of "${r.projectName}" facility.`,
      },
    })
  }

  const feeId = fundingSettlementFeeId(r.id)
  if (s.fee > 0 && !existingIds.has(feeId)) {
    posts.push({
      direction: "debit",
      entry: {
        id: feeId,
        amount: s.fee,
        currency: r.currency,
        status: "completed",
        date: dateIso,
        counterparty: "MCC Capital — AES Early Redemption",
        reference: r.id,
        category: "Early Redemption Fee",
        comment: `Early-exit settlement fee (${(AES_EARLY_REDEMPTION_RATE * 100).toFixed(0)}% of remaining-tenor cost of capital) on ${kindNote} of "${r.projectName}".`,
      },
    })
  }

  const prinId = fundingSettlementPrincipalId(r.id)
  if (s.principal > 0 && !existingIds.has(prinId)) {
    posts.push({
      direction: "debit",
      entry: {
        id: prinId,
        amount: s.principal,
        currency: r.currency,
        status: "completed",
        date: dateIso,
        counterparty: "MCC Capital — AES Facility Repayment",
        reference: r.id,
        category: "Project Funding",
        comment: `Facility principal returned to MCC Capital on ${kindNote} of "${r.projectName}".`,
      },
    })
  }

  return posts
}
