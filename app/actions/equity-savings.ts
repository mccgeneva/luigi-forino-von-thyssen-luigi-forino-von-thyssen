"use server"

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import {
  readLedgerEntries,
  upsertLedgerEntry,
  deleteLedgerEntry,
  availableByCurrency,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import {
  EQUITY_CATEGORY,
  EQUITY_COUNTERPARTY,
  equityEntryId,
  equityHoldingsFromEntries,
} from "@/lib/equity-savings"
import { logActivity } from "@/app/actions/log-activity"

export interface EquitySavingsSnapshot {
  /** Blocked equity per currency (only currencies with a positive balance). */
  byCurrency: Record<string, number>
  /** Spendable (available) balance per currency, for the deposit picker. */
  availableByCurrency: Record<string, number>
}

export type EquityResult<T = { reference: string }> = { ok: true; data: T } | { ok: false; error: string }

/** Read the signed-in customer's segregated equity + spendable balances. */
export async function getMyEquitySavings(): Promise<EquitySavingsSnapshot> {
  const session = await resolveCurrentSession()
  if (!session) return { byCurrency: {}, availableByCurrency: {} }
  try {
    const ownerId = await resolveDataOwnerIdFor(session.id)
    const entries = await readLedgerEntries(ownerId)
    const blocked = equityHoldingsFromEntries(entries)
    const available = availableByCurrency(entries)
    // Only surface currencies the customer actually holds or has blocked.
    const avail: Record<string, number> = {}
    for (const [cur, amt] of Object.entries(available)) {
      if (amt > 0.009 || blocked[cur] > 0) avail[cur] = Math.round(amt * 100) / 100
    }
    return { byCurrency: blocked, availableByCurrency: avail }
  } catch {
    return { byCurrency: {}, availableByCurrency: {} }
  }
}

/**
 * Move spendable funds INTO the equity-saving pot. The equity pot is a single
 * aggregate HOLD debit per currency (`EQSAV-<CUR>`) on the master ledger: a hold
 * blocks the funds (they leave the available/spendable balance and cannot be
 * paid out) while the settled balance — the money the customer still owns — is
 * untouched. Solvency-checked against the currency's own available balance.
 */
export async function depositToEquitySavings(input: {
  amount: number
  currency: string
}): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  const currency = (input.currency || "EUR").toUpperCase()
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." }
  }

  const ownerId = await resolveDataOwnerIdFor(session.id)
  const entries = await readLedgerEntries(ownerId)

  // The pot can only hold currencies the customer actually has spendable.
  const available = availableByCurrency(entries)[currency] ?? 0
  if (amount > available + 0.01) {
    return {
      ok: false,
      error: `Insufficient ${currency} balance. You can move up to ${available.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${currency} into equity savings.`,
    }
  }

  const existing = equityHoldingsFromEntries(entries)[currency] ?? 0
  const next = Math.round((existing + amount) * 100) / 100
  const entryId = equityEntryId(currency)

  await upsertLedgerEntry(ownerId, {
    id: entryId,
    direction: "debit",
    amount: next,
    currency,
    status: "hold",
    date: new Date().toISOString(),
    counterparty: EQUITY_COUNTERPARTY,
    reference: entryId,
    category: EQUITY_CATEGORY,
    comment: "Segregated equity collateral blocked from the Master Account.",
  })

  // Belt-and-suspenders: never let the block tip a currency negative.
  try {
    await assertOwnerSolvent(ownerId)
  } catch {
    // Roll back to the prior held amount (or remove the hold entirely).
    if (existing > 0) {
      await upsertLedgerEntry(ownerId, {
        id: entryId,
        direction: "debit",
        amount: existing,
        currency,
        status: "hold",
        date: new Date().toISOString(),
        counterparty: EQUITY_COUNTERPARTY,
        reference: entryId,
        category: EQUITY_CATEGORY,
        comment: "Segregated equity collateral blocked from the Master Account.",
      })
    } else {
      await deleteLedgerEntry(ownerId, entryId)
    }
    return { ok: false, error: "That amount would overdraw the account. Nothing was moved." }
  }

  await logActivity({
    category: "Treasury",
    action: "Equity saving deposit",
    details: { amount, currency, blockedTotal: next },
  }).catch(() => {})

  return { ok: true, data: { reference: entryId } }
}

/**
 * Release funds FROM the equity-saving pot back to the spendable balance. This
 * simply shrinks (or removes) the aggregate hold, so the money the customer
 * always owned becomes spendable again. Always allowed up to the blocked amount.
 */
export async function withdrawFromEquitySavings(input: {
  amount: number
  currency: string
}): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  const currency = (input.currency || "EUR").toUpperCase()
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." }
  }

  const ownerId = await resolveDataOwnerIdFor(session.id)
  const entries = await readLedgerEntries(ownerId)
  const existing = equityHoldingsFromEntries(entries)[currency] ?? 0
  if (existing <= 0) {
    return { ok: false, error: `You have no equity savings blocked in ${currency}.` }
  }
  if (amount > existing + 0.01) {
    return {
      ok: false,
      error: `You can release up to ${existing.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${currency}.`,
    }
  }

  const entryId = equityEntryId(currency)
  const next = Math.round((existing - amount) * 100) / 100

  if (next <= 0.009) {
    await deleteLedgerEntry(ownerId, entryId)
  } else {
    await upsertLedgerEntry(ownerId, {
      id: entryId,
      direction: "debit",
      amount: next,
      currency,
      status: "hold",
      date: new Date().toISOString(),
      counterparty: EQUITY_COUNTERPARTY,
      reference: entryId,
      category: EQUITY_CATEGORY,
      comment: "Segregated equity collateral blocked from the Master Account.",
    })
  }

  await logActivity({
    category: "Treasury",
    action: "Equity saving release",
    details: { amount, currency, blockedRemaining: next > 0 ? next : 0 },
  }).catch(() => {})

  return { ok: true, data: { reference: entryId } }
}

