"use server"

import {
  getAccountLimits as readAccountLimits,
  saveAccountLimits,
  DEFAULT_ACCOUNT_LIMITS,
  type AccountLimits,
} from "@/lib/account-limits-db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { logActivity } from "@/app/actions/log-activity"

export type { AccountLimits }

/** Public (session-gated by the proxy) read of the global account limits. Used
 *  by the customer account card and the admin panel alike. Never throws — falls
 *  back to the default so the UI always renders. */
export async function fetchAccountLimits(): Promise<AccountLimits> {
  try {
    return await readAccountLimits()
  } catch {
    return { ...DEFAULT_ACCOUNT_LIMITS }
  }
}

export interface UpdateAccountLimitsInput {
  passcode: string
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

/** Admin: set the platform-wide Daily Limit and Monthly Volume for all users. */
export async function updateAccountLimitsAdmin(
  input: UpdateAccountLimitsInput,
): Promise<UpdateAccountLimitsResult> {
  try {
    if (!(await adminActionAuthorized(input.passcode))) {
      return { ok: false, error: "Administrator authorization failed." }
    }
    const limits = await saveAccountLimits({
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

    await logActivity({
      action: "Administrator updated global account limits",
      category: "Administration / Limits",
      user: input.adminName || "Administrator",
      details: {
        summary: `Platform-wide account limits set for all users — Daily Limit: ${daily}; Monthly Volume: ${monthly}.`,
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
