"use client"

import { createContext, useContext } from "react"
import { generateUetr } from "@/lib/swift-gpi"
import { mirrorSubmission } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"

export type MonetizationStatus = "pending" | "approved" | "rejected" | "reversed"

// How the monetization is structured against the underlying bank instrument.
export type MonetizationStructure =
  | "CreditLine" // non-recourse credit line / loan secured by the instrument
  | "Discounting" // outright discounting / purchase of the instrument
  | "CollateralTransfer" // collateral transfer (SWIFT MT760) for credit enhancement

export interface MonetizationRequest {
  id: string // platform reference, e.g. "MON-1A2B3C4D"
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  uetr: string // SWIFT gpi Unique End-to-End Transaction Reference (UUID v4)

  // Underlying bank instrument being monetized
  instrumentId: string // reference of the instrument in the holder's portfolio
  instrumentType: string // short code, e.g. "SBLC", "BG", "MTN"
  instrumentTypeFull: string // full name, e.g. "Standby Letter of Credit"
  issuer: string // issuing bank of the instrument
  faceValue: number // face / nominal value of the instrument
  currency: string

  // Collateral base actually being monetized. For a plain instrument this equals
  // faceValue; for an instrument pledged to an approved leverage line it is the
  // leveraged value (faceValue × leverageRatio), e.g. €50M BG at 1:5 -> €250M.
  monetizedValue: number
  leverageRatio?: number // leverage multiplier on the underlying, when leveraged

  // Monetization economics
  structure: MonetizationStructure
  advanceRatePercent: number // loan-to-value / advance rate (% of monetized value)
  grossProceeds: number // computed: monetizedValue * advanceRate
  proceedsCurrency: string

  // Coordination / counterparties
  monetizationPlatform: string // monetizer / program name
  receivingBank: string // bank receiving the proceeds (usually MCC master)
  receivingBankBic: string

  // SWIFT messaging + supporting documentation references
  mt760Ref: string // MT760 (guarantee / SBLC issuance or collateral transfer)
  mt799Ref: string // MT799 (free-format pre-advice / RWA assurance)
  mt760Raw?: string // generated MT760 FIN message (full SWIFT block structure)
  mt799Raw?: string // generated MT799 FIN message (full SWIFT block structure)
  pofReference: string // Proof of Funds reference
  bclReference: string // Bank Comfort Letter reference

  notes: string

  status: MonetizationStatus
  submittedAt: string // ISO timestamp
  decidedAt?: string // ISO timestamp of approval/rejection
  decisionNote?: string // administrator note (e.g. rejection reason)
  creditedEntryId?: string // ledger entry id created on approval
}

interface MonetizationRequestsContextValue {
  requests: MonetizationRequest[]
  /** Create a new pending request (no funds move yet). Returns the stored record. */
  addRequest: (
    request: Omit<
      MonetizationRequest,
      "id" | "uetr" | "status" | "submittedAt" | "decidedAt" | "decisionNote" | "creditedEntryId"
    >,
  ) => MonetizationRequest
  /** Mark a pending request approved. Proceeds are credited by the caller (ledger). */
  approveRequest: (id: string, creditedEntryId?: string) => MonetizationRequest | null
  /** Mark a pending request rejected with an optional reason. No funds move. */
  rejectRequest: (id: string, reason?: string) => MonetizationRequest | null
  hydrated: boolean
}

const MonetizationRequestsContext = createContext<MonetizationRequestsContextValue | null>(null)

// Short, human-readable reference for the monetization request.
function generateMonetizationId(): string {
  return `MON-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
}

export function MonetizationRequestsProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon), so submissions and admin
  // decisions are visible on any device/browser. No localStorage involved.
  const { records: requests, setRecords: setRequests, hydrated, refresh } =
    useServerRequestList<MonetizationRequest>("monetization", { cancelledStatus: "reversed" })

  const addRequest: MonetizationRequestsContextValue["addRequest"] = (request) => {
    const full: MonetizationRequest = {
      ...request,
      id: generateMonetizationId(),
      uetr: generateUetr(),
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setRequests([full, ...requests])
    // Mirror into the DB so the Administrator can review it cross-client. We
    // attach a server-side ledger effect (a CREDIT for the gross proceeds) so
    // that when the admin approves — in a DIFFERENT browser/session via the
    // pending-approvals queue — the proceeds are posted to the OWNER's server
    // ledger and pulled via getMyLedger(). We persist the COMPLETE record under
    // `payload.record` so the server can rebuild the view anywhere. The list
    // store never posts to the ledger itself, so there is no double counting.
    void mirrorSubmission({
      kind: "monetization",
      title: `${full.instrumentTypeFull} · ${full.issuer}`,
      summary: `Monetize ${full.currency} ${full.monetizedValue.toLocaleString("en-US")} ${full.instrumentTypeFull}${full.leverageRatio ? ` (leveraged 1:${full.leverageRatio} on ${full.currency} ${full.faceValue.toLocaleString("en-US")} face)` : ""} at ${full.advanceRatePercent}% (proceeds ${full.proceedsCurrency} ${full.grossProceeds.toLocaleString("en-US")})`,
      amount: full.grossProceeds,
      currency: full.proceedsCurrency,
      payload: { localId: full.id, uetr: full.uetr, structure: full.structure, instrumentId: full.instrumentId, record: full },
      ledgerEffect: {
        direction: "credit",
        amount: full.grossProceeds,
        currency: full.proceedsCurrency,
        status: "completed",
        counterparty: full.monetizationPlatform || full.issuer,
        bank: full.receivingBank
          ? `${full.receivingBank}${full.receivingBankBic ? ` (${full.receivingBankBic})` : ""}`
          : undefined,
        reference: full.mt760Ref || full.uetr,
        category: "Instrument Monetization",
      },
    }).then(() => {
      void refresh()
    })
    return full
  }

  // Admin decisions flow through the DB and surface here via server hydration.
  // These local mutators update the in-memory view immediately for interface
  // compatibility; the next refresh reconciles against authoritative state.
  const approveRequest: MonetizationRequestsContextValue["approveRequest"] = (
    id,
    creditedEntryId,
  ) => {
    let updated: MonetizationRequest | null = null
    setRequests(
      requests.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = {
            ...r,
            status: "approved",
            decidedAt: new Date().toISOString(),
            creditedEntryId,
          }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  const rejectRequest: MonetizationRequestsContextValue["rejectRequest"] = (id, reason) => {
    let updated: MonetizationRequest | null = null
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
    <MonetizationRequestsContext.Provider
      value={{ requests, addRequest, approveRequest, rejectRequest, hydrated }}
    >
      {children}
    </MonetizationRequestsContext.Provider>
  )
}

export function useMonetizationRequests() {
  const ctx = useContext(MonetizationRequestsContext)
  if (!ctx) {
    throw new Error("useMonetizationRequests must be used within a MonetizationRequestsProvider")
  }
  return ctx
}
