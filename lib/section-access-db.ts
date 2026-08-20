import "server-only"
import { query } from "@/lib/db"
import type { SectionAccessMap, SectionOverride } from "@/lib/dashboard-sections"

/**
 * Per-user section-access overrides.
 *
 * An administrator can, for any individual user, force a dashboard section to be
 * "locked" (blocked regardless of tier) or "unlocked" (allowed regardless of
 * tier — e.g. granting a Visitor full access to a specific section). Absence of
 * a row means "no override" → the section falls back to the tier default (see
 * lib/dashboard-sections.ts `evaluateSectionAccess`).
 *
 * Rows are keyed by (user_id, section_key). Persisted in Neon so the rule is
 * durable and consistent across devices and sessions.
 */

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS user_section_access (
       user_id      text        NOT NULL,
       section_key  text        NOT NULL,
       access       text        NOT NULL,
       updated_at   timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, section_key)
     )`,
  )
  ensured = true
}

/** All overrides for a single user as a section key → access map. Empty object
 *  when the user has no overrides (or on any error — access must fail open to
 *  the tier default, never hard-block on a DB hiccup). */
export async function getUserSectionAccess(userId: string): Promise<SectionAccessMap> {
  if (!userId) return {}
  try {
    await ensureTable()
    const { rows } = await query(
      `SELECT section_key, access FROM user_section_access WHERE user_id = $1`,
      [userId],
    )
    const map: SectionAccessMap = {}
    for (const row of rows) {
      const access = String(row.access)
      if (access === "locked" || access === "unlocked") {
        map[String(row.section_key)] = access
      }
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Set (or clear) one section override for a user.
 *  - "locked" / "unlocked" → upsert the row.
 *  - "default"             → delete the row so the section reverts to the tier
 *                            default.
 */
export async function setUserSectionAccess(
  userId: string,
  sectionKey: string,
  access: SectionOverride | "default",
): Promise<void> {
  if (!userId || !sectionKey) return
  await ensureTable()
  if (access === "default") {
    await query(`DELETE FROM user_section_access WHERE user_id = $1 AND section_key = $2`, [
      userId,
      sectionKey,
    ])
    return
  }
  await query(
    `INSERT INTO user_section_access (user_id, section_key, access, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, section_key) DO UPDATE SET
       access     = EXCLUDED.access,
       updated_at = now()`,
    [userId, sectionKey, access],
  )
}

/** Remove every override for a user (revert them entirely to tier defaults). */
export async function clearUserSectionAccess(userId: string): Promise<void> {
  if (!userId) return
  await ensureTable()
  await query(`DELETE FROM user_section_access WHERE user_id = $1`, [userId])
}
