// ---------------------------------------------------------------------------
// Biometric storage — server-only. Lives in dedicated columns on `admin_users`
// that are NEVER included in `rowToRecord`/`DynamicUserRecord`, so encrypted
// face data can never be serialized to a client or leaked through the profile.
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import { FACE_MAX_FAILS } from "@/lib/biometric"
import type { FaceState, IdentityStatus } from "@/lib/biometric-types"

export type { FaceState, IdentityStatus }

let ensured = false
async function ensureColumns(): Promise<void> {
  if (ensured) return
  // Idempotent migration. `admin_users` is created in lib/admin-users-db.ts;
  // here we only add the biometric columns if they don't yet exist.
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS face_descriptor text`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS face_fail_count integer NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS face_locked boolean NOT NULL DEFAULT false`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS face_enrolled_at timestamptz`)
  // Identity-verification (passport + selfie) gate. We store ONLY non-sensitive
  // summary fields for display/audit — never the passport image itself, which is
  // deleted from Blob immediately after the one-time check. The verified live
  // selfie is enrolled through the existing `face_descriptor` column.
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS identity_verified boolean NOT NULL DEFAULT false`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS identity_country text`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS identity_full_name text`)
  await query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS identity_passport_last4 text`)
  ensured = true
}

/** Lightweight enrollment status for UI and login gating (no descriptor data). */
export async function getFaceState(userId: string): Promise<FaceState> {
  if (!userId) return { enrolled: false, locked: false, failCount: 0, enrolledAt: null }
  await ensureColumns()
  const { rows } = await query(
    `SELECT face_descriptor, face_fail_count, face_locked, face_enrolled_at FROM admin_users WHERE id = $1`,
    [userId],
  )
  const row = rows[0]
  if (!row) return { enrolled: false, locked: false, failCount: 0, enrolledAt: null }
  return {
    enrolled: !!row.face_descriptor,
    locked: !!row.face_locked,
    failCount: (row.face_fail_count as number) ?? 0,
    enrolledAt: (row.face_enrolled_at as Date)?.toISOString?.() ?? (row.face_enrolled_at as string | null),
  }
}

/** The raw encrypted descriptor blob — server-side use only (login verify). */
export async function getEncryptedDescriptor(userId: string): Promise<string | null> {
  if (!userId) return null
  await ensureColumns()
  const { rows } = await query(`SELECT face_descriptor FROM admin_users WHERE id = $1`, [userId])
  return (rows[0]?.face_descriptor as string | null) ?? null
}

/** Store (or replace) a user's encrypted enrollment and reset lock/fail state. */
export async function saveEncryptedDescriptor(userId: string, blob: string): Promise<void> {
  await ensureColumns()
  await query(
    `UPDATE admin_users
        SET face_descriptor = $2, face_fail_count = 0, face_locked = false,
            face_enrolled_at = now(), updated_at = now()
      WHERE id = $1`,
    [userId, blob],
  )
}

/**
 * Remove a user's enrollment entirely and clear lock/fail state (admin reset /
 * self-disable). Also clears identity verification so a reset user must re-prove
 * their identity (passport + selfie) on their next login rather than silently
 * skipping the gate.
 */
export async function clearEnrollment(userId: string): Promise<void> {
  await ensureColumns()
  await query(
    `UPDATE admin_users
        SET face_descriptor = NULL, face_fail_count = 0, face_locked = false,
            face_enrolled_at = NULL,
            identity_verified = false, identity_verified_at = NULL,
            identity_country = NULL, identity_full_name = NULL, identity_passport_last4 = NULL,
            updated_at = now()
      WHERE id = $1`,
    [userId],
  )
}

/** Identity-verification status for login gating and profile display. */
export async function getIdentityStatus(userId: string): Promise<IdentityStatus> {
  const empty: IdentityStatus = {
    verified: false,
    verifiedAt: null,
    country: null,
    fullName: null,
    passportLast4: null,
  }
  if (!userId) return empty
  await ensureColumns()
  const { rows } = await query(
    `SELECT identity_verified, identity_verified_at, identity_country, identity_full_name, identity_passport_last4
       FROM admin_users WHERE id = $1`,
    [userId],
  )
  const row = rows[0]
  if (!row) return empty
  return {
    verified: !!row.identity_verified,
    verifiedAt: (row.identity_verified_at as Date)?.toISOString?.() ?? (row.identity_verified_at as string | null),
    country: (row.identity_country as string | null) ?? null,
    fullName: (row.identity_full_name as string | null) ?? null,
    passportLast4: (row.identity_passport_last4 as string | null) ?? null,
  }
}

/** Mark a user identity-verified and record the non-sensitive passport summary. */
export async function markIdentityVerified(
  userId: string,
  meta: { country?: string | null; fullName?: string | null; passportLast4?: string | null },
): Promise<void> {
  await ensureColumns()
  await query(
    `UPDATE admin_users
        SET identity_verified = true, identity_verified_at = now(),
            identity_country = $2, identity_full_name = $3, identity_passport_last4 = $4,
            updated_at = now()
      WHERE id = $1`,
    [userId, meta.country || null, meta.fullName || null, meta.passportLast4 || null],
  )
}

/** Reset the consecutive-failure counter after a successful match. */
export async function resetFailCount(userId: string): Promise<void> {
  await ensureColumns()
  await query(`UPDATE admin_users SET face_fail_count = 0 WHERE id = $1`, [userId])
}

/**
 * Record a failed scan. Increments the counter and, once it reaches the limit,
 * LOCKS biometric login (which then requires an administrator reset). Returns
 * the new state so the caller can message the user appropriately.
 */
export async function registerFailure(userId: string): Promise<{ failCount: number; locked: boolean }> {
  await ensureColumns()
  const { rows } = await query(
    `UPDATE admin_users
        SET face_fail_count = face_fail_count + 1,
            face_locked = (face_fail_count + 1) >= $2,
            updated_at = now()
      WHERE id = $1
      RETURNING face_fail_count, face_locked`,
    [userId, FACE_MAX_FAILS],
  )
  const row = rows[0]
  return { failCount: (row?.face_fail_count as number) ?? 0, locked: !!row?.face_locked }
}
