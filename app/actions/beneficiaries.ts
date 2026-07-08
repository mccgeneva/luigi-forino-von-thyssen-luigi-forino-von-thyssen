"use server"

import {
  listBeneficiariesForUser,
  listPendingKycBeneficiaries,
  upsertBeneficiary,
  replaceBeneficiariesForUser,
  setBeneficiaryStatus,
  deleteBeneficiary,
} from "@/lib/beneficiaries-db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { logActivity } from "@/app/actions/log-activity"
import { resolveCurrentSession } from "@/lib/session-user"

async function requireAdmin(passcode: string): Promise<void> {
  if (!(await adminActionAuthorized(passcode))) {
    throw new Error("Administrator authorization failed.")
  }
}

/** Replace raw DB/connection failures with a clear, actionable message. */
function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database|connect|pool|password authentication/i.test(msg)) {
    return "Could not reach the database. Please confirm the Neon database is connected (DATABASE_URL) and try again."
  }
  return msg
}

export type BeneficiaryRecord = {
  id: string
  userId: string
  data: Record<string, unknown>
  status: string
  createdAt: string
  updatedAt: string
}

export type BeneficiaryListResult =
  | { ok: true; beneficiaries: BeneficiaryRecord[] }
  | { ok: false; error: string }

export type BeneficiaryMutation =
  | { ok: true; beneficiary?: BeneficiaryRecord }
  | { ok: false; error: string }

// --- Self-service (current signed-in user) ---------------------------------

/**
 * Returns the current user's beneficiaries from the server. Used by the client
 * store to hydrate from the durable source of truth. Returns an empty list (not
 * an error) when there is no session or the DB is unavailable, so the client can
 * gracefully fall back to its local cache.
 */
export async function getMyBeneficiaries(): Promise<BeneficiaryListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: true, beneficiaries: [] }
    const rows = await listBeneficiariesForUser(session.id)
    return { ok: true, beneficiaries: rows }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Mirrors the current user's full beneficiary set to the server. Called by the
 * client store after local changes so the durable copy stays in sync and
 * administrators always see the latest data.
 */
export async function syncMyBeneficiaries(
  items: { id: string; data: Record<string, unknown>; status: string }[],
): Promise<BeneficiaryMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "No active session." }
    await replaceBeneficiariesForUser(session.id, items)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Durably persist a SINGLE beneficiary for the current user and return the
 * stored row. The client calls this when the user adds (or edits) a beneficiary
 * so the record is committed to Neon immediately and the UI can confirm success
 * — independent of the background full-set mirror (`syncMyBeneficiaries`), which
 * is fire-and-forget and can race with refetches. Returns an error the UI can
 * show instead of silently losing the record.
 */
export async function upsertMyBeneficiary(
  id: string,
  data: Record<string, unknown>,
  status: string,
): Promise<BeneficiaryMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
    const row = await upsertBeneficiary(session.id, id, data, status)
    return { ok: true, beneficiary: row }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Admin management (on behalf of any user) ------------------------------

export async function adminListBeneficiaries(passcode: string, userId: string): Promise<BeneficiaryListResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listBeneficiariesForUser(userId)
    return { ok: true, beneficiaries: rows }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * List every beneficiary still awaiting a KYC decision, across all clients.
 * Powers the KYC tile in the admin Pending Decisions command center. Returns an
 * empty list (not an error) when the DB is unavailable so the panel still loads.
 */
export async function adminListPendingKyc(passcode: string): Promise<BeneficiaryListResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listPendingKycBeneficiaries()
    return { ok: true, beneficiaries: rows }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminUpsertBeneficiary(
  passcode: string,
  userId: string,
  id: string,
  data: Record<string, unknown>,
  status: string,
  adminName?: string,
): Promise<BeneficiaryMutation> {
  try {
    await requireAdmin(passcode)
    const row = await upsertBeneficiary(userId, id, data, status)
    await logActivity({
      action: "Administrator saved a beneficiary",
      category: "Administration / Beneficiaries",
      user: adminName || "Administrator",
      details: {
        beneficiary: (data.name as string) || id,
        ownerUserId: userId,
        status,
        result: "saved",
      },
    })
    return { ok: true, beneficiary: row }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminSetBeneficiaryStatus(
  passcode: string,
  id: string,
  status: string,
  adminName?: string,
): Promise<BeneficiaryMutation> {
  try {
    await requireAdmin(passcode)
    const row = await setBeneficiaryStatus(id, status)
    if (!row) return { ok: false, error: "Beneficiary not found." }
    await logActivity({
      action: `Administrator set beneficiary status to ${status}`,
      category: "Administration / Beneficiaries",
      user: adminName || "Administrator",
      details: {
        beneficiary: (row.data.name as string) || id,
        ownerUserId: row.userId,
        status,
        result: status === "active" ? "approved" : status,
      },
    })
    return { ok: true, beneficiary: row }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminDeleteBeneficiary(
  passcode: string,
  id: string,
  adminName?: string,
): Promise<BeneficiaryMutation> {
  try {
    await requireAdmin(passcode)
    await deleteBeneficiary(id)
    await logActivity({
      action: "Administrator removed a beneficiary",
      category: "Administration / Beneficiaries",
      user: adminName || "Administrator",
      details: { beneficiaryId: id, result: "deleted" },
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}
