"use server"

import { headers } from "next/headers"
import { deliverActivityEmailUnlessAdmin, type ActivityLog } from "@/lib/activity-email"
import { persistActivityEvent } from "@/lib/activity-persist"

async function resolveClientContext(): Promise<{ ipAddress: string; userAgent: string | null }> {
  try {
    const h = await headers()
    // x-forwarded-for can be a comma-separated list; the first entry is the client.
    const forwarded = h.get("x-forwarded-for")
    const first = forwarded?.split(",")[0]?.trim()
    const ipAddress = first || h.get("x-real-ip") || h.get("x-vercel-forwarded-for") || "Unknown"
    return { ipAddress, userAgent: h.get("user-agent") }
  } catch {
    return { ipAddress: "Unknown", userAgent: null }
  }
}

/**
 * Server-side activity logging (login, logout, session, treasury, etc.).
 *
 * Client components do NOT use this Server Action — they POST to
 * /api/log-activity (a Route Handler) which is immune to Server Action
 * Origin/CSRF checks and therefore works on every domain. This action remains
 * for server-to-server callers where origin is irrelevant.
 *
 * Email delivery is awaited directly (NOT via `after()`): in a serverless
 * environment `after()` background callbacks are not reliably executed across all
 * runtimes/regions, which made login/logout emails send on one domain but silently
 * drop on another. `deliverActivityEmail` has a hard 8s timeout and never throws,
 * so awaiting guarantees delivery without risking an indefinite hang.
 */
export async function logActivity(activity: ActivityLog) {
  try {
    const { ipAddress, userAgent } = await resolveClientContext()
    const [, result] = await Promise.all([
      persistActivityEvent(activity, { ipAddress, userAgent }),
      deliverActivityEmailUnlessAdmin(activity, ipAddress),
    ])
    return result
  } catch (err) {
    console.log("[v0] logActivity exception:", err)
    return { ok: false, error: "exception" }
  }
}
