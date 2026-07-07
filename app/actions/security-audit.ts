"use server"

// ---------------------------------------------------------------------------
// Admin Security Audit — passcode-gated read actions.
//
// NOTE: the admin panel loads this data through Route Handlers
// (app/api/admin/audit/*), NOT these Server Actions, because Server Action
// Origin/Host validation silently rejects calls on this app's production
// domains (apex -> www redirect, custom domains, in-app webviews). These thin
// wrappers remain for any server-side/back-compat callers and delegate to the
// shared service so there is a single source of truth.
// ---------------------------------------------------------------------------

import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  buildAuditOverview,
  buildUserAudit,
  type AuditOverview,
  type UserAuditReport,
} from "@/lib/security-audit-service"

export type { AuditActorView, AuditOverview, UserAuditReport } from "@/lib/security-audit-service"

function ok(passcode: string): boolean {
  return passcode === ADMIN_PASSCODE
}

/** Overview for the picker: active actors + the full account directory. */
export async function getAuditOverview(
  passcode: string,
): Promise<{ ok: boolean; data?: AuditOverview; error?: string }> {
  if (!ok(passcode)) return { ok: false, error: "Invalid admin passcode." }
  try {
    return { ok: true, data: await buildAuditOverview() }
  } catch (err) {
    console.log("[v0] getAuditOverview failed:", (err as Error).message)
    return { ok: false, error: "Could not load the audit overview." }
  }
}

/** Full audit report for one account. */
export async function getUserAudit(
  passcode: string,
  userId: string,
  opts?: { category?: string },
): Promise<{ ok: boolean; data?: UserAuditReport; error?: string }> {
  if (!ok(passcode)) return { ok: false, error: "Invalid admin passcode." }
  if (!userId) return { ok: false, error: "No account selected." }
  try {
    return { ok: true, data: await buildUserAudit(userId, opts) }
  } catch (err) {
    console.log("[v0] getUserAudit failed:", (err as Error).message)
    return { ok: false, error: "Could not load the audit report for this account." }
  }
}
