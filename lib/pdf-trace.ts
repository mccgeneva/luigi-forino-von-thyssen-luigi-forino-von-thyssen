// ---------------------------------------------------------------------------
// Document traceability — token encode/decode + in-file embedding (isomorphic).
//
// Every generated PDF carries an opaque trace token that links a leaked copy of
// the file back to the tamper-proof server audit row (see lib/pdf-trace-db.ts).
// This module is deliberately framework-free so it runs BOTH in the browser
// (embedding the token at generation time) and on the server (extracting it from
// an uploaded file during an admin investigation).
//
// HONEST LIMITATION: PDFs are produced client-side with jsPDF, so a determined
// user CAN strip anything embedded in the file. The in-file token is therefore a
// convenience for linking a copy back to its record — the authoritative trace is
// the server row, which can also be found by user + time range. We embed the
// token in TWO channels (the PDF Info dictionary and near-invisible page
// micro-text) so casual "save as / re-export" rarely removes both at once.
// ---------------------------------------------------------------------------

import type { jsPDF } from "jspdf"

/** Marker prefix that makes a token easy to locate inside raw PDF bytes. */
export const TRACE_PREFIX = "MCCX1:"

/** Regex used to recover a token from arbitrary PDF/text bytes. */
export const TRACE_TOKEN_REGEX = /MCCX1:[A-Za-z0-9\-_]+/g

/**
 * Non-secret rotation key for the light obfuscation below. This is NOT
 * encryption and is not meant to be — it only stops the payload from being
 * casually human-readable if someone opens the PDF in a text editor. The real
 * protection is the server audit row.
 */
const OBFUSCATION_KEY = "MCCcapital.trace.v1"

/** The decoded contents of a trace token embedded in a document. */
export interface TracePayload {
  /** Token format version. */
  v: 1
  /** Globally-unique document id, also the audit-row primary key. */
  docId: string
  /** Account id (owner) the document was generated for. */
  uid: string
  /** Account label (name/company) captured at generation time. */
  account: string
  /** Document type key, e.g. "statement", "receipt", "instrument". */
  kind: string
  /** Generation time (epoch ms). */
  ts: number
}

// --- base64url (isomorphic) -------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  const base64 =
    typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64")
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const binary =
    typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary")
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function xorCycle(bytes: Uint8Array): Uint8Array {
  const key = new TextEncoder().encode(OBFUSCATION_KEY)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length]
  return out
}

// --- doc id -----------------------------------------------------------------

/**
 * Generate a unique, human-legible-ish document id. Format:
 * `MCC-DOC-<base36 time>-<random>`. Safe as a filename fragment and as a DB key.
 */
export function newDocumentId(): string {
  const time = Date.now().toString(36).toUpperCase()
  let rand = ""
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(6)
    cryptoObj.getRandomValues(buf)
    rand = Array.from(buf, (b) => b.toString(36).toUpperCase().padStart(2, "0")).join("").slice(0, 8)
  } else {
    rand = Math.random().toString(36).slice(2, 10).toUpperCase()
  }
  return `MCC-DOC-${time}-${rand}`
}

// --- token codec ------------------------------------------------------------

/** Encode a payload into an opaque, obfuscated `MCCX1:` token string. */
export function encodeTraceToken(payload: TracePayload): string {
  const json = JSON.stringify(payload)
  const obfuscated = xorCycle(new TextEncoder().encode(json))
  return TRACE_PREFIX + toBase64Url(obfuscated)
}

/** Decode a `MCCX1:` token back into its payload, or null if malformed. */
export function decodeTraceToken(token: string): TracePayload | null {
  try {
    if (!token.startsWith(TRACE_PREFIX)) return null
    const body = token.slice(TRACE_PREFIX.length)
    const decoded = xorCycle(fromBase64Url(body))
    const json = new TextDecoder().decode(decoded)
    const parsed = JSON.parse(json) as TracePayload
    if (parsed?.v !== 1 || !parsed.docId) return null
    return parsed
  } catch {
    return null
  }
}

/** Recover the FIRST valid trace token found in arbitrary bytes/text. */
export function extractTraceToken(text: string): { token: string; payload: TracePayload } | null {
  const matches = text.match(TRACE_TOKEN_REGEX)
  if (!matches) return null
  for (const token of matches) {
    const payload = decodeTraceToken(token)
    if (payload) return { token, payload }
  }
  return null
}

// --- in-file embedding ------------------------------------------------------

/**
 * Embed the trace token into a jsPDF document through the PDF Info dictionary
 * (Keywords + Subject) via `setProperties`. jsPDF writes these as plaintext in
 * the file, so `extractTraceToken` can recover them from the raw bytes — this
 * traces a leaked copy back to the generating account without printing anything
 * on the page.
 *
 * NOTE: an earlier build also stamped near-invisible micro-text in the bottom
 * corner of every page. That visible channel was removed platform-wide because
 * on documents meant to be sent to a counterparty (e.g. an FCO) the faint
 * `MCC-DOC-… · MCCX1:…` string was misread as a suspicious watermark. The
 * invisible metadata token below, plus the authoritative server audit record,
 * preserve full leak-traceability.
 *
 * Must be called at generation time, before the doc is rendered to a blob.
 */
export function embedTraceToken(doc: jsPDF, token: string, docId: string): void {
  // Invisible channel only: document properties (Keywords + Subject).
  try {
    doc.setProperties({
      keywords: token,
      subject: `MCC Capital document ${docId}`,
    })
  } catch {
    // setProperties is best-effort; the server audit record still applies.
  }
}
