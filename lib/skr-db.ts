import "server-only"
import { pool, query } from "@/lib/db"

/**
 * Server-side persistence for the SKR (Safe Keeping Receipt) trading platform.
 *
 * SKR records and client requests were originally per-browser localStorage
 * lists. Because records are administrator-managed and *assigned to a specific
 * client* (and clients sign in on their own devices), localStorage made the
 * data neither durable nor visible cross-device — an admin could assign an SKR
 * on one browser that the client could never see on another. They are now
 * persisted in Neon, keyed by the owning client's user id, exactly like
 * client_beneficiaries.
 *
 * The full record / request object is stored as JSONB so the rich shape in
 * lib/skr-store.tsx (documents, transactions, etc.) can evolve without
 * migrations. The `status` column mirrors the JSON status for queryability.
 */

let ready: Promise<void> | null = null

async function ensureTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS client_skr_records (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          data         JSONB NOT NULL,
          status       TEXT NOT NULL DEFAULT 'active',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      await query(`CREATE INDEX IF NOT EXISTS client_skr_records_user_idx ON client_skr_records (user_id);`)
      await query(`
        CREATE TABLE IF NOT EXISTS client_skr_requests (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          data         JSONB NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      await query(`CREATE INDEX IF NOT EXISTS client_skr_requests_user_idx ON client_skr_requests (user_id);`)
    })().catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

export interface StoredSkr {
  id: string
  userId: string
  data: Record<string, unknown>
  status: string
  createdAt: string
  updatedAt: string
}

export interface SkrItemInput {
  id: string
  data: Record<string, unknown>
  status: string
}

function toStored(row: Record<string, unknown>): StoredSkr {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    data: row.data as Record<string, unknown>,
    status: row.status as string,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

export interface SkrExpertiseQueueItem {
  userId: string
  recordId: string
  kind: string
  status: string
  beneficialOwner: string
  faceValue: number
  currency: string
  requestedAt?: string
}

/**
 * Count SKR records with an expertise application AWAITING the custody desk
 * (status `requested`) — powers the admin command-center count/badge so a
 * customer application is discoverable, not just a transient bell.
 */
export async function countSkrExpertiseRequests(): Promise<number> {
  await ensureTables()
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM client_skr_records WHERE data->'expertise'->>'status' = 'requested'`,
  )
  return Number((rows[0] as { n?: number })?.n ?? 0)
}

/**
 * Cross-client queue of SKR expertise applications awaiting valuation. Carries
 * the owning `userId` so the admin SKR desk can jump straight to the client that
 * needs action (the manager is per-client, so a bare landing shows nothing).
 */
export async function listSkrExpertiseQueue(): Promise<SkrExpertiseQueueItem[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT id, user_id, data FROM client_skr_records
     WHERE data->'expertise'->>'status' = 'requested'
     ORDER BY updated_at DESC`,
  )
  return rows.map((row) => {
    const data = ((row as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>
    const exp = (data.expertise ?? {}) as Record<string, unknown>
    return {
      userId: String((row as { user_id: string }).user_id),
      recordId: String((row as { id: string }).id),
      kind: String(exp.kind ?? "Expertise"),
      status: String(exp.status ?? "requested"),
      beneficialOwner: String(data.beneficialOwner ?? ""),
      faceValue: Number(data.faceValue ?? 0),
      currency: String(data.currency ?? "USD"),
      requestedAt: exp.requestedAt ? String(exp.requestedAt) : undefined,
    }
  })
}

export interface SkrRequestQueueItem {
  userId: string
  requestId: string
  type: string
  message: string
  recordId: string
  status: string
  submittedAt?: string
}

/**
 * Count generic SKR service requests (Statement / Transfer / etc.) awaiting the
 * custody desk (status `pending`) — powers the admin command-center count so a
 * client request is discoverable, not just a transient bell.
 */
export async function countPendingSkrRequests(): Promise<number> {
  await ensureTables()
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM client_skr_requests WHERE status = 'pending'`,
  )
  return Number((rows[0] as { n?: number })?.n ?? 0)
}

/**
 * Cross-client queue of generic SKR requests awaiting action. Carries the owning
 * `userId` so the admin SKR desk can jump straight to the client that needs
 * action (the manager is per-client, so a bare landing shows nothing).
 */
export async function listPendingSkrRequestQueue(): Promise<SkrRequestQueueItem[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT id, user_id, data, status FROM client_skr_requests
     WHERE status = 'pending'
     ORDER BY created_at DESC`,
  )
  return rows.map((row) => {
    const data = ((row as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>
    return {
      userId: String((row as { user_id: string }).user_id),
      requestId: String((row as { id: string }).id),
      type: String(data.type ?? "Request"),
      message: String(data.message ?? ""),
      recordId: String(data.recordId ?? ""),
      status: String((row as { status: string }).status ?? "pending"),
      submittedAt: data.submittedAt ? String(data.submittedAt) : undefined,
    }
  })
}

// --- SKR records (administrator-owned, assigned to a client) ----------------

/** List every SKR record assigned to a single client. */
export async function listSkrRecordsForUser(userId: string): Promise<StoredSkr[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT * FROM client_skr_records WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(toStored)
}

/**
 * List every SKR record across ALL clients. Powers the administrator's
 * cross-client SKR overview (portfolio totals, status mix, recent issuance).
 * Each row carries its owning `userId` so the UI can attribute it to a client.
 */
export async function listAllSkrRecords(): Promise<StoredSkr[]> {
  await ensureTables()
  const { rows } = await query(`SELECT * FROM client_skr_records ORDER BY created_at DESC`)
  return rows.map(toStored)
}

/** List every SKR client request across ALL clients (for the admin overview). */
export async function listAllSkrRequests(): Promise<StoredSkr[]> {
  await ensureTables()
  const { rows } = await query(`SELECT * FROM client_skr_requests ORDER BY created_at DESC`)
  return rows.map(toStored)
}

/**
 * Reconcile the full set of SKR records for a client. Records are authored and
 * owned exclusively by the administrator, so this is a straight replace inside a
 * transaction: rows not present in `items` are removed, the rest are upserted.
 */
export async function replaceSkrRecordsForUser(userId: string, items: SkrItemInput[]): Promise<void> {
  await ensureTables()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows: existingRows } = await client.query(
      `SELECT id FROM client_skr_records WHERE user_id = $1`,
      [userId],
    )
    const incomingIds = new Set(items.map((i) => i.id))
    for (const r of existingRows) {
      const id = r.id as string
      if (!incomingIds.has(id)) {
        await client.query(`DELETE FROM client_skr_records WHERE id = $1 AND user_id = $2`, [id, userId])
      }
    }
    for (const item of items) {
      await client.query(
        `INSERT INTO client_skr_records (id, user_id, data, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               data = EXCLUDED.data,
               status = EXCLUDED.status,
               updated_at = now()`,
        [item.id, userId, JSON.stringify(item.data), item.status],
      )
    }
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Append a single supporting document to one of a client's own SKR records.
 *
 * Records are administrator-owned, but a client may attach their own evidence
 * (asset photos, custodian letters, etc.) to a receipt assigned to them. This
 * is a scoped, additive update: it only touches a row that belongs to `userId`,
 * and it merges the new document into the existing JSON `documents` array
 * without disturbing any administrator-authored fields. Returns the updated
 * record, or `null` if no matching record is owned by the user.
 */
export async function appendSkrDocumentForUser(
  userId: string,
  recordId: string,
  doc: Record<string, unknown>,
): Promise<StoredSkr | null> {
  await ensureTables()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query(
      `SELECT * FROM client_skr_records WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [recordId, userId],
    )
    if (rows.length === 0) {
      await client.query("ROLLBACK")
      return null
    }
    const stored = toStored(rows[0])
    const data = { ...stored.data }
    const documents = Array.isArray(data.documents) ? [...(data.documents as unknown[])] : []
    documents.push(doc)
    data.documents = documents
    const { rows: updated } = await client.query(
      `UPDATE client_skr_records
         SET data = $1::jsonb, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [JSON.stringify(data), recordId, userId],
    )
    await client.query("COMMIT")
    return toStored(updated[0])
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Scoped, additive patch of the expertise/evaluation/audit sub-object (and a
 * few controlled top-level fields) on ONE of a client's own SKR records.
 *
 * Used by both the customer (apply / accept / decline) and the custody desk
 * (return the valuation). It only ever touches a row that belongs to `userId`,
 * merges the `expertise` partial over any existing expertise, applies a small
 * whitelist of top-level fields (`blockedAsCollateral`), and optionally prepends
 * a transaction — without disturbing administrator-authored custody fields.
 * Returns the updated record, or `null` if no matching record is owned by the
 * user.
 */
export async function patchSkrExpertiseForUser(
  userId: string,
  recordId: string,
  patch: {
    expertise?: Record<string, unknown>
    blockedAsCollateral?: boolean
    transaction?: Record<string, unknown>
  },
): Promise<StoredSkr | null> {
  await ensureTables()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows } = await client.query(
      `SELECT * FROM client_skr_records WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [recordId, userId],
    )
    if (rows.length === 0) {
      await client.query("ROLLBACK")
      return null
    }
    const stored = toStored(rows[0])
    const data = { ...stored.data }
    if (patch.expertise) {
      const existing = (data.expertise as Record<string, unknown> | undefined) ?? {}
      data.expertise = { ...existing, ...patch.expertise }
    }
    if (typeof patch.blockedAsCollateral === "boolean") {
      data.blockedAsCollateral = patch.blockedAsCollateral
    }
    if (patch.transaction) {
      const transactions = Array.isArray(data.transactions) ? [...(data.transactions as unknown[])] : []
      transactions.unshift(patch.transaction)
      data.transactions = transactions
    }
    const { rows: updated } = await client.query(
      `UPDATE client_skr_records
         SET data = $1::jsonb, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [JSON.stringify(data), recordId, userId],
    )
    await client.query("COMMIT")
    return toStored(updated[0])
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

// --- SKR client requests ----------------------------------------------------

/** List every SKR request raised by a single client. */
export async function listSkrRequestsForUser(userId: string): Promise<StoredSkr[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT * FROM client_skr_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(toStored)
}

/**
 * Administrator-authoritative reconcile of a client's requests (used when the
 * custody desk approves / rejects). Straight replace inside a transaction.
 */
export async function replaceSkrRequestsForUser(userId: string, items: SkrItemInput[]): Promise<void> {
  await ensureTables()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const { rows: existingRows } = await client.query(
      `SELECT id FROM client_skr_requests WHERE user_id = $1`,
      [userId],
    )
    const incomingIds = new Set(items.map((i) => i.id))
    for (const r of existingRows) {
      const id = r.id as string
      if (!incomingIds.has(id)) {
        await client.query(`DELETE FROM client_skr_requests WHERE id = $1 AND user_id = $2`, [id, userId])
      }
    }
    for (const item of items) {
      await client.query(
        `INSERT INTO client_skr_requests (id, user_id, data, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data,
               status = EXCLUDED.status,
               updated_at = now()`,
        [item.id, userId, JSON.stringify(item.data), item.status],
      )
    }
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Client-side mirror of a user's own requests.
 *
 * Decisions (approve / reject + decision note + decided date) are owned by the
 * administrator and live on the same row, so a naive replace from the client
 * would clobber them. This performs a MERGE: brand-new requests are inserted as
 * sent; for requests that already exist on the server we KEEP the server's
 * status and decision fields while accepting nothing destructive from the
 * client. Requests are never deleted here (clients cannot withdraw them).
 */
export async function mergeSkrRequestsForUser(userId: string, items: SkrItemInput[]): Promise<SkrItemInput[]> {
  await ensureTables()
  const client = await pool.connect()
  const inserted: SkrItemInput[] = []
  try {
    await client.query("BEGIN")
    const { rows: existingRows } = await client.query(
      `SELECT id, data, status FROM client_skr_requests WHERE user_id = $1`,
      [userId],
    )
    const existing = new Map<string, { data: Record<string, unknown>; status: string }>(
      existingRows.map((r) => [
        r.id as string,
        { data: r.data as Record<string, unknown>, status: r.status as string },
      ]),
    )
    for (const item of items) {
      if (existing.has(item.id)) {
        // Already on the server — preserve the administrator's decision.
        continue
      }
      const { rowCount } = await client.query(
        `INSERT INTO client_skr_requests (id, user_id, data, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (id) DO NOTHING`,
        [item.id, userId, JSON.stringify(item.data), item.status],
      )
      if (rowCount && rowCount > 0) inserted.push(item)
    }
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  return inserted
}
