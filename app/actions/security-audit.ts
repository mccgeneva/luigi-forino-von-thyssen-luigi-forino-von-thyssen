"use server"

// ---------------------------------------------------------------------------
// Admin Security Audit — passcode-gated read actions.
//
// These power the admin "Security Audit" panel: pick any client and see their
// identity, login selfie, devices, geolocated IPs, and full activity timeline.
// Every action re-checks the admin passcode server-side; the client passcode
// gate is only a convenience, never the security boundary.
// ---------------------------------------------------------------------------

import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { geolocateIp, type IpGeo } from "@/lib/ip-geo"
import { getIdentityStatus, getLastLoginSelfie, type IdentityStatus } from "@/lib/biometric-db"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  listAuditActors,
  listAuditEvents,
  listUserDevices,
  getActorStats,
  type AuditActor,
  type AuditEvent,
  type DeviceRow,
  type ActorStats,
} from "@/lib/security-audit-db"

function ok(passcode: string): boolean {
  return passcode === ADMIN_PASSCODE
}

/** Turn a stored selfie pathname into an app-relative, session-gated proxy URL. */
function selfieUrl(pathname: string | null): string | null {
  if (!pathname) return null
  return `/api/login-selfie?pathname=${encodeURIComponent(pathname)}`
}

export interface AuditActorView extends Omit<AuditActor, "lastSelfieUrl"> {
  lastSelfieUrl: string | null
}

export interface AuditOverview {
  /** Accounts that already have recorded activity, most-recent first. */
  actors: AuditActorView[]
  /** Every known account (for search / picking clients with no events yet). */
  accounts: { userId: string; label: string; company: string; email: string }[]
  /** True the moment the store is still empty (nothing has happened yet). */
  empty: boolean
}

/** Overview for the picker: active actors + the full account directory. */
export async function getAuditOverview(passcode: string): Promise<{ ok: boolean; data?: AuditOverview; error?: string }> {
  if (!ok(passcode)) return { ok: false, error: "Invalid admin passcode." }
  try {
    const [actors, users] = await Promise.all([listAuditActors(), listDynamicUsers()])
    const accounts = users.map((u) => ({
      userId: u.id,
      label: u.profile.fullName || u.profile.company || u.email,
      company: u.profile.company || "",
      email: u.email,
    }))
    return {
      ok: true,
      data: {
        actors: actors.map((a) => ({ ...a, lastSelfieUrl: selfieUrl(a.lastSelfieUrl) })),
        accounts,
        empty: actors.length === 0,
      },
    }
  } catch (err) {
    console.log("[v0] getAuditOverview failed:", (err as Error).message)
    return { ok: false, error: "Could not load the audit overview." }
  }
}

export interface UserAuditReport {
  userId: string
  account: string
  stats: ActorStats
  identity: IdentityStatus
  selfie: { url: string | null; at: string | null }
  devices: DeviceRow[]
  /** Geolocated distinct IPs (best-effort, capped). */
  locations: IpGeo[]
  events: AuditEvent[]
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
    const [stats, identity, selfie, devices, events] = await Promise.all([
      getActorStats(userId),
      getIdentityStatus(userId),
      getLastLoginSelfie(userId),
      listUserDevices(userId),
      listAuditEvents({ userId, category: opts?.category, limit: 300 }),
    ])

    // Geolocate the most-recent distinct public IPs (cap the fan-out so a slow
    // geo service can't stall the report).
    const seen = new Set<string>()
    const ips: string[] = []
    for (const d of devices) {
      const ip = d.ipAddress?.split(",")[0]?.trim()
      if (ip && !seen.has(ip)) {
        seen.add(ip)
        ips.push(ip)
      }
      if (ips.length >= 8) break
    }
    const located = await Promise.all(ips.map((ip) => geolocateIp(ip)))
    const locations = located.filter((l): l is IpGeo => !!l)

    // Resolve the account label from stored data when the event trail lacks it.
    const account =
      events.find((e) => e.account)?.account ||
      (identity.fullName ? `${identity.fullName}` : "") ||
      userId

    return {
      ok: true,
      data: {
        userId,
        account,
        stats,
        identity,
        selfie: { url: selfieUrl(selfie?.url ?? null), at: selfie?.at ?? null },
        devices,
        locations,
        events,
      },
    }
  } catch (err) {
    console.log("[v0] getUserAudit failed:", (err as Error).message)
    return { ok: false, error: "Could not load the audit report for this account." }
  }
}
