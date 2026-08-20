// ---------------------------------------------------------------------------
// Bankeka (Bank Messenger) — shared, client-safe types & constants.
//
// This module is intentionally free of any server-only imports (no `pg`, no
// `server-only`) so both the Server Action layer and client components can
// import the same vocabulary. The DB layer lives in lib/bankeka-db.ts and the
// session-scoped actions in app/actions/bankeka.ts.
// ---------------------------------------------------------------------------

/**
 * The reserved participant id representing "MCC Capital · Administration".
 * Administrator broadcasts are sent *from* this id, and the admin console's
 * inbox shows exactly (and only) the threads where this id is a participant —
 * which is what keeps client-to-client conversations invisible to the admin.
 */
export const BANKEKA_ADMIN_ID = "mcc_admin"

export const BANKEKA_ADMIN_LABEL = "MCC Capital · Administration"
export const BANKEKA_ADMIN_INITIALS = "MC"

/** Delivery lifecycle of a single message, BlackBerry-Messenger style. */
export type MessageStatus = "sent" | "delivered" | "read"

/**
 * A document / image attached to a message. Files are uploaded directly from
 * the browser to Vercel Blob (via /api/bankeka/blob-upload) and only their
 * public URL + metadata are stored on the message — never the bytes.
 */
export interface BankekaAttachment {
  name: string
  url: string
  size?: number
  contentType?: string
}

/** File types accepted as message attachments, and the per-file size cap. */
export const BANKEKA_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
]
export const BANKEKA_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE = 6

/** A message as exposed to the client (no internal columns, fully serializable). */
export interface BankekaMessage {
  id: string
  senderId: string
  recipientId: string
  body: string
  /** Files attached to this message (may be empty). */
  attachments: BankekaAttachment[]
  /** "direct" = person-to-person, "broadcast" = part of an admin broadcast. */
  kind: "direct" | "broadcast"
  createdAt: string
  /** True when the *current viewer* is the sender of this message. */
  outgoing: boolean
  /** Status is only meaningful for outgoing messages (what happened to it). */
  status: MessageStatus
}

/** A lightweight identity used to render avatars / names in the messenger. */
export interface BankekaParticipant {
  id: string
  name: string
  company: string
  initials: string
  /** True for the reserved MCC Capital administration participant. */
  isAdmin: boolean
}

/** One row in the conversation list: a counterpart + the latest message + unread. */
export interface BankekaConversation {
  participant: BankekaParticipant
  lastMessage: string
  lastMessageAt: string
  /** True when the most recent message was sent by the current viewer. */
  lastOutgoing: boolean
  /** Status of the last message when it was outgoing (for the ticks preview). */
  lastStatus: MessageStatus
  unread: number
}

/** Compact metadata row for the administrator compliance audit trail. Never
 *  contains message bodies — only who messaged whom and when. */
export interface BankekaAuditEntry {
  id: string
  actorLabel: string
  action: "message" | "broadcast" | "reply"
  recipientLabel: string
  charCount: number
  createdAt: string
}

/** Canonical, order-independent key for a 1:1 thread between two participants. */
export function threadKey(a: string, b: string): string {
  return [a, b].sort().join("|")
}
