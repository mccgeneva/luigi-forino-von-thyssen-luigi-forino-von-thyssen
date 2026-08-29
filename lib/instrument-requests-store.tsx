"use client"

import { createContext, useContext } from "react"
import { buildInstrumentIdentifiers } from "@/lib/instrument-identifiers"
import { mirrorSubmission, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { cancelMyApproval, transferMyInstrument, deleteMyInstrument } from "@/app/actions/approvals"
import { releaseInstrumentByIsin } from "@/app/actions/marketplace-instruments"
import { type InstrumentUpgrade, upgradeBlocksInstrument } from "@/lib/instrument-upgrade"
import { type InstrumentAudit, isAuditPublished } from "@/lib/instrument-audit"

/**
 * Ensure an instrument carries the full identifier set. Records created before
 * identifiers existed (or seeded demo data) are enriched once on load so every
 * instrument — old or new — exposes a valid ISIN, Common Code, serial, issuing
 * BIC and governing rules.
 */
function ensureIdentifiers(inst: Instrument): Instrument {
  if (inst.isin) return inst
  const ids = buildInstrumentIdentifiers(inst.issuer, inst.type, new Date(inst.issuedDate || Date.now()))
  return { ...inst, ...ids }
}

export type InstrumentStatus = "pending" | "active" | "rejected" | "cancelled" | "expired" | "transferred"

export interface Instrument {
  id: string
  /** DB approval id once mirrored, so admin decisions can be reconciled back. */
  approvalId?: string
  type: string
  typeFull: string
  issuer: string
  faceValue: number
  currency: string
  status: InstrumentStatus
  issuedDate: string
  expiryDate: string
  daysRemaining: number
  rating: string
  purpose: string
  assignable: boolean
  monetizable: boolean
  tradeType?: string
  /**
   * Structured acquisition action ("reserve" | "assign" | "lease" | "purchase").
   * Present on records created after the ownership rule shipped; legacy records
   * are inferred from `tradeType` by `isMccHeldInstrument`.
   */
  acquisitionAction?: string
  /**
   * Beneficial owner. Reserve/Assign acquisitions remain owned by
   * "MCC HOLDING SA" (client is the assignee, 25% benefit share). An outright
   * purchase is owned by the client. Undefined on legacy records → inferred.
   */
  owner?: string
  submittedAt?: string // ISO timestamp of the client request
  decidedAt?: string // ISO timestamp of approval/rejection
  decisionNote?: string // administrator note (e.g. rejection reason)

  // ---- Securities / settlement identifiers (optional for legacy records) ----
  /** International Securities Identification Number (valid check digit). */
  isin?: string
  /** Euroclear / Clearstream 9-digit Common Code. */
  commonCode?: string
  /** US CUSIP, present only for US-domiciled issuers. */
  cusip?: string
  /** Unique instrument serial / SWIFT documentary reference. */
  serialNumber?: string
  /** Issuing bank SWIFT/BIC. */
  issuerBic?: string
  /** Issuing bank registered office address. */
  issuerAddress?: string
  /** Issuing bank country of incorporation. */
  issuerCountry?: string
  /** Place of issuance (city/country). */
  placeOfIssue?: string
  /** Governing rules (ISP98 / URDG 758 / English Law, etc.). */
  governingLaw?: string
  /** Delivery method (SWIFT MT760 / book-entry). */
  deliveryMethod?: string
  /** Instrument form (documentary, global note, etc.). */
  form?: string
  /**
   * True while an Administrator-initiated transformation/upgrade is in progress.
   * A blocked instrument cannot be monetized, leveraged, used to fund a yield,
   * transferred, returned or deleted until the upgrade completes or is declined.
   */
  blocked?: boolean
  /** The pending/decided transformation-upgrade deal, if any. */
  upgrade?: InstrumentUpgrade
  /**
   * Published independent audit & valuation report, if any. Only a PUBLISHED
   * audit is ever surfaced to the client (drafts / rejected audits are held
   * back server-side by the materializer).
   */
  audit?: InstrumentAudit
}

/**
 * Build an Instrument from a server approval record. Two payload shapes exist:
 *  - Client requests carry the full view-model under `payload.record`.
 *  - Administrator-ISSUED instruments carry it under `payload.instrument` with
 *    `issuedByAdmin: true` (the client cannot create these themselves).
 * Either way the DB lifecycle (`status`/`decidedAt`/`decisionNote`) wins, and
 * "approved" maps onto the instrument's "active" status.
 */
function instrumentFromApproval(rec: ApprovalRecord): Instrument | null {
  const p = rec.payload as
    | {
        record?: Instrument
        instrument?: Instrument
        issuedByAdmin?: boolean
        transferredTo?: string
        upgrade?: InstrumentUpgrade
        audit?: InstrumentAudit
      }
    | undefined
  const base = p?.issuedByAdmin ? p?.instrument : (p?.record ?? p?.instrument)
  if (!base || typeof base !== "object" || !base.id) return null
  // A cancelled record that was moved to another holder is surfaced as
  // "Transferred" (not a plain cancellation) so the sender sees what happened.
  let status = mapApprovalStatus(rec.status, { approvedStatus: "active" }) as InstrumentStatus
  if (status === "cancelled" && p?.transferredTo) status = "transferred"
  // An upgrade deal lives at the top level of the payload so it works
  // regardless of which base shape (record vs instrument) carries the VM.
  // Only the legacy fee-charged `proposed` flow blocks the old instrument;
  // a `negotiating` deal leaves it fully usable while the value is discussed.
  const upgrade = p?.upgrade
  // Only a PUBLISHED audit is exposed to the client; drafts and rejected audits
  // remain internal to the administrator.
  const audit = isAuditPublished(p?.audit) ? p?.audit : undefined
  return ensureIdentifiers({
    ...base,
    approvalId: rec.id,
    status,
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
    upgrade,
    audit,
    blocked: upgradeBlocksInstrument(upgrade) || base.blocked || undefined,
  })
}

/**
 * The non-refundable acquisition fee charged for leasing / assigning / buying
 * an instrument. Attached to the approval as a gated, settled DEBIT so that on
 * Administrator approval it is actually deducted from the client's balance (in
 * the instrument's own currency), funded via capped FX if needed, and the
 * approval auto-rejects if the fee cannot be covered.
 */
export interface AcquisitionFeeInput {
  /** Fee amount in the instrument's currency. */
  amount: number
  /** Human label of the action (e.g. "Lease", "Assign", "Purchase"). */
  actionLabel: string
}

interface InstrumentRequestsContextValue {
  instruments: Instrument[]
  /** Create a new pending instrument request awaiting Administrator approval. */
  addInstrument: (
    instrument: Omit<Instrument, "status" | "submittedAt" | "decidedAt" | "decisionNote">,
    fee?: AcquisitionFeeInput,
  ) => Instrument
  /** Approve a pending request — the instrument becomes active. */
  approveInstrument: (id: string) => Instrument | null
  /** Reject a pending request with an optional reason. */
  rejectInstrument: (id: string, reason?: string) => Instrument | null
  /** Client-side cancel (only meaningful for non-cancelled instruments). */
  cancelInstrument: (id: string) => void
  /** Permanently remove an instrument from the list. */
  deleteInstrument: (id: string) => void
  /**
   * Return an assigned/reserved instrument to the marketplace: it leaves the
   * holder's portfolio (server-side) AND its marketplace row is released
   * (available = true) so it reappears for everyone. Caller must ensure it is
   * not engaged in any monetization / leverage / yield scenario first.
   */
  returnInstrument: (id: string) => void
  /**
   * Transfer an ACTIVE instrument to another platform account (by email). The
   * instrument moves server-side immediately, then the local list reconciles:
   * it leaves the sender's active holdings (shown "Transferred") and appears in
   * the recipient's portfolio. Returns the outcome for the calling UI.
   */
  transferInstrument: (
    approvalId: string,
    recipientEmail: string,
  ) => Promise<{ ok: boolean; error?: string; recipientName?: string }>
  /** Re-fetch the authoritative portfolio from the server (e.g. after an upgrade). */
  refresh: () => Promise<Instrument[] | null>
  hydrated: boolean
}

const InstrumentRequestsContext = createContext<InstrumentRequestsContextValue | null>(null)

export function InstrumentRequestsProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon). The custom mapper folds in
  // BOTH client-submitted requests and administrator-issued instruments, so the
  // portfolio is identical on any device/browser. No localStorage involved.
  const {
    records: instruments,
    setRecords: setInstruments,
    hydrated,
    refresh,
  } = useServerRequestList<Instrument>("instrument", { fromApproval: instrumentFromApproval })

  const addInstrument: InstrumentRequestsContextValue["addInstrument"] = (instrument, fee) => {
    const full: Instrument = {
      ...instrument,
      status: "pending",
      submittedAt: new Date().toISOString(),
    }
    setInstruments([full, ...instruments])
    // A positive acquisition fee becomes a GATED, SETTLED debit on the approval:
    // on Administrator approval it is deducted from the client's balance in the
    // instrument's currency (FX-funded if needed) and the approval auto-rejects
    // if it cannot be covered. Admin-issued instruments never pass a fee here.
    const feeEffect =
      fee && Number.isFinite(fee.amount) && fee.amount > 0
        ? {
            direction: "debit" as const,
            amount: fee.amount,
            currency: full.currency,
            status: "completed" as const,
            gate: true,
            category: "Bank Instrument — Acquisition Fee",
            counterparty: `${fee.actionLabel} fee — ${full.issuer} ${full.type}`,
            reference: full.id,
          }
        : null
    // Mirror into the DB so the Administrator can review it cross-client; persist
    // the COMPLETE record under `payload.record` so the server rebuilds it anywhere.
    void mirrorSubmission({
      kind: "instrument",
      title: `${full.typeFull} · ${full.issuer}`,
      summary: `${full.currency} ${full.faceValue.toLocaleString("en-US")} ${full.typeFull} issued by ${full.issuer} (${full.purpose})`,
      amount: full.faceValue,
      currency: full.currency,
      payload: {
        localId: full.id,
        type: full.type,
        issuer: full.issuer,
        isin: full.isin,
        record: full,
        acquisitionFee: feeEffect ? { amount: feeEffect.amount, currency: feeEffect.currency, label: fee?.actionLabel } : null,
      },
      ledgerEffect: feeEffect,
    }).then(() => {
      void refresh()
    })
    return full
  }

  // Admin decisions flow through the DB and surface here via server hydration.
  // These local mutators update the in-memory view immediately for interface
  // compatibility; the next refresh reconciles against authoritative state.
  const approveInstrument: InstrumentRequestsContextValue["approveInstrument"] = (id) => {
    let updated: Instrument | null = null
    setInstruments(
      instruments.map((i) => {
        if (i.id === id && i.status === "pending") {
          updated = { ...i, status: "active", decidedAt: new Date().toISOString() }
          return updated
        }
        return i
      }),
    )
    return updated
  }

  const rejectInstrument: InstrumentRequestsContextValue["rejectInstrument"] = (id, reason) => {
    let updated: Instrument | null = null
    setInstruments(
      instruments.map((i) => {
        if (i.id === id && i.status === "pending") {
          updated = {
            ...i,
            status: "rejected",
            decidedAt: new Date().toISOString(),
            decisionNote: reason?.trim() || undefined,
          }
          return updated
        }
        return i
      }),
    )
    // Declined → release the held instrument back to the marketplace.
    const rejectedIsin = instruments.find((i) => i.id === id)?.isin
    if (rejectedIsin) void releaseInstrumentByIsin(rejectedIsin)
    return updated
  }

  const cancelInstrument: InstrumentRequestsContextValue["cancelInstrument"] = (id) => {
    const target = instruments.find((i) => i.id === id)
    setInstruments(instruments.map((i) => (i.id === id ? { ...i, status: "cancelled" } : i)))
    // Persist the cancellation server-side when the request is still pending, so
    // it stays cancelled on every device. Approved/active holdings cannot be
    // cancelled through the approvals API and remain a local view change only.
    if (target?.approvalId && target.status === "pending") {
      void cancelMyApproval(target.approvalId).then(() => void refresh())
    }
    // A cancelled pending request releases the held instrument. An approved/
    // active holding stays held (the client legitimately holds it).
    if (target?.isin && target.status === "pending") void releaseInstrumentByIsin(target.isin)
  }

  const deleteInstrument: InstrumentRequestsContextValue["deleteInstrument"] = (id) => {
    const target = instruments.find((i) => i.id === id)
    setInstruments(instruments.filter((i) => i.id !== id))
    // Persist the deletion server-side so it does not reappear on the next
    // hydrate. A still-pending request is cancelled (keeping the audit trail of
    // the decision), while a decided/active holding is permanently removed via
    // the owner-scoped delete. Both are keyed off the mirrored approval id.
    if (target?.approvalId) {
      const persist = target.status === "pending" ? cancelMyApproval : deleteMyInstrument
      void persist(target.approvalId).then(() => void refresh())
    }
    // Dropping a still-pending request releases the held instrument back to the
    // marketplace; an approved/active holding stays held.
    if (target?.isin && target.status === "pending") void releaseInstrumentByIsin(target.isin)
  }

  const returnInstrument: InstrumentRequestsContextValue["returnInstrument"] = (id) => {
    const target = instruments.find((i) => i.id === id)
    // Release the marketplace row first so the instrument becomes available to
    // everyone again (no-op if the ISIN was never a published marketplace row).
    if (target?.isin) void releaseInstrumentByIsin(target.isin)
    // Then remove it from the holder's portfolio and persist server-side. A
    // still-pending request is cancelled; an approved/active holding is deleted
    // via the owner-scoped delete — mirroring deleteInstrument's persistence.
    setInstruments(instruments.filter((i) => i.id !== id))
    if (target?.approvalId) {
      // Returning to the marketplace is NOT a "settle out" deletion, so the
      // 0.035% management fee is explicitly skipped here (unlike deleteInstrument).
      const persist =
        target.status === "pending"
          ? cancelMyApproval(target.approvalId)
          : deleteMyInstrument(target.approvalId, { chargeManagementFee: false })
      void persist.then(() => void refresh())
    }
  }

  const transferInstrument: InstrumentRequestsContextValue["transferInstrument"] = async (
    approvalId,
    recipientEmail,
  ) => {
    const res = await transferMyInstrument(approvalId, recipientEmail)
    if (!res.ok) return { ok: false, error: res.error }
    // Optimistically reflect the move locally (the sender's copy becomes
    // "Transferred"), then reconcile against authoritative server state.
    setInstruments(
      instruments.map((i) =>
        i.approvalId === approvalId
          ? { ...i, status: "transferred", decisionNote: `Transferred to ${res.recipientName}` }
          : i,
      ),
    )
    void refresh()
    return { ok: true, recipientName: res.recipientName }
  }

  return (
    <InstrumentRequestsContext.Provider
      value={{
        instruments,
        addInstrument,
        approveInstrument,
        rejectInstrument,
        cancelInstrument,
        deleteInstrument,
        returnInstrument,
        transferInstrument,
        refresh,
        hydrated,
      }}
    >
      {children}
    </InstrumentRequestsContext.Provider>
  )
}

export function useInstrumentRequests() {
  const ctx = useContext(InstrumentRequestsContext)
  if (!ctx) {
    throw new Error("useInstrumentRequests must be used within an InstrumentRequestsProvider")
  }
  return ctx
}

/**
 * Whether an instrument remains owned by MCC HOLDING SA (client is the assignee,
 * 75/25 benefit split applies to any investment return generated with it).
 * Prefers the structured fields; falls back to the legacy `tradeType` string for
 * records created before the ownership rule shipped. Reserve/assign → MCC-owned;
 * a purchase transfers full ownership to the client.
 */
export function isMccHeldInstrument(inst: Pick<Instrument, "owner" | "acquisitionAction" | "tradeType">): boolean {
  if (inst.owner) return inst.owner === "MCC HOLDING SA"
  if (inst.acquisitionAction) {
    return inst.acquisitionAction === "reserve" || inst.acquisitionAction === "assign"
  }
  const t = (inst.tradeType ?? "").toLowerCase()
  if (t.includes("purchase")) return false
  return t.includes("reserve") || t.includes("assign")
}
