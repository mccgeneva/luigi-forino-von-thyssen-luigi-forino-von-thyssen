"use client"

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react"
import { syncMySkrRequests } from "@/app/actions/skr"
import type { SkrExpertise } from "@/lib/skr-expertise"

// ---------------------------------------------------------------------------
// SKR (Safe Keeping Receipt) Trading Platform store.
//
// SKR records are administrator-managed instruments held under custody and
// assigned to a specific client account. Customers have READ-ONLY access to
// their own records; only administrators may create, modify, delete, transfer,
// or change the status of a record.
//
// Persistence is server-only: the single source of truth is Neon (lib/skr-db.ts
// + app/actions/skr.ts), keyed by the owning client's id, so administrators can
// assign and manage receipts that the client then sees on any device, and a
// client's requests follow them across any device/browser. The client view
// hydrates from the server, re-fetches on focus and on a 30s poll — nothing is
// read from or written to localStorage. Administrators read/write any client's
// data through the passcode-gated server actions.
// ---------------------------------------------------------------------------

export type SkrStatus =
  | "active"
  | "pending"
  | "matured"
  | "transferred"
  | "suspended"
  | "cancelled"

export interface SkrTransaction {
  id: string
  date: string // ISO
  type: string // e.g. "Issuance", "Transfer", "Status Update", "Verification"
  description: string
  reference: string
}

export interface SkrDocument {
  id: string
  name: string
  docType: string // e.g. "SKR Certificate", "Custodian Confirmation"
  uploadedAt: string // ISO
  note?: string
  /** Blob pathname for an uploaded file (served via the session-gated /api/file proxy). */
  pathname?: string
  /** Public blob URL (kept for reference; the app links through the proxy). */
  url?: string
  /** Size in bytes of the uploaded file, if known. */
  size?: number
  /** MIME type of the uploaded file, e.g. "image/png", "application/pdf". */
  contentType?: string
}

export interface SkrRecord {
  /** Instrument reference number, e.g. SKR-0001. */
  id: string
  /** Issuing bank or custodian. */
  custodian: string
  /** Beneficial owner (legal name). */
  beneficialOwner: string
  faceValue: number
  currency: string
  issueDate: string // ISO date
  expiryDate?: string // ISO date (if applicable)
  /** Custody account reference. */
  custodyAccountRef: string
  status: SkrStatus
  /** Description of the asset held under custody — the object of this SKR. */
  assetDescription?: string
  /** Optional free-text custody / instrument notes. */
  notes?: string
  documents: SkrDocument[]
  transactions: SkrTransaction[]
  /** Id of the client account this record is assigned to. */
  assignedUserId: string
  /**
   * Whether this SKR's value has been credited to the owner's treasury balance
   * as pledged collateral for trading. Kept on the record so the credit is
   * idempotent (it can only be applied once) and reversible.
   */
  creditedToTreasury?: boolean
  /** EUR amount credited to treasury (may differ from faceValue if converted). */
  treasuryCreditAmount?: number
  /** When the treasury credit was applied (ISO). */
  treasuryCreditedAt?: string
  /**
   * Expertise / evaluation / audit lifecycle. Present once a customer applies;
   * the administrator sets the assessed value + outcome and the client accepts.
   */
  expertise?: SkrExpertise
  /**
   * Set true once an accepted expertise has blocked this SKR as MT760-style
   * collateral (materialised as a pledgeable bank instrument). While blocked it
   * cannot be re-applied for expertise.
   */
  blockedAsCollateral?: boolean
  createdAt: string // ISO
  updatedAt: string // ISO
}

export type SkrRequestType =
  | "Statement"
  | "Verification"
  | "Amendment"
  | "Transfer"
  | "Other"

export type SkrRequestStatus = "pending" | "approved" | "rejected"

export interface SkrRequest {
  id: string
  recordId: string // related SKR reference (may be "" for general)
  type: SkrRequestType
  message: string
  status: SkrRequestStatus
  submittedAt: string // ISO
  decidedAt?: string // ISO
  decisionNote?: string
}

/** Generate a unique SKR reference number. */
export function generateSkrId(): string {
  const n = Math.floor(100000 + Math.random() * 900000)
  return `SKR-${n}`
}

export function generateSkrRef(prefix: string): string {
  const n = Math.floor(100000 + Math.random() * 900000)
  return `${prefix}-${n}`
}

// --- Active-user reactive context (customer-facing, read-mostly) ------------

interface SkrContextValue {
  records: SkrRecord[]
  requests: SkrRequest[]
  /** Customer submits a request concerning an instrument. */
  addRequest: (input: Omit<SkrRequest, "id" | "status" | "submittedAt">) => SkrRequest
  hydrated: boolean
  /** Force a re-read from storage (used after admin writes in the same tab). */
  refresh: () => void
}

const SkrContext = createContext<SkrContextValue | null>(null)

export function SkrProvider({ children }: { children: React.ReactNode }) {
  const [records, setRecords] = useState<SkrRecord[]>([])
  const [requests, setRequests] = useState<SkrRequest[]>([])
  const [hydrated, setHydrated] = useState(false)
  // Skip the server-mirror that the hydration/refresh setState would trigger,
  // so we never echo freshly-loaded data straight back to the server.
  const skipNextSync = useRef(true)

  // Reconcile records + requests with the authoritative server copy. Records are
  // read-only for the client (administrator-owned); requests are mirrored back
  // on change. We guard the next request-mirror so applying server data doesn't
  // bounce straight back.
  // Read through the GET Route Handler (`/api/skr`), NOT the `getMySkr*` Server
  // Actions: Server Actions are serialized with client navigations and would
  // freeze the dashboard's first navigation when ~20 providers all read on
  // login. A route-handler fetch stays off that queue. The write path
  // (`syncMySkrRequests`) stays a Server Action — it only fires on a deliberate
  // user action, never during the login mount storm.
  const reconcile = useCallback(async () => {
    try {
      const res = await fetch("/api/skr", { cache: "no-store" })
      if (!res.ok) return
      const json = (await res.json()) as {
        ok: boolean
        records?: { data: unknown }[]
        requests?: { data: unknown }[]
      }
      if (!json.ok) return
      if (Array.isArray(json.records)) {
        skipNextSync.current = true
        setRecords(json.records.map((r) => r.data as unknown as SkrRecord))
      }
      if (Array.isArray(json.requests)) {
        skipNextSync.current = true
        setRequests(json.requests.map((r) => r.data as unknown as SkrRequest))
      }
    } catch {
      // keep whatever we already have on a transient failure
    }
  }, [])

  // Load once on mount from Neon (durable, cross-device, admin-managed), then
  // re-fetch on focus and on a 30s poll so administrator changes appear without
  // a manual reload. Nothing is cached in localStorage.
  useEffect(() => {
    let active = true
    reconcile().finally(() => {
      if (active) setHydrated(true)
    })
    const onFocus = () => void reconcile()
    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const id = setInterval(() => void reconcile(), 30000)
    return () => {
      active = false
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(id)
    }
  }, [reconcile])

  // Mirror requests to the server on change (non-destructive: only new requests
  // are inserted; the custody desk's decisions are preserved). The first write
  // after a server-driven setRequests is skipped so we never echo fetched data.
  useEffect(() => {
    if (!hydrated) return
    if (skipNextSync.current) {
      skipNextSync.current = false
      return
    }
    void syncMySkrRequests(requests.map((r) => ({ id: r.id, data: r as unknown as Record<string, unknown>, status: r.status })))
  }, [requests, hydrated])

  const addRequest: SkrContextValue["addRequest"] = (input) => {
    const full: SkrRequest = {
      ...input,
      id: generateSkrRef("SKRREQ"),
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setRequests((prev) => [full, ...prev])
    return full
  }

  return (
    <SkrContext.Provider
      value={{ records, requests, addRequest, hydrated, refresh: reconcile }}
    >
      {children}
    </SkrContext.Provider>
  )
}

export function useSkr() {
  const ctx = useContext(SkrContext)
  if (!ctx) throw new Error("useSkr must be used within an SkrProvider")
  return ctx
}

// --- Formatting helpers shared across SKR surfaces --------------------------

export function formatSkrValue(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export const SKR_STATUS_LABELS: Record<SkrStatus, string> = {
  active: "Active",
  pending: "Pending",
  matured: "Matured",
  transferred: "Transferred",
  suspended: "Suspended",
  cancelled: "Cancelled",
}
