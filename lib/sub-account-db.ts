import "server-only"
import { query } from "@/lib/db"
import type { SubAccount, SubAccountStatus } from "@/lib/sub-account-types"

/**
 * Server-only persistence for client-managed sub-accounts (see
 * lib/sub-account-types.ts). One row per sub-account, keyed by its id and owned
 * by a user. The isolated balance itself lives in `ledger_entries` tagged with
 * `sub_account_id = <this id>`; this table only holds the compartment's
 * metadata and administrator-assigned banking coordinates.
 */

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS sub_accounts (
       id         text        PRIMARY KEY,
       user_id    text        NOT NULL,
       label      text        NOT NULL DEFAULT '',
       currency   text        NOT NULL DEFAULT 'EUR',
       purpose    text,
       status     text        NOT NULL DEFAULT 'pending',
       iban       text,
       bic        text,
       admin_note text,
       created_at timestamptz NOT NULL DEFAULT now(),
       decided_at timestamptz
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS sub_accounts_user_idx ON sub_accounts (user_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS sub_accounts_status_idx ON sub_accounts (status, created_at DESC)`)
  ensured = true
}

function rowToSubAccount(r: Record<string, unknown>): SubAccount {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    label: (r.label as string) ?? "",
    currency: (r.currency as string) ?? "EUR",
    purpose: (r.purpose as string) ?? undefined,
    status: ((r.status as string) ?? "pending") as SubAccountStatus,
    iban: (r.iban as string) ?? undefined,
    bic: (r.bic as string) ?? undefined,
    adminNote: (r.admin_note as string) ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : new Date().toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : undefined,
  }
}

/** Insert a brand-new sub-account request (status = pending). */
export async function insertSubAccount(input: {
  id: string
  userId: string
  label: string
  currency: string
  purpose?: string
}): Promise<SubAccount> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO sub_accounts (id, user_id, label, currency, purpose, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
    [input.id, input.userId, input.label, input.currency, input.purpose ?? null],
  )
  return rowToSubAccount(rows[0])
}

/** All sub-accounts owned by a user (most recent first). */
export async function listSubAccountsForUser(userId: string): Promise<SubAccount[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM sub_accounts WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
  return rows.map(rowToSubAccount)
}

/** A single sub-account by id (scoped nowhere — callers must check ownership). */
export async function getSubAccountById(id: string): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM sub_accounts WHERE id = $1`, [id])
  return rows[0] ? rowToSubAccount(rows[0]) : null
}

/** Every sub-account across all users, optionally filtered by status. Admin use. */
export async function listAllSubAccounts(status?: SubAccountStatus): Promise<SubAccount[]> {
  await ensureTable()
  const { rows } = status
    ? await query(`SELECT * FROM sub_accounts WHERE status = $1 ORDER BY created_at DESC`, [status])
    : await query(`SELECT * FROM sub_accounts ORDER BY created_at DESC`)
  return rows.map(rowToSubAccount)
}

/**
 * Administrator activation: assign IBAN/BIC and flip to active. Uses a guarded
 * WHERE so a request can only be activated once from the pending state.
 */
export async function activateSubAccount(
  id: string,
  input: { iban: string; bic?: string; adminNote?: string },
): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE sub_accounts
        SET status = 'active', iban = $2, bic = $3, admin_note = $4, decided_at = now()
      WHERE id = $1 AND status IN ('pending','rejected')
      RETURNING *`,
    [id, input.iban, input.bic ?? null, input.adminNote ?? null],
  )
  return rows[0] ? rowToSubAccount(rows[0]) : null
}

/** Administrator decision: reject a pending request. */
export async function rejectSubAccount(id: string, adminNote?: string): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE sub_accounts
        SET status = 'rejected', admin_note = $2, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, adminNote ?? null],
  )
  return rows[0] ? rowToSubAccount(rows[0]) : null
}

/** Administrator: close an active sub-account (kept for the audit trail). */
export async function closeSubAccount(id: string, adminNote?: string): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE sub_accounts
        SET status = 'closed', admin_note = COALESCE($2, admin_note), decided_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [id, adminNote ?? null],
  )
  return rows[0] ? rowToSubAccount(rows[0]) : null
}
