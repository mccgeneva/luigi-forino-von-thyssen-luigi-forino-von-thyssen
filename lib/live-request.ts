/**
 * Shared "is this request still LIVE?" predicate — the single source of truth for
 * every section tab-badge / summary count (PPP, Project Funding, Leverage, cards,
 * etc.).
 *
 * WHY THIS EXISTS: a recurring bug is that a section badge counts requests by
 * `status` alone, so a terminated item still inflates the count. Termination is
 * represented in the codebase in TWO different ways, and a status-only check
 * misses the second one:
 *
 *   1. A terminal STATUS value — e.g. `rejected`, `cancelled`, `closed`.
 *   2. A terminal MARKER field on a record whose status is still `approved` —
 *      e.g. Project Funding closure sets `closedAt`/`settlement` but keeps
 *      `status: "approved"`; PPP early termination sets `cancelledAt`; treasury
 *      settlement sets `settledAt`. These are "approved but finished" records.
 *
 * `isLiveRequest` returns false for BOTH cases, so counting live items is simply
 * `records.filter(isLiveRequest).length` everywhere. Use it for badges/summary
 * counts; the full list can still render terminal items as history.
 */

/** Status strings that mean a request has reached a terminal (non-live) state. */
const TERMINAL_STATUSES = new Set([
  "rejected",
  "declined",
  "cancelled",
  "canceled",
  "terminated",
  "withdrawn",
  "closed",
  "expired",
  "reversed",
  "settled",
  "completed", // a fully-completed one-off request is no longer an open item
])

/**
 * Marker fields that, when present (truthy) on a record, mean it has been
 * closed/terminated/settled even though its `status` may still read "approved".
 * Keep this list in sync when a new "finish an approved facility" flow is added.
 */
const TERMINAL_MARKERS = [
  "cancelledAt",
  "canceledAt",
  "closedAt",
  "terminatedAt",
  "settledAt",
  "withdrawnAt",
  "reversedAt",
  "exitedAt",
] as const

/** A minimal shape any section request satisfies. Only `status` is required to be
 *  the right type; marker fields are read via a safe cast so the concrete request
 *  types (PPPRequest / ProjectFundingRequest / LeverageRequest / …) all pass
 *  without needing an index signature. */
export type LiveRequestLike = { status?: string | null }

/**
 * True when the request is still active (pending review or an approved facility
 * that has NOT been closed/terminated/settled). Terminal by status OR by marker
 * field both return false.
 */
export function isLiveRequest(record: LiveRequestLike | null | undefined): boolean {
  if (!record) return false
  const rec = record as Record<string, unknown>
  const status = typeof rec.status === "string" ? (rec.status as string).toLowerCase() : ""
  if (status && TERMINAL_STATUSES.has(status)) return false
  for (const marker of TERMINAL_MARKERS) {
    if (rec[marker]) return false
  }
  return true
}

/** Convenience: number of live requests in a list (for tab badges / summaries). */
export function countLiveRequests<T extends LiveRequestLike>(records: readonly T[] | null | undefined): number {
  if (!records) return 0
  let n = 0
  for (const r of records) if (isLiveRequest(r)) n++
  return n
}
