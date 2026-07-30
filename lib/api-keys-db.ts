// ---------------------------------------------------------------------------
// External API key store (server-only) — Neon Postgres.
//
// Powers the programmatic API that lets trusted external applications (e.g.
// NQAi.cloud) read a specific customer's data and charge subscription costs
// against the balance they hold on mcc-btp.app.
//
// Security model:
//   - The full secret is shown to the administrator EXACTLY ONCE at creation.
//     Only a SHA-256 hash is persisted, so a database leak cannot reveal a
//     usable key (mirrors how passwords should be stored).
//   - Each key carries explicit SCOPES ("read" and/or "charge"). A read-only
//     key can retrieve customer data but can never move money.
//   - Keys can be revoked; a revoked key fails authentication immediately.
//
// This module is server-only (it imports `pg` via lib/db and node:crypto) and
// exposes plain async helpers consumed by the external API routes
// (app/api/v1/*) and the admin Server Action layer (app/actions/api-keys.ts).
// ---------------------------------------------------------------------------

import "server-only"
import { randomBytes, createHash, timingSafeEqual } from "node:crypto"
import { query } from "@/lib/db"

export type ApiKeyScope = "read" | "charge"
export const ALL_SCOPES: ApiKeyScope[] = ["read", "charge"]

/** Public shape returned to the admin UI — NEVER includes the secret hash. */
export interface ApiKeyRecord {
  id: string
  name: string
  keyPrefix: string
  scopes: ApiKeyScope[]
  status: "active" | "revoked"
  createdBy: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  requestCount: number
}

/** Internal shape that additionally carries the stored hash for verification. */
interface ApiKeyRow extends ApiKeyRecord {
  keyHash: string
}

const KEY_PLAINTEXT_PREFIX = "nqai_live_"

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS api_keys (
       id            text PRIMARY KEY,
       name          text NOT NULL,
       key_prefix    text NOT NULL,
       key_hash      text NOT NULL UNIQUE,
       scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
       status        text NOT NULL DEFAULT 'active',
       created_by    text,
       created_at    timestamptz NOT NULL DEFAULT now(),
       last_used_at  timestamptz,
       revoked_at    timestamptz,
       request_count bigint NOT NULL DEFAULT 0
     )`,
  )
  ensured = true
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

function rowToRecord(row: Record<string, unknown>): ApiKeyRow {
  const scopes = Array.isArray(row.scopes) ? (row.scopes as ApiKeyScope[]) : []
  return {
    id: row.id as string,
    name: row.name as string,
    keyPrefix: row.key_prefix as string,
    keyHash: row.key_hash as string,
    scopes: scopes.filter((s): s is ApiKeyScope => s === "read" || s === "charge"),
    status: (row.status as "active" | "revoked") ?? "active",
    createdBy: (row.created_by as string) ?? "",
    createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    lastUsedAt: row.last_used_at ? ((row.last_used_at as Date)?.toISOString?.() ?? String(row.last_used_at)) : null,
    revokedAt: row.revoked_at ? ((row.revoked_at as Date)?.toISOString?.() ?? String(row.revoked_at)) : null,
    requestCount: Number(row.request_count ?? 0),
  }
}

/** Strip the internal hash before returning to any caller that renders it. */
function toPublic(row: ApiKeyRow): ApiKeyRecord {
  const { keyHash: _keyHash, ...pub } = row
  return pub
}

export interface CreateApiKeyInput {
  name: string
  scopes: ApiKeyScope[]
  createdBy?: string
}

export interface CreatedApiKey {
  record: ApiKeyRecord
  /** The full secret — returned ONCE and never persisted. Show it, then forget it. */
  plaintext: string
}

/**
 * Create a new API key. Generates a cryptographically-random secret, persists
 * only its SHA-256 hash, and returns the plaintext exactly once so the admin
 * can hand it to the external integration.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  await ensureTable()
  const scopes = ALL_SCOPES.filter((s) => input.scopes.includes(s))
  if (scopes.length === 0) throw new Error("At least one scope is required.")

  const secret = randomBytes(24).toString("hex") // 48 hex chars
  const plaintext = `${KEY_PLAINTEXT_PREFIX}${secret}`
  const keyHash = sha256(plaintext)
  // Prefix shown in the UI so a key stays recognizable without exposing it:
  // "nqai_live_" + first 8 chars of the secret.
  const keyPrefix = `${KEY_PLAINTEXT_PREFIX}${secret.slice(0, 8)}`
  const id = `ak_${randomBytes(6).toString("hex")}`

  const { rows } = await query(
    `INSERT INTO api_keys (id, name, key_prefix, key_hash, scopes, status, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6)
     RETURNING *`,
    [id, input.name.trim() || "Untitled key", keyPrefix, keyHash, JSON.stringify(scopes), input.createdBy ?? ""],
  )
  return { record: toPublic(rowToRecord(rows[0])), plaintext }
}

/** All API keys, newest first. Secrets/hashes are never included. */
export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM api_keys ORDER BY created_at DESC`)
  return rows.map((r) => toPublic(rowToRecord(r)))
}

/** Revoke a key so it can no longer authenticate. Idempotent. */
export async function revokeApiKey(id: string): Promise<ApiKeyRecord | undefined> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1 RETURNING *`,
    [id],
  )
  return rows[0] ? toPublic(rowToRecord(rows[0])) : undefined
}

/** Permanently delete a key. */
export async function deleteApiKey(id: string): Promise<boolean> {
  await ensureTable()
  const { rowCount } = await query(`DELETE FROM api_keys WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}

/**
 * Authenticate an incoming API request by its plaintext bearer token. Returns
 * the (public) key record when the token maps to an ACTIVE key, else null.
 * Look-up is by hash — the plaintext is never stored — and the final compare is
 * constant-time to avoid leaking hash equality via timing.
 *
 * Best-effort usage accounting (last_used_at + request_count) is updated on a
 * successful match; a failure there never blocks the request.
 */
export async function authenticateApiKey(plaintext: string | null | undefined): Promise<ApiKeyRecord | null> {
  if (!plaintext || !plaintext.startsWith(KEY_PLAINTEXT_PREFIX)) return null
  await ensureTable()
  const keyHash = sha256(plaintext)
  const { rows } = await query(`SELECT * FROM api_keys WHERE key_hash = $1 AND status = 'active'`, [keyHash])
  if (!rows[0]) return null

  const row = rowToRecord(rows[0])
  // Defence-in-depth constant-time confirmation of the hash match.
  const a = Buffer.from(row.keyHash)
  const b = Buffer.from(keyHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    await query(`UPDATE api_keys SET last_used_at = now(), request_count = request_count + 1 WHERE id = $1`, [row.id])
  } catch {
    // Usage accounting is non-critical; never fail the request over it.
  }
  return toPublic(row)
}

/** True when a key record carries the required scope. */
export function hasScope(record: ApiKeyRecord, scope: ApiKeyScope): boolean {
  return record.scopes.includes(scope)
}
