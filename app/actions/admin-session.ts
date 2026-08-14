"use server"

import { isCurrentSessionAdmin, adminActionAuthorized } from "@/lib/admin-auth"

/**
 * Verify an administrator unlocking the panel. Both factors are checked on the
 * server: the caller must be an authorized admin account (role) AND present the
 * correct PIN (secret). The PIN is never compared in the browser, so it is no
 * longer meaningful to read it from the client bundle.
 */
export async function verifyAdminGate(
  pin: string,
): Promise<{ ok: true } | { ok: false; reason: "forbidden" | "pin" }> {
  try {
    if (!(await isCurrentSessionAdmin())) return { ok: false, reason: "forbidden" }
    if (!(await adminActionAuthorized(pin))) return { ok: false, reason: "pin" }
    return { ok: true }
  } catch {
    // Never reject the RPC: a thrown server error would surface on the client
    // as the opaque "Could not verify administrator access" message with no
    // actionable reason. Treat an unexpected failure as a (retryable) PIN
    // rejection so the admin gets a clear message and can try again.
    return { ok: false, reason: "pin" }
  }
}

/**
 * Re-confirm (server-side) that the current session is an admin. Used to
 * validate a persisted "unlocked" flag on mount so a stale client flag — e.g.
 * one left in sessionStorage after a previous user logged out — can never by
 * itself unlock the panel for a non-admin.
 */
export async function confirmAdminSession(): Promise<boolean> {
  return isCurrentSessionAdmin()
}
