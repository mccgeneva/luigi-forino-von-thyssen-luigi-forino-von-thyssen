import "server-only"
import { query } from "@/lib/db"

/**
 * EQUITY RELEASE REQUESTS.
 *
 * A customer can no longer self-release blocked equity. Instead they submit a
 * release REQUEST; only an administrator can approve it, negotiating the amount,
 * the modality (how the funds are handed back) and the time it credits. The
 * actual unblocking (shrinking the `EQSAV-<CUR>` ledger hold) happens either
 * immediately on approval or lazily when a scheduled `release_at` passes.
 */

export type EquityReleaseStatus = "pending" | "scheduled" | "released" | "rejected" | "cancelled"

export interface EquityReleaseRequest {
  id: string
  /** Session id of the requester (used for notifications + "my requests"). */
  userId: string
  /** Master data-owner id whose ledger holds the `EQSAV-<CUR>` block. */
  ownerId: string
  /** Human label for the admin queue. */
  holderLabel: string
  currency: string
  requestedAmount: number
  /** Amount the admin agreed to release (may be partial). Null until decided. */
  approvedAmount: number | null
  status: EquityReleaseStatus
  /** Admin-negotiated modality/terms of the release. */
  modality: string | null
  adminNote: string | null
  /** When the release should credit. Null = immediate on approval. */
  releaseAt: string | null
  createdAt: string
  decidedAt: string | null
  releasedAt: string | null
  releasedEntryId: string | null
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS equity_release_request (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      owner_id text NOT NULL,
      holder_label text NOT NULL DEFAULT '',
      currency text NOT NULL,
      requested_amount double precision NOT NULL,
      approved_amount double precision,
      status text NOT NULL DEFAULT 'pending',
      modality text,
      admin_note text,
      release_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz,
      released_at timestamptz,
      released_entry_id text
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS equity_release_status_idx ON equity_release_request (status)`)
  await query(`CREATE INDEX IF NOT EXISTS equity_release_user_idx ON equity_release_request (user_id)`)
  ensured = true
}

function rowTo(r: Record<string, unknown>): EquityReleaseRequest {
  const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString())
  return {
    id: String(r.id),
    userId: String(r.user_id),
    ownerId: String(r.owner_id),
    holderLabel: String(r.holder_label ?? ""),
    currency: String(r.currency),
    requestedAmount: Number(r.requested_amount),
    approvedAmount: r.approved_amount == null ? null : Number(r.approved_amount),
    status: String(r.status) as EquityReleaseStatus,
    modality: r.modality == null ? null : String(r.modality),
    adminNote: r.admin_note == null ? null : String(r.admin_note),
    releaseAt: iso(r.release_at),
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
    decidedAt: iso(r.decided_at),
    releasedAt: iso(r.released_at),
    releasedEntryId: r.released_entry_id == null ? null : String(r.released_entry_id),
  }
}

export async function createEquityReleaseRequest(input: {
  id: string
  userId: string
  ownerId: string
  holderLabel: string
  currency: string
  requestedAmount: number
}): Promise<EquityReleaseRequest> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO equity_release_request (id, user_id, owner_id, holder_label, currency, requested_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [input.id, input.userId, input.ownerId, input.holderLabel, input.currency.toUpperCase(), input.requestedAmount],
  )
  return rowTo(rows[0])
}

export async function getEquityReleaseById(id: string): Promise<EquityReleaseRequest | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM equity_release_request WHERE id = $1`, [id])
  return rows[0] ? rowTo(rows[0]) : null
}

/** Admin queue — requests still needing a decision or a pending scheduled credit. */
export async function listActiveEquityReleases(): Promise<EquityReleaseRequest[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM equity_release_request WHERE status IN ('pending','scheduled') ORDER BY created_at ASC`,
  )
  return rows.map(rowTo)
}

/** Requests still awaiting an ADMIN DECISION (drives the command-center count). */
export async function countPendingEquityReleases(): Promise<number> {
  await ensureTable()
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM equity_release_request WHERE status = 'pending'`)
  return Number(rows[0]?.n ?? 0)
}

/** A customer's own requests (any status), newest first. */
export async function listEquityReleasesForUsers(userIds: string[]): Promise<EquityReleaseRequest[]> {
  await ensureTable()
  if (userIds.length === 0) return []
  const { rows } = await query(
    `SELECT * FROM equity_release_request WHERE user_id = ANY($1) ORDER BY created_at DESC`,
    [userIds],
  )
  return rows.map(rowTo)
}

/** Scheduled releases whose credit time has arrived, for a given owner ledger. */
export async function listDueScheduledReleases(ownerId: string): Promise<EquityReleaseRequest[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM equity_release_request
     WHERE status = 'scheduled' AND owner_id = $1 AND release_at IS NOT NULL AND release_at <= now()
     ORDER BY release_at ASC`,
    [ownerId],
  )
  return rows.map(rowTo)
}

export async function updateEquityRelease(
  id: string,
  fields: Partial<{
    status: EquityReleaseStatus
    approvedAmount: number | null
    modality: string | null
    adminNote: string | null
    releaseAt: string | null
    decidedAt: string | null
    releasedAt: string | null
    releasedEntryId: string | null
  }>,
): Promise<EquityReleaseRequest | null> {
  await ensureTable()
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  const map: Record<string, string> = {
    status: "status",
    approvedAmount: "approved_amount",
    modality: "modality",
    adminNote: "admin_note",
    releaseAt: "release_at",
    decidedAt: "decided_at",
    releasedAt: "released_at",
    releasedEntryId: "released_entry_id",
  }
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) {
      sets.push(`${col} = $${i++}`)
      vals.push((fields as Record<string, unknown>)[k])
    }
  }
  if (sets.length === 0) return getEquityReleaseById(id)
  vals.push(id)
  const { rows } = await query(
    `UPDATE equity_release_request SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals,
  )
  return rows[0] ? rowTo(rows[0]) : null
}
