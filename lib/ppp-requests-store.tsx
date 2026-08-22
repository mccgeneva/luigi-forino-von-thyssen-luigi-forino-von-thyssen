"use client"

import { createContext, useContext } from "react"
import { mirrorSubmission } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"

export type PPPRequestStatus = "pending" | "approved" | "rejected"

export interface PPPRequest {
  id: string
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  programId: string
  programName: string
  expectedReturn: string
  returnFrequency: string
  duration: string
  currency: string
  amount: number // requested investment amount
  sourceOfFunds: string
  payoutAccount: string
  status: PPPRequestStatus
  submittedAt: string // ISO timestamp of the client request
  decidedAt?: string // ISO timestamp of approval/rejection
  decisionNote?: string // administrator note (e.g. rejection reason)

  // ---- MCC-owned funding instrument & 75/25 benefit split (optional) --------
  /** Id of the MCC HOLDING SA-owned instrument funding this investment, if any. */
  fundingInstrumentId?: string
  /** Human label of that instrument (type + id) for display/audit. */
  fundingInstrumentLabel?: string
  /** MCC HOLDING SA share of the RETURN (0.75) when funded by an MCC instrument. */
  mccBenefitRate?: number
  /** Assignee client share of the RETURN (0.25) when funded by an MCC instrument. */
  clientBenefitRate?: number
}

interface PPPRequestsContextValue {
  requests: PPPRequest[]
  /** Create a new pending PPP application awaiting Administrator approval. */
  addRequest: (
    request: Omit<PPPRequest, "status" | "submittedAt" | "decidedAt" | "decisionNote">,
  ) => PPPRequest
  /** Approve a pending application — the investment is activated. */
  approveRequest: (id: string) => PPPRequest | null
  /** Reject a pending application with an optional reason. */
  rejectRequest: (id: string, reason?: string) => PPPRequest | null
  hydrated: boolean
}

const PPPRequestsContext = createContext<PPPRequestsContextValue | null>(null)

export function PPPRequestsProvider({ children }: { children: React.ReactNode }) {
  // Source of truth is the server (Neon `approval_requests`); the list follows
  // the user across devices and reflects admin decisions. No localStorage.
  const { records: requests, setRecords: setRequests, hydrated, refresh } =
    useServerRequestList<PPPRequest>("ppp")

  const addRequest: PPPRequestsContextValue["addRequest"] = (request) => {
    const full: PPPRequest = {
      ...request,
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setRequests([full, ...requests])
    // Mirror into the DB so the Administrator can review it cross-client. The
    // complete record is stored under `payload.record` for cross-device rebuild.
    void mirrorSubmission({
      kind: "ppp",
      title: full.programName,
      summary: `${full.currency} ${full.amount.toLocaleString("en-US")} into ${full.programName} (${full.expectedReturn} ${full.returnFrequency})`,
      amount: full.amount,
      currency: full.currency,
      payload: { localId: full.id, programId: full.programId, sourceOfFunds: full.sourceOfFunds, record: full },
    }).then(() => void refresh())
    return full
  }

  const approveRequest: PPPRequestsContextValue["approveRequest"] = (id) => {
    let updated: PPPRequest | null = null
    setRequests(
      requests.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = { ...r, status: "approved", decidedAt: new Date().toISOString() }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  const rejectRequest: PPPRequestsContextValue["rejectRequest"] = (id, reason) => {
    let updated: PPPRequest | null = null
    setRequests(
      requests.map((r) => {
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

  return (
    <PPPRequestsContext.Provider
      value={{ requests, addRequest, approveRequest, rejectRequest, hydrated }}
    >
      {children}
    </PPPRequestsContext.Provider>
  )
}

export function usePPPRequests() {
  const ctx = useContext(PPPRequestsContext)
  if (!ctx) {
    throw new Error("usePPPRequests must be used within a PPPRequestsProvider")
  }
  return ctx
}
