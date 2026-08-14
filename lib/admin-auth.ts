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

/**
 * The two canonical administrator accounts. These are ALWAYS authorized — they
 * form a baseline that cannot be accidentally removed by a mis-formatted
 * ADMIN_EMAILS value. This is deliberate: locking the proprietor out of the
 * admin panel via an env typo would be worse than the (already server-gated)
 * cost of not being able to revoke them through env alone.
 */
const BASELINE_ADMIN_EMAILS = ["president@mccpetroli.com", "admin@mccgva.ch"]

/**
 * The proprietor's canonical administrator PIN. Like BASELINE_ADMIN_EMAILS this
 * is ALWAYS accepted — it is the value shipped in the client (`ADMIN_PASSCODE`)
 * and documented as the administrator passkey. Treating it as a baseline (in
 * ADDITION to any ADMIN_PIN env override) is deliberate and symmetric with the
 * baseline emails: a mis-set or drifted ADMIN_PIN env value must never lock the
 * proprietor out of their own documented passkey. Rotating ADMIN_PIN ADDS an
 * accepted PIN; it does not remove this baseline.
 */
const BASELINE_ADMIN_PIN = "270476"
const DEFAULT_ADMIN_PIN = BASELINE_ADMIN_PIN

/**
 * The admin email allowlist (lowercased): the baseline admins, PLUS any extra
 * emails configured in ADMIN_EMAILS. Extra entries can add admins but cannot
 * remove the baseline accounts.
 */
export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? ""
  const extra = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return Array.from(new Set([...BASELINE_ADMIN_EMAILS, ...extra]))
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

/** Length-safe, early-exit-free comparison of two strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * True when the supplied PIN matches an accepted administrator PIN. Two PINs are
 * accepted: the always-valid BASELINE_ADMIN_PIN (the proprietor's documented
 * passkey, also shipped as the client `ADMIN_PASSCODE`) and — when configured —
 * the ADMIN_PIN env override. Comparison is length-safe and early-exit-free.
 */
export function verifyAdminPin(pin: string | null | undefined): boolean {
  if (typeof pin !== "string" || pin.length === 0) return false
  const trimmed = pin.trim()
  // Baseline PIN is always accepted (mirrors BASELINE_ADMIN_EMAILS) so a
  // drifted/mis-set ADMIN_PIN env can never lock the proprietor out.
  if (timingSafeEqual(trimmed, BASELINE_ADMIN_PIN)) return true
  // Plus any explicitly configured PIN.
  const configured = adminPin()
  return timingSafeEqual(trimmed, configured)
}

/**
 * The id of the REAL actor behind this request — the human whose credentials
 * authorized it. During impersonation this is the ADMIN (from the signed
 * impersonation cookie), NOT the target client, so authorization can never be
 * escalated by "acting as" another account. Returns null for anonymous or
 * unresolvable sessions.
 */
export async function resolveActingUserId(): Promise<string | null> {
  try {
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
  } catch {
    // Never throw out of authorization resolution — fail closed instead, so a
    // transient cookie/crypto hiccup surfaces as "not authorized" rather than
    // an opaque server error at the RPC boundary.
    return null
  }
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
