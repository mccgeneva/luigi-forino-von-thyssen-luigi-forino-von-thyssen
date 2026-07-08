import "server-only"
import { query } from "@/lib/db"

/**
 * Per-user notifications, stored in Neon so the server can push a message to a
 * specific client (e.g. "your payment was approved") that they see on their
 * next load, regardless of which device they used to submit the request.
 */

export type NotificationTone = "info" | "success" | "warning" | "error"

export interface NotificationRecord {
  id: string
  userId: string
  tone: NotificationTone
  title: string
  body: string
  /** Optional deep-link target within the dashboard (e.g. "/dashboard/payments"). */
  href: string | null
  read: boolean
  createdAt: string
}

export interface NewNotification {
  userId: string
  tone?: NotificationTone
  title: string
  body: string
  href?: string | null
}

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS user_notifications (
       id         text        PRIMARY KEY,
       user_id    text        NOT NULL,
       tone       text        NOT NULL DEFAULT 'info',
       title      text        NOT NULL DEFAULT '',
       body       text        NOT NULL DEFAULT '',
       href       text,
       read       boolean     NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(
    `CREATE INDEX IF NOT EXISTS user_notifications_user_idx ON user_notifications (user_id, created_at DESC)`,
  )
  ensured = true
}

function rowToNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tone: (row.tone as NotificationTone) ?? "info",
    title: (row.title as string) ?? "",
    body: (row.body as string) ?? "",
    href: (row.href as string) ?? null,
    read: Boolean(row.read),
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
  }
}

export async function insertNotification(n: NewNotification): Promise<NotificationRecord> {
  await ensureTable()
  const id = `NT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const { rows } = await query(
    `INSERT INTO user_notifications (id, user_id, tone, title, body, href)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, n.userId, n.tone ?? "info", n.title, n.body, n.href ?? null],
  )
  return rowToNotification(rows[0])
}

/**
 * Insert a notification with a CALLER-SUPPLIED deterministic id, ignoring the
 * write if that id already exists. This gives exactly-once delivery for events
 * that a lazy reconciler may re-attempt on every page load (e.g. one monthly
 * treasury-interest debit → one notification, never duplicated on reload).
 * Returns true only when a NEW row was actually created.
 */
export async function insertNotificationOnce(id: string, n: NewNotification): Promise<boolean> {
  await ensureTable()
  const { rowCount } = await query(
    `INSERT INTO user_notifications (id, user_id, tone, title, body, href)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO NOTHING`,
    [id, n.userId, n.tone ?? "info", n.title, n.body, n.href ?? null],
  )
  return (rowCount ?? 0) > 0
}

export async function listNotificationsForUser(userId: string, limit = 30): Promise<NotificationRecord[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  )
  return rows.map(rowToNotification)
}

export async function countUnreadForUser(userId: string): Promise<number> {
  await ensureTable()
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read = false`,
    [userId],
  )
  return Number(rows[0]?.n ?? 0)
}

export async function markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
  await ensureTable()
  if (ids && ids.length) {
    await query(`UPDATE user_notifications SET read = true WHERE user_id = $1 AND id = ANY($2)`, [userId, ids])
  } else {
    await query(`UPDATE user_notifications SET read = true WHERE user_id = $1`, [userId])
  }
}
