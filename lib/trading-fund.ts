import type { LedgerEntry } from "@/lib/ledger-store"
import type { ApprovalRequest } from "@/lib/approvals-db"
import { round2 } from "@/lib/interest-accrual"

/**
 * NAFTAhub Trading — Treuhand AG Limited Hedge Fund -> Master Account.
 *
 * When a token subscription is APPROVED, two things must reflect on the
 * client's master account ledger:
 *
 *   1. The subscribed CAPITAL is DEBITED once — it is deployed to the fund and
 *      leaves the master account.
 *   2. The fund pays a fixed 25% MONTHLY ROI, credited IN ARREARS: a CREDIT of
 *      `capital * 25%` matures only after each FULL month of ACTIVE deployment.
 *      The first ROI posts one month after activation (e.g. deployed Aug 7 →
 *      first ROI Sep 7), then on each subsequent monthly anniversary. No ROI is
 *      ever paid in advance — the client must wait a full active month.
 *
 * ADMINISTRATOR POSITION CONTROL (only an administrator can drive these — the
 * markers live in the approval payload and are written solely by the admin
 * actions `pause/resume/closeTradingFundPosition`):
 *   - PAUSE: a pause window `{ from }` is opened. Paused time does NOT count as
 *     active deployment, so ROI stops maturing and every future anniversary is
 *     deferred by the paused duration. RESUME closes the window `{ from, to }`
 *     and accrual continues where it left off.
 *   - CLOSE / EXIT: `closedAt` is set. ROI stops maturing on/after that instant,
 *     and the deployed CAPITAL (the tokens) is CREDITED BACK to the master
 *     account — netting the original debit to zero. Matured ROI already earned
 *     before the close stays paid.
 *
 * There is no server scheduler, so — exactly like the AES funding cost-of-
 * capital engine — posts are made lazily: every reconcile posts any matured
 * months (and the close return) not yet on the ledger. All entries use
 * deterministic ids so reconciliation is fully idempotent (never double-posts).
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

/** A window during which the position was paused by an administrator. */
export interface TradingFundPauseWindow {
  from: string
  to?: string
}

/** Normalized pause window in epoch ms; an open pause ends at `cutoff`. */
interface PauseMs {
  from: number
  to: number
}

function normalizePauses(windows: TradingFundPauseWindow[] | undefined, cutoffMs: number): PauseMs[] {
  if (!Array.isArray(windows)) return []
  const out: PauseMs[] = []
  for (const w of windows) {
    const from = new Date(w.from).getTime()
    if (Number.isNaN(from)) continue
    const toRaw = w.to ? new Date(w.to).getTime() : cutoffMs
    const to = Number.isNaN(toRaw) ? cutoffMs : toRaw
    if (to > from) out.push({ from, to })
  }
  return out
}

/** Total paused milliseconds that fall strictly before instant `x`. */
function pausedMsBefore(x: number, pauses: PauseMs[]): number {
  let total = 0
  for (const p of pauses) {
    const hi = Math.min(p.to, x)
    if (hi > p.from) total += hi - p.from
  }
  return total
}

/**
 * Every 25% ROI payment that has MATURED by `now`, in arrears and pause-aware.
 * A payment's naive anniversary `addMonths(start, n)` is pushed later by any
 * paused time that precedes it (solved as a fixed point), so paused periods
 * never count toward maturity. `closeMs` (an admin exit) stops the series:
 * nothing matures on/after it. Returns the payment index and its matured date.
 */
function maturedRoiPayments(
  start: Date,
  now: Date,
  pauses: PauseMs[],
  closeMs?: number,
): { index: number; date: Date }[] {
  const out: { index: number; date: Date }[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return out
  const nowMs = now.getTime()
  for (let n = 1; n <= 1200; n++) {
    const scheduled = addMonths(start, n).getTime()
    // Defer the anniversary by the paused time before it (fixed point — the
    // deferral can itself pull earlier pause windows into scope).
    let d = scheduled
    for (let i = 0; i < 10; i++) {
      const nd = scheduled + pausedMsBefore(d, pauses)
      if (nd === d) break
      d = nd
    }
    if (d > nowMs) break
    if (closeMs != null && d >= closeMs) break
    out.push({ index: n, date: new Date(d) })
  }
  return out
}

/** Deterministic ledger id for the one-time capital deployment debit. */
export function tradingFundCapitalDebitId(reqId: string): string {
  return `APPR-${reqId}`
}

/** Deterministic ledger id for the Nth month's 25% ROI credit (1-based). */
export function tradingFundRoiId(reqId: string, monthIndex: number): string {
  return `TFUND-ROI-${reqId}-M${monthIndex}`
}

/** Deterministic ledger id for the capital-return credit posted when closed. */
export function tradingFundReturnId(reqId: string): string {
  return `TFUND-RETURN-${reqId}`
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

  const payload = (req.payload ?? {}) as {
    pauseWindows?: TradingFundPauseWindow[]
    closedAt?: string
    exitedAt?: string
  }

  // Admin-authorized close/exit: once set, ROI stops maturing on/after this
  // instant and the capital is returned. `exitedAt` is accepted as an alias for
  // back-compatibility. Only an administrator can set these markers (via the
  // pause/resume/close server actions), so a client can never end their own
  // schedule or reclaim capital early.
  const closeRaw = payload.closedAt ?? payload.exitedAt
  const closeDate = closeRaw ? new Date(closeRaw) : undefined
  const closeMs = closeDate && !Number.isNaN(closeDate.getTime()) ? closeDate.getTime() : undefined

  // Paused windows never count as active deployment. Open (ongoing) pauses end
  // at the close instant if closed, otherwise at `now`.
  const pauses = normalizePauses(payload.pauseWindows, closeMs ?? now.getTime())

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

  // 2. Fixed 25% monthly ROI, in arrears and pause-aware — the first payment
  //    matures one full ACTIVE month after activation, then each active month.
  const monthlyRoi = round2(capital * TRADING_FUND_MONTHLY_ROI)
  if (monthlyRoi > 0) {
    for (const period of maturedRoiPayments(start, now, pauses, closeMs)) {
      posts.push({
        id: tradingFundRoiId(req.id, period.index),
        direction: "credit",
        amount: monthlyRoi,
        currency,
        status: "completed",
        date: period.date.toISOString(),
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Fund ROI",
        comment: `Month ${period.index} — ${(TRADING_FUND_MONTHLY_ROI * 100).toFixed(0)}% ROI on the ${FUND_LABEL}${tokenNote}.`,
      })
    }
  }

  // 3. Position closed by the administrator → return the deployed capital (the
  //    tokens) to the master account, netting the original debit to zero.
  if (closeMs != null) {
    posts.push({
      id: tradingFundReturnId(req.id),
      direction: "credit",
      amount: capital,
      currency,
      status: "completed",
      date: new Date(closeMs).toISOString(),
      counterparty: FUND_LABEL,
      reference: req.id,
      category: "NAFTAhub Trading — Fund Exit",
      comment: `Position closed — capital${tokenNote} returned to the master account.`,
    })
  }

  return posts
}
