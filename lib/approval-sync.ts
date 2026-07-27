"use client"

import type { ApprovalKind } from "@/lib/approval-kinds"
import type { LedgerEffect } from "@/lib/approvals-db"

/**
 * Shared client-side bridge between the legacy per-user request stores
 * (localStorage) and the DB-backed approvals backbone.
 *
 * Why this exists: the request stores were per-browser, so the administrator
 * could never see another client's pending requests. Rather than rewrite every
 * store and page at once, each store now MIRRORS its submissions into the
 * `approval_requests` table (so the admin sees them cross-client and decides
 * there) and RECONCILES admin decisions back into its local records (so the
 * client sees the approve/reject outcome). The DB is the source of truth for
 * the decision; the local store remains the client's fast read model.
 */

export interface MirrorInput {
  kind: ApprovalKind
  title: string
  summary: string
  amount?: number | null
  currency?: string | null
  payload?: Record<string, unknown>
  ledgerEffect?: LedgerEffect | null
}

/**
 * Mirror a freshly-submitted local request into the DB. Fire-and-forget from
 * the caller's perspective: returns the new approval id (to store on the local
 * record for later reconciliation) or null if the DB write didn't happen
 * (e.g. no DB configured). Never throws.
 */
export async function mirrorSubmission(input: MirrorInput): Promise<string | null> {
  const res = await mirrorSubmissionDetailed(input)
  return res.ok && res.id ? res.id : null
}

/** The outcome of a mirror, carrying any server-side rejection reason so the
 *  caller can surface it (e.g. a duplicate-monetization guard rejection). */
export interface MirrorResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * Like {@link mirrorSubmission} but returns the full result, including a
 * server-side rejection reason. Use this when the submission can be REFUSED by
 * the server (e.g. the monetization duplicate guard) and the client needs to
 * show the reason and roll back its optimistic entry.
 */
export async function mirrorSubmissionDetailed(input: MirrorInput): Promise<MirrorResult> {
  try {
    // POST to a Route Handler instead of invoking the Server Action directly.
    // Server Actions are serialized with client navigations by Next.js, so a
    // slow/unreachable DB on submit would freeze navigation until a hard
    // refresh. A plain fetch has no such coupling.
    const res = await fetch("/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { ok: false, error: "Your request could not be submitted. Please try again." }
    const data = (await res.json()) as { ok: boolean; request?: { id: string }; error?: string }
    if (data.ok && data.request) return { ok: true, id: data.request.id }
    return { ok: false, error: data.error || "Your request could not be submitted. Please try again." }
  } catch {
    return { ok: false, error: "Your request could not be submitted. Please try again." }
  }
}

/**
 * The shape of a single approval record as returned by `GET /api/approvals`.
 * This is the full DB record (see `ApprovalRequest` in `lib/approvals-db.ts`):
 * the complete view-model each store needs lives in `payload`, with the
 * authoritative lifecycle in `status` / `decidedAt` / `decisionNote`.
 */
export interface ApprovalRecord {
  id: string
  kind: ApprovalKind
  status: string
  title: string
  summary: string
  amount: number | null
  currency: string | null
  payload: Record<string, unknown>
  decisionNote: string | null
  decidedAt: string | null
  createdAt: string
  requiresMasterApproval?: boolean
  masterDecision?: string | null
  adminDecision?: string | null
}

/**
 * Hydrate a store's ENTIRE list from the server (the single source of truth).
 * Fetches the signed-in user's approvals for `kind`, maps each DB record into
 * the store's view-model via `fromApproval`, and returns them newest-first.
 *
 * This replaces per-browser `localStorage` hydration: because the list is
 * rebuilt from Neon on every load, a user's requests follow them across any
 * device or browser, and an admin decision / reset is always reflected.
 * Never throws — returns `null` on failure so the caller can decide how to
 * surface a transient fetch error (typically: keep showing nothing / retry).
 */
export async function hydrateListFromDb<T>(
  kind: ApprovalKind,
  fromApproval: (record: ApprovalRecord) => T | null,
): Promise<T[] | null> {
  try {
    const res = await fetch(`/api/approvals?kind=${encodeURIComponent(kind)}`, { cache: "no-store" })
    if (!res.ok) return null
    const data = (await res.json()) as { ok: boolean; items?: ApprovalRecord[] }
    if (!data.ok || !Array.isArray(data.items)) return null
    const mapped: T[] = []
    for (const rec of data.items) {
      const vm = fromApproval(rec)
      if (vm) mapped.push(vm)
    }
    return mapped
  } catch {
    return null
  }
}

/**
 * Map a DB approval lifecycle status onto a store's own status vocabulary.
 * `pending`/`approved`/`rejected`/`cancelled` cover every store; pass overrides
 * for stores that rename them (e.g. instruments call approved "active").
 */
export function mapApprovalStatus(
  dbStatus: string,
  options?: { approvedStatus?: string; rejectedStatus?: string; pendingStatus?: string; cancelledStatus?: string },
): string {
  switch (dbStatus) {
    case "approved":
      return options?.approvedStatus ?? "approved"
    case "rejected":
      return options?.rejectedStatus ?? "rejected"
    case "cancelled":
      return options?.cancelledStatus ?? "cancelled"
    default:
      return options?.pendingStatus ?? "pending"
  }
}

/**
 * Rebuild a store's view-model from an approval record, given that the store
 * wrote its COMPLETE record into `payload.record` on submit (the convention
 * used across all migrated stores). The DB lifecycle fields always win, so an
 * admin decision / cancellation is reflected no matter which device made it.
 */
export function recordFromApproval<T extends Reconcilable & { id: string }>(
  rec: ApprovalRecord,
  options?: { approvedStatus?: string; rejectedStatus?: string; pendingStatus?: string; cancelledStatus?: string },
): T | null {
  const base = rec.payload?.record as T | undefined
  if (!base || typeof base !== "object") return null
  return {
    ...base,
    approvalId: rec.id,
    status: mapApprovalStatus(rec.status, options),
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
  }
}

/** A local record that has been mirrored carries the DB approval id + status. */
export interface Reconcilable {
  approvalId?: string
  status: string
  decidedAt?: string
  decisionNote?: string
}

export interface ReconcileResult<T> {
  records: T[]
  /** True if any record's decision changed (caller should persist). */
  changed: boolean
  /** Records that flipped pending → approved (caller may apply side effects). */
  newlyApproved: T[]
}

export interface ReconcileOptions {
  /** Local status value a DB approval maps to. Defaults to "approved". */
  approvedStatus?: string
  /** Local status value a DB rejection maps to. Defaults to "rejected". */
  rejectedStatus?: string
  /** Local status value(s) considered "still awaiting a decision". Defaults to ["pending"]. */
  pendingStatuses?: string[]
}

/**
 * Pull the signed-in user's decisions for `kind` from the DB and merge them
 * into the local records by approval id. By default maps DB status → store
 * status: approved → "approved", rejected → "rejected"; pass `options` to map
 * onto a store's own vocabulary (e.g. instruments use "active" for approved).
 * Returns updated records plus which ones newly became approved so the caller
 * can apply local side effects (e.g. a ledger debit) exactly once.
 */
export async function reconcileFromDb<T extends Reconcilable>(
  kind: ApprovalKind,
  records: T[],
  options?: ReconcileOptions,
): Promise<ReconcileResult<T>> {
  const approvedStatus = options?.approvedStatus ?? "approved"
  const rejectedStatus = options?.rejectedStatus ?? "rejected"
  const pendingStatuses = options?.pendingStatuses ?? ["pending"]
  let changed = false
  const newlyApproved: T[] = []
  try {
    // Read decisions via a Route Handler (see mirrorSubmission for why). This
    // poll runs in ~12 stores on an interval; if it were a Server Action a slow
    // DB read could block navigation each time it fired.
    const res = await fetch(`/api/approvals?kind=${encodeURIComponent(kind)}`)
    if (!res.ok) return { records, changed, newlyApproved }
    const data = (await res.json()) as {
      ok: boolean
      items: { id: string; status: string; decidedAt?: string; decisionNote?: string }[]
    }
    const remote = data.items ?? []
    if (!remote.length) return { records, changed, newlyApproved }
    const byId = new Map(remote.map((r) => [r.id, r]))
    const next = records.map((rec) => {
      if (!rec.approvalId || !pendingStatuses.includes(rec.status)) return rec
      const match = byId.get(rec.approvalId)
      if (!match || match.status === "pending") return rec
      if (match.status === "approved") {
        changed = true
        const updated = {
          ...rec,
          status: approvedStatus,
          decidedAt: match.decidedAt ?? new Date().toISOString(),
        }
        newlyApproved.push(updated)
        return updated
      }
      if (match.status === "rejected") {
        changed = true
        return {
          ...rec,
          status: rejectedStatus,
          decidedAt: match.decidedAt ?? new Date().toISOString(),
          decisionNote: match.decisionNote ?? rec.decisionNote,
        }
      }
      return rec
    })
    return { records: next, changed, newlyApproved }
  } catch {
    return { records, changed, newlyApproved }
  }
}
