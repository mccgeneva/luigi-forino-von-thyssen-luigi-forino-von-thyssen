"use server"

import {
  listCertificateRequestsForUser,
  listPendingCertificateRequests,
  getCertificateRequest,
  upsertCertificateRequest,
  replaceCertificateRequestsForUser,
  deleteCertificateRequestForUser,
} from "@/lib/certificates-db"
import {
  applyApproval,
  applyRejection,
  applyReissue,
  CERTIFICATE_TYPE_LABELS,
  type CertificateRequest,
} from "@/lib/certificates-shared"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { logActivity } from "@/app/actions/log-activity"
import { resolveCurrentSession, resolveAccountProfileById } from "@/lib/session-user"
// Certificates are part of the shared ENVIRONMENT: a Joint (J) account operates
// on its Master's certificates. `environmentOwnerId` equals the account's own
// id for every non-joint account, so this is a no-op for Master/Sub/Child.

async function requireAdmin(passcode: string): Promise<void> {
  if (!(await adminActionAuthorized(passcode))) {
    throw new Error("Administrator authorization failed.")
  }
}

/** Replace raw DB/connection failures with a clear, actionable message. */
function friendlyError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|database|connect|pool|password authentication/i.test(msg)) {
    return "Could not reach the database. Please confirm the Neon database is connected (DATABASE_URL) and try again."
  }
  return msg
}

export type CertificateListResult =
  | { ok: true; requests: CertificateRequest[] }
  | { ok: false; error: string }

export type CertificateRecordList =
  | { ok: true; requests: { id: string; userId: string; request: CertificateRequest }[] }
  | { ok: false; error: string }

export type CertificateMutation =
  | { ok: true; request?: CertificateRequest }
  | { ok: false; error: string }

// --- Self-service (current signed-in user) ---------------------------------

/**
 * Returns the current user's certificate requests from the server. Used by the
 * client store to hydrate from the durable source of truth. Returns an empty
 * list (not an error) when there is no session or the DB is unavailable, so the
 * client can gracefully fall back to its local cache.
 */
export async function getMyCertificateRequests(): Promise<CertificateListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: true, requests: [] }
    const rows = await listCertificateRequestsForUser(session.environmentOwnerId)
    return { ok: true, requests: rows.map((r) => r.request) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Mirrors the current user's full certificate-request set to the server. Called
 * by the client store after local changes so the durable copy stays in sync and
 * administrators always see the latest requests. The server merge protects any
 * compliance decision already recorded.
 */
export async function syncMyCertificateRequests(
  items: { id: string; data: Record<string, unknown>; status: string }[],
): Promise<CertificateMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "No active session." }
    await replaceCertificateRequestsForUser(session.environmentOwnerId, items)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Permanently delete one of the CURRENT user's own certificate requests (e.g.
 * one that is no longer needed or has expired). Ownership is enforced in the DB
 * query (id + session user id) so a client can never remove another account's
 * records. Writes an audit-log entry for traceability.
 */
export async function deleteMyCertificateRequest(id: string): Promise<CertificateMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "No active session." }

    // Load first (scoped read) so we can record what was removed in the audit
    // log. Ownership is checked against the ENVIRONMENT owner so a Joint account
    // may delete its Master's certificates (and vice-versa), but no unrelated
    // account can.
    const row = await getCertificateRequest(id)
    if (!row || row.userId !== session.environmentOwnerId) {
      return { ok: false, error: "Certificate not found." }
    }

    const removed = await deleteCertificateRequestForUser(session.environmentOwnerId, id)
    if (!removed) return { ok: false, error: "Certificate not found." }

    await logActivity({
      action: "Client deleted a certificate",
      category: "Certificates",
      details: {
        certificate: CERTIFICATE_TYPE_LABELS[row.request.type],
        reference: row.request.reference,
        status: row.request.status,
        result: "deleted",
      },
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Admin management (on behalf of any user) ------------------------------

export async function adminListCertificateRequests(
  passcode: string,
  userId: string,
): Promise<CertificateListResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listCertificateRequestsForUser(userId)
    return { ok: true, requests: rows.map((r) => r.request) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * List every pending certificate request across all clients. Powers an
 * administrator overview of work awaiting a decision. Returns an empty list
 * (not an error) when the DB is unavailable so the panel still loads.
 */
export async function adminListPendingCertificates(passcode: string): Promise<CertificateRecordList> {
  try {
    await requireAdmin(passcode)
    const rows = await listPendingCertificateRequests()
    return { ok: true, requests: rows.map((r) => ({ id: r.id, userId: r.userId, request: r.request })) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

async function decideAndLog(
  id: string,
  transform: (req: CertificateRequest) => CertificateRequest,
  action: string,
  adminName: string | undefined,
  resultLabel: string,
): Promise<CertificateMutation> {
  const row = await getCertificateRequest(id)
  if (!row) return { ok: false, error: "Certificate request not found." }
  const updated = transform(row.request)
  await upsertCertificateRequest(row.userId, updated)

  const owner = await resolveAccountProfileById(row.userId)
  await logActivity({
    action,
    category: "Administration / Certificates",
    user: adminName || "Administrator",
    details: {
      certificate: CERTIFICATE_TYPE_LABELS[updated.type],
      reference: updated.reference,
      targetAccount: `${owner.fullName} — ${owner.email}`,
      result: resultLabel,
    },
  })
  return { ok: true, request: updated }
}

/** Approve & issue or decline a pending certificate request. */
export async function adminDecideCertificate(
  passcode: string,
  id: string,
  mode: "approve" | "reject",
  note?: string,
  adminName?: string,
): Promise<CertificateMutation> {
  try {
    await requireAdmin(passcode)
    return await decideAndLog(
      id,
      (req) => (mode === "approve" ? applyApproval(req, note) : applyRejection(req, note)),
      `Administrator ${mode === "approve" ? "approved & issued" : "declined"} a certificate`,
      adminName,
      mode === "approve" ? "approved" : "declined",
    )
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/** Re-issue an already-approved certificate, bumping its revision. */
export async function adminReissueCertificate(
  passcode: string,
  id: string,
  note?: string,
  adminName?: string,
): Promise<CertificateMutation> {
  try {
    await requireAdmin(passcode)
    return await decideAndLog(
      id,
      (req) => applyReissue(req, note),
      "Administrator re-issued a certificate",
      adminName,
      "re-issued",
    )
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}
