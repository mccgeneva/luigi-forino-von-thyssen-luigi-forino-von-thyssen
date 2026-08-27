"use server"

import {
  resolveCurrentSession,
  resolveDataOwnerIdFor,
  resolveEnvironmentMemberIds,
  resolveAccountProfileById,
} from "@/lib/session-user"
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
import {
  createEquityReleaseRequest,
  getEquityReleaseById,
  listActiveEquityReleases,
  listEquityReleasesForUsers,
  listDueScheduledReleases,
  updateEquityRelease,
  countPendingEquityReleases,
  type EquityReleaseRequest,
} from "@/lib/equity-release-db"
import { adminActionAuthorized, adminEmails } from "@/lib/admin-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { insertNotification } from "@/lib/notifications-db"
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
    // Lazily credit any scheduled releases whose time has arrived before reading.
    await settleDueEquityReleases(ownerId)
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

/* -------------------------------------------------------------------------- */
/*  ADMIN-CONTROLLED RELEASE                                                    */
/*                                                                              */
/*  Customers can no longer self-release. They submit a REQUEST; only an        */
/*  administrator approves it, negotiating the amount, the modality and the     */
/*  time it credits. Unblocking = shrinking the `EQSAV-<CUR>` hold, done at     */
/*  approval (immediate) or lazily once a scheduled `releaseAt` passes.         */
/* -------------------------------------------------------------------------- */

/**
 * INTERNAL — shrink (or remove) the aggregate equity hold for a currency,
 * returning the amount actually unblocked. Clamps to what is currently blocked.
 */
async function shrinkEquityHold(ownerId: string, currency: string, amount: number): Promise<number> {
  const cur = currency.toUpperCase()
  const entries = await readLedgerEntries(ownerId)
  const existing = equityHoldingsFromEntries(entries)[cur] ?? 0
  if (existing <= 0) return 0
  const release = Math.min(round2(amount), existing)
  if (release <= 0) return 0
  const next = round2(existing - release)
  const entryId = equityEntryId(cur)
  if (next <= 0.009) {
    await deleteLedgerEntry(ownerId, entryId)
  } else {
    await upsertLedgerEntry(ownerId, {
      id: entryId,
      direction: "debit",
      amount: next,
      currency: cur,
      status: "hold",
      date: new Date().toISOString(),
      counterparty: EQUITY_COUNTERPARTY,
      reference: entryId,
      category: EQUITY_CATEGORY,
      comment: "Segregated equity collateral blocked from the Master Account.",
    })
  }
  return release
}

/** Settle any scheduled releases for an owner whose credit time has arrived. */
export async function settleDueEquityReleases(ownerId: string): Promise<void> {
  let due: EquityReleaseRequest[] = []
  try {
    due = await listDueScheduledReleases(ownerId)
  } catch {
    return
  }
  for (const req of due) {
    try {
      const amt = req.approvedAmount ?? req.requestedAmount
      const released = await shrinkEquityHold(req.ownerId, req.currency, amt)
      await updateEquityRelease(req.id, {
        status: "released",
        releasedAt: new Date().toISOString(),
        releasedEntryId: equityEntryId(req.currency),
      })
      await insertNotification({
        userId: req.userId,
        tone: "success",
        title: `Equity released to your Master Account`,
        body: `${fmtMoney(round2(released), req.currency)} has been released to your spendable Master Account balance as agreed.`,
        href: "/dashboard/equity-saving",
      }).catch(() => {})
      await auditEquityAttempt("accepted", { amount: released, currency: req.currency, reason: "scheduled release settled" })
    } catch {
      /* leave for the next read */
    }
  }
}

/** CUSTOMER — submit a request to release blocked equity (no funds move yet). */
export async function requestEquityRelease(input: {
  amount: number
  currency: string
}): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const amount = round2(Number(input.amount) || 0)
  const currency = (input.currency || "EUR").toUpperCase()
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." }
  }

  const ownerId = await resolveDataOwnerIdFor(session.id)
  const entries = await readLedgerEntries(ownerId)
  const blocked = equityHoldingsFromEntries(entries)[currency] ?? 0
  if (blocked <= 0) {
    return { ok: false, error: `You have no equity savings blocked in ${currency}.` }
  }
  if (amount > blocked + 0.01) {
    return { ok: false, error: `You can request up to ${fmtMoney(blocked, currency)}.` }
  }

  // Prevent stacking duplicate pending/scheduled requests for the same currency.
  const memberIds = Array.from(new Set([session.id, ...(await resolveEnvironmentMemberIds(session.id))]))
  const mine = await listEquityReleasesForUsers(memberIds)
  const openSameCcy = mine.find(
    (r) => r.currency === currency && (r.status === "pending" || r.status === "scheduled"),
  )
  if (openSameCcy) {
    return {
      ok: false,
      error: `You already have a ${currency} release request awaiting the administrator. Please wait for it to be actioned.`,
    }
  }

  const profile = await resolveAccountProfileById(session.id)
  const holderLabel = profile.company || profile.fullName || session.id
  const id = `EQR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  await createEquityReleaseRequest({
    id,
    userId: session.id,
    ownerId,
    holderLabel,
    currency,
    requestedAmount: amount,
  })

  // Signal every administrator so the request surfaces in the panel + bell.
  try {
    const emails = adminEmails()
    const seen = new Set<string>()
    for (const email of emails) {
      const admin = await getDynamicUserByEmail(email)
      if (!admin || seen.has(admin.id)) continue
      seen.add(admin.id)
      await insertNotification({
        userId: admin.id,
        tone: "info",
        title: "Equity release requested",
        body: `${holderLabel} requested to release ${fmtMoney(amount, currency)} of blocked equity. Review and negotiate the terms.`,
        href: "/dashboard/admin",
      }).catch(() => {})
    }
  } catch {
    /* best-effort */
  }

  await logActivity({
    category: "Treasury",
    action: "Equity release requested",
    details: { amount, currency },
  }).catch(() => {})

  return { ok: true, data: { reference: id } }
}

/** CUSTOMER — list my own release requests (any status). */
export async function getMyEquityReleaseRequests(): Promise<EquityReleaseRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    const memberIds = Array.from(new Set([session.id, ...(await resolveEnvironmentMemberIds(session.id))]))
    return await listEquityReleasesForUsers(memberIds)
  } catch {
    return []
  }
}

/** CUSTOMER — withdraw a still-pending release request (equity stays blocked). */
export async function cancelMyEquityRelease(id: string): Promise<EquityResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  const req = await getEquityReleaseById(id)
  if (!req) return { ok: false, error: "Release request not found." }
  const memberIds = Array.from(new Set([session.id, ...(await resolveEnvironmentMemberIds(session.id))]))
  if (!memberIds.includes(req.userId)) return { ok: false, error: "You cannot modify this request." }
  if (req.status !== "pending") {
    return { ok: false, error: "Only a request still awaiting the administrator can be withdrawn." }
  }
  await updateEquityRelease(id, { status: "cancelled", decidedAt: new Date().toISOString() })
  await logActivity({ category: "Treasury", action: "Equity release withdrawn", details: { id } }).catch(() => {})
  return { ok: true, data: { reference: id } }
}

/** ADMIN — active release queue (pending + scheduled). */
export async function listEquityReleasesAdmin(passcode: string): Promise<EquityReleaseRequest[]> {
  if (!(await adminActionAuthorized(passcode))) return []
  try {
    return await listActiveEquityReleases()
  } catch {
    return []
  }
}

/** ADMIN — count requests awaiting a decision (command-center tile). */
export async function countPendingEquityReleasesAdmin(passcode: string): Promise<number> {
  if (!(await adminActionAuthorized(passcode))) return 0
  try {
    return await countPendingEquityReleases()
  } catch {
    return 0
  }
}

/**
 * ADMIN — decide a release request. The admin negotiates the amount, the
 * modality and the time. `releaseAt` in the future schedules a lazy auto-credit;
 * null/past credits immediately.
 */
export async function decideEquityReleaseAdmin(
  passcode: string,
  id: string,
  input: {
    approve: boolean
    amount?: number
    releaseAt?: string | null
    modality?: string
    note?: string
  },
): Promise<EquityResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  const req = await getEquityReleaseById(id)
  if (!req) return { ok: false, error: "Release request not found." }
  // Pending requests can be approved/declined; already-scheduled requests can be
  // brought forward (approve now) or cancelled (decline) before they auto-credit.
  if (req.status !== "pending" && req.status !== "scheduled") {
    return { ok: false, error: "This request has already been actioned." }
  }

  const modality = (input.modality || "").trim() || null
  const note = (input.note || "").trim() || null

  if (!input.approve) {
    await updateEquityRelease(id, {
      status: "rejected",
      decidedAt: new Date().toISOString(),
      modality,
      adminNote: note,
    })
    await insertNotification({
      userId: req.userId,
      tone: "warning",
      title: "Equity release declined",
      body: `Your request to release ${fmtMoney(req.requestedAmount, req.currency)} was declined by the administrator.${note ? ` Note: ${note}` : ""}`,
      href: "/dashboard/equity-saving",
    }).catch(() => {})
    await logActivity({ category: "Treasury", action: "Equity release rejected", details: { id, currency: req.currency } }).catch(() => {})
    return { ok: true, data: { reference: id } }
  }

  // Negotiated amount (cannot exceed the requested amount).
  const approved = round2(Math.min(input.amount != null ? Number(input.amount) : req.requestedAmount, req.requestedAmount))
  if (!Number.isFinite(approved) || approved <= 0) {
    return { ok: false, error: "Enter a release amount greater than zero." }
  }

  const when = input.releaseAt ? new Date(input.releaseAt) : null
  const isFuture = when != null && !Number.isNaN(when.getTime()) && when.getTime() > Date.now() + 30_000

  if (isFuture) {
    await updateEquityRelease(id, {
      status: "scheduled",
      approvedAmount: approved,
      modality,
      adminNote: note,
      releaseAt: when!.toISOString(),
      decidedAt: new Date().toISOString(),
    })
    await insertNotification({
      userId: req.userId,
      tone: "info",
      title: "Equity release scheduled",
      body: `The administrator approved releasing ${fmtMoney(approved, req.currency)}. It will credit your Master Account on ${when!.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.${modality ? ` Terms: ${modality}` : ""}`,
      href: "/dashboard/equity-saving",
    }).catch(() => {})
    await logActivity({ category: "Treasury", action: "Equity release scheduled", details: { id, approved, currency: req.currency, releaseAt: when!.toISOString() } }).catch(() => {})
    return { ok: true, data: { reference: id } }
  }

  // Immediate release — unblock now.
  const released = await shrinkEquityHold(req.ownerId, req.currency, approved)
  await updateEquityRelease(id, {
    status: "released",
    approvedAmount: approved,
    modality,
    adminNote: note,
    releaseAt: null,
    decidedAt: new Date().toISOString(),
    releasedAt: new Date().toISOString(),
    releasedEntryId: equityEntryId(req.currency),
  })
  await insertNotification({
    userId: req.userId,
    tone: "success",
    title: "Equity released to your Master Account",
    body: `${fmtMoney(round2(released), req.currency)} has been released to your spendable Master Account balance.${modality ? ` Terms: ${modality}` : ""}`,
    href: "/dashboard/equity-saving",
  }).catch(() => {})
  await logActivity({ category: "Treasury", action: "Equity release approved", details: { id, released, currency: req.currency } }).catch(() => {})
  return { ok: true, data: { reference: id } }
}

