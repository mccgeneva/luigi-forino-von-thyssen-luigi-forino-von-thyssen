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

// In-memory cache of resolved locations, shared across requests on the same
// server instance. The admin panels re-resolve the WHOLE IP list on every load,
// and the free geo services rate-limit a shared serverless egress IP quickly —
// caching successful (and private) resolutions is what actually keeps the panel
// populated. Errors are NOT cached so a transient failure retries next load.
const GEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h
const geoCache = new Map<string, { value: IpGeo; expires: number }>()

/** Provider 1: ipwho.is — keyless HTTPS. Returns null on any non-fatal failure. */
async function lookupIpWhoIs(clean: string): Promise<IpGeo | null> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    if (!data || data.success === false) return null
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
    return null
  }
}

/**
 * Provider 2 (fallback): ip-api.com — keyless. The free endpoint is HTTP-only,
 * which is fine server-side (no mixed-content). Used when ipwho.is is rate-
 * limited/unavailable so the panel still resolves.
 */
async function lookupIpApiCom(clean: string): Promise<IpGeo | null> {
  try {
    const fields = "status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,query"
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(clean)}?fields=${fields}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    if (!data || data.status !== "success") return null
    return {
      ip: clean,
      country: data.country as string | undefined,
      countryCode: data.countryCode as string | undefined,
      region: data.regionName as string | undefined,
      city: data.city as string | undefined,
      postal: data.zip as string | undefined,
      latitude: typeof data.lat === "number" ? data.lat : undefined,
      longitude: typeof data.lon === "number" ? data.lon : undefined,
      timezone: data.timezone as string | undefined,
      isp: data.isp as string | undefined,
      org: data.org as string | undefined,
    }
  } catch {
    return null
  }
}

/**
 * Resolve an approximate physical location for an IP using free, key-less
 * geolocation services with a fallback chain (ipwho.is → ip-api.com) and an
 * in-memory cache. Best-effort: any failure returns a result carrying just the
 * IP plus an error note, never throws. Done at lookup time so historical rows
 * (recorded before geo existed) are located too.
 */
export async function geolocateIp(ip: string | null): Promise<IpGeo | null> {
  if (!ip) return null
  const clean = ip.split(",")[0]?.trim() || ip.trim()
  if (!clean) return null
  if (isPrivateIp(clean)) return { ip: clean, isPrivate: true }

  const cached = geoCache.get(clean)
  if (cached && cached.expires > Date.now()) return cached.value

  // Try providers in order; the first that resolves wins.
  const resolved = (await lookupIpWhoIs(clean)) ?? (await lookupIpApiCom(clean))
  if (resolved) {
    geoCache.set(clean, { value: resolved, expires: Date.now() + GEO_CACHE_TTL_MS })
    return resolved
  }

  // Both providers failed (most likely rate-limited). Do not cache the error.
  return { ip: clean, error: "Geolocation service unavailable." }
}
