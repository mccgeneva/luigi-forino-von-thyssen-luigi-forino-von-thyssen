// ---------------------------------------------------------------------------
// Admin-uploaded KYC documents — server-side store (Neon Postgres).
//
// An administrator can upload identity/compliance documents (passport, ID, face
// photo, company registration, utility bill, bank statement, …) against ANY
// client account — new or existing. The file itself lives in private Blob under
// a `kyc/<userId>/…` path; this table is the authoritative audit trail recording
// WHO uploaded WHAT, WHEN, and its type/size. Rows are only reachable through
// the admin-passcode-gated Security Audit routes.
//
// Mirrors the idempotent-migration pattern used by lib/security-audit-db.ts.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import {
  type UploadedKycDocument,
  type UploadedKycDocType,
  UPLOADED_KYC_DOC_LABELS,
  normalizeUploadedKycType,
} from "@/lib/kyc-types"

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS kyc_documents (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id text NOT NULL,
      doc_type text NOT NULL DEFAULT 'other',
      label text NOT NULL DEFAULT '',
      filename text NOT NULL DEFAULT '',
      content_type text NOT NULL DEFAULT '',
      size_bytes bigint NOT NULL DEFAULT 0,
      pathname text NOT NULL,
      uploaded_by text NOT NULL DEFAULT 'Administrator',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS kyc_documents_user_idx ON kyc_documents (user_id, created_at DESC)`)
  ensured = true
}

function rowToDoc(row: Record<string, unknown>): UploadedKycDocument {
  const created = row.created_at as Date | string | null
  const type = normalizeUploadedKycType(row.doc_type as string)
  const contentType = (row.content_type as string) || ""
  return {
    id: String(row.id),
    userId: (row.user_id as string) ?? "",
    type,
    label: (row.label as string) || UPLOADED_KYC_DOC_LABELS[type],
    filename: (row.filename as string) || "",
    contentType,
    sizeBytes: Number(row.size_bytes ?? 0),
    pathname: (row.pathname as string) ?? "",
    isImage: contentType.startsWith("image/"),
    uploadedBy: (row.uploaded_by as string) || "Administrator",
    createdAt: created instanceof Date ? created.toISOString() : (created as string) ?? new Date().toISOString(),
  }
}

export interface AddKycDocumentInput {
  userId: string
  type: UploadedKycDocType
  filename: string
  contentType: string
  sizeBytes: number
  pathname: string
  uploadedBy?: string
}

/** Record a freshly-uploaded document and return the stored row. */
export async function addKycDocument(input: AddKycDocumentInput): Promise<UploadedKycDocument> {
  await ensureTable()
  const type = normalizeUploadedKycType(input.type)
  const { rows } = await query(
    `INSERT INTO kyc_documents (user_id, doc_type, label, filename, content_type, size_bytes, pathname, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.userId,
      type,
      UPLOADED_KYC_DOC_LABELS[type],
      input.filename || "",
      input.contentType || "",
      Math.max(0, Math.round(input.sizeBytes || 0)),
      input.pathname,
      input.uploadedBy || "Administrator",
    ],
  )
  return rowToDoc(rows[0])
}

/** All documents for one account, most-recent first. */
export async function listKycDocuments(userId: string): Promise<UploadedKycDocument[]> {
  if (!userId) return []
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM kyc_documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(rowToDoc)
}

/** Fetch a single document by id (used before deleting to know its Blob path). */
export async function getKycDocument(id: string): Promise<UploadedKycDocument | null> {
  if (!id) return null
  await ensureTable()
  const { rows } = await query(`SELECT * FROM kyc_documents WHERE id = $1`, [id])
  return rows[0] ? rowToDoc(rows[0]) : null
}

/** Delete a document row. Returns the removed row (so the caller can del() its blob). */
export async function deleteKycDocument(id: string): Promise<UploadedKycDocument | null> {
  if (!id) return null
  await ensureTable()
  const { rows } = await query(`DELETE FROM kyc_documents WHERE id = $1 RETURNING *`, [id])
  return rows[0] ? rowToDoc(rows[0]) : null
}
