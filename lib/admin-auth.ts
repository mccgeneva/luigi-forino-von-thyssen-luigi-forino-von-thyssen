// ---------------------------------------------------------------------------
// Server-side administrator authorization (server-only).
//
// This is the REAL admin gate. It replaces the previous client-only scheme
// where a passcode bundled into the browser JS was compared in React state —
// which let any authenticated client open the admin panel and act on any
// account. Authorization is now decided on the server from two independent
// factors:
//
//   1. ROLE  — the signed-in account's email must be in the admin allowlist.
//   2. PIN   — a 6-digit secret verified here, never shipped to the client.
//
// Both the allowlist and the PIN come from environment variables (with safe
// fallbacks equal to the historical values) so they can be rotated without a
// code deploy and the PIN never appears in the client bundle.
// ---------------------------------------------------------------------------

import "server-only"
import { cookies } from "next/headers"
import { SESSION_COOKIE, IMPERSONATION_COOKIE } from "@/lib/auth"
import { verifyImpersonation } from "@/lib/session-token"
import { getDynamicUserById, getDynamicUserBySessionToken } from "@/lib/admin-users-db"

/** Historical values, used only as fallbacks when env vars are unset. */
const DEFAULT_ADMIN_EMAILS = ["president@mccpetroli.com", "admin@mccgva.ch"]
const DEFAULT_ADMIN_PIN = "270476"

/** The configured admin email allowlist (lowercased), from ADMIN_EMAILS. */
export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? ""
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return list.length ? list : DEFAULT_ADMIN_EMAILS
}

/** The configured admin PIN, from ADMIN_PIN. Server-only — never sent to client. */
function adminPin(): string {
  return (process.env.ADMIN_PIN ?? "").trim() || DEFAULT_ADMIN_PIN
}

/** True when `email` belongs to an authorized administrator account. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return adminEmails().includes(email.trim().toLowerCase())
}

/**
 * Length-safe constant-time-ish comparison of the supplied PIN against the
 * configured secret. Avoids early-exit timing leaks on the digits.
 */
export function verifyAdminPin(pin: string | null | undefined): boolean {
  if (typeof pin !== "string" || pin.length === 0) return false
  const expected = adminPin()
  if (pin.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= pin.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/**
 * The id of the REAL actor behind this request — the human whose credentials
 * authorized it. During impersonation this is the ADMIN (from the signed
 * impersonation cookie), NOT the target client, so authorization can never be
 * escalated by "acting as" another account. Returns null for anonymous or
 * unresolvable sessions.
 */
export async function resolveActingUserId(): Promise<string | null> {
  const cookieStore = await cookies()

  const imp = await verifyImpersonation(cookieStore.get(IMPERSONATION_COOKIE)?.value)
  if (imp && Date.now() < imp.exp) return imp.adminId

  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const dyn = await getDynamicUserBySessionToken(token)
    if (dyn && dyn.status === "active") return dyn.id
  } catch {
    // DB unreachable — cannot authorize.
  }
  return null
}

/**
 * True when the real actor behind this request is an authorized administrator.
 * Impersonation-aware: an admin "acting as" a client is still an admin; a
 * client is never an admin regardless of any client-side flag.
 */
export async function isCurrentSessionAdmin(): Promise<boolean> {
  const actingId = await resolveActingUserId()
  if (!actingId) return false
  try {
    const rec = await getDynamicUserById(actingId)
    return isAdminEmail(rec?.email)
  } catch {
    return false
  }
}

/**
 * The single authorization gate for admin server actions and API routes. An
 * action is authorized only when BOTH hold:
 *   - the real actor is an admin account, AND
 *   - the supplied PIN matches the server secret.
 *
 * The PIN is still required (defence-in-depth) so a stolen admin session alone
 * cannot mutate state without also presenting the secret.
 */
export async function adminActionAuthorized(pin: string | null | undefined): Promise<boolean> {
  if (!verifyAdminPin(pin)) return false
  return isCurrentSessionAdmin()
}
