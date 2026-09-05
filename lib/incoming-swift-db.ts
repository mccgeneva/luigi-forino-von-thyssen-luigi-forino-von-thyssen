import "server-only"
import { query } from "@/lib/db"

/**
 * Inbound SWIFT message store.
 *
 * Every SWIFT message received by the platform is parsed, cross-checked against
 * the active bank (gateway) accounts by beneficiary IBAN + receiver BIC, and
 * persisted here. A matched message is namespaced to the owning customer's
 * user_id so it surfaces in their dedicated "SWIFT Messages" inbox; an
 * unmatched message is stored with a null user_id and status `unmatched` so an
 * administrator can review and assign it manually.
 *
 * Lives in Neon (not per-browser state) so the customer sees the message on
 * their next load from any device and the full audit trail is durable.
 */

export type IncomingSwiftStatus = "matched" | "unmatched" | "assigned" | "rejected"

export interface IncomingSwiftMessage {
  id: string
  /** Matched (or admin-assigned) owning customer; null while unmatched. */
  userId: string | null
  status: IncomingSwiftStatus
  messageType: string
  senderBic: string
  receiverBic: string
  beneficiaryIban: string
  beneficiaryName: string
  orderingCustomer: string
  amount: string | null
  currency: string | null
  reference: string | null
  valueDate: string | null
  uetr: string | null
  /** Raw SWIFT FIN text (the copy of the message). */
  raw: string
  /** Gateway account the message was matched to. */
  matchedAccountId: string | null
  matchedAccountHolder: string | null
  /** Whether the receiver BIC confirmed the IBAN match. */
  bicConfirmed: boolean
  matchReason: string
  /** Set when the matched customer has opened the message. */
  readAt: string | null
  /** Set once an administrator has executed the credit to the Master Account. */
  creditedAt: string | null
  /** Deterministic ledger entry id posted for the credit (idempotency key). */
  creditedEntryId: string | null
  /** Credited amount + currency label (as posted to the Master Account). */
  creditedAmount: string | null
  /** True when the customer uploaded this message themselves (vs. platform-received). */
  customerSubmitted: boolean
  /** Blob pathname of the uploaded source printout, if any. */
  sourceDocPathname: string | null
  /** Original filename of the uploaded source printout, if any. */
  sourceDocName: string | null
  createdAt: string
}

export interface NewIncomingSwiftMessage {
  id?: string
  userId: string | null
  status: IncomingSwiftStatus
  messageType: string
  senderBic: string
  receiverBic: string
  beneficiaryIban: string
  beneficiaryName: string
  orderingCustomer: string
  amount?: string | null
  currency?: string | null
  reference?: string | null
  valueDate?: string | null
  uetr?: string | null
  raw: string
  matchedAccountId?: string | null
  matchedAccountHolder?: string | null
  bicConfirmed?: boolean
  matchReason: string
  customerSubmitted?: boolean
  sourceDocPathname?: string | null
  sourceDocName?: string | null
}

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS incoming_swift_messages (
       id                    text        PRIMARY KEY,
       user_id               text,
       status                text        NOT NULL DEFAULT 'unmatched',
       message_type          text        NOT NULL DEFAULT '',
       sender_bic            text        NOT NULL DEFAULT '',
       receiver_bic          text        NOT NULL DEFAULT '',
       beneficiary_iban      text        NOT NULL DEFAULT '',
       beneficiary_name      text        NOT NULL DEFAULT '',
       ordering_customer     text        NOT NULL DEFAULT '',
       amount                text,
       currency              text,
       reference             text,
       value_date            text,
       uetr                  text,
       raw                   text        NOT NULL DEFAULT '',
       matched_account_id    text,
       matched_account_holder text,
       bic_confirmed         boolean     NOT NULL DEFAULT false,
       match_reason          text        NOT NULL DEFAULT '',
       read_at               timestamptz,
       created_at            timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(
    `CREATE INDEX IF NOT EXISTS incoming_swift_user_idx ON incoming_swift_messages (user_id, created_at DESC)`,
  )
  await query(
    `CREATE INDEX IF NOT EXISTS incoming_swift_status_idx ON incoming_swift_messages (status, created_at DESC)`,
  )
  // Credit-tracking columns (added after the table shipped) — idempotent so an
  // existing store is upgraded in place without a migration step.
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS credited_at timestamptz`)
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS credited_entry_id text`)
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS credited_amount text`)
  // Customer-submitted printout tracking (added after the table shipped).
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS customer_submitted boolean NOT NULL DEFAULT false`)
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS source_doc_pathname text`)
  await query(`ALTER TABLE incoming_swift_messages ADD COLUMN IF NOT EXISTS source_doc_name text`)
  ensured = true
}

function rowToMessage(row: Record<string, unknown>): IncomingSwiftMessage {
  return {
    id: row.id as string,
    userId: (row.user_id as string) ?? null,
    status: row.status as IncomingSwiftStatus,
    messageType: (row.message_type as string) ?? "",
    senderBic: (row.sender_bic as string) ?? "",
    receiverBic: (row.receiver_bic as string) ?? "",
    beneficiaryIban: (row.beneficiary_iban as string) ?? "",
    beneficiaryName: (row.beneficiary_name as string) ?? "",
    orderingCustomer: (row.ordering_customer as string) ?? "",
    amount: (row.amount as string) ?? null,
    currency: (row.currency as string) ?? null,
    reference: (row.reference as string) ?? null,
    valueDate: (row.value_date as string) ?? null,
    uetr: (row.uetr as string) ?? null,
    raw: (row.raw as string) ?? "",
    matchedAccountId: (row.matched_account_id as string) ?? null,
    matchedAccountHolder: (row.matched_account_holder as string) ?? null,
    bicConfirmed: Boolean(row.bic_confirmed),
    matchReason: (row.match_reason as string) ?? "",
    readAt: row.read_at ? new Date(row.read_at as string).toISOString() : null,
    creditedAt: row.credited_at ? new Date(row.credited_at as string).toISOString() : null,
    creditedEntryId: (row.credited_entry_id as string) ?? null,
    creditedAmount: (row.credited_amount as string) ?? null,
    customerSubmitted: Boolean(row.customer_submitted),
    sourceDocPathname: (row.source_doc_pathname as string) ?? null,
    sourceDocName: (row.source_doc_name as string) ?? null,
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
  }
}

function genId(): string {
  return `ISW-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

export async function insertIncomingSwift(msg: NewIncomingSwiftMessage): Promise<IncomingSwiftMessage> {
  await ensureTable()
  const id = msg.id ?? genId()
  const { rows } = await query(
    `INSERT INTO incoming_swift_messages
       (id, user_id, status, message_type, sender_bic, receiver_bic, beneficiary_iban,
        beneficiary_name, ordering_customer, amount, currency, reference, value_date,
        uetr, raw, matched_account_id, matched_account_holder, bic_confirmed, match_reason,
        customer_submitted, source_doc_pathname, source_doc_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [
      id,
      msg.userId,
      msg.status,
      msg.messageType,
      msg.senderBic,
      msg.receiverBic,
      msg.beneficiaryIban,
      msg.beneficiaryName,
      msg.orderingCustomer,
      msg.amount ?? null,
      msg.currency ?? null,
      msg.reference ?? null,
      msg.valueDate ?? null,
      msg.uetr ?? null,
      msg.raw,
      msg.matchedAccountId ?? null,
      msg.matchedAccountHolder ?? null,
      msg.bicConfirmed ?? false,
      msg.matchReason,
      msg.customerSubmitted ?? false,
      msg.sourceDocPathname ?? null,
      msg.sourceDocName ?? null,
    ],
  )
  return rowToMessage(rows[0])
}

/** Every inbound message routed to a set of linked customer ids (newest first). */
export async function listIncomingSwiftForUsers(userIds: string[]): Promise<IncomingSwiftMessage[]> {
  await ensureTable()
  if (!userIds.length) return []
  const { rows } = await query(
    `SELECT * FROM incoming_swift_messages
       WHERE user_id = ANY($1) AND status IN ('matched','assigned')
     ORDER BY created_at DESC`,
    [userIds],
  )
  return rows.map(rowToMessage)
}

export async function countUnreadIncomingSwiftForUsers(userIds: string[]): Promise<number> {
  await ensureTable()
  if (!userIds.length) return 0
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM incoming_swift_messages
       WHERE user_id = ANY($1) AND status IN ('matched','assigned') AND read_at IS NULL`,
    [userIds],
  )
  return Number(rows[0]?.n ?? 0)
}

/** All still-unmatched messages, for the administrator review queue. */
export async function listUnmatchedIncomingSwift(): Promise<IncomingSwiftMessage[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM incoming_swift_messages WHERE status = 'unmatched' ORDER BY created_at DESC`,
  )
  return rows.map(rowToMessage)
}

export async function getIncomingSwiftById(id: string): Promise<IncomingSwiftMessage | undefined> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM incoming_swift_messages WHERE id = $1`, [id])
  return rows[0] ? rowToMessage(rows[0]) : undefined
}

/** Mark a message read, but only for the customer(s) it belongs to. */
export async function markIncomingSwiftRead(id: string, userIds: string[]): Promise<void> {
  await ensureTable()
  if (!userIds.length) return
  await query(
    `UPDATE incoming_swift_messages SET read_at = now()
       WHERE id = $1 AND user_id = ANY($2) AND read_at IS NULL`,
    [id, userIds],
  )
}

/** Mark every unread message that concerns the customer(s) read. Returns the
 *  number of messages that were flipped to read. */
export async function markAllIncomingSwiftRead(userIds: string[]): Promise<number> {
  await ensureTable()
  if (!userIds.length) return 0
  const { rowCount } = await query(
    `UPDATE incoming_swift_messages SET read_at = now()
       WHERE user_id = ANY($1) AND status IN ('matched','assigned') AND read_at IS NULL`,
    [userIds],
  )
  return rowCount ?? 0
}

/**
 * Messages that concern a platform account (matched or admin-assigned) and are
 * awaiting the administrator's credit execution — i.e. not yet credited.
 */
export async function listCreditableIncomingSwift(): Promise<IncomingSwiftMessage[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM incoming_swift_messages
       WHERE status IN ('matched','assigned') AND user_id IS NOT NULL AND credited_at IS NULL
     ORDER BY created_at DESC`,
  )
  return rows.map(rowToMessage)
}

/**
 * Stamp a message credited. Guarded on `credited_at IS NULL` so a concurrent /
 * repeat call never double-credits — returns null when it was already credited.
 */
export async function markIncomingSwiftCredited(
  id: string,
  entryId: string,
  amountLabel: string,
): Promise<IncomingSwiftMessage | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE incoming_swift_messages
       SET credited_at = now(), credited_entry_id = $2, credited_amount = $3
     WHERE id = $1 AND credited_at IS NULL
     RETURNING *`,
    [id, entryId, amountLabel],
  )
  return rows[0] ? rowToMessage(rows[0]) : null
}

/**
 * Administrator declines an inbound message instead of crediting it. Guarded on
 * `credited_at IS NULL` so a message that was already credited can never be
 * flipped to rejected. Setting status `rejected` removes it from both the admin
 * "Awaiting credit" queue and the customer's SWIFT inbox (both filter to
 * matched/assigned). Returns null when the message was missing or already credited.
 */
export async function rejectIncomingSwift(id: string, reason: string): Promise<IncomingSwiftMessage | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE incoming_swift_messages
       SET status = 'rejected', match_reason = $2
     WHERE id = $1 AND credited_at IS NULL AND status <> 'rejected'
     RETURNING *`,
    [id, reason],
  )
  return rows[0] ? rowToMessage(rows[0]) : null
}

/** Administrator manual resolution: attach an unmatched message to a customer. */
export async function assignIncomingSwift(
  id: string,
  userId: string,
  accountId: string | null,
  accountHolder: string | null,
  reason: string,
): Promise<IncomingSwiftMessage | null> {
  await ensureTable()
  const { rows } = await query(
    `UPDATE incoming_swift_messages
       SET user_id = $2, status = 'assigned', matched_account_id = $3,
           matched_account_holder = $4, match_reason = $5, read_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id, userId, accountId, accountHolder, reason],
  )
  return rows[0] ? rowToMessage(rows[0]) : null
}
