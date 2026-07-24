// ---------------------------------------------------------------------------
// Authoritative session resolver (server-only).
//
// The Edge proxy can only do a lightweight "is a session cookie present" check
// because it cannot reach Postgres. This module is the authoritative resolver:
// given the session cookie it returns the signed-in user — checking the static
// registry (lib/users.ts) first and then the dynamic, admin-created users in
// Neon (lib/admin-users-db.ts). It also enforces account status: suspended or
// inactive dynamic accounts resolve to `null` so they are denied access.
//
// Used by:
//  - app/dashboard/layout.tsx  → authoritative gate (redirects if invalid)
//  - app/actions/auth.ts        → login lookup
//  - app/actions/admin-users.ts → "who am I" for the client identity hydrate
// ---------------------------------------------------------------------------

import "server-only"
import { cookies } from "next/headers"
import { SESSION_COOKIE, SESSION_META_COOKIE, SESSION_IDLE_MAX_AGE, IMPERSONATION_COOKIE } from "@/lib/auth"
import { verifySessionMeta, evaluateSessionMeta, verifyImpersonation } from "@/lib/session-token"
import { getUserById, type UserProfile } from "@/lib/users"
import {
  getDynamicUserById,
  getDynamicUserBySessionToken,
  listAccountsByMaster,
  type DynamicUserRecord,
  type UserStatus,
} from "@/lib/admin-users-db"
import { hydrateProfile, type AccountRelationship } from "@/lib/profile-types"
import { effectiveRelationship } from "@/lib/account-hierarchy"

export interface ResolvedSession {
  /** Stable user id — this account's OWN identity (auth, audit, "who am I"). */
  id: string
  /** Full identity profile (icons hydrated for dynamic users). */
  profile: UserProfile
  /** "static" = hand-authored registry user; "dynamic" = admin-created. */
  kind: "static" | "dynamic"
  /** Account status. Static users are always "active". */
  status: UserStatus
  /** Position in the referral hierarchy ("master" | "sub" | "child"). */
  relationship: AccountRelationship
  /** The Master account id, when this is a sub/child account. */
  masterId?: string
  /**
   * The id whose SHARED financial data (balance + bank instruments) this
   * session operates on. For a Sub-account this is the Master's id, so a sub
   * reads/writes the Master's ledger and instruments — a live shared pool.
   * For everyone else it equals `id`. This is the single lever that implements
   * "shared balance & instruments" without weakening per-account isolation of
   * everything else (KYC, beneficiaries, profile, etc.).
   */
  dataOwnerId: string
  /**
   * The id whose otherwise per-account domains (certificates, beneficiaries,
   * cards, SKR, reserved deals — everything NOT covered by `dataOwnerId`) this
   * session operates on. For a Joint (J) account this is the Master's id, so a
   * joint account operates inside the Master's ENTIRE environment. For everyone
   * else — including Sub-accounts, whose non-financial data stays isolated — it
   * equals `id`. Keeping this separate from `dataOwnerId` means widening the
   * shared environment for joint accounts never weakens Sub/Child isolation.
   */
  environmentOwnerId: string
  /**
   * Set ONLY when an administrator is "signed in as" this account for
   * maintenance. Records the original admin so the UI can show a "Return to
   * admin" banner and the audit trail attributes actions correctly. Absent for
   * normal (non-impersonated) sessions.
   */
  impersonator?: { id: string; name: string }
}

function dynamicToResolved(rec: DynamicUserRecord): ResolvedSession {
  const relationship = effectiveRelationship(rec.profile.relationship)
  const masterId = rec.profile.masterId
  // Sub AND Joint share the Master's financial pool; only Joint additionally
  // shares the non-financial environment. Both fall back to own id if a
  // linked account somehow has no masterId, so data can never leak sideways.
  const linkedToMaster = (relationship === "sub" || relationship === "joint") && !!masterId
  const dataOwnerId = linkedToMaster ? (masterId as string) : rec.id
  const environmentOwnerId = relationship === "joint" && masterId ? masterId : rec.id
  return {
    id: rec.id,
    profile: hydrateProfile(rec.profile),
    kind: "dynamic",
    status: rec.status,
    relationship,
    masterId,
    dataOwnerId,
    environmentOwnerId,
  }
}

/**
 * Resolve the SHARED-data owner id for any account id. A Sub-account's balance
 * and bank instruments live under its Master, so financial reads/writes for a
 * sub must target the Master's id. Everyone else owns their own data.
 *
 * Falls back to the passed id on any lookup failure, so a transient DB error
 * can never cause one account's money movement to land on a different account.
 */
export async function resolveDataOwnerIdFor(userId: string | undefined | null): Promise<string> {
  if (!userId) return ""
  try {
    const rec = await getDynamicUserById(userId)
    const rel = rec ? effectiveRelationship(rec.profile.relationship) : "master"
    // Sub AND Joint accounts operate on the Master's shared financial pool.
    if (rec && (rel === "sub" || rel === "joint") && rec.profile.masterId) {
      return rec.profile.masterId
    }
  } catch {
    // DB unavailable — operate on the account's own id rather than guessing.
  }
  return userId
}

/**
 * Resolve the ENVIRONMENT owner id for any account id — the owner of the
 * otherwise per-account domains (certificates, beneficiaries, cards, SKR,
 * reserved deals). Only a Joint (J) account resolves to its Master here; every
 * other account (including Sub) owns its own environment. Falls back to the
 * passed id on any lookup failure.
 */
export async function resolveEnvironmentOwnerIdFor(userId: string | undefined | null): Promise<string> {
  if (!userId) return ""
  try {
    const rec = await getDynamicUserById(userId)
    if (rec && effectiveRelationship(rec.profile.relationship) === "joint" && rec.profile.masterId) {
      return rec.profile.masterId
    }
  } catch {
    // DB unavailable — operate on the account's own id rather than guessing.
  }
  return userId
}

/**
 * Resolve ALL account ids that share an environment with `userId` — i.e. the
 * Master plus every Joint (J) account linked under it. Used by "list my …"
 * reads (approvals, commodity deals, reserved cargo, payments) so a Joint
 * account sees the Master's full history and vice-versa, while writes/audit
 * stay attributed to the individual `session.id`.
 *
 * For any non-joint, unlinked account this returns just `[userId]`, so it is a
 * safe drop-in for the previous single-id reads. Always includes `userId` and
 * de-duplicates; falls back to `[userId]` on any lookup failure.
 */
export async function resolveEnvironmentMemberIds(userId: string | undefined | null): Promise<string[]> {
  if (!userId) return []
  const ids = new Set<string>([userId])
  try {
    const rec = await getDynamicUserById(userId)
    const rel = rec ? effectiveRelationship(rec.profile.relationship) : "master"
    // The environment's Master id: the account itself if it's a master, else
    // its linked masterId (only meaningful for a joint account).
    const masterId = rel === "joint" && rec?.profile.masterId ? rec.profile.masterId : userId
    ids.add(masterId)
    // Add every Joint account linked under that master (siblings + self).
    const joints = await listAccountsByMaster(masterId, "joint")
    for (const j of joints) ids.add(j.id)
  } catch {
    // DB unavailable — operate on just the account's own id.
  }
  return [...ids]
}

/**
 * Resolve a session token to a user. Every account lives in the database, so
 * this requires Postgres to be reachable. Accounts are only granted access
 * while their status is "active".
 */
export async function resolveSessionByToken(token: string | undefined | null): Promise<ResolvedSession | null> {
  if (!token) return null

  try {
    const dyn = await getDynamicUserBySessionToken(token)
    if (dyn && dyn.status === "active") return dynamicToResolved(dyn)
  } catch {
    // Database unreachable — the session cannot be resolved until it recovers.
  }
  return null
}

/** Resolve the current request's session from the httpOnly session cookie. */
export async function resolveCurrentSession(): Promise<ResolvedSession | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value

  // Defense-in-depth: enforce server-side session expiry here too, so any RSC,
  // layout, or server action that resolves the session rejects an expired/idle
  // session even if it were somehow reached without passing the Edge proxy.
  const meta = await verifySessionMeta(cookieStore.get(SESSION_META_COOKIE)?.value)
  if (evaluateSessionMeta(meta, SESSION_IDLE_MAX_AGE * 1000) !== "valid") return null

  // Admin "act as client" maintenance session. When a valid, signed
  // impersonation cookie is present, the session resolves to the TARGET account
  // so the entire dashboard (identity, ledger, instruments, KYC, …) operates as
  // that client. The target is resolved by id rather than by session token, so
  // it works even for suspended/inactive accounts that an admin needs to
  // maintain (e.g. the client changed their own password or enrolled Face ID).
  const imp = await verifyImpersonation(cookieStore.get(IMPERSONATION_COOKIE)?.value)
  if (imp && Date.now() < imp.exp) {
    try {
      const rec = await getDynamicUserById(imp.targetId)
      if (rec) {
        const resolved = dynamicToResolved(rec)
        resolved.impersonator = { id: imp.adminId, name: imp.adminName }
        return resolved
      }
    } catch {
      // DB unreachable — fall through to the normal token resolution below.
    }
  }

  return resolveSessionByToken(token)
}

/**
 * Resolve ANY account id — static OR dynamic (admin-created) — to its full
 * identity profile. Intended for server-side labelling such as admin audit-log
 * entries and emails, where we must show the CORRECT target account.
 *
 * For unknown ids it returns the neutral placeholder (via getUserById), never a
 * different real user. This is what keeps "Administrator posted X to <account>"
 * audit entries accurate for dynamic users instead of mis-attributing them to
 * the primary account.
 */
export async function resolveAccountProfileById(userId: string | undefined | null): Promise<UserProfile> {
  if (!userId) return getUserById(null)
  try {
    const dyn = await getDynamicUserById(userId)
    if (dyn) return hydrateProfile(dyn.profile)
  } catch {
    // DB unavailable — fall through to the neutral placeholder.
  }
  return getUserById(userId)
}
