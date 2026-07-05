"use server"

// ---------------------------------------------------------------------------
// Document traceability — Server Actions.
//
// Two audiences:
//  - Any signed-in client (implicitly) triggers `recordDocumentTrace` when they
//    generate a PDF. The server resolves WHO they are from the session cookie
//    (never trusting a client-supplied identity), captures the real client IP
//    from proxy headers, derives a non-reversible hash of their enrolled
//    biometric, and writes the authoritative audit row.
//  - Administrators (passcode-gated) use `adminExtractTrace` / `adminListTraces`
//    to investigate a leaked document — by its embedded token, its doc id, or by
//    browsing recent generations.
// ---------------------------------------------------------------------------

import { createHash } from "crypto"
import { headers } from "next/headers"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { resolveCurrentSession } from "@/lib/session-user"
import { getEncryptedDescriptor } from "@/lib/biometric-db"
import {
  insertDocumentTrace,
  getDocumentTrace,
  listDocumentTraces,
  type DocumentTrace,
} from "@/lib/pdf-trace-db"
import { decodeTraceToken, extractTraceToken, type TracePayload } from "@/lib/pdf-trace"

function adminOk(passcode: string): boolean {
  return passcode === ADMIN_PASSCODE
}

async function resolveClientIp(): Promise<string | null> {
  try {
    const h = await headers()
    const forwarded = h.get("x-forwarded-for")
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim()
      if (first) return first
    }
    return h.get("x-real-ip") || h.get("x-vercel-forwarded-for") || null
  } catch {
    return null
  }
}

async function resolveUserAgent(): Promise<string | null> {
  try {
    const h = await headers()
    return h.get("user-agent") || null
  } catch {
    return null
  }
}

// --- IP geolocation ---------------------------------------------------------

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
function isPrivateIp(ip: string): boolean {
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
async function geolocateIp(ip: string | null): Promise<IpGeo | null> {
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

/**
 * Derive a stable, non-reversible fingerprint of the user's enrolled biometric.
 * We hash the stored (already-encrypted) descriptor blob with the user id as a
 * salt. This lets an investigator confirm "this document was generated while
 * biometric X was on file for this account" WITHOUT the trace table ever holding
 * the descriptor itself. Returns null when the user has no enrolled biometric.
 */
async function deriveBiometricHash(userId: string): Promise<string | null> {
  try {
    const blob = await getEncryptedDescriptor(userId)
    if (!blob) return null
    return createHash("sha256").update(`${userId}:${blob}`).digest("hex")
  } catch {
    return null
  }
}

export interface RecordTraceClientInput {
  docId: string
  kind: string
  title?: string
  filename?: string
  isDemo?: boolean
}

/**
 * Record the authoritative audit row for a generated document. Called
 * fire-and-forget from the PDF chokepoint so it never delays the preview. The
 * identity is taken from the SESSION, not from the client payload.
 */
export async function recordDocumentTrace(
  input: RecordTraceClientInput,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!input?.docId || !input?.kind) return { ok: false, error: "Missing document metadata." }

    const session = await resolveCurrentSession()
    if (!session) {
      // No valid session — nothing trustworthy to record. Don't write a row.
      return { ok: false, error: "No active session." }
    }

    const account = session.profile.fullName || session.profile.company || session.profile.email || session.id
    const [ipAddress, userAgent, biometricHash] = await Promise.all([
      resolveClientIp(),
      resolveUserAgent(),
      deriveBiometricHash(session.id),
    ])

    await insertDocumentTrace({
      docId: input.docId,
      userId: session.id,
      account,
      kind: input.kind,
      title: input.title ?? null,
      filename: input.filename ?? null,
      ipAddress,
      userAgent,
      biometricHash,
      isDemo: input.isDemo ?? false,
    })
    return { ok: true }
  } catch (err) {
    console.log("[v0] recordDocumentTrace failed:", (err as Error).message)
    return { ok: false, error: "Could not record trace." }
  }
}

export interface TraceLookupResult {
  ok: boolean
  error?: string
  /** Decoded token payload, when a token was supplied and parsed. */
  payload?: TracePayload
  /** Matching server audit row, when found. */
  trace?: DocumentTrace | null
  /** True when a token decoded but no server row exists (e.g. record purged). */
  tokenOnly?: boolean
  /** Approximate physical location resolved from the recorded origin IP. */
  geo?: IpGeo | null
}

/**
 * Admin: investigate a document. Accepts EITHER a raw embedded token
 * (`MCCX1:…`), a bare document id (`MCC-DOC-…`), or a blob of text/PDF bytes
 * that contains a token. Returns the decoded payload and the authoritative row.
 */
export async function adminExtractTrace(passcode: string, needle: string): Promise<TraceLookupResult> {
  if (!adminOk(passcode)) return { ok: false, error: "Administrator authorization failed." }
  const raw = (needle ?? "").trim()
  if (!raw) return { ok: false, error: "Enter a document id, token, or paste document text." }

  try {
    // 1) Direct token, or token embedded within pasted content.
    let payload: TracePayload | null = decodeTraceToken(raw)
    if (!payload) {
      const found = extractTraceToken(raw)
      if (found) payload = found.payload
    }

    // 2) Resolve the doc id — from the token if we have one, else treat the
    //    input as a bare doc id.
    const docId = payload?.docId ?? (raw.startsWith("MCC-DOC-") ? raw : null)
    if (!docId) {
      return { ok: false, error: "No MCC document token or id could be read from that input." }
    }

    const trace = await getDocumentTrace(docId)
    if (!trace) {
      return {
        ok: true,
        payload: payload ?? undefined,
        trace: null,
        tokenOnly: !!payload,
        error: payload
          ? undefined
          : "No matching record found for that document id.",
      }
    }
    const geo = await geolocateIp(trace.ipAddress)
    return { ok: true, payload: payload ?? undefined, trace, geo }
  } catch (err) {
    console.log("[v0] adminExtractTrace failed:", (err as Error).message)
    return { ok: false, error: "The lookup failed. Please try again." }
  }
}

/**
 * Admin: geolocate a bare IP on demand (used when opening a row from the recent
 * list so the location panel is populated consistently).
 */
export async function adminGeolocateIp(
  passcode: string,
  ip: string | null,
): Promise<{ ok: boolean; geo?: IpGeo | null; error?: string }> {
  if (!adminOk(passcode)) return { ok: false, error: "Administrator authorization failed." }
  try {
    return { ok: true, geo: await geolocateIp(ip) }
  } catch {
    return { ok: false, error: "Geolocation lookup failed." }
  }
}

export interface TraceListResult {
  ok: boolean
  error?: string
  traces: DocumentTrace[]
}

/** Admin: list recent document generations, optionally filtered by account id. */
export async function adminListTraces(passcode: string, userId?: string): Promise<TraceListResult> {
  if (!adminOk(passcode)) return { ok: false, traces: [], error: "Administrator authorization failed." }
  try {
    const traces = await listDocumentTraces({ userId: userId?.trim() || undefined, limit: 100 })
    return { ok: true, traces }
  } catch (err) {
    console.log("[v0] adminListTraces failed:", (err as Error).message)
    return { ok: false, traces: [], error: "Could not load recent documents." }
  }
}
