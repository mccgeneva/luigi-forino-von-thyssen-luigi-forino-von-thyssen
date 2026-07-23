// ---------------------------------------------------------------------------
// Live vessel-data providers.
//
// The app can link to any one of several AIS / vessel-data companies by simply
// adding that provider's API token as an environment variable. We auto-select
// the first configured provider (in VESSEL_PROVIDERS priority order) and
// normalize its response into our internal `Vessel` shape.
//
// Adding a new provider only requires:
//   1. an entry in VESSEL_PROVIDERS (lib/spot-deals-shared.ts), and
//   2. a matching adapter in PROVIDER_ADAPTERS below.
// ---------------------------------------------------------------------------

import "server-only"
import {
  VESSEL_PROVIDERS,
  isValidImo,
  type Vessel,
  type VesselCompliance,
  type VesselComplianceStatus,
  type VesselLivePosition,
  type VesselProviderId,
  type VesselProviderInfo,
} from "@/lib/spot-deals-shared"
import { screenImoAgainstOfac } from "@/lib/ofac-screening"

export interface ResolvedProvider extends VesselProviderInfo {
  token: string
}

/** Returns the first provider that has a token configured, or null. */
export function resolveProvider(): ResolvedProvider | null {
  for (const p of VESSEL_PROVIDERS) {
    const token = process.env[p.envVar]
    if (token && token.trim()) {
      return { ...p, token: token.trim() }
    }
  }
  return null
}

/** Public, token-free view of which providers are linked. */
export function providerStatus(): {
  connected: boolean
  active: { id: VesselProviderId; label: string } | null
  providers: Array<{ id: VesselProviderId; label: string; envVar: string; signupUrl: string; configured: boolean }>
  /** The free OFAC sanctions + IMO-validity screening is always available. */
  complianceEnabled: boolean
} {
  const providers = VESSEL_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    signupUrl: p.signupUrl,
    configured: Boolean(process.env[p.envVar] && process.env[p.envVar]!.trim()),
  }))
  const active = providers.find((p) => p.configured) ?? null
  return {
    connected: Boolean(active),
    active: active ? { id: active.id, label: active.label } : null,
    providers,
    complianceEnabled: true,
  }
}

/**
 * Free, token-free compliance auto-check for a vessel IMO. Runs the official
 * IMO check-digit validation (offline) and screens the number against the
 * public OFAC sanctions lists. Never throws — degrades to "unverified" if the
 * sanctions source is briefly unavailable.
 */
export async function screenVesselImo(imo: string): Promise<VesselCompliance> {
  const clean = (imo ?? "").trim()
  const imoValid = isValidImo(clean)
  const sources = ["IMO check digit"]
  let status: VesselComplianceStatus
  let note: string | undefined
  let matches: VesselCompliance["matches"] = []

  const ofac = await screenImoAgainstOfac(clean)
  if (ofac.available) {
    sources.push(...ofac.sources)
    matches = ofac.matches
    if (matches.length > 0) {
      status = "flagged"
      const programs = [...new Set(matches.flatMap((m) => m.programs))].join("; ")
      note = `Sanctions match: ${matches[0].name}${programs ? ` (${programs})` : ""}. Do not transact.`
    } else {
      status = "clear"
      note = "No match on OFAC sanctions lists."
    }
  } else {
    status = "unverified"
    note = "OFAC sanctions list temporarily unavailable; re-screen recommended."
  }

  return { status, imoValid, sources, matches, checkedAt: new Date().toISOString(), note }
}

/** Minimal catalogue entry created from a token-free, compliance-only import. */
function complianceStub(imo: string, compliance: VesselCompliance): Vessel {
  return {
    imo,
    name: `IMO ${imo}`,
    type: "crude",
    capacity: 0,
    capacityUnit: "DWT",
    status: "idle",
    location: "Unknown",
    source: "compliance",
    compliance,
    updatedAt: new Date().toISOString(),
  }
}

const PUBLIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/**
 * Free, token-free enrichment from public vessel pages. Reads the public
 * VesselFinder details page and parses its meta description — which exposes the
 * vessel name, type, build year and flag for any valid IMO with no API key.
 * Returns a partial Vessel, or null when the vessel can't be resolved.
 *
 * Note: deadweight/capacity is not published on the public page, so it stays 0
 * for the admin to complete. Never throws.
 */
async function publicLookup(imo: string): Promise<Partial<Vessel> | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(`https://www.vesselfinder.com/vessels/details/${imo}`, {
      headers: { "User-Agent": PUBLIC_UA, Accept: "text/html" },
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const html = await res.text()
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || ""

    // "Vessel NAME (IMO x, MMSI y) is a TYPE built in YEAR and currently sailing under the flag of FLAG."
    const m = desc.match(
      /^Vessel\s+(.+?)\s+\(IMO\s+\d+(?:,\s*MMSI\s+\d+)?\)\s+is a\s+(.+?)(?:\s+built in\s+(\d{4}))?(?:\s+and currently sailing under the flag of\s+([^.]+))?\.?$/i,
    )
    if (!m) return null
    const name = m[1].trim()
    const typeRaw = m[2].trim()
    const builtYear = m[3] ? num(m[3]) : undefined
    const flag = (m[4] || "").trim() || undefined
    const type = classifyType(typeRaw)
    if (!name || /^imo\s/i.test(name)) return null
    return {
      name,
      type,
      vesselClass: typeRaw || undefined,
      capacityUnit: type === "gas" ? "CBM" : "DWT",
      flag,
      builtYear,
    }
  } catch (err) {
    console.log("[v0] publicLookup failed:", (err as Error).message)
    return null
  }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function classifyType(raw: string): Vessel["type"] {
  const t = raw.toLowerCase()
  if (t.includes("gas") || t.includes("lng") || t.includes("lpg")) return "gas"
  if (t.includes("crude")) return "crude"
  return "product"
}

/**
 * Normalize an AIS navigational status (string label or numeric AIS code) into
 * our internal VesselStatus. Falls back to "idle" for unknown / not-reported.
 */
function mapNavStatus(raw: unknown): Vessel["status"] {
  const s = String(raw ?? "").toLowerCase().trim()
  if (!s) return "idle"
  // Numeric AIS navigational-status codes (ITU-R M.1371).
  if (/^\d+$/.test(s)) {
    const code = Number(s)
    if (code === 1) return "anchored"
    if (code === 5) return "moored"
    if (code === 0 || code === 8) return "underway"
    return "idle"
  }
  if (s.includes("anchor")) return "anchored"
  if (s.includes("moor")) return "moored"
  if (s.includes("load")) return "loading"
  if (s.includes("discharg")) return "discharging"
  if (s.includes("under way") || s.includes("underway") || s.includes("sailing") || s.includes("en route"))
    return "underway"
  return "idle"
}

/** Extract a [lat, lng] pair from the many shapes providers use for position. */
function extractLatLng(row: Record<string, unknown>): { lat?: number; lng?: number } {
  const pos = (row.last_known_position ?? row.lastPositionUpdate ?? row.position) as
    | Record<string, unknown>
    | undefined
  const latRaw = row.latitude ?? row.lat ?? pos?.latitude ?? pos?.lat
  const lngRaw = row.longitude ?? row.lon ?? row.lng ?? pos?.longitude ?? pos?.lon ?? pos?.lng
  // GeoJSON geometry: { coordinates: [lng, lat] }
  const coords = (pos?.coordinates ?? (row.geometry as Record<string, unknown>)?.coordinates) as
    | unknown[]
    | undefined
  const lat = latRaw != null ? num(latRaw) : Array.isArray(coords) ? num(coords[1]) : undefined
  const lng = lngRaw != null ? num(lngRaw) : Array.isArray(coords) ? num(coords[0]) : undefined
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : undefined,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : undefined,
  }
}

type Adapter = (imo: string, token: string) => Promise<Vessel | { error: string }>

// --- Kpler -----------------------------------------------------------------
// Kpler is the premium maritime-intelligence source: full vessel master data,
// live AIS position/voyage, and commodity cargo/trade-flow context — all keyed
// by IMO. REST base is https://rest.sml.kpler.com with Bearer-token auth.
// Field names vary across Kpler's tiers, so every read is defensive.
const kpler: Adapter = async (imo, token) => {
  const res = await fetch(`https://rest.sml.kpler.com/vessels?imo=${encodeURIComponent(imo)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { error: "Kpler rejected the API key (unauthorized)." }
    return { error: `Kpler responded with ${res.status}.` }
  }
  const json = (await res.json()) as unknown
  // Accept array, {data:[]}, {vessels:[]}, {nodes:[]} or a bare object.
  const list = Array.isArray(json)
    ? json
    : ((json as Record<string, unknown>)?.data ??
        (json as Record<string, unknown>)?.vessels ??
        (json as Record<string, unknown>)?.nodes ??
        (json ? [json] : [])) as unknown[]
  const row = (Array.isArray(list) ? list[0] : undefined) as Record<string, unknown> | undefined
  if (!row) return { error: "No vessel found for that IMO at Kpler." }

  // Some tiers nest master fields under staticData and position under lastPositionUpdate.
  const staticData = (row.staticData ?? row.static_data ?? {}) as Record<string, unknown>
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (row[k] != null) return row[k]
      if (staticData[k] != null) return staticData[k]
    }
    return undefined
  }

  const typeRaw = String(
    get("vessel_type", "vesselType", "type", "vessel_type_cargo", "ship_and_cargo_type") ?? "",
  )
  const type = classifyType(typeRaw)
  const { lat, lng } = extractLatLng(row)
  const cargoRaw = get("vessel_type_cargo", "ship_and_cargo_type", "cargo", "commodity", "last_cargo")

  return {
    imo,
    name: String(get("name", "vessel_name", "shipname") ?? `IMO ${imo}`),
    type,
    vesselClass: typeRaw || undefined,
    capacity: num(get("vessel_dwt_tons", "dead_weight_tonnage", "deadweight", "dwt", "capacity")),
    capacityUnit: type === "gas" ? "CBM" : "DWT",
    status: mapNavStatus(get("navigation_status", "nav_status", "status", "ais_status")),
    location: String(get("destination", "current_port", "port", "last_port") ?? "Unknown"),
    lat,
    lng,
    flag: (() => {
      const f = get("flag_country", "flag_name", "flag")
      return f ? String(f) : undefined
    })(),
    builtYear: (() => {
      const y = get("build_year", "year_built", "built")
      return y ? num(y) : undefined
    })(),
    cargo: cargoRaw ? String(cargoRaw) : undefined,
    source: "kpler",
    updatedAt: new Date().toISOString(),
  }
}

// --- MarineTraffic ---------------------------------------------------------
const marineTraffic: Adapter = async (imo, token) => {
  const url = `https://services.marinetraffic.com/api/vesselmasterdata/${token}/imo:${imo}/protocol:jsono`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) return { error: `MarineTraffic responded with ${res.status}.` }
  const data = (await res.json()) as Array<Record<string, unknown>>
  const row = Array.isArray(data) ? data[0] : undefined
  if (!row) return { error: "No vessel found for that IMO at MarineTraffic." }
  const type = classifyType(String(row.SHIPTYPE ?? row.TYPE_NAME ?? ""))
  return {
    imo,
    name: String(row.NAME ?? row.SHIPNAME ?? `IMO ${imo}`),
    type,
    vesselClass: row.TYPE_NAME ? String(row.TYPE_NAME) : undefined,
    capacity: num(row.SUMMER_DWT ?? row.DWT),
    capacityUnit: type === "gas" ? "CBM" : "DWT",
    status: "idle",
    location: String(row.PORT ?? row.CURRENT_PORT ?? "Unknown"),
    flag: row.FLAG ? String(row.FLAG) : undefined,
    builtYear: row.YEAR_BUILT ? num(row.YEAR_BUILT) : undefined,
    cargo: undefined,
    source: "marinetraffic",
    updatedAt: new Date().toISOString(),
  }
}

// --- Datalastic ------------------------------------------------------------
const datalastic: Adapter = async (imo, token) => {
  const url = `https://api.datalastic.com/api/v0/vessel?api-key=${token}&imo=${imo}`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) return { error: `Datalastic responded with ${res.status}.` }
  const json = (await res.json()) as { data?: Record<string, unknown> }
  const row = json?.data
  if (!row) return { error: "No vessel found for that IMO at Datalastic." }
  const type = classifyType(String(row.type ?? row.type_specific ?? ""))
  return {
    imo,
    name: String(row.name ?? `IMO ${imo}`),
    type,
    vesselClass: row.type_specific ? String(row.type_specific) : row.type ? String(row.type) : undefined,
    capacity: num(row.deadweight ?? row.dwt ?? row.gross_tonnage),
    capacityUnit: type === "gas" ? "CBM" : "DWT",
    status: "idle",
    location: String(row.current_port ?? row.destination ?? "Unknown"),
    flag: row.country_iso ? String(row.country_iso) : row.flag ? String(row.flag) : undefined,
    builtYear: row.year_built ? num(row.year_built) : undefined,
    cargo: undefined,
    source: "datalastic",
    updatedAt: new Date().toISOString(),
  }
}

// --- VesselFinder ----------------------------------------------------------
const vesselFinder: Adapter = async (imo, token) => {
  const url = `https://api.vesselfinder.com/masterdata?userkey=${token}&imo=${imo}&format=json`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) return { error: `VesselFinder responded with ${res.status}.` }
  const data = (await res.json()) as unknown
  const row = (Array.isArray(data) ? (data[0] as Record<string, unknown>)?.AIS ?? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return { error: "No vessel found for that IMO at VesselFinder." }
  const type = classifyType(String(row.TYPE ?? row.SHIPTYPE ?? ""))
  return {
    imo,
    name: String(row.NAME ?? row.SHIPNAME ?? `IMO ${imo}`),
    type,
    vesselClass: row.TYPE ? String(row.TYPE) : undefined,
    capacity: num(row.DWT ?? row.GT),
    capacityUnit: type === "gas" ? "CBM" : "DWT",
    status: "idle",
    location: String(row.DESTINATION ?? row.CURRENT_PORT ?? "Unknown"),
    flag: row.FLAG ? String(row.FLAG) : undefined,
    builtYear: row.BUILT ? num(row.BUILT) : undefined,
    cargo: undefined,
    source: "vesselfinder",
    updatedAt: new Date().toISOString(),
  }
}

// --- Datadocked -----------------------------------------------------------
// Datadocked exposes a single real-time endpoint keyed by IMO or MMSI that
// returns both light master data (name, specific type, destination) and the
// live AIS fix (lat/lng, speed, course, nav status). Auth is an `x-api-key`
// header. Deadweight/flag/build-year aren't published here, so those stay for
// the admin to complete on import.
const DATADOCKED_BASE = "https://datadocked.com/api/vessels_operations/get-vessel-location"

async function datadockedFetch(imo: string, token: string): Promise<Record<string, unknown> | { error: string }> {
  const res = await fetch(`${DATADOCKED_BASE}?imo_or_mmsi=${encodeURIComponent(imo)}`, {
    headers: { accept: "application/json", "x-api-key": token },
    cache: "no-store",
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { error: "Datadocked rejected the API key (unauthorized)." }
    if (res.status === 404) return { error: "No vessel found for that IMO/MMSI at Datadocked." }
    return { error: `Datadocked responded with ${res.status}.` }
  }
  const json = (await res.json()) as Record<string, unknown> | null
  if (!json || (!json.latitude && !json.name)) {
    return { error: "No live data reported for that IMO/MMSI at Datadocked." }
  }
  return json
}

/**
 * Datadocked reports time as "Jul 23, 2026 04:07 UTC". V8's Date parser is
 * unreliable with a bare "UTC" suffix, so normalise it to "GMT" first; fall
 * back to now() when the string can't be parsed.
 */
function parseDatadockedTime(v: unknown): string {
  const raw = String(v ?? "").trim()
  if (raw) {
    const d = new Date(raw.replace(/\bUTC\b/i, "GMT"))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

const datadocked: Adapter = async (imo, token) => {
  const row = await datadockedFetch(imo, token)
  if ("error" in row) return row
  const typeRaw = String(row.typeSpecific ?? "")
  const type = classifyType(typeRaw)
  const { lat, lng } = extractLatLng(row)
  return {
    imo,
    name: String(row.name ?? `IMO ${imo}`),
    type,
    vesselClass: typeRaw || undefined,
    capacity: 0,
    capacityUnit: type === "gas" ? "CBM" : "DWT",
    status: mapNavStatus(row.navigationalStatus),
    location: String(row.destination ?? row.lastPort ?? "Unknown"),
    lat,
    lng,
    flag: undefined,
    builtYear: undefined,
    cargo: undefined,
    source: "datadocked",
    updatedAt: new Date().toISOString(),
  }
}

const PROVIDER_ADAPTERS: Record<VesselProviderId, Adapter> = {
  datadocked,
  kpler,
  marinetraffic: marineTraffic,
  datalastic,
  vesselfinder: vesselFinder,
}

/**
 * Fetch a vessel by IMO. The free OFAC + IMO-validity compliance screen always
 * runs and is stamped onto the returned vessel. If a paid provider is linked,
 * we also fetch real master data; otherwise we return a compliance-screened
 * stub so the import still works automatically with no token.
 */
export async function fetchVesselByImo(
  imo: string,
): Promise<{ vessel: Vessel; providerLabel: string; compliance: VesselCompliance } | { error: string; compliance: VesselCompliance }> {
  const compliance = await screenVesselImo(imo)
  const provider = resolveProvider()

  if (!provider) {
    // Token-free path: enrich from free public vessel pages (name, type, flag,
    // build year), falling back to a bare compliance-only stub. Either way the
    // record is stamped with the compliance verdict.
    const enriched = await publicLookup(imo)
    if (enriched) {
      const base = complianceStub(imo, compliance)
      return {
        vessel: {
          ...base,
          ...enriched,
          source: "compliance",
          compliance,
          updatedAt: new Date().toISOString(),
        },
        providerLabel: "Public registry + OFAC screening",
        compliance,
      }
    }
    return {
      vessel: complianceStub(imo, compliance),
      providerLabel: "OFAC compliance screening",
      compliance,
    }
  }

  try {
    const result = await PROVIDER_ADAPTERS[provider.id](imo, provider.token)
    if ("error" in result) return { error: result.error, compliance }
    return { vessel: { ...result, compliance }, providerLabel: provider.label, compliance }
  } catch (err) {
    console.log(`[v0] vessel provider ${provider.id} failed:`, (err as Error).message)
    return { error: `Live import via ${provider.label} failed. Please add the vessel manually.`, compliance }
  }
}

// ---------------------------------------------------------------------------
// Live AIS positions.
//
// Master data (name, DWT, flag) rarely changes, but a vessel's POSITION does —
// constantly. These adapters hit each provider's real-time position endpoint
// and normalise the many field spellings into our `VesselLivePosition` shape.
// They are ONLY reachable when a provider token is configured; there is no
// fabricated/last-known fallback, so callers can trust that any value returned
// here is a genuine live AIS fix.
// ---------------------------------------------------------------------------

type PositionAdapter = (imo: string, token: string) => Promise<VesselLivePosition | { error: string }>

function isoFromEpoch(v: unknown): string {
  // AIS providers report time as ISO strings or unix seconds/millis.
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

// --- MarineTraffic position (PS07 exportvessel) ----------------------------
// GET .../api/exportvessel/{key}/imo:{imo}/protocol:jsono → array of rows with
// LAT, LON, SPEED (knots ×10 on some plans), COURSE, STATUS, TIMESTAMP.
const marineTrafficPosition: PositionAdapter = async (imo, token) => {
  const url = `https://services.marinetraffic.com/api/exportvessel/${token}/imo:${imo}/protocol:jsono/timespan:60`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { error: "MarineTraffic rejected the API key (unauthorized)." }
    return { error: `MarineTraffic positions responded with ${res.status}.` }
  }
  const data = (await res.json()) as Array<Record<string, unknown>>
  const row = Array.isArray(data) ? data[0] : undefined
  if (!row) return { error: "No live AIS position reported for that IMO in the last hour." }
  const { lat, lng } = extractLatLng(row)
  if (lat == null || lng == null) return { error: "MarineTraffic returned no coordinates for that vessel." }
  // Speed is commonly transmitted in tenths of a knot.
  const rawSpeed = num(row.SPEED ?? row.speed)
  const speedKnots = rawSpeed > 102 ? rawSpeed / 10 : rawSpeed
  return {
    imo,
    lat,
    lng,
    status: mapNavStatus(row.STATUS ?? row.status),
    speedKnots: Number.isFinite(speedKnots) && speedKnots > 0 ? Math.round(speedKnots * 10) / 10 : undefined,
    courseDeg: (() => {
      const c = num(row.COURSE ?? row.course)
      return Number.isFinite(c) && c > 0 ? c : undefined
    })(),
    destination: row.DESTINATION ? String(row.DESTINATION) : undefined,
    timestamp: isoFromEpoch(row.TIMESTAMP ?? row.timestamp ?? row.LAST_POS),
  }
}

// --- Generic position (Kpler / Datalastic / VesselFinder) ------------------
// These providers embed position in their main vessel record; reuse the same
// robust coordinate extractor used for master data.
function genericPositionFromRow(imo: string, row: Record<string, unknown>): VesselLivePosition | { error: string } {
  const { lat, lng } = extractLatLng(row)
  if (lat == null || lng == null) return { error: "Provider returned no live coordinates for that vessel." }
  const rawSpeed = num(row.speed ?? row.SPEED ?? row.sog)
  return {
    imo,
    lat,
    lng,
    status: mapNavStatus(row.navigation_status ?? row.nav_status ?? row.status ?? row.STATUS),
    speedKnots: Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.round(rawSpeed * 10) / 10 : undefined,
    courseDeg: (() => {
      const c = num(row.course ?? row.COURSE ?? row.cog)
      return Number.isFinite(c) && c > 0 ? c : undefined
    })(),
    destination: (row.destination ?? row.DESTINATION ?? row.current_port) ? String(row.destination ?? row.DESTINATION ?? row.current_port) : undefined,
    timestamp: isoFromEpoch(row.last_position_epoch ?? row.timestamp ?? row.last_position_UTC ?? row.TIMESTAMP),
  }
}

const kplerPosition: PositionAdapter = async (imo, token) => {
  const res = await fetch(`https://rest.sml.kpler.com/vessels?imo=${encodeURIComponent(imo)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) return { error: `Kpler positions responded with ${res.status}.` }
  const json = (await res.json()) as unknown
  const list = Array.isArray(json)
    ? json
    : (((json as Record<string, unknown>)?.data ?? (json as Record<string, unknown>)?.vessels ?? (json ? [json] : [])) as unknown[])
  const row = (Array.isArray(list) ? list[0] : undefined) as Record<string, unknown> | undefined
  if (!row) return { error: "No vessel found for that IMO at Kpler." }
  return genericPositionFromRow(imo, row)
}

const datalasticPosition: PositionAdapter = async (imo, token) => {
  const res = await fetch(`https://api.datalastic.com/api/v0/vessel_pro?api-key=${token}&imo=${imo}`, {
    cache: "no-store",
  })
  if (!res.ok) return { error: `Datalastic positions responded with ${res.status}.` }
  const json = (await res.json()) as { data?: Record<string, unknown> }
  if (!json?.data) return { error: "No vessel found for that IMO at Datalastic." }
  return genericPositionFromRow(imo, json.data)
}

const vesselFinderPosition: PositionAdapter = async (imo, token) => {
  const res = await fetch(`https://api.vesselfinder.com/vesselslist?userkey=${token}&imo=${imo}&format=json`, {
    cache: "no-store",
  })
  if (!res.ok) return { error: `VesselFinder positions responded with ${res.status}.` }
  const data = (await res.json()) as unknown
  const row = (Array.isArray(data) ? (data[0] as Record<string, unknown>)?.AIS ?? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return { error: "No vessel found for that IMO at VesselFinder." }
  return genericPositionFromRow(imo, row)
}

// --- Datadocked position ---------------------------------------------------
// Same real-time endpoint as the master-data adapter; speed is already in whole
// knots (e.g. "0.1"), so no tenths-of-a-knot conversion is applied here.
const datadockedPosition: PositionAdapter = async (imo, token) => {
  const row = await datadockedFetch(imo, token)
  if ("error" in row) return row
  const { lat, lng } = extractLatLng(row)
  if (lat == null || lng == null) return { error: "Datadocked returned no coordinates for that vessel." }
  const rawSpeed = num(row.speed)
  return {
    imo,
    lat,
    lng,
    status: mapNavStatus(row.navigationalStatus),
    speedKnots: Number.isFinite(rawSpeed) && rawSpeed >= 0 ? Math.round(rawSpeed * 10) / 10 : undefined,
    courseDeg: (() => {
      const c = num(row.course)
      return Number.isFinite(c) && c > 0 ? c : undefined
    })(),
    destination: row.destination ? String(row.destination) : undefined,
    timestamp: parseDatadockedTime(row.positionReceived ?? row.updateTime),
  }
}

const POSITION_ADAPTERS: Record<VesselProviderId, PositionAdapter> = {
  datadocked: datadockedPosition,
  kpler: kplerPosition,
  marinetraffic: marineTrafficPosition,
  datalastic: datalasticPosition,
  vesselfinder: vesselFinderPosition,
}

/**
 * Fetch a vessel's REAL-TIME AIS position from the connected provider. Returns
 * `{ connected: false }` when no provider token is configured (so the UI can
 * show an honest "live position unavailable" state instead of stale data), or
 * the live fix / a provider error otherwise. Never throws.
 */
export async function fetchVesselPosition(
  imo: string,
): Promise<
  | { connected: true; providerLabel: string; position: VesselLivePosition }
  | { connected: true; providerLabel: string; error: string }
  | { connected: false }
> {
  const provider = resolveProvider()
  if (!provider) return { connected: false }
  try {
    const result = await POSITION_ADAPTERS[provider.id](imo, provider.token)
    if ("error" in result) return { connected: true, providerLabel: provider.label, error: result.error }
    return { connected: true, providerLabel: provider.label, position: result }
  } catch (err) {
    console.log(`[v0] vessel position ${provider.id} failed:`, (err as Error).message)
    return { connected: true, providerLabel: provider.label, error: `Live position via ${provider.label} failed.` }
  }
}
