"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import { getActiveUserId } from "@/lib/user-scope"
import { syncMyBeneficiaries } from "@/app/actions/beneficiaries"
import { DEMO_USER_ID } from "@/lib/users"
import { demoBeneficiaries } from "@/lib/demo-beneficiaries"
import { validateIban } from "@/lib/iban-swift"

export type BeneficiaryType = "individual" | "corporate" | "financial_institution"
export type BeneficiaryStatus = "active" | "pending" | "suspended" | "blocked" | "cancelled"

export interface Beneficiary {
  id: string
  type: BeneficiaryType
  name: string
  alias?: string
  accountNumber: string
  iban?: string
  swiftBic: string
  bankName: string
  bankAddress: string
  bankCountry: string
  beneficiaryAddress: string
  beneficiaryCity: string
  beneficiaryCountry: string
  beneficiaryPostalCode?: string
  currency: string
  status: BeneficiaryStatus
  isFavorite: boolean
  createdAt: string
  lastUsed?: string
  totalTransactions: number
  totalVolume: number
  notes?: string
  registrationNumber?: string
  vatNumber?: string
  dateOfBirth?: string
  nationality?: string
  kycVerified: boolean
  riskLevel: "low" | "medium" | "high"
  amlScreeningDate?: string
  correspondentBank?: string
  correspondentSwift?: string
  intermediaryBank?: string
  intermediarySwift?: string
}

interface BeneficiariesContextValue {
  beneficiaries: Beneficiary[]
  setBeneficiaries: React.Dispatch<React.SetStateAction<Beneficiary[]>>
  addBeneficiary: (beneficiary: Beneficiary) => void
}

const BeneficiariesContext = createContext<BeneficiariesContextValue | null>(null)

export function BeneficiariesProvider({ children }: { children: React.ReactNode }) {
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([])
  const [hydrated, setHydrated] = useState(false)
  // Skip the very first server-sync that the hydration setState would trigger,
  // so we never echo freshly-loaded data straight back to the server.
  const skipNextSync = useRef(true)
  // True while a local change is being mirrored to the server. The background
  // refetch (focus / visibility / 30s poll) must NOT apply server data while a
  // write is in flight, otherwise it can clobber a just-added beneficiary with a
  // stale server snapshot before the write lands — making the new record
  // "disappear" right after the user adds it.
  const pendingSync = useRef(false)
  // Guards the demo beneficiary-book backfill so it runs at most once per mount.
  const demoBackfillDone = useRef(false)

  // Load beneficiaries on mount from the server (Neon), the single source of
  // truth, so admins can manage beneficiaries on behalf of users and data
  // follows the user across any device/browser. Re-fetch on focus and on a 30s
  // poll so admin-side changes appear without a reload. Nothing is cached in
  // localStorage.
  useEffect(() => {
    let active = true

    // Read through the GET Route Handler (`/api/beneficiaries`), NOT the
    // `getMyBeneficiaries` Server Action: Server Actions are serialized with
    // client navigations and would freeze the dashboard's first navigation when
    // ~20 providers all read on login. A route-handler fetch stays off that
    // queue. The write path (`syncMyBeneficiaries`) stays a Server Action — it
    // only fires on a deliberate user change, never during the login mount storm.
    const load = async () => {
      // Don't overwrite local state while a local write is mirroring to the
      // server — a stale snapshot here would drop the in-flight change.
      if (pendingSync.current) return
      try {
        const res = await fetch("/api/beneficiaries", { cache: "no-store" })
        if (!active || !res.ok) return
        // Re-check after the await: a local edit may have started mid-flight.
        if (pendingSync.current) return
        const json = (await res.json()) as { ok: boolean; beneficiaries?: { data: unknown }[] }
        if (!active || pendingSync.current) return
        if (json.ok && Array.isArray(json.beneficiaries)) {
          skipNextSync.current = true
          setBeneficiaries(json.beneficiaries.map((b) => b.data as unknown as Beneficiary))
        }
      } catch {
        // keep whatever we already have on a transient failure
      }
    }

    load().finally(() => {
      if (active) setHydrated(true)
    })

    const onFocus = () => void load()
    const onVisible = () => {
      if (document.visibilityState === "visible") void load()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const id = setInterval(() => void load(), 30000)

    return () => {
      active = false
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(id)
    }
  }, [])

  // Persist on change: mirror to the server (durable), keeping the admin-visible
  // copy in sync. The first write after a server-driven setBeneficiaries is
  // skipped so we never echo freshly-fetched data straight back.
  //
  // CRITICAL: `syncMyBeneficiaries` RETURNS `{ ok: false }` on failure instead
  // of throwing, so a naive `.catch().finally(clear)` would treat a FAILED write
  // as done — clearing `pendingSync` and letting the next background `load()`
  // overwrite local state with a server set that never received the change. The
  // just-added beneficiary would then silently disappear. To prevent that we
  // keep `pendingSync` asserted (which blocks destructive refetches) until a
  // sync actually succeeds, retrying with backoff on failure.
  useEffect(() => {
    if (!hydrated) return
    if (skipNextSync.current) {
      skipNextSync.current = false
      return
    }

    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    pendingSync.current = true

    const payload = beneficiaries.map((b) => ({
      id: b.id,
      data: b as unknown as Record<string, unknown>,
      status: b.status,
    }))

    const attempt = async (tries: number) => {
      let ok = false
      try {
        const res = await syncMyBeneficiaries(payload)
        ok = res.ok
      } catch {
        ok = false
      }
      if (cancelled) return
      if (ok) {
        // Server now holds this exact set — safe to let refetches resume.
        pendingSync.current = false
        return
      }
      // Failed: keep pendingSync asserted so a refetch can't drop unsynced
      // local data, and retry with a capped backoff. If it never succeeds the
      // local copy is preserved (degraded but not lost).
      if (tries < 6) {
        retry = setTimeout(() => void attempt(tries + 1), Math.min(1000 * 2 ** tries, 15000))
      }
    }

    void attempt(0)

    // If beneficiaries change again mid-flight, cancel this attempt; the new
    // effect run will sync the latest set.
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }, [beneficiaries, hydrated])

  // One-time demo backfill + reconcile: after hydration, (1) merge any missing
  // counterparties from the canonical petroleum / trade / finance book and
  // (2) repair demo records whose persisted IBAN fails the ISO 7064 checksum
  // (the v1 backfill stored some with bad check digits). Runs against the
  // already-hydrated state (the durable server copy), then the persist effect
  // mirrors corrections back to Neon. Scoped to the demo user and guarded by a
  // per-session ref. It is idempotent — it only adds canonical rows missing from
  // the server copy — so re-running across reloads is a no-op and it never
  // re-adds rows the user has removed. No localStorage involved.
  useEffect(() => {
    if (!hydrated || demoBackfillDone.current) return
    demoBackfillDone.current = true
    if (getActiveUserId() !== DEMO_USER_ID) return

    const canonical = demoBeneficiaries()
    const canonicalById = new Map(canonical.map((b) => [b.id, b]))
    const existing = new Set(beneficiaries.map((b) => b.id))
    const missing = canonical.filter((b) => !existing.has(b.id))

    // Detect already-persisted demo records that hold an invalid IBAN so we can
    // overwrite just that field with the canonical, checksum-valid value.
    const needsIbanRepair = beneficiaries.some((b) => {
      const ref = canonicalById.get(b.id)
      return ref && b.iban && b.iban !== ref.iban && !validateIban(b.iban).valid
    })

    if (!missing.length && !needsIbanRepair) return

    setBeneficiaries((prev) => {
      // Repair invalid IBANs on existing demo records (leave all else untouched).
      const repaired = prev.map((b) => {
        const ref = canonicalById.get(b.id)
        if (ref && b.iban && b.iban !== ref.iban && !validateIban(b.iban).valid) {
          return { ...b, iban: ref.iban }
        }
        return b
      })
      const have = new Set(repaired.map((b) => b.id))
      return [...missing.filter((m) => !have.has(m.id)), ...repaired]
    })
  }, [hydrated, beneficiaries])

  const addBeneficiary = (beneficiary: Beneficiary) =>
    setBeneficiaries((prev) => [beneficiary, ...prev])

  return (
    <BeneficiariesContext.Provider value={{ beneficiaries, setBeneficiaries, addBeneficiary }}>
      {children}
    </BeneficiariesContext.Provider>
  )
}

export function useBeneficiaries() {
  const ctx = useContext(BeneficiariesContext)
  if (!ctx) {
    throw new Error("useBeneficiaries must be used within a BeneficiariesProvider")
  }
  return ctx
}
