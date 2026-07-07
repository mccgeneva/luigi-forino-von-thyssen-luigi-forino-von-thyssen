// ---------------------------------------------------------------------------
// Shared IP geolocation helper (server-only).
//
// Extracted so both the document-traceability tool and the security-audit tool
// resolve an approximate physical location the same way. Best-effort: every
// failure path returns a result carrying just the IP (plus a note), never
// throws, and never blocks the caller for long.
// ---------------------------------------------------------------------------

import "server-only"

export interface IpGeo {
  ip: string
  /** True for loopback / LAN addresses that cannot be geolocated. */
  isPrivate?: boolean
  country?: string
  countryCode?: string
  region?: string
  city?: string
  postal?: string
  latitude?: number
  longitude?: number
  timezone?: string
  isp?: string
  org?: string
  /** Set when the geo service could not resolve the address. */
  error?: string
}

/** Loopback / private-range / non-routable addresses have no public location. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase()
  if (!v || v === "localhost" || v === "::1" || v === "::") return true
  if (v.startsWith("127.") || v.startsWith("10.") || v.startsWith("192.168.")) return true
  if (v.startsWith("169.254.") || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true
  // 172.16.0.0 – 172.31.255.255
  const m = v.match(/^172\.(\d+)\./)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

/**
 * Resolve an approximate physical location for an IP using a free, key-less
 * HTTPS geolocation service (ipwho.is). Best-effort: any failure returns a
 * result carrying just the IP plus an error note, never throws. Done at lookup
 * time so historical rows (recorded before geo existed) are located too.
 */
export async function geolocateIp(ip: string | null): Promise<IpGeo | null> {
  if (!ip) return null
  const clean = ip.split(",")[0]?.trim() || ip.trim()
  if (!clean) return null
  if (isPrivateIp(clean)) return { ip: clean, isPrivate: true }
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, {
      cache: "no-store",
      // Don't let a slow third-party service hang the admin lookup.
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return { ip: clean, error: "Geolocation service unavailable." }
    const data = (await res.json()) as Record<string, unknown>
    if (!data || data.success === false) {
      return { ip: clean, error: (data?.message as string) || "No location on record for this address." }
    }
    const connection = (data.connection as Record<string, unknown> | undefined) ?? {}
    return {
      ip: clean,
      country: data.country as string | undefined,
      countryCode: data.country_code as string | undefined,
      region: data.region as string | undefined,
      city: data.city as string | undefined,
      postal: data.postal as string | undefined,
      latitude: typeof data.latitude === "number" ? data.latitude : undefined,
      longitude: typeof data.longitude === "number" ? data.longitude : undefined,
      timezone: (data.timezone as Record<string, unknown> | undefined)?.id as string | undefined,
      isp: connection.isp as string | undefined,
      org: connection.org as string | undefined,
    }
  } catch {
    return { ip: clean, error: "Geolocation lookup failed." }
  }
}
