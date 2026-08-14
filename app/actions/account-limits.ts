"use server"

import {
  getAccountLimits as readAccountLimits,
  hasAccountLimitsOverride,
  saveAccountLimits,
  clearAccountLimits,
  DEFAULT_ACCOUNT_LIMITS,
  GLOBAL_ACCOUNT_LIMITS_ID,
  type AccountLimits,
} from "@/lib/account-limits-db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { logActivity } from "@/app/actions/log-activity"

export type { AccountLimits }

/**
 * Public (session-gated by the proxy) read of the EFFECTIVE account limits for a
 * user: their per-user override if one exists, otherwise the platform-wide
 * default. Pass the customer's account id so a per-user override is honored;
 * omit it to read the global default. Never throws — falls back to the built-in
 * default so the UI always renders.
 */
export async function fetchAccountLimits(userId?: string | null): Promise<AccountLimits> {
  try {
    return await readAccountLimits(userId ?? undefined)
  } catch {
    return { ...DEFAULT_ACCOUNT_LIMITS }
  }
}

export type AdminAccountLimitsView = {
  ok: true
  limits: AccountLimits
  hasOverride: boolean
} | { ok: false; error: string }

/**
 * Admin: read the limits to pre-fill the editor for a chosen target. `targetId`
 * is the global id (platform default) or a user's account id. For a user it
 * returns their override when present (with `hasOverride: true`), otherwise the
 * effective values they currently inherit from the global default.
 */
export async function fetchAccountLimitsForTarget(
  passcode: string,
  targetId: string,
): Promise<AdminAccountLimitsView> {
  try {
    if (!(await adminActionAuthorized(passcode))) {
      return { ok: false, error: "Administrator authorization failed." }
    }
    const isGlobal = !targetId || targetId === GLOBAL_ACCOUNT_LIMITS_ID
    const limits = await readAccountLimits(isGlobal ? undefined : targetId)
    const hasOverride = isGlobal ? false : await hasAccountLimitsOverride(targetId)
    return { ok: true, limits, hasOverride }
  } catch {
    return { ok: false, error: "Could not load account limits." }
  }
}

export interface UpdateAccountLimitsInput {
  passcode: string
  /** Global id ('global') to set the platform default, or a user's account id
   *  to set a per-user override. Defaults to the global default. */
  targetId?: string
  /** Human-readable target name, used only for the activity-log summary. */
  targetName?: string
  dailyLimitAmount: number
  dailyLimitUnlimited: boolean
  monthlyVolumeAmount: number
  monthlyVolumeUnlimited: boolean
  currency: string
  adminName?: string
}

export type UpdateAccountLimitsResult =
  | { ok: true; limits: AccountLimits }
  | { ok: false; error: string }

/**
 * Admin: set the Daily Limit and Monthly Volume for a target — either the
 * platform-wide default (all users) or a specific user's override.
 */
export async function updateAccountLimitsAdmin(
  input: UpdateAccountLimitsInput,
): Promise<UpdateAccountLimitsResult> {
  try {
    if (!(await adminActionAuthorized(input.passcode))) {
      return { ok: false, error: "Administrator authorization failed." }
    }
    const targetId = input.targetId || GLOBAL_ACCOUNT_LIMITS_ID
    const isGlobal = targetId === GLOBAL_ACCOUNT_LIMITS_ID
    const limits = await saveAccountLimits(targetId, {
      dailyLimitAmount: Number.isFinite(input.dailyLimitAmount) ? input.dailyLimitAmount : 0,
      dailyLimitUnlimited: !!input.dailyLimitUnlimited,
      monthlyVolumeAmount: Number.isFinite(input.monthlyVolumeAmount) ? input.monthlyVolumeAmount : 0,
      monthlyVolumeUnlimited: !!input.monthlyVolumeUnlimited,
      currency: (input.currency || "EUR").toUpperCase(),
    })

    const daily = limits.dailyLimitUnlimited ? "Unlimited" : `${limits.currency} ${limits.dailyLimitAmount.toLocaleString()}`
    const monthly = limits.monthlyVolumeUnlimited
      ? "Unlimited"
      : `${limits.currency} ${limits.monthlyVolumeAmount.toLocaleString()}`
    const scope = isGlobal ? "all users (platform default)" : input.targetName || `user ${targetId}`

    await logActivity({
      action: isGlobal ? "Administrator updated global account limits" : "Administrator set per-user account limits",
      category: "Administration / Limits",
      user: input.adminName || "Administrator",
      details: {
        summary: `Account limits set for ${scope} — Daily Limit: ${daily}; Monthly Volume: ${monthly}.`,
        target: scope,
        dailyLimit: daily,
        monthlyVolume: monthly,
      },
    })

    return { ok: true, limits }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database|connect|pool|password authentication/i.test(msg)) {
      return { ok: false, error: "Could not reach the database. Please confirm Neon is connected and try again." }
    }
    return { ok: false, error: msg }
  }
}

/**
 * Admin: remove a user's per-user override so they revert to the platform-wide
 * default. Returns the effective (now global) limits for the user.
 */
export async function clearAccountLimitsAdmin(
  passcode: string,
  userId: string,
  targetName?: string,
): Promise<UpdateAccountLimitsResult> {
  try {
    if (!(await adminActionAuthorized(passcode))) {
      return { ok: false, error: "Administrator authorization failed." }
    }
    if (!userId || userId === GLOBAL_ACCOUNT_LIMITS_ID) {
      return { ok: false, error: "Select a specific user to reset." }
    }
    await clearAccountLimits(userId)
    const limits = await readAccountLimits(userId) // now resolves to the global default
    await logActivity({
      action: "Administrator reset per-user account limits",
      category: "Administration / Limits",
      user: "Administrator",
      details: {
        summary: `Per-user account limits reset to platform default for ${targetName || `user ${userId}`}.`,
        target: targetName || `user ${userId}`,
      },
    })
    return { ok: true, limits }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    return { ok: false, error: msg }
  }
}
