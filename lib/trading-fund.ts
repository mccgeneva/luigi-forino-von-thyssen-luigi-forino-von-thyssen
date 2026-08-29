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

/**
 * The fixed engagement term of a Treuhand AG Hedge Fund subscription, in ACTIVE
 * months. After this many matured monthly payments the position AUTOMATICALLY
 * terminates ("expires"): ROI stops, and the deployed capital is returned to the
 * master account — exactly as an administrator close would, but on a schedule.
 * Paused time never counts toward the term, so a pause pushes the expiry later.
 */
export const TRADING_FUND_TERM_MONTHS = 12

/**
 * ROI WITHDRAWAL LOCK for a LEVERAGE/DEBIT-funded Treuhand position. Each monthly
 * ROI credit is still shown on the master account the month it is earned, but it
 * is not WITHDRAWABLE until this many months have elapsed FROM THAT CREDIT (a
 * rolling lock — every payment carries its own 3-month unlock). ROI on a position
 * funded with the client's OWN real money is freely withdrawable immediately.
 */
export const TRADING_FUND_ROI_LOCK_MONTHS = 3

/**
 * Platform commission charged on EVERY exit ("when money goes out"), applied to
 * the CAPITAL RETURNED. Debited from the master account at termination, whether
 * the position matures at term end or is terminated early.
 */
export const TRADING_FUND_EXIT_COMMISSION = 0.02

/**
 * Reference rate used only to SUGGEST an early-resignation penalty to the
 * administrator (who has final say and can override). The suggestion is this
 * rate applied to the capital, pro-rated by how much of the term remains — the
 * earlier an investor resigns, the larger the suggested penalty. A position that
 * has reached its term has no remaining term, so the suggested penalty is 0.
 */
export const TRADING_FUND_EARLY_EXIT_PENALTY_RATE = 0.1

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
 * The matured DATE (epoch ms) of the Nth monthly anniversary of `start`, pushed
 * later by any paused time that precedes it (solved as a fixed point) so paused
 * periods never count toward maturity. This is the single source of truth for
 * both ROI payment dates and the engagement's expiry (the Nth = term anniversary).
 */
function deferredAnniversaryMs(start: Date, n: number, pauses: PauseMs[]): number {
  const scheduled = addMonths(start, n).getTime()
  let d = scheduled
  for (let i = 0; i < 10; i++) {
    const nd = scheduled + pausedMsBefore(d, pauses)
    if (nd === d) break
    d = nd
  }
  return d
}

/**
 * Every 25% ROI payment that has MATURED by `now`, in arrears and pause-aware.
 * `closeMs` (an admin exit) stops the series: nothing matures on/after it.
 * `maxIndex` caps the count — the fixed engagement term, after which the
 * position expires and no further ROI accrues. Returns index + matured date.
 */
function maturedRoiPayments(
  start: Date,
  now: Date,
  pauses: PauseMs[],
  closeMs?: number,
  maxIndex = 1200,
): { index: number; date: Date }[] {
  const out: { index: number; date: Date }[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return out
  const nowMs = now.getTime()
  for (let n = 1; n <= maxIndex; n++) {
    const d = deferredAnniversaryMs(start, n, pauses)
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

/** Deterministic ledger id for the 2% exit commission debit posted at exit. */
export function tradingFundCommissionId(reqId: string): string {
  return `TFUND-COMM-${reqId}`
}

/** Deterministic ledger id for the early-resignation penalty debit. */
export function tradingFundPenaltyId(reqId: string): string {
  return `TFUND-PENALTY-${reqId}`
}

/** Deterministic ledger id for any additional exit charges debit. */
export function tradingFundChargesId(reqId: string): string {
  return `TFUND-CHARGE-${reqId}`
}

/** The date a subscription's capital is deployed (and from which ROI accrues). */
function activationDate(req: ApprovalRequest): Date {
  return req.decidedAt ? new Date(req.decidedAt) : new Date(req.createdAt)
}

/**
 * Every ledger post a Treuhand fund subscription implies, keyed to its status:
 *
 *   - PENDING  → a single `hold` debit that RESERVES / BLOCKS the capital on the
 *     master account while the administrator reviews the application. The funds
 *     are frozen (not yet spent), so the client cannot double-spend them.
 *   - APPROVED → the `hold` becomes a permanent `completed` debit (capital
 *     deployed / deducted, reflecting on the master account) plus each matured
 *     monthly 25% ROI credit and, once closed, the capital-return credit.
 *   - any other status (rejected / cancelled) → nothing; the reservation hold is
 *     released by the reconciler / decision action.
 *
 * The capital entry uses the SAME `APPR-<id>` id in both phases, so approval
 * simply upgrades the reservation hold into a settled debit (no double-count),
 * and callers overwrite when the status differs. Posting is idempotent.
 */
export function buildTradingFundPosts(req: ApprovalRequest, now: Date = new Date()): LedgerEntry[] {
  if (req.kind !== "trading_fund") return []
  if (req.status !== "pending" && req.status !== "approved") return []

  const capital = Number(req.amount ?? (req.payload as { capital?: number })?.capital)
  if (!Number.isFinite(capital) || capital <= 0) return []

  const currency = req.currency || "EUR"

  const tokens = Number((req.payload as { tokens?: number })?.tokens)
  const tokenNote = Number.isFinite(tokens) && tokens > 0 ? ` (${tokens} token${tokens === 1 ? "" : "s"})` : ""

  // PENDING application → reserve/block the capital so it is frozen on the
  // master account until the administrator decides. No ROI accrues while
  // pending. This is the single entry the client sees as "reserved".
  if (req.status === "pending") {
    return [
      {
        id: tradingFundCapitalDebitId(req.id),
        direction: "debit",
        amount: capital,
        currency,
        status: "hold",
        date: new Date(req.createdAt).toISOString(),
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Reserved for Fund Subscription",
        comment: `Reserved for a pending ${FUND_LABEL} subscription${tokenNote} — awaiting authorization.`,
      },
    ]
  }

  const start = activationDate(req)
  if (Number.isNaN(start.getTime())) return []

  const payload = (req.payload ?? {}) as {
    pauseWindows?: TradingFundPauseWindow[]
    closedAt?: string
    exitedAt?: string
    earlyPenaltyAmount?: number
    exitChargesAmount?: number
    exitChargesNote?: string
  }

  // Admin-authorized close/exit: once set, ROI stops maturing on/after this
  // instant and the capital is returned. `exitedAt` is accepted as an alias for
  // back-compatibility. Only an administrator can set these markers (via the
  // pause/resume/close server actions), so a client can never end their own
  // schedule or reclaim capital early.
  const closeRaw = payload.closedAt ?? payload.exitedAt
  const closeDate = closeRaw ? new Date(closeRaw) : undefined
  const adminCloseMs = closeDate && !Number.isNaN(closeDate.getTime()) ? closeDate.getTime() : undefined

  // Paused windows never count as active deployment. Open (ongoing) pauses end
  // at the close instant if closed, otherwise at `now`.
  const pauses = normalizePauses(payload.pauseWindows, adminCloseMs ?? now.getTime())

  // Automatic maturity: the engagement lasts exactly TRADING_FUND_TERM_MONTHS
  // ACTIVE months. Its expiry is the term-th monthly anniversary (pause-aware),
  // and the position terminates at the EARLIER of that and any admin close.
  const expiryMs = deferredAnniversaryMs(start, TRADING_FUND_TERM_MONTHS, pauses)
  const terminationMs = adminCloseMs != null ? Math.min(adminCloseMs, expiryMs) : expiryMs
  // ROI halts strictly before an admin close, but the final term payment matures
  // exactly at expiry and must still be paid — so only an admin close gates ROI.
  const roiStopMs = adminCloseMs

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

  // Was this subscription funded with LEVERAGE/DEBIT money? Stamped at submission
  // from the account's borrowed exposure. Only a leverage-funded position locks
  // its ROI; a position funded with the client's own real money pays freely-
  // withdrawable ROI.
  const leverageFunded = (req.payload as { leverageFunded?: boolean } | undefined)?.leverageFunded === true

  // 2. Fixed 25% monthly ROI, in arrears and pause-aware — the first payment
  //    matures one full ACTIVE month after activation, then each active month,
  //    up to the fixed engagement term (after which the position expires).
  //    LEVERAGE-funded: each ROI is CREDITED (reflects on the master account) but
  //    HELD — not withdrawable — until TRADING_FUND_ROI_LOCK_MONTHS have elapsed
  //    from that credit (rolling). A held credit shows on the ledger yet is
  //    excluded from the spendable balance, and flips to `completed` (withdrawable)
  //    automatically once its unlock date passes (same id → the reconciler updates
  //    it). REAL-money positions post `completed` immediately.
  const monthlyRoi = round2(capital * TRADING_FUND_MONTHLY_ROI)
  if (monthlyRoi > 0) {
    const nowMs = now.getTime()
    for (const period of maturedRoiPayments(start, now, pauses, roiStopMs, TRADING_FUND_TERM_MONTHS)) {
      let unlockMs = 0
      if (leverageFunded) {
        const u = new Date(period.date)
        u.setMonth(u.getMonth() + TRADING_FUND_ROI_LOCK_MONTHS)
        unlockMs = u.getTime()
      }
      const locked = leverageFunded && nowMs < unlockMs
      posts.push({
        id: tradingFundRoiId(req.id, period.index),
        direction: "credit",
        amount: monthlyRoi,
        currency,
        status: locked ? "hold" : "completed",
        date: period.date.toISOString(),
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Fund ROI",
        comment: locked
          ? `Month ${period.index} of ${TRADING_FUND_TERM_MONTHS} — ${(TRADING_FUND_MONTHLY_ROI * 100).toFixed(0)}% ROI on the ${FUND_LABEL}${tokenNote}. Leverage-funded: credited but locked (not withdrawable) until ${new Date(unlockMs).toISOString().slice(0, 10)} — ${TRADING_FUND_ROI_LOCK_MONTHS} months from this credit.`
          : `Month ${period.index} of ${TRADING_FUND_TERM_MONTHS} — ${(TRADING_FUND_MONTHLY_ROI * 100).toFixed(0)}% ROI on the ${FUND_LABEL}${tokenNote}.`,
      })
    }
  }

  // 3. Position terminated → return the deployed capital (the tokens) to the
  //    master account, netting the original debit to zero. This fires either
  //    when an administrator closes early OR automatically when the engagement
  //    term expires, whichever comes first. On EVERY exit the platform charges a
  //    2% commission on the returned capital, plus — for an EARLY resignation the
  //    administrator has reconciled — any penalty and charges recorded on the
  //    payload. All fees are dated at termination and referenced to the position.
  if (adminCloseMs != null || now.getTime() >= expiryMs) {
    const byAdmin = adminCloseMs != null && adminCloseMs <= expiryMs
    const terminationIso = new Date(terminationMs).toISOString()

    // 3a. Capital returned.
    posts.push({
      id: tradingFundReturnId(req.id),
      direction: "credit",
      amount: capital,
      currency,
      status: "completed",
      date: terminationIso,
      counterparty: FUND_LABEL,
      reference: req.id,
      category: "NAFTAhub Trading — Fund Exit",
      comment: byAdmin
        ? `Position closed by the administrator — capital${tokenNote} returned to the master account.`
        : `Engagement term reached — position expired, capital${tokenNote} returned to the master account.`,
    })

    // 3b. 2% platform commission on the capital going out (every exit).
    const commission = round2(capital * TRADING_FUND_EXIT_COMMISSION)
    if (commission > 0) {
      posts.push({
        id: tradingFundCommissionId(req.id),
        direction: "debit",
        amount: commission,
        currency,
        status: "completed",
        date: terminationIso,
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Exit Commission",
        comment: `${(TRADING_FUND_EXIT_COMMISSION * 100).toFixed(0)}% platform commission on ${formatFundMoney(capital, currency)} of capital withdrawn.`,
      })
    }

    // 3c. Early-resignation penalty (admin-reconciled, early exits only).
    const penalty = round2(Math.max(0, Number(payload.earlyPenaltyAmount) || 0))
    if (penalty > 0) {
      posts.push({
        id: tradingFundPenaltyId(req.id),
        direction: "debit",
        amount: penalty,
        currency,
        status: "completed",
        date: terminationIso,
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Early Termination Penalty",
        comment: `Penalty applied for anticipated resignation from the ${FUND_LABEL} engagement.`,
      })
    }

    // 3d. Any additional charges the administrator recorded at reconciliation.
    const charges = round2(Math.max(0, Number(payload.exitChargesAmount) || 0))
    if (charges > 0) {
      posts.push({
        id: tradingFundChargesId(req.id),
        direction: "debit",
        amount: charges,
        currency,
        status: "completed",
        date: terminationIso,
        counterparty: FUND_LABEL,
        reference: req.id,
        category: "NAFTAhub Trading — Exit Charges",
        comment: payload.exitChargesNote?.trim()
          ? `Exit charges: ${payload.exitChargesNote.trim()}`
          : "Additional charges applied at reconciliation.",
      })
    }
  }

  return posts
}

/** Compact money label for engine-generated ledger comments. */
function formatFundMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** A complete, client-facing view of a Treuhand fund position's lifecycle. */
export interface TradingFundView {
  /** Fixed engagement term, in months. */
  termMonths: number
  /** Fixed monthly ROI rate (e.g. 0.25). */
  monthlyRoiRate: number
  /** When the capital was deployed and ROI began accruing. */
  activation: Date
  /** When the engagement automatically terminates (capital returned). */
  expiry: Date
  /** True once the term has been reached (position matured/expired). */
  expired: boolean
  /** Calendar days since activation (clamped to the term length). */
  daysElapsed: number
  /** Total calendar days across the whole engagement (activation → expiry). */
  daysTotal: number
  /** Calendar days remaining until automatic termination (>= 0). */
  daysRemaining: number
  /** Progress through the term, 0..1. */
  termProgress: number
  /** Monthly payments already matured (paid). */
  monthsMatured: number
  /** Monthly payments still to come before expiry. */
  monthsRemaining: number
  /** One month's ROI amount. */
  monthlyRoiAmount: number
  /** ROI paid so far (authoritative, from the ledger). */
  roiMatured: number
  /** Total ROI paid across the full term. */
  roiPerTerm: number
  /** ROI still to be paid before expiry (>= 0). */
  roiRemaining: number
  /** Capital originally deployed. */
  capitalStarted: number
  /** Total value returned at maturity: capital + all ROI over the term. */
  capitalAtMaturity: number
  /** The next scheduled ROI payout date, or null once fully matured. */
  nextRoiDate: Date | null
}

/**
 * Build the full lifecycle view of a position for the trading dashboard. Driven
 * purely by the values the client's own ledger already exposes (capital,
 * activation date, ROI paid), plus the fixed term — so it stays consistent with
 * the ledger the master account reads. Pause windows (admin-only, rarely set)
 * are optional; when omitted the term runs on calendar time.
 */
export function analyzeTradingFundPosition(opts: {
  capitalStarted: number
  activation: Date
  roiMatured: number
  now?: Date
  pauseWindows?: TradingFundPauseWindow[]
}): TradingFundView {
  const now = opts.now ?? new Date()
  const capital = Math.max(0, opts.capitalStarted)
  const activation = opts.activation
  const pauses = normalizePauses(opts.pauseWindows, now.getTime())

  const monthlyRoiAmount = round2(capital * TRADING_FUND_MONTHLY_ROI)
  const roiPerTerm = round2(monthlyRoiAmount * TRADING_FUND_TERM_MONTHS)
  const capitalAtMaturity = round2(capital + roiPerTerm)

  const activationMs = activation.getTime()
  const expiryMs = deferredAnniversaryMs(activation, TRADING_FUND_TERM_MONTHS, pauses)
  const expiry = new Date(expiryMs)
  const nowMs = now.getTime()

  const daysTotal = Math.max(1, Math.round((expiryMs - activationMs) / MS_PER_DAY))
  const daysElapsed = Math.min(daysTotal, Math.max(0, Math.round((nowMs - activationMs) / MS_PER_DAY)))
  const daysRemaining = Math.max(0, Math.ceil((expiryMs - nowMs) / MS_PER_DAY))
  const expired = nowMs >= expiryMs
  const termProgress = Math.min(1, Math.max(0, daysElapsed / daysTotal))

  const monthsMatured =
    monthlyRoiAmount > 0
      ? Math.min(TRADING_FUND_TERM_MONTHS, Math.round(opts.roiMatured / monthlyRoiAmount))
      : 0
  const monthsRemaining = Math.max(0, TRADING_FUND_TERM_MONTHS - monthsMatured)
  const roiRemaining = round2(Math.max(0, roiPerTerm - opts.roiMatured))

  const nextRoiDate =
    !expired && monthsMatured < TRADING_FUND_TERM_MONTHS
      ? new Date(deferredAnniversaryMs(activation, monthsMatured + 1, pauses))
      : null

  return {
    termMonths: TRADING_FUND_TERM_MONTHS,
    monthlyRoiRate: TRADING_FUND_MONTHLY_ROI,
    activation,
    expiry,
    expired,
    daysElapsed,
    daysTotal,
    daysRemaining,
    termProgress,
    monthsMatured,
    monthsRemaining,
    monthlyRoiAmount,
    roiMatured: round2(opts.roiMatured),
    roiPerTerm,
    roiRemaining,
    capitalStarted: capital,
    capitalAtMaturity,
    nextRoiDate,
  }
}

/** The reconciliation figures for terminating a Treuhand position. */
export interface TradingFundExitQuote {
  /** Whether this is an early resignation (term not yet reached). */
  early: boolean
  /** Whole months of the term already served. */
  monthsServed: number
  /** Whole months still remaining in the term. */
  monthsRemaining: number
  /** Capital returned to the master account. */
  capitalReturned: number
  /** ROI already matured and paid over the life of the position. */
  roiMatured: number
  /** 2% platform commission on the capital returned. */
  commission: number
  /** Early-resignation penalty being applied (admin-decided). */
  penalty: number
  /** Any additional charges being applied (admin-decided). */
  charges: number
  /** Administrator's suggested penalty (term-scaled; admin may override). */
  suggestedPenalty: number
  /** Net amount credited to the master account at exit = capital − all fees. */
  netCredited: number
}

/**
 * Compute the money movement of terminating a position, for the admin
 * reconciliation panel and the client's pre-request preview. Matured ROI is
 * derived deterministically from the activation date (the same schedule the
 * ledger posts), so the quote is authoritative without reading the ledger.
 * `penalty`/`charges` are the administrator's inputs (default 0 → the client
 * preview shows the commission-only floor).
 */
export function quoteTradingFundExit(opts: {
  capitalStarted: number
  activation: Date
  now?: Date
  pauseWindows?: TradingFundPauseWindow[]
  penalty?: number
  charges?: number
}): TradingFundExitQuote {
  const now = opts.now ?? new Date()
  const capital = Math.max(0, opts.capitalStarted)
  const pauses = normalizePauses(opts.pauseWindows, now.getTime())

  const monthsServed = maturedRoiPayments(opts.activation, now, pauses, undefined, TRADING_FUND_TERM_MONTHS).length
  const monthsRemaining = Math.max(0, TRADING_FUND_TERM_MONTHS - monthsServed)
  const roiMatured = round2(capital * TRADING_FUND_MONTHLY_ROI * monthsServed)

  const expiryMs = deferredAnniversaryMs(opts.activation, TRADING_FUND_TERM_MONTHS, pauses)
  const early = now.getTime() < expiryMs

  const commission = round2(capital * TRADING_FUND_EXIT_COMMISSION)
  const penalty = round2(Math.max(0, opts.penalty ?? 0))
  const charges = round2(Math.max(0, opts.charges ?? 0))

  // Term-scaled suggestion: the more of the term remains, the larger the hint.
  const suggestedPenalty = early
    ? round2(capital * TRADING_FUND_EARLY_EXIT_PENALTY_RATE * (monthsRemaining / TRADING_FUND_TERM_MONTHS))
    : 0

  const netCredited = round2(Math.max(0, capital - commission - penalty - charges))

  return {
    early,
    monthsServed,
    monthsRemaining,
    capitalReturned: capital,
    roiMatured,
    commission,
    penalty,
    charges,
    suggestedPenalty,
    netCredited,
  }
}
