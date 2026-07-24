"use client"

import { createContext, useContext, useEffect } from "react"
import { generateUetr } from "@/lib/swift-gpi"
import { mirrorSubmission, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { useLedger } from "@/lib/ledger-store"
import type { Vessel } from "@/lib/spot-deals-shared"
import {
  revokeMyCommodityDeal,
  updateMyApprovalRecord,
  requestDealAmendment,
  addDealNegotiationNote,
  setMyCommodityDealHold,
  editMyCommodityDealTerms,
  deleteMyCommodityDeal,
  type EditableDealTerms,
} from "@/app/actions/approvals"

export type DealStatus = "pending" | "approved" | "rejected" | "cancelled"

// Standard professional commodity-trading sequence. The client advances through
// the pre-execution stages as the deal progresses; only the Administrator can
// move a deal to "execution" (by approving it) — no automatic customer execution.
export type DealStage = "icpo" | "fco" | "contract" | "pop" | "pof" | "execution"

export const DEAL_STAGES: { key: DealStage; label: string; description: string }[] = [
  { key: "icpo", label: "ICPO", description: "Buyer submits Irrevocable Corporate Purchase Order" },
  { key: "fco", label: "FCO", description: "Seller issues Full Corporate Offer & contract draft" },
  { key: "contract", label: "Contract", description: "Signed contract exchange between parties" },
  { key: "pop", label: "POP", description: "Seller submits Proof of Product documents" },
  { key: "pof", label: "POF", description: "Buyer submits Proof of Funds / banking instrument" },
  { key: "execution", label: "Execution", description: "Admin-authorized execution / shipment" },
]

// Commodity transaction structures.
export type TradeStructure = "FOB" | "CIF" | "Spot" | "Long-term"

// Specialized transaction categories supported by the desk.
export type DealCategory =
  | "Commodity Trade"
  | "Download of Funds"
  | "DTC/IP Transfer"
  | "Bank Instrument Monetization"

// Instrument backing the value of the deal.
export type InstrumentType = "Cash" | "SBLC" | "BG" | "Securities" | "Commodity" | "DLC"

// "POP" (seller proof-of-product) and "POF" (buyer proof-of-funds) are the
// client-managed modules; "DEAL" is the administrator-managed deal-document
// catalogue (POI, ICPO, POF letters, POP, SGS, proof of payment, allocation,
// free-to-resell, sold, etc.) attached directly to an approved deal.
export type DocModule = "POP" | "POF" | "DEAL"

export type DocStatus = "submitted" | "verified" | "rejected"

/** The fixed catalogue of administrator-issued deal documents. */
export const DEAL_DOC_TYPES = [
  "Passport / Photo ID (POI)",
  "ICPO",
  "Proof of Funds (POF)",
  "Partial POP",
  "Full POP",
  "SGS / Inspection Report",
  "Proof of Payment (SWIFT)",
  "Allocated / Reserved",
  "Free to Resell",
  "Sold",
  "Contract (SPA)",
  "Other",
] as const

// A single immutable version of a document record. Metadata is always present;
// when the administrator uploads a real file, the binary lives in private Blob
// storage and is referenced by `blobPathname` (served via the /api/file proxy).
export interface DealDocumentVersion {
  version: number
  fileName: string // descriptive file name, e.g. "BL-2024-0042.pdf"
  reference: string // document reference / number
  issuedBy: string // issuing bank / authority / inspector
  issueDate: string // ISO yyyy-mm-dd
  notes: string
  uploadedAt: string // ISO timestamp
  /** Private Blob pathname of the uploaded PDF, if any (never the raw URL). */
  blobPathname?: string
  /** Size of the uploaded file in bytes, for display. */
  fileSize?: number
  /** MIME type of the uploaded file (expected application/pdf). */
  contentType?: string
}

export interface DealDocument {
  id: string
  module: DocModule // POP (seller) or POF (buyer)
  docType: string // e.g. "Bill of Lading", "Bank Comfort Letter (BCL)"
  status: DocStatus
  currentVersion: number
  versions: DealDocumentVersion[]
  // SWIFT reference where relevant (e.g. MT799 pre-advice for POF instruments).
  swiftRef?: string
  decidedAt?: string
  decisionNote?: string
}

// The negotiable subset of a deal's commercial terms. A post-approval amendment
// proposes new values for these, which take effect only after admin sign-off.
export interface DealTerms {
  approxValue: number
  quantity: string
  tradeStructure: TradeStructure
  /** The renegotiated PER-UNIT price (per MT/BBL). The server recomputes the
   * authoritative total as unitPrice × quantity from this, so a stale client
   * can never persist a raw per-unit price as the total deal value. */
  unitPrice?: number
}

// A single entry in a deal's negotiation log (client or admin authored).
export interface DealNegotiationNote {
  id: string
  author: string // display name of who logged it
  authorRole: "client" | "admin"
  message: string
  createdAt: string // ISO timestamp
}

// A reversible pause (suspend) or lock (freeze) placed on a deal by either the
// client or the administrator. Suspend halts the workflow (stage advances and
// document uploads); freeze additionally locks edits, revocation and deletion,
// keeping any reserved funds blocked until it is lifted.
export type DealHoldState = "suspended" | "frozen"
export interface DealHold {
  state: DealHoldState
  by: "client" | "admin"
  byName?: string
  note?: string
  at: string // ISO timestamp
}

export type AmendmentStatus = "pending" | "approved" | "rejected"

// A proposed (or historical) change to a deal's commercial terms. Lives on the
// deal record; the `pending` one is mirrored to a `commodity_amendment` approval
// so it clears the same admin gate as the original deal before going live.
export interface DealAmendment {
  id: string
  approvalId?: string // DB approval id for the amendment request
  status: AmendmentStatus
  reason: string // why the client is renegotiating
  previous: DealTerms // terms before the change (for the audit diff)
  proposed: DealTerms // terms the client wants
  requestedAt: string
  decidedAt?: string
  decisionNote?: string
}

export interface CommodityDeal {
  id: string // platform reference, e.g. "DEAL-1A2B3C4D"
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  /** Source spot deal id when this tracked deal was auto-created from a reserved spot cargo. */
  spotDealId?: string
  uetr: string // SWIFT gpi Unique End-to-End Transaction Reference (UUID v4)

  // Deal identity
  title: string
  category: DealCategory
  tradeStructure: TradeStructure
  commodity: string
  quantity: string // free-form, e.g. "100,000 MT" / "2,000,000 BBL"
  approxValue: number
  currency: string

  // Parties
  buyerName: string
  sellerName: string

  // Banking / transaction context
  sendingBank: string
  sendingBankBic: string
  receivingBank: string
  receivingBankBic: string
  instrumentType: InstrumentType
  originCountry: string
  destinationCountry: string

  // SWIFT message references
  mt103Ref: string // MT103 single customer credit transfer
  mt202Ref: string // MT202 / MT202 COV financial institution transfer
  mt799Ref: string // MT799 free-format / pre-advice

  notes: string

  // Workflow
  stage: DealStage
  status: DealStatus

  // Embedded document records (POP + POF + admin-issued DEAL documents)
  documents: DealDocument[]

  /** Vessel assigned to carry the cargo, attached & verified by the admin.
   *  A denormalised snapshot (with its compliance screening) so the deal stays
   *  intact even if the vessel catalogue row later changes. */
  vessel?: Vessel

  submittedAt: string
  decidedAt?: string
  decisionNote?: string
  // Ledger entry created when the deal is authorized for execution (proceeds credited).
  settledEntryId?: string
  // Set by the administrator once the commodity is received/settled. A delivered
  // deal is finalized and can no longer be revoked by the client.
  delivered?: boolean
  deliveredAt?: string

  // --- Post-approval negotiation / amendment ------------------------------
  /** Negotiation log shared between the client and admin (audit trail). */
  negotiationNotes?: DealNegotiationNote[]
  /** Free-form record of the counterparty's latest position / agreement. */
  counterpartyPosition?: string
  /** The amendment awaiting admin approval, if any (only one open at a time). */
  pendingAmendment?: DealAmendment
  /** Past amendments (approved/rejected) for the audit trail. */
  amendmentHistory?: DealAmendment[]

  /** Active suspend/freeze hold placed by the client or admin, if any. */
  hold?: DealHold | null

  // --- Admin-shared (read-only) deals -------------------------------------
  /** True when this deal is a read-only copy an admin shared for visibility. */
  readOnly?: boolean
  /** Alias kept alongside `readOnly` for the shared marker. */
  shared?: boolean
  /** Who shared it (e.g. "MCC Capital"), shown on the read-only card. */
  sharedFromName?: string
}

/**
 * Build a CommodityDeal from a server approval record. The complete deal —
 * including its documents, stage and the admin "delivered" flag — lives under
 * `payload.record`, so it is identical on every device. The DB lifecycle decides
 * pending/approved/rejected/cancelled; an approved deal is shown at the execution
 * stage to match the in-app approval behaviour. `delivered`/`deliveredAt` are
 * read from the top-level payload (set by the admin) when present.
 */
function dealFromApproval(rec: ApprovalRecord): CommodityDeal | null {
  const base = rec.payload?.record as CommodityDeal | undefined
  if (!base || typeof base !== "object" || !base.id) return null
  const status = mapApprovalStatus(rec.status) as DealStatus
  const delivered = (rec.payload?.delivered as boolean | undefined) ?? base.delivered
  // A copy an administrator shared with this user for visibility only. It is
  // rendered read-only and excluded from the owner's counts/uploads/actions.
  const sharedReadOnly = (rec.payload?.sharedReadOnly as boolean | undefined) === true
  const sharedFromName =
    (rec.payload?.sharedFromName as string | undefined) ?? base.sharedFromName
  return {
    ...base,
    approvalId: rec.id,
    status,
    stage: status === "approved" ? "execution" : base.stage,
    delivered,
    deliveredAt: (rec.payload?.deliveredAt as string | undefined) ?? base.deliveredAt,
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
    readOnly: sharedReadOnly || base.readOnly,
    shared: sharedReadOnly || base.shared,
    sharedFromName,
  }
}

// Document type catalogues surfaced in the UI (extensible — "not limited to").
export const POP_DOC_TYPES = [
  "Certificate of Origin",
  "Product Availability Statement",
  "Refinery Allocation Letter",
  "Tank Storage Receipt (TSR)",
  "SGS Inspection Report",
  "Export License",
  "Warehouse Receipt",
  "Bill of Lading",
  "Authority to Sell (ATS)",
]

export const POF_DOC_TYPES = [
  "Bank Comfort Letter (BCL)",
  "Ready, Willing and Able (RWA) Letter",
  "Bank-issued Proof of Funds Letter",
  "Recent Bank Statement",
  "MT799 Pre-Advice",
  "Confirmation of Available Credit Line",
  "Irrevocable Documentary Letter of Credit (DLC)",
  "Standby Letter of Credit (SBLC)",
]

interface CommodityDealsContextValue {
  deals: CommodityDeal[]
  /** Create a new pending deal (nothing executes yet). Returns the stored record. */
  addDeal: (
    deal: Omit<
      CommodityDeal,
      "id" | "uetr" | "status" | "stage" | "documents" | "submittedAt" | "decidedAt" | "decisionNote"
    > & { stage?: DealStage },
  ) => CommodityDeal
  /** Attach a new document record (version 1) to a deal. */
  addDocument: (
    dealId: string,
    doc: { module: DocModule; docType: string; swiftRef?: string } & Omit<
      DealDocumentVersion,
      "version" | "uploadedAt"
    >,
  ) => CommodityDeal | null
  /** Append a new version to an existing document (resets it to "submitted"). */
  addDocumentVersion: (
    dealId: string,
    docId: string,
    version: Omit<DealDocumentVersion, "version" | "uploadedAt">,
  ) => CommodityDeal | null
  /** Client-side stage advance (cannot set "execution" — admin only). */
  setStage: (dealId: string, stage: DealStage) => CommodityDeal | null
  /** Admin: mark a document verified. */
  verifyDocument: (dealId: string, docId: string) => CommodityDeal | null
  /** Admin: reject a document with an optional reason. */
  rejectDocument: (dealId: string, docId: string, reason?: string) => CommodityDeal | null
  /** Admin: approve the deal — advances it to the execution stage. */
  approveDeal: (dealId: string, note?: string, settledEntryId?: string) => CommodityDeal | null
  /** Admin: reject the deal with an optional reason. Nothing executes. */
  rejectDeal: (dealId: string, reason?: string) => CommodityDeal | null
  /**
   * Client: revoke an approved (not-yet-delivered) deal. Releases the reserved
   * funds back to the available balance server-side, marks the local deal
   * cancelled, and refreshes the ledger. Rejected by the server once the deal
   * has been flagged delivered by the administrator.
   */
  revokeDeal: (dealId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Client: propose an amendment to an approved (not-yet-delivered) deal's
   * commercial terms (price / quantity / incoterms). Files a
   * `commodity_amendment` approval for the admin to sign off; terms only change
   * once approved. Rejected by the server if the deal is delivered or already
   * has an open amendment.
   */
  requestAmendment: (
    dealId: string,
    proposed: DealTerms,
    reason: string,
  ) => Promise<{ ok: boolean; error?: string }>
  /** Client/admin: append a note to a deal's negotiation log. */
  addNegotiationNote: (
    dealId: string,
    message: string,
    counterpartyPosition?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Client: suspend (pause) / freeze (lock) / resume one of their own deals.
   * Pass `null` to lift an existing hold. Refreshes so the badge and disabled
   * states update immediately.
   */
  setDealHold: (
    dealId: string,
    hold: DealHoldState | null,
    note?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Client: directly edit the commercial terms of one of their own
   * NON-approved deals (pending / rejected / cancelled). Approved deals hold
   * reserved funds and must instead go through `requestAmendment`.
   */
  editDealTerms: (
    dealId: string,
    patch: EditableDealTerms,
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Client: permanently delete one of their own deals, releasing any reserved
   * funds. Removes it from the local list and refreshes the ledger on success.
   */
  deleteDeal: (dealId: string) => Promise<{ ok: boolean; error?: string }>
  hydrated: boolean
}

const CommodityDealsContext = createContext<CommodityDealsContextValue | null>(null)

function generateDealId(): string {
  return `DEAL-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
}

function generateDocId(): string {
  return `DOC-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
}

export function CommodityDealsProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon). The mapper rebuilds each deal
  // (documents, stage, delivered flag and lifecycle) from the server record, so
  // deals are identical on any device/browser. No localStorage involved.
  const {
    records: deals,
    setRecords: setDeals,
    hydrated,
    refresh,
  } = useServerRequestList<CommodityDeal>("commodity", { fromApproval: dealFromApproval })

  const { refresh: refreshLedger } = useLedger()

  // Whenever the server list changes (admin approval/delivery/revocation picked
  // up on the next poll/focus), pull the ledger so reserved/released holds are
  // reflected in the balance overview without a manual reload.
  useEffect(() => {
    if (!hydrated) return
    refreshLedger()
  }, [deals, hydrated, refreshLedger])

  /**
   * Persist a client-managed change to a deal's server record (documents, stage)
   * so it follows the user across devices and the admin sees the latest state.
   */
  const persistDeal = (deal: CommodityDeal | null) => {
    // A read-only copy shared with this user must never be written back — the
    // server would refuse anyway, but we short-circuit to avoid a wasted call
    // and any local state drift.
    if (deal?.readOnly || deal?.shared) return
    if (deal?.approvalId) {
      void updateMyApprovalRecord(deal.approvalId, { ...deal }).then(() => void refresh())
    }
  }

  const addDeal: CommodityDealsContextValue["addDeal"] = (deal) => {
    const { stage, ...rest } = deal
    const full: CommodityDeal = {
      ...rest,
      id: generateDealId(),
      uetr: generateUetr(),
      stage: stage && stage !== "execution" ? stage : "icpo",
      status: "pending",
      documents: [],
      submittedAt: new Date().toISOString(),
    }
    setDeals([full, ...deals])
    // Mirror into the DB so the Administrator can review it cross-client; persist
    // the COMPLETE record under `payload.record` so the server rebuilds it anywhere.
    void mirrorSubmission({
      kind: "commodity",
      title: `${full.title} · ${full.commodity}`,
      summary: `${full.tradeStructure} ${full.commodity} ${full.quantity} — ${full.currency} ${full.approxValue.toLocaleString("en-US")} (${full.buyerName} ⇄ ${full.sellerName})`,
      amount: full.approxValue,
      currency: full.currency,
      // On approval, reserve (place a hold on) the deal value on the client's
      // balance — funds earmarked to settle the petroleum / supplier payment.
      ledgerEffect:
        full.approxValue > 0
          ? {
              direction: "debit",
              amount: full.approxValue,
              currency: full.currency,
              status: "hold",
              counterparty: full.sellerName || "Commodity supplier",
              reference: full.uetr || full.id,
              category: "Commodity Trade — Reserved Funds",
            }
          : null,
      payload: { localId: full.id, uetr: full.uetr, category: full.category, commodity: full.commodity, record: full },
    }).then(() => {
      void refresh()
    })
    return full
  }

  const addDocument: CommodityDealsContextValue["addDocument"] = (dealId, doc) => {
    // Guard: a suspended/frozen deal cannot take document uploads.
    if (deals.find((d) => d.id === dealId)?.hold) return null
    let updated: CommodityDeal | null = null
    const { module, docType, swiftRef, ...versionFields } = doc
    const newDoc: DealDocument = {
      id: generateDocId(),
      module,
      docType,
      swiftRef: swiftRef?.trim() || undefined,
      status: "submitted",
      currentVersion: 1,
      versions: [{ ...versionFields, version: 1, uploadedAt: new Date().toISOString() }],
    }
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id === dealId) {
          updated = { ...d, documents: [...d.documents, newDoc] }
          return updated
        }
        return d
      }),
    )
    persistDeal(updated)
    return updated
  }

  const addDocumentVersion: CommodityDealsContextValue["addDocumentVersion"] = (
    dealId,
    docId,
    version,
  ) => {
    // Guard: a suspended/frozen deal cannot take new document versions.
    if (deals.find((d) => d.id === dealId)?.hold) return null
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id !== dealId) return d
        const documents = d.documents.map((doc) => {
          if (doc.id !== docId) return doc
          const nextVersion = doc.currentVersion + 1
          return {
            ...doc,
            status: "submitted" as DocStatus,
            currentVersion: nextVersion,
            decidedAt: undefined,
            decisionNote: undefined,
            versions: [
              ...doc.versions,
              { ...version, version: nextVersion, uploadedAt: new Date().toISOString() },
            ],
          }
        })
        updated = { ...d, documents }
        return updated
      }),
    )
    persistDeal(updated)
    return updated
  }

  const setStage: CommodityDealsContextValue["setStage"] = (dealId, stage) => {
    // Guard: clients cannot self-advance to execution.
    if (stage === "execution") return null
    // Guard: a suspended/frozen deal's workflow is paused (server enforces too).
    if (deals.find((d) => d.id === dealId)?.hold) return null
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id === dealId && d.status === "pending") {
          updated = { ...d, stage }
          return updated
        }
        return d
      }),
    )
    persistDeal(updated)
    return updated
  }

  const verifyDocument: CommodityDealsContextValue["verifyDocument"] = (dealId, docId) => {
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id !== dealId) return d
        const documents = d.documents.map((doc) =>
          doc.id === docId
            ? { ...doc, status: "verified" as DocStatus, decidedAt: new Date().toISOString(), decisionNote: undefined }
            : doc,
        )
        updated = { ...d, documents }
        return updated
      }),
    )
    persistDeal(updated)
    return updated
  }

  const rejectDocument: CommodityDealsContextValue["rejectDocument"] = (dealId, docId, reason) => {
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id !== dealId) return d
        const documents = d.documents.map((doc) =>
          doc.id === docId
            ? {
                ...doc,
                status: "rejected" as DocStatus,
                decidedAt: new Date().toISOString(),
                decisionNote: reason?.trim() || undefined,
              }
            : doc,
        )
        updated = { ...d, documents }
        return updated
      }),
    )
    persistDeal(updated)
    return updated
  }

  const approveDeal: CommodityDealsContextValue["approveDeal"] = (dealId, note, settledEntryId) => {
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id === dealId && d.status === "pending") {
          updated = {
            ...d,
            status: "approved",
            stage: "execution",
            decidedAt: new Date().toISOString(),
            decisionNote: note?.trim() || undefined,
            settledEntryId: settledEntryId || undefined,
          }
          return updated
        }
        return d
      }),
    )
    return updated
  }

  const rejectDeal: CommodityDealsContextValue["rejectDeal"] = (dealId, reason) => {
    let updated: CommodityDeal | null = null
    setDeals((prev) =>
      prev.map((d) => {
        if (d.id === dealId && d.status === "pending") {
          updated = {
            ...d,
            status: "rejected",
            decidedAt: new Date().toISOString(),
            decisionNote: reason?.trim() || undefined,
          }
          return updated
        }
        return d
      }),
    )
    return updated
  }

  const revokeDeal: CommodityDealsContextValue["revokeDeal"] = async (dealId) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target) return { ok: false, error: "Deal not found." }
    if (target.status !== "approved") return { ok: false, error: "Only an approved deal can be revoked." }
    if (target.delivered) {
      return { ok: false, error: "This deal has been delivered and can no longer be revoked." }
    }
    if (!target.approvalId) {
      return { ok: false, error: "This deal cannot be revoked yet. Please try again shortly." }
    }

    const res = await revokeMyCommodityDeal(target.approvalId)
    if (!res.ok) return res

    // Mark the local deal cancelled and pull the server ledger so the released
    // (unfrozen) funds reappear in the available balance right away.
    setDeals((prev) =>
      prev.map((d) =>
        d.id === dealId
          ? { ...d, status: "cancelled" as DealStatus, decidedAt: new Date().toISOString() }
          : d,
      ),
    )
    refreshLedger()
    return { ok: true }
  }

  const requestAmendment: CommodityDealsContextValue["requestAmendment"] = async (dealId, proposed, reason) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target) return { ok: false, error: "Deal not found." }
    if (target.status !== "approved") return { ok: false, error: "Only an approved deal can be amended." }
    if (target.delivered) {
      return { ok: false, error: "This deal has been delivered and can no longer be amended." }
    }
    if (target.pendingAmendment?.status === "pending") {
      return { ok: false, error: "An amendment is already pending approval for this deal." }
    }
    if (!target.approvalId) {
      return { ok: false, error: "This deal cannot be amended yet. Please try again shortly." }
    }

    const res = await requestDealAmendment(target.approvalId, proposed, reason)
    if (!res.ok) return res
    // The server stamped the deal record with the pending amendment; refresh so
    // the diff/badge appears for the client right away.
    await refresh()
    return { ok: true }
  }

  const addNegotiationNote: CommodityDealsContextValue["addNegotiationNote"] = async (
    dealId,
    message,
    counterpartyPosition,
  ) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target?.approvalId) return { ok: false, error: "Deal not found." }
    const res = await addDealNegotiationNote(target.approvalId, message, counterpartyPosition)
    if (!res.ok) return res
    await refresh()
    return { ok: true }
  }

  const setDealHold: CommodityDealsContextValue["setDealHold"] = async (dealId, hold, note) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target?.approvalId) return { ok: false, error: "This deal cannot be updated yet. Please try again shortly." }
    if (target.readOnly || target.shared) return { ok: false, error: "This deal is read-only." }
    const res = await setMyCommodityDealHold(target.approvalId, hold, note)
    if (!res.ok) return res
    await refresh()
    return { ok: true }
  }

  const editDealTerms: CommodityDealsContextValue["editDealTerms"] = async (dealId, patch) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target?.approvalId) return { ok: false, error: "This deal cannot be edited yet. Please try again shortly." }
    if (target.readOnly || target.shared) return { ok: false, error: "This deal is read-only." }
    const res = await editMyCommodityDealTerms(target.approvalId, patch)
    if (!res.ok) return res
    await refresh()
    return { ok: true }
  }

  const deleteDeal: CommodityDealsContextValue["deleteDeal"] = async (dealId) => {
    const target = deals.find((d) => d.id === dealId)
    if (!target?.approvalId) return { ok: false, error: "This deal cannot be deleted yet. Please try again shortly." }
    if (target.readOnly || target.shared) return { ok: false, error: "This deal is read-only." }
    const res = await deleteMyCommodityDeal(target.approvalId)
    if (!res.ok) return res
    // Drop it from the local list right away, then pull the ledger so any
    // released reservation reappears in the available balance.
    setDeals((prev) => prev.filter((d) => d.id !== dealId))
    refreshLedger()
    return { ok: true }
  }

  return (
    <CommodityDealsContext.Provider
      value={{
        deals,
        addDeal,
        addDocument,
        addDocumentVersion,
        setStage,
        verifyDocument,
        rejectDocument,
        approveDeal,
        rejectDeal,
        revokeDeal,
        requestAmendment,
        addNegotiationNote,
        setDealHold,
        editDealTerms,
        deleteDeal,
        hydrated,
      }}
    >
      {children}
    </CommodityDealsContext.Provider>
  )
}

export function useCommodityDeals() {
  const ctx = useContext(CommodityDealsContext)
  if (!ctx) {
    throw new Error("useCommodityDeals must be used within a CommodityDealsProvider")
  }
  return ctx
}
