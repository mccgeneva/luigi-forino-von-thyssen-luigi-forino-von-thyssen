import "server-only"
import { query } from "@/lib/db"
import type { ApprovalKind } from "@/lib/approval-kinds"

export type { ApprovalKind }

/**
 * Unified cross-client approval backbone.
 *
 * Every "request that needs an administrator decision" — outgoing payments,
 * leverage lines, PPP/yield, bank instruments, monetization, project funding,
 * fiduciary, download-of-funds, DTC, Euroclear, commodity deals — is stored as
 * a single row in `approval_requests`, namespaced by the owning client's
 * user_id. Because it lives in Neon (not per-browser localStorage), the
 * administrator can see and act on requests from ANY client, and the decision
 * is visible to that client on their next load.
 *
 * Kind-specific detail lives in the `payload` JSONB column so every workflow
 * shares one table, one query path, and one audit trail.
 */

/**
 * Lifecycle of a request:
 *  - "pending"          — awaiting the administrator's decision.
 *  - "awaiting_master"  — admin approved, but a Sub-account's Master must also
 *                          consent before the money moves. Treated as "still
 *                          pending" by the client reconcile (no side effect yet)
 *                          and excluded from the admin's pending queue.
 *  - "approved"         — all required gates cleared; the ledger effect applies.
 *  - "rejected"         — declined by the admin OR the Master.
 *  - "cancelled"        — withdrawn by the owning client.
 */
export type ApprovalStatus = "pending" | "awaiting_master" | "approved" | "rejected" | "cancelled"

/** A single party's verdict in the (possibly) two-gate decision. */
export type GateDecision = "pending" | "approved" | "rejected"

/**
 * Optional financial effect applied to the owner's server-authoritative ledger
 * when the request is APPROVED. When present, approving the request posts this
 * entry (e.g. debiting an outgoing payment, crediting a funded amount).
 */
export interface LedgerEffect {
  direction: "debit" | "credit"
  amount: number
  currency: string
  counterparty?: string
  account?: string
  bank?: string
  reference?: string
  category?: string
  /** "completed" moves available balance immediately; "hold" pends it. */
  status?: "completed" | "hold"
  /**
   * Sub-account compartment this effect posts against. Absent/empty ⇒ the
   * user's MAIN account (default). When set, the ledger entry is tagged with
   * this id so it moves ONLY that compartment's isolated balance — used when a
   * client remits an outgoing payment FROM a specific sub-account.
   */
  subAccountId?: string
  /**
   * Opt-in fund-availability gate for an immediate ("completed") DEBIT. Normally
   * only "hold" debits are pre-assessed (auto-reject if unfundable) and funded
   * via capped cross-currency FX. Setting `gate: true` makes a settled debit —
   * e.g. a non-refundable instrument acquisition fee that must actually leave the
   * balance on approval — go through the SAME feasibility check + FX funding +
   * solvency enforcement, so approval auto-rejects when the fee can't be covered
   * and never overdraws the account.
   */
  gate?: boolean
}

export interface ApprovalRequest {
  id: string
  userId: string
  kind: ApprovalKind
  status: ApprovalStatus
  title: string
  summary: string
  amount: number | null
  currency: string | null
  payload: Record<string, unknown>
  ledgerEffect: LedgerEffect | null
  decisionNote: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  // --- Dual-gate (Sub-account) consent --------------------------------------
  /** When true, a Master must also approve before the request executes. */
  requiresMasterApproval: boolean
  /** The Master account responsible for the second gate. */
  masterId: string | null
  /** The Master's verdict on the second gate. */
  masterDecision: GateDecision
  masterDecidedAt: string | null
  /** The administrator's verdict on the first gate (mirrors `status` for
   *  single-gate requests, distinct for dual-gate ones). */
  adminDecision: GateDecision
  /** Who actually initiated the request (the Sub-account), for audit. */
  initiatedById: string | null
  initiatedByName: string | null
}

export interface NewApprovalRequest {
  id?: string
  userId: string
  kind: ApprovalKind
  title: string
  summary: string
  amount?: number | null
  currency?: string | null
  payload?: Record<string, unknown>
  ledgerEffect?: LedgerEffect | null
  requiresMasterApproval?: boolean
  masterId?: string | null
  initiatedById?: string | null
  initiatedByName?: string | null
}

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS approval_requests (
       id            text        PRIMARY KEY,
       user_id       text        NOT NULL,
       kind          text        NOT NULL,
       status        text        NOT NULL DEFAULT 'pending',
       title         text        NOT NULL DEFAULT '',
       summary       text        NOT NULL DEFAULT '',
       amount        numeric,
       currency      text,
       payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
       ledger_effect jsonb,
       decision_note text,
       decided_by    text,
       decided_at    timestamptz,
       created_at    timestamptz NOT NULL DEFAULT now()
     )`,
  )
  // Columns added after the table first shipped. Added via IF NOT EXISTS so the
  // table migrates forward in place without dropping existing requests. The
  // ledger_effect column is essential for reserve/hold-on-approval to work on
  // deployments whose approval_requests table predates that feature.
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS ledger_effect jsonb`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS requires_master_approval boolean NOT NULL DEFAULT false`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS master_id text`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS master_decision text NOT NULL DEFAULT 'pending'`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS master_decided_at timestamptz`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS admin_decision text NOT NULL DEFAULT 'pending'`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS initiated_by_id text`)
  await query(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS initiated_by_name text`)

  // Indexes that match our hot read paths: a client's own list, the admin's
  // global pending queue, and a Master's consent queue.
  await query(`CREATE INDEX IF NOT EXISTS approval_requests_user_idx ON approval_requests (user_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS approval_requests_master_idx ON approval_requests (master_id, created_at DESC)`)
  ensured = true
}

function rowToRequest(row: Record<string, unknown>): ApprovalRequest {
  const payload = (row.payload as Record<string, unknown>) ?? {}
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    title: (row.title as string) ?? "",
    summary: (row.summary as string) ?? "",
    amount: row.amount == null ? null : Number(row.amount),
    currency: (row.currency as string) ?? null,
    payload,
    ledgerEffect: (row.ledger_effect as LedgerEffect | null) ?? null,
    decisionNote: (row.decision_note as string) ?? null,
    decidedBy: (row.decided_by as string) ?? null,
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
    requiresMasterApproval: Boolean(row.requires_master_approval),
    masterId: (row.master_id as string) ?? null,
    masterDecision: ((row.master_decision as GateDecision) ?? "pending") || "pending",
    masterDecidedAt: row.master_decided_at ? new Date(row.master_decided_at as string).toISOString() : null,
    adminDecision: ((row.admin_decision as GateDecision) ?? "pending") || "pending",
    initiatedById: (row.initiated_by_id as string) ?? null,
    initiatedByName: (row.initiated_by_name as string) ?? null,
  }
}

/**
 * Combine the two gate verdicts into the request's overall status.
 *  - Any rejection ⇒ rejected.
 *  - Admin approved + (no Master gate OR Master approved) ⇒ approved.
 *  - Admin approved + Master gate still open ⇒ awaiting_master.
 *  - Otherwise still pending the administrator.
 */
export function combineStatus(
  adminDecision: GateDecision,
  masterDecision: GateDecision,
  requiresMaster: boolean,
): ApprovalStatus {
  if (adminDecision === "rejected" || (requiresMaster && masterDecision === "rejected")) {
    return "rejected"
  }
  if (adminDecision === "approved") {
    if (!requiresMaster || masterDecision === "approved") return "approved"
    return "awaiting_master"
  }
  return "pending"
}

function genId(kind: ApprovalKind): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${kind.toUpperCase().slice(0, 4)}-${Date.now().toString(36).toUpperCase()}-${rand}`
}

/** Insert a new pending request. Returns the stored record. */
export async function insertApproval(req: NewApprovalRequest): Promise<ApprovalRequest> {
  await ensureTable()
  const id = req.id ?? genId(req.kind)
  const requiresMaster = Boolean(req.requiresMasterApproval && req.masterId)
  const { rows } = await query(
    `INSERT INTO approval_requests
       (id, user_id, kind, status, title, summary, amount, currency, payload, ledger_effect,
        requires_master_approval, master_id, initiated_by_id, initiated_by_name)
     VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
     RETURNING *`,
    [
      id,
      req.userId,
      req.kind,
      req.title,
      req.summary,
      req.amount ?? null,
      req.currency ?? null,
      JSON.stringify(req.payload ?? {}),
      req.ledgerEffect ? JSON.stringify(req.ledgerEffect) : null,
      requiresMaster,
      requiresMaster ? req.masterId : null,
      req.initiatedById ?? null,
      req.initiatedByName ?? null,
    ],
  )
  return rowToRequest(rows[0])
}

/**
 * Idempotently seed a request at a FINAL lifecycle state (used by the demo
 * account seeder). Unlike `insertApproval` — which always lands a row at
 * `pending` and runs the live mirror/ledger workflow — this inserts a row whose
 * `status` is given up front (e.g. an already-`approved` payment or an
 * `active`/approved instrument) together with its decision timestamp, and uses
 * `ON CONFLICT (id) DO NOTHING` so re-running the seeder (or a re-login) never
 * duplicates or clobbers a record the user has since acted on. It deliberately
 * does NOT carry a ledger effect: the demo's balances are seeded directly into
 * `ledger_entries`, so applying effects here would double-count.
 */
export async function seedApproval(
  req: NewApprovalRequest & { status?: ApprovalStatus; decidedAt?: string | null; createdAt?: string | null },
): Promise<void> {
  await ensureTable()
  const status = req.status ?? "pending"
  const adminDecision: GateDecision =
    status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending"
  await query(
    `INSERT INTO approval_requests
       (id, user_id, kind, status, title, summary, amount, currency, payload,
        admin_decision, decided_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,COALESCE($12::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING`,
    [
      req.id ?? genId(req.kind),
      req.userId,
      req.kind,
      status,
      req.title,
      req.summary,
      req.amount ?? null,
      req.currency ?? null,
      JSON.stringify(req.payload ?? {}),
      adminDecision,
      req.decidedAt ?? null,
      req.createdAt ?? null,
    ],
  )
}

/** A single request by id (used to validate decisions). */
export async function getApprovalById(id: string): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM approval_requests WHERE id = $1`, [id])
  return rows.length ? rowToRequest(rows[0]) : null
}

/** All requests owned by one client, newest first. Optionally filter by kind. */
export async function listApprovalsForUser(userId: string, kind?: ApprovalKind): Promise<ApprovalRequest[]> {
  await ensureTable()
  const { rows } = kind
    ? await query(
        `SELECT * FROM approval_requests WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC`,
        [userId, kind],
      )
    : await query(`SELECT * FROM approval_requests WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
  return rows.map(rowToRequest)
}

/**
 * All requests owned by ANY of the given client ids, newest first. Used for a
 * shared environment (Master + its Joint accounts) so a Joint account sees the
 * whole environment's deals/payments. Falls back to an empty list for no ids.
 */
export async function listApprovalsForUsers(userIds: string[], kind?: ApprovalKind): Promise<ApprovalRequest[]> {
  const ids = userIds.filter(Boolean)
  if (ids.length === 0) return []
  if (ids.length === 1) return listApprovalsForUser(ids[0], kind)
  await ensureTable()
  const { rows } = kind
    ? await query(
        `SELECT * FROM approval_requests WHERE user_id = ANY($1) AND kind = $2 ORDER BY created_at DESC`,
        [ids, kind],
      )
    : await query(`SELECT * FROM approval_requests WHERE user_id = ANY($1) ORDER BY created_at DESC`, [ids])
  return rows.map(rowToRequest)
}

/** Cross-client list for the admin dashboard, newest first. */
export async function listAllApprovals(opts?: {
  status?: ApprovalStatus
  kind?: ApprovalKind
  userId?: string
}): Promise<ApprovalRequest[]> {
  await ensureTable()
  const where: string[] = []
  const params: unknown[] = []
  if (opts?.status) {
    params.push(opts.status)
    where.push(`status = $${params.length}`)
  }
  if (opts?.kind) {
    params.push(opts.kind)
    where.push(`kind = $${params.length}`)
  }
  if (opts?.userId) {
    params.push(opts.userId)
    where.push(`user_id = $${params.length}`)
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const { rows } = await query(`SELECT * FROM approval_requests ${clause} ORDER BY created_at DESC`, params)
  return rows.map(rowToRequest)
}

/** Count of pending requests grouped by kind — drives the admin banner. */
export async function countPendingByKind(): Promise<Record<string, number>> {
  await ensureTable()
  const { rows } = await query<{ kind: string; n: string }>(
    `SELECT kind, COUNT(*)::int AS n FROM approval_requests WHERE status = 'pending' GROUP BY kind`,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.kind] = Number(r.n)
  return out
}

/**
 * Count of outgoing PAYMENTS that were approved & initiated (stage 2) but not
 * yet confirmed delivered (stage 3). These carry a pending ADMINISTRATOR action
 * — "Mark funds delivered" — even though they are no longer `pending`, so they
 * would otherwise be invisible on the command center (which counts pending only).
 *
 * Scoped to payments that carry a `deliveryInitiatedAt` marker (stamped when a
 * payment reaches approved & initiated, going forward). This DELIBERATELY
 * excludes the historical backlog of older approved payments that predate the
 * stage-3 delivery feature and will never be marked delivered — so only genuinely
 * new, not-yet-delivered payments surface as an admin action.
 */
export async function countPaymentsAwaitingDelivery(): Promise<number> {
  await ensureTable()
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM approval_requests
      WHERE kind = 'payment' AND status = 'approved'
        AND payload->>'deliveryInitiatedAt' IS NOT NULL
        AND COALESCE(payload->>'delivered', 'false') <> 'true'`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Count of APPROVED Yield / PPP programs whose client has requested an early
 * termination the administrator has not yet confirmed. These carry a pending
 * ADMINISTRATOR action (negotiate the exit cost & confirm) even though the
 * program is still `approved`, so they would otherwise be invisible on the
 * command center (which counts only `pending` rows).
 */
export async function countYieldTerminationRequests(): Promise<number> {
  await ensureTable()
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM approval_requests
      WHERE kind = 'ppp' AND status = 'approved'
        AND payload->'record'->>'terminationRequestedAt' IS NOT NULL
        AND payload->'record'->>'cancelledAt' IS NULL`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Count of APPROVED Treuhand hedge-fund positions (kind `trading_fund`) whose
 * client has requested an early termination the administrator has not yet
 * reconciled. The termination marker lives on the TOP-LEVEL payload (not
 * `payload.record`) and the position stays `approved`, so — like the yield
 * termination case — it is invisible on the command center without this count.
 */
export async function countTradingFundTerminationRequests(): Promise<number> {
  await ensureTable()
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM approval_requests
      WHERE kind = 'trading_fund' AND status = 'approved'
        AND payload->>'terminationRequestedAt' IS NOT NULL
        AND payload->>'closedAt' IS NULL
        AND payload->>'exitedAt' IS NULL`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Count of APPROVED bank instruments whose client has REQUESTED a transformation
 * upgrade the administrator has not yet actioned. The customer-initiated request
 * stamps `payload.upgrade.status = 'requested'` on the still-`approved`
 * instrument (it blocks nothing and charges nothing), so — like the yield /
 * Treuhand termination requests — it never enters the `pending` counts and is
 * invisible on the command center without this dedicated count.
 */
export async function countInstrumentUpgradeRequests(): Promise<number> {
  await ensureTable()
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM approval_requests
      WHERE kind = 'instrument' AND status = 'approved'
        AND payload->'upgrade'->>'status' = 'requested'`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Record a decision on a pending request. Returns the updated record, or null
 * if it does not exist or was already decided (idempotent / race-safe via the
 * status guard in the WHERE clause).
 */
export async function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  note?: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
        SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, decision, decidedBy, note?.trim() || null],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Replace an approval's JSONB payload. Used when the administrator customizes a
 * request before deciding it (e.g. finalizing a payment card's network, tier,
 * limit and features) so the finalized record is delivered to the client.
 * Returns the updated record, or null if the request no longer exists.
 */
export async function updateApprovalPayload(
  id: string,
  payload: Record<string, unknown>,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests SET payload = $2::jsonb WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(payload ?? {})],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Replace an approval's commercial terms (amount, currency, ledger effect) AND
 * its payload in one statement. Used when an administrator approves a deal
 * amendment: the new price/quantity/incoterms must update the stored value and
 * the reservation effect together so the balance hold tracks the amended value.
 */
export async function updateApprovalTerms(
  id: string,
  fields: {
    amount: number | null
    currency: string | null
    ledgerEffect: LedgerEffect | null
    payload: Record<string, unknown>
  },
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
       SET amount = $2, currency = $3, ledger_effect = $4::jsonb, payload = $5::jsonb
     WHERE id = $1
     RETURNING *`,
    [
      id,
      fields.amount,
      fields.currency,
      fields.ledgerEffect ? JSON.stringify(fields.ledgerEffect) : null,
      JSON.stringify(fields.payload ?? {}),
    ],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Record the ADMINISTRATOR's verdict (first gate). Recomputes the overall
 * status from both gates so a dual-gate request lands on "awaiting_master"
 * rather than "approved" until the Master also consents. Only acts while the
 * request is still open (pending / awaiting_master).
 */
export async function recordAdminDecision(
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  note?: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const existing = await getApprovalById(id)
  if (!existing) return null
  if (existing.status !== "pending" && existing.status !== "awaiting_master") return null
  const status = combineStatus(decision, existing.masterDecision, existing.requiresMasterApproval)
  const { rows } = await query(
    `UPDATE approval_requests
        SET admin_decision = $2, status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE id = $1 AND status IN ('pending','awaiting_master')
      RETURNING *`,
    [id, decision, status, decidedBy, note?.trim() || null],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Record the MASTER's verdict (second gate) for a Sub-account request.
 * Recomputes the overall status; money only moves once BOTH gates are approved.
 * Only acts on requests that actually require the Master and are still open.
 */
export async function recordMasterDecision(
  id: string,
  masterId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const existing = await getApprovalById(id)
  if (!existing) return null
  if (!existing.requiresMasterApproval || existing.masterId !== masterId) return null
  if (existing.status !== "pending" && existing.status !== "awaiting_master") return null
  const status = combineStatus(existing.adminDecision, decision, true)
  // Preserve any administrator note; only append the Master's note when given.
  const mergedNote = note?.trim() ? `${existing.decisionNote ? `${existing.decisionNote} · ` : ""}Master: ${note.trim()}` : existing.decisionNote
  const { rows } = await query(
    `UPDATE approval_requests
        SET master_decision = $2, master_decided_at = now(), status = $3, decision_note = $4
      WHERE id = $1 AND master_id = $5 AND requires_master_approval = true
        AND status IN ('pending','awaiting_master')
      RETURNING *`,
    [id, decision, status, mergedNote, masterId],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * The consent queue for a Master: every Sub-account request routed to them for
 * a second-gate decision, newest first. Optionally restrict to those still
 * awaiting the Master's verdict.
 */
export async function listApprovalsForMaster(
  masterId: string,
  opts?: { pendingOnly?: boolean },
): Promise<ApprovalRequest[]> {
  await ensureTable()
  const { rows } = opts?.pendingOnly
    ? await query(
        `SELECT * FROM approval_requests
          WHERE master_id = $1 AND requires_master_approval = true AND master_decision = 'pending'
            AND status IN ('pending','awaiting_master')
          ORDER BY created_at DESC`,
        [masterId],
      )
    : await query(
        `SELECT * FROM approval_requests
          WHERE master_id = $1 AND requires_master_approval = true
          ORDER BY created_at DESC`,
        [masterId],
      )
  return rows.map(rowToRequest)
}

/** Client-side cancellation of their own still-pending request. */
export async function cancelApproval(id: string, userId: string): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
        SET status = 'cancelled', decided_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
      RETURNING *`,
    [id, userId],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Client-side REVOCATION of their own already-APPROVED request (e.g. a
 * commodity deal that was authorized but has not yet been delivered). Race-safe:
 * the WHERE clause only acts while the request is still `approved` AND has NOT
 * been flagged delivered in its payload — so a deal the administrator marked
 * delivered can never be revoked. The caller is responsible for releasing any
 * ledger hold. Returns the updated record, or null if it can no longer be
 * revoked (already settled/delivered/decided otherwise).
 */
export async function revokeApprovedApproval(
  id: string,
  userId: string,
  note?: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
        SET status = 'cancelled',
            decided_at = now(),
            decision_note = $3,
            payload = payload || '{"revokedByClient": true}'::jsonb
      WHERE id = $1 AND user_id = $2 AND status = 'approved'
        AND COALESCE(payload->>'delivered', 'false') <> 'true'
      RETURNING *`,
    [id, userId, note?.trim() || "Revoked by client before delivery."],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Move an already-APPROVED (active) instrument out of a holder's portfolio as
 * part of a client-to-client transfer. Sets the record to `cancelled` and
 * stamps `transferredTo` into the payload so the store can surface it as
 * "Transferred" rather than a plain cancellation. Race-safe and ownership-
 * scoped: only acts while the record is still `approved` AND owned by `userId`,
 * so two concurrent transfers of the same instrument cannot both succeed.
 * Returns the updated record, or null if it can no longer be transferred.
 */
export async function markApprovalTransferred(
  id: string,
  userId: string,
  toLabel: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
        SET status = 'cancelled',
            decided_at = now(),
            decision_note = $3,
            payload = payload || jsonb_build_object('transferredTo', $4::text)
      WHERE id = $1 AND user_id = $2 AND status = 'approved'
      RETURNING *`,
    [id, userId, `Transferred to ${toLabel}`, toLabel],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Administrator REVOCATION of an already-APPROVED request, regardless of which
 * client owns it. Unlike the client revoke, this is NOT scoped to a user id —
 * administrator authority. Still race-safe: only acts while the request is
 * `approved` AND has NOT been flagged delivered (a delivered deal is finalized
 * and cannot be reversed). The caller releases the ledger hold. Returns the
 * updated record, or null if it can no longer be revoked.
 */
export async function adminRevokeApprovedApproval(
  id: string,
  note?: string,
): Promise<ApprovalRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE approval_requests
        SET status = 'cancelled',
            decided_at = now(),
            decision_note = $2,
            payload = payload || '{"revokedByAdmin": true}'::jsonb
      WHERE id = $1 AND status = 'approved'
        AND COALESCE(payload->>'delivered', 'false') <> 'true'
      RETURNING *`,
    [id, note?.trim() || "Revoked by administrator before delivery."],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Administrator flags an approved deal as DELIVERED (commodity received /
 * settled). Once delivered the deal is locked: the client can no longer revoke
 * it. Stamps `delivered` + `deliveredAt` into the payload so the state is
 * visible cross-client. Only acts on a still-approved request. Returns the
 * updated record, or null if it is not in an approved state.
 */
export async function markApprovalDelivered(id: string): Promise<ApprovalRequest | null> {
  await ensureTable()
  const deliveredAt = new Date().toISOString()
  const { rows } = await query(
    `UPDATE approval_requests
        SET payload = payload || jsonb_build_object('delivered', true, 'deliveredAt', $2::text)
      WHERE id = $1 AND status = 'approved'
      RETURNING *`,
    [id, deliveredAt],
  )
  return rows.length ? rowToRequest(rows[0]) : null
}

/**
 * Permanently remove an approval row. Used by the administrator to hard-delete a
 * deal (any lifecycle state) after any reserved funds have been released by the
 * caller. NOT ownership-scoped — administrator authority. Returns true if a row
 * was actually deleted.
 */
export async function deleteApproval(id: string): Promise<boolean> {
  await ensureTable()
  const { rows } = await query(`DELETE FROM approval_requests WHERE id = $1 RETURNING id`, [id])
  return rows.length > 0
}

/**
 * Permanently remove one of a client's OWN approval rows. Ownership-scoped so a
 * client can only ever delete their own record. The caller is responsible for
 * releasing any reserved-funds hold first. Returns true if a row was deleted.
 */
export async function deleteApprovalForUser(id: string, userId: string): Promise<boolean> {
  await ensureTable()
  const { rows } = await query(
    `DELETE FROM approval_requests WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  )
  return rows.length > 0
}
