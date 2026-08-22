import "server-only"
import { query } from "@/lib/db"
import type { LedgerEntry } from "@/lib/ledger-store"

/**
 * Server-only helpers for the authoritative ledger, shared by the approvals
 * workflow so that approving a financial request (e.g. an outgoing payment)
 * actually moves the client's balance in Neon. The table definition mirrors the
 * one bootstrapped in app/actions/ledger.ts (CREATE IF NOT EXISTS is idempotent
 * so both entry points are safe).
 */

let ensured = false

async function ensureLedgerTable(): Promise<void> {
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
  // Additive migration (idempotent): the client's own receiving account (IBAN)
  // this payment landed in, for per-bank attribution.
  await query(`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS received_account text`)
  // Additive migration (idempotent): sub-account compartment tag (NULL ⇒ main).
  await query(`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS sub_account_id text`)
  ensured = true
}

/** Read every ledger entry for a user (most recent first). */
export async function readLedgerEntries(userId: string): Promise<LedgerEntry[]> {
  await ensureLedgerTable()
  const { rows } = await query(
    `SELECT entry_id, direction, amount, currency, status, entry_date,
            counterparty, account, bank, reference, comment, category, received_account, sub_account_id
       FROM ledger_entries WHERE user_id = $1 ORDER BY entry_date DESC`,
    [userId],
  )
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.entry_id),
    direction: r.direction as LedgerEntry["direction"],
    amount: Number(r.amount),
    currency: String(r.currency),
    status: r.status as LedgerEntry["status"],
    date: new Date(r.entry_date as string).toISOString(),
    counterparty: String(r.counterparty ?? ""),
    account: (r.account as string) ?? undefined,
    bank: (r.bank as string) ?? undefined,
    receivedAccount: (r.received_account as string) ?? undefined,
    reference: (r.reference as string) ?? undefined,
    comment: (r.comment as string) ?? undefined,
    category: (r.category as string) ?? undefined,
    subAccountId: (r.sub_account_id as string) ?? undefined,
  }))
}

/**
 * Available (spendable) balance per currency from a set of ledger entries:
 * settled credits − settled debits − held debits. Mirrors the client store's
 * `balanceFor`, so server-side reservation decisions match what the client sees.
 */
export function availableByCurrency(entries: LedgerEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) {
    const cur = e.currency || "USD"
    if (out[cur] === undefined) out[cur] = 0
    if (e.status === "hold") {
      if (e.direction === "debit") out[cur] -= e.amount
    } else {
      out[cur] += e.direction === "credit" ? e.amount : -e.amount
    }
  }
  return out
}

/**
 * Permanently remove a single ledger entry for a user (by entry id). Used to
 * RELEASE a reservation/hold — e.g. when an approved commodity deal is revoked,
 * deleting its `APPR-<id>` hold returns (unfreezes) the blocked funds to the
 * client's available balance. Returns true if a row was deleted.
 */
export async function deleteLedgerEntry(userId: string, entryId: string): Promise<boolean> {
  await ensureLedgerTable()
  const { rowCount } = await query(
    `DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`,
    [userId, entryId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Hard, database-level non-negativity guard. Recomputes the owner's AVAILABLE
 * balance per currency directly from the persisted rows and throws if any
 * currency is overdrawn (beyond a one-cent rounding tolerance). Call this after
 * posting reservation/debit effects so a negative balance can NEVER be left
 * committed — the caller is expected to roll back and surface the failure.
 */
export async function assertOwnerSolvent(userId: string): Promise<void> {
  await ensureLedgerTable()
  const entries = await readLedgerEntries(userId)
  const balances = availableByCurrency(entries)
  for (const [currency, balance] of Object.entries(balances)) {
    if (balance < -0.01) {
      throw new Error(
        `INSUFFICIENT_FUNDS: posting would overdraw ${currency} (available ${balance.toFixed(2)})`,
      )
    }
  }
}

/** Insert or update a single ledger entry for a user. */
export async function upsertLedgerEntry(userId: string, entry: LedgerEntry): Promise<void> {
  await ensureLedgerTable()
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
