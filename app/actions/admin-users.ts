"use server"

// ---------------------------------------------------------------------------
// Administrator user management.
//
// Lets an administrator create new client accounts at runtime, generate
// credentials (email + temporary password), reset credentials, edit the
// displayed identity, and activate / suspend / deactivate / delete accounts.
//
// Dynamic users are persisted in Neon (lib/admin-users-db.ts) so they survive
// restarts and can actually log in via app/actions/auth.ts. Every mutating
// action is passcode-gated and written to the activity-log audit trail, exactly
// like the other administrator sections (gateway, treasury, ledger, …).
// ---------------------------------------------------------------------------

import { adminActionAuthorized } from "@/lib/admin-auth"
import { normalizeAccountBadge } from "@/lib/account-tier"
import { logActivity } from "@/app/actions/log-activity"
import {
  listDynamicUsers,
  getDynamicUserById,
  getDynamicUserByEmail,
  insertDynamicUser,
  updateDynamicUserProfile,
  setDynamicUserStatus,
  deleteDynamicUser,
  type DynamicUserRecord,
  type UserStatus,
} from "@/lib/admin-users-db"
import type { SerializableUserProfile, SerializableProfileItem, AccountRelationship } from "@/lib/profile-types"
import { effectiveRelationship } from "@/lib/account-hierarchy"
import { validateIban, validateBic } from "@/lib/iban-swift"
import type { KycDocument, KycPassportMeta } from "@/lib/kyc-types"

// A client-safe view of a dynamic user (never includes nothing it shouldn't —
// for the admin console the password IS shown, intentionally, so the admin can
// hand it to the client; this mirrors the demo nature of the platform).
export interface AdminUserView {
  id: string
  email: string
  password: string
  status: UserStatus
  fullName: string
  company: string
  role: string
  accountBadge: string
  createdAt: string
  updatedAt: string
  createdBy: string
  // Referral hierarchy
  relationship: AccountRelationship
  masterId?: string
  masterName?: string
  masterEmail?: string
  // Existing banking coordinates (extracted from the profile's banking rows),
  // surfaced so admin flows can pre-fill them without re-typing.
  bankName?: string
  iban?: string
  swift?: string
  accountCurrency?: string
}

/** Pull the common banking coordinates out of a profile's free-form banking
 *  rows so admin views can pre-fill them. Matching is label-keyword based and
 *  tolerant of the various labels used across the platform. */
function extractBankingCoordinates(banking: SerializableProfileItem[] | undefined): {
  bankName?: string
  iban?: string
  swift?: string
  accountCurrency?: string
} {
  const rows = banking ?? []
  const find = (test: (label: string) => boolean) => rows.find((r) => test(r.label.toLowerCase()))?.value?.trim()
  const iban = find((l) => l.includes("iban"))
  const swift = find((l) => l.includes("swift") || l.includes("bic"))
  const accountCurrency = find((l) => l.includes("currency"))
  // "Bank name" / "Bank" but never the IBAN/SWIFT rows.
  const bankName = find((l) => l.includes("bank") && !l.includes("iban") && !l.includes("swift") && !l.includes("bic"))
  return {
    ...(bankName ? { bankName } : {}),
    ...(iban ? { iban } : {}),
    ...(swift ? { swift } : {}),
    ...(accountCurrency ? { accountCurrency } : {}),
  }
}

export type AdminUsersResult =
  | { ok: true; users: AdminUserView[] }
  | { ok: false; error: string }

export type AdminUserMutation =
  | { ok: true; user: AdminUserView; tempPassword?: string }
  | { ok: false; error: string }

async function requireAdmin(passcode: string): Promise<void> {
  if (!(await adminActionAuthorized(passcode))) {
    throw new Error("Administrator authorization failed.")
  }
}

function toView(rec: DynamicUserRecord): AdminUserView {
  return {
    id: rec.id,
    email: rec.email,
    password: rec.password,
    status: rec.status,
    fullName: rec.profile.fullName,
    company: rec.profile.company,
    role: rec.profile.role,
    accountBadge: normalizeAccountBadge(rec.profile.accountBadge),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    createdBy: rec.createdBy,
    relationship: effectiveRelationship(rec.profile.relationship),
    masterId: rec.profile.masterId,
    masterName: rec.profile.masterName,
    masterEmail: rec.profile.masterEmail,
    ...extractBankingCoordinates(rec.profile.banking),
  }
}

// --- Credential generators -------------------------------------------------

function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24)
}

/** Generate a unique login email from a name/company, e.g. "louis.thyssen@mccgva.ch". */
export async function generateUsername(seed: string): Promise<string> {
  const base = slugify(seed) || "client"
  const domain = "mccgva.ch"
  let candidate = `${base}@${domain}`
  let n = 1
  // Ensure uniqueness across all (dynamic) accounts.
  while (await getDynamicUserByEmail(candidate)) {
    n += 1
    candidate = `${base}${n}@${domain}`
  }
  return candidate
}

/** Generate a readable temporary password, e.g. "MCC-7F3A-2K9D". */
function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no ambiguous chars
  const block = (len: number) =>
    Array.from({ length: len }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("")
  return `MCC-${block(4)}-${block(4)}`
}

/**
 * Map any thrown error to an admin-facing message. Raw database/connection
 * failures (e.g. ECONNREFUSED when DATABASE_URL isn't configured) are replaced
 * with a clear, actionable message instead of a cryptic socket error.
 */
function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database|connect|pool|password authentication/i.test(msg)) {
    return "Could not reach the database. Please confirm the Neon database is connected (DATABASE_URL) and try again."
  }
  return msg
}

function newId(): string {
  // Dynamic ids are prefixed so they never collide with static ("u1"…) ids and
  // are obvious in storage namespaces.
  return `du_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function newSessionToken(id: string): string {
  return `mcc.session.${id}.${Math.random().toString(36).slice(2, 16)}`
}

// --- Profile assembly ------------------------------------------------------

export interface CreateUserInput {
  passcode: string
  email?: string // optional — auto-generated when omitted
  password?: string // optional — auto-generated when omitted
  fullName: string
  company: string
  role?: string
  accountBadge?: string
  status?: UserStatus
  phone?: string
  nationality?: string
  address?: string
  website?: string
  // Free-form extra identity rows the admin can attach.
  principalExtra?: SerializableProfileItem[]
  companyExtra?: SerializableProfileItem[]
  bankingExtra?: SerializableProfileItem[]
  // KYC documents extracted from an uploaded onboarding PDF (Blob pathnames).
  passportImage?: string
  passportMeta?: KycPassportMeta | null
  kycDocuments?: KycDocument[]
  kycPdfPathname?: string
  adminName?: string
  // Referral hierarchy. relationship defaults to "master" (standalone). When
  // "sub" or "child", masterId must reference an existing account.
  relationship?: AccountRelationship
  masterId?: string
}

function initialsFrom(fullName: string, company: string): string {
  const src = (fullName || company || "Client").trim()
  const parts = src.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

function buildProfile(input: CreateUserInput, id: string, email: string, password: string): SerializableUserProfile {
  const fullName = input.fullName.trim()
  const company = input.company.trim()
  const role = (input.role || "Authorised Signatory").trim()
  const firstName = fullName.split(/\s+/)[0] || company || "Client"

  const principal: SerializableProfileItem[] = [
    { label: "Represented By", value: fullName || company },
    { label: "Occupation", value: role },
  ]
  if (input.nationality) principal.push({ label: "Nationality", value: input.nationality })
  if (input.address) principal.push({ label: "Residential Address", value: input.address })
  if (input.phone) principal.push({ label: "Mobile", value: input.phone })
  principal.push({ label: "E-mail", value: email })
  if (input.principalExtra?.length) principal.push(...input.principalExtra)

  const companyInfo: SerializableProfileItem[] = [{ label: "Business Name", value: company }]
  if (input.website) companyInfo.push({ label: "Website", value: input.website })
  companyInfo.push({ label: "Contact E-mail", value: email })
  if (input.companyExtra?.length) companyInfo.push(...input.companyExtra)

  const banking: SerializableProfileItem[] = []
  if (input.bankingExtra?.length) banking.push(...input.bankingExtra)

  return {
    id,
    email,
    password,
    sessionToken: newSessionToken(id),
    firstName,
    shortName: fullName || company,
    fullName: fullName || company,
    initials: initialsFrom(fullName, company),
    company,
    role,
    headerTag: `${company.toUpperCase().slice(0, 18)} · CLIENT`,
    accountBadge: normalizeAccountBadge(input.accountBadge),
    accountEmail: email,
    supportEmail: email,
    cardHolderPerson: (fullName || company).toUpperCase(),
    cardHolderCompany: company.toUpperCase(),
    principal,
    companyInfo,
    banking,
    ...(input.passportImage ? { passportImage: input.passportImage } : {}),
    ...(input.passportMeta ? { passportMeta: input.passportMeta } : {}),
    ...(input.kycDocuments?.length ? { kycDocuments: input.kycDocuments } : {}),
    ...(input.kycPdfPathname ? { kycPdfPathname: input.kycPdfPathname } : {}),
  }
}

/**
 * Validate a requested hierarchy placement and resolve the denormalised Master
 * fields to stamp onto the profile. Enforces the core invariants:
 *  - master accounts carry no master link;
 *  - sub/child must reference an existing account;
 *  - the chosen Master must itself be a "master" (no multi-level chaining), so
 *    the tree stays exactly two levels deep.
 * Returns the resolved fields, or an error string.
 */
async function resolveHierarchy(
  relationship: AccountRelationship | undefined,
  masterId: string | undefined,
  selfId?: string,
): Promise<
  | { ok: true; fields: Pick<SerializableUserProfile, "relationship" | "masterId" | "masterName" | "masterEmail"> }
  | { ok: false; error: string }
> {
  const rel = effectiveRelationship(relationship)
  if (rel === "master") {
    return { ok: true, fields: { relationship: "master", masterId: undefined, masterName: undefined, masterEmail: undefined } }
  }
  if (!masterId) {
    return { ok: false, error: "Select a Master account for a sub or child account." }
  }
  if (selfId && masterId === selfId) {
    return { ok: false, error: "An account cannot be its own Master." }
  }
  const master = await getDynamicUserById(masterId)
  if (!master) {
    return { ok: false, error: "The selected Master account no longer exists." }
  }
  if (effectiveRelationship(master.profile.relationship) !== "master") {
    return { ok: false, error: "The selected account is itself linked to a Master. Choose a top-level Master account." }
  }
  return {
    ok: true,
    fields: {
      relationship: rel,
      masterId: master.id,
      masterName: master.profile.fullName,
      masterEmail: master.email,
    },
  }
}

// --- Actions ---------------------------------------------------------------

export async function listUsers(passcode: string): Promise<AdminUsersResult> {
  try {
    await requireAdmin(passcode)
    const users = (await listDynamicUsers()).map(toView)
    return { ok: true, users }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function createUser(input: CreateUserInput): Promise<AdminUserMutation> {
  try {
    requireAdmin(input.passcode)
    if (!input.fullName?.trim() && !input.company?.trim()) {
      return { ok: false, error: "A full name or company is required." }
    }

    const email = (input.email?.trim() || (await generateUsername(input.fullName || input.company))).toLowerCase()
    if (await getDynamicUserByEmail(email)) {
      return { ok: false, error: `The email ${email} is already in use.` }
    }
    const tempPassword = input.password?.trim() || generateTempPassword()
    const id = newId()
    const profile = buildProfile(input, id, email, tempPassword)
    const status = input.status ?? "active"

    // Resolve & validate referral placement, then stamp it onto the profile.
    const hierarchy = await resolveHierarchy(input.relationship, input.masterId, id)
    if (!hierarchy.ok) return { ok: false, error: hierarchy.error }
    Object.assign(profile, hierarchy.fields)

    const rec = await insertDynamicUser({
      email,
      password: tempPassword,
      status,
      profile,
      createdBy: input.adminName || "Administrator",
    })

    await logActivity({
      action: "Administrator created a client account",
      category: "Administration / User Management",
      user: input.adminName || "Administrator",
      details: {
        account: profile.fullName,
        company: profile.company,
        email,
        status,
        result: "created",
      },
    })

    return { ok: true, user: toView(rec), tempPassword }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function resetUserPassword(
  passcode: string,
  id: string,
  newPassword?: string,
  adminName?: string,
): Promise<AdminUserMutation> {
  try {
    await requireAdmin(passcode)
    const existing = await getDynamicUserById(id)
    if (!existing) return { ok: false, error: "User not found." }
    const tempPassword = newPassword?.trim() || generateTempPassword()
    const rec = await updateDynamicUserProfile(id, { password: tempPassword })
    if (!rec) return { ok: false, error: "Unable to update credentials." }

    await logActivity({
      action: "Administrator reset client credentials",
      category: "Administration / User Management",
      user: adminName || "Administrator",
      details: { account: rec.profile.fullName, email: rec.email, result: "password reset" },
    })

    return { ok: true, user: toView(rec), tempPassword }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function updateUserStatus(
  passcode: string,
  id: string,
  status: UserStatus,
  adminName?: string,
): Promise<AdminUserMutation> {
  try {
    await requireAdmin(passcode)
    const rec = await setDynamicUserStatus(id, status)
    if (!rec) return { ok: false, error: "User not found." }

    await logActivity({
      action: `Administrator set client account to ${status}`,
      category: "Administration / User Management",
      user: adminName || "Administrator",
      details: { account: rec.profile.fullName, email: rec.email, status, result: "status changed" },
    })

    return { ok: true, user: toView(rec) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export interface EditUserInput {
  passcode: string
  id: string
  email?: string
  fullName?: string
  company?: string
  role?: string
  accountBadge?: string
  adminName?: string
  // Referral hierarchy. Provide relationship (+ masterId for sub/child) to
  // re-place the account in the tree. Omit to leave the placement unchanged.
  relationship?: AccountRelationship
  masterId?: string
}

export async function editUser(input: EditUserInput): Promise<AdminUserMutation> {
  try {
    requireAdmin(input.passcode)
    const existing = await getDynamicUserById(input.id)
    if (!existing) return { ok: false, error: "User not found." }

    const profile = { ...existing.profile }
    if (input.fullName?.trim()) {
      profile.fullName = input.fullName.trim()
      profile.shortName = input.fullName.trim()
      profile.firstName = input.fullName.trim().split(/\s+/)[0] || profile.firstName
      profile.initials = initialsFrom(input.fullName, profile.company)
      profile.cardHolderPerson = input.fullName.trim().toUpperCase()
    }
    if (input.company?.trim()) {
      profile.company = input.company.trim()
      profile.cardHolderCompany = input.company.trim().toUpperCase()
      profile.headerTag = `${input.company.trim().toUpperCase().slice(0, 18)} · CLIENT`
    }
    if (input.role?.trim()) profile.role = input.role.trim()
    if (input.accountBadge?.trim()) profile.accountBadge = normalizeAccountBadge(input.accountBadge)

    let email = existing.email
    if (input.email?.trim() && input.email.trim().toLowerCase() !== existing.email.toLowerCase()) {
      email = input.email.trim().toLowerCase()
      if (await getDynamicUserByEmail(email)) {
        return { ok: false, error: `The email ${email} is already in use.` }
      }
      profile.email = email
      profile.accountEmail = email
      profile.supportEmail = email
    }

    // Re-place in the referral tree when a relationship is supplied. Guard
    // against turning a Master that still has dependants into a sub/child,
    // which would orphan its linked accounts.
    if (input.relationship !== undefined) {
      const nextRel = effectiveRelationship(input.relationship)
      if (nextRel !== "master" && effectiveRelationship(existing.profile.relationship) === "master") {
        const dependants = (await listDynamicUsers()).filter((u) => u.profile.masterId === input.id)
        if (dependants.length > 0) {
          return {
            ok: false,
            error: `This account is a Master for ${dependants.length} linked account(s). Re-link or remove them before changing its type.`,
          }
        }
      }
      const hierarchy = await resolveHierarchy(input.relationship, input.masterId, input.id)
      if (!hierarchy.ok) return { ok: false, error: hierarchy.error }
      Object.assign(profile, hierarchy.fields)
    }

    const rec = await updateDynamicUserProfile(input.id, { email, profile })
    if (!rec) return { ok: false, error: "Unable to update the account." }

    await logActivity({
      action: "Administrator edited a client account",
      category: "Administration / User Management",
      user: input.adminName || "Administrator",
      details: { account: rec.profile.fullName, company: rec.profile.company, email: rec.email, result: "updated" },
    })

    return { ok: true, user: toView(rec) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Master Account management --------------------------------------------
//
// Dedicated flow for fully updating / replacing the Master Account a customer
// operates under. Re-linking repoints the customer's `dataOwnerId` (via the
// sub/joint relationship) at the new Master, so ALL of their balances, bank
// instruments and transactions resolve to the new Master — both existing and
// future — while the previous Master account is left active but simply unlinked
// from this customer (it disappears from the customer's active view because
// their data no longer resolves to it). Every change is written to the audit
// trail with the OLD vs NEW master details, the acting administrator and time.

export interface MasterRef {
  id: string
  name: string
  email: string
}

export interface ChangeMasterInput {
  passcode: string
  userId: string
  /**
   *  - "existing": link the customer under an existing Master (newMasterId).
   *  - "new": create a brand-new Master account inline, then link under it.
   *  - "detach": make the customer its own standalone Master (unlink).
   */
  mode: "existing" | "new" | "detach"
  /** How the customer relates to the new Master. Only "sub" | "joint" share the
   *  Master's balance/instruments; anything else is coerced to "sub". Ignored
   *  for "detach". */
  linkType?: AccountRelationship
  /** Required for mode "existing". */
  newMasterId?: string
  /** Required for mode "new" — minimal identity for the account to create,
   *  plus optional banking rows (IBAN / SWIFT / bank name) stamped onto the new
   *  Master's profile. */
  newMaster?: {
    fullName?: string
    company?: string
    email?: string
    accountBadge?: string
    bankingExtra?: SerializableProfileItem[]
  }
  adminName?: string
}

export type MasterChangeResult =
  | {
      ok: true
      user: AdminUserView
      previousMaster: MasterRef | null
      newMaster: MasterRef | null
      /** Present only when a brand-new Master account was created inline. */
      createdMasterCredentials?: { email: string; password: string }
    }
  | { ok: false; error: string }

/** Coerce a requested link type to one that actually shares the Master's
 *  financial pool. The whole point of a Master change is balance/instrument
 *  continuity, so we only allow the two relationships that share them. */
function coerceLinkType(rel: AccountRelationship | undefined): "sub" | "joint" {
  return effectiveRelationship(rel) === "joint" ? "joint" : "sub"
}

export async function changeMasterAccount(input: ChangeMasterInput): Promise<MasterChangeResult> {
  try {
    await requireAdmin(input.passcode)

    const existing = await getDynamicUserById(input.userId)
    if (!existing) return { ok: false, error: "The selected customer account was not found." }

    // Capture the CURRENT (previous) master linkage for the audit trail before
    // anything changes. A standalone master has no previous master link.
    const prevRel = effectiveRelationship(existing.profile.relationship)
    const previousMaster: MasterRef | null =
      prevRel !== "master" && existing.profile.masterId
        ? {
            id: existing.profile.masterId,
            name: existing.profile.masterName || "—",
            email: existing.profile.masterEmail || "—",
          }
        : null

    // Detaching (making the account its own standalone Master) is only a
    // re-placement; guarded below like every other transition.
    const targetLinkType = coerceLinkType(input.linkType)

    // Guard: if this customer is itself a Master that still has dependants,
    // turning it into a sub/joint would orphan those linked accounts.
    if (input.mode !== "detach" && prevRel === "master") {
      const dependants = (await listDynamicUsers()).filter((u) => u.profile.masterId === input.userId)
      if (dependants.length > 0) {
        return {
          ok: false,
          error: `This account is itself a Master for ${dependants.length} linked account(s). Re-link or remove them before placing it under another Master.`,
        }
      }
    }

    let createdMasterCredentials: { email: string; password: string } | undefined
    let resolvedMasterId: string | undefined
    let nextRelationship: AccountRelationship
    let masterName: string | undefined
    let masterEmail: string | undefined

    if (input.mode === "detach") {
      nextRelationship = "master"
    } else if (input.mode === "new") {
      const fullName = input.newMaster?.fullName?.trim() || ""
      const company = input.newMaster?.company?.trim() || ""
      if (!fullName && !company) {
        return { ok: false, error: "Enter a name or company for the new Master account." }
      }
      // Create the new Master as a standalone account, then link under it.
      const created = await createUser({
        passcode: input.passcode,
        fullName,
        company,
        email: input.newMaster?.email?.trim() || undefined,
        accountBadge: input.newMaster?.accountBadge?.trim() || undefined,
        // Banking coordinates (IBAN / SWIFT / bank name) captured on the form.
        bankingExtra: input.newMaster?.bankingExtra?.length ? input.newMaster.bankingExtra : undefined,
        relationship: "master",
        adminName: input.adminName,
      })
      if (!created.ok) return { ok: false, error: created.error }
      resolvedMasterId = created.user.id
      nextRelationship = targetLinkType
      createdMasterCredentials = { email: created.user.email, password: created.tempPassword ?? created.user.password }
    } else {
      if (!input.newMasterId) return { ok: false, error: "Select a Master account to link the customer under." }
      resolvedMasterId = input.newMasterId
      nextRelationship = targetLinkType
    }

    // Validate the placement (master must be top-level, no self-link) and
    // resolve the denormalised master fields to stamp onto the profile.
    const hierarchy = await resolveHierarchy(nextRelationship, resolvedMasterId, input.userId)
    if (!hierarchy.ok) return { ok: false, error: hierarchy.error }

    const profile = { ...existing.profile, ...hierarchy.fields }
    masterName = hierarchy.fields.masterName
    masterEmail = hierarchy.fields.masterEmail

    const rec = await updateDynamicUserProfile(input.userId, { profile })
    if (!rec) return { ok: false, error: "Unable to update the customer's Master Account. Please try again." }

    const newMaster: MasterRef | null =
      effectiveRelationship(rec.profile.relationship) !== "master" && rec.profile.masterId
        ? { id: rec.profile.masterId, name: masterName || "—", email: masterEmail || "—" }
        : null

    // Full audit trail: who, when (logActivity stamps the time), old vs new.
    const describe = (m: MasterRef | null) => (m ? `${m.name} <${m.email}> (${m.id})` : "Standalone (own Master)")
    await logActivity({
      action: "Administrator changed a customer's Master Account",
      category: "Administration / Master Account",
      user: input.adminName || "Administrator",
      details: {
        summary: `Master Account for ${rec.profile.fullName} (${rec.profile.company}) changed from “${describe(
          previousMaster,
        )}” to “${describe(newMaster)}”${input.mode === "new" ? " (new Master account created)" : ""}.`,
        account: `${rec.profile.fullName} — ${rec.email}`,
        previousMaster: describe(previousMaster),
        newMaster: describe(newMaster),
        linkType: input.mode === "detach" ? "detached (standalone)" : nextRelationship,
        mode: input.mode,
        result: "master account changed",
      },
    })

    return { ok: true, user: toView(rec), previousMaster, newMaster, createdMasterCredentials }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Master bank-account details: EDIT IN PLACE ----------------------------
//
// Pick a client and edit HIS master account's bank details in place — login
// email + IBAN / SWIFT / bank name / account currency. No new account is
// created and no re-linking happens. For an account linked under a Master (a
// sub/joint), the details of the resolved MASTER are shown and edited, because
// that is the bank account the customer actually operates under.

export interface MasterBankProfile {
  /** The account the admin selected. */
  selectedId: string
  selectedName: string
  /** The resolved master account whose details are shown/edited. */
  masterId: string
  masterName: string
  masterCompany: string
  masterEmail: string
  /** True when the selected account IS its own master. */
  isSelf: boolean
  relationship: AccountRelationship
  bankName?: string
  iban?: string
  swift?: string
  accountCurrency?: string
}

/** Resolve the master account record for a given account id: the account itself
 *  when it is a standalone Master, otherwise the account referenced by
 *  `masterId`. Falls back to the account itself if the link is dangling. */
async function resolveMasterRecord(userId: string): Promise<{ selected: DynamicUserRecord; master: DynamicUserRecord } | null> {
  const selected = await getDynamicUserById(userId)
  if (!selected) return null
  const rel = effectiveRelationship(selected.profile.relationship)
  const masterId = rel !== "master" && selected.profile.masterId ? selected.profile.masterId : userId
  if (masterId === userId) return { selected, master: selected }
  const master = (await getDynamicUserById(masterId)) ?? selected
  return { selected, master }
}

export type MasterBankProfileResult =
  | { ok: true; profile: MasterBankProfile }
  | { ok: false; error: string }

/** Admin: load the resolved master account's current bank details for editing. */
export async function getMasterBankProfileAdmin(passcode: string, userId: string): Promise<MasterBankProfileResult> {
  try {
    await requireAdmin(passcode)
    const resolved = await resolveMasterRecord(userId)
    if (!resolved) return { ok: false, error: "The selected customer account was not found." }
    const { selected, master } = resolved
    const coords = extractBankingCoordinates(master.profile.banking)
    return {
      ok: true,
      profile: {
        selectedId: selected.id,
        selectedName: selected.profile.fullName || selected.email,
        masterId: master.id,
        masterName: master.profile.fullName || "—",
        masterCompany: master.profile.company || "",
        masterEmail: master.email,
        isSelf: master.id === selected.id,
        relationship: effectiveRelationship(selected.profile.relationship),
        ...coords,
      },
    }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/** Upsert a labelled banking row in place: replace the matched row's value,
 *  append a canonical row when none exists, or drop it when cleared. */
function upsertBankingRow(
  rows: SerializableProfileItem[],
  match: (label: string) => boolean,
  canonicalLabel: string,
  value: string,
): void {
  const idx = rows.findIndex((r) => match(r.label.toLowerCase()))
  const v = value.trim()
  if (v) {
    if (idx >= 0) rows[idx] = { ...rows[idx], value: v }
    else rows.push({ label: canonicalLabel, value: v })
  } else if (idx >= 0) {
    rows.splice(idx, 1)
  }
}

export interface UpdateMasterBankInput {
  passcode: string
  userId: string
  email?: string
  bankName?: string
  iban?: string
  swift?: string
  accountCurrency?: string
  adminName?: string
}

/** Admin: save edited bank details back onto the resolved master account. */
export async function updateMasterBankProfileAdmin(input: UpdateMasterBankInput): Promise<MasterBankProfileResult> {
  try {
    await requireAdmin(input.passcode)
    const resolved = await resolveMasterRecord(input.userId)
    if (!resolved) return { ok: false, error: "The selected customer account was not found." }
    const { master } = resolved

    const before = extractBankingCoordinates(master.profile.banking)
    const rows: SerializableProfileItem[] = [...(master.profile.banking ?? [])]

    // Validate + normalise IBAN.
    if (input.iban !== undefined) {
      const raw = input.iban.trim()
      if (raw) {
        const c = validateIban(raw)
        if (!c.valid) return { ok: false, error: `IBAN is not valid: ${c.error}` }
        upsertBankingRow(rows, (l) => l.includes("iban"), "IBAN", c.formatted)
      } else {
        upsertBankingRow(rows, (l) => l.includes("iban"), "IBAN", "")
      }
    }

    // Validate + normalise SWIFT / BIC.
    if (input.swift !== undefined) {
      const raw = input.swift.trim()
      if (raw) {
        const c = validateBic(raw)
        if (!c.valid) return { ok: false, error: `SWIFT / BIC is not valid: ${c.error}` }
        upsertBankingRow(rows, (l) => l.includes("swift") || l.includes("bic"), "SWIFT / BIC", c.normalized)
      } else {
        upsertBankingRow(rows, (l) => l.includes("swift") || l.includes("bic"), "SWIFT / BIC", "")
      }
    }

    if (input.bankName !== undefined) {
      upsertBankingRow(
        rows,
        (l) => l.includes("bank") && !l.includes("iban") && !l.includes("swift") && !l.includes("bic"),
        "Bank",
        input.bankName,
      )
    }

    if (input.accountCurrency !== undefined) {
      upsertBankingRow(rows, (l) => l.includes("currency"), "Account Currency", input.accountCurrency.toUpperCase())
    }

    // Integrity guard: the IBAN and SWIFT/BIC must belong to the SAME country.
    // A German IBAN can never be serviced by a Swiss BIC (and vice versa), so a
    // cross-country pair is a corrupt record — reject it authoritatively rather
    // than persist an impossible bank account.
    const finalIban = rows.find((r) => r.label.toLowerCase().includes("iban"))?.value
    const finalSwift = rows.find((r) => {
      const l = r.label.toLowerCase()
      return l.includes("swift") || l.includes("bic")
    })?.value
    if (finalIban && finalSwift) {
      const ic = validateIban(finalIban)
      const bc = validateBic(finalSwift)
      if (ic.valid && bc.valid && ic.countryCode !== bc.countryCode) {
        return {
          ok: false,
          error: `The IBAN country (${ic.countryCode}) and the SWIFT/BIC country (${bc.countryCode}) don't match. A ${ic.countryCode} IBAN cannot be held at a ${bc.countryCode} bank — correct one of them before saving.`,
        }
      }
    }

    // Optional login-email change — guarded against collisions with any OTHER account.
    let nextEmail = master.email
    if (input.email !== undefined) {
      const raw = input.email.trim().toLowerCase()
      if (raw && raw !== master.email.toLowerCase()) {
        const clash = await getDynamicUserByEmail(raw)
        if (clash && clash.id !== master.id) {
          return { ok: false, error: "That login email is already used by another account." }
        }
        nextEmail = raw
      }
    }

    const nextProfile: SerializableUserProfile = { ...master.profile, banking: rows }
    const rec = await updateDynamicUserProfile(master.id, { email: nextEmail, profile: nextProfile })
    if (!rec) return { ok: false, error: "Unable to save the bank details. Please try again." }

    const after = extractBankingCoordinates(rec.profile.banking)
    const changed: string[] = []
    if (before.iban !== after.iban) changed.push(`IBAN: “${before.iban ?? "—"}” → “${after.iban ?? "—"}”`)
    if (before.swift !== after.swift) changed.push(`SWIFT/BIC: “${before.swift ?? "—"}” → “${after.swift ?? "—"}”`)
    if (before.bankName !== after.bankName) changed.push(`Bank: “${before.bankName ?? "—"}” → “${after.bankName ?? "—"}”`)
    if (before.accountCurrency !== after.accountCurrency)
      changed.push(`Currency: “${before.accountCurrency ?? "—"}” → “${after.accountCurrency ?? "—"}”`)
    if (nextEmail !== master.email) changed.push(`Login email: “${master.email}” → “${nextEmail}”`)

    await logActivity({
      action: "Administrator updated a master account's bank details",
      category: "Administration / Master Account",
      user: input.adminName || "Administrator",
      details: {
        summary: `Bank details for ${rec.profile.fullName} (${rec.profile.company}) updated. ${
          changed.length ? changed.join("; ") : "No effective change."
        }`,
        account: `${rec.profile.fullName} — ${rec.email}`,
        changes: changed.join("; ") || "none",
      },
    })

    return {
      ok: true,
      profile: {
        selectedId: input.userId,
        selectedName: resolved.selected.profile.fullName || resolved.selected.email,
        masterId: rec.id,
        masterName: rec.profile.fullName || "—",
        masterCompany: rec.profile.company || "",
        masterEmail: rec.email,
        isSelf: rec.id === input.userId,
        relationship: effectiveRelationship(resolved.selected.profile.relationship),
        ...after,
      },
    }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function removeUser(passcode: string, id: string, adminName?: string): Promise<AdminUsersResult> {
  try {
    await requireAdmin(passcode)
    const existing = await getDynamicUserById(id)
    if (!existing) return { ok: false, error: "User not found." }
    await deleteDynamicUser(id)

    await logActivity({
      action: "Administrator deleted a client account",
      category: "Administration / User Management",
      user: adminName || "Administrator",
      details: { account: existing.profile.fullName, email: existing.email, result: "deleted" },
    })

    const users = (await listDynamicUsers()).map(toView)
    return { ok: true, users }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Self-service (no passcode) -------------------------------------------

/**
 * Returns the *current* signed-in user's serialized profile when they are a
 * dynamic (admin-created) account, so the client can hydrate and display the
 * correct identity. Returns null for static users (the client already has their
 * profile in lib/users.ts) or when there is no valid dynamic session.
 *
 * This is intentionally NOT passcode-gated: it only ever returns the caller's
 * OWN profile, resolved from their httpOnly session cookie.
 */
export async function getMyProfile(): Promise<SerializableUserProfile | null> {
  try {
    const { resolveCurrentSession } = await import("@/lib/session-user")
    const session = await resolveCurrentSession()
    if (!session || session.kind !== "dynamic") return null
    const rec = await getDynamicUserById(session.id)
    if (!rec) return null
    // Guarantee the client only ever sees a real account tier (PRO / Avant-garde),
    // even for accounts created before the tier was restricted.
    return { ...rec.profile, accountBadge: normalizeAccountBadge(rec.profile.accountBadge) }
  } catch {
    return null
  }
}

/**
 * The authoritative identity of whoever is signed in on THIS request, resolved
 * strictly from the httpOnly session cookie (never the client-readable
 * `mcc_user` cookie, which can be stale/missing/spoofed).
 *
 *  - Static account → `{ kind: "static", id }`. The client already has the full
 *    profile in lib/users.ts and looks it up by this id (which is guaranteed to
 *    exist in the static registry).
 *  - Dynamic (admin-created) account → `{ kind: "dynamic", id, profile }` with
 *    the serialized profile for the client to hydrate.
 *  - No valid session → `null`.
 *
 * This is the single source of truth the client uses to decide who it is, so a
 * wrong/absent `mcc_user` cookie can never cause one user to be shown — or to
 * act — as another account. Not passcode-gated: it only returns the caller's
 * OWN identity.
 */
export type MyIdentity =
  | { kind: "static"; id: string; impersonator?: { id: string; name: string }; isAdmin: boolean }
  | {
      kind: "dynamic"
      id: string
      profile: SerializableUserProfile
      impersonator?: { id: string; name: string }
      isAdmin: boolean
    }

export async function getMyIdentity(): Promise<MyIdentity | null> {
  try {
    const { resolveCurrentSession } = await import("@/lib/session-user")
    const session = await resolveCurrentSession()
    if (!session) return null
    // Authoritative admin flag, resolved server-side from the acting account's
    // email against the allowlist (impersonation-aware). The UI uses this only
    // to decide whether to SHOW admin navigation — every admin route/action is
    // still independently gated on the server, so hiding the link is a UX
    // nicety, not the security boundary.
    const { isCurrentSessionAdmin } = await import("@/lib/admin-auth")
    const isAdmin = await isCurrentSessionAdmin()
    if (session.kind === "static") {
      return { kind: "static", id: session.id, impersonator: session.impersonator, isAdmin }
    }
    const rec = await getDynamicUserById(session.id)
    if (!rec) return null
    // Coerce the stored badge so legacy/blank tiers resolve to PRO / Avant-garde.
    const profile = { ...rec.profile, accountBadge: normalizeAccountBadge(rec.profile.accountBadge) }
    return { kind: "dynamic", id: session.id, profile, impersonator: session.impersonator, isAdmin }
  } catch {
    return null
  }
}

// --- Shared client picker --------------------------------------------------

export interface SelectableClient {
  id: string
  fullName: string
  company: string
  email: string
  kind: "static" | "dynamic"
}

/**
 * Returns every account an administrator can act on (manage balances,
 * beneficiaries, etc.): all *active* accounts in the database, including the
 * three seeded core accounts. Passcode-gated. Used by admin pickers so every
 * client is first-class throughout the control panel — not just in User
 * Management.
 */
export async function listSelectableClients(passcode: string): Promise<SelectableClient[]> {
  try {
    await requireAdmin(passcode)
    return (await listDynamicUsers())
      .filter((u) => u.status === "active")
      .map((u) => ({
        id: u.id,
        fullName: u.profile.fullName,
        company: u.profile.company,
        email: u.email,
        kind: "dynamic" as const,
      }))
  } catch {
    // DB unavailable or unauthorized — return an empty list rather than exposing
    // any account.
    return []
  }
}

/**
 * Master candidates for the admin's relationship picker: every active account
 * that is itself a top-level Master (so the hierarchy stays two levels deep).
 * Passcode-gated. `excludeId` omits the account currently being edited.
 */
export async function listMasterCandidates(passcode: string, excludeId?: string): Promise<SelectableClient[]> {
  try {
    await requireAdmin(passcode)
    return (await listDynamicUsers())
      .filter(
        (u) =>
          u.status === "active" &&
          u.id !== excludeId &&
          effectiveRelationship(u.profile.relationship) === "master",
      )
      .map((u) => ({
        id: u.id,
        fullName: u.profile.fullName,
        company: u.profile.company,
        email: u.email,
        kind: "dynamic" as const,
      }))
  } catch {
    return []
  }
}

/** A linked account in a Master's network, as shown in "My Network". */
export interface NetworkMember {
  id: string
  fullName: string
  company: string
  email: string
  relationship: AccountRelationship
  accountBadge: string
  status: UserStatus
  createdAt: string
}

/**
 * The signed-in Master's network: every sub/child account linked under them.
 * Resolved from the current session (no passcode — this is a client-facing
 * view), so a client only ever sees their OWN dependants.
 */
export async function getMyNetwork(): Promise<NetworkMember[]> {
  const { resolveCurrentSession } = await import("@/lib/session-user")
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    return (await listDynamicUsers())
      .filter((u) => u.profile.masterId === session.id)
      .map((u) => ({
        id: u.id,
        fullName: u.profile.fullName,
        company: u.profile.company,
        email: u.email,
        relationship: effectiveRelationship(u.profile.relationship),
        accountBadge: normalizeAccountBadge(u.profile.accountBadge),
        status: u.status,
        createdAt: u.createdAt,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
  } catch (err) {
    console.log("[v0] getMyNetwork failed:", (err as Error).message)
    return []
  }
}

/** Lightweight hierarchy summary for the signed-in account (for dashboards). */
export interface MyHierarchyInfo {
  relationship: AccountRelationship
  masterId?: string
  masterName?: string
  masterEmail?: string
  networkCount: number
}

/** Returns the signed-in account's hierarchy position + dependant count. */
export async function getMyHierarchyInfo(): Promise<MyHierarchyInfo | null> {
  const { resolveCurrentSession } = await import("@/lib/session-user")
  const session = await resolveCurrentSession()
  if (!session) return null
  const relationship = session.relationship
  let networkCount = 0
  if (relationship === "master") {
    try {
      networkCount = (await listDynamicUsers()).filter((u) => u.profile.masterId === session.id).length
    } catch {
      networkCount = 0
    }
  }
  return {
    relationship,
    masterId: session.masterId,
    masterName: session.profile.masterName,
    masterEmail: session.profile.masterEmail,
    networkCount,
  }
}
