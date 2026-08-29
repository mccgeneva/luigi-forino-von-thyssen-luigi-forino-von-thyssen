"use client"

import { createContext, useContext } from "react"
import { mirrorSubmission, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { updateMyApprovalRecord, withdrawMyLeverageApplication } from "@/app/actions/approvals"
import {
  LEVERAGE_RATIOS,
  TREASURY_LEVERAGE_RATIOS,
  debitInterestRateFor,
} from "@/lib/leverage-rates"

// Re-export the shared, configurable rate model so existing importers of the
// leverage store keep working unchanged.
export { LEVERAGE_RATIOS, TREASURY_LEVERAGE_RATIOS, debitInterestRateFor }

export type LeverageRequestStatus =
  | "pending" // activation requested, awaiting admin
  | "approved" // active leverage line
  | "rejected" // activation declined
  | "switchoff_pending" // client requested switch-off, awaiting admin
  | "closed" // switched off and settled

export type LeverageAccountKey = "treasury" | "master" | "instruments" | "naftahub"

export interface LeverageAccountOption {
  key: LeverageAccountKey
  label: string
  description: string
  maxLeverage: number
}

// The funding sources a leverage line can be opened against, per the platform's
// risk-management specification. Each category carries its own maximum leverage
// ceiling that the platform will underwrite.
export const LEVERAGE_ACCOUNTS: LeverageAccountOption[] = [
  {
    key: "treasury",
    label: "Treasury Services",
    description: "Leveraged trading line collateralised by the MCC treasury deposit facility.",
    maxLeverage: 10,
  },
  {
    key: "master",
    label: "Master Banking",
    description: "Cash equity held in the MCC master banking account.",
    maxLeverage: 30,
  },
  {
    key: "instruments",
    label: "Bank Instruments",
    description: "Monetizable bank instruments (SBLC, BG, MTN) pledged as collateral.",
    maxLeverage: 30,
  },
  {
    key: "naftahub",
    label: "NAFTAhub Trading",
    description: "Equity allocated to the NAFTAhub NQAi trading desk.",
    maxLeverage: 30,
  },
]

// Per-category maximum leverage ceilings, keyed for O(1) lookup.
export const ACCOUNT_MAX_LEVERAGE: Record<LeverageAccountKey, number> = LEVERAGE_ACCOUNTS.reduce(
  (acc, opt) => {
    acc[opt.key] = opt.maxLeverage
    return acc
  },
  {} as Record<LeverageAccountKey, number>,
)

// Highest leverage the platform offers across every category (1:30). Used for
// display copy and global guards.
export const MAX_LEVERAGE = Math.max(...LEVERAGE_ACCOUNTS.map((a) => a.maxLeverage))

// Resolve the maximum leverage permitted for a given funding category.
export function maxLeverageFor(account: LeverageAccountKey): number {
  return ACCOUNT_MAX_LEVERAGE[account] ?? MAX_LEVERAGE
}

// Selectable ratios for a funding category. Treasury financing is restricted to
// exactly 1:5 and 1:10; every other facility offers the full 1:2 … 1:30 ladder
// (filtered to the category's ceiling).
export function leverageRatiosFor(account: LeverageAccountKey): number[] {
  if (account === "treasury") {
    return TREASURY_LEVERAGE_RATIOS.slice()
  }
  const cap = maxLeverageFor(account)
  return LEVERAGE_RATIOS.filter((r) => r <= cap)
}

// Annual debit interest on the borrowed (leveraged) funds follows the
// risk-based INVERSE scale in `lib/leverage-rates.ts` (higher leverage = lower
// rate): 1:2 → 14% … 1:30 → 3%, charged monthly as (annual ÷ 12). This is
// distinct from Project Finance, which is an INVESTMENT product carrying a 1.8%
// p.a. ROI, not a debit rate. `debitInterestRateFor` is re-exported above.

// Risk thresholds expressed as a margin level percentage (equity / used margin).
export const RISK_THRESHOLDS = {
  warning: 150, // below this -> margin warning
  marginCall: 100, // below this -> margin call
  stopOut: 50, // below this -> positions liquidated
}

export interface LeverageRequest {
  id: string
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  account: LeverageAccountKey
  accountLabel: string
  equity: number // client's own allocated funds (base margin)
  currency: string
  leverageRatio: number // e.g. 5 for 1:5
  buyingPower: number // equity * leverageRatio (total leveraged position)
  borrowedAmount: number // equity * (leverageRatio - 1) -> credited to balance on approval
  interestRate: number // annual debit interest rate on the borrowed amount
  instrumentType: string // asset class to be traded
  notes?: string
  // When the funding account is "instruments", the specific active bank
  // instrument (SBLC / BG / MTN) pledged as collateral for this line.
  pledgedInstrumentId?: string
  pledgedInstrumentLabel?: string
  status: LeverageRequestStatus
  submittedAt: string
  decidedAt?: string // when the activation request was approved/rejected
  decisionNote?: string
  activatedAt?: string // when the line went live (interest accrual start)
  creditEntryId?: string // ledger entry id for the borrowed-funds credit
  switchOffRequestedAt?: string // when the client requested switch-off
  closedAt?: string // when the line was switched off and settled
  settledInterest?: number // total debit interest charged at close
  repayEntryId?: string // ledger entry id for the principal repayment debit
  interestEntryId?: string // ledger entry id for the interest settlement debit
  // Audit trail of admin ratio modifications applied to the active line.
  modifications?: LeverageModification[]
  // ── PPI appeal / cost-negotiation flow ──────────────────────────────────
  // Set when the client could not afford the PPI premium and submitted an
  // appeal. The PPI is reserved as a HOLD ("PPI Appeal – Pending Admin Review")
  // that may push available balance temporarily negative, pending admin review.
  ppiAppeal?: boolean
  appealPpiOriginal?: number // PPI premium quoted at appeal time
  appealPpiFinal?: number // final applied PPI once admin decides
  appealResolvedAt?: string // when the appeal hold was converted/released
  appealDecision?: "approved" | "rejected"
  // Admin PPI negotiation audit trail (also used by the non-appeal refund path).
  ppiOriginal?: number
  negotiatedPpi?: number
  ppiRefund?: number
  ppiNegotiatedAt?: string
}

// A single admin adjustment of an active line's leverage ratio. Interest that
// accrued under the previous ratio is captured in `interestToDate` so accrual
// can continue cleanly on the new principal from `appliedAt`.
export interface LeverageModification {
  appliedAt: string
  fromRatio: number
  toRatio: number
  fromBorrowed: number
  toBorrowed: number
  deltaBorrowed: number // positive = extra credited, negative = repaid
  interestToDate: number // interest accrued under the prior ratio up to appliedAt
  adjustmentEntryId?: string // ledger entry id for the balancing credit/debit
  note?: string
}

/**
 * Build a LeverageRequest from a server approval record. The complete record
 * lives under `payload.record`. The DB lifecycle decides pending/approved/
 * rejected; once a line is approved, its post-approval sub-states
 * ("switchoff_pending" / "closed") are client/admin-managed and kept in the
 * record itself, so those win over the coarse DB "approved".
 */
function leverageFromApproval(rec: ApprovalRecord): LeverageRequest | null {
  const base = rec.payload?.record as LeverageRequest | undefined
  if (!base || typeof base !== "object" || !base.id) return null
  const lifecycle = mapApprovalStatus(rec.status) as LeverageRequestStatus
  const recordStatus = base.status
  // After approval the record may carry switch-off / closed sub-states.
  const status: LeverageRequestStatus =
    lifecycle === "approved" && (recordStatus === "switchoff_pending" || recordStatus === "closed")
      ? recordStatus
      : lifecycle
  return {
    ...base,
    approvalId: rec.id,
    status,
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
  }
}

// `accruedInterest` (and MS_PER_YEAR) now live in the SERVER-SAFE module
// `lib/leverage-interest.ts` so server actions (settlement / termination) can
// call them. It is re-exported here so existing client consumers that import it
// from this store keep working unchanged. Keeping the pure math out of this
// "use client" module is what fixes the leverage termination throw
// ("Attempted to call accruedInterest() from the server ...").
export { accruedInterest, MS_PER_YEAR } from "@/lib/leverage-interest"

interface ApproveSwitchOffPayload {
  settledInterest: number
  repayEntryId?: string
  interestEntryId?: string
}

interface ModifyRatioPayload {
  toRatio: number
  interestToDate: number // interest accrued under the prior ratio, up to now
  adjustmentEntryId?: string // ledger entry id for the balancing credit/debit
  note?: string
}

interface LeverageRequestsContextValue {
  requests: LeverageRequest[]
  addRequest: (
    request: Omit<
      LeverageRequest,
      | "status"
      | "submittedAt"
      | "decidedAt"
      | "decisionNote"
      | "activatedAt"
      | "creditEntryId"
      | "switchOffRequestedAt"
      | "closedAt"
      | "settledInterest"
      | "repayEntryId"
      | "interestEntryId"
    >,
  ) => LeverageRequest
  approveRequest: (id: string, creditEntryId?: string) => LeverageRequest | null
  rejectRequest: (id: string, reason?: string) => LeverageRequest | null
  modifyRatio: (id: string, payload: ModifyRatioPayload) => LeverageRequest | null
  requestSwitchOff: (id: string) => LeverageRequest | null
  approveSwitchOff: (id: string, payload: ApproveSwitchOffPayload) => LeverageRequest | null
  rejectSwitchOff: (id: string, reason?: string) => LeverageRequest | null
  /** Client self-service: instantly terminate an active line (approved OR
   *  switch-off pending) and close it. The caller settles the ledger
   *  (principal repayment + accrued interest) and passes the entry ids. */
  unwindLine: (id: string, payload: ApproveSwitchOffPayload) => LeverageRequest | null
  /** Client self-service: withdraw a still-PENDING application before any admin
   *  review. Releases the reserved audit/PPI holds (nothing was charged) and
   *  cancels the request. Resolves to true when the server confirms. */
  withdrawLine: (id: string) => Promise<boolean>
  /** Re-hydrate the list from the server (e.g. after a client termination). */
  refresh: () => void | Promise<unknown>
  hydrated: boolean
}

const LeverageRequestsContext = createContext<LeverageRequestsContextValue | null>(null)

export function LeverageRequestsProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon), so activation lines and their
  // post-approval state are identical on any device/browser. No localStorage.
  const {
    records: requests,
    setRecords: setRequests,
    hydrated,
    refresh,
  } = useServerRequestList<LeverageRequest>("leverage", { fromApproval: leverageFromApproval })

  /** Persist a change to a line's server record so it follows the user. */
  const persistRecord = (line: LeverageRequest | null) => {
    if (line?.approvalId) {
      void updateMyApprovalRecord(line.approvalId, { ...line }).then(() => void refresh())
    }
  }

  const addRequest: LeverageRequestsContextValue["addRequest"] = (request) => {
    const full: LeverageRequest = {
      ...request,
      // Authoritative rate: always derived from the ratio via the risk-based
      // scale, so a stale value from the caller can never diverge from policy.
      interestRate: debitInterestRateFor(request.leverageRatio),
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setRequests([full, ...requests])
    // Mirror the activation request into the DB for cross-client review; persist
    // the COMPLETE record under `payload.record` so the server rebuilds it anywhere.
    void mirrorSubmission({
      kind: "leverage",
      title: `${full.accountLabel} · 1:${full.leverageRatio}`,
      summary: `${full.currency} ${full.equity.toLocaleString("en-US")} equity at 1:${full.leverageRatio} on ${full.accountLabel} (buying power ${full.currency} ${full.buyingPower.toLocaleString("en-US")})`,
      amount: full.equity,
      currency: full.currency,
      payload: { localId: full.id, account: full.account, leverageRatio: full.leverageRatio, instrumentType: full.instrumentType, record: full },
    }).then(() => {
      void refresh()
    })
    return full
  }

  const approveRequest: LeverageRequestsContextValue["approveRequest"] = (id, creditEntryId) => {
    let updated: LeverageRequest | null = null
    const now = new Date().toISOString()
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = { ...r, status: "approved", decidedAt: now, activatedAt: now, creditEntryId }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  const rejectRequest: LeverageRequestsContextValue["rejectRequest"] = (id, reason) => {
    let updated: LeverageRequest | null = null
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = {
            ...r,
            status: "rejected",
            decidedAt: new Date().toISOString(),
            decisionNote: reason?.trim() || undefined,
          }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  // Admin modifies the leverage ratio of an already-active line, within the
  // category ceiling. The buying power and borrowed principal are recomputed on
  // the new ratio; the difference is re-settled on the ledger (credit if the
  // ratio went up, debit if it went down) by the caller, whose entry id we store.
  // Interest accrued so far is captured as a modification segment so future
  // accrual continues cleanly on the new principal.
  const modifyRatio: LeverageRequestsContextValue["modifyRatio"] = (id, payload) => {
    let updated: LeverageRequest | null = null
    const now = new Date().toISOString()
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id !== id || r.status !== "approved") return r
        const cap = maxLeverageFor(r.account)
        const toRatio = Math.max(1, Math.min(payload.toRatio, cap))
        if (toRatio === r.leverageRatio) return r
        const newBuyingPower = r.equity * toRatio
        const newBorrowed = r.equity * (toRatio - 1)
        const modification: LeverageModification = {
          appliedAt: now,
          fromRatio: r.leverageRatio,
          toRatio,
          fromBorrowed: r.borrowedAmount,
          toBorrowed: newBorrowed,
          deltaBorrowed: newBorrowed - r.borrowedAmount,
          interestToDate: payload.interestToDate,
          adjustmentEntryId: payload.adjustmentEntryId,
          note: payload.note?.trim() || undefined,
        }
        updated = {
          ...r,
          leverageRatio: toRatio,
          buyingPower: newBuyingPower,
          borrowedAmount: newBorrowed,
          // Rate follows the new ratio under the risk-based scale (historical
          // segments keep their own rate via `accruedInterest`).
          interestRate: debitInterestRateFor(toRatio),
          modifications: [...(r.modifications ?? []), modification],
        }
        return updated
      }),
    )
    persistRecord(updated)
    return updated
  }

  // Client asks to switch off an active line. Moves it into the admin queue
  // without touching the ledger — settlement happens on admin approval.
  const requestSwitchOff: LeverageRequestsContextValue["requestSwitchOff"] = (id) => {
    let updated: LeverageRequest | null = null
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && r.status === "approved") {
          updated = { ...r, status: "switchoff_pending", switchOffRequestedAt: new Date().toISOString() }
          return updated
        }
        return r
      }),
    )
    // Persist the switch-off request so the admin sees it and it survives across
    // devices. The DB approval stays "approved"; the sub-state lives in the record.
    persistRecord(updated)
    return updated
  }

  // Admin approves the switch-off: the line is closed, accrued interest is
  // settled and the borrowed principal is repaid (ledger entries are created by
  // the caller and their ids stored here for the audit trail).
  const approveSwitchOff: LeverageRequestsContextValue["approveSwitchOff"] = (id, payload) => {
    let updated: LeverageRequest | null = null
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && r.status === "switchoff_pending") {
          updated = {
            ...r,
            status: "closed",
            closedAt: new Date().toISOString(),
            settledInterest: payload.settledInterest,
            repayEntryId: payload.repayEntryId,
            interestEntryId: payload.interestEntryId,
          }
          return updated
        }
        return r
      }),
    )
    persistRecord(updated)
    return updated
  }

  // Admin declines the switch-off: the line stays active.
  const rejectSwitchOff: LeverageRequestsContextValue["rejectSwitchOff"] = (id, reason) => {
    let updated: LeverageRequest | null = null
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && r.status === "switchoff_pending") {
          updated = {
            ...r,
            status: "approved",
            switchOffRequestedAt: undefined,
            decisionNote: reason?.trim() || undefined,
          }
          return updated
        }
        return r
      }),
    )
    persistRecord(updated)
    return updated
  }

  // Client-initiated instant termination. Unlike requestSwitchOff (which parks
  // the line in the admin queue), this closes the line immediately: the caller
  // has already posted the principal repayment and interest settlement to the
  // ledger. Accepts a line that is either live ("approved") or already sitting
  // in the switch-off queue ("switchoff_pending").
  const unwindLine: LeverageRequestsContextValue["unwindLine"] = (id, payload) => {
    let updated: LeverageRequest | null = null
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id === id && (r.status === "approved" || r.status === "switchoff_pending")) {
          updated = {
            ...r,
            status: "closed",
            switchOffRequestedAt: r.switchOffRequestedAt ?? new Date().toISOString(),
            closedAt: new Date().toISOString(),
            settledInterest: payload.settledInterest,
            repayEntryId: payload.repayEntryId,
            interestEntryId: payload.interestEntryId,
          }
          return updated
        }
        return r
      }),
    )
    persistRecord(updated)
    return updated
  }

  // Client withdraws a still-pending line: the server releases the reserved
  // audit/PPI holds and cancels the approval, then we re-hydrate from the DB.
  const withdrawLine: LeverageRequestsContextValue["withdrawLine"] = async (id) => {
    const target = requests.find((r) => r.id === id)
    if (!target?.approvalId) return false
    // Optimistically drop it from the list; the refresh reconciles authoritatively.
    setRequests((prev) => prev.filter((r) => r.id !== id))
    const res = await withdrawMyLeverageApplication(target.approvalId)
    void refresh()
    return res.ok
  }

  return (
    <LeverageRequestsContext.Provider
      value={{
        requests,
        addRequest,
        approveRequest,
        rejectRequest,
        modifyRatio,
        requestSwitchOff,
        approveSwitchOff,
        rejectSwitchOff,
        unwindLine,
        withdrawLine,
        refresh,
        hydrated,
      }}
    >
      {children}
    </LeverageRequestsContext.Provider>
  )
}

export function useLeverageRequests() {
  const ctx = useContext(LeverageRequestsContext)
  if (!ctx) {
    throw new Error("useLeverageRequests must be used within a LeverageRequestsProvider")
  }
  return ctx
}
