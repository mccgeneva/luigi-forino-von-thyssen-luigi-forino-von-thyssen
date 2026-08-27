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
import { convertCurrency } from "@/lib/fx"
import { logActivity } from "@/app/actions/log-activity"
import type { LedgerEntry } from "@/lib/ledger-store"

const BASE = "EUR"

function round2(n: number): number {
  return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100
}

function fmtMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

/**
 * SETTLED (completed-only) balance per currency for the master pool. Holds are
 * NOT subtracted here — this is the money actually owned, the same definition
 * the controlled-overdraft engine uses to decide whether an account is negative
 * (`lib/overdraft.ts` getSettledBalanceEur). Sub-account-tagged rows are
 * excluded (isolated compartments, not the shared master pool).
 */
function settledByCurrency(entries: LedgerEntry[]): Record<string, number> {
  const perCur: Record<string, number> = {}
  for (const e of entries) {
    if (e.status !== "completed") continue
    if (e.subAccountId) continue
    const c = (e.currency || "USD").toUpperCase()
    perCur[c] = (perCur[c] ?? 0) + (e.direction === "credit" ? e.amount : -e.amount)
  }
  return perCur
}

/** Aggregate settled balance across all currencies, EUR-equivalent. */
function settledEurFromEntries(entries: LedgerEntry[]): number {
  const perCur = settledByCurrency(entries)
  let sum = 0
  for (const [c, v] of Object.entries(perCur)) sum += convertCurrency(v, c, BASE)
  return round2(sum)
}

/** Fire-and-forget audit of an equity-saving transfer attempt (accepted or rejected). */
async function auditEquityAttempt(
  outcome: "accepted" | "rejected",
  input: { amount: number; currency: string; reason?: string; blockedTotal?: number },
): Promise<void> {
  await logActivity({
    category: "Treasury",
    action: `Equity saving deposit ${outcome}`,
    details: {
      amount: input.amount,
      currency: input.currency,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.blockedTotal != null ? { blockedTotal: input.blockedTotal } : {}),
    },
  }).catch(() => {})
}

export interface EquitySavingsSnapshot {
  /** Blocked equity per currency (only currencies with a positive balance). */
  byCurrency: Record<string, number>
  /** Spendable (available) balance per currency, for the deposit picker. */
  availableByCurrency: Record<string, number>
  /**
   * True when the master account is negative (in controlled overdraft): its
   * aggregate settled EUR balance is below zero. While true, NO equity top-up
   * is allowed — the customer must first restore a positive balance.
   */
  accountNegative: boolean
  /** How negative the account is, EUR-equivalent (0 when positive). */
  negativeEur: number
}

export type EquityResult<T = { reference: string }> = { ok: true; data: T } | { ok: false; error: string }

/** Read the signed-in customer's segregated equity + spendable balances. */
export async function getMyEquitySavings(): Promise<EquitySavingsSnapshot> {
  const session = await resolveCurrentSession()
  if (!session) return { byCurrency: {}, availableByCurrency: {}, accountNegative: false, negativeEur: 0 }
  try {
    const ownerId = await resolveDataOwnerIdFor(session.id)
    const entries = await readLedgerEntries(ownerId)
    const blocked = equityHoldingsFromEntries(entries)
    const available = availableByCurrency(entries)
    // Only surface currencies the customer actually holds or has blocked.
    const avail: Record<string, number> = {}
    for (const [cur, amt] of Object.entries(available)) {
      if (amt > 0.009 || blocked[cur] > 0) avail[cur] = round2(amt)
    }
    const settledEur = settledEurFromEntries(entries)
    const accountNegative = settledEur < -0.01
    return {
      byCurrency: blocked,
      availableByCurrency: avail,
      accountNegative,
      negativeEur: accountNegative ? round2(-settledEur) : 0,
    }
  } catch {
    return { byCurrency: {}, availableByCurrency: {}, accountNegative: false, negativeEur: 0 }
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

  // ELIGIBILITY RULE 1 — NEGATIVE MASTER ACCOUNT (hard pre-check).
  // If the master account is negative (in controlled overdraft), NO equity
  // top-up is allowed in any currency. The customer must first restore a
  // positive balance. This catches the cross-currency case where one currency
  // looks positive while the account as a whole is overdrawn.
  const settledPer = settledByCurrency(entries)
  const settledEur = settledEurFromEntries(entries)
  if (settledEur < -0.01) {
    const reason = `Your Master Account is negative (${fmtMoney(round2(-settledEur), BASE)} in overdraft). Restore a positive balance before adding to Equity Saving.`
    await auditEquityAttempt("rejected", { amount, currency, reason })
    return { ok: false, error: reason }
  }

  // ELIGIBILITY RULE 2 — the SOURCE currency itself must not be in deficit.
  const settledInCcy = round2(settledPer[currency] ?? 0)
  if (settledInCcy < -0.01) {
    const reason = `Your ${currency} balance is negative (${fmtMoney(round2(-settledInCcy), currency)}). Equity Saving can only be funded from a positive ${currency} balance.`
    await auditEquityAttempt("rejected", { amount, currency, reason })
    return { ok: false, error: reason }
  }

  // ELIGIBILITY RULE 3 — CLEAN FUNDS ONLY. `availableByCurrency` already
  // subtracts every hold (reserved, blocked, leverage/PPI-appeal, overdraft and
  // any other encumbrance), so it is exactly the clean, unencumbered, spendable
  // balance. Only that may be committed.
  const available = round2(availableByCurrency(entries)[currency] ?? 0)
  if (amount > available + 0.01) {
    const reason = `Insufficient clean ${currency} funds. Only ${fmtMoney(available, currency)} is unencumbered and available to move into Equity Saving (reserved, blocked, leveraged or overdraft-linked funds are excluded).`
    await auditEquityAttempt("rejected", { amount, currency, reason })
    return { ok: false, error: reason }
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
    const reason = "That amount would overdraw the account. Nothing was moved."
    await auditEquityAttempt("rejected", { amount, currency, reason })
    return { ok: false, error: reason }
  }

  await auditEquityAttempt("accepted", { amount, currency, blockedTotal: next })

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

