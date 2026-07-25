"use client"

import { createContext, useContext } from "react"
import { generateUetr } from "@/lib/swift-gpi"
import { mirrorSubmission } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"

export type PaymentRequestStatus = "pending" | "approved" | "rejected"

export interface PaymentRequest {
  id: string
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  uetr: string // SWIFT gpi Unique End-to-End Transaction Reference (UUID v4)
  beneficiary: string
  beneficiaryCountry: string
  iban: string
  swiftCode: string
  reference: string
  notes: string
  currency: string
  amount: number // principal
  fee: number // 2% platform fee
  total: number // amount + fee
  payeeSource: string
  status: PaymentRequestStatus
  submittedAt: string // ISO timestamp
  decidedAt?: string // ISO timestamp of approval/rejection
  decisionNote?: string // administrator note (e.g. rejection reason)
  // --- Outgoing routing (assigned by the Administrator at approval) ---------
  routedBankKey?: string // PartnerBank.key the payment is settled through
  routedBankName?: string // human-readable partner bank name (denormalised)
  routedBankBic?: string // partner bank BIC (denormalised for display/audit)
  // --- Recall lifecycle (set on the original payment when a recall is filed) -
  /** "pending" once a recall is requested, "recalled" once it is approved. */
  recallStatus?: "pending" | "recalled"
  // --- Delivery lifecycle (stage 3) -----------------------------------------
  /**
   * Set to "delivered" once the Administrator confirms the funds reached the
   * beneficiary account. An approved payment is "Approved & Initiated" (stage 2)
   * until this is set, at which point it becomes "Completed — Funds Delivered"
   * (stage 3). The funds already left the account at approval; this is a
   * delivery confirmation only, not a further ledger movement.
   */
  deliveryStatus?: "delivered"
  /** ISO timestamp the Administrator confirmed delivery. */
  deliveredAt?: string
  /** Responsible party who confirmed delivery (for the audit trail). */
  deliveredBy?: string
}

/** Routing details assigned to an outgoing payment when it is approved. */
export interface PaymentRouting {
  routedBankKey: string
  routedBankName: string
  routedBankBic: string
}

interface PaymentRequestsContextValue {
  requests: PaymentRequest[]
  /** Create a new pending request (no funds move yet). Returns the stored record. */
  addRequest: (
    request: Omit<
      PaymentRequest,
      "status" | "submittedAt" | "decidedAt" | "decisionNote" | "uetr"
    >,
  ) => PaymentRequest
  /** Mark a pending request approved. Funds are debited by the caller (ledger). */
  approveRequest: (id: string, routing?: PaymentRouting) => PaymentRequest | null
  /** Mark a pending request rejected with an optional reason. No funds move. */
  rejectRequest: (id: string, reason?: string) => PaymentRequest | null
  /**
   * Mark an approved request as delivered (stage 3, "Completed — Funds
   * Delivered"). Optimistic local update only; the caller must also persist via
   * the server so the change survives the next refresh and reaches the client.
   */
  markDelivered: (id: string) => PaymentRequest | null
  hydrated: boolean
}

const PaymentRequestsContext = createContext<PaymentRequestsContextValue | null>(null)

export function PaymentRequestsProvider({ children }: { children: React.ReactNode }) {
  // The list is sourced entirely from the server (Neon `approval_requests`),
  // so a client's payments follow them across any device/browser and reflect
  // administrator decisions made elsewhere. No localStorage is involved.
  const { records: requests, setRecords: setRequests, hydrated, refresh } =
    useServerRequestList<PaymentRequest>("payment")

  const addRequest: PaymentRequestsContextValue["addRequest"] = (request) => {
    const full: PaymentRequest = {
      ...request,
      uetr: generateUetr(),
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    // Optimistically show the request, then mirror it to the DB. We persist the
    // COMPLETE record under `payload.record` so the server can fully rebuild the
    // view on any device. A server-side ledger effect (debit incl. the 2% fee)
    // posts to the OWNER's ledger when the admin approves — in any session — and
    // the LedgerProvider pulls it via getMyLedger(); the list store never posts
    // to the ledger itself, so there is no double counting.
    setRequests([full, ...requests])
    void mirrorSubmission({
      kind: "payment",
      title: `Payment to ${full.beneficiary}`,
      summary: `${full.currency} ${full.amount.toLocaleString("en-US")} to ${full.beneficiary}${full.reference ? ` · ${full.reference}` : ""}`,
      amount: full.total,
      currency: full.currency,
      payload: { localId: full.id, uetr: full.uetr, iban: full.iban, swiftCode: full.swiftCode, record: full },
      ledgerEffect: {
        direction: "debit",
        amount: full.total,
        currency: full.currency,
        status: "completed",
        counterparty: full.beneficiary,
        account: full.iban,
        reference: full.reference || full.uetr,
        category: "Outgoing Payment",
      },
    }).then(() => {
      // Re-pull from the server so the record carries its server id + status.
      void refresh()
    })
    return full
  }

  // Admin decisions are made through the DB approvals queue and surface here via
  // the server hydration above. These local mutators are retained for interface
  // compatibility and update the in-memory view immediately; the next refresh
  // reconciles against the authoritative server state.
  const approveRequest: PaymentRequestsContextValue["approveRequest"] = (id, routing) => {
    let updated: PaymentRequest | null = null
    setRequests(
      requests.map((r) => {
        if (r.id === id && r.status === "pending") {
          updated = {
            ...r,
            status: "approved",
            decidedAt: new Date().toISOString(),
            ...(routing
              ? {
                  routedBankKey: routing.routedBankKey,
                  routedBankName: routing.routedBankName,
                  routedBankBic: routing.routedBankBic,
                }
              : {}),
          }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  const rejectRequest: PaymentRequestsContextValue["rejectRequest"] = (id, reason) => {
    let updated: PaymentRequest | null = null
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

  const markDelivered: PaymentRequestsContextValue["markDelivered"] = (id) => {
    let updated: PaymentRequest | null = null
    setRequests(
      requests.map((r) => {
        // Only an approved, not-yet-delivered payment can advance to stage 3.
        if (r.id === id && r.status === "approved" && r.deliveryStatus !== "delivered") {
          updated = {
            ...r,
            deliveryStatus: "delivered",
            deliveredAt: new Date().toISOString(),
            deliveredBy: "Administrator",
          }
          return updated
        }
        return r
      }),
    )
    return updated
  }

  return (
    <PaymentRequestsContext.Provider
      value={{ requests, addRequest, approveRequest, rejectRequest, markDelivered, hydrated }}
    >
      {children}
    </PaymentRequestsContext.Provider>
  )
}

export function usePaymentRequests() {
  const ctx = useContext(PaymentRequestsContext)
  if (!ctx) {
    throw new Error("usePaymentRequests must be used within a PaymentRequestsProvider")
  }
  return ctx
}
