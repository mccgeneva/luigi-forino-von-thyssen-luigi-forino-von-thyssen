"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { persistMyLedgerEntry } from "@/app/actions/ledger"
import { convertCurrency } from "@/lib/fx"

// Reads go through the GET Route Handler (`/api/ledger`), NOT the `getMyLedger`
// Server Action, because Server Actions are serialized with client navigations
// and would freeze the dashboard's first navigation when ~20 providers all read
// on login. The writes below (`persistMyLedgerEntry`) stay Server Actions: they
// only fire on a deliberate user action, never during the login mount storm.
async function fetchLedgerEntries(): Promise<LedgerEntry[] | null> {
  try {
    const res = await fetch("/api/ledger", { cache: "no-store" })
    if (!res.ok) return null
    const json = (await res.json()) as { ok: boolean; entries?: LedgerEntry[] }
    return json.ok && Array.isArray(json.entries) ? json.entries : null
  } catch {
    return null
  }
}

export type LedgerDirection = "credit" | "debit"
export type LedgerStatus = "completed" | "hold"

export interface LedgerEntry {
  id: string // receipt / reference number, e.g. "PPY3175227"
  direction: LedgerDirection
  amount: number // always positive; direction determines sign
  currency: string
  status: LedgerStatus
  date: string // ISO date
  counterparty: string // sender (for credits) or beneficiary (for debits)
  account?: string // counterparty account number
  bank?: string // counterparty bank
  /** The CLIENT's own receiving account (IBAN) this payment landed in, used to
   *  attribute incoming funds to a specific registered bank so the client can
   *  see a per-bank sub-balance. Distinct from `account` (the counterparty). */
  receivedAccount?: string
  reference?: string
  comment?: string
  category?: string
  /** Sub-account compartment this entry belongs to. Absent/empty ⇒ the user's
   *  MAIN account. Entries tagged with a sub-account id are isolated: they are
   *  excluded from the main balance and only counted for that sub-account. */
  subAccountId?: string
}

// Re-exported (imported at top) from the shared, server-safe FX module so
// existing imports from "@/lib/ledger-store" keep working while server actions
// can use the same rates.
export { convertCurrency }

interface LedgerContextValue {
  entries: LedgerEntry[]
  /** Record an incoming payment (credit). Persists to the server ledger and
   *  optimistically updates the live view. Returns the stored entry. */
  addReceipt: (entry: Omit<LedgerEntry, "direction">) => LedgerEntry
  /** Record an outgoing payment (debit). Persists to the server ledger and
   *  optimistically updates the live view. Returns the stored entry. */
  addDebit: (entry: Omit<LedgerEntry, "direction">) => LedgerEntry
  /** Net available balance for a currency: completed credits minus completed
   *  debits, minus any funds currently on hold (reserved). Reserved funds are
   *  not spendable, so they are excluded from the available balance. */
  balanceFor: (currency: string) => number
  /** Funds currently reserved/blocked (sum of held debits) for a currency. */
  reservedFor: (currency: string) => number
  /** Credited-but-LOCKED funds (sum of held CREDITS) for a currency — e.g. ROI
   *  from a leverage/debit-funded program that reflects on the account but is not
   *  yet withdrawable. Shown so the customer sees the credit even though it is
   *  excluded from the spendable balance. */
  lockedCreditsFor: (currency: string) => number
  /** Aggregated MAIN balance of every currency converted into the target currency. */
  totalIn: (currency: string) => number
  /** Net balance of a specific SUB-ACCOUNT compartment in a currency: settled
   *  credits − settled debits − held debits tagged with that sub-account id. */
  subAccountBalanceFor: (subAccountId: string, currency: string) => number
  /** All currencies that have at least one entry. */
  currencies: string[]
  /** Re-read the persisted ledger from storage (e.g. after an admin edit to the
   *  currently signed-in account) so the live view reflects the change. */
  refresh: () => void
  hydrated: boolean
}

const LedgerContext = createContext<LedgerContextValue | null>(null)

export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [hydrated, setHydrated] = useState(false)

  // Pull the ledger from the server (Neon) — the single source of truth where
  // every credit/debit (admin-posted, instant transfers, approved monetizations)
  // lives. Nothing is read from or written to localStorage, so balances are
  // identical on any device/browser. A fresh account with no rows reads 0.00.
  // Re-fetch on focus and on a 30s poll so admin activity appears without a reload.
  useEffect(() => {
    let cancelled = false

    // The route handler reconciles already-approved credits server-side before
    // returning, so a single GET covers both steps without an extra round trip.
    const load = async () => {
      const serverEntries = await fetchLedgerEntries()
      if (cancelled || !serverEntries) return
      const sorted = [...serverEntries].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      )
      setEntries(sorted)
    }

    load().finally(() => {
      if (!cancelled) setHydrated(true)
    })

    const onFocus = () => void load()
    const onVisible = () => {
      if (document.visibilityState === "visible") void load()
    }
    // pageshow covers bfcache restore + installed-PWA resume, where a
    // backgrounded interval is throttled and `focus` may never fire — so the
    // balance re-syncs the moment the user returns after an admin operation.
    const onPageShow = () => void load()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onPageShow)
    const id = setInterval(() => void load(), 12000)

    return () => {
      cancelled = true
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onPageShow)
      clearInterval(id)
    }
  }, [])

  // Record a new entry: optimistically prepend it to the live view, then persist
  // it to the durable server ledger so it survives reloads and appears on every
  // device. No localStorage is involved. Memoized with a stable identity (it only
  // uses the stable `setEntries` setter and a module-level action) so consumers
  // that depend on it in effects — notably FundingCapitalReconciler — do not
  // re-run on every provider render.
  const recordEntry = useCallback((entry: LedgerEntry) => {
    setEntries((prev) =>
      [entry, ...prev].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    )
    void persistMyLedgerEntry(entry).catch(() => {
      // best-effort; a failed persist still shows locally until the next refresh
    })
  }, [])

  const addReceipt = useCallback(
    (entry: Omit<LedgerEntry, "direction">) => {
      const full: LedgerEntry = { ...entry, direction: "credit" }
      recordEntry(full)
      return full
    },
    [recordEntry],
  )

  const addDebit = useCallback(
    (entry: Omit<LedgerEntry, "direction">) => {
      const full: LedgerEntry = { ...entry, direction: "debit" }
      recordEntry(full)
      return full
    },
    [recordEntry],
  )

  // Funds currently reserved/blocked: held debits (e.g. an approved commodity
  // deal earmarking funds to settle the supplier). Held credits are ignored —
  // incoming pending money is not yet available either way. Memoized on
  // `entries` so its identity is stable between data changes.
  const reservedFor = useCallback(
    (currency: string) =>
      entries
        .filter((e) => e.currency === currency && e.status === "hold" && e.direction === "debit" && !e.subAccountId)
        .reduce((sum, e) => sum + e.amount, 0),
    [entries],
  )

  // Credited-but-locked funds: held CREDITS (e.g. leverage-funded program ROI
  // that reflects on the account but is not yet withdrawable). Excluded from the
  // spendable balance below, surfaced separately so the customer sees the credit.
  const lockedCreditsFor = useCallback(
    (currency: string) =>
      entries
        .filter((e) => e.currency === currency && e.status === "hold" && e.direction === "credit" && !e.subAccountId)
        .reduce((sum, e) => sum + e.amount, 0),
    [entries],
  )

  // Available (spendable) MAIN balance: settled credits minus settled debits,
  // minus anything currently on hold. Reserved funds cannot be spent, so they
  // reduce the available balance everywhere it is read (send, payments…).
  // Entries tagged to a sub-account are EXCLUDED so parking money in a
  // sub-account correctly lowers the main balance (all legacy rows are untagged
  // ⇒ identical behaviour to before).
  const balanceFor = useCallback(
    (currency: string) => {
      const settled = entries
        .filter((e) => e.currency === currency && e.status === "completed" && !e.subAccountId)
        .reduce((sum, e) => sum + (e.direction === "credit" ? e.amount : -e.amount), 0)
      return settled - reservedFor(currency)
    },
    [entries, reservedFor],
  )

  // Net balance of a single sub-account compartment in a currency.
  const subAccountBalanceFor = useCallback(
    (subAccountId: string, currency: string) =>
      entries
        .filter((e) => e.currency === currency && e.subAccountId === subAccountId)
        .reduce((sum, e) => {
          if (e.status === "hold") return e.direction === "debit" ? sum - e.amount : sum
          return sum + (e.direction === "credit" ? e.amount : -e.amount)
        }, 0),
    [entries],
  )

  const currencies = useMemo(
    () => Array.from(new Set(entries.map((e) => e.currency))),
    [entries],
  )

  // Sum every currency's net balance, converted into the target currency.
  const totalIn = useCallback(
    (currency: string) =>
      currencies.reduce((sum, cur) => sum + convertCurrency(balanceFor(cur), cur, currency), 0),
    [currencies, balanceFor],
  )

  // Re-pull the authoritative server ledger. Used after an out-of-band write
  // (e.g. an administrator editing the signed-in account's ledger, or an instant
  // transfer) so the live view reflects the change without a reload.
  const refresh = useCallback(() => {
    void fetchLedgerEntries().then((serverEntries) => {
      if (!serverEntries) return
      setEntries(
        [...serverEntries].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
      )
    })
  }, [])

  // Memoize the context value so it only changes when the underlying data or a
  // (now stable) callback changes — never on every render. This prevents the
  // whole dashboard's ledger consumers from re-rendering in lockstep and stops
  // any consumer effect keyed on these callbacks from re-firing spuriously.
  const value = useMemo(
    () => ({
      entries,
      addReceipt,
      addDebit,
      balanceFor,
      reservedFor,
      lockedCreditsFor,
      totalIn,
      subAccountBalanceFor,
      currencies,
      refresh,
      hydrated,
    }),
    [entries, addReceipt, addDebit, balanceFor, reservedFor, lockedCreditsFor, totalIn, subAccountBalanceFor, currencies, refresh, hydrated],
  )

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>
}

export function useLedger() {
  const ctx = useContext(LedgerContext)
  if (!ctx) {
    throw new Error("useLedger must be used within a LedgerProvider")
  }
  return ctx
}
