// ---------------------------------------------------------------------------
// Activity persistence bridge (server-only).
//
// Both logging chokepoints — the /api/log-activity Route Handler (client posts)
// and the logActivity Server Action (server-to-server callers) — funnel through
// here so EVERY event is written to the security-audit trail in addition to
// being emailed. This is intentionally best-effort: it never throws, so a DB
// hiccup can never break login, logout, or any user operation.
// ---------------------------------------------------------------------------

import "server-only"
import { insertAuditEvent } from "@/lib/security-audit-db"
import { resolveCurrentSession } from "@/lib/session-user"
import type { ActivityLog } from "@/lib/activity-email"

function normalizeDetails(
  details: ActivityLog["details"],
  extra?: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  if (details) {
    for (const [k, v] of Object.entries(details)) {
      if (v !== undefined) out[k] = v
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * Persist a single activity event to the audit trail. Resolves the acting
 * account from the caller-supplied `userId` when present (e.g. the login flow,
 * which knows who just authenticated) and otherwise from the session cookie.
 */
export async function persistActivityEvent(
  activity: ActivityLog,
  ctx: { ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  try {
    let userId = activity.userId ?? null
    let account = activity.user ?? null
    let actingAdmin: string | undefined

    if (!userId) {
      // No explicit id — resolve WHO this is from the authoritative session.
      const session = await resolveCurrentSession().catch(() => null)
      if (session) {
        userId = session.id
        account =
          account ||
          session.profile.fullName ||
          session.profile.company ||
          session.profile.email ||
          session.id
        // Attribute admin "act as client" maintenance so the trail stays honest.
        if (session.impersonator) actingAdmin = `${session.impersonator.name} (${session.impersonator.id})`
      }
    }

    await insertAuditEvent({
      userId,
      account,
      action: activity.action,
      category: activity.category,
      path: activity.path ?? null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      selfieUrl: activity.selfieUrl ?? null,
      details: normalizeDetails(activity.details, actingAdmin ? { actingAdmin } : undefined),
    })
  } catch (err) {
    console.log("[v0] persistActivityEvent failed:", (err as Error).message)
  }
}
