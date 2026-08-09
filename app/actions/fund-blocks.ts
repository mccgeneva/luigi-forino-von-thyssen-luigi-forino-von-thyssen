"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveAccountProfileById, resolveDataOwnerIdFor } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import {
  readLedgerEntries,
  availableByCurrency,
  upsertLedgerEntry,
  deleteLedgerEntry,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import { insertNotification } from "@/lib/notifications-db"
import type { LedgerEntry } from "@/lib/ledger-store"

/**
 * Administrator manual fund blocking on a client's Master Account.
 *
 * A "block" is a HOLD debit posted to the shared data-owner (Master) ledger:
 *   - it immediately reduces the client's AVAILABLE balance (holds are
 *     subtracted in `availableByCurrency`), so the reserved amount cannot be
 *     spent — identical to every other reservation in the platform;
 *   - it never touches the settled balance while held, so RELEASING it (delete
 *     the row) returns the funds to available with no side effects;
 *   - PERMANENT WITHDRAWAL flips the same row from `hold` → `completed`, which
 *     turns the reservation into a real outgoing debit (funds leave for good).
 *
 * Deterministic id prefix `ADMIN-BLOCK-` lets both the admin panel and the
 * client-facing notice recognise administrative holds unambiguously.
 */

// NOTE: this is a `"use server"` module — only async functions may be
// exported. These identifiers stay module-private; the client-facing notice
// recognises administrative holds by the `ADMIN-BLOCK-` id prefix instead.
const BLOCK_ID_PREFIX = "ADMIN-BLOCK-"
const ADMIN_BLOCK_CATEGORY = "Administrative Hold"
const ADMIN_WITHDRAWN_CATEGORY = "Administrative Withdrawal"
const BLOCK_COUNTERPARTY = "MCC Capital — Compliance"

export interface BlockedFund {
  id: string
  amount: number
  currency: string
  reason: string
  counterparty: string
  createdAt: string
}

export type FundBlockResult =
  | { ok: true; blocks: BlockedFund[]; available: Record<string, number> }
  | { ok: false; error: string; shortfall?: { currency: string; available: number; requested: number } }

function newBlockId(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${BLOCK_ID_PREFIX}${Date.now().toString(36).toUpperCase()}-${rand}`
}

/** Every current administrative HOLD on the owner ledger, newest first. */
function extractBlocks(entries: LedgerEntry[]): BlockedFund[] {
  return entries
    .filter((e) => e.id.startsWith(BLOCK_ID_PREFIX) && e.status === "hold" && e.direction === "debit")
    .map((e) => ({
      id: e.id,
      amount: e.amount,
      currency: e.currency,
      reason: e.comment?.trim() || "(no reason recorded)",
      counterparty: e.counterparty || BLOCK_COUNTERPARTY,
      createdAt: e.date,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

async function loadState(ownerId: string): Promise<{ blocks: BlockedFund[]; available: Record<string, number> }> {
  const entries = await readLedgerEntries(ownerId)
  return { blocks: extractBlocks(entries), available: availableByCurrency(entries) }
}

function fmt(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Admin: list every active block on a client's Master Account + available balances. */
export async function listBlockedFundsForUserAdmin(passcode: string, userId: string): Promise<FundBlockResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  if (!userId) return { ok: false, error: "Select a client account first." }
  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    const state = await loadState(ownerId)
    return { ok: true, ...state }
  } catch (err) {
    console.log("[v0] listBlockedFundsForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "The blocked-funds status could not be loaded. Please try again." }
  }
}

/**
 * Admin: block (reserve) an amount from a client's Master Account balance.
 * Gated on available balance — blocking more than is available is rejected with
 * a clear shortfall notice and nothing is posted (negative-balance protection).
 */
export async function blockUserFundsAdmin(
  passcode: string,
  userId: string,
  amount: number,
  currency: string,
  reason: string,
): Promise<FundBlockResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  if (!userId) return { ok: false, error: "Select a client account first." }
  const numeric = Number(amount)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, error: "Enter a valid amount greater than zero." }
  }
  const cur = (currency || "EUR").toUpperCase()
  const trimmedReason = reason?.trim() ?? ""
  if (!trimmedReason) {
    return { ok: false, error: "A reason is required to block funds." }
  }

  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    const before = await readLedgerEntries(ownerId)
    const available = availableByCurrency(before)[cur] ?? 0
    if (numeric > available + 0.01) {
      return {
        ok: false,
        error: `Insufficient available balance. Only ${fmt(available, cur)} is available to block, but ${fmt(numeric, cur)} was requested.`,
        shortfall: { currency: cur, available, requested: numeric },
      }
    }

    const id = newBlockId()
    const entry: LedgerEntry = {
      id,
      direction: "debit",
      amount: numeric,
      currency: cur,
      status: "hold",
      date: new Date().toISOString(),
      counterparty: BLOCK_COUNTERPARTY,
      reference: id,
      comment: trimmedReason,
      category: ADMIN_BLOCK_CATEGORY,
    }
    await upsertLedgerEntry(ownerId, entry)

    // Final DB-level non-negativity guard: if a concurrent write made the hold
    // overdraw available balance, roll the block back and report the shortfall.
    try {
      await assertOwnerSolvent(ownerId)
    } catch {
      await deleteLedgerEntry(ownerId, id)
      const nowAvail = availableByCurrency(await readLedgerEntries(ownerId))[cur] ?? 0
      return {
        ok: false,
        error: `Insufficient available balance. Only ${fmt(nowAvail, cur)} is available to block right now.`,
        shortfall: { currency: cur, available: nowAvail, requested: numeric },
      }
    }

    const target = await resolveAccountProfileById(userId)
    try {
      await insertNotification({
        userId,
        tone: "warning",
        title: "Funds blocked on your account",
        body: `${fmt(numeric, cur)} has been blocked on your Master Account by MCC Capital and is temporarily unavailable. Reason: ${trimmedReason}.`,
        href: "/dashboard",
      })
    } catch (err) {
      console.log("[v0] block notification failed:", (err as Error).message)
    }
    try {
      await logActivity({
        action: `Administrator blocked ${fmt(numeric, cur)} on ${target.fullName}'s Master Account`,
        category: "Administration / Fund Controls",
        user: "Administrator",
        details: {
          referenceId: id,
          targetAccount: `${target.fullName} — ${target.email}`,
          amount: fmt(numeric, cur),
          decision: "Blocked",
          reason: trimmedReason,
        },
      })
    } catch (err) {
      console.log("[v0] block activity log failed:", (err as Error).message)
    }

    return { ok: true, ...(await loadState(ownerId)) }
  } catch (err) {
    console.log("[v0] blockUserFundsAdmin failed:", (err as Error).message)
    return { ok: false, error: "The funds could not be blocked. Please try again." }
  }
}

/** Admin: release a block — return the reserved funds to the client's available balance. */
export async function releaseBlockedFundsAdmin(
  passcode: string,
  userId: string,
  blockId: string,
): Promise<FundBlockResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  if (!userId || !blockId) return { ok: false, error: "Missing account or block reference." }
  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    const entries = await readLedgerEntries(ownerId)
    const block = entries.find((e) => e.id === blockId && e.status === "hold")
    if (!block) return { ok: false, error: "This block was already released or withdrawn." }

    await deleteLedgerEntry(ownerId, blockId)

    const target = await resolveAccountProfileById(userId)
    try {
      await insertNotification({
        userId,
        tone: "success",
        title: "Blocked funds released",
        body: `${fmt(block.amount, block.currency)} previously blocked on your Master Account has been released and is available again.`,
        href: "/dashboard",
      })
    } catch (err) {
      console.log("[v0] release notification failed:", (err as Error).message)
    }
    try {
      await logActivity({
        action: `Administrator released ${fmt(block.amount, block.currency)} back to ${target.fullName}`,
        category: "Administration / Fund Controls",
        user: "Administrator",
        details: {
          referenceId: blockId,
          targetAccount: `${target.fullName} — ${target.email}`,
          amount: fmt(block.amount, block.currency),
          decision: "Released",
          reason: block.comment?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] release activity log failed:", (err as Error).message)
    }

    return { ok: true, ...(await loadState(ownerId)) }
  } catch (err) {
    console.log("[v0] releaseBlockedFundsAdmin failed:", (err as Error).message)
    return { ok: false, error: "The block could not be released. Please try again." }
  }
}

/**
 * Admin: permanently withdraw blocked funds. Flips the HOLD into a settled
 * outgoing debit (same row/id) so the amount leaves the balance for good; the
 * available balance is unchanged (it was already reduced by the hold).
 */
export async function withdrawBlockedFundsAdmin(
  passcode: string,
  userId: string,
  blockId: string,
): Promise<FundBlockResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  if (!userId || !blockId) return { ok: false, error: "Missing account or block reference." }
  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    const entries = await readLedgerEntries(ownerId)
    const block = entries.find((e) => e.id === blockId && e.status === "hold")
    if (!block) return { ok: false, error: "This block was already released or withdrawn." }

    await upsertLedgerEntry(ownerId, {
      ...block,
      status: "completed",
      category: ADMIN_WITHDRAWN_CATEGORY,
      date: new Date().toISOString(),
      comment: block.comment?.trim()
        ? `Permanent withdrawal — ${block.comment.trim()}`
        : "Permanent administrative withdrawal",
    })

    // Defensive: converting hold→completed keeps available unchanged, but guard
    // against any state that would leave a currency overdrawn.
    await assertOwnerSolvent(ownerId)

    const target = await resolveAccountProfileById(userId)
    try {
      await insertNotification({
        userId,
        tone: "warning",
        title: "Blocked funds withdrawn",
        body: `${fmt(block.amount, block.currency)} previously blocked on your Master Account has been permanently withdrawn by MCC Capital.`,
        href: "/dashboard",
      })
    } catch (err) {
      console.log("[v0] withdrawal notification failed:", (err as Error).message)
    }
    try {
      await logActivity({
        action: `Administrator permanently withdrew ${fmt(block.amount, block.currency)} from ${target.fullName}`,
        category: "Administration / Fund Controls",
        user: "Administrator",
        details: {
          referenceId: blockId,
          targetAccount: `${target.fullName} — ${target.email}`,
          amount: fmt(block.amount, block.currency),
          decision: "Permanently withdrawn",
          reason: block.comment?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] withdrawal activity log failed:", (err as Error).message)
    }

    return { ok: true, ...(await loadState(ownerId)) }
  } catch (err) {
    console.log("[v0] withdrawBlockedFundsAdmin failed:", (err as Error).message)
    return { ok: false, error: "The funds could not be withdrawn. Please try again." }
  }
}
