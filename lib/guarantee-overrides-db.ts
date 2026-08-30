import "server-only"
import { query } from "@/lib/db"

/**
 * Per-customer manual trust-score override. A silent administrator control:
 * one row per user id holding a `forced_score` (0..100) that the admin dragged
 * to. Absent row = automatic scoring. Reads never throw — they degrade to
 * "no override" so scoring always works.
 */

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS guarantee_overrides (
      user_id      text PRIMARY KEY,
      mode         text,
      forced_score numeric,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `)
  // This table may pre-exist from the earlier green/red design with a NOT NULL
  // `mode` column. Add the numeric column, relax `mode`, and convert any legacy
  // rows (green → 0, red → 36) so existing overrides keep working.
  await query(`ALTER TABLE guarantee_overrides ADD COLUMN IF NOT EXISTS forced_score numeric`)
  await query(`ALTER TABLE guarantee_overrides ALTER COLUMN mode DROP NOT NULL`).catch(() => {})
  await query(
    `UPDATE guarantee_overrides
        SET forced_score = CASE WHEN mode = 'green' THEN 0 WHEN mode = 'red' THEN 36 ELSE forced_score END
      WHERE forced_score IS NULL AND mode IS NOT NULL`,
  )
  ensured = true
}

function normalizeScore(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100))
}

/** The forced score for a single user, or null when none / on error. */
export async function getGuaranteeOverride(userId: string): Promise<number | null> {
  if (!userId) return null
  try {
    await ensureTable()
    const { rows } = await query(`SELECT forced_score FROM guarantee_overrides WHERE user_id = $1`, [userId])
    if (!rows.length) return null
    return normalizeScore((rows[0] as { forced_score?: unknown }).forced_score)
  } catch {
    return null
  }
}

/** Batch read forced scores for many users → map of userId → score. Never throws. */
export async function getGuaranteeOverridesFor(userIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  if (!userIds.length) return out
  try {
    await ensureTable()
    const { rows } = await query(
      `SELECT user_id, forced_score FROM guarantee_overrides WHERE user_id = ANY($1)`,
      [userIds],
    )
    for (const r of rows as Array<{ user_id: string; forced_score: unknown }>) {
      const v = normalizeScore(r.forced_score)
      if (v != null) out[r.user_id] = v
    }
  } catch {
    /* degrade to empty */
  }
  return out
}

/** Set the forced score (0..100) or clear (null = automatic scoring) for a user. */
export async function setGuaranteeOverride(userId: string, forcedScore: number | null): Promise<void> {
  if (!userId) return
  await ensureTable()
  if (forcedScore === null) {
    await query(`DELETE FROM guarantee_overrides WHERE user_id = $1`, [userId])
    return
  }
  const v = normalizeScore(forcedScore) ?? 0
  await query(
    `INSERT INTO guarantee_overrides (user_id, forced_score, mode, updated_at) VALUES ($1, $2, NULL, now())
     ON CONFLICT (user_id) DO UPDATE SET forced_score = EXCLUDED.forced_score, mode = NULL, updated_at = now()`,
    [userId, v],
  )
}
