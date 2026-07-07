// ---------------------------------------------------------------------------
// Security audit trail — server-side event store (Neon Postgres).
//
// Every meaningful platform event (login, logout, security event, treasury
// operation, request, document, NQAi use, …) is persisted here going forward,
// so an administrator can reconstruct exactly what a given client did, from
// which device and IP, and when. This is the AUTHORITATIVE trail: rows live on
// the server and are never reachable by the account holder.
//
// NOTE: this store starts empty at deploy time — activity was previously only
// emailed to the trader desk, never stored. History accrues from the first
// event after this table exists.
//
// Mirrors the idempotent-migration pattern used by lib/pdf-trace-db.ts.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import { parseUserAgent } from "@/lib/user-agent"

export interface AuditEvent {
  id: string
  userId: string | null
  account: string
  action: string
  category: string
  path: string | null
  ipAddress: string | null
  userAgent: string | null
  deviceType: string | null
  os: string | null
  browser: string | null
  selfieUrl: string | null
  details: Record<string, unknown> | null
  createdAt: string
}

export interface RecordAuditInput {
  userId?: string | null
  account?: string | null
  action: string
  category: string
  path?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  selfieUrl?: string | null
  details?: Record<string, unknown> | null
}

/** One row of the per-user "recent devices" rollup. */
export interface DeviceRow {
  ipAddress: string | null
  deviceType: string | null
  os: string | null
  browser: string | null
  eventCount: number
  lastSeen: string
}

/** One row of the account picker: a client that has any recorded activity. */
export interface AuditActor {
  userId: string
  account: string
  eventCount: number
  lastSeen: string
  lastIp: string | null
  lastSelfieUrl: string | null
}

/** Aggregate stats for a single account, shown at the top of the report. */
export interface ActorStats {
  eventCount: number
  loginCount: number
  failedLoginCount: number
  firstSeen: string | null
  lastSeen: string | null
  distinctIpCount: number
  distinctDeviceCount: number
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS security_audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id text,
      account text NOT NULL DEFAULT '',
      action text NOT NULL,
      category text NOT NULL DEFAULT '',
      path text,
      ip_address text,
      user_agent text,
      device_type text,
      os text,
      browser text,
      selfie_url text,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS security_audit_user_idx ON security_audit_events (user_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS security_audit_created_idx ON security_audit_events (created_at DESC)`)
  ensured = true
}

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  const created = row.created_at as Date | string | null
  let details: Record<string, unknown> | null = null
  const raw = row.details
  if (raw && typeof raw === "object") details = raw as Record<string, unknown>
  else if (typeof raw === "string" && raw) {
    try {
      details = JSON.parse(raw)
    } catch {
      details = null
    }
  }
  return {
    id: String(row.id),
    userId: (row.user_id as string | null) ?? null,
    account: (row.account as string) ?? "",
    action: (row.action as string) ?? "",
    category: (row.category as string) ?? "",
    path: (row.path as string | null) ?? null,
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    deviceType: (row.device_type as string | null) ?? null,
    os: (row.os as string | null) ?? null,
    browser: (row.browser as string | null) ?? null,
    selfieUrl: (row.selfie_url as string | null) ?? null,
    details,
    createdAt: created instanceof Date ? created.toISOString() : (created as string) ?? new Date().toISOString(),
  }
}

/**
 * Persist one audit event. Device/OS/browser are derived from the user-agent
 * here so callers only need to pass the raw UA string. Never throws to the
 * caller's critical path — callers should still wrap in try/catch and treat
 * logging as best-effort.
 */
export async function insertAuditEvent(input: RecordAuditInput): Promise<void> {
  await ensureTable()
  const ua = parseUserAgent(input.userAgent)
  await query(
    `INSERT INTO security_audit_events
       (user_id, account, action, category, path, ip_address, user_agent, device_type, os, browser, selfie_url, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      input.userId || null,
      input.account || "",
      input.action,
      input.category || "",
      input.path || null,
      input.ipAddress || null,
      input.userAgent || null,
      ua.deviceType,
      ua.os,
      ua.browser,
      input.selfieUrl || null,
      input.details ? JSON.stringify(input.details) : null,
    ],
  )
}

/** Recent events, optionally filtered by user id and/or category. */
export async function listAuditEvents(opts?: {
  userId?: string
  category?: string
  limit?: number
}): Promise<AuditEvent[]> {
  await ensureTable()
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts?.userId) {
    params.push(opts.userId)
    clauses.push(`user_id = $${params.length}`)
  }
  if (opts?.category) {
    params.push(opts.category)
    clauses.push(`category = $${params.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  params.push(limit)
  const { rows } = await query(
    `SELECT * FROM security_audit_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  )
  return rows.map(rowToEvent)
}

/** Accounts that have any recorded activity, most-recently-active first. */
export async function listAuditActors(limit = 200): Promise<AuditActor[]> {
  await ensureTable()
  const capped = Math.min(Math.max(limit, 1), 500)
  const { rows } = await query(
    `SELECT
        user_id,
        COUNT(*)::int AS event_count,
        MAX(created_at) AS last_seen,
        (ARRAY_AGG(account ORDER BY created_at DESC) FILTER (WHERE account <> ''))[1] AS account,
        (ARRAY_AGG(ip_address ORDER BY created_at DESC) FILTER (WHERE ip_address IS NOT NULL))[1] AS last_ip,
        (ARRAY_AGG(selfie_url ORDER BY created_at DESC) FILTER (WHERE selfie_url IS NOT NULL))[1] AS last_selfie
     FROM security_audit_events
     WHERE user_id IS NOT NULL
     GROUP BY user_id
     ORDER BY last_seen DESC
     LIMIT $1`,
    [capped],
  )
  return rows.map((r) => {
    const last = r.last_seen as Date | string
    return {
      userId: r.user_id as string,
      account: (r.account as string | null) || (r.user_id as string),
      eventCount: (r.event_count as number) ?? 0,
      lastSeen: last instanceof Date ? last.toISOString() : (last as string),
      lastIp: (r.last_ip as string | null) ?? null,
      lastSelfieUrl: (r.last_selfie as string | null) ?? null,
    }
  })
}

/** Per-account aggregate stats for the report header. */
export async function getActorStats(userId: string): Promise<ActorStats> {
  await ensureTable()
  const { rows } = await query(
    `SELECT
        COUNT(*)::int AS event_count,
        COUNT(*) FILTER (WHERE action ILIKE 'Login successful%')::int AS login_count,
        COUNT(*) FILTER (WHERE action ILIKE 'Login failed%' OR action ILIKE 'Face ID%fail%')::int AS failed_count,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        COUNT(DISTINCT ip_address)::int AS ip_count,
        COUNT(DISTINCT COALESCE(device_type,'') || '|' || COALESCE(os,'') || '|' || COALESCE(browser,''))::int AS device_count
     FROM security_audit_events
     WHERE user_id = $1`,
    [userId],
  )
  const r = rows[0] ?? {}
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null)) ?? null
  return {
    eventCount: (r.event_count as number) ?? 0,
    loginCount: (r.login_count as number) ?? 0,
    failedLoginCount: (r.failed_count as number) ?? 0,
    firstSeen: iso(r.first_seen),
    lastSeen: iso(r.last_seen),
    distinctIpCount: (r.ip_count as number) ?? 0,
    distinctDeviceCount: (r.device_count as number) ?? 0,
  }
}

/** Distinct devices/IPs a given account has been seen from, newest first. */
export async function listUserDevices(userId: string, limit = 25): Promise<DeviceRow[]> {
  await ensureTable()
  const capped = Math.min(Math.max(limit, 1), 100)
  const { rows } = await query(
    `SELECT ip_address, device_type, os, browser,
            COUNT(*)::int AS event_count, MAX(created_at) AS last_seen
       FROM security_audit_events
      WHERE user_id = $1
      GROUP BY ip_address, device_type, os, browser
      ORDER BY last_seen DESC
      LIMIT $2`,
    [userId, capped],
  )
  return rows.map((r) => {
    const last = r.last_seen as Date | string
    return {
      ipAddress: (r.ip_address as string | null) ?? null,
      deviceType: (r.device_type as string | null) ?? null,
      os: (r.os as string | null) ?? null,
      browser: (r.browser as string | null) ?? null,
      eventCount: (r.event_count as number) ?? 0,
      lastSeen: last instanceof Date ? last.toISOString() : (last as string),
    }
  })
}
