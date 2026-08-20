import type { LedgerEntry } from "@/lib/ledger-store"
import type { ApprovalRequest } from "@/lib/approvals-db"
import {
  accruedInterestToDate,
  monthlyInterestAmount,
  monthlyInterestCharges,
  round2,
} from "@/lib/interest-accrual"

/**
 * Internal Lending -> Master Account.
 *
 * A plain internal LOAN a customer requests on demand (any amount, up to
 * unlimited). It is DISTINCT from:
 *   • the security-deposit "Capital Lending" (which finances the treasury
 *     security deposit up to its fixed amount), and
 *   • AES private-investment / trading products.
 *
 * Lifecycle (all approval-backed, driven off `approval_requests`, no scheduler):
 *   • PENDING   → nothing on the ledger; the administrator is evaluating risk
 *                 and the repayment guarantee.
 *   • APPROVED  → the full principal is CREDITED to the master account
 *                 (`ILOAN-<id>`), an optional one-time arrangement fee is
 *                 DEBITED (`ILOAN-FEE-<id>`), and a monthly debit interest
 *                 (default 3% p.a., admin-overridable) accrues on the
 *                 outstanding principal from the funding date
 *                 (`ILOAN-INT-<id>-<YYYY-MM>`, first month pro-rated).
 *   • REJECTED  → nothing on the ledger (never funded).
 *   • SETTLED   → on client self-service repayment, the principal is returned
 *                 (`ILOAN-SETTLE-PRIN-<id>` debit, netting the drawdown credit)
 *                 plus any interest not yet charged monthly
 *                 (`ILOAN-SETTLE-INT-<id>`); `settledAt` stops further interest.
 *
 * Every post uses a DETERMINISTIC id so the reconciler is fully idempotent.
 */

/** Default annual debit interest on an internal loan (3% p.a.). */
export const INTERNAL_LOAN_DEFAULT_RATE = 0.03

/** Currency an internal loan defaults to when none is given. */
export const INTERNAL_LOAN_DEFAULT_CURRENCY = "EUR"

/** The loan terms carried in an `internal_loan` approval's payload. */
export interface InternalLoanTerms {
  amount: number
  currency: string
  /** Annual interest rate as a decimal (e.g. 0.03 = 3% p.a.). */
  annualRate: number
  /** One-time arrangement fee (absolute, loan currency); 0 or absent = none. */
  arrangementFee?: number
  purpose?: string
  repaymentPlan?: string
  collateralNote?: string
  /** Set when the administrator approves/funds the loan (accrual start). */
  activatedAt?: string
  /** Set when the loan is repaid/closed; caps interest accrual. */
  settledAt?: string
}

/** Deterministic ledger id: the drawdown principal credit. */
export const internalLoanCreditId = (id: string) => `ILOAN-${id}`
/** Deterministic ledger id: the one-time arrangement fee debit. */
export const internalLoanFeeId = (id: string) => `ILOAN-FEE-${id}`
/** Deterministic ledger id: a month's interest charge. */
export const internalLoanInterestChargeId = (id: string, yearMonth: string) =>
  `ILOAN-INT-${id}-${yearMonth}`
/** Deterministic ledger id: the principal returned at repayment. */
export const internalLoanSettlePrincipalId = (id: string) => `ILOAN-SETTLE-PRIN-${id}`
/** Deterministic ledger id: interest settled at repayment (final stub). */
export const internalLoanSettleInterestId = (id: string) => `ILOAN-SETTLE-INT-${id}`
/** Deterministic ledger id: the k-th self-service partial repayment leg. */
export const internalLoanRepayId = (id: string, leg: number) => `ILOAN-REPAY-${id}-${leg}`

/** Format money for loan messages, e.g. `EUR 1,000,000.00`. */
export function formatLoanMoney(amount: number, currency: string = INTERNAL_LOAN_DEFAULT_CURRENCY): string {
  return `${currency} ${Number(amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Current outstanding balance of an APPROVED loan against a ledger snapshot —
 * what the borrower still owes right now, never negative.
 *
 *   full payoff now (principal + interest accrued-but-not-yet-billed)
 *     − every repayment/settlement leg already posted for THIS loan
 *       (`ILOAN-REPAY-<id>-*`, `ILOAN-SETTLE-PRIN-<id>`, `ILOAN-SETTLE-INT-<id>`)
 *
 * Monthly interest charges (`ILOAN-INT-*`) are the *billing* of interest to the
 * master balance and do NOT reduce the loan — `internalLoanPayoff` already nets
 * them out of `interestRemaining`, so they are intentionally not subtracted
 * again here.
 */
export function outstandingInternalLoan(
  req: ApprovalRequest,
  entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>,
  now: Date = new Date(),
): number {
  const terms = readInternalLoanTerms(req)
  if (!terms || !(terms.amount > 0)) return 0

  const postedInterest = postedInternalLoanInterest(req.id, entries)
  const payoff = internalLoanPayoff(req, postedInterest, now)

  const repayPrefix = `ILOAN-REPAY-${req.id}-`
  const settlePrincipal = internalLoanSettlePrincipalId(req.id)
  const settleInterest = internalLoanSettleInterestId(req.id)
  let repaid = 0
  for (const e of entries) {
    if (typeof e.id !== "string") continue
    if (e.id.startsWith(repayPrefix) || e.id === settlePrincipal || e.id === settleInterest) {
      repaid += e.amount
    }
  }

  return Math.max(0, round2(payoff.total - repaid))
}

/**
 * Read (and sanity-check) the loan terms off an approval, or null if absent.
 *
 * The canonical client record lives under `payload.record` (the shape written
 * by the store + admin action); an older `payload.loan` shape is accepted as a
 * fallback. Field-name tolerant: `interestRate`/`annualRate` and
 * `settledAt`/`closedAt` are treated as equivalent.
 */
export function readInternalLoanTerms(req: ApprovalRequest | null | undefined): InternalLoanTerms | null {
  if (!req || req.kind !== "internal_loan") return null
  const src =
    ((req.payload as { record?: Record<string, unknown> } | undefined)?.record as
      | Record<string, unknown>
      | undefined) ??
    ((req.payload as { loan?: Record<string, unknown> } | undefined)?.loan as
      | Record<string, unknown>
      | undefined) ??
    {}
  const amount = Number(src.amount ?? req.amount ?? 0)
  if (!(amount > 0)) return null
  const rate = Number(src.annualRate ?? src.interestRate)
  const settledAt = (src.settledAt as string | undefined) ?? (src.closedAt as string | undefined)
  return {
    amount,
    currency: (src.currency as string | undefined) ?? req.currency ?? INTERNAL_LOAN_DEFAULT_CURRENCY,
    annualRate: Number.isFinite(rate) && rate >= 0 ? rate : INTERNAL_LOAN_DEFAULT_RATE,
    arrangementFee: Math.max(0, Number(src.arrangementFee ?? 0)) || 0,
    purpose: src.purpose as string | undefined,
    repaymentPlan: src.repaymentPlan as string | undefined,
    collateralNote: src.collateralNote as string | undefined,
    activatedAt: src.activatedAt as string | undefined,
    settledAt,
  }
}

/** The instant interest accrual begins (funding date), or null if not funded. */
function activationDate(terms: InternalLoanTerms): Date | null {
  if (!terms.activatedAt) return null
  const d = new Date(terms.activatedAt)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Accrual cut-off: `settledAt` once repaid, else `now`. */
function accrualCutoff(terms: InternalLoanTerms, now: Date): Date {
  if (terms.settledAt) {
    const s = new Date(terms.settledAt)
    if (!Number.isNaN(s.getTime()) && s.getTime() < now.getTime()) return s
  }
  return now
}

/** One full month's interest on the outstanding principal. */
export function monthlyInternalLoanInterest(terms: InternalLoanTerms): number {
  return monthlyInterestAmount(Math.max(0, terms.amount), terms.annualRate)
}

/** Total interest accrued to date (continuous, including the in-progress month). */
export function accruedInternalLoanInterest(
  req: ApprovalRequest | null | undefined,
  asOf: Date = new Date(),
): number {
  const terms = readInternalLoanTerms(req)
  if (!terms) return 0
  const start = activationDate(terms)
  if (!start) return 0
  return accruedInterestToDate(terms.amount, terms.annualRate, start, accrualCutoff(terms, asOf))
}

/** Sum of interest already charged month-by-month for a loan (ledger prefix). */
export function postedInternalLoanInterest(
  id: string,
  entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>,
): number {
  const prefix = `ILOAN-INT-${id}-`
  let sum = 0
  for (const e of entries) {
    if (typeof e.id === "string" && e.id.startsWith(prefix)) sum += e.amount
  }
  return round2(sum)
}

export interface InternalLoanPayoff {
  principal: number
  /** Interest accrued but not yet charged monthly (the settlement stub). */
  interestRemaining: number
  total: number
  currency: string
}

/**
 * Compute the payoff to fully repay a loan now: the outstanding principal plus
 * any interest accrued since the last monthly charge (total accrued − already
 * posted). `postedInterest` is summed from the owner's ledger for accuracy.
 */
export function internalLoanPayoff(
  req: ApprovalRequest,
  postedInterest: number,
  now: Date = new Date(),
): InternalLoanPayoff {
  const terms = readInternalLoanTerms(req)
  if (!terms) return { principal: 0, interestRemaining: 0, total: 0, currency: INTERNAL_LOAN_DEFAULT_CURRENCY }
  const accrued = accruedInternalLoanInterest(req, now)
  const interestRemaining = Math.max(0, round2(accrued - postedInterest))
  const principal = round2(terms.amount)
  return {
    principal,
    interestRemaining,
    total: round2(principal + interestRemaining),
    currency: terms.currency,
  }
}

export interface PendingLoanPost {
  direction: "credit" | "debit"
  entry: Omit<LedgerEntry, "direction">
}

/**
 * Build every ledger post an APPROVED internal loan should have that is not yet
 * present (checked against `existingIds`): the principal drawdown credit, the
 * one-time arrangement fee debit, and each matured monthly interest charge.
 *
 * Once the loan is settled (`settledAt`) NO monthly interest is emitted here —
 * the settlement action bills the remaining interest as a one-time stub, so
 * emitting month charges too would double-count.
 */
export function buildInternalLoanPosts(
  req: ApprovalRequest | null | undefined,
  existingIds: Set<string>,
  now: Date = new Date(),
): PendingLoanPost[] {
  const posts: PendingLoanPost[] = []
  if (!req || req.status !== "approved") return posts
  const terms = readInternalLoanTerms(req)
  if (!terms) return posts

  // 1) Principal drawdown credit (self-heals a loan approved before its effect).
  const creditId = internalLoanCreditId(req.id)
  if (!existingIds.has(creditId)) {
    posts.push({
      direction: "credit",
      entry: {
        id: creditId,
        amount: round2(terms.amount),
        currency: terms.currency,
        status: "completed",
        date: terms.activatedAt ?? req.decidedAt ?? req.createdAt,
        counterparty: "MCC Capital — Internal Loan",
        reference: req.id,
        category: "Internal Loan Drawdown",
        comment: `Internal loan of ${terms.currency} ${terms.amount.toLocaleString("en-US")} credited to the master account on administrator approval.`,
      },
    })
  }

  // 2) One-time arrangement fee debit (if the admin set one).
  if (terms.arrangementFee && terms.arrangementFee > 0) {
    const feeId = internalLoanFeeId(req.id)
    if (!existingIds.has(feeId)) {
      posts.push({
        direction: "debit",
        entry: {
          id: feeId,
          amount: round2(terms.arrangementFee),
          currency: terms.currency,
          status: "completed",
          date: terms.activatedAt ?? req.decidedAt ?? req.createdAt,
          counterparty: "MCC Capital — Internal Loan",
          reference: req.id,
          category: "Internal Loan Fee",
          comment: `One-time arrangement fee on internal loan ${req.id}.`,
        },
      })
    }
  }

  // 3) Monthly debit interest on the outstanding principal (skip once settled —
  //    the settlement stub covers the remaining interest exactly once).
  const start = activationDate(terms)
  if (start && !terms.settledAt) {
    for (const charge of monthlyInterestCharges(terms.amount, terms.annualRate, start, accrualCutoff(terms, now))) {
      const chargeId = internalLoanInterestChargeId(req.id, charge.yearMonth)
      if (existingIds.has(chargeId)) continue
      const proNote = charge.prorated
        ? ` (pro-rated ${(charge.fraction * 100).toFixed(0)}% — accrual began on the funding date)`
        : ""
      posts.push({
        direction: "debit",
        entry: {
          id: chargeId,
          amount: charge.amount,
          currency: terms.currency,
          status: "completed",
          date: charge.date.toISOString(),
          counterparty: "MCC Capital — Internal Loan Interest",
          reference: req.id,
          category: "Internal Loan Interest",
          comment: `Monthly debit interest (${(terms.annualRate * 100).toFixed(2)}% p.a. ÷ 12) on internal loan ${req.id} for ${charge.yearMonth}${proNote}.`,
        },
      })
    }
  }

  return posts.sort((a, b) => new Date(a.entry.date).getTime() - new Date(b.entry.date).getTime())
}

/**
 * The subset of a funded internal-loan record (the `payload.record` / client
 * store shape) that the debit-schedule + settlement engines need. Kept here
 * (server-safe, no `"use client"`) so both the pure schedule and the pure
 * settlement engine can consume it without importing the client store.
 */
export interface InternalLoanRecordLike {
  id: string
  /** DB approval id — the canonical ledger key once mirrored. */
  approvalId?: string
  amount: number
  currency: string
  /** Annual rate; either name is accepted (`readInternalLoanTerms` normalizes). */
  interestRate?: number
  annualRate?: number
  arrangementFee?: number
  purpose?: string
  repaymentPlan?: string
  collateralNote?: string
  status?: string
  submittedAt?: string
  decidedAt?: string
  /** Funding date — interest accrual start. */
  activatedAt?: string
  /** Repaid/closed date — caps accrual (either name is accepted). */
  closedAt?: string
  settledAt?: string
}

/**
 * Wrap a funded internal-loan record into the minimal `ApprovalRequest` shape
 * the audited internal-loan engine reads. The engine only touches
 * `id/kind/status/amount/currency/createdAt/decidedAt/payload.record`, so this
 * lets `buildInternalLoanPosts`, `internalLoanPayoff`, and
 * `accruedInternalLoanInterest` be reused from the Debits & Financing schedule
 * and settlement paths with IDENTICAL math and deterministic ids.
 *
 * The id is the DB approval id (`approvalId ?? id`) so every synthetic post
 * matches the ledger rows the server reconciler already wrote.
 */
export function internalLoanApprovalShim(rec: InternalLoanRecordLike): ApprovalRequest {
  const id = rec.approvalId ?? rec.id
  const createdAt = rec.submittedAt ?? rec.activatedAt ?? new Date().toISOString()
  // The audited engine only reads id/kind/status/amount/currency/createdAt/
  // decidedAt/payload.record, so this minimal object is a faithful adapter.
  const shim: ApprovalRequest = {
    id,
    userId: "",
    kind: "internal_loan",
    status: "approved",
    title: "",
    summary: "",
    amount: rec.amount,
    currency: rec.currency,
    payload: { record: rec },
    ledgerEffect: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: rec.decidedAt ?? rec.activatedAt ?? null,
    createdAt,
    requiresMasterApproval: false,
    masterId: null,
    masterDecision: "pending",
    masterDecidedAt: null,
    adminDecision: "approved",
    initiatedById: null,
    initiatedByName: null,
  }
  return shim
}
