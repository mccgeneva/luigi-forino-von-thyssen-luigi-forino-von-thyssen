"use server"

import { query, isDatabaseConfigured } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveAccountProfileById, resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { listApprovalsForUser } from "@/lib/approvals-db"
import { reconcileSubAccountFees } from "@/lib/sub-account-db"
import { logActivity } from "@/app/actions/log-activity"
import { getMyMembership } from "@/app/actions/membership"
import { capabilitiesForAccount, VISITOR_RESTRICTION_MESSAGE } from "@/lib/tier-capabilities"
import type { LedgerEntry } from "@/lib/ledger-store"

// --- Session / admin helpers ------------------------------------------------

async function getSessionUser(): Promise<UserProfile | undefined> {
  const session = await resolveCurrentSession()
  return session?.profile
}

/**
 * The id whose ledger the signed-in session operates on. For a Sub-account this
 * is its Master's id (shared balance); for everyone else, their own id. Returns
 * undefined when there is no valid session.
 */
async function getDataOwnerId(): Promise<string | undefined> {
  const session = await resolveCurrentSession()
  return session?.dataOwnerId
}

async function requireAdmin(passcode: string): Promise<UserProfile> {
  const user = await getSessionUser()
  if (!user) throw new Error("Your session has expired. Please sign in again.")
  if (!(await adminActionAuthorized(passcode))) throw new Error("Administrator authorization failed.")
  return user
}

// --- Table bootstrap --------------------------------------------------------

let ensured = false

const DB_NOT_CONFIGURED_MSG =
  "The database is not connected yet. Add the Neon connection string (DATABASE_URL) in Project Settings → Environment Variables, then try again."

/**
 * Lazily create the ledger_entries table on first use. Mirrors the pattern used
 * by gateway/reconciliation/admin-users so the table exists before any read or
 * write — otherwise queries throw and reads silently return empty, which makes
 * edit/reverse report "entry does not exist".
 */
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS ledger_entries (
       user_id      text        NOT NULL,
       entry_id     text        NOT NULL,
       direction    text        NOT NULL,
       amount       numeric     NOT NULL DEFAULT 0,
       currency     text        NOT NULL DEFAULT 'USD',
       status       text        NOT NULL DEFAULT 'completed',
       entry_date   timestamptz NOT NULL DEFAULT now(),
       counterparty text,
       account      text,
       bank         text,
       reference    text,
       comment      text,
       category     text,
       PRIMARY KEY (user_id, entry_id)
     )`,
  )
  // Additive migration for databases created before per-bank attribution: the
  // client's own receiving account (IBAN) the funds landed in. Idempotent.
  await query(`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS received_account text`)
  // Additive migration for client sub-accounts: which isolated compartment this
  // entry belongs to. NULL ⇒ the user's MAIN account. Idempotent.
  await query(`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS sub_account_id text`)
  ensured = true
}

// --- Row mapping ------------------------------------------------------------

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    id: row.entry_id as string,
    direction: (row.direction as LedgerEntry["direction"]) ?? "credit",
    amount: Number(row.amount) || 0,
    currency: (row.currency as string) ?? "USD",
    status: (row.status as LedgerEntry["status"]) ?? "completed",
    date: row.entry_date ? new Date(row.entry_date as string).toISOString() : new Date().toISOString(),
    counterparty: (row.counterparty as string) ?? "",
    account: (row.account as string) ?? undefined,
    bank: (row.bank as string) ?? undefined,
    receivedAccount: (row.received_account as string) ?? undefined,
    reference: (row.reference as string) ?? undefined,
    comment: (row.comment as string) ?? undefined,
    category: (row.category as string) ?? undefined,
    subAccountId: (row.sub_account_id as string) ?? undefined,
  }
}

async function readLedger(userId: string): Promise<LedgerEntry[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY entry_date DESC`,
    [userId],
  )
  return rows.map(rowToEntry)
}

async function upsertEntry(userId: string, entry: LedgerEntry): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO ledger_entries
       (user_id, entry_id, direction, amount, currency, status, entry_date,
        counterparty, account, bank, reference, comment, category, received_account, sub_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (user_id, entry_id) DO UPDATE SET
       direction = EXCLUDED.direction,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       status = EXCLUDED.status,
       entry_date = EXCLUDED.entry_date,
       counterparty = EXCLUDED.counterparty,
       account = EXCLUDED.account,
       bank = EXCLUDED.bank,
       reference = EXCLUDED.reference,
       comment = EXCLUDED.comment,
       category = EXCLUDED.category,
       received_account = EXCLUDED.received_account,
       sub_account_id = EXCLUDED.sub_account_id`,
    [
      userId,
      entry.id,
      entry.direction,
      entry.amount,
      entry.currency,
      entry.status,
      entry.date,
      entry.counterparty ?? "",
      entry.account ?? null,
      entry.bank ?? null,
      entry.reference ?? null,
      entry.comment ?? null,
      entry.category ?? null,
      entry.receivedAccount ?? null,
      entry.subAccountId ?? null,
    ],
  )
}

// --- Customer-facing (own ledger only) --------------------------------------

/**
 * Return the signed-in user's ledger entries. Scoped to the data-owner id, so a
 * Sub-account transparently reads its Master's shared balance.
 */
export async function getMyLedger(): Promise<LedgerEntry[]> {
  const ownerId = await getDataOwnerId()
  if (!ownerId) return []
  try {
    // Accrue any due sub-account tariffs (recurring annual fee) before reading,
    // so the master ledger is always current. Best-effort — never block a read.
    try {
      await reconcileSubAccountFees(ownerId)
    } catch (err) {
      console.log("[v0] reconcileSubAccountFees failed:", (err as Error).message)
    }
    return await readLedger(ownerId)
  } catch (err) {
    console.log("[v0] getMyLedger query failed:", (err as Error).message)
    return []
  }
}

/** Persist (insert or update) a single ledger entry for the signed-in user
 *  (or, for a sub, the shared Master ledger). */
export async function persistMyLedgerEntry(entry: LedgerEntry): Promise<{ ok: boolean }> {
  const ownerId = await getDataOwnerId()
  if (!ownerId) return { ok: false }
  try {
    await upsertEntry(ownerId, entry)
    return { ok: true }
  } catch (err) {
    console.log("[v0] persistMyLedgerEntry failed:", (err as Error).message)
    return { ok: false }
  }
}

/** Remove a single ledger entry for the signed-in user (shared Master ledger
 *  for a sub). */
export async function removeMyLedgerEntry(entryId: string): Promise<{ ok: boolean }> {
  const ownerId = await getDataOwnerId()
  if (!ownerId) return { ok: false }
  try {
    await ensureTable()
    await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ownerId, entryId])
    return { ok: true }
  } catch (err) {
    console.log("[v0] removeMyLedgerEntry failed:", (err as Error).message)
    return { ok: false }
  }
}

/**
 * Net available balance for a currency from a server-side ledger: settled
 * credits − settled debits − held debits. Mirrors the client `balanceFor` so
 * the server enforces the same spendable amount.
 */
function availableBalanceFor(entries: LedgerEntry[], currency: string): number {
  let settled = 0
  let held = 0
  for (const e of entries) {
    if (e.currency !== currency) continue
    if (e.status === "completed") {
      settled += e.direction === "credit" ? e.amount : -e.amount
    } else if (e.status === "hold" && e.direction === "debit") {
      held += e.amount
    }
  }
  return settled - held
}

export type InstantTransferResult =
  | { ok: true; reference: string; entries: LedgerEntry[] }
  | { ok: false; error: string }

/**
 * Execute an instant internal P2P transfer SERVER-SIDE so it is durable and
 * visible to both parties on any device/browser. Previously the credit was
 * written only to the sender's browser localStorage, so the recipient saw the
 * money on the same browser (shared localStorage) but not when logging in
 * elsewhere. This posts BOTH legs to the Neon ledger: a debit on the sender's
 * (data-owner) ledger and a credit on the recipient's (data-owner) ledger.
 */
export async function sendInstantTransfer(input: {
  recipientEmail: string
  amount: number
  currency: string
  note?: string
  reference?: string
}): Promise<InstantTransferResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  // Tier gate: guards outgoing transfers. Visitor accounts may now send money
  // (canSendMoney is true), so this only blocks any future tier that has money-out
  // disabled. An active PRO/Avant-Garde grant always resolves to full access.
  // Incoming credits are never restricted here or on the recipient's tier.
  const membership = await getMyMembership()
  if (!capabilitiesForAccount(session.profile.accountBadge, membership).canSendMoney) {
    return { ok: false, error: VISITOR_RESTRICTION_MESSAGE }
  }

  if (!isDatabaseConfigured) return { ok: false, error: DB_NOT_CONFIGURED_MSG }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid amount greater than 0." }
  }
  const currency = (input.currency || "EUR").toUpperCase()
  const email = (input.recipientEmail || "").trim().toLowerCase()
  if (!email) return { ok: false, error: "Enter the recipient's registered email address." }

  // Resolve recipient against the durable account directory.
  const recipient = await getDynamicUserByEmail(email)
  if (!recipient || recipient.status !== "active") {
    return { ok: false, error: "No active platform account is registered to that email address." }
  }

  const senderOwnerId = session.dataOwnerId
  const recipientOwnerId = await resolveDataOwnerIdFor(recipient.id)
  if (senderOwnerId === recipientOwnerId) {
    return { ok: false, error: "You cannot send an instant transfer to your own account." }
  }

  try {
    // Server-side balance enforcement: never allow an overdraft.
    const senderEntries = await readLedger(senderOwnerId)
    const available = availableBalanceFor(senderEntries, currency)
    if (amount > available) {
      return {
        ok: false,
        error: `Insufficient funds. This transfer needs ${currency} ${amount.toLocaleString("en-US")} but only ${currency} ${available.toLocaleString("en-US")} is available.`,
      }
    }

    const ref = (input.reference || "").trim() || `ITR-${Date.now().toString().slice(-8)}`
    const nowIso = new Date().toISOString()
    const senderProfile = session.profile
    const senderLabel = `${senderProfile.fullName || senderProfile.company} (${senderProfile.email})`
    const recipientLabel = `${recipient.profile.fullName || recipient.profile.company || recipient.email} (${recipient.email})`
    const note = (input.note || "").trim()

    // Credit the recipient (shared owner ledger). Distinct entry id so it never
    // collides with the sender's debit under the same (user_id, entry_id) key.
    await upsertEntry(recipientOwnerId, {
      id: `${ref}-IN`,
      direction: "credit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: senderLabel,
      account: senderProfile.email,
      bank: "MCC Capital — Internal Transfer",
      reference: ref,
      comment: note || `Internal transfer received from ${senderLabel}.`,
      category: "Internal Transfer",
    })

    // Debit the sender (shared owner ledger).
    await upsertEntry(senderOwnerId, {
      id: `${ref}-OUT`,
      direction: "debit",
      amount,
      currency,
      status: "completed",
      date: nowIso,
      counterparty: recipientLabel,
      account: recipient.email,
      bank: "MCC Capital — Internal Transfer",
      reference: ref,
      comment: note || `Internal transfer sent to ${recipientLabel}.`,
      category: "Internal Transfer",
    })

    await logActivity({
      action: `Sent an instant internal transfer of ${currency} ${amount.toLocaleString("en-US")} to ${recipient.email}`,
      category: "Payments",
      details: {
        summary: `Instant internal P2P transfer of ${currency} ${amount.toLocaleString("en-US")} from ${senderLabel} to ${recipientLabel}. Settled in real time on the server ledger. Reference: ${ref}.`,
        referenceId: ref,
        recipientEmail: recipient.email,
        amount: `${currency} ${amount.toLocaleString("en-US")}`,
        currency,
        note: note || "(none)",
        settlement: "Instant / Internal",
      },
    })

    return { ok: true, reference: ref, entries: await readLedger(senderOwnerId) }
  } catch (err) {
    console.log("[v0] sendInstantTransfer failed:", (err as Error).message)
    return { ok: false, error: "The transfer could not be completed. Please try again." }
  }
}

// --- Admin cross-user (passcode verified server-side) -----------------------

export type AdminLedgerResult =
  | { ok: true; entries: LedgerEntry[] }
  | { ok: false; error: string }

/** Admin: read any client's ledger. Scoped to the data-owner id so a Sub-account
 *  shows the SAME shared Master balance the client itself sees. */
export async function getLedgerForUserAdmin(passcode: string, userId: string): Promise<AdminLedgerResult> {
  try {
    await requireAdmin(passcode)
    const ownerId = await resolveDataOwnerIdFor(userId)
    return { ok: true, entries: await readLedger(ownerId) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Admin: credit or debit a client's ledger with a single entry. */
export async function addLedgerEntryForUserAdmin(
  passcode: string,
  userId: string,
  entry: LedgerEntry,
): Promise<AdminLedgerResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(entry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid amount." }
  }

  if (!isDatabaseConfigured) {
    return { ok: false, error: DB_NOT_CONFIGURED_MSG }
  }

  try {
    // Post to the data-owner ledger so crediting a Sub-account lands on the
    // shared Master balance the client actually reads (otherwise the credit
    // would silently sit on the sub's own, never-displayed ledger).
    const ownerId = await resolveDataOwnerIdFor(userId)
    await upsertEntry(ownerId, { ...entry, amount })
    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator posted a ${entry.direction} of ${entry.currency} ${amount.toLocaleString("en-US")} to ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: entry.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        direction: entry.direction,
        amount: `${entry.currency} ${amount.toLocaleString("en-US")}`,
        counterparty: entry.counterparty || "(none)",
        comment: entry.comment ?? "(none)",
      },
    })
    return { ok: true, entries: await readLedger(ownerId) }
  } catch (err) {
    console.log("[v0] addLedgerEntryForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "The entry could not be posted. Please try again." }
  }
}

/** A registered receiving account the admin can attribute an incoming payment
 *  to, so it surfaces as a per-bank sub-balance on the client's accounts page. */
export interface RegisteredAccountOption {
  id: string
  bankName: string
  iban: string
  currency: string
}

export type RegisteredAccountsResult =
  | { ok: true; accounts: RegisteredAccountOption[] }
  | { ok: false; error: string }

/**
 * Admin: list a client's APPROVED registered (external) bank accounts so an
 * incoming payment can be attributed to the specific bank it landed in. The
 * resulting `receivedAccount` IBAN is what the client's accounts page matches
 * to show a per-bank sub-balance (while the funds also feed the master
 * Settlement Account, never double-counted).
 */
export async function listRegisteredAccountsForUserAdmin(
  passcode: string,
  userId: string,
): Promise<RegisteredAccountsResult> {
  try {
    await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const approvals = await listApprovalsForUser(userId, "bank_account")
    const accounts = approvals
      .filter((a) => a.status === "approved")
      .map((a) => {
        const p = (a.payload ?? {}) as { bankName?: string; iban?: string; currency?: string }
        return {
          id: a.id,
          bankName: p.bankName ?? "Registered account",
          iban: p.iban ?? "",
          currency: p.currency ?? "EUR",
        }
      })
      .filter((a) => a.iban.trim().length > 0)
    return { ok: true, accounts }
  } catch (err) {
    console.log("[v0] listRegisteredAccountsForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not load the client's registered accounts." }
  }
}

/** Admin: remove a single ledger entry from a client's ledger. */
export async function removeLedgerEntryForUserAdmin(
  passcode: string,
  userId: string,
  entryId: string,
): Promise<AdminLedgerResult> {
  try {
    await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    await ensureTable()
    const ownerId = await resolveDataOwnerIdFor(userId)
    await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ownerId, entryId])
    return { ok: true, entries: await readLedger(ownerId) }
  } catch (err) {
    console.log("[v0] removeLedgerEntryForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "The entry could not be removed. Please try again." }
  }
}

/**
 * Admin: edit an existing ledger entry in place (amount, status, dates,
 * counterparty, etc.). Reuses the upsert so any subset of fields can be
 * corrected — e.g. releasing a hold by switching status to "completed".
 */
export async function updateLedgerEntryForUserAdmin(
  passcode: string,
  userId: string,
  entry: LedgerEntry,
): Promise<AdminLedgerResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(entry.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid amount." }
  }

  if (!isDatabaseConfigured) {
    return { ok: false, error: DB_NOT_CONFIGURED_MSG }
  }

  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    await upsertEntry(ownerId, { ...entry, amount })
    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator edited ledger entry ${entry.id} for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: entry.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        direction: entry.direction,
        amount: `${entry.currency} ${amount.toLocaleString("en-US")}`,
        status: entry.status,
        counterparty: entry.counterparty || "(none)",
      },
    })
    return { ok: true, entries: await readLedger(ownerId) }
  } catch (err) {
    console.log("[v0] updateLedgerEntryForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "The entry could not be updated. Please try again." }
  }
}

/**
 * Admin: reverse an existing ledger entry by posting a mirror entry in the
 * opposite direction. The original is preserved for the audit trail; the
 * reversal nets the balance back to where it was.
 */
export async function reverseLedgerEntryForUserAdmin(
  passcode: string,
  userId: string,
  entryId: string,
): Promise<AdminLedgerResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    const ownerId = await resolveDataOwnerIdFor(userId)
    const ledger = await readLedger(ownerId)
    const original = ledger.find((e) => e.id === entryId)
    if (!original) return { ok: false, error: "Original entry not found." }

    const reversal: LedgerEntry = {
      ...original,
      id: `REV-${original.id}`,
      direction: original.direction === "credit" ? "debit" : "credit",
      status: "completed",
      date: new Date().toISOString(),
      reference: `Reversal of ${original.id}`,
      comment: `Reversal of transaction ${original.id}${original.comment ? ` — ${original.comment}` : ""}`,
      category: "Reversal",
    }
    await upsertEntry(ownerId, reversal)

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator reversed ledger entry ${original.id} for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: reversal.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        reversedEntry: original.id,
        direction: reversal.direction,
        amount: `${original.currency} ${Number(original.amount).toLocaleString("en-US")}`,
      },
    })
    return { ok: true, entries: await readLedger(ownerId) }
  } catch (err) {
    console.log("[v0] reverseLedgerEntryForUserAdmin failed:", (err as Error).message)
    return { ok: false, error: "The entry could not be reversed. Please try again." }
  }
}

// --- Client financial snapshot (for approval due-diligence) ------------------

/** A single currency line in a client's financial snapshot. */
export interface CurrencyBalance {
  currency: string
  /** Net settled balance (completed credits − completed debits). */
  available: number
  /** Amount currently on hold (not yet settled). */
  onHold: number
}

export interface ClientFinancialSnapshot {
  userId: string
  fullName: string
  company: string
  email: string
  accountBadge: string
  relationship?: string
  country?: string
  /** Per-currency balances, richest first. */
  balances: CurrencyBalance[]
  totalEntries: number
  lastActivity?: string
}

export type ClientSnapshotResult =
  | { ok: true; snapshot: ClientFinancialSnapshot }
  | { ok: false; error: string }

/**
 * Admin: assemble a financial-capability snapshot for a client. Returns the
 * client's profile basics plus per-currency settled balances and on-hold totals
 * computed from the durable ledger, so an administrator reviewing a deal can
 * judge whether the client can actually fund it. Passcode-gated.
 */
export async function getClientFinancialSnapshotAdmin(
  passcode: string,
  userId: string,
): Promise<ClientSnapshotResult> {
  try {
    await requireAdmin(passcode)
    // Balances come from the shared data-owner ledger (a Sub-account funds from
    // its Master's pool); the profile stays keyed to the selected account.
    const ownerId = await resolveDataOwnerIdFor(userId)
    const [entries, profile] = await Promise.all([
      readLedger(ownerId),
      resolveAccountProfileById(userId),
    ])

    const byCurrency = new Map<string, CurrencyBalance>()
    for (const e of entries) {
      const cur = e.currency || "USD"
      const line = byCurrency.get(cur) ?? { currency: cur, available: 0, onHold: 0 }
      const signed = e.direction === "credit" ? e.amount : -e.amount
      if (e.status === "hold") {
        line.onHold += e.amount
      } else {
        line.available += signed
      }
      byCurrency.set(cur, line)
    }

    const balances = Array.from(byCurrency.values()).sort(
      (a, b) => Math.abs(b.available) - Math.abs(a.available),
    )

    const lastActivity = entries.length
      ? entries.reduce((latest, e) => (e.date > latest ? e.date : latest), entries[0].date)
      : undefined

    const country =
      profile.companyInfo?.find((i) => /country|nationality/i.test(i.label))?.value || undefined

    return {
      ok: true,
      snapshot: {
        userId,
        fullName: profile.fullName,
        company: profile.company,
        email: profile.email,
        accountBadge: profile.accountBadge,
        relationship: profile.relationship,
        country,
        balances,
        totalEntries: entries.length,
        lastActivity,
      },
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
