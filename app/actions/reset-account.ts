"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import { query } from "@/lib/db"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { resolveCurrentSession } from "@/lib/session-user"

/**
 * Every server-side table that holds per-account data, all keyed by `user_id`.
 * Wiping these rows for a single account restores it to a brand-new state on the
 * SERVER — the authoritative source the in-memory stores hydrate from.
 * (Clearing localStorage alone is not enough: balances, transactions, requests,
 * beneficiaries, etc. live in Neon and would otherwise reappear after login.)
 */
const PER_USER_TABLES = [
  "ledger_entries", // balances + transaction history
  "approval_requests", // payments / commodity / leverage / Yield-PPP / DOF / DTC requests
  "client_beneficiaries", // beneficiaries
  "client_skr_records", // SKR records
  "client_skr_requests", // SKR requests
  "certificate_requests", // bank instruments / certificate requests
  "swift_routing_requests", // SWIFT routing queue items
  "user_notifications", // notification feed
] as const

export type ResetAccountResult =
  | { ok: true; cleared: number; targetName: string; targetEmail: string }
  | { ok: false; error: string }

/**
 * Per-account "reset epoch": a server-side timestamp stamped on every reset.
 *
 * The stores now hydrate exclusively from Neon (no localStorage caching) and
 * poll/refetch on an interval and on window focus, so a reset that wipes the
 * server tables surfaces to the client on its own — no client-side purge gate is
 * needed. This timestamp is retained as a lightweight, durable audit signal of
 * when an account was last reset, exposed via getMyResetEpoch for any future
 * "your account was reset" surfacing.
 */
let resetMarksEnsured = false
async function ensureResetMarksTable(): Promise<void> {
  if (resetMarksEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS account_reset_marks (
       user_id  text        PRIMARY KEY,
       reset_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  resetMarksEnsured = true
}

/**
 * Returns the most recent reset timestamp (ISO string) that applies to the
 * signed-in session — checking both this account's own id and its shared-data
 * owner id (a sub-account inherits its Master's reset). Null when never reset.
 */
export async function getMyResetEpoch(): Promise<string | null> {
  const session = await resolveCurrentSession()
  if (!session) return null
  const ids = Array.from(new Set([session.id, session.dataOwnerId].filter(Boolean)))
  if (ids.length === 0) return null
  try {
    await ensureResetMarksTable()
    const { rows } = await query(
      `SELECT MAX(reset_at) AS reset_at FROM account_reset_marks WHERE user_id = ANY($1)`,
      [ids],
    )
    const v = rows[0]?.reset_at
    return v ? new Date(v as string).toISOString() : null
  } catch (err) {
    console.log("[v0] getMyResetEpoch failed:", (err as Error).message)
    return null
  }
}

/**
 * Administrator Danger-Zone reset of ONE specific account's server-side data.
 *
 * Isolation guarantee: the wipe is scoped STRICTLY to the selected account's own
 * `user_id`. It deliberately does NOT expand to a shared-data owner (a
 * sub-account's Master), because deleting the Master's rows would also wipe the
 * balance/history shared with the Master and its other sub-accounts. Restricting
 * the DELETE to the chosen id guarantees no other user's data is ever affected.
 */
export async function resetServerAccountDataForUser(
  passcode: string,
  targetUserId: string,
): Promise<ResetAccountResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }

  const id = targetUserId?.trim()
  if (!id) return { ok: false, error: "Select an account to reset first." }

  // Confirm the account exists so a typo / stale id can never silently no-op,
  // and so we can echo back exactly which account was reset.
  const target = await getDynamicUserById(id)
  if (!target) {
    return { ok: false, error: "The selected account could not be found." }
  }

  let cleared = 0
  for (const table of PER_USER_TABLES) {
    try {
      // Strictly this account's own rows — never ANY()/owner expansion.
      const res = await query(`DELETE FROM ${table} WHERE user_id = $1`, [id])
      cleared += res.rowCount ?? 0
    } catch (err) {
      // A missing table (never bootstrapped yet) is not an error for a reset —
      // there is simply nothing to clear. Log and continue with the rest.
      console.log(`[v0] reset: skipped ${table}:`, (err as Error).message)
    }
  }

  // Stamp the reset epoch so the selected account's own browser purges its local
  // caches (balances/transactions/etc.) on its next load — making the reset
  // actually stick on the user's device, not just on the server.
  try {
    await ensureResetMarksTable()
    await query(
      `INSERT INTO account_reset_marks (user_id, reset_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET reset_at = now()`,
      [id],
    )
  } catch (err) {
    console.log("[v0] reset: failed to stamp reset epoch:", (err as Error).message)
  }

  return {
    ok: true,
    cleared,
    targetName: target.profile.fullName || target.profile.company || target.email,
    targetEmail: target.email,
  }
}
