"use client"

// ---------------------------------------------------------------------------
// Treasury Services store.
//
// Each client has a single Treasury Services record holding their security
// deposit status, any leverage facility granted by MCC CAPITAL, the resulting
// debit exposure financed by MCC HOLDING SA, and a treasury transaction
// history. The record is persisted in the shared Neon database (server action
// `getMyTreasury`), keyed per user, so it is consistent on any device/browser.
// Nothing is stored in localStorage.
//
// Permissions are enforced by surface, matching the specification:
//   • Customers use `useTreasury()` (this file) to READ their own record only.
//   • The Administrator panel writes to ANY client via the cross-user helpers
//     at the bottom of this file (mirroring lib/admin-ledger.ts).
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect, useState, useCallback } from "react"

// --- Account profiles & their required security deposits --------------------

export type TreasuryProfileKey = "pro" | "avantgarde"

export interface TreasuryProfile {
  key: TreasuryProfileKey
  label: string
  /** Required security deposit, in EUR. */
  requiredDeposit: number
  description: string
}

export const TREASURY_PROFILES: TreasuryProfile[] = [
  {
    key: "pro",
    label: "PRO Account",
    requiredDeposit: 500_000,
    description: "Professional treasury profile requiring a €500,000 security deposit.",
  },
  {
    key: "avantgarde",
    label: "Avant-Garde Account",
    requiredDeposit: 1_000_000,
    description: "Premier treasury profile requiring a €1,000,000 security deposit.",
  },
]

export function getProfile(key: TreasuryProfileKey): TreasuryProfile {
  return TREASURY_PROFILES.find((p) => p.key === key) ?? TREASURY_PROFILES[0]
}

// Security deposits and the leverage facility are denominated in EUR.
export const TREASURY_CURRENCY = "EUR"

// Maximum leverage that may be approved by the administrator on a security
// deposit: 1:10. With it, a €50,000 contribution covers a €500,000 PRO deposit
// and €100,000 covers a €1,000,000 Avant-Garde deposit. The administrator must
// explicitly approve the facility per client.
export const MAX_LEVERAGE_RATIO = 10

/**
 * Leverage facilities the administrator may approve on a treasury security
 * deposit. 1:5 requires a larger client contribution (20% of the deposit) than
 * 1:10 (10%). Kept ascending; the last entry is the maximum (MAX_LEVERAGE_RATIO).
 */
export const TREASURY_LEVERAGE_RATIOS = [5, 10] as const

/**
 * Snap a stored/legacy leverage value to an approved facility level. Historic
 * records stored an *observed* ratio (required ÷ contribution) that may not be
 * one of the offered facilities; those default to the 1:10 facility that was
 * the only option at the time, so financing capacity never regresses.
 */
export function normalizeTreasuryLeverageRatio(ratio: number | undefined | null): number {
  const n = Number(ratio)
  return (TREASURY_LEVERAGE_RATIOS as readonly number[]).includes(n) ? n : MAX_LEVERAGE_RATIO
}

/**
 * Minimum customer contribution required to reach `requiredDeposit` under the
 * approved leverage facility — i.e. `requiredDeposit / ratio` (10% at 1:10,
 * 20% at 1:5). Defaults to the maximum facility when no ratio is given.
 */
export function leverageMinContribution(
  requiredDeposit: number,
  ratio: number = MAX_LEVERAGE_RATIO,
): number {
  return Math.ceil(requiredDeposit / Math.max(1, ratio))
}

// Annual debit cycle fee charged on leveraged positions. Applied to the
// financed (leveraged) amount of the security deposit plus any financial
// transaction exposure associated with the leverage facility.
export const DEBIT_CYCLE_FEE_RATE = 0.018 // 1.8% per year

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

// --- Record types -----------------------------------------------------------

export type TreasuryStatus =
  | "none" // no treasury account established yet
  | "pending" // established, awaiting funding / approval
  | "secured" // security deposit fully satisfied
  | "shortfall" // contribution + leverage does not cover the requirement
  | "closed" // facility closed

export type TreasuryTxnType =
  | "deposit" // customer security deposit contribution received
  | "leverage" // leverage drawdown financed by MCC HOLDING SA
  | "collateral" // SKR (Safe Keeping Receipt) value pledged as treasury collateral
  | "fee" // debit cycle fee charged
  | "adjustment" // manual adjustment
  | "settlement" // repayment / settlement of exposure

export interface TreasuryTransaction {
  id: string
  date: string // ISO
  type: TreasuryTxnType
  label: string
  amount: number
  currency: string
  note?: string
  /**
   * For a treasury financing drawdown: the ISO timestamp at which the client
   * reversed/terminated it and settled the payoff from the master balance.
   * Once set, debit-interest accrual on this drawdown stops at this moment.
   */
  settledAt?: string
}

export interface TreasuryAccount {
  /** Selected account profile (drives the required deposit). */
  profile: TreasuryProfileKey
  currency: string
  /** Required security deposit for the profile (EUR). */
  requiredDeposit: number
  /** Funds actually contributed by the customer (EUR). */
  customerContribution: number
  /** Whether a leverage facility has been granted by MCC CAPITAL. */
  leverageEnabled: boolean
  /** Applied leverage ratio, e.g. 10 for 1:10. */
  leverageRatio: number
  /** Amount financed by MCC HOLDING SA to reach the full deposit (debit exposure). */
  financedAmount: number
  /** Additional financial transaction exposure tied to the leverage facility. */
  transactionExposure: number
  /**
   * Total value of Safe Keeping Receipts (SKRs) pledged as collateral and
   * credited to this treasury balance for trading uses. Counts toward the
   * secured deposit alongside the cash contribution, but is not itself leveraged
   * (the leverage facility only amplifies the client's own cash contribution).
   */
  skrCollateral: number
  /** Annual debit cycle fee rate (1.8%). */
  feeRate: number
  status: TreasuryStatus
  establishedAt?: string
  securedAt?: string // when the deposit requirement was satisfied (fee accrual start)
  updatedAt?: string
  note?: string
  transactions: TreasuryTransaction[]
}

/** A brand-new, empty treasury record. */
export function emptyTreasuryAccount(): TreasuryAccount {
  return {
    profile: "pro",
    currency: TREASURY_CURRENCY,
    requiredDeposit: getProfile("pro").requiredDeposit,
    customerContribution: 0,
    leverageEnabled: false,
    leverageRatio: 1,
    financedAmount: 0,
    transactionExposure: 0,
    skrCollateral: 0,
    feeRate: DEBIT_CYCLE_FEE_RATE,
    status: "none",
    transactions: [],
  }
}

// --- Derived calculations ---------------------------------------------------

/**
 * Maximum amount the approved leverage facility can finance, given the client's
 * actual contribution. A 1:N facility amplifies the client's own funds up to N×
 * the total — i.e. it can finance at most (N − 1)× the contribution. With no
 * contribution there is nothing to amplify, so the facility finances nothing.
 */
export function maxFinanceable(contribution: number, ratio: number = MAX_LEVERAGE_RATIO): number {
  const cap = Math.max(1, ratio) - 1
  return Math.max(0, contribution * cap)
}

/**
 * The amount actually financed by MCC HOLDING SA: the gap between the required
 * deposit and the client's contribution, but never more than the approved
 * leverage allows on that contribution. This is derived (not the stored value)
 * so legacy records and any contribution change cascade correctly.
 */
export function financedAmountFor(account: TreasuryAccount): number {
  if (!account.leverageEnabled) return 0
  // Pledged SKR collateral already covers part of the deposit, so MCC HOLDING SA
  // only finances the remaining gap — never more than the approved facility
  // (1:5 or 1:10) allows on the client's own cash contribution.
  const collateral = Math.max(0, account.skrCollateral || 0)
  const gap = Math.max(0, account.requiredDeposit - account.customerContribution - collateral)
  const ratioCap = normalizeTreasuryLeverageRatio(account.leverageRatio)
  return Math.min(gap, maxFinanceable(account.customerContribution, ratioCap))
}

/**
 * Total credited to treasury = customer contribution + financed (leveraged)
 * amount + pledged SKR collateral. This is the balance available for trading.
 */
export function treasurySecured(account: TreasuryAccount): number {
  return account.customerContribution + financedAmountFor(account) + Math.max(0, account.skrCollateral || 0)
}

/** Remaining shortfall against the required deposit (0 if fully secured). */
export function treasuryShortfall(account: TreasuryAccount): number {
  return Math.max(0, account.requiredDeposit - treasurySecured(account))
}

/**
 * The deposit status that the actual coverage implies, regardless of any stale
 * stored value. "none" (not established) and "closed" remain authoritative; the
 * rest are derived from real coverage so a client can never appear "Fully
 * Secured" while the deposit is in fact uncovered.
 */
export function effectiveTreasuryStatus(account: TreasuryAccount): TreasuryStatus {
  if (account.status === "none") return "none"
  if (account.status === "closed") return "closed"
  if (account.requiredDeposit <= 0) return "pending"
  const secured = treasurySecured(account)
  if (secured >= account.requiredDeposit) return "secured"
  if (secured > 0) return "shortfall"
  return "pending"
}

/** Annual debit cycle fee = 1.8% of (financed amount + transaction exposure). */
export function annualCycleFee(account: TreasuryAccount): number {
  if (!account.leverageEnabled) return 0
  return (financedAmountFor(account) + account.transactionExposure) * account.feeRate
}

/**
 * Debit cycle fee accrued from when the facility was secured up to `asOf`.
 * Returns 0 when there is no active leverage facility.
 */
export function accruedCycleFee(account: TreasuryAccount, asOf: number = Date.now()): number {
  if (!account.leverageEnabled) return 0
  const startIso = account.securedAt ?? account.establishedAt
  if (!startIso) return 0
  const start = new Date(startIso).getTime()
  const elapsedMs = Math.max(0, asOf - start)
  return annualCycleFee(account) * (elapsedMs / MS_PER_YEAR)
}

// --- Customer-facing provider (read-only of their own record) ---------------
//
// The customer's treasury record now lives in the shared Neon database (server
// action `getMyTreasury`), so it is consistent across every device the client
// signs in from. The record is fetched on mount and re-fetched whenever the tab
// regains focus, so Administrator changes appear without a manual reload.

interface TreasuryContextValue {
  account: TreasuryAccount
  hydrated: boolean
  /** Re-fetch this user's treasury record from the server. */
  refresh: () => Promise<void>
}

const TreasuryContext = createContext<TreasuryContextValue | null>(null)

export function TreasuryProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<TreasuryAccount>(() => emptyTreasuryAccount())
  const [hydrated, setHydrated] = useState(false)

  // Read through the GET Route Handler (`/api/treasury`), NOT the `getMyTreasury`
  // Server Action: Server Actions are serialized with client navigations and
  // would freeze the dashboard's first navigation when ~20 providers all read on
  // login. A route-handler fetch stays off that queue.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/treasury", { cache: "no-store" })
      if (!res.ok) return
      const json = (await res.json()) as { ok: boolean; account?: TreasuryAccount }
      if (json.ok && json.account) setAccount(json.account)
    } catch {
      // keep whatever we already have on a transient failure
    }
  }, [])

  useEffect(() => {
    void refresh().finally(() => setHydrated(true))
  }, [refresh])

  // Re-sync from the server when the tab regains focus so Administrator updates
  // (made in a separate session) appear for the client.
  useEffect(() => {
    if (!hydrated) return
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisible)
    const id = setInterval(() => void refresh(), 30000)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(id)
    }
  }, [hydrated, refresh])

  return (
    <TreasuryContext.Provider value={{ account, hydrated, refresh }}>
      {children}
    </TreasuryContext.Provider>
  )
}

export function useTreasury() {
  const ctx = useContext(TreasuryContext)
  if (!ctx) {
    throw new Error("useTreasury must be used within a TreasuryProvider")
  }
  return ctx
}
