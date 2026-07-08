"use server"

import {
  listSkrRecordsForUser,
  replaceSkrRecordsForUser,
  listSkrRequestsForUser,
  replaceSkrRequestsForUser,
  mergeSkrRequestsForUser,
  appendSkrDocumentForUser,
  listAllSkrRecords,
  listAllSkrRequests,
  type SkrItemInput,
} from "@/lib/skr-db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"
import { listSelectableClients } from "@/app/actions/admin-users"

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

export type SkrRow = {
  id: string
  data: Record<string, unknown>
  status: string
}

export type SkrListResult = { ok: true; items: SkrRow[] } | { ok: false; error: string }
export type SkrMutation = { ok: true } | { ok: false; error: string }

function toRows(rows: { id: string; data: Record<string, unknown>; status: string }[]): SkrRow[] {
  return rows.map((r) => ({ id: r.id, data: r.data, status: r.status }))
}

// --- Self-service (current signed-in client) -------------------------------

/**
 * Returns the current client's SKR records from the server (read-only). Used by
 * the client store to hydrate from the durable source of truth. Returns an empty
 * list (not an error) when there is no session or the DB is unavailable, so the
 * client can gracefully fall back to its local cache.
 */
export async function getMySkrRecords(): Promise<SkrListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: true, items: [] }
    const rows = await listSkrRecordsForUser(session.id)
    return { ok: true, items: toRows(rows) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/** Returns the current client's own SKR requests. */
export async function getMySkrRequests(): Promise<SkrListResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: true, items: [] }
    const rows = await listSkrRequestsForUser(session.id)
    return { ok: true, items: toRows(rows) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Mirrors the current client's requests to the server. Non-destructive: it only
 * inserts brand-new requests and never overwrites the administrator's decisions
 * on existing ones (see mergeSkrRequestsForUser).
 */
export async function syncMySkrRequests(items: SkrItemInput[]): Promise<SkrMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "No active session." }
    await mergeSkrRequestsForUser(session.id, items)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Attach a supporting document the current client uploaded (to Blob) to one of
 * their own SKR records. Ownership is enforced server-side by the session id.
 */
export async function addMySkrDocument(
  recordId: string,
  doc: Record<string, unknown>,
): Promise<SkrMutation> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "No active session." }
    const updated = await appendSkrDocumentForUser(session.id, recordId, doc)
    if (!updated) return { ok: false, error: "Receipt not found." }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Admin management (custody desk, on behalf of any client) --------------

export async function adminListSkrRecords(passcode: string, userId: string): Promise<SkrListResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listSkrRecordsForUser(userId)
    return { ok: true, items: toRows(rows) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminReplaceSkrRecords(
  passcode: string,
  userId: string,
  items: SkrItemInput[],
): Promise<SkrMutation> {
  try {
    await requireAdmin(passcode)
    await replaceSkrRecordsForUser(userId, items)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminListSkrRequests(passcode: string, userId: string): Promise<SkrListResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listSkrRequestsForUser(userId)
    return { ok: true, items: toRows(rows) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

export async function adminReplaceSkrRequests(
  passcode: string,
  userId: string,
  items: SkrItemInput[],
): Promise<SkrMutation> {
  try {
    await requireAdmin(passcode)
    await replaceSkrRequestsForUser(userId, items)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

// --- Cross-client overview (custody desk dashboard) ------------------------

export type SkrOverviewRow = {
  id: string
  userId: string
  /** Resolved client display name (falls back to the user id if unknown). */
  clientName: string
  clientCompany: string
  data: Record<string, unknown>
  status: string
  createdAt: string
  updatedAt: string
}

export type SkrOverviewResult =
  | { ok: true; records: SkrOverviewRow[]; requests: SkrOverviewRow[] }
  | { ok: false; error: string }

/**
 * Aggregate every SKR record and client request across ALL clients, each tagged
 * with the owning client's name/company. Powers the administrator SKR overview.
 */
export async function adminListAllSkr(passcode: string): Promise<SkrOverviewResult> {
  try {
    await requireAdmin(passcode)
    const [records, requests, clients] = await Promise.all([
      listAllSkrRecords(),
      listAllSkrRequests(),
      listSelectableClients(passcode),
    ])
    const nameById = new Map(clients.map((c) => [c.id, c]))
    const decorate = (r: {
      id: string
      userId: string
      data: Record<string, unknown>
      status: string
      createdAt: string
      updatedAt: string
    }): SkrOverviewRow => {
      const client = nameById.get(r.userId)
      return {
        id: r.id,
        userId: r.userId,
        clientName: client?.fullName ?? "Unknown client",
        clientCompany: client?.company ?? "",
        data: r.data,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    }
    return { ok: true, records: records.map(decorate), requests: requests.map(decorate) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}
