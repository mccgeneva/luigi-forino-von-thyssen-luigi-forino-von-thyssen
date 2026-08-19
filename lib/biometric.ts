// ---------------------------------------------------------------------------
// Biometric (Face ID) core — server-only.
//
// Handles the SECURITY-CRITICAL primitives for face login:
//   • AES-256-GCM encryption of face descriptors at rest (we NEVER store images,
//     only the 128-number embedding, and even that is encrypted).
//   • Euclidean matching with a STRICT threshold.
//   • Short-lived, signed login "challenges" so the password step can hand off
//     to the face step without re-sending the password to the client.
//
// The encryption key and challenge HMAC key are derived from SESSION_SECRET, so
// no new secret has to be provisioned. This module imports node:crypto and must
// only ever run on the server.
// ---------------------------------------------------------------------------

import "server-only"
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"

/** face-api.js descriptors are always 128 floats. */
export const DESCRIPTOR_LENGTH = 128

/**
 * Match threshold (euclidean distance on the descriptor) for enrolled
 * selfie-vs-selfie login. face-api's standard recognition default is ~0.6.
 *
 * We previously ran an aggressive 0.42, but that rejected too many GENUINE
 * users: the same person under different lighting, angle, distance, or a
 * lower-quality front camera routinely scans at 0.45-0.60, while a DIFFERENT
 * person almost always scores 0.70+. 0.42 sat inside the genuine-match band and
 * caused frequent false rejections (real support cases at ~0.53). 0.55 admits
 * genuine matches with real-world capture variance while preserving a healthy
 * gap from impostors. A scan matches only if its distance to an enrolled sample
 * is <= this value.
 */
export const FACE_MATCH_THRESHOLD = 0.55

/**
 * LOOSER threshold used ONLY for the identity-verification gate, where a LIVE
 * selfie is compared against the face photo printed on a passport. Comparing a
 * live camera frame to a scanned/printed document photo is inherently noisier
 * than selfie-vs-selfie (print screen, laminate glare, older photo), so a strict
 * 0.42 would reject most genuine matches. 0.60 is face-api's standard recognition
 * default: it admits genuine live-vs-print matches (which cluster around
 * 0.55-0.62) while still comfortably rejecting a different person (who typically
 * score 0.70+). After a user passes once, we enroll their LIVE selfie and all
 * future logins use the tighter selfie-only threshold, so day-to-day security is unchanged.
 */
export const PASSPORT_FACE_MATCH_THRESHOLD = 0.6

/** Consecutive failed scans before biometric login locks. */
export const FACE_MAX_FAILS = 5

/**
 * How long a biometric lock lasts before it automatically clears, letting a
 * genuine user self-recover without waiting for an administrator. Face matching
 * fails easily in the real world (poor lighting, low-quality front cameras,
 * in-app browser webviews that degrade the camera), so a permanent lock created
 * far too much login friction. An administrator can still reset instantly at any
 * time; this is just the automatic fallback.
 */
export const FACE_LOCK_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Login challenge validity — must comfortably outlast the WHOLE hand-off from
 * the password step through the passport upload AND the live selfie capture.
 * The old 2-minute window routinely expired mid-flow for first-time users (and
 * in slow in-app webviews), which surfaced as an opaque "Vercel Blob: Failed to
 * retrieve the client token" error at the passport upload and left them unable
 * to log in until they re-entered their password. 15 minutes removes that
 * friction while staying short-lived — the real security boundary is the
 * password check plus the face match, not this token's lifetime.
 */
const CHALLENGE_TTL_MS = 15 * 60 * 1000

const FALLBACK_SECRET = "mcc-naftahub-dev-secret-do-not-use-in-prod"
function secret(): string {
  return process.env.SESSION_SECRET || FALLBACK_SECRET
}

// Derive stable, independent 32-byte keys for the two purposes.
function encKey(): Buffer {
  return scryptSync(secret(), "mcc-biometric-enc-v1", 32)
}
function macKey(): Buffer {
  return scryptSync(secret(), "mcc-biometric-mac-v1", 32)
}

// --- Descriptor encryption (AES-256-GCM) ----------------------------------

/**
 * Encrypt one or more enrollment descriptors into a single opaque string.
 * Format: base64(iv).base64(authTag).base64(ciphertext).
 */
export function encryptDescriptors(descriptors: number[][]): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(descriptors), "utf8")
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`
}

/** Decrypt the stored blob back into the enrolled descriptors. Returns [] on failure. */
export function decryptDescriptors(blob: string | null | undefined): number[][] {
  if (!blob) return []
  try {
    const [ivB64, tagB64, dataB64] = blob.split(".")
    if (!ivB64 || !tagB64 || !dataB64) return []
    const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivB64, "base64"))
    decipher.setAuthTag(Buffer.from(tagB64, "base64"))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()])
    const parsed = JSON.parse(plaintext.toString("utf8"))
    return Array.isArray(parsed) ? (parsed as number[][]) : []
  } catch {
    return []
  }
}

// --- Matching --------------------------------------------------------------

/** Validate that a client-supplied descriptor is well-formed (length + finite). */
export function isValidDescriptor(d: unknown): d is number[] {
  return (
    Array.isArray(d) &&
    d.length === DESCRIPTOR_LENGTH &&
    d.every((n) => typeof n === "number" && Number.isFinite(n))
  )
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }
  return Math.sqrt(sum)
}

/** Smallest distance between a candidate scan and any enrolled sample. */
export function bestDistance(candidate: number[], enrolled: number[][]): number {
  let best = Number.POSITIVE_INFINITY
  for (const sample of enrolled) {
    if (sample.length !== candidate.length) continue
    const d = euclideanDistance(candidate, sample)
    if (d < best) best = d
  }
  return best
}

/** True when a candidate scan matches the enrolled identity under the strict threshold. */
export function matchesEnrolled(candidate: number[], enrolled: number[][]): { ok: boolean; distance: number } {
  const distance = bestDistance(candidate, enrolled)
  return { ok: distance <= FACE_MATCH_THRESHOLD, distance }
}

/**
 * True when a live selfie matches a passport-photo descriptor under the LOOSER
 * identity-gate threshold. Used only during first-time identity verification.
 */
export function matchesPassport(selfie: number[], passport: number[]): { ok: boolean; distance: number } {
  const distance = bestDistance(selfie, [passport])
  return { ok: distance <= PASSPORT_FACE_MATCH_THRESHOLD, distance }
}

// --- Login challenge (signed, short-lived) ---------------------------------

interface ChallengePayload {
  uid: string
  exp: number
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Issue a signed challenge proving the password step passed for `uid`. The token
 * never contains the password and expires quickly, so it can safely round-trip
 * to the browser while it performs the face scan.
 */
export function signChallenge(uid: string): string {
  const payload: ChallengePayload = { uid, exp: Date.now() + CHALLENGE_TTL_MS }
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
  const sig = b64url(createHmac("sha256", macKey()).update(body).digest())
  return `${body}.${sig}`
}

/** Verify a challenge token and return its uid, or null if invalid/expired/tampered. */
export function verifyChallenge(token: string | null | undefined): string | null {
  if (!token) return null
  const [body, sig] = token.split(".")
  if (!body || !sig) return null
  const expected = b64url(createHmac("sha256", macKey()).update(body).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as ChallengePayload
    if (!payload?.uid || typeof payload.exp !== "number" || Date.now() > payload.exp) return null
    return payload.uid
  } catch {
    return null
  }
}
