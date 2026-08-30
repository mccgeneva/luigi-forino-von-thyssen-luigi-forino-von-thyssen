import "server-only"
import { query } from "@/lib/db"
import type { GuaranteeOverrideMode } from "@/lib/guarantees-accumulator"

/**
 * Per-customer manual trust-score override. A silent administrator control:
 * one row per user id, `mode` ∈ 'green' | 'red'. Absent = automatic scoring.
 * Reads never throw — they degrade to "no override" so scoring always works.
 */

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS guarantee_overrides (
      user_id    text PRIMARY KEY,
      mode       text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  ensured = true
}

function normalizeMode(v: unknown): GuaranteeOverrideMode | null {
  return v === "green" || v === "red" ? v : null
}

/** The override for a single user, or null when none / on error. */
export async function getGuaranteeOverride(userId: string): Promise<GuaranteeOverrideMode | null> {
  if (!userId) return null
  try {
    await ensureTable()
    const { rows } = await query(`SELECT mode FROM guarantee_overrides WHERE user_id = $1`, [userId])
    if (!rows.length) return null
    return normalizeMode((rows[0] as { mode?: unknown }).mode)
  } catch {
    return null
  }
}

/** Batch read overrides for many users → map of userId → mode. Never throws. */
export async function getGuaranteeOverridesFor(userIds: string[]): Promise<Record<string, GuaranteeOverrideMode>> {
  const out: Record<string, GuaranteeOverrideMode> = {}
  if (!userIds.length) return out
  try {
    await ensureTable()
    const { rows } = await query(`SELECT user_id, mode FROM guarantee_overrides WHERE user_id = ANY($1)`, [userIds])
    for (const r of rows as Array<{ user_id: string; mode: unknown }>) {
      const mode = normalizeMode(r.mode)
      if (mode) out[r.user_id] = mode
    }
  } catch {
    /* degrade to empty */
  }
  return out
}

/** Set (green/red) or clear (null) the override for a user. */
export async function setGuaranteeOverride(userId: string, mode: GuaranteeOverrideMode | null): Promise<void> {
  if (!userId) return
  await ensureTable()
  if (mode === null) {
    await query(`DELETE FROM guarantee_overrides WHERE user_id = $1`, [userId])
    return
  }
  await query(
    `INSERT INTO guarantee_overrides (user_id, mode, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
    [userId, mode],
  )
}
