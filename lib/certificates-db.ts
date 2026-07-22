import "server-only"
import { pool, query } from "@/lib/db"
import { mergeAuditEvents, type CertificateRequest } from "@/lib/certificates-shared"

/**
 * Server-side persistence for bank certificate requests.
 *
 * Certificate requests were originally a per-browser localStorage list, which
 * meant a request made on the client's device was invisible to the
 * administrator's approval panel running in a different browser/session. They
 * are now persisted in Neon, keyed by the owning user's id, so administrators
 * can review, approve, decline and re-issue any client's certificates from any
 * device. The client store hydrates from here and mirrors writes back, falling
 * back to its local cache when the DB is unavailable (e.g. local dev without
 * DATABASE_URL).
 *
 * The full request object is stored as JSONB so the rich document shape in
 * lib/certificates-shared.ts can evolve without migrations.
 */

let ready: Promise<void> | null = null

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS certificate_requests (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          data         JSONB NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      await query(`CREATE INDEX IF NOT EXISTS certificate_requests_user_idx ON certificate_requests (user_id);`)
      await query(`CREATE INDEX IF NOT EXISTS certificate_requests_status_idx ON certificate_requests (status);`)
    })().catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

export interface StoredCertificate {
  id: string
  userId: string
  request: CertificateRequest
  status: string
  createdAt: string
  updatedAt: string
}

function toStored(row: Record<string, unknown>): StoredCertificate {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    request: row.data as CertificateRequest,
    status: row.status as string,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

/** List all certificate requests belonging to a single user, newest first. */
export async function listCertificateRequestsForUser(userId: string): Promise<StoredCertificate[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM certificate_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(toStored)
}

/**
 * List every certificate request still awaiting a decision, across all clients.
 * Powers the administrator's pending-approval overview.
 */
export async function listPendingCertificateRequests(): Promise<StoredCertificate[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM certificate_requests WHERE status = 'pending' ORDER BY created_at ASC`,
  )
  return rows.map(toStored)
}

/** Fetch a single certificate request by its id (PK, globally unique). */
export async function getCertificateRequest(id: string): Promise<StoredCertificate | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM certificate_requests WHERE id = $1`, [id])
  return rows[0] ? toStored(rows[0]) : null
}

/**
 * Delete a single certificate request owned by a specific user.
 *
 * The query is scoped by BOTH the request id and the owning user_id so a client
 * can only ever remove their own records — there is no row-level security on
 * Neon, so this per-query ownership filter is the security boundary. Returns
 * true when a row was actually removed.
 */
export async function deleteCertificateRequestForUser(userId: string, id: string): Promise<boolean> {
  await ensureTable()
  const { rowCount } = await query(
    `DELETE FROM certificate_requests WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return (rowCount ?? 0) > 0
}

/** Insert or replace a single certificate request for a user. */
export async function upsertCertificateRequest(
  userId: string,
  request: CertificateRequest,
): Promise<StoredCertificate> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO certificate_requests (id, user_id, data, status, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data,
           status = EXCLUDED.status,
           updated_at = now()
     RETURNING *`,
    [request.id, userId, JSON.stringify(request), request.status],
  )
  return toStored(rows[0])
}

/**
 * Reconcile a client's full request set with the server (used by the client
 * mirror sync).
 *
 * IMPORTANT: the lifecycle (approve / decline / re-issue) is administrator-owned
 * and lives only on the server. A client's local copy of an already-decided
 * request can be stale, so a naive overwrite would clobber a compliance
 * decision. To prevent that, this performs a MERGE that:
 *
 *   - inserts brand-new requests (not yet on the server) exactly as sent;
 *   - for a request that already exists on the server, KEEPS the server's
 *     authoritative lifecycle fields (status, version, decidedAt, decisionNote,
 *     issuedAt, approvedBy) while unioning the audit events so a client-side
 *     "Downloaded" event and a server-side "Approved" event both survive;
 *   - never deletes — clients have no delete affordance, and an empty/stale
 *     client payload must never wipe an administrator's records.
 */
export async function replaceCertificateRequestsForUser(
  userId: string,
  items: { id: string; data: Record<string, unknown>; status: string }[],
): Promise<void> {
  await ensureTable()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const { rows: existingRows } = await client.query(
      `SELECT id, data FROM certificate_requests WHERE user_id = $1`,
      [userId],
    )
    const existing = new Map<string, CertificateRequest>(
      existingRows.map((r) => [r.id as string, r.data as CertificateRequest]),
    )

    for (const item of items) {
      const incoming = item.data as unknown as CertificateRequest
      const prior = existing.get(item.id)
      let merged = incoming
      if (prior) {
        // Keep administrator-owned lifecycle from the server; accept the
        // client's descriptive fields; union the audit trail.
        merged = {
          ...incoming,
          status: prior.status,
          version: prior.version,
          decidedAt: prior.decidedAt,
          decisionNote: prior.decisionNote,
          issuedAt: prior.issuedAt,
          approvedBy: prior.approvedBy,
          events: mergeAuditEvents(prior.events, incoming.events),
        }
      }
      await client.query(
        `INSERT INTO certificate_requests (id, user_id, data, status, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data,
               status = EXCLUDED.status,
               updated_at = now()`,
        [item.id, userId, JSON.stringify(merged), merged.status],
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
