import "server-only"

// ---------------------------------------------------------------------------
// GLEIF (Global Legal Entity Identifier Foundation) — free public API.
//
// Maps a real ISIN to its issuing legal entity so the marketplace publish flow
// can AUTO-FILL genuine reference data (legal name, registered address, SWIFT/
// BIC, country) instead of anyone typing — or worse, inventing — it.
//
// This is authoritative, free, and needs no key: https://api.gleif.org/api/v1.
// If GLEIF has no mapping for an ISIN (common for bilateral bank instruments),
// we return null and the caller leaves the fields blank. Nothing is fabricated.
// ---------------------------------------------------------------------------

const GLEIF_BASE = "https://api.gleif.org/api/v1"

export interface GleifEntity {
  lei: string
  legalName: string | null
  /** Primary SWIFT/BIC for the entity's home country, when GLEIF maps one. */
  bic: string | null
  countryCode: string | null
  city: string | null
  /** Single-line registered/head-office address. */
  address: string | null
  postalCode: string | null
}

async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      headers: { Accept: "application/vnd.api+json" },
      cache: "no-store",
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

interface GleifAddress {
  addressLines?: string[]
  city?: string | null
  region?: string | null
  country?: string | null
  postalCode?: string | null
}

/**
 * From GLEIF's flat list of full 11-char BICs, choose the one that best
 * represents the entity's home country: prefer a BIC whose country segment
 * (chars 5-6) matches the legal-address country, favouring the primary "XXX"
 * head-office branch. Falls back to the first BIC if none match.
 */
function pickPrimaryBic(bics: string[], countryCode: string | null): string | null {
  if (!bics.length) return null
  const inCountry = countryCode
    ? bics.filter((b) => b.slice(4, 6).toUpperCase() === countryCode.toUpperCase())
    : []
  const pool = inCountry.length ? inCountry : bics
  const headOffice = pool.find((b) => b.toUpperCase().endsWith("XXX"))
  // Return the 8-char BIC (drop a trailing XXX branch, which is implicit).
  const chosen = headOffice ?? pool[0]
  return chosen.length === 11 && chosen.toUpperCase().endsWith("XXX") ? chosen.slice(0, 8) : chosen
}

function formatAddress(addr?: GleifAddress): string | null {
  if (!addr) return null
  const parts = [...(addr.addressLines ?? []), addr.city, addr.postalCode, addr.country].filter(
    (p): p is string => Boolean(p && p.trim()),
  )
  return parts.length ? parts.join(", ") : null
}

/**
 * Resolve the issuing legal entity for an ISIN via GLEIF. Returns null when
 * GLEIF has no mapping (so the caller keeps the fields empty).
 */
export async function resolveIsinEntity(isin: string): Promise<GleifEntity | null> {
  const clean = isin.trim().toUpperCase()
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(clean)) return null

  try {
    const res = await fetchWithTimeout(
      `${GLEIF_BASE}/lei-records?filter%5Bisin%5D=${encodeURIComponent(clean)}&page%5Bsize%5D=1`,
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: Array<{
        attributes?: {
          lei?: string
          bic?: string[] | null
          entity?: {
            legalName?: { name?: string }
            legalAddress?: GleifAddress
            headquartersAddress?: GleifAddress
          }
        }
      }>
    }
    const rec = json?.data?.[0]?.attributes
    if (!rec) return null

    const entity = rec.entity ?? {}
    const addr = entity.legalAddress ?? entity.headquartersAddress
    const countryCode = addr?.country ?? null
    return {
      lei: rec.lei ?? "",
      legalName: entity.legalName?.name ?? null,
      bic: pickPrimaryBic(rec.bic ?? [], countryCode),
      countryCode,
      city: addr?.city ?? null,
      address: formatAddress(addr),
      postalCode: addr?.postalCode ?? null,
    }
  } catch (err) {
    console.log("[v0] GLEIF lookup failed:", (err as Error).message)
    return null
  }
}
