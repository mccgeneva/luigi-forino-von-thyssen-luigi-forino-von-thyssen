import type { LedgerEntry } from "@/lib/ledger-store"
import type { ApprovalRequest } from "@/lib/approvals-db"
import { round2, yearMonthKey } from "@/lib/interest-accrual"

/**
 * NAFTAhub Trading — Treuhand AG Limited Hedge Fund -> Master Account.
 *
 * When a token subscription is APPROVED, two things must reflect on the
 * client's master account ledger:
 *
 *   1. The subscribed CAPITAL is DEBITED once — it is deployed to the fund and
 *      leaves the master account.
 *   2. The fund pays a fixed 25% MONTHLY ROI, credited MONTHLY IN ADVANCE: a
 *      CREDIT of `capital * 25%` is posted for the activation month IMMEDIATELY
 *      when the subscription starts, then again at the first of every following
 *      calendar month for as long as it is active. Crediting in advance is what
 *      makes the ROI reflect on the master account the moment the position
 *      starts (rather than only weeks later at the first month-end), which is
 *      the behaviour the desk expects for "once started, pay 25% each month".
 *
 * There is no server scheduler, so — exactly like the AES funding cost-of-
 * capital engine — credits are posted lazily: every reconcile posts any active
 * months that are not yet on the ledger. All entries use deterministic ids so
 * reconciliation is fully idempotent (re-running never double-posts).
 *
 * IMPORTANT: the capital debit uses the SAME `APPR-<id>` id the approval's own
 * `ledgerEffect` posts on approval. That is deliberate — it means this builder
 * self-heals a subscription that was approved BEFORE a ledger effect was
 * attached (posting the missing debit on the next ledger read) while never
 * double-debiting one approved WITH an effect (the id already exists → skipped).
 */

/** Fixed monthly ROI paid by the Treuhand fund on deployed token capital. */
export const TRADING_FUND_MONTHLY_ROI = 0.25

const FUND_LABEL = "Treuhand AG Limited Hedge Fund"

/**
 * Every active MONTHLY ROI period between activation and `now`, credited in
 * advance: the activation month (dated at the exact activation instant so it
 * reflects immediately) followed by the first of every subsequent calendar
 * month up to and including the current one. `end` (a future termination date)
 * stops the series — no ROI is paid for a month that begins on/after `end`.
 */
function activeRoiMonths(start: Date, now: Date, end?: Date): { yearMonth: string; date: Date }[] {
  const out: { yearMonth: string; date: Date }[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return out
  let year = start.getFullYear()
  let month = start.getMonth()
  for (let i = 0; i < 1200; i++) {
    const monthStart = new Date(year, month, 1, 0, 0, 0, 0)
    // The activation month posts at the activation instant, not the 1st.
    const postDate = monthStart.getTime() < start.getTime() ? start : monthStart
    if (postDate.getTime() > now.getTime()) break
    if (end && postDate.getTime() >= end.getTime()) break
    out.push({ yearMonth: yearMonthKey(monthStart), date: postDate })
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }
  return out
}

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

  // 2. Fixed 25% monthly ROI, paid in advance for every active month — the
  //    activation month immediately, then each subsequent month. Pass an `end`
  //    date (future termination) to `activeRoiMonths` to stop the series.
  const monthlyRoi = round2(capital * TRADING_FUND_MONTHLY_ROI)
  if (monthlyRoi > 0) {
    for (const period of activeRoiMonths(start, now)) {
      posts.push({
        id: tradingFundRoiId(req.id, period.yearMonth),
        direction: "credit",
        amount: monthlyRoi,
        currency,
        status: "completed",
        date: period.date.toISOString(),
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Fund ROI",
        comment: `Monthly ${(TRADING_FUND_MONTHLY_ROI * 100).toFixed(0)}% ROI on the ${FUND_LABEL}${tokenNote} for ${period.yearMonth}.`,
      })
    }
  }

  return posts
}
