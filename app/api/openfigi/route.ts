import { NextResponse } from "next/server"
import { mapIsinServer, searchFigiServer } from "@/lib/openfigi-server"

// ---------------------------------------------------------------------------
// OpenFIGI proxy (server-only)
//
// The OpenFIGI API key MUST never reach the browser, so all calls go through
// this route. The actual Bloomberg access lives in `lib/openfigi-server.ts`,
// shared with the marketplace publish flow so verification is identical
// everywhere. Two modes:
//   • POST { isin }   → /v3/mapping  : validate & enrich a single ISIN
//   • POST { query }  → /v3/search   : live Bloomberg-style security search
//
// Bilateral bank instruments (SBLC / BG / most private MTNs) are NOT exchange
// listed, so a valid-but-unlisted ISIN returns an empty match — that is the
// honest, expected result and is surfaced as "not exchange-listed".
// ---------------------------------------------------------------------------

export const runtime = "nodejs"

const CACHE_TTL_MS = 10 * 60_000 // 10 minutes — identifiers are stable.

// Module-level cache shared across requests on the same server instance.
const cache = new Map<string, { ts: number; payload: unknown }>()

export async function POST(request: Request) {
  let body: { isin?: string; query?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }

  const isin = body.isin?.trim()
  const query = body.query?.trim()

  if (!isin && !query) {
    return NextResponse.json({ ok: false, error: "Provide an isin or query." }, { status: 400 })
  }

  const cacheKey = isin ? `isin:${isin.toUpperCase()}` : `q:${query!.toLowerCase()}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload)
  }

  try {
    if (isin) {
      const result = await mapIsinServer(isin)
      const payload = { ok: true, mode: "mapping", isin: isin.toUpperCase(), ...result }
      cache.set(cacheKey, { ts: Date.now(), payload })
      return NextResponse.json(payload)
    }
    const result = await searchFigiServer(query!)
    const payload = { ok: true, mode: "search", query, ...result }
    cache.set(cacheKey, { ts: Date.now(), payload })
    return NextResponse.json(payload)
  } catch (err) {
    console.log("[v0] openfigi route failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: "OpenFIGI lookup failed. Please try again." },
      { status: 502 },
    )
  }
}
