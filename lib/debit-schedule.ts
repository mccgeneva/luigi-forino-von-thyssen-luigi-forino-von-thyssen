import {
  buildFundingLedgerPosts,
  monthlyCostOfCapital,
  fundingCreditDate,
  FUNDING_ANNUAL_RATE,
} from "@/lib/funding-capital"
import { buildMonetizationInterestPosts } from "@/lib/monetization-financing"
import { computeTieredInterest } from "@/lib/tiered-debit-interest"
import { buildLeverageInterestPosts } from "@/lib/leverage-financing"
import { debitInterestRateFor, type LeverageRequest } from "@/lib/leverage-requests-store"
import {
  buildTreasuryFinancingLedgerPosts,
  treasuryFinancingTxns,
  monthlyTreasuryInterest,
  TREASURY_FINANCING_ANNUAL_RATE,
} from "@/lib/treasury-financing"
import { endOfMonth, round2 } from "@/lib/interest-accrual"
import type { LedgerEntry } from "@/lib/ledger-store"
import type { ProjectFundingRequest } from "@/lib/project-funding-store"
import type { MonetizationRequest } from "@/lib/monetization-requests-store"
import type { TreasuryAccount } from "@/lib/treasury-store"

/**
 * Unified debit / financing schedule.
 *
 * The platform charges monthly debit interest from FOUR independent financing
 * products, each with its own audited accrual engine:
 *
 *   • Project Funding (AES)   — 1.8% p.a. flat cost of capital
 *   • Credit facilities       — progressive/tiered loan interest (1.8%–3.5%)
 *   • Leverage lines          — 0.36% p.a. per unit of leverage (scales w/ ratio)
 *   • Treasury Financing       — 3% p.a. flat on the drawn deposit facility
 *
 * This module does NOT re-derive any interest math. It calls each product's own
 * ledger-post builder with a FUTURE horizon so the very same engine that posts
 * real charges also projects the upcoming ones — guaranteeing the calendar
 * matches the ledger to the cent. It then normalizes every product into one
 * `DebitFacility` + `DebitCharge` shape for the profile "Debits & Financing"
 * page, and splits charges into already-posted vs. upcoming (projected).
 */

export type DebitKind = "funding" | "monetization" | "leverage" | "treasury"

/** One financing arrangement that generates debits (a loan, leverage line, etc). */
export interface DebitFacility {
  /** Source record id — every charge references this. */
  id: string
  kind: DebitKind
  /** Human title, e.g. project name, instrument ref, or account label. */
  title: string
  /** Outstanding financed principal the interest is charged on. */
  principal: number
  currency: string
  /** Interest accrual start (funding / activation / drawdown date), ISO. */
  startDate: string
  /** Representative annual rate (effective/blended for tiered facilities). */
  annualRate: number
  /** Pre-formatted rate label, e.g. "1.80% p.a." or "blended 1.94% p.a.". */
  rateLabel: string
  /** One full month's charge at the current principal & rate. */
  monthlyAmount: number
  /** Lifecycle status from the source record. */
  status: string
  /** True when the facility is closed/settled (no longer accruing forward). */
  closed: boolean
  /**
   * DB approval id backing this facility (funding / monetization / leverage).
   * Undefined for treasury financing, which is keyed by its drawdown txn id
   * (`id`) on the treasury account rather than an approval record.
   */
  approvalId?: string
  /**
   * True when the client may reverse/terminate this facility from the Debits &
   * Financing page — i.e. it is live, not already closed, and self-service
   * settlement is supported for its product.
   */
  settleable: boolean
}

/** A single monthly debit charge — posted historically or projected ahead. */
export interface DebitCharge {
  /** Deterministic ledger id from the product engine. */
  id: string
  facilityId: string
  kind: DebitKind
  /** Month-end instant the charge is dated at, ISO. */
  date: string
  /** Calendar month key, e.g. "2026-07". */
  yearMonth: string
  amount: number
  currency: string
  category: string
  note: string
  /** True when this month was charged at less than a full month. */
  prorated: boolean
  /** True when this charge is already on the ledger. */
  posted: boolean
  /** True when this charge is in the future (projected, not yet due). */
  upcoming: boolean
}

export interface DebitScheduleTotals {
  /** Sum of charges already posted to the ledger. */
  postedTotal: number
  /** Sum of upcoming projected charges within the horizon. */
  upcomingTotal: number
  /** Combined full-month run-rate across all active facilities. */
  monthlyRunRate: number
  /** Distinct currencies present across all facilities. */
  currencies: string[]
}

export interface DebitSchedule {
  facilities: DebitFacility[]
  charges: DebitCharge[]
  totals: DebitScheduleTotals
  /** True when there is at least one financing arrangement. */
  hasAny: boolean
}

export interface BuildDebitScheduleInput {
  funding?: ProjectFundingRequest[] | null
  monetization?: MonetizationRequest[] | null
  leverage?: LeverageRequest[] | null
  treasury?: TreasuryAccount | null
  /** Ledger entry ids already posted — used to flag charges as posted. */
  postedIds: Set<string>
  /** Evaluation instant (defaults to now). */
  now?: Date
  /** Months to project forward past `now` (default 12). */
  horizonMonths?: number
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}% p.a.`
}

/**
 * Build the unified debit schedule across all four financing products.
 * Pure and deterministic in its inputs.
 */
export function buildDebitSchedule(input: BuildDebitScheduleInput): DebitSchedule {
  const now = input.now ?? new Date()
  const horizonMonths = input.horizonMonths ?? 12
  // Horizon = end of the month `horizonMonths` ahead, so a full final month is
  // always included in the projection.
  const horizon = endOfMonth(now.getFullYear(), now.getMonth() + horizonMonths)
  const postedIds = input.postedIds

  const facilities: DebitFacility[] = []
  const charges: DebitCharge[] = []

  const isUpcoming = (dateIso: string) => new Date(dateIso).getTime() > now.getTime()

  // --- 1. Project Funding (AES) — 1.8% p.a. flat -----------------------------
  const funding = (input.funding ?? []).filter((r) => r.status === "approved" && r.facility > 0)
  for (const r of funding) {
    facilities.push({
      id: r.id,
      kind: "funding",
      title: r.projectName || "AES project facility",
      principal: r.facility,
      currency: r.currency,
      startDate: fundingCreditDate(r).toISOString(),
      annualRate: FUNDING_ANNUAL_RATE,
      rateLabel: fmtPct(FUNDING_ANNUAL_RATE),
      monthlyAmount: monthlyCostOfCapital(r.facility),
      status: r.status,
      closed: !!r.closedAt,
      approvalId: r.approvalId,
      settleable: !r.closedAt && !!r.approvalId,
    })
  }
  if (funding.length > 0) {
    for (const post of buildFundingLedgerPosts(funding, new Set(), horizon)) {
      if (post.direction !== "debit") continue // skip the one-time capital credit
      pushCharge(post.entry, "funding")
    }
  }

  // --- 2. Credit facilities (monetization) — tiered 1.8%–3.5% ----------------
  const monetization = (input.monetization ?? []).filter((r) => r.status === "approved" && r.grossProceeds > 0)
  for (const req of monetization) {
    const priced = computeTieredInterest(req.grossProceeds)
    facilities.push({
      id: req.id,
      kind: "monetization",
      title: `${req.instrumentType} ${req.instrumentId}`.trim(),
      principal: req.grossProceeds,
      currency: req.proceedsCurrency,
      startDate: req.decidedAt ?? req.submittedAt,
      annualRate: priced.effectiveRate,
      rateLabel: `blended ${fmtPct(priced.effectiveRate)}`,
      monthlyAmount: priced.monthlyInterest,
      status: req.closedAt ? "closed" : req.status,
      closed: !!req.closedAt,
      approvalId: req.approvalId,
      settleable: !req.closedAt && !!req.approvalId,
    })
  }
  if (monetization.length > 0) {
    for (const post of buildMonetizationInterestPosts(monetization, new Set(), horizon)) {
      pushCharge(post.entry, "monetization")
    }
  }

  // --- 3. Leverage lines — 0.36% p.a. per unit of leverage -------------------
  const leverage = (input.leverage ?? []).filter(
    (l) => (l.status === "approved" || l.status === "switchoff_pending") && !!l.activatedAt && !l.closedAt,
  )
  for (const line of leverage) {
    const rate = debitInterestRateFor(line.leverageRatio)
    facilities.push({
      id: line.id,
      kind: "leverage",
      title: `${line.accountLabel} · 1:${line.leverageRatio}`,
      principal: line.borrowedAmount,
      currency: line.currency,
      startDate: line.activatedAt as string,
      annualRate: rate,
      rateLabel: `${fmtPct(rate)} (1:${line.leverageRatio})`,
      monthlyAmount: round2((line.borrowedAmount * rate) / 12),
      status: line.status,
      closed: false,
      approvalId: line.approvalId,
      settleable: !!line.approvalId,
    })
  }
  if (leverage.length > 0) {
    for (const post of buildLeverageInterestPosts(leverage, new Set(), horizon)) {
      pushCharge(post.entry, "leverage")
    }
  }

  // --- 4. Treasury financing — 3% p.a. flat, per drawdown --------------------
  const treasuryDraws = treasuryFinancingTxns(input.treasury)
  for (const txn of treasuryDraws) {
    facilities.push({
      id: txn.id,
      kind: "treasury",
      title: txn.label || "Treasury financing",
      principal: txn.amount,
      currency: txn.currency || "EUR",
      startDate: txn.date,
      annualRate: TREASURY_FINANCING_ANNUAL_RATE,
      rateLabel: fmtPct(TREASURY_FINANCING_ANNUAL_RATE),
      monthlyAmount: monthlyTreasuryInterest(txn.amount),
      status: txn.settledAt ? "closed" : "active",
      closed: !!txn.settledAt,
      settleable: !txn.settledAt,
    })
  }
  if (treasuryDraws.length > 0) {
    for (const post of buildTreasuryFinancingLedgerPosts(input.treasury, new Set(), horizon)) {
      pushCharge(post.entry, "treasury")
    }
  }

  // Sort charges chronologically for the timeline/list.
  charges.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const postedTotal = round2(charges.filter((c) => c.posted).reduce((s, c) => s + c.amount, 0))
  const upcomingTotal = round2(charges.filter((c) => c.upcoming).reduce((s, c) => s + c.amount, 0))
  const monthlyRunRate = round2(facilities.filter((f) => !f.closed).reduce((s, f) => s + f.monthlyAmount, 0))
  const currencies = Array.from(new Set(facilities.map((f) => f.currency)))

  return {
    facilities,
    charges,
    totals: { postedTotal, upcomingTotal, monthlyRunRate, currencies },
    hasAny: facilities.length > 0,
  }

  // Local helper closes over `charges`, `postedIds`, `isUpcoming`.
  function pushCharge(entry: Omit<LedgerEntry, "direction">, kind: DebitKind) {
    const dateIso = entry.date
    const ym = dateIso.slice(0, 7)
    charges.push({
      id: entry.id,
      facilityId: entry.reference ?? "",
      kind,
      date: dateIso,
      yearMonth: ym,
      amount: entry.amount,
      currency: entry.currency,
      category: entry.category ?? "",
      note: entry.comment ?? "",
      prorated: /pro-rated/i.test(entry.comment ?? ""),
      posted: postedIds.has(entry.id),
      upcoming: isUpcoming(dateIso),
    })
  }
}

/**
 * Static, human-readable explanation of each debit scenario's conditions —
 * a single source of truth reused by the profile page. Rates and rules here
 * mirror the audited engines above.
 */
export interface DebitScenarioExplainer {
  kind: DebitKind
  title: string
  rate: string
  whenCharged: string
  accrualStart: string
  conditions: string[]
}

export const DEBIT_SCENARIOS: Record<DebitKind, DebitScenarioExplainer> = {
  funding: {
    kind: "funding",
    title: "AES Project Funding — Cost of Capital",
    rate: "1.80% per annum (flat), charged as 1/12 each month.",
    whenCharged: "At the end of every calendar month while the facility is open.",
    accrualStart: "The exact day the approved facility capital is credited to your master account.",
    conditions: [
      "Applies to approved AES project funding facilities. The financed capital is credited to your balance once at approval.",
      "The first month is pro-rated to the number of days the facility was active in that month.",
      "If you close the facility early, an early-redemption fee (70% of the cost of capital that would have accrued over the remaining standard tenor) plus the outstanding interest tail and the principal are settled at closure.",
      "Interest already charged month-by-month is the cost of holding the capital and is not refunded on repayment.",
    ],
  },
  monetization: {
    kind: "monetization",
    title: "Credit Facility — Progressive (Tiered) Debit Interest",
    rate: "Progressive 1.80%–3.50% p.a., priced marginally per tranche (blended rate shown per facility).",
    whenCharged: "At the end of every calendar month from the funding date.",
    accrualStart: "The approval date, when the gross proceeds are credited to your balance.",
    conditions: [
      "Applies to approved monetization / non-recourse credit facilities. Interest is charged only on the portion of the facility within each tier — you never pay the top rate on the whole facility.",
      "Tiers: 0–5M @ 1.80%, 5–10M @ 2.00%, 10–50M @ 2.40%, 50–100M @ 2.60%, 100–500M @ 3.00%, 500M+ @ 3.50% (facility currency units).",
      "The total annual interest is fixed at approval by the facility size; one-twelfth is charged each month.",
      "The first month is pro-rated to the active days from the funding date.",
    ],
  },
  leverage: {
    kind: "leverage",
    title: "Leverage Line — Debit Interest on Borrowed Funds",
    rate: "Risk-based inverse scale: 14% p.a. at 1:2, 10% at 1:5, 8% at 1:10, 7% at 1:15, 6% at 1:20, 4% at 1:25, 3% at 1:30 — a higher leverage multiple carries a lower rate.",
    whenCharged: "At the end of every calendar month while the line is live.",
    accrualStart: "The activation date, when the borrowed funds are credited to your balance.",
    conditions: [
      "Applies to active leverage lines. Interest is charged on the borrowed amount (equity × (ratio − 1)), not on your own equity.",
      "Higher leverage signals lower risk, so the annual rate DECREASES as the ratio increases (1:2 is the most expensive, 1:30 the cheapest).",
      "If an administrator adjusts your ratio, interest is billed segment-by-segment at the ratio in force during each window.",
      "The first month is pro-rated from the activation date; a switch-off settles any interest not yet collected monthly.",
    ],
  },
  treasury: {
    kind: "treasury",
    title: "Special Treasury Financing",
    rate: "3.00% per annum (flat), charged as 1/12 each month.",
    whenCharged: "At the end of every calendar month while the financing is outstanding.",
    accrualStart: "The exact day the financed amount is credited to your EUR balance.",
    conditions: [
      "Applies to administrator-executed treasury financing drawdowns (€500,000 PRO / €1,000,000 Avant-Garde).",
      "Interest is charged monthly at 3% ÷ 12 on the financed principal.",
      "The first month is pro-rated to the active days from the drawdown date.",
      "Each drawdown accrues independently from its own credit date.",
    ],
  },
}
