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
 *   2. The fund pays a fixed 25% MONTHLY ROI, credited IN ARREARS: a CREDIT of
 *      `capital * 25%` matures only after each FULL month of the capital being
 *      deployed. The first ROI posts one month after activation (e.g. deployed
 *      Aug 7 → first ROI Sep 7), then on each subsequent monthly anniversary
 *      for as long as the subscription is active. No ROI is ever paid in
 *      advance — the client must wait a full month for each payment to mature.
 *
 * There is no server scheduler, so — exactly like the AES funding cost-of-
 * capital engine — credits are posted lazily: every reconcile posts any matured
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

/** Add `n` whole months to a date, clamping the day to the target month length. */
function addMonths(base: Date, n: number): Date {
  const d = new Date(base.getTime())
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, daysInMonth))
  return d
}

/**
 * Every 25% ROI payment that has MATURED by `now`, in arrears. ROI matures on
 * each monthly anniversary of the activation date — the first a full month
 * AFTER activation (never on the activation day itself), then monthly. `end`
 * (a future termination date) stops the series: nothing matures on/after it.
 */
function maturedRoiMonths(start: Date, now: Date, end?: Date): { yearMonth: string; date: Date }[] {
  const out: { yearMonth: string; date: Date }[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return out
  for (let n = 1; n <= 1200; n++) {
    const date = addMonths(start, n)
    if (date.getTime() > now.getTime()) break
    if (end && date.getTime() >= end.getTime()) break
    out.push({ yearMonth: yearMonthKey(date), date })
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

  // Admin-authorized exit: once set, ROI stops maturing on/after this date. The
  // capital debit still stands (the deployment already happened). Only an
  // administrator can set `exitedAt` (see `exitTradingFund` in the approvals
  // action), so a client can never end their own ROI schedule.
  const exitedAtRaw = (req.payload as { exitedAt?: string })?.exitedAt
  const exitedAt = exitedAtRaw ? new Date(exitedAtRaw) : undefined
  const exitDate = exitedAt && !Number.isNaN(exitedAt.getTime()) ? exitedAt : undefined

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

  // 2. Fixed 25% monthly ROI, in arrears — the first payment matures one full
  //    month after activation, then on each monthly anniversary. Pass an `end`
  //    date (future termination) to `maturedRoiMonths` to stop the series.
  const monthlyRoi = round2(capital * TRADING_FUND_MONTHLY_ROI)
  if (monthlyRoi > 0) {
    for (const period of maturedRoiMonths(start, now, exitDate)) {
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
