"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { PARTNER_BANKS, type PartnerBank } from "@/lib/partner-banks"
import {
  mergedPartnerBanks,
  listCustomBanks,
  upsertCustomBank,
  deleteCustomBank,
  type CustomBankInput,
} from "@/lib/gateway-banks-db"

/**
 * The live partner-bank directory (code baseline + admin-added rows). Client
 * callable — bank identities are non-sensitive. Falls back to the code baseline
 * on any failure so the picker is never empty.
 */
export async function getPartnerBankDirectory(): Promise<PartnerBank[]> {
  try {
    return await mergedPartnerBanks()
  } catch {
    return PARTNER_BANKS
  }
}

export type AdminBankRow = PartnerBank & { source: "built-in" | "custom" }

export type AdminBankListResult =
  | { ok: true; banks: AdminBankRow[] }
  | { ok: false; error: string }

/** Admin view of the full directory, tagged built-in vs custom (deletable). */
export async function listPartnerBanksAdmin(passcode: string): Promise<AdminBankListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session?.profile) return { ok: false, error: "Your session has expired. Please sign in again." }
    if (!(await adminActionAuthorized(passcode))) {
      return { ok: false, error: "Administrator authorization failed." }
    }
    const custom = await listCustomBanks()
    const customKeys = new Set(custom.map((b) => b.key))
    const merged: AdminBankRow[] = []
    const byKey = new Map<string, PartnerBank>()
    for (const b of PARTNER_BANKS) byKey.set(b.key, b)
    for (const b of custom) byKey.set(b.key, b)
    for (const b of byKey.values()) {
      merged.push({ ...b, source: customKeys.has(b.key) ? "custom" : "built-in" })
    }
    merged.sort((a, b) => a.name.localeCompare(b.name))
    return { ok: true, banks: merged }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export type AddBankResult = { ok: true; bank: PartnerBank } | { ok: false; error: string }

/** Admin: add or edit a partner bank in the database (no redeploy needed). */
export async function addPartnerBankAdmin(
  passcode: string,
  input: CustomBankInput,
): Promise<AddBankResult> {
  const session = await resolveCurrentSession()
  if (!session?.profile) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }

  const result = await upsertCustomBank(input)
  if (!result.ok) return result

  await logActivity({
    action: `Administrator added partner bank ${result.bank.name}`,
    category: "Administration",
    user: `${session.profile.fullName} (${session.profile.company})`,
    details: {
      summary: `Administrator added correspondent bank ${result.bank.name} (${result.bank.country}, BIC ${result.bank.bic}) issuing ${result.bank.currencies.join(", ")}. It is now selectable in the Payment Gateway without a redeploy.`,
      partnerBank: result.bank.name,
      country: result.bank.country,
      bic: result.bank.bic,
      currencies: result.bank.currencies.join(", "),
      region: result.bank.region,
    },
  })

  return result
}

/** Admin: remove a custom (database-added) partner bank. */
export async function removePartnerBankAdmin(
  passcode: string,
  bankKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session?.profile) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  const result = await deleteCustomBank(bankKey)
  if (result.ok) {
    await logActivity({
      action: `Administrator removed custom partner bank`,
      category: "Administration",
      user: `${session.profile.fullName} (${session.profile.company})`,
      details: { summary: `Administrator removed the custom partner bank "${bankKey}" from the directory.` },
    })
  }
  return result
}
