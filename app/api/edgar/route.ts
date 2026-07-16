import { NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// SEC EDGAR proxy (server-only)
//
// Pulls public issuer information, prospectuses and filing documents straight
// from the SEC's official systems. No API key exists for EDGAR, but the SEC
// fair-access policy REQUIRES a descriptive User-Agent on every request, so all
// calls are proxied here (never from the browser) with that header attached.
//
// Two modes, auto-selected from the request:
//   • POST { query }            → resolve an issuer / ticker to its CIK and
//                                 return the company profile + recent filings
//                                 (prospectuses, registration statements, 10-K…)
//   • POST { query, fullText }  → EDGAR full-text search across filing bodies,
//                                 returning matching documents (used as a
//                                 fallback when a name doesn't map to a CIK).
//
// Docs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
// ---------------------------------------------------------------------------

export const runtime = "nodejs"

// SEC requires a real contact in the UA. Allow an env override so operators can
// point it at their own contact address; fall back to a platform default.
const USER_AGENT =
  process.env.SEC_EDGAR_USER_AGENT || "NAFTAhub Bank Instruments compliance@naftahub.com"

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions"
const FULLTEXT_URL = "https://efts.sec.gov/LATEST/search-index"
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data"

// Forms that represent a prospectus / securities-offering document. Flagged in
// the UI so a client can jump straight to offering material.
const PROSPECTUS_FORMS = new Set([
  "424A",
  "424B1",
  "424B2",
  "424B3",
  "424B4",
  "424B5",
  "424B7",
  "424B8",
  "S-1",
  "S-1/A",
  "S-3",
  "S-3/A",
  "F-1",
  "F-1/A",
  "F-3",
  "424H",
  "FWP",
  "EFFECT",
  "N-2",
])

// Result caps + cache TTLs. Reference data is stable, so caching is safe and
// keeps us well under the SEC's 10 requests/second fair-access limit.
const MAX_FILINGS = 40
const MAX_FULLTEXT = 25
const CACHE_TTL_MS = 10 * 60_000

interface TickerRecord {
  cik_str: number
  ticker: string
  title: string
}

interface EdgarFiling {
  form: string
  filingDate: string
  reportDate?: string
  accessionNumber: string
  primaryDocument: string
  primaryDocDescription?: string
  documentUrl: string
  filingIndexUrl: string
  isProspectus: boolean
  size?: number
}

interface EdgarCompany {
  cik: string
  name: string
  tickers: string[]
  exchanges: string[]
  sic?: string
  sicDescription?: string
  entityType?: string
}

// Module-level caches shared across requests on the same server instance.
const responseCache = new Map<string, { ts: number; payload: unknown }>()
let tickerCache: { ts: number; records: TickerRecord[] } | null = null

function secHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  }
}

/** Zero-pad a CIK to the 10 digits the submissions API expects. */
function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0")
}

/** Load & cache the SEC ticker↔CIK directory (a few hundred KB, stable). */
async function loadTickers(): Promise<TickerRecord[]> {
  if (tickerCache && Date.now() - tickerCache.ts < 24 * 60 * 60_000) {
    return tickerCache.records
  }
  const res = await fetch(TICKERS_URL, { headers: secHeaders(), cache: "no-store" })
  if (!res.ok) throw new Error(`SEC tickers ${res.status}`)
  const json = (await res.json()) as Record<string, TickerRecord>
  const records = Object.values(json)
  tickerCache = { ts: Date.now(), records }
  return records
}

/**
 * Resolve a free-text issuer / ticker to the best-matching CIK. Exact ticker
 * matches win, then exact names, then name "starts-with", then substring.
 */
async function resolveCik(query: string): Promise<TickerRecord | null> {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const records = await loadTickers()

  const exactTicker = records.find((r) => r.ticker.toLowerCase() === q)
  if (exactTicker) return exactTicker

  const exactName = records.find((r) => r.title.toLowerCase() === q)
  if (exactName) return exactName

  const startsWith = records.find((r) => r.title.toLowerCase().startsWith(q))
  if (startsWith) return startsWith

  return records.find((r) => r.title.toLowerCase().includes(q)) ?? null
}

/** Build the public document + filing-index URLs for one filing. */
function buildUrls(cik: string, accession: string, primaryDocument: string) {
  const cikNum = String(Number.parseInt(cik, 10))
  const accNoDashes = accession.replace(/-/g, "")
  const documentUrl = primaryDocument
    ? `${ARCHIVES_BASE}/${cikNum}/${accNoDashes}/${primaryDocument}`
    : `${ARCHIVES_BASE}/${cikNum}/${accNoDashes}/`
  const filingIndexUrl = `${ARCHIVES_BASE}/${cikNum}/${accNoDashes}/${accession}-index.htm`
  return { documentUrl, filingIndexUrl }
}

/** Fetch a company profile + normalised recent filings from the submissions API. */
async function fetchCompany(record: TickerRecord): Promise<{ company: EdgarCompany; filings: EdgarFiling[] }> {
  const cik = padCik(record.cik_str)
  const res = await fetch(`${SUBMISSIONS_BASE}/CIK${cik}.json`, {
    headers: secHeaders(),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`SEC submissions ${res.status}`)
  const data = (await res.json()) as {
    cik: string
    name: string
    tickers?: string[]
    exchanges?: string[]
    sic?: string
    sicDescription?: string
    entityType?: string
    filings?: {
      recent?: {
        accessionNumber?: string[]
        filingDate?: string[]
        reportDate?: string[]
        form?: string[]
        primaryDocument?: string[]
        primaryDocDescription?: string[]
        size?: number[]
      }
    }
  }

  const recent = data.filings?.recent
  const filings: EdgarFiling[] = []
  if (recent?.accessionNumber) {
    for (let i = 0; i < recent.accessionNumber.length && filings.length < MAX_FILINGS; i++) {
      const form = recent.form?.[i] ?? ""
      const accessionNumber = recent.accessionNumber[i]
      const primaryDocument = recent.primaryDocument?.[i] ?? ""
      const { documentUrl, filingIndexUrl } = buildUrls(cik, accessionNumber, primaryDocument)
      filings.push({
        form,
        filingDate: recent.filingDate?.[i] ?? "",
        reportDate: recent.reportDate?.[i] || undefined,
        accessionNumber,
        primaryDocument,
        primaryDocDescription: recent.primaryDocDescription?.[i] || undefined,
        documentUrl,
        filingIndexUrl,
        isProspectus: PROSPECTUS_FORMS.has(form.toUpperCase()),
        size: recent.size?.[i],
      })
    }
  }

  const company: EdgarCompany = {
    cik,
    name: data.name ?? record.title,
    tickers: data.tickers ?? [record.ticker],
    exchanges: data.exchanges ?? [],
    sic: data.sic,
    sicDescription: data.sicDescription,
    entityType: data.entityType,
  }
  return { company, filings }
}

interface FullTextHit {
  form: string
  filingDate: string
  accessionNumber: string
  cik: string
  displayName: string
  documentUrl: string
  filingIndexUrl: string
  isProspectus: boolean
}

/** EDGAR full-text search fallback across filing bodies. */
async function fullTextSearch(query: string): Promise<FullTextHit[]> {
  const url = `${FULLTEXT_URL}?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: secHeaders(), cache: "no-store" })
  if (!res.ok) throw new Error(`SEC full-text ${res.status}`)
  const json = (await res.json()) as {
    hits?: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> }
  }
  const hits = json.hits?.hits ?? []
  const out: FullTextHit[] = []
  for (const h of hits.slice(0, MAX_FULLTEXT)) {
    const src = h._source ?? {}
    // _id is "<accession>:<filename>" e.g. "0000320193-24-000123:aapl.htm".
    // The accession is also exposed as `adsh`; prefer it and fall back to _id.
    const [idAccession, filename] = (h._id ?? "").split(":")
    const accession = (src.adsh as string) || idAccession
    const ciks = (src.ciks as string[] | undefined) ?? []
    const cik = ciks[0] ?? ""
    // Live EDGAR exposes a string `form`, plus `root_forms` (array) and
    // `file_type`. Use whichever is present, in that order.
    const rootForms = src.root_forms as string[] | undefined
    const form =
      (src.form as string) || rootForms?.[0] || (src.file_type as string) || ""
    const display = ((src.display_names as string[] | undefined) ?? []).join(", ")
    if (!accession || !cik) continue
    const { documentUrl, filingIndexUrl } = buildUrls(cik, accession, filename ?? "")
    out.push({
      form,
      filingDate: (src.file_date as string) ?? "",
      accessionNumber: accession,
      cik: padCik(cik),
      displayName: display,
      documentUrl,
      filingIndexUrl,
      isProspectus: PROSPECTUS_FORMS.has(form.toUpperCase()),
    })
  }
  return out
}

export async function POST(request: Request) {
  let body: { query?: string; fullText?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }

  const query = body.query?.trim()
  if (!query) {
    return NextResponse.json({ ok: false, error: "Provide an issuer name, ticker or search phrase." }, { status: 400 })
  }

  const cacheKey = `${body.fullText ? "ft" : "co"}:${query.toLowerCase()}`
  const cached = responseCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload)
  }

  try {
    // Explicit full-text search requested.
    if (body.fullText) {
      const hits = await fullTextSearch(query)
      const payload = { ok: true, mode: "fulltext", query, hits }
      responseCache.set(cacheKey, { ts: Date.now(), payload })
      return NextResponse.json(payload)
    }

    // Default: resolve to a company and return its filings.
    const record = await resolveCik(query)
    if (record) {
      const { company, filings } = await fetchCompany(record)
      const payload = { ok: true, mode: "company", query, company, filings }
      responseCache.set(cacheKey, { ts: Date.now(), payload })
      return NextResponse.json(payload)
    }

    // No CIK match — fall back to full-text search so the client still gets docs.
    const hits = await fullTextSearch(query)
    const payload = {
      ok: true,
      mode: "fulltext",
      query,
      hits,
      note: "No exact issuer match in the SEC CIK directory — showing full-text document matches instead.",
    }
    responseCache.set(cacheKey, { ts: Date.now(), payload })
    return NextResponse.json(payload)
  } catch (err) {
    console.log("[v0] edgar route failed:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: "SEC EDGAR lookup failed. Please try again shortly." },
      { status: 502 },
    )
  }
}
