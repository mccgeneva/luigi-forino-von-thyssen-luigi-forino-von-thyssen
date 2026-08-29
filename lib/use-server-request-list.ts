"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  hydrateListFromDb,
  recordFromApproval,
  type ApprovalRecord,
  type Reconcilable,
} from "@/lib/approval-sync"
import type { ApprovalKind } from "@/lib/approval-kinds"

export interface ServerRequestListOptions<T> {
  /** Local status a DB "approved" maps to (default "approved"). */
  approvedStatus?: string
  /** Local status a DB "rejected" maps to (default "rejected"). */
  rejectedStatus?: string
  /** Local status a DB "pending" maps to (default "pending"). */
  pendingStatus?: string
  /** Local status a DB "cancelled" maps to (default "cancelled"). */
  cancelledStatus?: string
  /**
   * Custom record builder. Defaults to `recordFromApproval`, which rebuilds the
   * store's view-model from `payload.record`. Override for stores that merge in
   * extra server sources (e.g. admin-issued instruments) or need bespoke mapping.
   */
  fromApproval?: (rec: ApprovalRecord) => T | null
}

/**
 * The single, uniform lifecycle for every DB-backed request list.
 *
 * The server (Neon `approval_requests`) is the source of truth: the list is
 * fetched from `GET /api/approvals?kind=K` on mount, re-fetched on window focus,
 * and polled every 30s so administrator decisions / resets / cross-device
 * submissions are always reflected. NOTHING is read from or written to
 * `localStorage` — a user's requests follow them across any device or browser.
 *
 * Reads go through a Route Handler (not a Server Action), so they are never
 * serialized with client navigations and can never freeze the UI.
 */
export function useServerRequestList<T extends Reconcilable & { id: string }>(
  kind: ApprovalKind,
  options?: ServerRequestListOptions<T>,
) {
  const [records, setRecords] = useState<T[]>([])
  const [hydrated, setHydrated] = useState(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const mapper = useCallback((rec: ApprovalRecord): T | null => {
    const opts = optionsRef.current
    if (opts?.fromApproval) return opts.fromApproval(rec)
    return recordFromApproval<T>(rec, opts)
  }, [])

  const refresh = useCallback(async (): Promise<T[] | null> => {
    const list = await hydrateListFromDb<T>(kind, mapper)
    if (list) setRecords(list)
    return list
  }, [kind, mapper])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await hydrateListFromDb<T>(kind, mapper)
      if (cancelled) return
      if (list) setRecords(list)
      setHydrated(true)
    })()
    // Poll every 12s (fast enough that an administrator's decision reflects
    // almost immediately) — reads go through a Route Handler so this never
    // blocks navigation. The real fix for "stayed out of sync for a long time"
    // is the resume triggers below: a backgrounded tab / installed PWA throttles
    // or pauses setInterval and often does NOT fire `focus` on return, so we ALSO
    // force-refresh on visibilitychange (tab re-shown) and pageshow (bfcache /
    // PWA resume). This makes the client re-sync the instant the user comes back.
    const id = setInterval(() => void refresh(), 12000)
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const onPageShow = () => void refresh()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onPageShow)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [kind, mapper, refresh])

  return { records, setRecords, hydrated, refresh }
}
