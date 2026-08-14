import "server-only"
import { query } from "@/lib/db"

/**
 * Global account limits store.
 *
 * The Daily Limit and Monthly Volume shown on every customer's account card are
 * a single PLATFORM-WIDE setting configured by an administrator — not a
 * per-account value. They are persisted here as one canonical row (id =
 * 'global') in Neon so the same figures apply to all users on every device, and
 * an admin change is durable and immediately visible to everyone.
 *
 * Each figure can be marked UNLIMITED independently; when unlimited the numeric
 * amount is ignored and the card displays "Unlimited".
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

const GLOBAL_ID = "global"

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

/** Read the single global limits row, or the default when none is set yet. */
export async function getAccountLimits(): Promise<AccountLimits> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM account_limits WHERE id = $1`, [GLOBAL_ID])
  return rows[0] ? rowToLimits(rows[0]) : { ...DEFAULT_ACCOUNT_LIMITS }
}

/** Upsert the single global limits row. */
export async function saveAccountLimits(input: {
  dailyLimitAmount: number
  dailyLimitUnlimited: boolean
  monthlyVolumeAmount: number
  monthlyVolumeUnlimited: boolean
  currency: string
}): Promise<AccountLimits> {
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
      GLOBAL_ID,
      input.dailyLimitUnlimited ? 0 : Math.max(0, input.dailyLimitAmount),
      input.dailyLimitUnlimited,
      input.monthlyVolumeUnlimited ? 0 : Math.max(0, input.monthlyVolumeAmount),
      input.monthlyVolumeUnlimited,
      input.currency || "EUR",
    ],
  )
  return rowToLimits(rows[0])
}
