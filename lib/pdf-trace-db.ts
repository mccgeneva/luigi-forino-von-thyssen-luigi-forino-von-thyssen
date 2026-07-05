// ---------------------------------------------------------------------------
// Document traceability — server-side audit store (Neon Postgres).
//
// This is the AUTHORITATIVE trace. Unlike the token embedded in the PDF (which a
// determined user can strip), rows here live on the server and cannot be reached
// by the account holder. Each row records who generated a document, for which
// account, from which server-captured IP, when, the document type, and a salted
// hash of the user's enrolled biometric descriptor (so a document can be tied to
// the biometric identity that was on file at generation time — without ever
// storing the descriptor itself).
//
// Mirrors the idempotent-migration pattern used by lib/biometric-db.ts.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"

export interface DocumentTrace {
  docId: string
  userId: string
  account: string
  kind: string
  title: string | null
  filename: string | null
  ipAddress: string | null
  userAgent: string | null
  biometricHash: string | null
  isDemo: boolean
  createdAt: string
}

export interface RecordTraceInput {
  docId: string
  userId: string
  account: string
  kind: string
  title?: string | null
  filename?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  biometricHash?: string | null
  isDemo?: boolean
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS document_traces (
      doc_id text PRIMARY KEY,
      user_id text NOT NULL,
      account text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'document',
      title text,
      filename text,
      ip_address text,
      user_agent text,
      biometric_hash text,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  // Helpful indexes for the two admin lookups: by user and by recency.
  await query(`CREATE INDEX IF NOT EXISTS document_traces_user_idx ON document_traces (user_id)`)
  await query(`CREATE INDEX IF NOT EXISTS document_traces_created_idx ON document_traces (created_at DESC)`)
  ensured = true
}

function rowToTrace(row: Record<string, unknown>): DocumentTrace {
  const created = row.created_at as Date | string | null
  return {
    docId: row.doc_id as string,
    userId: row.user_id as string,
    account: (row.account as string) ?? "",
    kind: (row.kind as string) ?? "document",
    title: (row.title as string | null) ?? null,
    filename: (row.filename as string | null) ?? null,
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    biometricHash: (row.biometric_hash as string | null) ?? null,
    isDemo: !!row.is_demo,
    createdAt: created instanceof Date ? created.toISOString() : (created as string) ?? new Date().toISOString(),
  }
}

/**
 * Insert (or upsert) a trace row. Idempotent on doc_id so a duplicated
 * fire-and-forget call from the client can never create two rows for one file.
 */
export async function insertDocumentTrace(input: RecordTraceInput): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO document_traces
       (doc_id, user_id, account, kind, title, filename, ip_address, user_agent, biometric_hash, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (doc_id) DO NOTHING`,
    [
      input.docId,
      input.userId,
      input.account || "",
      input.kind || "document",
      input.title || null,
      input.filename || null,
      input.ipAddress || null,
      input.userAgent || null,
      input.biometricHash || null,
      input.isDemo ?? false,
    ],
  )
}

/** Look up a single trace by its document id. */
export async function getDocumentTrace(docId: string): Promise<DocumentTrace | null> {
  if (!docId) return null
  await ensureTable()
  const { rows } = await query(`SELECT * FROM document_traces WHERE doc_id = $1`, [docId.trim()])
  return rows[0] ? rowToTrace(rows[0]) : null
}

/** Recent traces, optionally filtered by user id, for the admin list view. */
export async function listDocumentTraces(opts?: { userId?: string; limit?: number }): Promise<DocumentTrace[]> {
  await ensureTable()
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200)
  if (opts?.userId) {
    const { rows } = await query(
      `SELECT * FROM document_traces WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [opts.userId, limit],
    )
    return rows.map(rowToTrace)
  }
  const { rows } = await query(`SELECT * FROM document_traces ORDER BY created_at DESC LIMIT $1`, [limit])
  return rows.map(rowToTrace)
}
