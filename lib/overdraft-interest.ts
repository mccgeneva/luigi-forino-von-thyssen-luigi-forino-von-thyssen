import "server-only"
import type { LedgerEntry } from "@/lib/ledger-store"

// ---------------------------------------------------------------------------
// Overdraft debit interest.
//
// When a Master Account is in overdraft (its aggregate settled balance, EUR-
// equivalent, is negative), the USED overdraft accrues debit interest at
// OVERDRAFT_DEBIT_ANNUAL_RATE, charged DAILY (annual rate ÷ 365 per elapsed
// day) on the negative balance. Charges are posted lazily by the ledger
// reconciler (no scheduler), each with a deterministic per-day id so a re-run
// never double-charges and it self-heals across devices. Because each new
// day's basis is the CURRENT negative balance — which already includes the
// prior days' interest debits — interest compounds daily across reconciles.
// ---------------------------------------------------------------------------

/** Annual overdraft debit interest rate (22% p.a.). */
export const OVERDRAFT_DEBIT_ANNUAL_RATE = 0.22
/** Human label for the annual rate. */
export const OVERDRAFT_DEBIT_ANNUAL_LABEL = "22%"
/** All overdraft interest is charged in this currency. */
export const OVERDRAFT_INTEREST_CURRENCY = "EUR"
/** Deterministic ledger-id prefix for a day's overdraft interest charge. */
export const OVERDRAFT_INTEREST_ID_PREFIX = "OD-INT-"

/**
 * How many elapsed days back a single accrual pass will charge. The reconciler
 * runs on essentially every ledger read, so the gap is normally 0–1 days; the
 * cap bounds the retroactive charge for a returning user (we cannot reconstruct
 * historical daily balances, so we never backfill more than this using the
 * current balance as the basis — deliberately lenient, never over-charging a
 * long positive gap).
 */
const MAX_LOOKBACK_DAYS = 3

const ONE_DAY_MS = 86_400_000

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** True when a ledger id is an overdraft interest charge. */
export function isOverdraftInterestEntry(id: string): boolean {
  return typeof id === "string" && id.startsWith(OVERDRAFT_INTEREST_ID_PREFIX)
}

/** UTC calendar-day key `YYYY-MM-DD` for an epoch-ms instant. */
function utcDateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
}

/** Midnight-UTC epoch-ms of a `YYYY-MM-DD` key (NaN when malformed). */
function dateKeyToUtcMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return Number.NaN
  return Date.UTC(y, m - 1, d)
}

/** Deterministic ledger id for a given day's overdraft interest charge. */
export function overdraftInterestEntryId(dateKey: string): string {
  return `${OVERDRAFT_INTEREST_ID_PREFIX}${dateKey}`
}

/**
 * Total overdraft interest already posted, summed from the ledger by matching
 * the deterministic id prefix (EUR).
 */
export function postedOverdraftInterest(entries: ReadonlyArray<Pick<LedgerEntry, "id" | "amount">>): number {
  let sum = 0
  for (const e of entries) {
    if (isOverdraftInterestEntry(e.id)) sum += e.amount || 0
  }
  return round2(sum)
}

/**
 * Build the overdraft-interest charges due but not yet on the ledger.
 *
 * @param entries    the owner's current ledger rows (to detect already-posted
 *                   days and the last accrual date).
 * @param negativeEur the CURRENT used overdraft = -(aggregate settled EUR
 *                   balance) when negative, else 0. This is the daily basis.
 * @param now        clock (defaults to Date.now()).
 *
 * Returns one `completed` EUR debit per fully-elapsed UTC day in the accrual
 * window (never today, which is not yet complete). Empty when not in overdraft.
 */
export function buildOverdraftInterestPosts(opts: {
  entries: ReadonlyArray<LedgerEntry>
  negativeEur: number
  now?: number
}): LedgerEntry[] {
  const now = opts.now ?? Date.now()
  const negative = round2(Math.max(0, opts.negativeEur || 0))
  if (negative <= 0.01) return [] // not in overdraft → nothing accrues

  const dailyAmount = round2((negative * OVERDRAFT_DEBIT_ANNUAL_RATE) / 365)
  if (dailyAmount <= 0) return []

  const nowD = new Date(now)
  const todayStartMs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate())
  const yesterdayMs = todayStartMs - ONE_DAY_MS // only charge fully-elapsed days
  if (yesterdayMs < 0) return []

  // Most recent day already charged.
  let lastKeyMs = -1
  for (const e of opts.entries) {
    if (!isOverdraftInterestEntry(e.id)) continue
    const ms = dateKeyToUtcMs(e.id.slice(OVERDRAFT_INTEREST_ID_PREFIX.length))
    if (Number.isFinite(ms) && ms > lastKeyMs) lastKeyMs = ms
  }

  const capStartMs = yesterdayMs - (MAX_LOOKBACK_DAYS - 1) * ONE_DAY_MS
  // First run (no prior charge): start accruing from the most recent elapsed
  // day only — no retroactive charge for days before the account was observed.
  const fromMs = lastKeyMs >= 0 ? Math.max(lastKeyMs + ONE_DAY_MS, capStartMs) : yesterdayMs

  const existing = new Set(opts.entries.map((e) => e.id))
  const posts: LedgerEntry[] = []
  for (let ms = fromMs; ms <= yesterdayMs; ms += ONE_DAY_MS) {
    const key = utcDateKey(ms)
    const id = overdraftInterestEntryId(key)
    if (existing.has(id)) continue
    posts.push({
      id,
      direction: "debit",
      amount: dailyAmount,
      currency: OVERDRAFT_INTEREST_CURRENCY,
      status: "completed",
      date: new Date(ms + 12 * 3_600_000).toISOString(), // midday UTC of that day
      counterparty: "MCC Capital — Overdraft Interest",
      category: "Overdraft Debit Interest",
      comment: `Debit interest at ${OVERDRAFT_DEBIT_ANNUAL_LABEL} p.a. (daily) on the used overdraft of EUR ${negative.toLocaleString(
        "en-US",
        { minimumFractionDigits: 2, maximumFractionDigits: 2 },
      )} for ${key}.`,
    })
  }
  return posts
}
