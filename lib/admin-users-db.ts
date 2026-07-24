// ---------------------------------------------------------------------------
// Dynamic (admin-created) user store — Neon Postgres.
//
// Static users live in lib/users.ts. Administrators can additionally create new
// clients at runtime; those are persisted here so they survive restarts and can
// actually log in. This module is server-only (it imports `pg`) and exposes
// plain async helpers used by the Server Action layer (app/actions/admin-users.ts)
// and the shared session resolver (lib/session-user.ts).
//
// NOTE: This is intentionally NOT a "use server" file. It exports helpers and
// types (not just async actions) for other server modules to import directly.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import type { SerializableUserProfile, SerializableProfileItem, UserStatus } from "@/lib/profile-types"
import { CORE_USER_SEEDS } from "@/lib/core-user-seeds"

export type { UserStatus }

export interface DynamicUserRecord {
  id: string
  email: string
  password: string
  sessionToken: string
  status: UserStatus
  profile: SerializableUserProfile
  createdAt: string
  updatedAt: string
  createdBy: string
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS admin_users (
       id            text PRIMARY KEY,
       email         text NOT NULL UNIQUE,
       password      text NOT NULL,
       session_token text NOT NULL UNIQUE,
       status        text NOT NULL DEFAULT 'active',
       profile       jsonb NOT NULL,
       created_by    text,
       created_at    timestamptz NOT NULL DEFAULT now(),
       updated_at    timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await seedCoreUsers()
  ensured = true
}

// Migrate the three legacy "static" accounts into the table exactly once,
// preserving their ids/emails/passwords/session tokens so existing data and
// logins keep working. `ON CONFLICT DO NOTHING` makes this idempotent and means
// that once an account has been edited or deleted by an administrator it is
// never silently recreated.
async function seedCoreUsers(): Promise<void> {
  for (const seed of CORE_USER_SEEDS) {
    try {
      await query(
        `INSERT INTO admin_users (id, email, password, session_token, status, profile, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT DO NOTHING`,
        [
          seed.profile.id,
          seed.email.trim(),
          seed.password,
          seed.profile.sessionToken,
          seed.status,
          JSON.stringify(seed.profile),
          "System (core account)",
        ],
      )
    } catch {
      // Non-fatal: a seed failure must never block the rest of the table from
      // being usable. The account simply isn't migrated yet.
    }
  }
}

function rowToRecord(row: Record<string, unknown>): DynamicUserRecord {
  return {
    id: row.id as string,
    email: row.email as string,
    password: row.password as string,
    sessionToken: row.session_token as string,
    status: (row.status as UserStatus) ?? "active",
    profile: row.profile as SerializableUserProfile,
    createdAt: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    updatedAt: (row.updated_at as Date)?.toISOString?.() ?? String(row.updated_at),
    createdBy: (row.created_by as string) ?? "",
  }
}

/** All dynamic users, newest first. */
export async function listDynamicUsers(): Promise<DynamicUserRecord[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM admin_users ORDER BY created_at DESC`)
  return rows.map(rowToRecord)
}

/**
 * All accounts linked under a given Master id, optionally filtered to a single
 * relationship (e.g. "joint"). Matches on the profile's `masterId` in JSONB.
 * Used to resolve the members of a shared environment (Master + its Joint
 * accounts) so a Joint account can read the Master's full data set.
 */
export async function listAccountsByMaster(
  masterId: string,
  relationship?: string,
): Promise<DynamicUserRecord[]> {
  if (!masterId) return []
  await ensureTable()
  const params: unknown[] = [JSON.stringify({ masterId })]
  let sql = `SELECT * FROM admin_users WHERE profile @> $1::jsonb`
  if (relationship) {
    params.push(JSON.stringify({ relationship }))
    sql += ` AND profile @> $2::jsonb`
  }
  sql += ` ORDER BY created_at DESC`
  const { rows } = await query(sql, params)
  return rows.map(rowToRecord)
}

export async function getDynamicUserById(id: string): Promise<DynamicUserRecord | undefined> {
  if (!id) return undefined
  await ensureTable()
  const { rows } = await query(`SELECT * FROM admin_users WHERE id = $1`, [id])
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

export async function getDynamicUserByEmail(email: string): Promise<DynamicUserRecord | undefined> {
  if (!email) return undefined
  await ensureTable()
  const { rows } = await query(`SELECT * FROM admin_users WHERE lower(email) = lower($1)`, [email.trim()])
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

export async function getDynamicUserBySessionToken(token: string): Promise<DynamicUserRecord | undefined> {
  if (!token) return undefined
  await ensureTable()
  const { rows } = await query(`SELECT * FROM admin_users WHERE session_token = $1`, [token])
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

export interface CreateDynamicUserInput {
  email: string
  password: string
  status?: UserStatus
  profile: SerializableUserProfile
  createdBy?: string
}

export async function insertDynamicUser(input: CreateDynamicUserInput): Promise<DynamicUserRecord> {
  await ensureTable()
  const id = input.profile.id
  const sessionToken = input.profile.sessionToken
  const status = input.status ?? "active"
  const { rows } = await query(
    `INSERT INTO admin_users (id, email, password, session_token, status, profile, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING *`,
    [id, input.email.trim(), input.password, sessionToken, status, JSON.stringify(input.profile), input.createdBy ?? ""],
  )
  return rowToRecord(rows[0])
}

export async function updateDynamicUserProfile(
  id: string,
  patch: { email?: string; password?: string; status?: UserStatus; profile?: SerializableUserProfile },
): Promise<DynamicUserRecord | undefined> {
  await ensureTable()
  const existing = await getDynamicUserById(id)
  if (!existing) return undefined

  const email = patch.email?.trim() || existing.email
  const password = patch.password || existing.password
  const status = patch.status ?? existing.status
  const profile = patch.profile ?? existing.profile
  // Keep the embedded profile's authoritative fields in sync.
  profile.email = email
  profile.password = password

  const { rows } = await query(
    `UPDATE admin_users
        SET email = $2, password = $3, status = $4, profile = $5::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, email, password, status, JSON.stringify(profile)],
  )
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

export async function setDynamicUserStatus(id: string, status: UserStatus): Promise<DynamicUserRecord | undefined> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE admin_users SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  )
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

export async function deleteDynamicUser(id: string): Promise<boolean> {
  await ensureTable()
  const { rowCount } = await query(`DELETE FROM admin_users WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0
}

/** True when an email is already used by a dynamic user (case-insensitive). */
export async function dynamicEmailExists(email: string): Promise<boolean> {
  return !!(await getDynamicUserByEmail(email))
}

export type { SerializableUserProfile, SerializableProfileItem }
