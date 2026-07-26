"use server"

import { resolveCurrentSession } from "@/lib/session-user"
import {
  listNotificationsForUser,
  countUnreadForUser,
  markNotificationsRead,
  insertNotificationOnce,
  type NotificationRecord,
} from "@/lib/notifications-db"

/** Money formatter for notification copy (e.g. "€12,500.00"). */
function fmtEur(amount: number): string {
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(amount)
  } catch {
    return `€${amount.toFixed(2)}`
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export interface TreasuryInterestDebitNotice {
  /** Stable per-charge key (e.g. the ledger entry id) — dedupes the notice. */
  chargeId: string
  /** Amount debited this month, in EUR. */
  amount: number
  /** Remaining Master Account (EUR) balance immediately after this debit. */
  remainingBalance: number
  /** ISO date of the next expected monthly deduction. */
  nextDeductionAt: string
  /** Optional human label for the financing tier (e.g. "Avant-garde"). */
  tierLabel?: string
}

/**
 * Emit exactly ONE notification for a monthly treasury-financing interest debit.
 * Safe to call on every reconciler pass: the deterministic id derived from the
 * charge means reloads never produce duplicate notices. Returns whether a new
 * notification was actually created.
 */
export async function notifyTreasuryInterestDebit(
  notice: TreasuryInterestDebitNotice,
): Promise<{ ok: boolean; created: boolean }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, created: false }
  try {
    const tier = notice.tierLabel ? ` (${notice.tierLabel})` : ""
    const body =
      `${fmtEur(notice.amount)} was deducted from your Master Account as your monthly ` +
      `Special Treasury Financing interest (3% p.a.)${tier}. ` +
      `Remaining balance: ${fmtEur(notice.remainingBalance)}. ` +
      `Next deduction: ${fmtDate(notice.nextDeductionAt)}.`
    const created = await insertNotificationOnce(`TFI-${notice.chargeId}`, {
      userId: session.id,
      tone: "warning",
      title: "Treasury financing interest charged",
      body,
      href: "/dashboard/leverage",
    })
    return { ok: true, created }
  } catch (err) {
    console.log("[v0] notifyTreasuryInterestDebit failed:", (err as Error).message)
    return { ok: false, created: false }
  }
}

/** Money formatter for an arbitrary currency (leverage lines are multi-currency). */
function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export interface LeverageInterestDebitNotice {
  /** Stable per-charge key (the monthly ledger entry id) — dedupes the notice. */
  chargeId: string
  /** Amount debited this month. */
  amount: number
  /** Currency of the leverage line / charge. */
  currency: string
  /** Remaining Master Account balance (same currency) immediately after the debit. */
  remainingBalance: number
  /** ISO date of the next expected monthly deduction. */
  nextDeductionAt: string
  /** Leverage multiple (e.g. 10 for 1:10) for the notice copy. */
  leverageRatio: number
  /** Annual debit interest rate applied (e.g. 0.036 for 3.60%). */
  annualRate: number
}

/**
 * Emit exactly ONE notification for a monthly leverage debit-interest charge to
 * the Master Account. Safe to call on every reconciler pass: the deterministic
 * id derived from the charge means reloads never produce duplicate notices.
 */
export async function notifyLeverageInterestDebit(
  notice: LeverageInterestDebitNotice,
): Promise<{ ok: boolean; created: boolean }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, created: false }
  try {
    const body =
      `${fmtMoney(notice.amount, notice.currency)} was deducted from your Master Account as your monthly ` +
      `leverage debit interest on your 1:${notice.leverageRatio} line ` +
      `(${(notice.annualRate * 100).toFixed(2)}% p.a. ÷ 12). ` +
      `Remaining balance: ${fmtMoney(notice.remainingBalance, notice.currency)}. ` +
      `Next deduction: ${fmtDate(notice.nextDeductionAt)}.`
    const created = await insertNotificationOnce(`LVI-${notice.chargeId}`, {
      userId: session.id,
      tone: notice.remainingBalance < 0 ? "error" : "warning",
      title: "Leverage interest charged",
      body,
      href: "/dashboard/leverage",
    })
    return { ok: true, created }
  } catch (err) {
    console.log("[v0] notifyLeverageInterestDebit failed:", (err as Error).message)
    return { ok: false, created: false }
  }
}

export interface NotificationsSnapshot {
  items: NotificationRecord[]
  unread: number
}

/** The signed-in user's most recent notifications + unread count. */
export async function getMyNotifications(): Promise<NotificationsSnapshot> {
  const session = await resolveCurrentSession()
  if (!session) return { items: [], unread: 0 }
  try {
    const [items, unread] = await Promise.all([
      listNotificationsForUser(session.id),
      countUnreadForUser(session.id),
    ])
    return { items, unread }
  } catch (err) {
    console.log("[v0] getMyNotifications failed:", (err as Error).message)
    return { items: [], unread: 0 }
  }
}

/** Mark some (or all) of the user's notifications read. */
export async function markMyNotificationsRead(ids?: string[]): Promise<{ ok: boolean }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false }
  try {
    await markNotificationsRead(session.id, ids)
    return { ok: true }
  } catch (err) {
    console.log("[v0] markMyNotificationsRead failed:", (err as Error).message)
    return { ok: false }
  }
}
