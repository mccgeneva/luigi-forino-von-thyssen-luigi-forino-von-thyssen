"use server"

// ---------------------------------------------------------------------------
// Self-service Linked / Joint (J) accounts.
//
// A signed-in Master can instantly create a Joint account from their own
// profile — no administrator involvement. A Joint account:
//   • has its OWN login credentials and enrols its OWN Face ID on first login
//     (identity & authentication stay per-account for individual accountability);
//   • operates fully inside the Master's ENVIRONMENT — shared balance,
//     instruments, transactions, deals, certificates, beneficiaries, documents —
//     resolved server-side via `dataOwnerId` / `environmentOwnerId`;
//   • has UNRESTRICTED rights: it is NOT subject to the Master-consent payment
//     gate (that gate keys on "sub" only — see lib/account-hierarchy.ts).
//
// Security notes:
//   • The Master is taken from the AUTHORITATIVE session, never client input, so
//     a client can only ever create Joint accounts under THEMSELVES.
//   • Only an effective "master", active, non-impersonated session may create a
//     Joint account. This keeps the hierarchy exactly two levels deep (a Joint
//     or Sub account cannot spawn further linked accounts).
// ---------------------------------------------------------------------------

import { normalizeAccountBadge } from "@/lib/account-tier"
import { logActivity } from "@/app/actions/log-activity"
import {
  getDynamicUserByEmail,
  insertDynamicUser,
  listAccountsByMaster,
  type DynamicUserRecord,
} from "@/lib/admin-users-db"
import { resolveCurrentSession } from "@/lib/session-user"
import { effectiveRelationship } from "@/lib/account-hierarchy"
import type { SerializableUserProfile } from "@/lib/profile-types"

export interface LinkedAccountView {
  id: string
  email: string
  fullName: string
  role: string
  status: string
  createdAt: string
}

export type CreateLinkedAccountInput = {
  fullName: string
  email: string
  password: string
  role?: string
}

export type CreateLinkedAccountResult =
  | { ok: true; account: LinkedAccountView }
  | { ok: false; error: string }

export type LinkedAccountsListResult =
  | { ok: true; accounts: LinkedAccountView[] }
  | { ok: false; error: string }

// --- Helpers ---------------------------------------------------------------

function newId(): string {
  return `du_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function newSessionToken(id: string): string {
  return `mcc.session.${id}.${Math.random().toString(36).slice(2, 16)}`
}

function initialsFrom(fullName: string): string {
  const src = (fullName || "Account").trim()
  const parts = src.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database|connect|pool|password authentication/i.test(msg)) {
    return "Could not reach the database. Please try again in a moment."
  }
  return msg
}

function toView(rec: DynamicUserRecord): LinkedAccountView {
  return {
    id: rec.id,
    email: rec.email,
    fullName: rec.profile.fullName,
    role: rec.profile.role,
    status: rec.status,
    createdAt: rec.createdAt,
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- Actions ---------------------------------------------------------------

/**
 * The Joint accounts the signed-in Master has created. Returns an empty list
 * (not an error) for a non-master session so the UI can simply hide the section.
 */
export async function listMyLinkedAccounts(): Promise<LinkedAccountsListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: true, accounts: [] }
    // Only a Master owns linked accounts; a joint/sub/child never has children.
    if (effectiveRelationship(session.relationship) !== "master") {
      return { ok: true, accounts: [] }
    }
    const rows = await listAccountsByMaster(session.id, "joint")
    return { ok: true, accounts: rows.map(toView) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Instantly create a Joint (J) account linked to the signed-in Master. The
 * Master is derived from the session, so this can only ever create a Joint
 * account under the caller themselves.
 */
export async function createLinkedAccount(input: CreateLinkedAccountInput): Promise<CreateLinkedAccountResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

    // Guard: an administrator "acting as" a client must not silently create a
    // linked account under that client from this self-service surface.
    if (session.impersonator) {
      return { ok: false, error: "Linked accounts cannot be created while acting as a client." }
    }

    // Only a top-level Master may add Joint accounts — keeps the tree 2 levels.
    if (effectiveRelationship(session.relationship) !== "master") {
      return { ok: false, error: "Only a primary (Master) account can create a linked account." }
    }

    const fullName = input.fullName?.trim()
    if (!fullName) return { ok: false, error: "Enter the linked account holder's full name." }

    const email = input.email?.trim().toLowerCase()
    if (!email || !EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address for the linked account." }

    const password = input.password?.trim()
    if (!password || password.length < 8) {
      return { ok: false, error: "Choose a password of at least 8 characters." }
    }

    if (await getDynamicUserByEmail(email)) {
      return { ok: false, error: `The email ${email} is already in use.` }
    }

    const id = newId()
    const role = (input.role || "Joint Account Holder").trim()
    // The Joint account lives inside the Master's environment, so it inherits
    // the Master's company / branding for a consistent shared experience.
    const company = session.profile.company

    const profile: SerializableUserProfile = {
      id,
      email,
      password,
      sessionToken: newSessionToken(id),
      firstName: fullName.split(/\s+/)[0] || company || "Account",
      shortName: fullName,
      fullName,
      initials: initialsFrom(fullName),
      company,
      role,
      headerTag: `${company.toUpperCase().slice(0, 18)} · LINKED`,
      accountBadge: normalizeAccountBadge(session.profile.accountBadge),
      accountEmail: email,
      supportEmail: session.profile.supportEmail || email,
      cardHolderPerson: fullName.toUpperCase(),
      cardHolderCompany: company.toUpperCase(),
      principal: [
        { label: "Represented By", value: fullName },
        { label: "Occupation", value: role },
        { label: "E-mail", value: email },
      ],
      companyInfo: [
        { label: "Business Name", value: company },
        { label: "Contact E-mail", value: email },
      ],
      banking: [],
      // Hierarchy: a Joint account linked under the signed-in Master.
      relationship: "joint",
      masterId: session.id,
      masterName: session.profile.fullName,
      masterEmail: session.profile.email,
    }

    const rec = await insertDynamicUser({
      email,
      password,
      status: "active",
      profile,
      createdBy: session.profile.fullName || "Master",
    })

    await logActivity({
      action: "Client created a linked (joint) account",
      category: "Administration / User Management",
      user: session.profile.fullName,
      details: {
        account: fullName,
        email,
        master: session.profile.fullName,
        relationship: "joint",
        result: "created",
      },
    })

    return { ok: true, account: toView(rec) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}
