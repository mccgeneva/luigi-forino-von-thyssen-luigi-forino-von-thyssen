import { round2, accruedInterestToDate } from "@/lib/interest-accrual"
import type { LedgerEntry } from "@/lib/ledger-store"
import type { DebitKind } from "@/lib/debit-schedule"

import {
  buildFundingLedgerPosts,
  buildFundingSettlementPosts,
  computeFundingSettlement,
} from "@/lib/funding-capital"
import type { ProjectFundingRequest } from "@/lib/project-funding-store"

import { buildMonetizationInterestPosts } from "@/lib/monetization-financing"
import { computeTieredInterest } from "@/lib/tiered-debit-interest"
import type { MonetizationRequest } from "@/lib/monetization-requests-store"

import { buildLeverageInterestPosts } from "@/lib/leverage-financing"
import { accruedInterest } from "@/lib/leverage-interest"
import { type LeverageRequest } from "@/lib/leverage-requests-store"

import {
  buildTreasuryFinancingLedgerPosts,
  treasuryFinancingTxns,
  TREASURY_FINANCING_ANNUAL_RATE,
  TREASURY_FINANCING_CURRENCY,
} from "@/lib/treasury-financing"
import type { TreasuryAccount, TreasuryTransaction } from "@/lib/treasury-store"

import {
  buildInternalLoanPosts,
  internalLoanApprovalShim,
  accruedInternalLoanInterest,
  readInternalLoanTerms,
  internalLoanSettlePrincipalId,
  internalLoanSettleInterestId,
  type InternalLoanRecordLike,
} from "@/lib/internal-loan"

/**
 * Unified debit-facility SETTLEMENT engine.
 *
 * A client may, from the "Debits & Financing" page, REVERSE / TERMINATE any of
 * their four financing products (AES project funding, bank-instrument
 * monetization, leverage lines, special treasury financing) or RECONCILE one
 * (bring it current by posting every monthly charge that has come due but is not
 * yet on the ledger). Both operations must be SUPPORTED BY THE MASTER ACCOUNT
 * BALANCE — the caller enforces the balance gate; this module only does the pure
 * money math and produces the exact ledger posts to write.
 *
 * It re-uses each product's own audited accrual engine (never re-deriving the
 * interest math) so the payoff quoted to the client, the balance gate on the
 * server, and the ledger rows finally posted all agree to the cent. Every post
 * carries a deterministic id, so reconciling then terminating (or a double
 * submit) can never double-charge.
 *
 * The termination payoff has up to four parts:
 *   • principal     — the financed capital, returned to MCC;
 *   • interestTail  — cost of capital accrued since the last month-end that has
 *                     not yet been billed at a monthly charge;
 *   • fee           — early-exit settlement fee (AES project funding only);
 *   • dueNow        — monthly charges already due but not yet on the ledger,
 *                     posted as part of the settlement so nothing is skipped.
 *
 *   payoff = principal + interestTail + fee + dueNow
 */

/** A single settlement/reconcile ledger post — always a completed debit. */
export interface SettlePost {
  direction: "debit"
  entry: Omit<LedgerEntry, "direction">
}

/** The computed cost of reversing or reconciling one facility. */
export interface SettlementQuote {
  kind: DebitKind
  facilityId: string
  title: string
  currency: string
  /** Financed capital returned to MCC on termination. */
  principal: number
  /** Outstanding accrued interest since the last billed month-end. */
  interestTail: number
  /** Early-exit settlement fee (AES project funding only; 0 otherwise). */
  fee: number
  /** Monthly charges already due but not yet posted to the ledger. */
  dueNow: number
  /** Total that must leave the balance to TERMINATE: principal+tail+fee+dueNow. */
  payoff: number
  /** Cost to RECONCILE only (post the due monthly charges): equals dueNow. */
  reconcileDue: number
}

export interface FacilityRecords {
  funding?: ProjectFundingRequest[] | null
  monetization?: MonetizationRequest[] | null
  leverage?: LeverageRequest[] | null
  treasury?: TreasuryAccount | null
  internalLoans?: InternalLoanRecordLike[] | null
}

export interface SettlementInput extends FacilityRecords {
  kind: DebitKind
  facilityId: string
  /** Current ledger entries — used to detect which charges are already posted. */
  entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>
  now?: Date
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

function debit(entry: Omit<LedgerEntry, "direction">): SettlePost {
  return { direction: "debit", entry }
}

function sum(posts: SettlePost[]): number {
  return round2(posts.reduce((s, p) => s + p.entry.amount, 0))
}

/** Locate a single facility's source record(s) across the four products. */
function findFacility(input: SettlementInput):
  | { kind: "funding"; record: ProjectFundingRequest }
  | { kind: "monetization"; record: MonetizationRequest }
  | { kind: "leverage"; record: LeverageRequest }
  | { kind: "treasury"; account: TreasuryAccount; txn: TreasuryTransaction }
  | { kind: "internal_loan"; record: InternalLoanRecordLike }
  | null {
  const id = input.facilityId
  switch (input.kind) {
    case "funding": {
      const record = (input.funding ?? []).find((r) => r.id === id)
      return record ? { kind: "funding", record } : null
    }
    case "monetization": {
      const record = (input.monetization ?? []).find((r) => r.id === id)
      return record ? { kind: "monetization", record } : null
    }
    case "leverage": {
      const record = (input.leverage ?? []).find((l) => l.id === id)
      return record ? { kind: "leverage", record } : null
    }
    case "treasury": {
      const account = input.treasury ?? null
      const txn = treasuryFinancingTxns(account).find((t) => t.id === id)
      return account && txn ? { kind: "treasury", account, txn } : null
    }
    case "internal_loan": {
      // The facility id is the DB approval id (what engineFacilityId emits), so
      // match on approvalId first, falling back to the local record id.
      const record = (input.internalLoans ?? []).find((l) => (l.approvalId ?? l.id) === id)
      return record ? { kind: "internal_loan", record } : null
    }
    default:
      return null
  }
}

/**
 * Build the reconcile posts (monthly charges due but not yet on the ledger) for
 * a single facility, using its own product engine. Pure and idempotent.
 */
export function buildReconcilePosts(input: SettlementInput): SettlePost[] {
  const now = input.now ?? new Date()
  const postedIds = new Set(input.entries.map((e) => e.id))
  const found = findFacility(input)
  if (!found) return []

  if (found.kind === "funding") {
    // Debits only (drop the one-time capital credit); a live facility has no
    // settlement legs yet.
    return buildFundingLedgerPosts([found.record], postedIds, now)
      .filter((p) => p.direction === "debit")
      .map((p) => debit(p.entry))
  }
  if (found.kind === "monetization") {
    return buildMonetizationInterestPosts([found.record], postedIds, now).map((p) => debit(p.entry))
  }
  if (found.kind === "leverage") {
    return buildLeverageInterestPosts([found.record], postedIds, now).map((p) => debit(p.entry))
  }
  if (found.kind === "internal_loan") {
    // Only the monthly interest debits are catch-up charges (the one-time
    // principal credit + arrangement fee are posted at approval, not here).
    return buildInternalLoanPosts(internalLoanApprovalShim(found.record), postedIds, now)
      .filter((p) => p.direction === "debit" && p.entry.id.startsWith("ILOAN-INT-"))
      .map((p) => debit(p.entry))
  }
  // treasury — scope the builder to this single drawdown.
  const scoped: TreasuryAccount = { ...found.account, transactions: [found.txn] }
  return buildTreasuryFinancingLedgerPosts(scoped, postedIds, now)
    .filter((p) => p.direction === "debit")
    .map((p) => debit(p.entry))
}

/** All due monthly charges (posted OR not), used to size the interest tail. */
function allDueMonthlyTotal(input: SettlementInput): number {
  const now = input.now ?? new Date()
  const found = findFacility(input)
  if (!found) return 0
  if (found.kind === "funding") {
    return sum(
      buildFundingLedgerPosts([found.record], new Set(), now)
        .filter((p) => p.direction === "debit")
        .map((p) => debit(p.entry)),
    )
  }
  if (found.kind === "monetization") {
    return sum(buildMonetizationInterestPosts([found.record], new Set(), now).map((p) => debit(p.entry)))
  }
  if (found.kind === "leverage") {
    return sum(buildLeverageInterestPosts([found.record], new Set(), now).map((p) => debit(p.entry)))
  }
  if (found.kind === "internal_loan") {
    return sum(
      buildInternalLoanPosts(internalLoanApprovalShim(found.record), new Set(), now)
        .filter((p) => p.direction === "debit" && p.entry.id.startsWith("ILOAN-INT-"))
        .map((p) => debit(p.entry)),
    )
  }
  const scoped: TreasuryAccount = { ...found.account, transactions: [found.txn] }
  return sum(
    buildTreasuryFinancingLedgerPosts(scoped, new Set(), now)
      .filter((p) => p.direction === "debit")
      .map((p) => debit(p.entry)),
  )
}

/**
 * The full result of terminating a facility: the quote, the exact ledger posts
 * to write (reconcile catch-up + settlement legs), and the record patch that
 * marks the facility settled so it stops accruing.
 */
export interface TerminationPlan {
  quote: SettlementQuote
  /** Due monthly catch-up charges to post first (idempotent). */
  reconcilePosts: SettlePost[]
  /** Principal + interest tail (+ early-exit fee) settlement legs. */
  settlementPosts: SettlePost[]
  /** Fields to merge into the facility record to mark it settled. */
  closePatch: Record<string, unknown>
}

/** Deterministic settlement leg ids (align client display, gate, and posts). */
export const leverageSettlementPrincipalId = (id: string) => `LEV-SETTLE-PRIN-${id}`
export const leverageSettlementInterestId = (id: string) => `LEV-SETTLE-INT-${id}`
export const monetizationSettlementPrincipalId = (id: string) => `MON-SETTLE-PRIN-${id}`
export const monetizationSettlementInterestId = (id: string) => `MON-SETTLE-INT-${id}`
export const treasurySettlementPrincipalId = (id: string) => `TRY-SETTLE-PRIN-${id}`
export const treasurySettlementInterestId = (id: string) => `TRY-SETTLE-INT-${id}`

/**
 * Compute the termination plan for one facility. Pure and deterministic in
 * (records, ledger entries, now); returns null when the facility can't be found
 * or is already closed.
 */
export function buildTerminationPlan(input: SettlementInput): TerminationPlan | null {
  const now = input.now ?? new Date()
  const found = findFacility(input)
  if (!found) return null

  const reconcilePosts = buildReconcilePosts(input)
  const dueNow = sum(reconcilePosts)
  const dateIso = now.toISOString()

  if (found.kind === "funding") {
    const r = found.record
    if (r.closedAt) return null
    const closedRecord: ProjectFundingRequest = {
      ...r,
      closedAt: dateIso,
      closureKind: "client_early",
    }
    const settlement = computeFundingSettlement(closedRecord, now)
    const settlementPosts = buildFundingSettlementPosts(closedRecord).map((p) => debit(p.entry))
    const quote: SettlementQuote = {
      kind: "funding",
      facilityId: r.id,
      title: r.projectName || "AES project facility",
      currency: r.currency,
      principal: settlement.principal,
      interestTail: settlement.interest,
      fee: settlement.fee,
      dueNow,
      payoff: round2(settlement.total + dueNow),
      reconcileDue: dueNow,
    }
    return {
      quote,
      reconcilePosts,
      settlementPosts,
      closePatch: {
        closedAt: dateIso,
        closureKind: "client_early",
        closureNote: "Early closure executed by the client from Debits & Financing.",
        settlement,
        closureRequest: null,
      },
    }
  }

  if (found.kind === "leverage") {
    const line = found.record
    if (line.closedAt) return null
    const principal = round2(Math.max(0, line.borrowedAmount || 0))
    const continuous = accruedInterest(line, now.getTime())
    const billed = allDueMonthlyTotal(input)
    const interestTail = round2(Math.max(0, continuous - billed))
    const totalInterest = round2(billed + interestTail)
    const settlementPosts: SettlePost[] = []
    if (interestTail > 0) {
      settlementPosts.push(
        debit({
          id: leverageSettlementInterestId(line.id),
          amount: interestTail,
          currency: line.currency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Leverage Financing Interest",
          reference: line.id,
          category: "Leverage Interest",
          comment: `Outstanding debit interest settled on termination of ${line.accountLabel} 1:${line.leverageRatio} leverage line.`,
        }),
      )
    }
    if (principal > 0) {
      settlementPosts.push(
        debit({
          id: leverageSettlementPrincipalId(line.id),
          amount: principal,
          currency: line.currency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Leverage Financing Repayment",
          reference: line.id,
          category: "Leverage Financing",
          comment: `Borrowed funds returned to MCC on termination of ${line.accountLabel} 1:${line.leverageRatio} leverage line.`,
        }),
      )
    }
    const quote: SettlementQuote = {
      kind: "leverage",
      facilityId: line.id,
      title: `${line.accountLabel} · 1:${line.leverageRatio}`,
      currency: line.currency,
      principal,
      interestTail,
      fee: 0,
      dueNow,
      payoff: round2(principal + interestTail + dueNow),
      reconcileDue: dueNow,
    }
    return {
      quote,
      reconcilePosts,
      settlementPosts,
      closePatch: {
        status: "closed",
        closedAt: dateIso,
        switchOffRequestedAt: line.switchOffRequestedAt ?? dateIso,
        settledInterest: totalInterest,
        repayEntryId: principal > 0 ? leverageSettlementPrincipalId(line.id) : undefined,
        interestEntryId: interestTail > 0 ? leverageSettlementInterestId(line.id) : undefined,
      },
    }
  }

  if (found.kind === "monetization") {
    const req = found.record
    if (req.closedAt) return null
    const principal = round2(Math.max(0, req.grossProceeds || 0))
    const priced = computeTieredInterest(req.grossProceeds)
    const start = new Date(req.decidedAt ?? req.submittedAt)
    const continuous = accruedInterestToDate(req.grossProceeds, priced.effectiveRate, start, now)
    const billed = allDueMonthlyTotal(input)
    const interestTail = round2(Math.max(0, continuous - billed))
    const totalInterest = round2(billed + interestTail)
    const settlementPosts: SettlePost[] = []
    if (interestTail > 0) {
      settlementPosts.push(
        debit({
          id: monetizationSettlementInterestId(req.id),
          amount: interestTail,
          currency: req.proceedsCurrency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Credit Facility Interest",
          reference: req.id,
          category: "Monetization Interest",
          comment: `Outstanding debit interest settled on termination of ${req.instrumentType} ${req.instrumentId} credit facility.`,
        }),
      )
    }
    if (principal > 0) {
      settlementPosts.push(
        debit({
          id: monetizationSettlementPrincipalId(req.id),
          amount: principal,
          currency: req.proceedsCurrency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Credit Facility Repayment",
          reference: req.id,
          category: "Monetization",
          comment: `Advanced proceeds returned to MCC on termination of ${req.instrumentType} ${req.instrumentId} credit facility.`,
        }),
      )
    }
    const quote: SettlementQuote = {
      kind: "monetization",
      facilityId: req.id,
      title: `${req.instrumentType} ${req.instrumentId}`.trim(),
      currency: req.proceedsCurrency,
      principal,
      interestTail,
      fee: 0,
      dueNow,
      payoff: round2(principal + interestTail + dueNow),
      reconcileDue: dueNow,
    }
    return {
      quote,
      reconcilePosts,
      settlementPosts,
      closePatch: {
        closedAt: dateIso,
        settledInterest: totalInterest,
        repayEntryId: principal > 0 ? monetizationSettlementPrincipalId(req.id) : undefined,
        interestEntryId: interestTail > 0 ? monetizationSettlementInterestId(req.id) : undefined,
      },
    }
  }

  if (found.kind === "internal_loan") {
    const rec = found.record
    const shim = internalLoanApprovalShim(rec)
    const terms = readInternalLoanTerms(shim)
    if (!terms) return null
    if (terms.settledAt) return null
    const principal = round2(Math.max(0, terms.amount || 0))
    // interestTail = interest accrued (incl. the in-progress month) beyond every
    // matured monthly charge; dueNow posts the matured-but-unposted months, so
    // together they settle exactly the total accrued interest, once.
    const billed = allDueMonthlyTotal(input)
    const continuous = accruedInternalLoanInterest(shim, now)
    const interestTail = round2(Math.max(0, continuous - billed))
    const currency = terms.currency
    const title = rec.purpose?.trim() ? `Internal loan · ${rec.purpose.trim()}` : "Internal loan"
    const settlementPosts: SettlePost[] = []
    if (interestTail > 0) {
      settlementPosts.push(
        debit({
          id: internalLoanSettleInterestId(shim.id),
          amount: interestTail,
          currency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Internal Loan Interest",
          reference: shim.id,
          category: "Internal Loan Interest",
          comment: `Outstanding debit interest settled on repayment of internal loan ${shim.id}.`,
        }),
      )
    }
    if (principal > 0) {
      settlementPosts.push(
        debit({
          id: internalLoanSettlePrincipalId(shim.id),
          amount: principal,
          currency,
          status: "completed",
          date: dateIso,
          counterparty: "MCC Capital — Internal Loan Repayment",
          reference: shim.id,
          category: "Internal Loan Repayment",
          comment: `Loan principal returned to MCC on repayment of internal loan ${shim.id}.`,
        }),
      )
    }
    const quote: SettlementQuote = {
      kind: "internal_loan",
      facilityId: shim.id,
      title,
      currency,
      principal,
      interestTail,
      fee: 0,
      dueNow,
      payoff: round2(principal + interestTail + dueNow),
      reconcileDue: dueNow,
    }
    return {
      quote,
      reconcilePosts,
      settlementPosts,
      closePatch: {
        status: "closed",
        closedAt: dateIso,
        settledAt: dateIso,
        settledInterest: round2(billed + interestTail),
        repayEntryId: principal > 0 ? internalLoanSettlePrincipalId(shim.id) : undefined,
        interestEntryId: interestTail > 0 ? internalLoanSettleInterestId(shim.id) : undefined,
      },
    }
  }

  // treasury
  const { txn } = found
  if (txn.settledAt) return null
  const principal = round2(Math.max(0, txn.amount || 0))
  const currency = txn.currency || TREASURY_FINANCING_CURRENCY
  const start = new Date(txn.date)
  const continuous = accruedInterestToDate(txn.amount, TREASURY_FINANCING_ANNUAL_RATE, start, now)
  const billed = allDueMonthlyTotal(input)
  const interestTail = round2(Math.max(0, continuous - billed))
  const settlementPosts: SettlePost[] = []
  if (interestTail > 0) {
    settlementPosts.push(
      debit({
        id: treasurySettlementInterestId(txn.id),
        amount: interestTail,
        currency,
        status: "completed",
        date: dateIso,
        counterparty: "MCC Capital — Treasury Financing Interest",
        reference: txn.id,
        category: "Treasury Interest",
        comment: `Outstanding debit interest settled on termination of treasury financing.`,
      }),
    )
  }
  if (principal > 0) {
    settlementPosts.push(
      debit({
        id: treasurySettlementPrincipalId(txn.id),
        amount: principal,
        currency,
        status: "completed",
        date: dateIso,
        counterparty: "MCC Capital — Treasury Financing Repayment",
        reference: txn.id,
        category: "Treasury Financing",
        comment: `Financed principal returned to MCC on termination of treasury financing.`,
      }),
    )
  }
  const quote: SettlementQuote = {
    kind: "treasury",
    facilityId: txn.id,
    title: txn.label || "Treasury financing",
    currency,
    principal,
    interestTail,
    fee: 0,
    dueNow,
    payoff: round2(principal + interestTail + dueNow),
    reconcileDue: dueNow,
  }
  return {
    quote,
    reconcilePosts,
    settlementPosts,
    closePatch: { settledAt: dateIso },
  }
}

/** Convenience: just the quote (display), or null. */
export function quoteFacility(input: SettlementInput): SettlementQuote | null {
  return buildTerminationPlan(input)?.quote ?? null
}

export { MS_PER_YEAR }
