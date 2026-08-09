"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  resolveCurrentSession,
  resolveDataOwnerIdFor,
  resolveEnvironmentMemberIds,
  resolveAccountProfileById,
} from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { insertNotification } from "@/lib/notifications-db"
import { parseSwiftMessage } from "@/lib/swift-mt"
import { matchIncomingSwift, type MatchAccount } from "@/lib/incoming-swift-match"
import {
  assignIncomingSwift,
  getIncomingSwiftById,
  insertIncomingSwift,
  listIncomingSwiftForUsers,
  listUnmatchedIncomingSwift,
  markIncomingSwiftRead,
  type IncomingSwiftMessage,
} from "@/lib/incoming-swift-db"
import type { GatewayAccount } from "@/lib/gateway-store"

// ---------------------------------------------------------------------------
// Match targets — every user's ACTIVE gateway (bank) account carries an
// assigned IBAN + BIC and is linked to an owning customer. Mirrors the reader
// used by the reconciliation engine.
// ---------------------------------------------------------------------------

async function readActiveMatchAccounts(): Promise<MatchAccount[]> {
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_accounts (
       user_id text NOT NULL, request_id text NOT NULL, status text NOT NULL,
       submitted_at timestamptz, decided_at timestamptz,
       updated_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
       PRIMARY KEY (user_id, request_id))`,
  )
  const { rows } = await query(`SELECT payload, request_id FROM gateway_accounts WHERE status = 'active'`)
  return rows.map((row: Record<string, unknown>) => {
    const payload = (row.payload as GatewayAccount) ?? ({} as GatewayAccount)
    return {
      userId: payload.userId,
      accountId: row.request_id as string,
      accountHolder: payload.accountHolder ?? "",
      company: payload.company,
      iban: payload.coordinates?.iban,
      bic: payload.coordinates?.bic,
      currency: payload.currency,
    }
  })
}

// ---------------------------------------------------------------------------
// Extraction — pull the receiving-side fields out of a parsed SWIFT message.
// ---------------------------------------------------------------------------

function firstLine(lines?: string[]): string {
  return (lines ?? []).find(Boolean) ?? ""
}

function extractIncoming(raw: string) {
  const msg = parseSwiftMessage(raw)
  const beneficiaryParty = msg.beneficiary ?? msg.beneficiaryInstitution
  const beneficiaryIban = beneficiaryParty?.account ?? ""
  const beneficiaryName = firstLine(msg.beneficiary?.nameAndAddress) || beneficiaryParty?.bic || ""
  // The receiving institution: the account-with-institution (:57a:) is the
  // beneficiary's bank; fall back to the message destination in the header.
  const receiverBic =
    msg.accountWithInstitution?.bic ??
    msg.beneficiaryInstitution?.bic ??
    msg.applicationHeader?.counterpartyBic ??
    ""
  const senderBic =
    msg.orderingInstitution?.bic ?? msg.orderingCustomer?.bic ?? msg.basicHeader?.senderBic ?? ""
  const orderingCustomer = firstLine(msg.orderingCustomer?.nameAndAddress) || senderBic || ""
  const reference =
    (msg.remittanceInfo?.replace(/\n/g, " ").trim() || msg.senderReference || msg.relatedReference || "") ?? ""
  return {
    msg,
    beneficiaryIban,
    beneficiaryName,
    receiverBic,
    senderBic,
    orderingCustomer,
    reference,
  }
}

function fmtMoney(amount: number | undefined, currency: string | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return ""
  return `${currency ? `${currency} ` : ""}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ---------------------------------------------------------------------------
// Admin: ingest an incoming SWIFT message, auto-match it, notify + audit.
// ---------------------------------------------------------------------------

export interface IngestResult {
  ok: boolean
  error?: string
  status?: IncomingSwiftMessage["status"]
  matchedTo?: string | null
  reason?: string
  message?: IncomingSwiftMessage
}

export async function ingestIncomingSwiftAdmin(passcode: string, raw: string): Promise<IngestResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  const text = (raw ?? "").trim()
  if (!text) return { ok: false, error: "Paste a SWIFT FIN message to ingest." }

  try {
    const ex = extractIncoming(text)
    const accounts = await readActiveMatchAccounts()
    const match = matchIncomingSwift(
      { beneficiaryIban: ex.beneficiaryIban, receiverBic: ex.receiverBic, beneficiaryName: ex.beneficiaryName },
      accounts,
    )

    const amountStr = fmtMoney(ex.msg.amount, ex.msg.currency)
    const stored = await insertIncomingSwift({
      userId: match.status === "matched" ? match.account!.userId : null,
      status: match.status === "matched" ? "matched" : "unmatched",
      messageType: ex.msg.type,
      senderBic: ex.senderBic,
      receiverBic: ex.receiverBic,
      beneficiaryIban: ex.beneficiaryIban,
      beneficiaryName: ex.beneficiaryName,
      orderingCustomer: ex.orderingCustomer,
      amount: amountStr || null,
      currency: ex.msg.currency ?? null,
      reference: ex.reference || null,
      valueDate: ex.msg.valueDate ?? null,
      uetr: ex.msg.uetr ?? null,
      raw: text,
      matchedAccountId: match.account?.accountId ?? null,
      matchedAccountHolder: match.account?.accountHolder ?? null,
      bicConfirmed: match.bicConfirmed,
      matchReason: match.reason,
    })

    if (match.status === "matched" && match.account) {
      // Notify the matched customer — they see it at next login / on poll.
      await insertNotification({
        userId: match.account.userId,
        tone: "info",
        title: `SWIFT ${ex.msg.type} received`,
        body: `A ${ex.msg.type} message${amountStr ? ` for ${amountStr}` : ""} naming your account (IBAN ${ex.beneficiaryIban}) has been received. View it in your SWIFT Messages.`,
        href: "/dashboard/swift",
      })

      await logActivity({
        action: `Incoming ${ex.msg.type} auto-matched to ${match.account.accountHolder} and delivered to their SWIFT Messages`,
        category: "SWIFT",
        details: {
          summary: `Inbound SWIFT ${ex.msg.type} (ref ${ex.reference || "n/a"}${ex.msg.uetr ? `, UETR ${ex.msg.uetr}` : ""}) was matched by beneficiary IBAN ${ex.beneficiaryIban}${ex.receiverBic ? ` and receiver BIC ${ex.receiverBic}` : ""} to gateway account ${match.account.accountId} (${match.account.accountHolder}). ${match.reason}`,
          messageId: stored.id,
          matchedUserId: match.account.userId,
          matchedAccountId: match.account.accountId,
          bicConfirmed: String(match.bicConfirmed),
          amount: amountStr || "n/a",
        },
      })
    } else {
      await logActivity({
        action: `Incoming ${ex.msg.type} could not be matched to a platform account — flagged for review`,
        category: "SWIFT",
        details: {
          summary: `Inbound SWIFT ${ex.msg.type} (ref ${ex.reference || "n/a"}) with beneficiary IBAN ${ex.beneficiaryIban || "none"} and receiver BIC ${ex.receiverBic || "none"} did not resolve to a single active platform account. ${match.reason}`,
          messageId: stored.id,
          amount: amountStr || "n/a",
          decision: "Unmatched — administrator review required",
        },
      })
    }

    return {
      ok: true,
      status: stored.status,
      matchedTo: match.account?.accountHolder ?? null,
      reason: match.reason,
      message: stored,
    }
  } catch (err) {
    console.log("[v0] ingestIncomingSwiftAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not ingest the SWIFT message." }
  }
}

// ---------------------------------------------------------------------------
// Customer: read the SWIFT messages delivered to my account.
// ---------------------------------------------------------------------------

async function sessionMemberIds(): Promise<{ ok: boolean; ids: string[] }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, ids: [] }
  const ids = new Set<string>(await resolveEnvironmentMemberIds(session.id))
  ids.add(session.id)
  const owner = await resolveDataOwnerIdFor(session.id)
  if (owner) ids.add(owner)
  return { ok: true, ids: [...ids] }
}

export async function getMyIncomingSwiftMessages(): Promise<{ ok: boolean; messages: IncomingSwiftMessage[] }> {
  const { ok, ids } = await sessionMemberIds()
  if (!ok) return { ok: false, messages: [] }
  try {
    const messages = await listIncomingSwiftForUsers(ids)
    return { ok: true, messages }
  } catch (err) {
    console.log("[v0] getMyIncomingSwiftMessages failed:", (err as Error).message)
    return { ok: true, messages: [] }
  }
}

export async function markMyIncomingSwiftRead(id: string): Promise<{ ok: boolean }> {
  const { ok, ids } = await sessionMemberIds()
  if (!ok) return { ok: false }
  try {
    await markIncomingSwiftRead(id, ids)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Admin: unmatched review queue + manual assignment.
// ---------------------------------------------------------------------------

export async function listUnmatchedIncomingSwiftAdmin(
  passcode: string,
): Promise<{ ok: boolean; error?: string; messages: IncomingSwiftMessage[] }> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed.", messages: [] }
  }
  try {
    return { ok: true, messages: await listUnmatchedIncomingSwift() }
  } catch {
    return { ok: true, messages: [] }
  }
}

export async function assignIncomingSwiftAdmin(
  passcode: string,
  id: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  const existing = await getIncomingSwiftById(id)
  if (!existing) return { ok: false, error: "Message not found." }

  try {
    const profile = await resolveAccountProfileById(userId)
    const accounts = await readActiveMatchAccounts()
    const acct = accounts.find((a) => a.userId === userId)
    const reason = `Manually assigned by administrator to ${profile?.fullName ?? userId}.`
    const updated = await assignIncomingSwift(id, userId, acct?.accountId ?? null, acct?.accountHolder ?? profile?.fullName ?? null, reason)
    if (!updated) return { ok: false, error: "Could not assign the message." }

    await insertNotification({
      userId,
      tone: "info",
      title: `SWIFT ${existing.messageType} received`,
      body: `A ${existing.messageType} message${existing.amount ? ` for ${existing.amount}` : ""} has been delivered to your account. View it in your SWIFT Messages.`,
      href: "/dashboard/swift",
    })

    await logActivity({
      action: `Unmatched incoming ${existing.messageType} manually assigned to ${profile?.fullName ?? userId}`,
      category: "SWIFT",
      details: {
        summary: `Administrator assigned previously-unmatched inbound SWIFT ${existing.messageType} (${existing.id}, beneficiary IBAN ${existing.beneficiaryIban || "none"}) to ${profile?.fullName ?? userId}.`,
        messageId: existing.id,
        matchedUserId: userId,
      },
    })

    return { ok: true }
  } catch (err) {
    console.log("[v0] assignIncomingSwiftAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not assign the message." }
  }
}
