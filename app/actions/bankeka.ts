"use server"

// ---------------------------------------------------------------------------
// Bankeka (Bank Messenger) — Server Actions.
//
// Two audiences share this module:
//  - Clients (customers & staff) use the session-scoped actions. Identity is
//    resolved from the authoritative httpOnly session cookie, NEVER from a
//    client-supplied id, so a user can only ever read/write their own threads.
//  - The administrator console uses the passcode-gated `admin*` actions, which
//    operate strictly as the reserved MCC Capital administration participant and
//    therefore can only see threads that participant is part of.
//
// Privacy guarantee: a thread read is always constrained to the exact pair of
// participants (see lib/bankeka-db.ts), so no third party can observe a
// conversation they are not in.
// ---------------------------------------------------------------------------

import { resolveCurrentSession } from "@/lib/session-user"
import { getDynamicUserById, getDynamicUserByEmail, listDynamicUsers } from "@/lib/admin-users-db"
import { adminActionAuthorized, resolveActingUserId, isAdminEmail } from "@/lib/admin-auth"
import { logActivity } from "@/app/actions/log-activity"
import { insertNotification } from "@/lib/notifications-db"
import {
  insertMessage,
  hideMessageForUser,
  markThreadRead,
  markAllDelivered,
  getThreadMessages,
  getUnreadCount,
  getMessagesForParticipant,
  recordAudit,
  listAudit,
  type MessageRow,
} from "@/lib/bankeka-db"
import {
  BANKEKA_ADMIN_ID,
  BANKEKA_ADMIN_LABEL,
  BANKEKA_ADMIN_INITIALS,
  BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE,
  type BankekaMessage,
  type BankekaParticipant,
  type BankekaConversation,
  type BankekaAuditEntry,
  type BankekaAttachment,
  type MessageStatus,
} from "@/lib/bankeka-shared"

const MAX_BODY = 4000

/** A short, single-line preview of a message body for the bell notification. */
function notifyPreview(body: string, hadAttachment: boolean): string {
  const clean = body.replace(/\s+/g, " ").trim()
  if (!clean) return hadAttachment ? "Sent you a document." : "You have a new message."
  const trimmed = clean.length > 140 ? `${clean.slice(0, 139)}…` : clean
  return hadAttachment ? `${trimmed} (with attachment)` : trimmed
}

/**
 * Trust-boundary filter for caller-supplied attachments. Only accepts files
 * that actually landed on our Blob store (the upload route gates who may write
 * there), caps the count, and clamps the metadata — so a crafted request can
 * never inject an arbitrary/off-host link as a "document".
 */
function sanitizeAttachments(input: unknown): BankekaAttachment[] {
  if (!Array.isArray(input)) return []
  const out: BankekaAttachment[] = []
  for (const a of input.slice(0, BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE)) {
    const at = a as Record<string, unknown>
    const url = typeof at?.url === "string" ? at.url.trim() : ""
    if (!/^https:\/\/[a-z0-9.-]*\.public\.blob\.vercel-storage\.com\//i.test(url)) continue
    out.push({
      name: typeof at.name === "string" && at.name ? at.name.slice(0, 200) : "document",
      url,
      size: Number.isFinite(Number(at.size)) ? Number(at.size) : undefined,
      contentType: typeof at.contentType === "string" ? at.contentType.slice(0, 120) : undefined,
    })
  }
  return out
}

// --- Identity helpers ------------------------------------------------------

const adminParticipant: BankekaParticipant = {
  id: BANKEKA_ADMIN_ID,
  name: BANKEKA_ADMIN_LABEL,
  company: "MCC Capital",
  initials: BANKEKA_ADMIN_INITIALS,
  isAdmin: true,
}

// ---------------------------------------------------------------------------
// The Administrator Console is a ROLE, not a separate platform account. A real,
// authorized user temporarily activates it (by PIN); when they message a client
// privately they do so AS THEMSELVES — a real-user ↔ real-user conversation.
//
// The synthetic BANKEKA_ADMIN_ID identity is therefore used ONLY for one-to-many
// broadcasts (official announcements). It is never a participant in a private
// two-way thread anymore.
//
// `BANKEKA_OPERATOR_EMAIL` is the operator OF RECORD: the resting administration
// account that receives client-initiated support messages and is the target for
// any legacy synthetic-admin private thread. Whoever unlocks the console SENDS
// as their own real account (resolveActingUserId); the operator of record is
// only used when there is no specific sending operator (inbound support).
// ---------------------------------------------------------------------------
const BANKEKA_OPERATOR_EMAIL = "admin@mccgva.ch"

type OperatorRec = {
  id: string
  email: string
  status: string
  profile: { fullName?: string; shortName?: string; company?: string; initials?: string }
}

/** The real account that backs the administration for INBOUND messages (client
 *  → support) and as the fallback sender when a specific operator can't be
 *  resolved. Returns the full record so callers can build its participant. */
async function getOperatorOfRecord(): Promise<OperatorRec | null> {
  try {
    const rec = (await getDynamicUserByEmail(BANKEKA_OPERATOR_EMAIL)) as OperatorRec | null
    return rec && rec.status === "active" ? rec : null
  } catch {
    return null
  }
}

/**
 * The REAL account the administration console operates as. This is a SHARED
 * support inbox: EVERY admin (president, admin@mccgva.ch, a.koller, …) anchors
 * on the single OPERATOR OF RECORD, so a client enquiry — which always routes to
 * that operator — is visible to, and answerable by, whichever admin is on duty
 * (one unified thread per client, regardless of who replies). Only if the
 * operator of record can't be resolved do we fall back to the signed-in admin.
 * Callers are already PIN + admin gated, so the acting user is always an admin.
 */
async function resolveAdminAnchorId(): Promise<string | null> {
  const rec = await getOperatorOfRecord()
  if (rec?.id) return rec.id
  return await resolveActingUserId()
}

/** Build a client-facing participant for a real administration operator. The
 *  client sees the operator's REAL name & company (staff identity is not private
 *  client data), presented as an ordinary private contact — not the synthetic
 *  "Administrator" entity. */
function operatorParticipant(rec: {
  id: string
  email: string
  profile: { fullName?: string; shortName?: string; company?: string; initials?: string }
}): BankekaParticipant {
  return {
    id: rec.id,
    name: rec.profile.fullName || rec.profile.shortName || rec.email,
    company: rec.profile.company || "",
    initials: rec.profile.initials || rec.email.slice(0, 2).toUpperCase(),
    isAdmin: false,
  }
}

/**
 * FULL identity resolver — exposes the real name & company. This is used ONLY
 * for the administrator console and the compliance audit trail, both of which
 * are legitimately authorised to see who an account belongs to. It must NEVER
 * be used to build anything returned to an ordinary client.
 */
async function resolveParticipant(id: string): Promise<BankekaParticipant> {
  if (id === BANKEKA_ADMIN_ID) return adminParticipant
  try {
    const rec = await getDynamicUserById(id)
    if (rec) {
      return {
        id,
        name: rec.profile.fullName || rec.profile.shortName || rec.email,
        company: rec.profile.company || "",
        initials: rec.profile.initials || rec.email.slice(0, 2).toUpperCase(),
        isAdmin: false,
      }
    }
  } catch {
    // fall through to placeholder
  }
  return { id, name: "Unknown account", company: "", initials: "??", isAdmin: false }
}

/**
 * PRIVACY-PRESERVING resolver for everything shown to an ordinary client.
 *
 * A client must never learn another account's real name, company, or any other
 * profile data — they are only ever allowed to know the email address they
 * already had (which is how they reached the person in the first place). So a
 * counterpart is identified strictly by their email address; no names, no
 * companies, no account details are disclosed.
 */
async function resolveClientParticipant(id: string): Promise<BankekaParticipant> {
  if (id === BANKEKA_ADMIN_ID) return adminParticipant
  try {
    const rec = await getDynamicUserById(id)
    if (rec) {
      // Administration operators are staff acting in an official capacity — their
      // real name/company is NOT private client data, and the client is entitled
      // to know which real person they are negotiating a loan with. Everyone else
      // stays email-only so the client base can't be enumerated.
      if (isAdminEmail(rec.email)) return operatorParticipant(rec)
      return {
        id,
        name: rec.email, // identify by email only — never the real name
        company: "", // never disclose company / account data
        initials: rec.email.slice(0, 2).toUpperCase(),
        isAdmin: false,
      }
    }
  } catch {
    // fall through to placeholder
  }
  return { id, name: "Unknown account", company: "", initials: "??", isAdmin: false }
}

function statusOf(row: MessageRow): MessageStatus {
  if (row.readAt) return "read"
  if (row.deliveredAt) return "delivered"
  return "sent"
}

function toMessage(row: MessageRow, viewerId: string): BankekaMessage {
  return {
    id: row.id,
    senderId: row.senderId,
    recipientId: row.recipientId,
    body: row.body,
    attachments: row.attachments ?? [],
    kind: row.kind,
    createdAt: row.createdAt,
    outgoing: row.senderId === viewerId,
    status: statusOf(row),
  }
}

async function requireSessionId(): Promise<string | null> {
  const session = await resolveCurrentSession()
  return session?.id ?? null
}

// --- Conversation building (shared between client & admin) -----------------

async function buildConversations(
  viewerId: string,
  resolve: (id: string) => Promise<BankekaParticipant>,
): Promise<BankekaConversation[]> {
  const rows = await getMessagesForParticipant(viewerId)

  // Group by counterpart; rows arrive newest-first so the first row per
  // counterpart is the latest message.
  const byCounterpart = new Map<string, { last: MessageRow; unread: number }>()
  for (const row of rows) {
    const counterpart = row.senderId === viewerId ? row.recipientId : row.senderId
    const entry = byCounterpart.get(counterpart)
    const isUnread = row.recipientId === viewerId && !row.readAt
    if (!entry) {
      byCounterpart.set(counterpart, { last: row, unread: isUnread ? 1 : 0 })
    } else if (isUnread) {
      entry.unread += 1
    }
  }

  const conversations = await Promise.all(
    Array.from(byCounterpart.entries()).map(async ([counterpart, { last, unread }]) => {
      const participant = await resolve(counterpart)
      const conv: BankekaConversation = {
        participant,
        lastMessage: last.body,
        lastMessageAt: last.createdAt,
        lastOutgoing: last.senderId === viewerId,
        lastStatus: statusOf(last),
        unread,
      }
      return conv
    }),
  )

  conversations.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
  return conversations
}

// --- Client (session-scoped) actions ---------------------------------------

export interface ThreadResult {
  participant: BankekaParticipant
  messages: BankekaMessage[]
}

/** The signed-in user's conversation list (newest first). */
export async function listConversations(): Promise<BankekaConversation[]> {
  const me = await requireSessionId()
  if (!me) return []
  try {
    await markAllDelivered(me)
    return await buildConversations(me, resolveClientParticipant)
  } catch {
    return []
  }
}

/** Open a private thread with `otherId`; marks incoming messages as read. */
export async function getThread(otherId: string): Promise<ThreadResult | null> {
  const me = await requireSessionId()
  if (!me || !otherId || otherId === me) return null

  // The synthetic admin id is the client's BROADCAST inbox — one-way official
  // announcements from "MCC Capital · Administration". Opening it must show
  // those broadcast messages, keyed to the [me, mcc_admin] pair. Previously this
  // REDIRECTED to the real operator's (usually empty) two-way thread, so the
  // list showed the broadcast preview but tapping it opened a blank
  // "No messages yet" screen under the operator's real name. Return the actual
  // broadcast thread instead and mark it read (clearing the unread dot). A reply
  // still routes to the real operator via sendMessage's own redirect.
  if (otherId === BANKEKA_ADMIN_ID) {
    try {
      await markThreadRead(me, BANKEKA_ADMIN_ID)
      const rows = await getThreadMessages(me, BANKEKA_ADMIN_ID)
      const participant = await resolveClientParticipant(BANKEKA_ADMIN_ID)
      return { participant, messages: rows.map((r) => toMessage(r, me)) }
    } catch {
      return null
    }
  }

  if (otherId === me) return null
  try {
    await markThreadRead(me, otherId)
    const rows = await getThreadMessages(me, otherId)
    const participant = await resolveClientParticipant(otherId)
    return { participant, messages: rows.map((r) => toMessage(r, me)) }
  } catch {
    return null
  }
}

export type SendResult = { ok: true; message: BankekaMessage } | { ok: false; error: string }

/** Send a private message from the signed-in user to `otherId`. */
export async function sendMessage(
  otherId: string,
  body: string,
  attachments?: BankekaAttachment[],
): Promise<SendResult> {
  const me = await requireSessionId()
  if (!me) return { ok: false, error: "Your session has expired. Please sign in again." }
  const trimmed = (body ?? "").trim()
  const files = sanitizeAttachments(attachments)
  if (!trimmed && files.length === 0) return { ok: false, error: "Write a message or attach a document." }
  if (trimmed.length > MAX_BODY) return { ok: false, error: "Message is too long." }
  if (!otherId || otherId === me) return { ok: false, error: "Invalid recipient." }

  // The synthetic admin is broadcast-only; a client contacting "support"
  // actually messages the real operator of record, so their reply lands in a
  // genuine two-way thread the administration can answer from.
  const resolvedOther = otherId === BANKEKA_ADMIN_ID ? (await getOperatorOfRecord())?.id ?? null : otherId
  if (!resolvedOther || resolvedOther === me) return { ok: false, error: "Invalid recipient." }

  try {
    // Confirm the recipient is an ACTIVE real account. We never message
    // suspended/inactive/unknown ids.
    const rec = await getDynamicUserById(resolvedOther)
    if (!rec || rec.status !== "active") {
      return { ok: false, error: "Recipient not found." }
    }
    // Real identity is resolved ONLY for the compliance audit trail (admin-only).
    const recipient = await resolveParticipant(resolvedOther)
    const row = await insertMessage({ senderId: me, recipientId: resolvedOther, body: trimmed, attachments: files })
    const sender = await resolveParticipant(me)
    await recordAudit({
      actorId: me,
      actorLabel: `${sender.name}${sender.company ? ` (${sender.company})` : ""}`,
      action: isAdminEmail(rec.email) ? "reply" : "message",
      recipientId: resolvedOther,
      recipientLabel: `${recipient.name}${recipient.company ? ` (${recipient.company})` : ""}`,
      messageId: row.id,
      charCount: trimmed.length,
    })
    // When a client contacts the administration, fire a bell notification so the
    // operator gets a persistent, actionable signal even without Bankeka open
    // (otherwise a client enquiry only surfaces as an unread Messages badge).
    if (isAdminEmail(rec.email)) {
      try {
        await insertNotification({
          userId: resolvedOther,
          tone: "info",
          title: `New client enquiry from ${sender.name}${sender.company ? ` (${sender.company})` : ""}`,
          body: notifyPreview(trimmed, files.length > 0),
          href: "/dashboard/bankeka",
        })
      } catch (err) {
        console.log("[v0] bankeka client-enquiry notification failed:", (err as Error).message)
      }
    }
    return { ok: true, message: toMessage(row, me) }
  } catch {
    return { ok: false, error: "Could not send the message. Please try again." }
  }
}

/** Total unread count for the signed-in user (header badge + dashboard tile). */
export async function getMyUnreadCount(): Promise<number> {
  const me = await requireSessionId()
  if (!me) return 0
  try {
    await markAllDelivered(me)
    return await getUnreadCount(me)
  } catch {
    return 0
  }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Delete a single message for the signed-in user only ("delete for me").
 *
 * This is non-destructive: the message is merely hidden from this user's own
 * view — the other participant still sees it, and the compliance record is
 * untouched. The DB layer verifies the caller is a participant of the message,
 * so a user can only ever hide messages from their own threads. Works for both
 * received and sent messages.
 */
export async function deleteMessage(messageId: string): Promise<DeleteResult> {
  const me = await requireSessionId()
  if (!me) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (!messageId) return { ok: false, error: "Invalid message." }
  try {
    const ok = await hideMessageForUser(me, messageId)
    if (!ok) return { ok: false, error: "Message not found." }
    return { ok: true }
  } catch {
    return { ok: false, error: "Could not delete the message. Please try again." }
  }
}

/** The pinned administration contact, so support is always reachable without
 *  needing to know an email address. This is the REAL operator of record (a
 *  role-bearing account), not a synthetic entity — messaging it opens a genuine
 *  two-way thread. Falls back to the broadcast label only if no operator account
 *  is currently active. */
export async function getSupportContact(): Promise<BankekaParticipant | null> {
  const me = await requireSessionId()
  if (!me) return null
  const rec = await getOperatorOfRecord()
  return rec ? operatorParticipant(rec) : adminParticipant
}

export type FindRecipientResult =
  | { ok: true; participant: BankekaParticipant }
  | { ok: false; error: string }

/**
 * Look up a single recipient by their EXACT email address.
 *
 * This is the ONLY way a client can start a new conversation: there is no
 * browsable directory, so a user can only reach someone whose email address
 * they already know. The match is exact (no partial/prefix search) to prevent
 * enumeration of the client base, and the result is identified by the email
 * address alone — no real name, company, or account data is ever returned.
 */
export async function findRecipientByEmail(email: string): Promise<FindRecipientResult> {
  const me = await requireSessionId()
  if (!me) return { ok: false, error: "Your session has expired. Please sign in again." }

  const normalized = (email ?? "").trim().toLowerCase()
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: "Enter the full, exact email address." }
  }

  try {
    const rec = await getDynamicUserByEmail(normalized)
    // Self lookup: tell the user plainly (they already know it's their own email).
    if (rec && rec.id === me) {
      return { ok: false, error: "That is your own email address." }
    }
    // Unknown or non-active accounts return a single generic message so the
    // response can't be used to probe which emails belong to real accounts
    // beyond a plain "reachable / not reachable" needed to actually message.
    if (!rec || rec.status !== "active") {
      return { ok: false, error: "No reachable account matches that email address." }
    }
    return {
      ok: true,
      participant: {
        id: rec.id,
        name: rec.email, // identify by email only — never the real name
        company: "", // never disclose company / account data
        initials: rec.email.slice(0, 2).toUpperCase(),
        isAdmin: false,
      },
    }
  } catch {
    return { ok: false, error: "Could not complete the search. Please try again." }
  }
}

// --- Administrator (passcode-gated) actions --------------------------------

async function adminOk(passcode: string): Promise<boolean> {
  return adminActionAuthorized(passcode)
}

export type BroadcastResult = { ok: true; delivered: number } | { ok: false; error: string }

/**
 * Publish an administrator message to one, several, or all active clients. Each
 * recipient receives a private message from the MCC Capital administration
 * participant — they cannot see who else received it.
 */
export async function adminBroadcast(
  passcode: string,
  target: "all" | string[],
  body: string,
): Promise<BroadcastResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const trimmed = (body ?? "").trim()
  if (!trimmed) return { ok: false, error: "Message cannot be empty." }
  if (trimmed.length > MAX_BODY) return { ok: false, error: "Message is too long." }

  try {
    const all = (await listDynamicUsers()).filter((u) => u.status === "active")
    const recipients =
      target === "all" ? all.map((u) => u.id) : all.filter((u) => target.includes(u.id)).map((u) => u.id)
    if (recipients.length === 0) return { ok: false, error: "No active recipients selected." }

    const broadcastId = `bcast_${Date.now().toString(36)}`
    for (const rid of recipients) {
      const row = await insertMessage({
        senderId: BANKEKA_ADMIN_ID,
        recipientId: rid,
        body: trimmed,
        kind: "broadcast",
        broadcastId,
      })
      await recordAudit({
        actorId: BANKEKA_ADMIN_ID,
        actorLabel: BANKEKA_ADMIN_LABEL,
        action: "broadcast",
        recipientId: rid,
        recipientLabel: (await resolveParticipant(rid)).name,
        messageId: row.id,
        charCount: trimmed.length,
      })
      // Bell notification per recipient so a broadcast reaches clients who
      // don't currently have Bankeka open.
      try {
        await insertNotification({
          userId: rid,
          tone: "info",
          title: `New message from ${BANKEKA_ADMIN_LABEL}`,
          body: notifyPreview(trimmed, false),
          href: "/dashboard/bankeka",
        })
      } catch (err) {
        console.log("[v0] bankeka broadcast notification failed:", (err as Error).message)
      }
    }

    // A single audit-trail email for the whole broadcast (no per-recipient spam).
    await logActivity({
      action: `Administrator broadcast a Bankeka message to ${recipients.length} client${recipients.length === 1 ? "" : "s"}`,
      category: "Administration",
      details: {
        summary: `Administrator published a Bankeka broadcast to ${recipients.length} active client${recipients.length === 1 ? "" : "s"} (${target === "all" ? "all clients" : "selected clients"}).`,
        recipients: String(recipients.length),
        characters: String(trimmed.length),
      },
    })

    return { ok: true, delivered: recipients.length }
  } catch {
    return { ok: false, error: "Broadcast failed. Please try again." }
  }
}

/** Admin inbox: the real operator's two-way conversations. Anchored on the
 *  signed-in operator (the person who unlocked the console), so it shows genuine
 *  real-user ↔ client threads — not a synthetic admin account. */
export async function adminListConversations(passcode: string): Promise<BankekaConversation[]> {
  if (!(await adminOk(passcode))) return []
  const anchor = await resolveAdminAnchorId()
  if (!anchor) return []
  try {
    await markAllDelivered(anchor)
    return await buildConversations(anchor, resolveParticipant)
  } catch {
    return []
  }
}

/** Admin opens a thread with a specific client; marks incoming as read. */
export async function adminGetThread(passcode: string, otherId: string): Promise<ThreadResult | null> {
  if (!(await adminOk(passcode)) || !otherId) return null
  const anchor = await resolveAdminAnchorId()
  if (!anchor || anchor === otherId) return null
  try {
    await markThreadRead(anchor, otherId)
    const rows = await getThreadMessages(anchor, otherId)
    const participant = await resolveParticipant(otherId)
    return { participant, messages: rows.map((r) => toMessage(r, anchor)) }
  } catch {
    return null
  }
}

/** Admin replies to a client inside an existing admin thread. */
export async function adminReply(
  passcode: string,
  otherId: string,
  body: string,
  attachments?: BankekaAttachment[],
): Promise<SendResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const trimmed = (body ?? "").trim()
  const files = sanitizeAttachments(attachments)
  if (!trimmed && files.length === 0) return { ok: false, error: "Write a message or attach a document." }
  if (trimmed.length > MAX_BODY) return { ok: false, error: "Message is too long." }
  if (!otherId) return { ok: false, error: "Invalid recipient." }

  // Replies are sent AS THE OPERATOR OF RECORD (shared support inbox), so every
  // admin answers into one unified thread per client and the client sees a
  // single consistent operator identity — not a synthetic "Administrator".
  const anchor = await resolveAdminAnchorId()
  if (!anchor) return { ok: false, error: "Could not resolve the administrator account." }
  if (anchor === otherId) {
    return { ok: false, error: "You cannot open an administration thread with your own account." }
  }
  try {
    const operator = await resolveParticipant(anchor)
    const operatorLabel = `${operator.name}${operator.company ? ` (${operator.company})` : ""}`
    const row = await insertMessage({
      senderId: anchor,
      recipientId: otherId,
      body: trimmed,
      attachments: files,
    })
    await recordAudit({
      actorId: anchor,
      actorLabel: operatorLabel,
      action: "reply",
      recipientId: otherId,
      recipientLabel: (await resolveParticipant(otherId)).name,
      messageId: row.id,
      charCount: trimmed.length,
    })
    // Persistent bell notification so the client is alerted even when Bankeka
    // is closed (the chat-icon unread badge only shows once they look).
    try {
      await insertNotification({
        userId: otherId,
        tone: "info",
        title: `New message from ${operator.name}`,
        body: notifyPreview(trimmed, files.length > 0),
        href: "/dashboard/bankeka",
      })
    } catch (err) {
      console.log("[v0] bankeka reply notification failed:", (err as Error).message)
    }
    return { ok: true, message: toMessage(row, anchor) }
  } catch {
    return { ok: false, error: "Could not send the reply. Please try again." }
  }
}

/** Delete a message for the administration inbox only ("delete for me"). Hides
 *  it from the admin console view; the client still sees it and the compliance
 *  record is untouched. */
export async function adminDeleteMessage(passcode: string, messageId: string): Promise<DeleteResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!messageId) return { ok: false, error: "Invalid message." }
  const anchor = await resolveAdminAnchorId()
  if (!anchor) return { ok: false, error: "Could not resolve the administrator account." }
  try {
    const ok = await hideMessageForUser(anchor, messageId)
    if (!ok) return { ok: false, error: "Message not found." }
    return { ok: true }
  } catch {
    return { ok: false, error: "Could not delete the message. Please try again." }
  }
}

/** Unread count for the administration inbox (admin console badge). */
export async function adminUnreadCount(passcode: string): Promise<number> {
  if (!(await adminOk(passcode))) return 0
  const anchor = await resolveAdminAnchorId()
  if (!anchor) return 0
  try {
    await markAllDelivered(anchor)
    return await getUnreadCount(anchor)
  } catch {
    return 0
  }
}

/** The compliance audit trail (metadata only — never message bodies). */
export async function adminListAudit(passcode: string): Promise<BankekaAuditEntry[]> {
  if (!(await adminOk(passcode))) return []
  try {
    const rows = await listAudit(300)
    return rows.map((r) => ({
      id: r.id,
      actorLabel: r.actorLabel,
      action: r.action,
      recipientLabel: r.recipientLabel,
      charCount: r.charCount,
      createdAt: r.createdAt,
    }))
  } catch {
    return []
  }
}
