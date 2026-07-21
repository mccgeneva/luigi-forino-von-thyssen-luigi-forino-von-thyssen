import "server-only"

// ---------------------------------------------------------------------------
// Shared server-side OpenFIGI (Bloomberg) access.
//
// The OpenFIGI API key must never reach the browser, so every call runs on the
// server. This module is the single source of truth used by BOTH the public
// proxy route (`/api/openfigi`) and the marketplace publish flow, so an ISIN is
// verified against the REAL Bloomberg registry in exactly the same way whether
// a customer is looking it up or an administrator is publishing it.
//
// Bilateral bank instruments (SBLC / BG / most private MTNs) are NOT exchange
// listed, so a structurally-valid-but-unlisted ISIN returns an empty match —
// that is the honest, expected result and is surfaced as "not exchange-listed",
// never faked.
// ---------------------------------------------------------------------------

const OPENFIGI_BASE = "https://api.openfigi.com/v3"

export interface FigiRecord {
  figi: string
  name?: string
  ticker?: string
  exchCode?: string
  securityType?: string
  securityType2?: string
  marketSector?: string
  securityDescription?: string
}

export interface IsinMappingResult {
  listed: boolean
  matches: FigiRecord[]
  reason?: string
}

function apiKeyHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const key = process.env.OPENFIGI_API_KEY
  if (key) headers["X-OPENFIGI-APIKEY"] = key
  return headers
}

/** A lightly validated ISIN (2 letters + 9 alnum + 1 digit). */
export function looksLikeIsin(v: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(v.trim().toUpperCase())
}

/** Map (validate + enrich) a single ISIN against the live OpenFIGI registry. */
export async function mapIsinServer(isin: string): Promise<IsinMappingResult> {
  if (!looksLikeIsin(isin)) {
    return { listed: false, matches: [], reason: "Invalid ISIN format" }
  }
  const res = await fetch(`${OPENFIGI_BASE}/mapping`, {
    method: "POST",
    headers: apiKeyHeaders(),
    cache: "no-store",
    body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin.trim().toUpperCase() }]),
  })
  if (!res.ok) {
    return { listed: false, matches: [], reason: `OpenFIGI ${res.status}` }
  }
  const json = (await res.json()) as Array<{ data?: FigiRecord[]; error?: string }>
  const first = json?.[0]
  if (first?.error) {
    return { listed: false, matches: [], reason: first.error }
  }
  const matches = (first?.data ?? []).slice(0, 5)
  return { listed: matches.length > 0, matches }
}

/** Free-text Bloomberg-style security search (name / ticker). */
export async function searchFigiServer(query: string): Promise<{ matches: FigiRecord[]; reason?: string }> {
  const res = await fetch(`${OPENFIGI_BASE}/search`, {
    method: "POST",
    headers: apiKeyHeaders(),
    cache: "no-store",
    body: JSON.stringify({ query: query.trim() }),
  })
  if (!res.ok) {
    return { matches: [], reason: `OpenFIGI ${res.status}` }
  }
  const json = (await res.json()) as { data?: FigiRecord[]; error?: string }
  if (json?.error) return { matches: [], reason: json.error }
  return { matches: (json?.data ?? []).slice(0, 25) }
}
