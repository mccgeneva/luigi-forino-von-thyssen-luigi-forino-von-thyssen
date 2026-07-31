// ---------------------------------------------------------------------------
// Debug / error event store — server-side (Neon Postgres).
//
// Captures automatically-detected anomalies so an administrator can see bugs,
// exceptions and failures as they happen, WITHOUT a client having to report
// them. Sources:
//   - client   : window.onerror / unhandledrejection / React global-error
//   - server   : captureServerError() wired into server catch blocks
//
// This is complementary to security_audit_events (which records intentional
// user actions). Here we record things that WENT WRONG.
//
// Mirrors the idempotent-migration + never-throw pattern of
// lib/security-audit-db.ts. Logging is always best-effort: a failure to record
// an error must never itself throw into the path that was already failing.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import { parseUserAgent } from "@/lib/user-agent"

export type DebugSeverity = "critical" | "error" | "warning" | "info"
export type DebugSource = "client" | "server" | "edge"

export interface DebugErrorEvent {
  id: string
  severity: DebugSeverity
  source: DebugSource
  kind: string
  message: string
  stack: string | null
  userId: string | null
  account: string | null
  path: string | null
  ipAddress: string | null
  userAgent: string | null
  deviceType: string | null
  os: string | null
  browser: string | null
  meta: Record<string, unknown> | null
  createdAt: string
}

export interface CaptureDebugInput {
  severity?: DebugSeverity
  source: DebugSource
  kind?: string | null
  message: string
  stack?: string | null
  userId?: string | null
  account?: string | null
  path?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  meta?: Record<string, unknown> | null
}

export interface DebugErrorStats {
  total: number
  critical: number
  error: number
  warning: number
  clientCount: number
  serverCount: number
  lastSeen: string | null
}

// Hard caps so a runaway error loop can never write unbounded data.
const MAX_MESSAGE = 2000
const MAX_STACK = 8000
const MAX_META = 12000

function clamp(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  return value.length > max ? value.slice(0, max) : value
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS debug_error_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      severity text NOT NULL DEFAULT 'error',
      source text NOT NULL DEFAULT 'server',
      kind text NOT NULL DEFAULT '',
      message text NOT NULL,
      stack text,
      user_id text,
      account text,
      path text,
      ip_address text,
      user_agent text,
      device_type text,
      os text,
      browser text,
      meta jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS debug_error_created_idx ON debug_error_events (created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS debug_error_severity_idx ON debug_error_events (severity, created_at DESC)`)
  ensured = true
}

function rowToEvent(row: Record<string, unknown>): DebugErrorEvent {
  const created = row.created_at as Date | string | null
  let meta: Record<string, unknown> | null = null
  const raw = row.meta
  if (raw && typeof raw === "object") meta = raw as Record<string, unknown>
  else if (typeof raw === "string" && raw) {
    try {
      meta = JSON.parse(raw)
    } catch {
      meta = null
    }
  }
  return {
    id: String(row.id),
    severity: ((row.severity as string) || "error") as DebugSeverity,
    source: ((row.source as string) || "server") as DebugSource,
    kind: (row.kind as string) ?? "",
    message: (row.message as string) ?? "",
    stack: (row.stack as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    account: (row.account as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    deviceType: (row.device_type as string | null) ?? null,
    os: (row.os as string | null) ?? null,
    browser: (row.browser as string | null) ?? null,
    meta,
    createdAt: created instanceof Date ? created.toISOString() : (created as string) ?? new Date().toISOString(),
  }
}

/**
 * Persist one debug/error event. NEVER throws — logging an error must not break
 * the already-failing path that reported it. Returns true if stored.
 */
export async function captureDebugEvent(input: CaptureDebugInput): Promise<boolean> {
  try {
    await ensureTable()
    const ua = parseUserAgent(input.userAgent)
    await query(
      `INSERT INTO debug_error_events
         (severity, source, kind, message, stack, user_id, account, path, ip_address, user_agent, device_type, os, browser, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        input.severity || "error",
        input.source,
        (input.kind || "").slice(0, 120),
        clamp(input.message, MAX_MESSAGE) || "(no message)",
        clamp(input.stack, MAX_STACK),
        input.userId || null,
        input.account || null,
        input.path || null,
        input.ipAddress || null,
        input.userAgent || null,
        ua.deviceType,
        ua.os,
        ua.browser,
        input.meta ? clamp(JSON.stringify(input.meta), MAX_META) : null,
      ],
    )
    return true
  } catch (err) {
    // Last-resort: log to the server console, but do not propagate.
    console.log("[v0] captureDebugEvent failed (non-fatal):", (err as Error)?.message)
    return false
  }
}

/**
 * Convenience wrapper for server-side catch blocks. Normalizes an unknown throw
 * into a structured debug event. Best-effort and never throws, so it is safe to
 * `void captureServerError(...)` inside a catch without awaiting.
 *
 *   } catch (err) {
 *     void captureServerError(err, { kind: "treasury.reconcile", userId })
 *     ...
 *   }
 */
export async function captureServerError(
  err: unknown,
  ctx?: {
    kind?: string
    severity?: DebugSeverity
    userId?: string | null
    account?: string | null
    path?: string | null
    meta?: Record<string, unknown> | null
  },
): Promise<void> {
  const e = err as { message?: string; stack?: string; name?: string; code?: string }
  const message = e?.message || (typeof err === "string" ? err : "Unknown server error")
  const meta = { ...(ctx?.meta ?? {}) }
  if (e?.name) (meta as Record<string, unknown>).name = e.name
  if (e?.code) (meta as Record<string, unknown>).code = e.code
  await captureDebugEvent({
    severity: ctx?.severity || "error",
    source: "server",
    kind: ctx?.kind || e?.name || "server.error",
    message,
    stack: e?.stack || null,
    userId: ctx?.userId ?? null,
    account: ctx?.account ?? null,
    path: ctx?.path ?? null,
    meta: Object.keys(meta).length ? meta : null,
  })
}

/** Recent debug/error events, newest first, with optional filters. */
export async function listDebugEvents(opts?: {
  severity?: DebugSeverity
  source?: DebugSource
  limit?: number
}): Promise<DebugErrorEvent[]> {
  try {
    await ensureTable()
    const limit = Math.min(Math.max(opts?.limit ?? 150, 1), 500)
    const clauses: string[] = []
    const params: unknown[] = []
    if (opts?.severity) {
      params.push(opts.severity)
      clauses.push(`severity = $${params.length}`)
    }
    if (opts?.source) {
      params.push(opts.source)
      clauses.push(`source = $${params.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    params.push(limit)
    const { rows } = await query(
      `SELECT * FROM debug_error_events ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    )
    return rows.map(rowToEvent)
  } catch (err) {
    console.log("[v0] listDebugEvents failed:", (err as Error)?.message)
    return []
  }
}

/** Aggregate counts for the Errors & Debug header. */
export async function getDebugStats(): Promise<DebugErrorStats> {
  try {
    await ensureTable()
    const { rows } = await query(
      `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
          COUNT(*) FILTER (WHERE severity = 'error')::int AS error,
          COUNT(*) FILTER (WHERE severity = 'warning')::int AS warning,
          COUNT(*) FILTER (WHERE source = 'client')::int AS client_count,
          COUNT(*) FILTER (WHERE source = 'server')::int AS server_count,
          MAX(created_at) AS last_seen
       FROM debug_error_events`,
    )
    const r = rows[0] ?? {}
    const last = r.last_seen as Date | string | null
    return {
      total: (r.total as number) ?? 0,
      critical: (r.critical as number) ?? 0,
      error: (r.error as number) ?? 0,
      warning: (r.warning as number) ?? 0,
      clientCount: (r.client_count as number) ?? 0,
      serverCount: (r.server_count as number) ?? 0,
      lastSeen: last instanceof Date ? last.toISOString() : (last as string | null) ?? null,
    }
  } catch (err) {
    console.log("[v0] getDebugStats failed:", (err as Error)?.message)
    return { total: 0, critical: 0, error: 0, warning: 0, clientCount: 0, serverCount: 0, lastSeen: null }
  }
}
