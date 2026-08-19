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
