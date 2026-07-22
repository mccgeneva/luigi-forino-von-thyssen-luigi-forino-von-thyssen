"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import {
  buildCertificateRequest,
  type CertificateRequest,
  type NewCertificateInput,
} from "@/lib/certificates-shared"
import { syncMyCertificateRequests, deleteMyCertificateRequest } from "@/app/actions/certificates"

// Read through the GET Route Handler (`/api/certificates`), NOT the
// `getMyCertificateRequests` Server Action: Server Actions are serialized with
// client navigations and would freeze the dashboard's first navigation when ~20
// providers all read on login. A route-handler fetch stays off that queue. The
// write path (`syncMyCertificateRequests`) stays a Server Action — it only fires
// on a deliberate user change, never during the login mount storm.
async function fetchCertificateRequests(): Promise<CertificateRequest[] | null> {
  try {
    const res = await fetch("/api/certificates", { cache: "no-store" })
    if (!res.ok) return null
    const json = (await res.json()) as { ok: boolean; requests?: CertificateRequest[] }
    return json.ok && Array.isArray(json.requests) ? json.requests : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Official bank certificates store (client provider).
//
// Clients REQUEST one of four official certificates; an administrator
// (Compliance desk) must APPROVE a request before the certificate can be
// issued/downloaded.
//
// Persistence is server-only: the single source of truth is Neon
// (lib/certificates-db.ts via app/actions/certificates.ts), so an administrator
// can see and decide on a client's requests from ANY device, and a client's
// requests follow them across any device/browser. Nothing is read from or
// written to localStorage — the list is fetched on mount, re-fetched on focus,
// and polled so administrator decisions appear without a manual reload.
// ---------------------------------------------------------------------------

// Re-export the pure logic so existing imports from "@/lib/certificates-store"
// keep working unchanged.
export * from "@/lib/certificates-shared"

interface CertificatesContextValue {
  requests: CertificateRequest[]
  hydrated: boolean
  /** Client submits a new certificate request (status pending). Returns the record. */
  addRequest: (input: NewCertificateInput) => CertificateRequest
  /** Append a "Downloaded" audit event when an approved certificate is generated. */
  recordDownload: (id: string) => void
  /** Permanently delete one of the user's own certificates. Resolves to true on success. */
  deleteRequest: (id: string) => Promise<boolean>
  /** Force a re-read from the durable server copy (e.g. after returning to the tab). */
  refresh: () => void
}

const CertificatesContext = createContext<CertificatesContextValue | null>(null)

export function CertificateRequestsProvider({ children }: { children: React.ReactNode }) {
  const [requests, setRequests] = useState<CertificateRequest[]>([])
  const [hydrated, setHydrated] = useState(false)
  // Skip the very first mirror that the hydration setState would trigger, so we
  // never echo freshly-loaded server data straight back to the server.
  const skipNextSync = useRef(true)

  const loadFromServer = () => {
    void fetchCertificateRequests().then((requests) => {
      if (requests) {
        skipNextSync.current = true
        setRequests(requests)
      }
    })
  }

  // Hydrate from the server (single source of truth) on mount.
  useEffect(() => {
    fetchCertificateRequests()
      .then((requests) => {
        if (requests) {
          skipNextSync.current = true
          setRequests(requests)
        }
      })
      .finally(() => setHydrated(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist on change: mirror to the server (durable). The server merge
  // preserves administrator-owned lifecycle fields. The first write after a
  // server-driven setRequests is skipped so we never echo fetched data back.
  useEffect(() => {
    if (!hydrated) return
    if (skipNextSync.current) {
      skipNextSync.current = false
      return
    }
    void syncMyCertificateRequests(
      requests.map((r) => ({ id: r.id, data: r as unknown as Record<string, unknown>, status: r.status })),
    ).catch(() => {})
  }, [requests, hydrated])

  // Re-fetch from the server when the client returns to the tab and on a 30s
  // poll, so a freshly approved/declined certificate appears without a reload.
  useEffect(() => {
    if (!hydrated) return
    const onFocus = () => loadFromServer()
    const onVisible = () => {
      if (document.visibilityState === "visible") loadFromServer()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const id = setInterval(loadFromServer, 30000)
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  const addRequest: CertificatesContextValue["addRequest"] = (input) => {
    const full = buildCertificateRequest(input)
    setRequests((prev) => [full, ...prev])
    return full
  }

  const recordDownload: CertificatesContextValue["recordDownload"] = (id) => {
    const now = new Date().toISOString()
    setRequests((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, events: [{ at: now, action: "Downloaded", actor: "Client" }, ...r.events] }
          : r,
      ),
    )
  }

  // Delete goes through a DEDICATED server action, not the mirror sync (whose
  // merge intentionally never deletes so a stale client payload can't wipe an
  // administrator's records). We optimistically drop the row locally, then ask
  // the server to remove it; on failure we re-read to restore the true state.
  const deleteRequest: CertificatesContextValue["deleteRequest"] = async (id) => {
    const prev = requests
    skipNextSync.current = true
    setRequests((list) => list.filter((r) => r.id !== id))
    const res = await deleteMyCertificateRequest(id).catch(() => ({ ok: false as const, error: "network" }))
    if (!res.ok) {
      setRequests(prev)
      return false
    }
    return true
  }

  return (
    <CertificatesContext.Provider
      value={{ requests, hydrated, addRequest, recordDownload, deleteRequest, refresh: loadFromServer }}
    >
      {children}
    </CertificatesContext.Provider>
  )
}

export function useCertificateRequests() {
  const ctx = useContext(CertificatesContext)
  if (!ctx) {
    throw new Error("useCertificateRequests must be used within a CertificateRequestsProvider")
  }
  return ctx
}
