"use client"

import { createContext, useContext } from "react"
import { mirrorSubmission, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { INTERNAL_LOAN_DEFAULT_RATE, INTERNAL_LOAN_DEFAULT_CURRENCY } from "@/lib/internal-loan"

// Re-export the engine constants so importers of the store keep one source.
export { INTERNAL_LOAN_DEFAULT_RATE, INTERNAL_LOAN_DEFAULT_CURRENCY }

export type InternalLoanStatus =
  | "pending" // requested, awaiting administrator risk evaluation
  | "approved" // approved & funded — principal credited to the master account
  | "rejected" // declined
  | "closed" // repaid / settled by the client

/**
 * A customer-requested internal loan. The COMPLETE record is stored on the
 * server approval under `payload.record`, so it rebuilds identically on any
 * device. Distinct from the security-deposit "Capital Lending" and from AES
 * private-investment products.
 */
export interface InternalLoanRequest {
  id: string
  /** DB approval id once mirrored, so admin decisions reconcile back. */
  approvalId?: string
  amount: number
  currency: string
  purpose: string
  repaymentPlan: string
  collateralNote?: string
  /** Annual debit interest rate as a decimal (default 3% p.a.; admin may override). */
  interestRate: number
  /** One-time arrangement fee (absolute, loan currency); set by the admin at approval. */
  arrangementFee?: number
  status: InternalLoanStatus
  submittedAt: string
  decidedAt?: string
  decisionNote?: string
  /** When the loan was approved/funded — interest accrual start. */
  activatedAt?: string
  /** Ledger entry id for the principal drawdown credit. */
  creditEntryId?: string
  /** Ledger entry id for the arrangement fee debit. */
  arrangementFeeEntryId?: string
  /** When the loan was repaid/closed — caps interest accrual. */
  closedAt?: string
  /** Total interest settled at repayment. */
  settledInterest?: number
  /** Ledger entry id for the principal repayment debit. */
  repayEntryId?: string
  /** Ledger entry id for the interest settlement debit. */
  interestEntryId?: string
}

/**
 * Rebuild an InternalLoanRequest from a server approval record. The full record
 * lives under `payload.record`. The DB lifecycle decides pending/approved/
 * rejected; a client repayment records "closed" in the record itself, so that
 * sub-state wins over the coarse DB "approved".
 */
function internalLoanFromApproval(rec: ApprovalRecord): InternalLoanRequest | null {
  const base = rec.payload?.record as InternalLoanRequest | undefined
  if (!base || typeof base !== "object" || !base.id) return null
  const lifecycle = mapApprovalStatus(rec.status) as InternalLoanStatus
  const status: InternalLoanStatus =
    lifecycle === "approved" && base.status === "closed" ? "closed" : lifecycle
  return {
    ...base,
    approvalId: rec.id,
    status,
    // The admin stamps rate / fee / activation onto the record at approval, so
    // trust the stored record for those. Decision metadata mirrors the row.
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
  }
}

interface InternalLoanContextValue {
  loans: InternalLoanRequest[]
  /** Submit a new loan request for administrator review. Returns the optimistic record. */
  addRequest: (input: {
    amount: number
    currency: string
    purpose: string
    repaymentPlan: string
    collateralNote?: string
  }) => InternalLoanRequest
  /** Re-hydrate the list from the server. */
  refresh: () => void | Promise<unknown>
  hydrated: boolean
}

const InternalLoanContext = createContext<InternalLoanContextValue | null>(null)

export function InternalLoanProvider({ children }: { children: React.ReactNode }) {
  const {
    records: loans,
    setRecords: setLoans,
    hydrated,
    refresh,
  } = useServerRequestList<InternalLoanRequest>("internal_loan", { fromApproval: internalLoanFromApproval })

  const addRequest: InternalLoanContextValue["addRequest"] = (input) => {
    const id = `ILOAN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const full: InternalLoanRequest = {
      id,
      amount: input.amount,
      currency: input.currency || INTERNAL_LOAN_DEFAULT_CURRENCY,
      purpose: input.purpose,
      repaymentPlan: input.repaymentPlan,
      collateralNote: input.collateralNote?.trim() || undefined,
      // Provisional rate shown to the client; the administrator confirms or
      // overrides it at approval (authoritative value lands back via refresh).
      interestRate: INTERNAL_LOAN_DEFAULT_RATE,
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setLoans([full, ...loans])
    // Mirror into the DB for cross-device review; persist the COMPLETE record
    // under `payload.record` so the server rebuilds it anywhere. NO money moves
    // at request time — funding happens only on administrator approval.
    void mirrorSubmission({
      kind: "internal_loan",
      title: `Internal loan · ${full.currency} ${full.amount.toLocaleString("en-US")}`,
      summary: `${full.currency} ${full.amount.toLocaleString("en-US")} internal loan requested — ${full.purpose}`,
      amount: full.amount,
      currency: full.currency,
      payload: { localId: full.id, purpose: full.purpose, record: full },
    }).then(() => {
      void refresh()
    })
    return full
  }

  return (
    <InternalLoanContext.Provider value={{ loans, addRequest, refresh, hydrated }}>
      {children}
    </InternalLoanContext.Provider>
  )
}

export function useInternalLoans() {
  const ctx = useContext(InternalLoanContext)
  if (!ctx) {
    throw new Error("useInternalLoans must be used within an InternalLoanProvider")
  }
  return ctx
}
