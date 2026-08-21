"use server"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import {
  FRESH_LOGIN_COOKIE,
  SESSION_COOKIE,
  SESSION_META_COOKIE,
  SESSION_MAX_AGE,
  IMPERSONATION_COOKIE,
  sessionCookieOptions,
  sessionMetaCookieOptions,
  freshLoginCookieOptions,
  userCookieOptions,
  expiredCookieOptions,
} from "@/lib/auth"
import { signSessionMeta } from "@/lib/session-token"
import { USER_COOKIE } from "@/lib/user-scope"
import { getDynamicUserByEmail, getDynamicUserById, updateDynamicUserProfile } from "@/lib/admin-users-db"
import { resolveCurrentSession } from "@/lib/session-user"
import { DEMO_USER_ID } from "@/lib/users"
import { logActivity } from "@/app/actions/log-activity"
import { del, put } from "@vercel/blob"
import {
  signChallenge,
  verifyChallenge,
  decryptDescriptors,
  encryptDescriptors,
  matchesEnrolled,
  matchesPassport,
  isValidDescriptor,
  FACE_LOCK_COOLDOWN_MS,
  FACE_MAX_FAILS,
} from "@/lib/biometric"
import {
  getFaceState,
  getEncryptedDescriptor,
  getIdentityStatus,
  markIdentityVerified,
  saveEncryptedDescriptor,
  setLastLoginSelfie,
  registerFailure,
  resetFailCount,
} from "@/lib/biometric-db"
import { verifyPassportImage, analyzeKycDocument } from "@/lib/kyc-analyze"
import { insertDemoIdSubmission } from "@/lib/demo-id-db"

export type LoginState = {
  error?: string
  /** Set when the password step passed but a face scan is now required. */
  faceRequired?: boolean
  /**
   * Set when the password step passed but the account still needs to complete
   * one-time identity verification (passport + matching live selfie) before a
   * session is granted. Applies to unverified accounts and, every time, to the
   * shared demo account.
   */
  identityRequired?: boolean
  /** True when the identity step belongs to the stateless demo account. */
  demo?: boolean
  /** Short-lived signed token proving the password step passed (no password inside). */
  challenge?: string
  /** Display name for the face-scan UI. */
  name?: string
  /**
   * Set by `completeFaceLogin` after a successful match. The session cookies
   * are already established server-side; the client performs the navigation.
   * We do NOT `redirect()` inside that action because it is invoked imperatively
   * from the face-capture handler, where a thrown `NEXT_REDIRECT` would be
   * swallowed by the surrounding try/catch and surfaced as a false "something
   * went wrong" error — even though login actually succeeded.
   */
  success?: boolean
  /** Where the client should navigate to after a successful face login. */
  redirectTo?: string
}

/**
 * Hard-clear every session cookie. Each cookie is OVERWRITTEN with an empty,
 * already-expired value using the SAME attributes it was set with
 * (`SameSite=None; Secure; Path=/`). A bare `cookies().delete(name)` is NOT
 * sufficient for `SameSite=None; Secure` cookies — the browser won't replace
 * them unless the clearing cookie matches, which previously left `mcc_session`
 * alive after logout so a refresh re-authenticated silently.
 */
async function clearAllSessionCookies() {
  const cookieStore = await cookies()
  // Overwrite each cookie with an empty, already-expired value using the SAME
  // attributes it was set with. Do NOT also call `cookieStore.delete(name)`
  // here: `delete` emits a second, attribute-less `Set-Cookie` for the same
  // name that WINS over this one, and an attribute-less clear cannot remove a
  // `SameSite=None; Secure` cookie — which would leave the session alive and
  // make logout appear to do nothing (the proxy re-authenticates on redirect).
  // IMPERSONATION_COOKIE is included so logging out (or any forced session clear)
  // never leaves a stale "act as client" cookie behind that would resurrect an
  // impersonated identity on the next visit.
  for (const name of [
    SESSION_COOKIE,
    SESSION_META_COOKIE,
    USER_COOKIE,
    FRESH_LOGIN_COOKIE,
    IMPERSONATION_COOKIE,
  ]) {
    cookieStore.set(name, "", expiredCookieOptions)
  }
}

// A minimal, auth-only view of a credential match. Every account is a dynamic
// record in Neon (lib/admin-users-db.ts).
interface AuthMatch {
  id: string
  password: string
  sessionToken: string
  fullName: string
  company: string
  /** Accounts can be suspended/inactive, which denies access. */
  active: boolean
}

/**
 * Resolve a login email to a credential record from the database. All accounts
 * (including the three seeded core accounts) live in Postgres, so login depends
 * on the database being reachable.
 */
async function findAuthMatchByEmail(email: string): Promise<AuthMatch | undefined> {
  try {
    const dyn = await getDynamicUserByEmail(email)
    if (dyn) {
      return {
        id: dyn.id,
        password: dyn.password,
        sessionToken: dyn.sessionToken,
        fullName: dyn.profile.fullName || dyn.profile.company || dyn.email,
        company: dyn.profile.company || "",
        active: dyn.status === "active",
      }
    }
  } catch {
    // Database unreachable — no account can be resolved until it recovers.
  }
  return undefined
}

/** Path the client lands on immediately after a genuine login. */
const POST_LOGIN_PATH = "/dashboard?fresh=1"

/**
 * Establish the authenticated session cookies for a user. Shared by the
 * password-only path and the face-verified path so both produce an identical,
 * fully-valid session. Does NOT redirect — callers decide how to navigate.
 */
/**
 * Store a login selfie snapshot (a small JPEG data URL captured client-side) in
 * Blob and record it as this user's latest login selfie. Returns the blob
 * PATHNAME (never the raw public URL) so it can only be reached through the
 * admin-gated proxy route. Best-effort: any failure returns null and never
 * blocks the login. The demo account is excluded — it is stateless.
 */
async function storeLoginSelfie(userId: string, dataUrl?: string): Promise<string | null> {
  try {
    if (!userId || userId === DEMO_USER_ID || !dataUrl) return null
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl)
    if (!match) return null
    const contentType = match[1]
    const buffer = Buffer.from(match[2], "base64")
    // Guard against an implausibly large payload (the client sends a ~320px JPEG).
    if (buffer.byteLength > 600_000) return null
    const blob = await put(`login-selfies/${userId}/${Date.now()}.jpg`, buffer, {
      access: "public",
      addRandomSuffix: true,
      contentType,
    })
    await setLastLoginSelfie(userId, blob.pathname)
    return blob.pathname
  } catch (err) {
    console.log("[v0] storeLoginSelfie failed:", (err as Error).message)
    return null
  }
}

async function establishSession(
  matchedUser: AuthMatch,
  email: string,
  opts?: { selfieDataUrl?: string },
): Promise<void> {
  const cookieStore = await cookies()
  // The session cookie carries this user's unique token (the security
  // boundary), and a separate readable cookie records which user it is so the
  // client can show the right identity and isolate the right data.
  cookieStore.set(SESSION_COOKIE, matchedUser.sessionToken, sessionCookieOptions)
  cookieStore.set(USER_COOKIE, matchedUser.id, userCookieOptions)

  // Issue the signed session-metadata cookie (server-enforced absolute expiry).
  const nowMs = Date.now()
  const metaToken = await signSessionMeta({
    iat: nowMs,
    exp: nowMs + SESSION_MAX_AGE * 1000,
    seen: nowMs,
  })
  cookieStore.set(SESSION_META_COOKIE, metaToken, sessionMetaCookieOptions)
  cookieStore.set(FRESH_LOGIN_COOKIE, "1", freshLoginCookieOptions)
  // A genuine login is always a clean, non-impersonated session — clear any
  // lingering impersonation marker so the new session resolves to this account.
  cookieStore.set(IMPERSONATION_COOKIE, "", expiredCookieOptions)

  // Persist the login selfie (if the client captured one) BEFORE logging so the
  // audit event carries the snapshot pathname.
  const selfiePathname = await storeLoginSelfie(matchedUser.id, opts?.selfieDataUrl)

  await logActivity({
    action: "Login successful",
    category: "Authentication",
    user: `${matchedUser.fullName} (${matchedUser.company})`,
    userId: matchedUser.id,
    selfieUrl: selfiePathname ?? undefined,
    details: { email, result: "granted", selfieCaptured: selfiePathname ? "yes" : "no" },
  })
}

/**
 * Establish the session and `redirect()`. Safe ONLY for callers invoked through
 * a form action / `useActionState` (e.g. the password-only path), where a
 * thrown `NEXT_REDIRECT` is handled by the framework rather than caught by app
 * code. NOTE: this never returns.
 */
async function establishSessionAndRedirect(matchedUser: AuthMatch, email: string): Promise<never> {
  await establishSession(matchedUser, email)
  redirect(POST_LOGIN_PATH)
}

/**
 * User-facing message for a biometric lock. Since the lock now auto-clears after
 * FACE_LOCK_COOLDOWN_MS, we tell the user roughly how long until they can retry,
 * while still offering the instant administrator-reset path.
 */
function lockedMessage(lockedAt: string | null): string {
  const lockedMs = lockedAt ? Date.parse(lockedAt) : NaN
  if (Number.isFinite(lockedMs)) {
    const remaining = FACE_LOCK_COOLDOWN_MS - (Date.now() - lockedMs)
    const minutes = Math.max(1, Math.ceil(remaining / 60000))
    return `Face ID is temporarily locked after too many failed attempts. It will unlock automatically in about ${minutes} minute${minutes === 1 ? "" : "s"}, or contact your administrator to reset it now.`
  }
  return "Face ID is temporarily locked after too many failed attempts. Please wait a few minutes and try again, or contact your administrator to reset it now."
}

async function logFailedLogin(email: string, reason: string): Promise<void> {
  await logActivity({
    action: "Login failed",
    category: "Authentication / Security",
    user: email || "(no email)",
    details: { email: email || "(empty)", reason, result: "denied" },
  })
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") || "").trim()
  const password = String(formData.get("password") || "")

  const matchedUser = await findAuthMatchByEmail(email)
  const passwordMatches = !!matchedUser && password === matchedUser.password
  const accountActive = !!matchedUser && matchedUser.active

  if (matchedUser && passwordMatches && accountActive) {
    // ------------------------------------------------------------------
    // PREVIEW-ONLY 2FA BYPASS (sandbox / local development).
    //
    // In the v0 preview sandbox there is no real passport or camera, so the
    // mandatory passport + selfie identity gate can't be completed. This
    // shortcut skips the second factor and grants the session directly.
    //
    // PRODUCTION-SAFE BY CONSTRUCTION: Vercel always builds in production mode
    // (NODE_ENV === "production") for BOTH production and preview deployments,
    // so this branch can only ever run under a development build — i.e. the v0
    // sandbox or a local `next dev`. The deployed site at www.mcc-btp.app can
    // NEVER trigger it.
    // ------------------------------------------------------------------
    if (process.env.NODE_ENV !== "production") {
      await establishSessionAndRedirect(matchedUser, email)
    }

    // Password step passed. DO NOT establish a session yet — a second factor is
    // always required. We hand the browser a short-lived signed challenge (no
    // password inside) that the follow-up action verifies alongside the scan.
    const isDemo = matchedUser.id === DEMO_USER_ID
    const face = await getFaceState(matchedUser.id)
    const identity = await getIdentityStatus(matchedUser.id)

    // FAST PATH: a real account that has already completed identity verification
    // and enrolled a live selfie only needs the strict selfie second factor —
    // the unchanged Face ID flow. (The demo account is stateless and never
    // takes this path; it re-verifies its identity on every login.)
    if (!isDemo && identity.verified && face.enrolled) {
      if (face.locked) {
        await logFailedLogin(email, "biometric locked")
        await clearAllSessionCookies()
        return { error: lockedMessage(face.lockedAt) }
      }
      return {
        faceRequired: true,
        challenge: signChallenge(matchedUser.id),
        name: matchedUser.fullName,
      }
    }

    // IDENTITY GATE: unverified real accounts (including existing users on their
    // next login) and the demo account every time must prove their identity with
    // a passport + a matching live selfie before any session is granted.
    return {
      identityRequired: true,
      demo: isDemo,
      challenge: signChallenge(matchedUser.id),
      name: matchedUser.fullName,
    }
  }

  // A failed attempt must never leave an active session behind.
  await clearAllSessionCookies()

  const reason = !matchedUser
    ? "unauthorized email"
    : !passwordMatches
      ? "incorrect password"
      : "account not active"
  await logFailedLogin(email, reason)

  return {
    error:
      matchedUser && passwordMatches && !accountActive
        ? "This account is not active. Please contact your administrator."
        : "Invalid email or password. Access denied.",
  }
}

/**
 * Second login factor: verify a live face scan against the user's enrolled,
 * encrypted descriptor under a STRICT match threshold. Only callable with a
 * valid, unexpired challenge issued by the password step — so the password
 * gate cannot be skipped. On success, establishes the session; on failure,
 * increments the lockout counter and (after the limit) locks biometric login.
 */
export async function completeFaceLogin(
  challenge: string,
  descriptor: number[],
  selfieImage?: string,
): Promise<LoginState> {
  const uid = verifyChallenge(challenge)
  if (!uid) {
    return { error: "Your sign-in attempt expired. Please enter your password again." }
  }
  if (!isValidDescriptor(descriptor)) {
    return { faceRequired: true, challenge, error: "No face detected. Center your face and try again." }
  }

  const rec = await getDynamicUserById(uid)
  if (!rec || rec.status !== "active") {
    await clearAllSessionCookies()
    return { error: "Invalid email or password. Access denied." }
  }

  const face = await getFaceState(uid)
  if (!face.enrolled) {
    // Enrollment was cleared (e.g. admin reset) mid-flow → fall back to password.
    return { error: "Face ID is no longer set up for this account. Please sign in with your password." }
  }
  if (face.locked) {
    return { error: lockedMessage(face.lockedAt) }
  }

  const enrolled = decryptDescriptors(await getEncryptedDescriptor(uid))
  const { ok, distance } = matchesEnrolled(descriptor, enrolled)

  if (!ok) {
    const { failCount, locked } = await registerFailure(uid)
    await logActivity({
      action: locked ? "Face ID locked after failed attempts" : "Face ID verification failed",
      category: "Authentication / Security",
      user: `${rec.profile.fullName || rec.email}`,
      details: { email: rec.email, distance: distance.toFixed(3), failCount, result: locked ? "locked" : "denied" },
    })
    if (locked) {
      // Just locked → the full cooldown remains from now.
      return { error: lockedMessage(new Date().toISOString()) }
    }
    const remaining = Math.max(0, FACE_MAX_FAILS - failCount)
    return {
      faceRequired: true,
      challenge,
      error: `Face not recognized. Move to a well-lit spot, hold the phone at eye level, and keep your whole face in frame. Please try again${remaining ? ` (${remaining} attempt${remaining === 1 ? "" : "s"} left)` : ""}.`,
    }
  }

  // Match. Clear the fail counter and start the session. We do NOT redirect
  // here (see LoginState.success): the cookies are set server-side and the
  // client navigates, so a thrown NEXT_REDIRECT can't be mistaken for a scan
  // failure.
  await resetFailCount(uid)
  await establishSession(
    {
      id: rec.id,
      password: rec.password,
      sessionToken: rec.sessionToken,
      fullName: rec.profile.fullName || rec.profile.company || rec.email,
      company: rec.profile.company || "",
      active: true,
    },
    rec.email,
    { selfieDataUrl: selfieImage },
  )
  return { success: true, redirectTo: POST_LOGIN_PATH }
}

/** Payload sent by the client after gathering the passport + live selfie. */
export interface IdentityVerificationInput {
  /** 128-float descriptor of the face photo on the passport (computed client-side). */
  passportDescriptor: number[]
  /** 128-float descriptor of the live selfie (computed client-side). */
  selfieDescriptor: number[]
  /** Blob pathname of the uploaded passport image (server reads its bio-data, then deletes it). */
  passportPathname: string
  /** Content type of the uploaded passport image. */
  passportContentType: string
  /** Small JPEG data URL of the live selfie, retained as the login snapshot. */
  selfieImage?: string
}

/**
 * First login factor extension: mandatory identity verification. Requires a
 * valid, unexpired challenge from the password step, then:
 *   1. Confirms the uploaded document actually reads as a passport (photo + MRZ)
 *      via the multimodal analyzer — an in-app document check, NOT a licensed
 *      government-authenticity attestation.
 *   2. Matches the live selfie against the passport photo under a looser
 *      threshold suited to live-vs-printed comparison.
 * On success: real accounts are marked verified and their LIVE selfie is
 * enrolled for the strict fast path on future logins; the full passport number
 * and the passport image are RETAINED for the administrator KYC dossier. The
 * demo account verifies statelessly (nothing persisted, image deleted) so the
 * shared public login stays usable. On any rejection/failure the uploaded image
 * is always deleted.
 */
export async function verifyIdentityAndLogin(
  challenge: string,
  input: IdentityVerificationInput,
): Promise<LoginState> {
  const uid = verifyChallenge(challenge)
  if (!uid) {
    return { error: "Your sign-in attempt expired. Please enter your password again." }
  }

  const rec = await getDynamicUserById(uid)
  if (!rec || rec.status !== "active") {
    await clearAllSessionCookies()
    return { error: "Invalid email or password. Access denied." }
  }

  const isDemo = uid === DEMO_USER_ID
  const name = rec.profile.fullName || rec.profile.company || rec.email

  if (!isValidDescriptor(input?.passportDescriptor)) {
    return {
      identityRequired: true,
      demo: isDemo,
      challenge,
      name,
      error: "We couldn't find a clear face photo on your passport. Retake the photo with the whole bio-data page in frame.",
    }
  }
  if (!isValidDescriptor(input?.selfieDescriptor)) {
    return {
      identityRequired: true,
      demo: isDemo,
      challenge,
      name,
      error: "No face detected in your selfie. Center your face and try again.",
    }
  }

  // Face-scan lockout applies to real accounts (the demo is stateless and never
  // locks, so the public login can't be bricked by a bad actor).
  const face = await getFaceState(uid)
  if (!isDemo && face.locked) {
    return { error: "Face ID is locked after too many failed attempts. Please contact your administrator to reset it." }
  }

  // Once we commit to RETAINING the passport image (real account, verified), we
  // must never delete it — otherwise the stored `identity_passport_image` path
  // would dangle. This flag makes the catch-all cleanup below respect that.
  let passportRetained = false
  const cleanupPassport = async () => {
    if (passportRetained) return
    try {
      await del(input.passportPathname)
    } catch {
      // Best-effort: a leftover blob is harmless and will be re-checked next time.
    }
  }

  try {
    // 1) Confirm the uploaded document reads as a passport with a face photo.
    const pv = await verifyPassportImage(input.passportPathname, input.passportContentType || "image/jpeg")
    if (!pv.isPassport || !pv.hasFacePhoto) {
      await cleanupPassport()
      await logActivity({
        action: "Identity verification rejected — not a valid passport",
        category: "Authentication / Security",
        user: name,
        details: { email: rec.email, reason: pv.reason || "document is not a passport with a photo", result: "denied" },
      })
      return {
        identityRequired: true,
        demo: isDemo,
        challenge,
        name,
        error:
          (pv.reason && pv.reason.trim()) ||
          "That document doesn't read as a valid passport. Upload a clear photo of your passport bio-data page.",
      }
    }

    // 2) Match the live selfie against the passport photo (looser threshold).
    const { ok, distance } = matchesPassport(input.selfieDescriptor, input.passportDescriptor)
    if (!ok) {
      await cleanupPassport()
      let failCount = 0
      let locked = false
      if (!isDemo) {
        const res = await registerFailure(uid)
        failCount = res.failCount
        locked = res.locked
      }
      await logActivity({
        action: locked ? "Identity verification locked after failed attempts" : "Identity verification failed — face mismatch",
        category: "Authentication / Security",
        user: name,
        details: { email: rec.email, distance: distance.toFixed(3), failCount, result: locked ? "locked" : "denied" },
      })
      if (locked) {
        return { error: "Face verification locked after too many failed attempts. Please contact your administrator to reset it." }
      }
      const remaining = isDemo ? 0 : Math.max(0, 5 - failCount)
      return {
        identityRequired: true,
        demo: isDemo,
        challenge,
        name,
        error: `Your selfie didn't match the photo on the passport. Please try again${
          remaining ? ` (${remaining} attempt${remaining === 1 ? "" : "s"} left)` : ""
        }.`,
      }
    }

    // 3) Success.
    if (!isDemo) {
      // Mark BEFORE the DB write so any later failure in this try can't delete
      // the image out from under a stored `identity_passport_image` path.
      passportRetained = true
      // Persist verification and enroll the LIVE selfie so future logins use the
      // strict selfie-only fast path (selfie-vs-selfie, not selfie-vs-document).
      // RETAIN the full passport number and the passport image for the
      // administrator KYC dossier: the image is intentionally NOT deleted here —
      // it stays in Blob under its unguessable `identity/` pathname and is only
      // reachable through the session-gated passport-image proxy that the
      // admin-passcode-gated security audit surfaces.
      const last4 = pv.passportNo ? pv.passportNo.slice(-4) : null
      await markIdentityVerified(uid, {
        country: pv.country || null,
        fullName: pv.fullName || name,
        passportLast4: last4,
        passportNo: pv.passportNo || null,
        passportImagePath: input.passportPathname || null,
      })
      await saveEncryptedDescriptor(uid, encryptDescriptors([input.selfieDescriptor]))
      await resetFailCount(uid)
    } else {
      // The demo account is stateless — never persist a passport image.
      await cleanupPassport()
    }

    await logActivity({
      action: "Identity verified",
      category: "Authentication / Security",
      user: name,
      details: {
        email: rec.email,
        country: pv.country || "",
        distance: distance.toFixed(3),
        mode: isDemo ? "demo (stateless)" : "enrolled",
        result: "granted",
      },
    })

    await establishSession(
      {
        id: rec.id,
        password: rec.password,
        sessionToken: rec.sessionToken,
        fullName: name,
        company: rec.profile.company || "",
        active: true,
      },
      rec.email,
      { selfieDataUrl: input.selfieImage },
    )
    return { success: true, redirectTo: POST_LOGIN_PATH }
  } catch (error) {
    await cleanupPassport()
    const detail = error instanceof Error ? error.message : String(error)
    console.error("[v0] Identity verification error:", detail)
    return {
      identityRequired: true,
      demo: isDemo,
      challenge,
      name,
      error: "We couldn't verify your identity right now. Please try again in a moment.",
    }
  }
}

/** Payload sent by the demo account after uploading a valid ID document. */
export interface DemoIdVerificationInput {
  /** Blob pathname of the uploaded ID image (retained for administrator review). */
  docPathname: string
  /** Content type of the uploaded image. */
  docContentType: string
  /** Best-effort GPS captured client-side (omitted when the visitor denied it). */
  gps?: { lat: number; lng: number; accuracy?: number }
}

/** Extract the client IP from the standard proxy headers. */
async function readClientIp(): Promise<string | null> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  const first = forwarded ? forwarded.split(",")[0]?.trim() : ""
  return first || h.get("x-real-ip") || h.get("x-vercel-forwarded-for") || null
}

/**
 * DEMO-ONLY login factor: the shared demo account (demo@mccgva.ch) does NOT use
 * facial recognition. Instead the visitor uploads a photo/screenshot of a valid
 * ID document. We OCR it to identify who is testing the platform and RETAIN the
 * image together with the visitor's IP and GPS (if granted) for administrator
 * inspection, then grant the demo session. No face match, no descriptor.
 *
 * This action is hard-scoped to DEMO_USER_ID — any other account is rejected, so
 * a real account can never bypass its own strict biometric/identity gate here.
 */
export async function verifyDemoDocumentAndLogin(
  challenge: string,
  input: DemoIdVerificationInput,
): Promise<LoginState> {
  const uid = verifyChallenge(challenge)
  if (!uid) {
    return { error: "Your sign-in attempt expired. Please enter your password again." }
  }
  if (uid !== DEMO_USER_ID) {
    // This document-only path is exclusively for the shared demo account.
    await clearAllSessionCookies()
    return { error: "Invalid email or password. Access denied." }
  }

  const rec = await getDynamicUserById(uid)
  if (!rec || rec.status !== "active") {
    await clearAllSessionCookies()
    return { error: "This demonstration account is not available right now." }
  }

  const name = rec.profile.fullName || rec.profile.company || rec.email
  const pathname = input?.docPathname || ""
  if (!pathname) {
    return { identityRequired: true, demo: true, challenge, name, error: "Please add a photo of your ID document first." }
  }

  try {
    // 1) OCR the document. Accept ANY valid government ID (passport, national ID
    //    card, driver's licence). Reject anything that clearly isn't identity.
    const analysis = await analyzeKycDocument(pathname, input.docContentType || "image/jpeg")
    const idPage = analysis.pages?.find(
      (p) => p.isDocument && ["passport", "id_card", "drivers_license"].includes(p.type),
    )
    const isIdentityDoc = !!analysis.passport || !!idPage
    if (!isIdentityDoc) {
      // Not an ID — remove the useless upload and ask again.
      try {
        await del(pathname)
      } catch {
        // best-effort
      }
      await logActivity({
        action: "Demo ID verification rejected — not a valid ID document",
        category: "Authentication / Security",
        user: "Demo visitor",
        details: { result: "denied", reason: "uploaded file is not an identity document" },
      })
      return {
        identityRequired: true,
        demo: true,
        challenge,
        name,
        error: "That doesn't read as a valid ID document. Upload a clear photo of your passport, national ID, or driver's licence.",
      }
    }

    // 2) Build the identity summary from the OCR output.
    const p = analysis.passport
    const fullName =
      (analysis.fields?.fullName || "").trim() ||
      (p ? `${p.givenNames} ${p.surname}`.trim() : "") ||
      "Unidentified visitor"
    const docType = (p?.type || idPage?.label || "ID document").trim()
    const docNumber = (p?.passportNo || "").trim()
    const country = (p?.country || analysis.fields?.nationality || "").trim()

    // 3) Capture IP + user agent (server-side) and persist the audit record.
    const h = await headers()
    const ip = await readClientIp()
    const userAgent = h.get("user-agent")
    const gps = input.gps
    await insertDemoIdSubmission({
      id: `DEMOID-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      docPathname: pathname,
      docContentType: input.docContentType || "image/jpeg",
      docType,
      fullName,
      docNumber,
      country,
      ip,
      userAgent,
      gpsLat: typeof gps?.lat === "number" && Number.isFinite(gps.lat) ? gps.lat : null,
      gpsLng: typeof gps?.lng === "number" && Number.isFinite(gps.lng) ? gps.lng : null,
      gpsAccuracy: typeof gps?.accuracy === "number" && Number.isFinite(gps.accuracy) ? gps.accuracy : null,
    })

    await logActivity({
      action: "Demo access — ID captured",
      category: "Authentication / Security",
      user: fullName,
      userId: DEMO_USER_ID,
      details: {
        result: "granted",
        docType,
        country: country || "",
        ip: ip || "unknown",
        gps: gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : "not shared",
        mode: "demo (ID-verified, no face)",
      },
    })

    // 4) Grant the demo session (no face factor).
    await establishSession(
      {
        id: rec.id,
        password: rec.password,
        sessionToken: rec.sessionToken,
        fullName: name,
        company: rec.profile.company || "",
        active: true,
      },
      rec.email,
    )
    return { success: true, redirectTo: POST_LOGIN_PATH }
  } catch (error) {
    console.error("[v0] Demo ID verification error:", error instanceof Error ? error.message : error)
    return {
      identityRequired: true,
      demo: true,
      challenge,
      name,
      error: "We couldn't process your ID right now. Please try again in a moment.",
    }
  }
}

// NOTE: Sign-out used to live here as the `logout()` Server Action, invoked via
// `<form action={logout}>`. It was moved to the Route Handler `app/api/logout`
// because Server Action POSTs are silently rejected on this app's production
// domains + mobile in-app webviews — the failed action bubbled into the app
// error boundary ("Something went wrong"), most visibly right after returning
// from an admin impersonation session. Do NOT reintroduce logout as a Server
// Action; the forms now do a native POST to /api/logout.

export type ChangePasswordResult = { ok: true } | { ok: false; error: string }

/**
 * Self-service password change for the signed-in client.
 *
 * Security model:
 *  - Identity comes ONLY from the authoritative session (`resolveCurrentSession`),
 *    never from client-supplied ids — a user can only ever change their OWN
 *    password.
 *  - The current password must be re-verified, so a hijacked but unlocked
 *    session still can't silently rotate the password.
 *  - The demo / showcase account (DEMO_USER_ID) is intentionally immutable so
 *    the public demonstration login keeps working for everyone.
 *  - Blocked while an administrator is impersonating ("Sign in as") a client —
 *    admins rotate credentials through the dedicated admin reset tool instead,
 *    so a maintenance session can't accidentally change a client's password.
 */
export async function changeMyPassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  const session = await resolveCurrentSession()
  if (!session) {
    return { ok: false, error: "Your session has expired. Please sign in again." }
  }
  if (session.impersonator) {
    return {
      ok: false,
      error: "Password changes are disabled during a maintenance session. Use the admin reset tool instead.",
    }
  }
  if (session.id === DEMO_USER_ID) {
    return {
      ok: false,
      error: "This is a demonstration account — its password cannot be changed.",
    }
  }

  const current = String(currentPassword || "")
  const next = String(newPassword || "")
  if (next.length < 8) {
    return { ok: false, error: "Your new password must be at least 8 characters long." }
  }
  if (next === current) {
    return { ok: false, error: "Your new password must be different from your current password." }
  }

  const rec = await getDynamicUserById(session.id)
  if (!rec) {
    return { ok: false, error: "We couldn't load your account. Please sign in again." }
  }
  if (current !== rec.password) {
    await logActivity({
      action: "Password change failed",
      category: "Authentication / Security",
      user: `${rec.profile.fullName || rec.email}`,
      details: { email: rec.email, reason: "incorrect current password", result: "denied" },
    })
    return { ok: false, error: "Your current password is incorrect." }
  }

  const updated = await updateDynamicUserProfile(session.id, { password: next })
  if (!updated) {
    return { ok: false, error: "We couldn't update your password. Please try again." }
  }

  await logActivity({
    action: "Password changed",
    category: "Authentication / Security",
    user: `${rec.profile.fullName || rec.email}`,
    details: { email: rec.email, result: "password updated by account holder" },
  })

  return { ok: true }
}

// Reasons used for automatic session termination by the client-side SessionGuard.
export type ExpireReason = "expiry" | "tab-close" | "inactivity"

const EXPIRE_REASON_LABELS: Record<ExpireReason, string> = {
  expiry: "session expired",
  "tab-close": "browser tab or window closed",
  inactivity: "inactive for 15 minutes",
}

// Securely terminates the session from the client (cookie is httpOnly, so only
// the server can delete it). Logs the reason for the audit trail.
export async function expireSession(reason: ExpireReason) {
  await clearAllSessionCookies()
  await logActivity({
    action: "Session terminated automatically",
    category: "Authentication / Security",
    details: {
      result: "session ended",
      reason: EXPIRE_REASON_LABELS[reason] ?? reason,
      trigger: reason,
    },
  })
  redirect(`/login?expired=${reason}`)
}
