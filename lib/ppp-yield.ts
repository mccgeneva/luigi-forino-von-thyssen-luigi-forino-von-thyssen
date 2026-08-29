import type { LedgerEntry } from "@/lib/ledger-store"
import type { ApprovalRequest } from "@/lib/approvals-db"
import { round2 } from "@/lib/interest-accrual"

/**
 * NAFTAhub Yield / PPP — automatic periodic ROI -> Master Account.
 *
 * Once a Yield/PPP application is APPROVED by an administrator, the program pays
 * its ROI automatically, IN ARREARS, on a fixed cycle (weekly / monthly / …):
 * the first payout matures one full period after activation, then on each
 * subsequent period boundary, up to the program's stated duration (term). Each
 * matured payout is CREDITED to the client's Master Account.
 *
 * 75 / 25 BENEFIT SPLIT: when the investment is funded by an instrument owned by
 * MCC HOLDING SA (acquired via reserve/assign — the client is the assignee), the
 * RETURN is alienated 75% to MCC HOLDING SA and 25% to the client. In that case
 * only the client's 25% share is credited to their Master Account; the gross and
 * the MCC share are documented in the entry comment. Funded from the client's
 * own means (no MCC instrument) → the client keeps 100% of the return.
 *
 * There is no server scheduler, so — exactly like the Treuhand fund engine — the
 * posts are made LAZILY: every reconcile posts any matured periods not yet on the
 * ledger. All entries use deterministic ids so reconciliation is fully idempotent
 * (never double-credits), and the balance follows the user across devices.
 *
 * CAPITAL LEG: `buildPppCapitalPosts` handles the invested principal — it is
 * DEBITED from the Master Account when the program is approved (the capital is
 * deployed into the program) and RETURNED once the program term elapses. Early
 * cancellation returns the principal too (handled by the cancel action). This
 * `buildPppRoiPosts` function covers ONLY the periodic ROI the client earns.
 */

/**
 * Early-cancellation penalty rate for an ONGOING (approved) yield/PPP program,
 * as a fraction of the invested principal. Charged from the client's Master
 * Account when they cancel before the program's term ends.
 */
export const YIELD_EARLY_CANCELLATION_PENALTY_RATE = 0.02

/** The early-cancellation penalty (2% of the invested principal), rounded. */
export function yieldCancellationPenalty(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return round2(amount * YIELD_EARLY_CANCELLATION_PENALTY_RATE)
}

/** How often a program pays out. `maturity` = a single payout at term end. */
export type YieldPeriodUnit = "day" | "week" | "month" | "quarter" | "year" | "maturity"

/** The lower-bound rate (as a %) parsed from a program's expected-return string. */
export function parseYieldRatePct(expectedReturn: string | undefined): number {
  if (!expectedReturn) return 0
  const m = expectedReturn.match(/\d+(\.\d+)?/)
  const pct = m ? Number.parseFloat(m[0]) : 0
  return Number.isFinite(pct) && pct > 0 ? pct : 0
}

/** Map a free-text return frequency to a payout cycle. Defaults to monthly. */
export function parseYieldPeriod(returnFrequency: string | undefined): YieldPeriodUnit {
  const f = (returnFrequency ?? "").toLowerCase()
  if (f.includes("matur")) return "maturity"
  if (f.includes("day") || f.includes("daily")) return "day"
  if (f.includes("week")) return "week"
  if (f.includes("quarter")) return "quarter"
  if (f.includes("year") || f.includes("annual")) return "year"
  if (f.includes("month")) return "month"
  return "month"
}

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

/** The date of the Nth payout period after `start` for a given cycle. */
function addPeriods(start: Date, n: number, unit: YieldPeriodUnit): Date {
  switch (unit) {
    case "day":
      return new Date(start.getTime() + n * 24 * 60 * 60 * 1000)
    case "week":
      return new Date(start.getTime() + n * 7 * 24 * 60 * 60 * 1000)
    case "quarter":
      return addMonths(start, n * 3)
    case "year":
      return addMonths(start, n * 12)
    case "month":
    default:
      return addMonths(start, n)
  }
}

/**
 * Parse a program duration string ("12 months", "40 banking weeks", "1 year", …)
 * into a term-end date measured from `activation`. Falls back to 12 months when
 * the string can't be understood, so ROI is always bounded by a term.
 */
export function parseYieldTermEnd(duration: string | undefined, activation: Date): Date {
  const s = (duration ?? "").toLowerCase()
  const m = s.match(/(\d+(\.\d+)?)/)
  const n = m ? Number.parseFloat(m[0]) : NaN
  if (!Number.isFinite(n) || n <= 0) return addMonths(activation, 12)
  if (s.includes("day")) return new Date(activation.getTime() + n * 24 * 60 * 60 * 1000)
  if (s.includes("week")) return new Date(activation.getTime() + n * 7 * 24 * 60 * 60 * 1000)
  if (s.includes("quarter")) return addMonths(activation, Math.round(n) * 3)
  if (s.includes("year") || s.includes("annual")) return addMonths(activation, Math.round(n) * 12)
  if (s.includes("month")) return addMonths(activation, Math.round(n))
  return addMonths(activation, 12)
}

/** Deterministic ledger id for the Nth matured ROI payout (1-based). */
export function pppRoiId(reqId: string, periodIndex: number): string {
  return `PPP-ROI-${reqId}-P${periodIndex}`
}

/** Deterministic ledger id for the invested principal DEBIT (capital deployed). */
export function pppCapitalId(reqId: string): string {
  return `PPP-CAPITAL-${reqId}`
}

/** Deterministic ledger id for the principal RETURN (maturity or cancellation). */
export function pppCapitalReturnId(reqId: string): string {
  return `PPP-CAPITAL-RETURN-${reqId}`
}

/**
 * A PPP is CASH-funded when NO bank instrument is pledged to back it. Only a
 * cash-funded program moves money on the master account (principal debited on
 * approval, returned at maturity). An INSTRUMENT-funded program is collateralized
 * by the pledged instrument, so no cash leaves the balance.
 */
export function pppIsCashFunded(record: { fundingInstrumentId?: string } | undefined): boolean {
  return !record?.fundingInstrumentId
}

/** The date a program is activated (and from which ROI accrues). */
function activationDate(req: ApprovalRequest): Date {
  return req.decidedAt ? new Date(req.decidedAt) : new Date(req.createdAt)
}

/** Human label for the payout cycle, used in ledger comments. */
function periodLabel(unit: YieldPeriodUnit): string {
  switch (unit) {
    case "day":
      return "daily"
    case "week":
      return "weekly"
    case "quarter":
      return "quarterly"
    case "year":
      return "annual"
    case "maturity":
      return "at-maturity"
    case "month":
    default:
      return "monthly"
  }
}

/** Compact money label for engine-generated ledger comments. */
function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

interface PppRecord {
  amount?: number
  currency?: string
  programName?: string
  expectedReturn?: string
  returnFrequency?: string
  duration?: string
  fundingInstrumentId?: string
  fundingInstrumentLabel?: string
  mccBenefitRate?: number
  clientBenefitRate?: number
  /** True when the program was funded with leverage/debit money (stamped at
   *  submission). Leverage-funded ROI is credited but locked until the program
   *  matures; real-money ROI is freely withdrawable. */
  leverageFunded?: boolean
}

/**
 * Every ROI credit an APPROVED Yield/PPP application has already earned by `now`,
 * in arrears and bounded by the program term. Returns an empty array for any
 * non-approved / non-ppp request. Deterministic ids keep it idempotent.
 */
export function buildPppRoiPosts(req: ApprovalRequest, now: Date = new Date()): LedgerEntry[] {
  if (req.kind !== "ppp") return []
  if (req.status !== "approved") return []

  const record = ((req.payload as { record?: PppRecord } | undefined)?.record ?? {}) as PppRecord

  const amount = Number(record.amount ?? req.amount)
  if (!Number.isFinite(amount) || amount <= 0) return []

  const currency = record.currency || req.currency || "USD"
  const ratePct = parseYieldRatePct(record.expectedReturn)
  if (ratePct <= 0) return []

  const unit = parseYieldPeriod(record.returnFrequency)
  const start = activationDate(req)
  if (Number.isNaN(start.getTime())) return []
  const termEnd = parseYieldTermEnd(record.duration, start)
  const termEndMs = termEnd.getTime()
  const nowMs = now.getTime()

  // Gross ROI per period, then the client's share after the 75/25 split when the
  // investment is funded by an MCC HOLDING SA-owned instrument.
  const grossPerPeriod = round2((amount * ratePct) / 100)
  if (grossPerPeriod <= 0) return []
  const hasSplit = !!record.fundingInstrumentId
  const clientRate = hasSplit ? (record.clientBenefitRate ?? 0.25) : 1
  const mccRate = hasSplit ? (record.mccBenefitRate ?? 0.75) : 0
  const clientPerPeriod = round2(grossPerPeriod * clientRate)
  if (clientPerPeriod <= 0) return []

  const programName = record.programName || req.title || "Yield / PPP program"
  const splitNote = hasSplit
    ? ` Gross ${formatMoney(grossPerPeriod, currency)} split ${Math.round(mccRate * 100)}% to MCC HOLDING SA / ${Math.round(clientRate * 100)}% to you${record.fundingInstrumentLabel ? ` (funded by ${record.fundingInstrumentLabel})` : ""}.`
    : ""

  // Leverage/debit-funded programs (stamped at submission) LOCK their ROI: each
  // credit reflects on the master account but is not withdrawable until the whole
  // program matures (term end). Real-money programs pay freely-withdrawable ROI.
  // A held credit shows on the ledger yet is excluded from the spendable balance,
  // and flips to `completed` automatically once the program matures (same id → the
  // reconciler updates it).
  const leverageFunded = record.leverageFunded === true
  const unlockNote = ` Leverage-funded: credited but locked (not withdrawable) until the program matures on ${termEnd.toISOString().slice(0, 10)}.`

  // Determine matured payout dates (in arrears): the first one full period after
  // activation, then each cycle, capped at the program term end.
  const posts: LedgerEntry[] = []
  const pushPost = (index: number, date: Date) => {
    const locked = leverageFunded && nowMs < termEndMs
    posts.push({
      id: pppRoiId(req.id, index),
      direction: "credit",
      amount: clientPerPeriod,
      currency,
      status: locked ? "hold" : "completed",
      date: date.toISOString(),
      counterparty: programName,
      reference: req.id,
      category: "NAFTAhub Yield — ROI",
      comment: `${periodLabel(unit)} ROI on ${programName} (${ratePct}% per period).${splitNote}${locked ? unlockNote : ""}`,
    })
  }

  if (unit === "maturity") {
    // A single payout at the end of the term.
    if (nowMs >= termEndMs) pushPost(1, termEnd)
    return posts
  }

  // Recurring cycle, bounded to avoid an unbounded loop on odd data.
  const MAX_PERIODS = 1040
  for (let n = 1; n <= MAX_PERIODS; n++) {
    const d = addPeriods(start, n, unit)
    const dMs = d.getTime()
    if (dMs > nowMs) break
    if (dMs > termEndMs) break
    pushPost(n, d)
  }
  return posts
}

/**
 * Principal (capital) movement for an APPROVED, CASH-funded Yield / PPP program:
 *   • a DEBIT of the invested principal from the Master Account when the program
 *     is approved — the capital is deployed into the program (dated at activation);
 *   • a matching CREDIT returning the principal to the Master Account once the
 *     program TERM has fully elapsed (dated at term end).
 *
 * Returns [] for any non-approved / non-ppp request AND for INSTRUMENT-funded
 * programs — those are collateralized by the pledged bank instrument, so no cash
 * ever leaves the master account. Deterministic ids make it idempotent so the
 * principal is debited exactly once and returned exactly once, and — like the ROI
 * engine — it self-heals across devices with no scheduler. (Early cancellation
 * returns the principal via the cancel action, reusing the same
 * `pppCapitalReturnId`, so a cancel and a maturity can never double-return.)
 */
export function buildPppCapitalPosts(req: ApprovalRequest, now: Date = new Date()): LedgerEntry[] {
  if (req.kind !== "ppp") return []
  if (req.status !== "approved") return []

  const record = ((req.payload as { record?: PppRecord } | undefined)?.record ?? {}) as PppRecord
  // Instrument-funded programs pledge collateral instead of cash — no money moves.
  if (!pppIsCashFunded(record)) return []
  const amount = Number(record.amount ?? req.amount)
  if (!Number.isFinite(amount) || amount <= 0) return []

  const currency = record.currency || req.currency || "USD"
  const start = activationDate(req)
  if (Number.isNaN(start.getTime())) return []
  const principal = round2(amount)
  const programName = record.programName || req.title || "Yield / PPP program"

  const posts: LedgerEntry[] = [
    {
      id: pppCapitalId(req.id),
      direction: "debit",
      amount: principal,
      currency,
      status: "completed",
      date: start.toISOString(),
      counterparty: programName,
      reference: req.id,
      category: "NAFTAhub Yield — Capital Invested",
      comment: `Principal of ${formatMoney(principal, currency)} deployed into ${programName}.`,
    },
  ]

  // Return the principal to the Master Account once the program term has elapsed.
  const termEnd = parseYieldTermEnd(record.duration, start)
  if (now.getTime() >= termEnd.getTime()) {
    posts.push({
      id: pppCapitalReturnId(req.id),
      direction: "credit",
      amount: principal,
      currency,
      status: "completed",
      date: termEnd.toISOString(),
      counterparty: programName,
      reference: req.id,
      category: "NAFTAhub Yield — Capital Returned",
      comment: `Principal of ${formatMoney(principal, currency)} returned at maturity of ${programName}.`,
    })
  }
  return posts
}
