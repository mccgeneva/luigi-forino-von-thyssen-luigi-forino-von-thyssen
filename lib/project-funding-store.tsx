"use client"

import { createContext, useContext } from "react"
import type { AesEquityComponent } from "@/lib/aes"
import { mirrorSubmission } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"

export type ProjectFundingStatus = "pending" | "approved" | "rejected"

/** A single uploaded document in the required documentation package. Only
 *  metadata is persisted (file name + timestamp), consistent with the rest of
 *  the platform's document handling. */
export interface UploadedFundingDoc {
  docId: string
  title: string
  fileName: string
  uploadedAt: string
}

export interface ProjectFundingRequest {
  id: string
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  projectName: string
  sector: string
  jurisdiction: string
  description?: string
  currency: string
  /** Total financing facility requested. */
  facility: number
  /** Total equity obligation computed at submission via the AES tiered matrix. */
  totalEquity: number
  /** Blended effective equity rate (snapshot at submission). */
  effectiveRate: number
  /** Equity composition the client intends to provide. */
  equityComponents: AesEquityComponent[]
  /** Cash commitment band (snapshot at submission). */
  cashCommitmentMin: number
  cashCommitmentMax: number
  /** Client confirmed they will submit the full required documentation package. */
  documentsAcknowledged: boolean
  /** Whether the client will provide a qualifying bank statement. */
  bankStatementProvided: boolean
  /** True when the bank-statement waiver fee applies (no statement provided). */
  waiverFeeApplies: boolean
  /** Client accepted the upfront waiver fee in lieu of a bank statement. */
  waiverFeeAccepted: boolean
  /** Waiver fee amount + currency snapshot (when applicable). */
  waiverFeeAmount?: number
  waiverFeeCurrency?: string
  /** Documents uploaded with the application (metadata only). */
  uploadedDocuments: UploadedFundingDoc[]
  status: ProjectFundingStatus
  submittedAt: string
  decidedAt?: string
  decisionNote?: string
  /** Risk score (0–10) issued at approval; sets the applicable cash commitment. */
  riskScore?: number
  /** Applicable upfront cash commitment fixed at approval. */
  cashCommitment?: number

  // --- Administrator display (populated only when the admin loads the
  //     cross-client facility queue, so a decision card can show WHO the
  //     facility belongs to). Never set on the client's own portfolio view. ---
  /** Account id that owns / received this facility. */
  ownerUserId?: string
  /** Owner's full name (admin display). */
  ownerName?: string
  /** Owner's registered email (admin display). */
  ownerEmail?: string
  /** Owner's company (admin display). */
  ownerCompany?: string

  // --- Early liquidation / closure lifecycle --------------------------------
  /** A client's pending request to close the facility early (awaiting admin). */
  closureRequest?: FundingClosureRequest
  /** Set once the facility has been recalled/terminated and settled. */
  closedAt?: string
  /** Who/what closed the facility. */
  closureKind?: "admin_recall" | "client_early"
  /** Free-text note recorded at closure. */
  closureNote?: string
  /** Immutable settlement snapshot computed at the closure date. */
  settlement?: FundingSettlementSnapshot
}

/** A client-initiated early-closure request awaiting administrator approval. */
export interface FundingClosureRequest {
  requestedAt: string
  /** Optional reason supplied by the client. */
  note?: string
  /** Total payoff quoted to the client when they submitted the request. */
  quotedPayoff: number
  /** The instant the quote was computed (payoff grows until settlement). */
  quotedAsOf: string
  currency: string
}

/** The settlement breakdown debited from the owner's balance on closure. */
export interface FundingSettlementSnapshot {
  /** Facility principal clawed back to MCC. */
  principal: number
  /** Outstanding accrued cost-of-capital not yet charged, to the closure date. */
  interest: number
  /** Early-exit settlement fee (AES 70% of the remaining-tenor cost of capital). */
  fee: number
  /** principal + interest + fee. */
  total: number
  currency: string
  closedAt: string
}

export interface ApproveFundingOptions {
  riskScore?: number
  cashCommitment?: number
  note?: string
}

interface ProjectFundingContextValue {
  requests: ProjectFundingRequest[]
  /** Create a new pending project funding application awaiting Administrator approval. */
  addRequest: (
    request: Omit<
      ProjectFundingRequest,
      "status" | "submittedAt" | "decidedAt" | "decisionNote" | "riskScore" | "cashCommitment"
    >,
  ) => ProjectFundingRequest
  /** Approve a pending application, optionally fixing the risk score / cash commitment. */
  approveRequest: (id: string, opts?: ApproveFundingOptions) => ProjectFundingRequest | null
  /** Reject a pending application with an optional reason. */
  rejectRequest: (id: string, reason?: string) => ProjectFundingRequest | null
  hydrated: boolean
}

const ProjectFundingContext = createContext<ProjectFundingContextValue | null>(null)

export function ProjectFundingProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon), so applications and admin
  // decisions are visible on any device/browser. No localStorage involved.
  const { records: requests, setRecords: setRequests, hydrated, refresh } =
    useServerRequestList<ProjectFundingRequest>("project_funding")

  const addRequest: ProjectFundingContextValue["addRequest"] = (request) => {
    const full: ProjectFundingRequest = {
      ...request,
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setRequests([full, ...requests])
    // Mirror into the DB so the Administrator can review it cross-client; persist
    // the COMPLETE record under `payload.record` so the server rebuilds it anywhere.
    void mirrorSubmission({
      kind: "project_funding",
      title: `${full.projectName} · ${full.sector}`,
      summary: `${full.currency} ${full.facility.toLocaleString("en-US")} facility for ${full.projectName} (${full.jurisdiction}) — equity ${full.currency} ${full.totalEquity.toLocaleString("en-US")} @ ${full.effectiveRate}%`,
      amount: full.facility,
      currency: full.currency,
      payload: { localId: full.id, sector: full.sector, jurisdiction: full.jurisdiction, record: full },
    }).then(() => {
      void refresh()
    })
    return full
  }

  // Admin decisions flow through the DB and surface here via server hydration.
  // These local mutators update the in-memory view immediately for interface
  // compatibility; the next refresh reconciles against authoritative state.
  const approveRequest: ProjectFundingContextValue["approveRequest"] = (id, opts) => {
    let updated: ProjectFundingRequest | null = null
    setRequests(
      requests.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = {
            ...r,
            status: "approved",
            decidedAt: new Date().toISOString(),
            riskScore: opts?.riskScore,
            cashCommitment: opts?.cashCommitment,
            decisionNote: opts?.note?.trim() || undefined,
          }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  const rejectRequest: ProjectFundingContextValue["rejectRequest"] = (id, reason) => {
    let updated: ProjectFundingRequest | null = null
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
    <ProjectFundingContext.Provider
      value={{ requests, addRequest, approveRequest, rejectRequest, hydrated }}
    >
      {children}
    </ProjectFundingContext.Provider>
  )
}

export function useProjectFunding() {
  const ctx = useContext(ProjectFundingContext)
  if (!ctx) {
    throw new Error("useProjectFunding must be used within a ProjectFundingProvider")
  }
  return ctx
}
