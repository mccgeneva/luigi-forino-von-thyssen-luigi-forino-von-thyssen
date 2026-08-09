import "server-only"
import { query } from "@/lib/db"

/**
 * SWIFT message routing & approval backbone.
 *
 * When a client generates and "sends" a SWIFT message, the message is NOT
 * delivered straight to a counterparty. Instead it is persisted here as a
 * `pending` routing request (namespaced by the owning client's user_id) and the
 * client receives an immediate confirmation email. An administrator then
 * reviews the request in the control panel, picks the correct beneficiary from
 * the platform users database, and approves it — at which point the full SWIFT
 * FIN text is emailed to the chosen beneficiary and the request is marked
 * `approved` (or `declined`).
 *
 * Lives in Neon (not per-browser state) so the administrator can see and act on
 * requests from ANY client, and each client sees the decision on their next
 * load.
 */

export type SwiftRoutingStatus = "pending" | "approved" | "declined"

export interface SwiftRoutingRequest {
  id: string
  /** Owning client (the sender who composed the message). */
  userId: string
  /** Sender's account/contact email that received the submission confirmation. */
  customerEmail: string
  customerName: string
  messageType: string
  messageName: string
  category: string
  uetr: string
  /** Raw SWIFT FIN text. */
  raw: string
  senderBic: string
  receiverBic: string
  amount: string | null
  currency: string | null
  reference: string | null
  status: SwiftRoutingStatus
  /** Beneficiary chosen by the admin at approval time. */
  beneficiaryUserId: string | null
  beneficiaryEmail: string | null
  beneficiaryName: string | null
  decisionNote: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

export interface NewSwiftRoutingRequest {
  id?: string
  userId: string
  customerEmail: string
  customerName: string
  messageType: string
  messageName: string
  category: string
  uetr: string
  raw: string
  senderBic: string
  receiverBic: string
  amount?: string | null
  currency?: string | null
  reference?: string | null
}

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS swift_routing_requests (
       id                text        PRIMARY KEY,
       user_id           text        NOT NULL,
       customer_email    text        NOT NULL DEFAULT '',
       customer_name     text        NOT NULL DEFAULT '',
       message_type      text        NOT NULL DEFAULT '',
       message_name      text        NOT NULL DEFAULT '',
       category          text        NOT NULL DEFAULT '',
       uetr              text        NOT NULL DEFAULT '',
       raw               text        NOT NULL DEFAULT '',
       sender_bic        text        NOT NULL DEFAULT '',
       receiver_bic      text        NOT NULL DEFAULT '',
       amount            text,
       currency          text,
       reference         text,
       status            text        NOT NULL DEFAULT 'pending',
       beneficiary_user_id text,
       beneficiary_email   text,
       beneficiary_name    text,
       decision_note     text,
       decided_by        text,
       decided_at        timestamptz,
       created_at        timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS swift_routing_user_idx ON swift_routing_requests (user_id, created_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS swift_routing_status_idx ON swift_routing_requests (status, created_at DESC)`)
  ensured = true
}

function rowToRequest(row: Record<string, unknown>): SwiftRoutingRequest {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    customerEmail: (row.customer_email as string) ?? "",
    customerName: (row.customer_name as string) ?? "",
    messageType: (row.message_type as string) ?? "",
    messageName: (row.message_name as string) ?? "",
    category: (row.category as string) ?? "",
    uetr: (row.uetr as string) ?? "",
    raw: (row.raw as string) ?? "",
    senderBic: (row.sender_bic as string) ?? "",
    receiverBic: (row.receiver_bic as string) ?? "",
    amount: (row.amount as string) ?? null,
    currency: (row.currency as string) ?? null,
    reference: (row.reference as string) ?? null,
    status: row.status as SwiftRoutingStatus,
    beneficiaryUserId: (row.beneficiary_user_id as string) ?? null,
    beneficiaryEmail: (row.beneficiary_email as string) ?? null,
    beneficiaryName: (row.beneficiary_name as string) ?? null,
    decisionNote: (row.decision_note as string) ?? null,
    decidedBy: (row.decided_by as string) ?? null,
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
  }
}

function genId(): string {
  return `swr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Persist a new pending routing request. */
export async function insertSwiftRoutingRequest(input: NewSwiftRoutingRequest): Promise<SwiftRoutingRequest> {
  await ensureTable()
  const id = input.id ?? genId()
  const { rows } = await query(
    `INSERT INTO swift_routing_requests
       (id, user_id, customer_email, customer_name, message_type, message_name, category,
        uetr, raw, sender_bic, receiver_bic, amount, currency, reference, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
     RETURNING *`,
    [
      id,
      input.userId,
      input.customerEmail,
      input.customerName,
      input.messageType,
      input.messageName,
      input.category,
      input.uetr,
      input.raw,
      input.senderBic,
      input.receiverBic,
      input.amount ?? null,
      input.currency ?? null,
      input.reference ?? null,
    ],
  )
  return rowToRequest(rows[0])
}

/** Admin: every routing request across all clients, newest first. */
export async function listAllSwiftRoutingRequests(): Promise<SwiftRoutingRequest[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM swift_routing_requests ORDER BY created_at DESC`)
  return rows.map(rowToRequest)
}

/** Client: a single user's own routing requests, newest first. */
export async function listSwiftRoutingRequestsForUser(userId: string): Promise<SwiftRoutingRequest[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM swift_routing_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(rowToRequest)
}

export async function getSwiftRoutingRequest(id: string): Promise<SwiftRoutingRequest | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM swift_routing_requests WHERE id = $1`, [id])
  return rows[0] ? rowToRequest(rows[0]) : null
}

/**
 * Approve a request, recording the chosen beneficiary. Only transitions a
 * still-pending row (returns null if it was already decided), so a double
 * approval can never route the message twice.
 */
export async function approveSwiftRoutingRequest(
  id: string,
  beneficiary: { userId: string | null; email: string; name: string },
  decidedBy: string,
): Promise<SwiftRoutingRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE swift_routing_requests
        SET status = 'approved',
            beneficiary_user_id = $2,
            beneficiary_email = $3,
            beneficiary_name = $4,
            decided_by = $5,
            decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, beneficiary.userId ?? null, beneficiary.email, beneficiary.name, decidedBy],
  )
  return rows[0] ? rowToRequest(rows[0]) : null
}

export async function declineSwiftRoutingRequest(
  id: string,
  reason: string,
  decidedBy: string,
): Promise<SwiftRoutingRequest | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE swift_routing_requests
        SET status = 'declined', decision_note = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, reason, decidedBy],
  )
  return rows[0] ? rowToRequest(rows[0]) : null
}
