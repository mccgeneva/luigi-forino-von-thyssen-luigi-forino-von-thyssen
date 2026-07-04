// ---------------------------------------------------------------------------
// Bankeka (Bank Messenger) — Neon Postgres persistence layer (server-only).
//
// Stores private, person-to-person messages plus administrator broadcasts. Every
// row is a single directed message (sender → recipient). Privacy is enforced at
// the query layer: thread reads are always constrained to the *exact* pair of
// participants, so no third party (including an administrator) can read a
// conversation they are not part of.
//
// This module imports `pg` and is therefore server-only. It exposes plain async
// helpers consumed by the Server Action layer (app/actions/bankeka.ts).
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import { threadKey } from "@/lib/bankeka-shared"

export interface MessageRow {
  id: string
  threadKey: string
  senderId: string
  recipientId: string
  body: string
  kind: "direct" | "broadcast"
  broadcastId: string | null
  createdAt: string
  deliveredAt: string | null
  readAt: string | null
}

let ensured = false
async function ensureTables(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS bankeka_messages (
       id            text PRIMARY KEY,
       thread_key    text NOT NULL,
       sender_id     text NOT NULL,
       recipient_id  text NOT NULL,
       body          text NOT NULL,
       kind          text NOT NULL DEFAULT 'direct',
       broadcast_id  text,
       created_at    timestamptz NOT NULL DEFAULT now(),
       delivered_at  timestamptz,
       read_at       timestamptz
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS bankeka_thread_idx ON bankeka_messages (thread_key, created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS bankeka_recipient_idx ON bankeka_messages (recipient_id)`)
  // Per-user "delete for me" markers. Deleting a message is intentionally NON
  // destructive: it hides the message from the viewer who deleted it only, so
  // one participant can never erase a message from the other's inbox (or from
  // the compliance record). One row per (message, user).
  await query(
    `CREATE TABLE IF NOT EXISTS bankeka_hidden (
       message_id text NOT NULL,
       user_id    text NOT NULL,
       hidden_at  timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (message_id, user_id)
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS bankeka_hidden_user_idx ON bankeka_hidden (user_id)`)
  await query(
    `CREATE TABLE IF NOT EXISTS bankeka_audit (
       id              text PRIMARY KEY,
       actor_id        text NOT NULL,
       actor_label     text NOT NULL,
       action          text NOT NULL,
       recipient_id    text,
       recipient_label text,
       message_id      text,
       char_count      integer NOT NULL DEFAULT 0,
       created_at      timestamptz NOT NULL DEFAULT now()
     )`,
  )
  ensured = true
}

function iso(v: unknown): string | null {
  if (!v) return null
  return (v as Date)?.toISOString?.() ?? String(v)
}

function rowToMessage(row: Record<string, unknown>): MessageRow {
  return {
    id: row.id as string,
    threadKey: row.thread_key as string,
    senderId: row.sender_id as string,
    recipientId: row.recipient_id as string,
    body: row.body as string,
    kind: ((row.kind as string) === "broadcast" ? "broadcast" : "direct") as "direct" | "broadcast",
    broadcastId: (row.broadcast_id as string) ?? null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    deliveredAt: iso(row.delivered_at),
    readAt: iso(row.read_at),
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
}

// --- Writes ----------------------------------------------------------------

export interface InsertMessageInput {
  senderId: string
  recipientId: string
  body: string
  kind?: "direct" | "broadcast"
  broadcastId?: string | null
}

export async function insertMessage(input: InsertMessageInput): Promise<MessageRow> {
  await ensureTables()
  const id = newId("bk")
  const tk = threadKey(input.senderId, input.recipientId)
  const { rows } = await query(
    `INSERT INTO bankeka_messages (id, thread_key, sender_id, recipient_id, body, kind, broadcast_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [id, tk, input.senderId, input.recipientId, input.body, input.kind ?? "direct", input.broadcastId ?? null],
  )
  return rowToMessage(rows[0])
}

/**
 * Hide a single message for `userId` only ("delete for me"). Verifies the caller
 * is actually a participant of that message (sender or recipient) before writing,
 * so a user can only ever delete a message from a thread they belong to. Returns
 * true when a marker exists afterwards. Idempotent (safe to call twice).
 */
export async function hideMessageForUser(userId: string, messageId: string): Promise<boolean> {
  await ensureTables()
  const { rows } = await query(
    `SELECT id FROM bankeka_messages WHERE id = $1 AND (sender_id = $2 OR recipient_id = $2)`,
    [messageId, userId],
  )
  if (rows.length === 0) return false // not a participant / message doesn't exist
  await query(
    `INSERT INTO bankeka_hidden (message_id, user_id) VALUES ($1, $2)
     ON CONFLICT (message_id, user_id) DO NOTHING`,
    [messageId, userId],
  )
  return true
}

/** Mark every message addressed to `me` from `other` as read (right now). */
export async function markThreadRead(me: string, other: string): Promise<void> {
  await ensureTables()
  await query(
    `UPDATE bankeka_messages
        SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
      WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
    [me, other],
  )
}

/** Mark all messages addressed to `me` as delivered (they reached the client). */
export async function markAllDelivered(me: string): Promise<void> {
  await ensureTables()
  await query(
    `UPDATE bankeka_messages SET delivered_at = now()
      WHERE recipient_id = $1 AND delivered_at IS NULL`,
    [me],
  )
}

// --- Reads -----------------------------------------------------------------

/** All messages in the private thread between `me` and `other`, oldest first. */
export async function getThreadMessages(me: string, other: string): Promise<MessageRow[]> {
  await ensureTables()
  const tk = threadKey(me, other)
  const { rows } = await query(
    `SELECT m.* FROM bankeka_messages m
      WHERE m.thread_key = $1
        AND NOT EXISTS (
          SELECT 1 FROM bankeka_hidden h WHERE h.message_id = m.id AND h.user_id = $2
        )
      ORDER BY m.created_at ASC`,
    [tk, me],
  )
  return rows.map(rowToMessage)
}

/** Total number of unread messages addressed to `me`. */
export async function getUnreadCount(me: string): Promise<number> {
  await ensureTables()
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM bankeka_messages m
      WHERE m.recipient_id = $1 AND m.read_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM bankeka_hidden h WHERE h.message_id = m.id AND h.user_id = $1
        )`,
    [me],
  )
  return (rows[0]?.n as number) ?? 0
}

/** Every message where `me` is a participant, newest first (for the list view). */
export async function getMessagesForParticipant(me: string): Promise<MessageRow[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT m.* FROM bankeka_messages m
      WHERE (m.sender_id = $1 OR m.recipient_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM bankeka_hidden h WHERE h.message_id = m.id AND h.user_id = $1
        )
      ORDER BY m.created_at DESC`,
    [me],
  )
  return rows.map(rowToMessage)
}

// --- Audit -----------------------------------------------------------------

export interface AuditInput {
  actorId: string
  actorLabel: string
  action: "message" | "broadcast" | "reply"
  recipientId?: string | null
  recipientLabel?: string | null
  messageId?: string | null
  charCount: number
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await ensureTables()
  try {
    await query(
      `INSERT INTO bankeka_audit (id, actor_id, actor_label, action, recipient_id, recipient_label, message_id, char_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId("bka"),
        input.actorId,
        input.actorLabel,
        input.action,
        input.recipientId ?? null,
        input.recipientLabel ?? null,
        input.messageId ?? null,
        input.charCount,
      ],
    )
  } catch {
    // Audit is best-effort; a logging failure must never block a message send.
  }
}

export interface AuditRow {
  id: string
  actorLabel: string
  action: "message" | "broadcast" | "reply"
  recipientLabel: string
  charCount: number
  createdAt: string
}

export async function listAudit(limit = 200): Promise<AuditRow[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT * FROM bankeka_audit ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
    id: row.id as string,
    actorLabel: row.actor_label as string,
    action: ((row.action as string) || "message") as "message" | "broadcast" | "reply",
    recipientLabel: (row.recipient_label as string) ?? "—",
    charCount: (row.char_count as number) ?? 0,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  }))
}
