import "server-only"
import { query } from "@/lib/db"
import type { SubAccount, SubAccountStatus, SubAccountVerification, SubAccountDoc } from "@/lib/sub-account-types"
import { buildSubAccountFeeEntries } from "@/lib/sub-account-fees"
import { upsertLedgerEntry } from "@/lib/ledger-db"

/** Coerce a jsonb column (already parsed by node-postgres, or a JSON string) into
 *  the document array shape, tolerating null/legacy values. */
function parseDocs(value: unknown): SubAccountDoc[] | undefined {
  if (!value) return undefined
  let arr: unknown = value
  if (typeof value === "string") {
    try {
      arr = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return Array.isArray(arr) ? (arr as SubAccountDoc[]) : undefined
}

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
  // Additive migrations for the sub-account's own beneficiary (idempotent).
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS beneficiary_name text`)
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS beneficiary_details text`)
  // Additive migrations for UBO verification (KYC/passport) vs alias liability.
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS verification text NOT NULL DEFAULT 'alias'`)
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS kyc_documents jsonb`)
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS legal_ack_at timestamptz`)
  // Lifecycle anchors for tariff accrual: activation date (annual-fee anchor,
  // preserved through closure) and closure date (stops annual accrual).
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS activated_at timestamptz`)
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS closed_at timestamptz`)
  // Client-side dismissal: the owner can purge DECLINED requests from their view
  // without affecting the administrator record. Owner-scoped, persisted so the
  // purge holds across devices.
  await query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS dismissed_at timestamptz`)
  ensured = true
}

function rowToSubAccount(r: Record<string, unknown>): SubAccount {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    label: (r.label as string) ?? "",
    currency: (r.currency as string) ?? "EUR",
    purpose: (r.purpose as string) ?? undefined,
    beneficiaryName: (r.beneficiary_name as string) ?? undefined,
    beneficiaryDetails: (r.beneficiary_details as string) ?? undefined,
    verification: ((r.verification as string) ?? "alias") as SubAccountVerification,
    kycDocuments: parseDocs(r.kyc_documents),
    legalResponsibilityAcceptedAt: r.legal_ack_at ? new Date(r.legal_ack_at as string).toISOString() : undefined,
    status: ((r.status as string) ?? "pending") as SubAccountStatus,
    iban: (r.iban as string) ?? undefined,
    bic: (r.bic as string) ?? undefined,
    adminNote: (r.admin_note as string) ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : new Date().toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : undefined,
    activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : undefined,
    closedAt: r.closed_at ? new Date(r.closed_at as string).toISOString() : undefined,
  }
}

/** Insert a brand-new sub-account request (status = pending). */
export async function insertSubAccount(input: {
  id: string
  userId: string
  label: string
  currency: string
  purpose?: string
  beneficiaryName?: string
  beneficiaryDetails?: string
  verification: SubAccountVerification
  kycDocuments?: SubAccountDoc[]
  legalResponsibilityAcceptedAt?: string
}): Promise<SubAccount> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO sub_accounts
       (id, user_id, label, currency, purpose, beneficiary_name, beneficiary_details,
        verification, kyc_documents, legal_ack_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'pending') RETURNING *`,
    [
      input.id,
      input.userId,
      input.label,
      input.currency,
      input.purpose ?? null,
      input.beneficiaryName ?? null,
      input.beneficiaryDetails ?? null,
      input.verification,
      input.kycDocuments && input.kycDocuments.length ? JSON.stringify(input.kycDocuments) : null,
      input.legalResponsibilityAcceptedAt ?? null,
    ],
  )
  return rowToSubAccount(rows[0])
}

/** Owner-scoped update of a sub-account's own beneficiary (managed by the client). */
export async function updateSubAccountBeneficiary(
  id: string,
  userId: string,
  input: { beneficiaryName?: string; beneficiaryDetails?: string },
): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE sub_accounts
        SET beneficiary_name = $3, beneficiary_details = $4
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [id, userId, input.beneficiaryName ?? null, input.beneficiaryDetails ?? null],
  )
  return rows[0] ? rowToSubAccount(rows[0]) : null
}

/** All sub-accounts owned by a user (most recent first), excluding any the
 *  client has purged from their view. */
export async function listSubAccountsForUser(userId: string): Promise<SubAccount[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM sub_accounts WHERE user_id = $1 AND dismissed_at IS NULL ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(rowToSubAccount)
}

/**
 * Client purge: hide every DECLINED (rejected) request from the owner's view.
 * Owner-scoped; only rejected rows are affected so live/pending/active
 * sub-accounts are never touched. The administrator record is unchanged (admin
 * lists use listAllSubAccounts). Returns how many were purged.
 */
export async function dismissDeclinedSubAccounts(userId: string): Promise<number> {
  await ensureTable()
  const { rowCount } = await query(
    `UPDATE sub_accounts
        SET dismissed_at = now()
      WHERE user_id = $1 AND status = 'rejected' AND dismissed_at IS NULL`,
    [userId],
  )
  return rowCount ?? 0
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
        SET status = 'active', iban = $2, bic = $3, admin_note = $4,
            decided_at = now(), activated_at = COALESCE(activated_at, now())
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

/**
 * Post any sub-account tariffs (service / annual / closing) that have accrued
 * for an owner but are not yet on the ledger. Runs on every ledger read so the
 * recurring ANNUAL fee accrues cross-device with no scheduler; deterministic
 * `SUBA-*` ids make it idempotent (existing rows are skipped). Charges land on
 * the owner's MASTER ledger, so tariffs reflect on the Master Account.
 */
export async function reconcileSubAccountFees(ownerId: string, now: Date = new Date()): Promise<void> {
  await ensureTable()
  const subs = await listSubAccountsForUser(ownerId)
  const relevant = subs.filter((s) => s.status === "active" || s.status === "closed")
  if (!relevant.length) return

  const existing = new Set<string>()
  const { rows } = await query(`SELECT entry_id FROM ledger_entries WHERE user_id = $1 AND entry_id LIKE 'SUBA-%'`, [
    ownerId,
  ])
  for (const r of rows) existing.add(String((r as Record<string, unknown>).entry_id))

  const nowIso = now.toISOString()
  for (const sub of relevant) {
    for (const post of buildSubAccountFeeEntries(sub, nowIso)) {
      if (existing.has(post.id)) continue
      await upsertLedgerEntry(ownerId, post)
      existing.add(post.id)
    }
  }
}

/** Administrator: close an active sub-account (kept for the audit trail). */
export async function closeSubAccount(id: string, adminNote?: string): Promise<SubAccount | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE sub_accounts
        SET status = 'closed', admin_note = COALESCE($2, admin_note),
            decided_at = now(), closed_at = COALESCE(closed_at, now())
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [id, adminNote ?? null],
  )
  return rows[0] ? rowToSubAccount(rows[0]) : null
}
