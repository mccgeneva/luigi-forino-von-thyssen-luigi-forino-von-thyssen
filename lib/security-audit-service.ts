// ---------------------------------------------------------------------------
// Security Audit — core read logic (framework-agnostic).
//
// This module holds the actual data-gathering for the admin Security Audit
// panel so it can be shared by BOTH a Route Handler (app/api/admin/audit/*)
// and the legacy Server Action wrappers. The Route Handler is the path the UI
// actually uses, because Next.js validates Server Action requests against the
// forwarded Origin/Host and on this app's production domains (apex -> www
// redirect, custom domains, in-app webviews) that check can SILENTLY reject the
// call — which is why the panel showed "Could not load the audit overview".
// Route Handlers are exempt from that check.
// ---------------------------------------------------------------------------

import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { geolocateIp, type IpGeo } from "@/lib/ip-geo"
import { getIdentityStatus, getLastLoginSelfie, getAdminIdentityDetails, type IdentityStatus } from "@/lib/biometric-db"
import { listDynamicUsers, getDynamicUserById } from "@/lib/admin-users-db"
import { listKycDocuments } from "@/lib/kyc-documents-db"
import { blobFileUrl, type UploadedKycDocument, type KycDocument, type KycDocumentType } from "@/lib/kyc-types"
import {
  listAuditActors,
  listAuditEvents,
  listUserDevices,
  getActorStats,
  type AuditActor,
  type AuditEvent,
  type DeviceRow,
  type ActorStats,
} from "@/lib/security-audit-db"

// These proxy URLs are consumed by the admin Security Audit panel, which is
// authenticated by the shared admin passcode rather than a user session. We
// append `p=<passcode>` so the images load even when there is no user-session
// cookie (or it isn't carried into a new tab / mobile in-app webview). The
// routes accept either a valid session OR a matching passcode.
const adminPasscodeParam = `&p=${encodeURIComponent(ADMIN_PASSCODE)}`

/** Turn a stored selfie pathname into an app-relative, admin-authorized proxy URL. */
function selfieUrl(pathname: string | null): string | null {
  if (!pathname) return null
  return `/api/login-selfie?pathname=${encodeURIComponent(pathname)}${adminPasscodeParam}`
}

/** Turn a retained passport-image pathname into an admin-authorized proxy URL. */
function passportUrl(pathname: string | null): string | null {
  if (!pathname) return null
  return `/api/passport-image?pathname=${encodeURIComponent(pathname)}${adminPasscodeParam}`
}

/**
 * Stable id for a profile (onboarding-PDF) KYC document, derived from its Blob
 * pathname. Shared by the report and the analysis route so per-document AI
 * analysis can be matched back to the right document in the dossier.
 */
export function profileDocId(pathname: string): string {
  return `profile:${pathname}`
}

/**
 * A KYC document extracted from the client's onboarding PDF and stored on their
 * PROFILE (e.g. company registration / extract certificate, proof of address).
 * This is a DIFFERENT store from the admin-uploaded `kyc_documents` table, and
 * was previously absent from the dossier. `url` is the admin-authorized proxy.
 */
export interface ProfileKycDocView {
  id: string
  pathname: string
  url: string
  type: KycDocumentType
  label: string
  pageNumber: number
  isImage: boolean
}

/** Build the profile-document views (incl. the original onboarding PDF) for a user. */
async function buildProfileDocuments(
  userId: string,
): Promise<{ documents: ProfileKycDocView[]; pdfUrl: string | null }> {
  const user = await getDynamicUserById(userId).catch(() => undefined)
  const profile = user?.profile
  if (!profile) return { documents: [], pdfUrl: null }
  const docs = (profile.kycDocuments ?? []) as KycDocument[]
  const documents: ProfileKycDocView[] = docs
    .filter((d) => !!d.pathname)
    .map((d) => ({
      id: profileDocId(d.pathname),
      pathname: d.pathname,
      url: blobFileUrl(d.pathname, ADMIN_PASSCODE),
      type: d.type,
      label: d.label || d.type,
      pageNumber: d.pageNumber || 0,
      // Onboarding-PDF documents are stored as rendered page images.
      isImage: true,
    }))
  const pdfUrl = profile.kycPdfPathname ? blobFileUrl(profile.kycPdfPathname, ADMIN_PASSCODE) : null
  return { documents, pdfUrl }
}

export interface AuditActorView extends Omit<AuditActor, "lastSelfieUrl"> {
  lastSelfieUrl: string | null
}

export interface AuditOverview {
  /** Accounts that already have recorded activity, most-recent first. */
  actors: AuditActorView[]
  /** Every known account (for search / picking clients with no events yet). */
  accounts: { userId: string; label: string; company: string; email: string }[]
  /** True the moment the store is still empty (nothing has happened yet). */
  empty: boolean
}

export interface UserAuditReport {
  userId: string
  account: string
  stats: ActorStats
  identity: IdentityStatus
  /** ADMIN-ONLY: full (unmasked) passport number, when one was retained. */
  passportNo: string | null
  /** ADMIN-ONLY: session-gated proxy URL for the retained passport image. */
  passportImageUrl: string | null
  selfie: { url: string | null; at: string | null }
  devices: DeviceRow[]
  /** Geolocated distinct IPs (best-effort, capped). */
  locations: IpGeo[]
  events: AuditEvent[]
  /** Admin-uploaded KYC documents (passport, ID, face, company reg, bills, …). */
  documents: UploadedKycDocument[]
  /** Onboarding-PDF documents stored on the client PROFILE (company extract,
   *  proof of address, …). Separate store from `documents`. */
  profileDocuments: ProfileKycDocView[]
  /** Admin-authorized proxy URL for the original onboarding KYC PDF, if any. */
  profileKycPdfUrl: string | null
}

/** Overview for the picker: active actors + the full account directory. */
export async function buildAuditOverview(): Promise<AuditOverview> {
  const [actors, users] = await Promise.all([listAuditActors(), listDynamicUsers()])
  const accounts = users.map((u) => ({
    userId: u.id,
    label: u.profile.fullName || u.profile.company || u.email,
    company: u.profile.company || "",
    email: u.email,
  }))
  return {
    actors: actors.map((a) => ({ ...a, lastSelfieUrl: selfieUrl(a.lastSelfieUrl) })),
    accounts,
    empty: actors.length === 0,
  }
}

/** Full audit report for one account. */
export async function buildUserAudit(userId: string, opts?: { category?: string }): Promise<UserAuditReport> {
  const [stats, identity, adminIdentity, selfie, devices, events, documents, profile] = await Promise.all([
    getActorStats(userId),
    getIdentityStatus(userId),
    getAdminIdentityDetails(userId),
    getLastLoginSelfie(userId),
    listUserDevices(userId),
    listAuditEvents({ userId, category: opts?.category, limit: 300 }),
    listKycDocuments(userId).catch(() => [] as UploadedKycDocument[]),
    buildProfileDocuments(userId),
  ])

  // Geolocate the most-recent distinct public IPs (cap the fan-out so a slow
  // geo service can't stall the report).
  const seen = new Set<string>()
  const ips: string[] = []
  for (const d of devices) {
    const ip = d.ipAddress?.split(",")[0]?.trim()
    if (ip && !seen.has(ip)) {
      seen.add(ip)
      ips.push(ip)
    }
    if (ips.length >= 8) break
  }
  const located = await Promise.all(ips.map((ip) => geolocateIp(ip)))
  const locations = located.filter((l): l is IpGeo => !!l)

  // Resolve the account label from stored data when the event trail lacks it.
  const account =
    events.find((e) => e.account)?.account || (identity.fullName ? `${identity.fullName}` : "") || userId

  return {
    userId,
    account,
    stats,
    identity,
    passportNo: adminIdentity.passportNo,
    passportImageUrl: passportUrl(adminIdentity.passportImagePath),
    selfie: { url: selfieUrl(selfie?.url ?? null), at: selfie?.at ?? null },
    devices,
    locations,
    events,
    documents,
    profileDocuments: profile.documents,
    profileKycPdfUrl: profile.pdfUrl,
  }
}
