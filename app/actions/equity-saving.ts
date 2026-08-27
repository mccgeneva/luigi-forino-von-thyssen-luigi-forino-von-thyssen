"use server"

import { readLedgerEntries, upsertLedgerEntry, deleteLedgerEntry, availableByCurrency } from "@/lib/ledger-db"
import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import type { LedgerEntry } from "@/lib/ledger-store"
import {
  equityEntryId,
  isEquityEntryId,
  readEquityHoldings,
  EQUITY_CATEGORY,
  EQUITY_COUNTERPARTY,
} from "@/lib/equity-savings"

const SUPPORTED = ["EUR", "USD", "GBP", "CHF"]

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

export interface EquitySavingView {
  /** Blocked equity per currency (positive amounts). */
  holdings: { currency: string; amount: number }[]
  /** Spendable balance per currency (what can still be committed). */
  available: { currency: string; amount: number }[]
}

export type EquityResult = { ok: true; view: EquitySavingView } | { ok: false; error: string }

/** Read the customer's equity pot + their available balances (for the transfer UI). */
export async function getMyEquitySaving(): Promise<EquitySavingView> {
  const session = await resolveCurrentSession()
  if (!session) return { holdings: [], available: [] }
  const ownerId = await resolveDataOwnerIdFor(session.id)
  const [entries, holdings] = await Promise.all([readLedgerEntries(ownerId), readEquityHoldings(ownerId)])
  const avail = availableByCurrency(entries)
  return {
    holdings: Object.entries(holdings)
      .filter(([, a]) => a > 0.005)
      .map(([currency, amount]) => ({ currency, amount: round2(amount) })),
    available: Object.entries(avail)
      .filter(([, a]) => a > 0.005)
      .map(([currency, amount]) => ({ currency, amount: round2(amount) })),
  }
}

async function buildView(ownerId: string): Promise<EquitySavingView> {
  const [entries, holdings] = await Promise.all([readLedgerEntries(ownerId), readEquityHoldings(ownerId)])
  const avail = availableByCurrency(entries)
  return {
    holdings: Object.entries(holdings)
      .filter(([, a]) => a > 0.005)
      .map(([currency, amount]) => ({ currency, amount: round2(amount) })),
    available: Object.entries(avail)
      .filter(([, a]) => a > 0.005)
      .map(([currency, amount]) => ({ currency, amount: round2(amount) })),
  }
}

/**
 * COMMIT funds from the Master Account into the segregated Equity Saving pot.
 * The money is blocked (a hold) — still owned but no longer spendable — and now
 * counts as collateral improving the Guarantees Accumulator trust score.
 */
export async function commitEquitySaving(input: { amount: number; currency: string }): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const currency = (input.currency || "EUR").toUpperCase()
  if (!SUPPORTED.includes(currency)) return { ok: false, error: `Unsupported currency ${currency}.` }
  const amount = round2(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." }

  const ownerId = await resolveDataOwnerIdFor(session.id)
  const entries = await readLedgerEntries(ownerId)

  // Solvency: only currently-available (spendable) funds in THIS currency can be
  // committed — same rule every payment/leverage gate uses.
  const available = availableByCurrency(entries)[currency] ?? 0
  if (amount > available + 0.01) {
    return {
      ok: false,
      error: `Insufficient available ${currency} balance. You can commit up to ${available.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${currency}.`,
    }
  }

  // Grow the aggregate hold for this currency (upsert the deterministic id).
  const existing = entries.find((e) => e.id === equityEntryId(currency) && e.status === "hold")
  const nextAmount = round2((existing?.amount ?? 0) + amount)
  const entry: LedgerEntry = {
    id: equityEntryId(currency),
    direction: "debit",
    amount: nextAmount,
    currency,
    status: "hold",
    date: new Date().toISOString(),
    counterparty: EQUITY_COUNTERPARTY,
    reference: equityEntryId(currency),
    category: EQUITY_CATEGORY,
    comment: "Segregated equity saving — blocked as collateral, still owned.",
  }
  await upsertLedgerEntry(ownerId, entry)
  return { ok: true, view: await buildView(ownerId) }
}

/**
 * RELEASE funds from the Equity Saving pot back to the spendable Master Account.
 * Reduces (or deletes) the aggregate hold for the currency.
 */
export async function releaseEquitySaving(input: { amount: number; currency: string }): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const currency = (input.currency || "EUR").toUpperCase()
  if (!SUPPORTED.includes(currency)) return { ok: false, error: `Unsupported currency ${currency}.` }
  const amount = round2(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." }

  const ownerId = await resolveDataOwnerIdFor(session.id)
  const entries = await readLedgerEntries(ownerId)
  const existing = entries.find((e) => e.id === equityEntryId(currency) && e.status === "hold")
  const blocked = existing?.amount ?? 0
  if (blocked <= 0) return { ok: false, error: `You have no blocked ${currency} equity to release.` }
  if (amount > blocked + 0.01) {
    return {
      ok: false,
      error: `You can release at most ${blocked.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${currency}.`,
    }
  }

  const remaining = round2(blocked - amount)
  if (remaining <= 0.005) {
    await deleteLedgerEntry(ownerId, equityEntryId(currency))
  } else {
    await upsertLedgerEntry(ownerId, {
      id: equityEntryId(currency),
      direction: "debit",
      amount: remaining,
      currency,
      status: "hold",
      date: new Date().toISOString(),
      counterparty: EQUITY_COUNTERPARTY,
      reference: equityEntryId(currency),
      category: EQUITY_CATEGORY,
      comment: "Segregated equity saving — blocked as collateral, still owned.",
    })
  }
  return { ok: true, view: await buildView(ownerId) }
}

/** Guard used by callers that must not double-count equity ids. */
export { isEquityEntryId }
