"use client"

import { createContext, useContext } from "react"
import useSWR from "swr"
import { mirrorSubmissionDetailed, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { INTERNAL_LOAN_DEFAULT_RATE, INTERNAL_LOAN_DEFAULT_CURRENCY } from "@/lib/internal-loan"
import { listMyInternalLoanOutstanding } from "@/app/actions/internal-loan"

// Re-export the engine constants so importers of the store keep one source.
export { INTERNAL_LOAN_DEFAULT_RATE, INTERNAL_LOAN_DEFAULT_CURRENCY }

export type InternalLoanStatus =
  | "pending" // requested, awaiting administrator risk evaluation
  | "approved" // approved & funded — principal credited to the master account
  | "rejected" // declined
  | "cancelled" // withdrawn before a decision
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
  purpose?: string
  repaymentPlan?: string
  collateralNote?: string
  /** Annual debit interest rate as a decimal (default 3% p.a.; admin may override). */
  interestRate: number
  /** One-time arrangement fee (absolute, loan currency); set by the admin at approval. */
  arrangementFee?: number
  status: InternalLoanStatus
  submittedAt: string
  /** Set by the administrator when negotiations are opened (pending loans). */
  discussionOpenedAt?: string
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
  /**
   * Server-computed current balance still owed (principal + interest accrued −
   * repayments), in the loan currency. Only meaningful for approved loans;
   * enriched onto the record from the server, not persisted in `payload.record`.
   */
  outstanding?: number
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

/** UI-facing alias — the card renders these directly. */
export type InternalLoanView = InternalLoanRequest

export type RequestLoanResult = { ok: true; loan: InternalLoanRequest } | { ok: false; error: string }

interface InternalLoanContextValue {
  loans: InternalLoanRequest[]
  /** Submit a new loan request for administrator review. */
  requestLoan: (input: {
    amount: number
    currency: string
    purpose?: string
    repaymentPlan?: string
    collateralNote?: string
  }) => Promise<RequestLoanResult>
  /** Re-hydrate the list from the server. */
  refresh: () => void | Promise<unknown>
  hydrated: boolean
}

const InternalLoanContext = createContext<InternalLoanContextValue | null>(null)

export function InternalLoanProvider({ children }: { children: React.ReactNode }) {
  const {
    records: rawLoans,
    setRecords: setLoans,
    hydrated,
    refresh,
  } = useServerRequestList<InternalLoanRequest>("internal_loan", { fromApproval: internalLoanFromApproval })

  // Enrich approved loans with their server-computed outstanding balance. The
  // balance depends on live interest accrual + repayments (ledger state), so it
  // can't live in the static approval record — we fetch it and merge by id.
  const { data: outstandingMap, mutate: mutateOutstanding } = useSWR(
    hydrated ? "internal-loan-outstanding" : null,
    () => listMyInternalLoanOutstanding(),
    { refreshInterval: 60_000, revalidateOnFocus: true },
  )

  const loans: InternalLoanRequest[] = rawLoans.map((l) => {
    const key = l.approvalId ?? l.id
    const outstanding = outstandingMap?.[key]
    return typeof outstanding === "number" ? { ...l, outstanding } : l
  })

  const refreshAll = () => {
    void mutateOutstanding()
    return refresh()
  }

  const requestLoan: InternalLoanContextValue["requestLoan"] = async (input) => {
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "Enter a valid loan amount greater than 0." }
    }
    const id = `ILOAN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const full: InternalLoanRequest = {
      id,
      amount,
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
    // Optimistically show the pending request while the DB mirror completes.
    setLoans([full, ...rawLoans])
    // Mirror into the DB for cross-device review; persist the COMPLETE record
    // under `payload.record` so the server rebuilds it anywhere. NO money moves
    // at request time — funding happens only on administrator approval.
    const res = await mirrorSubmissionDetailed({
      kind: "internal_loan",
      title: `Internal loan · ${full.currency} ${full.amount.toLocaleString("en-US")}`,
      summary: `${full.currency} ${full.amount.toLocaleString("en-US")} internal loan requested — ${full.purpose}`,
      amount: full.amount,
      currency: full.currency,
      payload: { localId: full.id, purpose: full.purpose, record: full },
    })
    if (!res?.ok) {
      // Roll back the optimistic entry — nothing was created.
      setLoans(rawLoans.filter((l) => l.id !== full.id))
      return { ok: false, error: res?.error ?? "Your loan request could not be submitted. Please try again." }
    }
    await refresh()
    return { ok: true, loan: full }
  }

  return (
    <InternalLoanContext.Provider value={{ loans, requestLoan, refresh: refreshAll, hydrated }}>
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
