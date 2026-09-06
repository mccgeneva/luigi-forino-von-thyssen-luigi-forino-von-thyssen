"use server"

import {
  listSkrRecordsForUser,
  replaceSkrRecordsForUser,
  listSkrRequestsForUser,
  replaceSkrRequestsForUser,
  mergeSkrRequestsForUser,
  appendSkrDocumentForUser,
  patchSkrExpertiseForUser,
  countSkrExpertiseRequests,
  listSkrExpertiseQueue,
  listAllSkrRecords,
  listAllSkrRequests,
  type SkrItemInput,
  type SkrExpertiseQueueItem,
} from "@/lib/skr-db"
import { adminActionAuthorized, adminEmails } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"
import { listSelectableClients } from "@/app/actions/admin-users"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { insertNotification } from "@/lib/notifications-db"
import { logActivity } from "@/app/actions/log-activity"
import { gatherGuaranteeProfile } from "@/lib/guarantees-profile"
import { getGuaranteeConfig } from "@/lib/guarantees-config-db"
import { listApprovalsForUser } from "@/lib/approvals-db"
import {
  skrExpertiseCost,
  SKR_EXPERTISE_KINDS,
  type SkrExpertiseKind,
} from "@/lib/skr-expertise"

function skrRef(prefix: string): string {
  return `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`
}

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
    let rows = await listSkrRecordsForUser(session.id)
    // Self-heal: if a blocked SKR's collateral instrument was later removed
    // (deleted / returned to marketplace / admin-revoked / transferred), the
    // SKR must stop showing as blocked collateral. This read is the single
    // session-scoped source behind the SKR page, so reconciling here covers
    // every removal path in one place and runs exactly where the stale badge
    // shows — no per-deletion-path hooks needed. Best-effort: never fail the read.
    try {
      const released = await releaseOrphanedSkrCollateral(session.id, rows)
      if (released) rows = await listSkrRecordsForUser(session.id)
    } catch (err) {
      console.log("[v0] SKR collateral reconcile skipped:", (err as Error).message)
    }
    return { ok: true, items: toRows(rows) }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/** Statuses that mean the client no longer holds the instrument. */
const TERMINAL_INSTRUMENT_STATUSES = new Set([
  "rejected",
  "cancelled",
  "canceled",
  "transferred",
  "reversed",
  "expired",
])

/**
 * Releases any SKR that is `blockedAsCollateral` but whose materialised
 * collateral instrument (`expertise.instrumentId` === `payload.instrument.id`)
 * no longer exists or has reached a terminal status. Returns the number of
 * records released (0 if nothing to do). Scoped to the owning `userId`.
 */
async function releaseOrphanedSkrCollateral(
  userId: string,
  rows: { id: string; data: Record<string, unknown> }[],
): Promise<number> {
  const blocked = rows.filter((r) => {
    const d = r.data as { blockedAsCollateral?: boolean; expertise?: { status?: string; instrumentId?: string } }
    return d.blockedAsCollateral === true && !!d.expertise?.instrumentId
  })
  if (blocked.length === 0) return 0

  // The instrument's own id (SKR-COLL-<recordId>) lives in payload.instrument.id
  // for an admin-issued instrument; the approval row id differs, so match by it.
  const instrumentApprovals = await listApprovalsForUser(userId, "instrument")
  const liveInstrumentIds = new Set<string>()
  for (const appr of instrumentApprovals) {
    if (TERMINAL_INSTRUMENT_STATUSES.has(String(appr.status))) continue
    const p = (appr.payload ?? {}) as { instrument?: { id?: string }; record?: { id?: string } }
    const instId = p.instrument?.id ?? p.record?.id
    if (instId) liveInstrumentIds.add(String(instId))
  }

  let releasedCount = 0
  for (const r of blocked) {
    const d = r.data as { expertise?: { instrumentId?: string; kind?: string } }
    const instrumentId = String(d.expertise?.instrumentId ?? "")
    if (instrumentId && liveInstrumentIds.has(instrumentId)) continue // still held — keep blocked
    const now = new Date().toISOString()
    await patchSkrExpertiseForUser(userId, r.id, {
      expertise: { status: "released", releasedAt: now },
      blockedAsCollateral: false,
      transaction: {
        id: skrRef("TX"),
        date: now,
        type: "Collateral Released",
        description: `The collateral bank instrument (${instrumentId || "linked instrument"}) was removed, so this SKR is no longer blocked as collateral and can be used or re-assessed.`,
        reference: r.id,
      },
    })
    releasedCount += 1
  }
  return releasedCount
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

// --- Expertise / Evaluation / Audit ----------------------------------------

type SkrRecordData = {
  faceValue?: number
  currency?: string
  custodian?: string
  beneficialOwner?: string
  status?: string
  blockedAsCollateral?: boolean
  expertise?: { status?: string; kind?: string }
}

export type SkrExpertiseResult = { ok: true } | { ok: false; error: string }
export type SkrExpertiseAssessResult =
  | { ok: true; cost: number; tradeScore: number; currency: string }
  | { ok: false; error: string }

/**
 * Customer applies for an Expertise / Evaluation / Audit of one of their own
 * SKRs. Writes a `requested` expertise onto the record (scoped to the owner) and
 * alerts the custody desk. Nothing is charged here.
 */
export async function requestSkrExpertise(
  recordId: string,
  kind: SkrExpertiseKind,
  note?: string,
): Promise<SkrExpertiseResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
    if (!SKR_EXPERTISE_KINDS.includes(kind)) return { ok: false, error: "Unknown assessment type." }

    const rows = await listSkrRecordsForUser(session.id)
    const row = rows.find((r) => r.id === recordId)
    if (!row) return { ok: false, error: "SKR record not found in your portfolio." }
    const data = row.data as SkrRecordData
    if (data.status === "cancelled") return { ok: false, error: "This SKR is cancelled and cannot be assessed." }
    if (data.blockedAsCollateral) {
      return { ok: false, error: "This SKR is already blocked as collateral and cannot be re-assessed." }
    }
    const st = data.expertise?.status
    if (st === "requested" || st === "assessed") {
      return { ok: false, error: "An assessment is already in progress for this SKR." }
    }

    const now = new Date().toISOString()
    const updated = await patchSkrExpertiseForUser(session.id, recordId, {
      expertise: {
        kind,
        status: "requested",
        requestedAt: now,
        requestNote: note?.trim() || undefined,
        // clear any prior valuation if re-applying after a decline
        assessedValue: undefined,
        cost: undefined,
        tradeScore: undefined,
        outcomeNote: undefined,
        assessedAt: undefined,
        declinedAt: undefined,
      },
      transaction: {
        id: skrRef("TX"),
        date: now,
        type: "Expertise Requested",
        description: `Client applied for an official ${kind.toLowerCase()} of the goods held under this SKR.`,
        reference: skrRef("EXP"),
      },
    })
    if (!updated) return { ok: false, error: "SKR record not found in your portfolio." }

    // Alert every administrator so the request surfaces on the custody desk.
    try {
      const clientLabel = data.beneficialOwner || "A client"
      const seen = new Set<string>()
      for (const email of adminEmails()) {
        const admin = await getDynamicUserByEmail(email)
        if (!admin || seen.has(admin.id)) continue
        seen.add(admin.id)
        await insertNotification({
          userId: admin.id,
          tone: "warning",
          title: `SKR ${kind.toLowerCase()} requested`,
          body: `${clientLabel} applied for an official ${kind.toLowerCase()} of SKR ${recordId}. Set the assessed value and return the outcome from the SKR desk.`,
          href: "/dashboard/admin?view=skr",
        }).catch(() => undefined)
      }
    } catch {
      // best-effort — a notification failure must never fail the request
    }

    await logActivity({
      action: `Applied for an SKR ${kind.toLowerCase()} on ${recordId}`,
      category: "SKR Trading",
      details: {
        summary: `Client applied for an official ${kind} of the goods held under safe keeping receipt ${recordId}.`,
        referenceId: recordId,
        requestType: kind,
        status: "Awaiting custody-desk valuation",
      },
    }).catch(() => undefined)

    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Command-center count of SKR expertise applications awaiting valuation. Kept
 * in lock-step with the request notification so the admin sees a persistent
 * signal, not just a transient bell.
 */
export async function adminCountSkrExpertiseRequests(passcode: string): Promise<number> {
  try {
    await requireAdmin(passcode)
    return await countSkrExpertiseRequests()
  } catch {
    return 0
  }
}

export type SkrExpertiseQueueResult =
  | { ok: true; items: SkrExpertiseQueueItem[] }
  | { ok: false; error: string }

/** Cross-client list of SKR expertise applications awaiting valuation. */
export async function adminListSkrExpertiseQueue(passcode: string): Promise<SkrExpertiseQueueResult> {
  try {
    await requireAdmin(passcode)
    return { ok: true, items: await listSkrExpertiseQueue() }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Administrator returns the valuation: sets the assessed value of the goods and
 * a professional outcome, and quotes the formula-based service cost
 * `(faceValue × 0.075% × (tradeScore + 1)) / 1.5` using the customer's
 * Guarantees-Accumulator trade score. The client then accepts or declines.
 */
export async function adminSetSkrExpertise(
  passcode: string,
  userId: string,
  recordId: string,
  input: { assessedValue: number; assessedCurrency?: string; outcomeNote: string },
): Promise<SkrExpertiseAssessResult> {
  try {
    await requireAdmin(passcode)
    const rows = await listSkrRecordsForUser(userId)
    const row = rows.find((r) => r.id === recordId)
    if (!row) return { ok: false, error: "SKR record not found for this client." }
    const data = row.data as SkrRecordData
    if (data.blockedAsCollateral) {
      return { ok: false, error: "This SKR is already blocked as collateral." }
    }
    const st = data.expertise?.status
    if (st !== "requested" && st !== "assessed") {
      return { ok: false, error: "There is no open expertise application to value." }
    }
    const assessedValue = Number(input.assessedValue)
    if (!Number.isFinite(assessedValue) || assessedValue <= 0) {
      return { ok: false, error: "Enter a valid assessed value greater than zero." }
    }
    if (!input.outcomeNote.trim()) {
      return { ok: false, error: "Enter the expertise outcome / findings." }
    }

    const faceValue = Number(data.faceValue ?? 0)
    const currency = String(data.currency ?? "USD")

    // Customer Trade Score = Guarantees Accumulator risk score (finalScore).
    let tradeScore = 0
    try {
      const profile = await gatherGuaranteeProfile(userId, await getGuaranteeConfig())
      tradeScore = Number.isFinite(profile.score.finalScore) ? profile.score.finalScore : 0
    } catch {
      tradeScore = 0
    }
    const cost = skrExpertiseCost(faceValue, tradeScore)
    const now = new Date().toISOString()

    const updated = await patchSkrExpertiseForUser(userId, recordId, {
      expertise: {
        status: "assessed",
        assessedValue,
        assessedCurrency: input.assessedCurrency?.trim() || currency,
        outcomeNote: input.outcomeNote.trim(),
        tradeScore,
        cost,
        costCurrency: currency,
        assessedAt: now,
        declinedAt: undefined,
      },
      transaction: {
        id: skrRef("TX"),
        date: now,
        type: "Expertise Valued",
        description: `Custody desk returned the assessment. Assessed value ${(input.assessedCurrency?.trim() || currency)} ${assessedValue.toLocaleString("en-US")}; service cost ${currency} ${cost.toLocaleString("en-US")}.`,
        reference: skrRef("EXP"),
      },
    })
    if (!updated) return { ok: false, error: "SKR record not found for this client." }

    try {
      await insertNotification({
        userId,
        tone: "info",
        title: "SKR expertise ready",
        body: `Your ${(data.expertise?.kind ?? "expertise").toString().toLowerCase()} of SKR ${recordId} is ready. Assessed value ${(input.assessedCurrency?.trim() || currency)} ${assessedValue.toLocaleString("en-US")}. Review the outcome and the ${currency} ${cost.toLocaleString("en-US")} cost, then accept to unlock it as collateral.`,
        href: "/dashboard/skr",
      })
    } catch {
      // best-effort
    }

    await logActivity({
      action: `Returned SKR expertise valuation for ${recordId}`,
      category: "Administration",
      details: {
        summary: `Administrator returned the expertise valuation for SKR ${recordId}: assessed value ${(input.assessedCurrency?.trim() || currency)} ${assessedValue.toLocaleString("en-US")}, trade score ${tradeScore.toFixed(2)}, service cost ${currency} ${cost.toLocaleString("en-US")}.`,
        referenceId: recordId,
        assessedValue: `${input.assessedCurrency?.trim() || currency} ${assessedValue.toLocaleString("en-US")}`,
        tradeScore: tradeScore.toFixed(2),
        cost: `${currency} ${cost.toLocaleString("en-US")}`,
      },
    }).catch(() => undefined)

    return { ok: true, cost, tradeScore, currency }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}

/**
 * Customer declines the returned valuation. Nothing was charged, so this simply
 * marks the expertise declined (the client may apply again later).
 */
export async function declineSkrExpertise(recordId: string): Promise<SkrExpertiseResult> {
  try {
    const session = await resolveCurrentSession()
    if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
    const rows = await listSkrRecordsForUser(session.id)
    const row = rows.find((r) => r.id === recordId)
    if (!row) return { ok: false, error: "SKR record not found in your portfolio." }
    const data = row.data as SkrRecordData
    if (data.expertise?.status !== "assessed") {
      return { ok: false, error: "There is no returned valuation to decline." }
    }
    const now = new Date().toISOString()
    await patchSkrExpertiseForUser(session.id, recordId, {
      expertise: { status: "declined", declinedAt: now },
      transaction: {
        id: skrRef("TX"),
        date: now,
        type: "Expertise Declined",
        description: `Client declined the returned expertise valuation and cost.`,
        reference: skrRef("EXP"),
      },
    })
    await logActivity({
      action: `Declined the SKR expertise valuation for ${recordId}`,
      category: "SKR Trading",
      details: {
        summary: `Client declined the returned expertise valuation for safe keeping receipt ${recordId}.`,
        referenceId: recordId,
        status: "Declined",
      },
    }).catch(() => undefined)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: friendlyError(err) }
  }
}
