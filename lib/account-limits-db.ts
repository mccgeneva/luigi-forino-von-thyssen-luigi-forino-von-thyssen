import "server-only"
import { query } from "@/lib/db"

/**
 * Account limits store.
 *
 * The Daily Limit and Monthly Volume shown on a customer's account card are
 * configured by an administrator and persisted in Neon so they are durable and
 * consistent across devices.
 *
 * There are two levels:
 *  - a PLATFORM-WIDE default row (id = 'global') that applies to every user, and
 *  - optional PER-USER override rows (id = the user's account id) that take
 *    precedence for that specific user.
 *
 * Effective limits for a user = their own override if one exists, otherwise the
 * global default, otherwise the built-in default. Each figure can be marked
 * UNLIMITED independently; when unlimited the numeric amount is ignored and the
 * card displays "Unlimited".
 */

export interface AccountLimits {
  dailyLimitAmount: number
  dailyLimitUnlimited: boolean
  monthlyVolumeAmount: number
  monthlyVolumeUnlimited: boolean
  currency: string
  updatedAt: string | null
}

/** Sensible default before an administrator has ever configured the limits. */
export const DEFAULT_ACCOUNT_LIMITS: AccountLimits = {
  dailyLimitAmount: 0,
  dailyLimitUnlimited: false,
  monthlyVolumeAmount: 0,
  monthlyVolumeUnlimited: false,
  currency: "EUR",
  updatedAt: null,
}

/** Row id of the platform-wide default that applies to every user. Per-user
 *  override rows use the user's own account id as their row id. */
export const GLOBAL_ACCOUNT_LIMITS_ID = "global"
const GLOBAL_ID = GLOBAL_ACCOUNT_LIMITS_ID

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS account_limits (
       id                        text        PRIMARY KEY,
       daily_limit_amount        numeric     NOT NULL DEFAULT 0,
       daily_limit_unlimited     boolean     NOT NULL DEFAULT false,
       monthly_volume_amount     numeric     NOT NULL DEFAULT 0,
       monthly_volume_unlimited  boolean     NOT NULL DEFAULT false,
       currency                  text        NOT NULL DEFAULT 'EUR',
       updated_at                timestamptz NOT NULL DEFAULT now()
     )`,
  )
  ensured = true
}

function rowToLimits(row: Record<string, unknown>): AccountLimits {
  return {
    dailyLimitAmount: Number(row.daily_limit_amount ?? 0),
    dailyLimitUnlimited: Boolean(row.daily_limit_unlimited),
    monthlyVolumeAmount: Number(row.monthly_volume_amount ?? 0),
    monthlyVolumeUnlimited: Boolean(row.monthly_volume_unlimited),
    currency: (row.currency as string) || "EUR",
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  }
}

/** Read a single limits row by id (global or a user id). Null when unset. */
export async function readAccountLimitsRow(id: string): Promise<AccountLimits | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM account_limits WHERE id = $1`, [id])
  return rows[0] ? rowToLimits(rows[0]) : null
}

/**
 * Effective limits for a user: their own per-user override if one exists,
 * otherwise the platform-wide global default, otherwise the built-in default.
 * Pass no `userId` (or the global id) to read the global default directly.
 */
export async function getAccountLimits(userId?: string | null): Promise<AccountLimits> {
  await ensureTable()
  if (userId && userId !== GLOBAL_ID) {
    const own = await readAccountLimitsRow(userId)
    if (own) return own
  }
  const global = await readAccountLimitsRow(GLOBAL_ID)
  return global ?? { ...DEFAULT_ACCOUNT_LIMITS }
}

/** True when a specific per-user override row exists for this user. */
export async function hasAccountLimitsOverride(userId: string): Promise<boolean> {
  if (!userId || userId === GLOBAL_ID) return false
  return (await readAccountLimitsRow(userId)) != null
}

/**
 * Upsert a limits row. `targetId` is the platform-wide global id to set the
 * default for everyone, or a user's account id to set a per-user override.
 */
export async function saveAccountLimits(
  targetId: string,
  input: {
    dailyLimitAmount: number
    dailyLimitUnlimited: boolean
    monthlyVolumeAmount: number
    monthlyVolumeUnlimited: boolean
    currency: string
  },
): Promise<AccountLimits> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO account_limits
       (id, daily_limit_amount, daily_limit_unlimited, monthly_volume_amount, monthly_volume_unlimited, currency, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       daily_limit_amount       = EXCLUDED.daily_limit_amount,
       daily_limit_unlimited    = EXCLUDED.daily_limit_unlimited,
       monthly_volume_amount    = EXCLUDED.monthly_volume_amount,
       monthly_volume_unlimited = EXCLUDED.monthly_volume_unlimited,
       currency                 = EXCLUDED.currency,
       updated_at               = now()
     RETURNING *`,
    [
      targetId || GLOBAL_ID,
      input.dailyLimitUnlimited ? 0 : Math.max(0, input.dailyLimitAmount),
      input.dailyLimitUnlimited,
      input.monthlyVolumeUnlimited ? 0 : Math.max(0, input.monthlyVolumeAmount),
      input.monthlyVolumeUnlimited,
      input.currency || "EUR",
    ],
  )
  return rowToLimits(rows[0])
}

/**
 * Remove a per-user override so the user reverts to the platform-wide default.
 * The global row is never deleted through this path.
 */
export async function clearAccountLimits(targetId: string): Promise<void> {
  if (!targetId || targetId === GLOBAL_ID) return
  await ensureTable()
  await query(`DELETE FROM account_limits WHERE id = $1`, [targetId])
}
