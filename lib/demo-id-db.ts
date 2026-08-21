import "server-only"
import { query } from "@/lib/db"
import type { DemoIdSubmission } from "@/lib/demo-id-types"

// ---------------------------------------------------------------------------
// Demo-account identity submissions store (Neon).
//
// Every login to the shared demo account records the ID document the visitor
// uploaded (OCR-identified), their IP, and their GPS position (if granted), so
// an administrator can see who has been testing the platform. This is a
// security/audit trail — it is NEVER shown to the demo user themselves.
// ---------------------------------------------------------------------------

let ensured: Promise<void> | null = null

/** Lazily create the table on first use (idempotent). */
async function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = query(`
      CREATE TABLE IF NOT EXISTS demo_id_submissions (
        id                TEXT PRIMARY KEY,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        doc_pathname      TEXT NOT NULL,
        doc_content_type  TEXT NOT NULL DEFAULT 'image/jpeg',
        doc_type          TEXT NOT NULL DEFAULT '',
        full_name         TEXT NOT NULL DEFAULT '',
        doc_number        TEXT NOT NULL DEFAULT '',
        country           TEXT NOT NULL DEFAULT '',
        ip                TEXT,
        user_agent        TEXT,
        gps_lat           NUMERIC(10,7),
        gps_lng           NUMERIC(10,7),
        gps_accuracy      NUMERIC(10,2)
      );
      CREATE INDEX IF NOT EXISTS demo_id_submissions_created_idx
        ON demo_id_submissions (created_at DESC);
    `)
      .then(() => undefined)
      .catch((err) => {
        // Reset so a transient failure can be retried on the next call.
        ensured = null
        throw err
      })
  }
  return ensured
}

interface Row {
  id: string
  created_at: Date | string
  doc_pathname: string
  doc_content_type: string
  doc_type: string
  full_name: string
  doc_number: string
  country: string
  ip: string | null
  user_agent: string | null
  gps_lat: string | number | null
  gps_lng: string | number | null
  gps_accuracy: string | number | null
}

function toNum(v: string | number | null): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function mapRow(r: Row): DemoIdSubmission {
  return {
    id: r.id,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
    docPathname: r.doc_pathname,
    docContentType: r.doc_content_type,
    docType: r.doc_type,
    fullName: r.full_name,
    docNumber: r.doc_number,
    country: r.country,
    ip: r.ip,
    userAgent: r.user_agent,
    gpsLat: toNum(r.gps_lat),
    gpsLng: toNum(r.gps_lng),
    gpsAccuracy: toNum(r.gps_accuracy),
  }
}

export interface DemoIdSubmissionInput {
  id: string
  docPathname: string
  docContentType: string
  docType: string
  fullName: string
  docNumber: string
  country: string
  ip: string | null
  userAgent: string | null
  gpsLat: number | null
  gpsLng: number | null
  gpsAccuracy: number | null
}

/** Persist one demo-account identity submission. Never throws to the caller. */
export async function insertDemoIdSubmission(input: DemoIdSubmissionInput): Promise<void> {
  try {
    await ensureTable()
    await query(
      `INSERT INTO demo_id_submissions
         (id, doc_pathname, doc_content_type, doc_type, full_name, doc_number, country,
          ip, user_agent, gps_lat, gps_lng, gps_accuracy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.docPathname,
        input.docContentType,
        input.docType,
        input.fullName,
        input.docNumber,
        input.country,
        input.ip,
        input.userAgent,
        input.gpsLat,
        input.gpsLng,
        input.gpsAccuracy,
      ],
    )
  } catch (err) {
    console.log("[v0] insertDemoIdSubmission failed:", (err as Error).message)
  }
}

/** List the most recent demo-account identity submissions (admin inspection). */
export async function listDemoIdSubmissions(limit = 200): Promise<DemoIdSubmission[]> {
  try {
    await ensureTable()
    const res = await query<Row>(
      `SELECT * FROM demo_id_submissions ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(500, limit))],
    )
    return res.rows.map(mapRow)
  } catch (err) {
    console.log("[v0] listDemoIdSubmissions failed:", (err as Error).message)
    return []
  }
}
