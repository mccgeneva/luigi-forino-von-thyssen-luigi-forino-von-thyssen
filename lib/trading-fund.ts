import type { LedgerEntry } from "@/lib/ledger-store"
import type { ApprovalRequest } from "@/lib/approvals-db"
import { monthlyInterestCharges } from "@/lib/interest-accrual"

/**
 * NAFTAhub Trading — Treuhand AG Limited Hedge Fund -> Master Account.
 *
 * When a token subscription is APPROVED, two things must reflect on the
 * client's master account ledger:
 *
 *   1. The subscribed CAPITAL is DEBITED once — it is deployed to the fund and
 *      leaves the master account.
 *   2. The fund pays a fixed 25% MONTHLY ROI: a CREDIT of `capital * 25%` is
 *      posted at each elapsed calendar month-end for as long as the
 *      subscription is active. Accrual begins on the exact approval day, so the
 *      first month is PRO-RATED to its active days (matured share).
 *
 * There is no server scheduler, so — exactly like the AES funding cost-of-
 * capital engine — charges/credits are accrued lazily: every reconcile posts
 * any month-ends that have come due but are not yet on the ledger. All entries
 * use deterministic ids so reconciliation is fully idempotent (re-running never
 * double-posts).
 *
 * IMPORTANT: the capital debit uses the SAME `APPR-<id>` id the approval's own
 * `ledgerEffect` posts on approval. That is deliberate — it means this builder
 * self-heals a subscription that was approved BEFORE a ledger effect was
 * attached (posting the missing debit on the next ledger read) while never
 * double-debiting one approved WITH an effect (the id already exists → skipped).
 */

/** Fixed monthly ROI paid by the Treuhand fund on deployed token capital. */
export const TRADING_FUND_MONTHLY_ROI = 0.25

/**
 * `monthlyInterestCharges` divides the annual rate by 12, so the annual-rate
 * equivalent of a 25% MONTHLY return is 25% × 12 = 300% p.a. This reuses the
 * single audited accrual/pro-rating engine rather than re-deriving month math.
 */
const ROI_ANNUAL_EQUIV = TRADING_FUND_MONTHLY_ROI * 12

const FUND_LABEL = "Treuhand AG Limited Hedge Fund"

/** Deterministic ledger id for the one-time capital deployment debit. */
export function tradingFundCapitalDebitId(reqId: string): string {
  return `APPR-${reqId}`
}

/** Deterministic ledger id for a single month's 25% ROI credit. */
export function tradingFundRoiId(reqId: string, yearMonth: string): string {
  return `TFUND-ROI-${reqId}-${yearMonth}`
}

/** The date a subscription's capital is deployed (and from which ROI accrues). */
function activationDate(req: ApprovalRequest): Date {
  return req.decidedAt ? new Date(req.decidedAt) : new Date(req.createdAt)
}

/**
 * Every ledger post an approved Treuhand fund subscription implies: the capital
 * deployment debit (once) plus each matured monthly 25% ROI credit. Callers
 * skip ids already on the ledger; posting is idempotent regardless.
 */
export function buildTradingFundPosts(req: ApprovalRequest, now: Date = new Date()): LedgerEntry[] {
  if (req.kind !== "trading_fund" || req.status !== "approved") return []

  const capital = Number(req.amount ?? (req.payload as { capital?: number })?.capital)
  if (!Number.isFinite(capital) || capital <= 0) return []

  const currency = req.currency || "EUR"
  const start = activationDate(req)
  if (Number.isNaN(start.getTime())) return []

  const tokens = Number((req.payload as { tokens?: number })?.tokens)
  const tokenNote = Number.isFinite(tokens) && tokens > 0 ? ` (${tokens} token${tokens === 1 ? "" : "s"})` : ""

  const posts: LedgerEntry[] = []

  // 1. Capital deployed to the fund — permanent debit, once. Same id the
  //    approval's ledgerEffect posts, so it never doubles yet back-fills any
  //    subscription approved before the effect existed.
  posts.push({
    id: tradingFundCapitalDebitId(req.id),
    direction: "debit",
    amount: capital,
    currency,
    status: "completed",
    date: start.toISOString(),
    counterparty: FUND_LABEL,
    reference: req.id,
    category: "NAFTAhub Trading — Fund Subscription",
    comment: `Capital deployed to the ${FUND_LABEL}${tokenNote}.`,
  })

  // 2. Matured monthly ROI credits (25% of deployed capital per elapsed month).
  //    An end date could be passed here to stop accrual on termination.
  for (const charge of monthlyInterestCharges(capital, ROI_ANNUAL_EQUIV, start, now)) {
    posts.push({
      id: tradingFundRoiId(req.id, charge.yearMonth),
      direction: "credit",
      amount: charge.amount,
      currency,
      status: "completed",
      date: charge.date.toISOString(),
      counterparty: FUND_LABEL,
      reference: req.id,
      category: "NAFTAhub Trading — Fund ROI",
      comment:
        `Monthly ${(TRADING_FUND_MONTHLY_ROI * 100).toFixed(0)}% ROI on the ${FUND_LABEL} for ${charge.yearMonth}` +
        (charge.prorated ? ` (pro-rated ${(charge.fraction * 100).toFixed(0)}% — matured share since deployment).` : "."),
    })
  }

  return posts
}
