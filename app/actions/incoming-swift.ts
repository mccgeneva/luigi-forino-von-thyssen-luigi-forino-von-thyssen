"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized, adminEmails } from "@/lib/admin-auth"
import { getDynamicUserByEmail, listDynamicUsers } from "@/lib/admin-users-db"
import { extractCurrencyBankingCoordinates, currenciesWithBankingRows } from "@/lib/banking-coordinates"
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
  listCreditableIncomingSwift,
  markIncomingSwiftCredited,
  markIncomingSwiftRead,
  markAllIncomingSwiftRead,
  rejectIncomingSwift,
  type IncomingSwiftMessage,
} from "@/lib/incoming-swift-db"
import { convertCurrency } from "@/lib/fx"
import { incomingTransactionFee } from "@/lib/incoming-fees"
import { applyCashbackForOwner } from "@/lib/fee-cashback-db"
import { cashbackNote, applyCashback } from "@/lib/fee-cashback"
import { getFeeTiers } from "@/lib/tiered-fees-db"
import { upsertLedgerEntry, readLedgerEntries, availableByCurrency } from "@/lib/ledger-db"
import { getOverdraftStatusForOwner } from "@/lib/overdraft"
import { adminIssueInstrument } from "@/app/actions/approvals"
import { findInstrumentType } from "@/lib/instrument-marketplace"
import type { GatewayAccount } from "@/lib/gateway-store"
import type { LedgerEntry } from "@/lib/ledger-store"

/** FX spread applied when the received currency differs from the account. */
const GATEWAY_FX_FEE_RATE = 0.005

/**
 * Receipt fee charged when a blocked-funds bank guarantee (MT760 / SBLC) is
 * received into a customer's account. 0.2% of the undertaking face value, in the
 * guarantee's own currency, debited from the Master Account. If that currency
 * pocket is short it is auto-covered from the strongest funded currency by the
 * FX auto-cover pass in reconcileMyApprovedCredits (drawn across all currencies).
 */
const GUARANTEE_RECEIPT_FEE_RATE = 0.002

/**
 * Notify every authorized administrator (the admin-email allowlist resolved to
 * their platform accounts) that a customer-submitted SWIFT printout is awaiting
 * verification. This is what surfaces the submission in the admin's own
 * notification bell and links them straight to the delivery queue — without it
 * a customer upload sits silently in the "Awaiting credit" tab with no signal.
 * Best-effort: a notify failure never blocks the customer's submission.
 */
async function notifyAdminsOfCustomerSwift(opts: {
  holder: string
  messageType: string
  amountStr: string
}): Promise<void> {
  try {
    const emails = adminEmails()
    const admins = await Promise.all(
      emails.map((e) => getDynamicUserByEmail(e).catch(() => undefined)),
    )
    const seen = new Set<string>()
    await Promise.all(
      admins
        .filter((a): a is NonNullable<typeof a> => !!a && !seen.has(a.id) && (seen.add(a.id), true))
        .map((admin) =>
          insertNotification({
            userId: admin.id,
            tone: "info",
            title: `New SWIFT ${opts.messageType} awaiting verification`,
            body: `${opts.holder} uploaded a SWIFT ${opts.messageType} printout${
              opts.amountStr ? ` (${opts.amountStr})` : ""
            } for verification. Open the Administrator panel → Incoming SWIFT to review and action it.`,
            href: "/dashboard/admin?view=incomingswift",
          }).catch(() => undefined),
        ),
    )
  } catch {
    // Never let admin-notification failure affect the customer's submission.
  }
}

function normalizeIban(raw: string | undefined | null): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * A blocked-funds bank guarantee (MT760 / SBLC family) must NEVER be credited as
 * spendable cash — it is booked as a pledgeable instrument via
 * recordGuaranteeInstrumentAdmin. This is a defense-in-depth guard on top of the
 * message type: it also catches a guarantee that parsed imperfectly (e.g. a
 * "{2:MT760}" shorthand header a bank printout used) so the cash-credit path can
 * never book €25M as a balance. Detects the MT760 type, any parsed guarantee
 * undertaking, or a 760/767/768/769 guarantee-family header in the raw FIN.
 */
function looksLikeBlockedFundsGuarantee(parsed: ReturnType<typeof parseSwiftMessage>, raw: string): boolean {
  if (parsed.type === "MT760") return true
  if (parsed.guarantee && Number(parsed.guarantee.amount ?? 0) > 0) return true
  if (/\{\s*2\s*:\s*(?:MT)?[IO]?\s*7(?:60|61|65|67|68|69)\b/i.test(raw)) return true
  return false
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ---------------------------------------------------------------------------
// Match targets — an inbound SWIFT beneficiary IBAN can name EITHER:
//   (1) a customer's ACTIVE gateway (Collect-funds) account, OR
//   (2) a customer's OWN master-account banking (the primary EUR settlement
//       account PLUS each per-currency USD/GBP/CHF account, which may each be a
//       DIFFERENT IBAN) stored on their profile.
// We scan BOTH so a message addressed to a customer's real bank IBAN matches —
// previously only gateway accounts were scanned, so a genuine master-banking
// IBAN (e.g. DE95…3521 25) came back "no active platform account holds it".
// Mirrors the master-banking scan used by the outgoing-payment reconciler.
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
  const accounts: MatchAccount[] = rows.map((row: Record<string, unknown>) => {
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

  // Add every customer's OWN master-account banking IBANs (primary + per
  // currency). Dedup per (owner, IBAN) so a customer who lists the same IBAN
  // under several currency labels — or an IBAN already present as a gateway
  // account for that same owner — is not added twice (which would otherwise make
  // the matcher see "multiple accounts share the IBAN" and refuse to match).
  try {
    const seen = new Set<string>(
      accounts
        .filter((a) => a.iban)
        .map((a) => `${a.userId}::${normalizeIban(a.iban)}`),
    )
    const users = await listDynamicUsers()
    for (const u of users) {
      const bankingRows = u.profile?.banking
      if (!bankingRows || bankingRows.length === 0) continue
      const holder = u.profile?.fullName || u.profile?.company || u.email || ""
      const currencies = ["EUR", ...currenciesWithBankingRows(bankingRows)]
      for (const cur of currencies) {
        const c = extractCurrencyBankingCoordinates(bankingRows, cur)
        const iban = normalizeIban(c.iban)
        if (!iban) continue
        const key = `${u.id}::${iban}`
        if (seen.has(key)) continue
        seen.add(key)
        accounts.push({
          userId: u.id,
          accountId: `master-${u.id}-${cur}`,
          accountHolder: holder,
          company: u.profile?.company,
          iban: c.iban ?? undefined,
          bic: c.bic ?? undefined,
          currency: cur,
        })
      }
    }
  } catch (err) {
    console.log("[v0] readActiveMatchAccounts master-banking scan failed:", (err as Error).message)
  }

  return accounts
}

/**
 * Read the full active gateway (bank) account payload for a matched customer.
 * Prefers the exact matched account id; otherwise falls back to the customer's
 * single active account. Used by the credit executor to resolve the account
 * currency, partner bank and reference exactly like the reconciliation engine.
 */
async function readActiveGatewayAccount(
  userId: string,
  accountId: string | null,
): Promise<GatewayAccount | null> {
  const { rows } = await query(
    `SELECT payload, request_id FROM gateway_accounts WHERE user_id = $1 AND status = 'active'`,
    [userId],
  )
  if (!rows.length) return null
  const mapped = rows.map((row: Record<string, unknown>) => {
    const payload = (row.payload as GatewayAccount) ?? ({} as GatewayAccount)
    return { ...payload, id: (row.request_id as string) ?? payload.id }
  })
  return (accountId ? mapped.find((a) => a.id === accountId) : undefined) ?? mapped[0] ?? null
}

// ---------------------------------------------------------------------------
// Extraction — pull the receiving-side fields out of a parsed SWIFT message.
// ---------------------------------------------------------------------------

function firstLine(lines?: string[]): string {
  return (lines ?? []).find(Boolean) ?? ""
}

function extractIncoming(raw: string) {
  const msg = parseSwiftMessage(raw)
  // An MT760 (bank guarantee / SBLC) carries its parties + amount inside the
  // guarantee block (:50: applicant, :59: beneficiary, :32B:), NOT the MT103
  // fields (msg.beneficiary / msg.orderingCustomer), so we must fall back to it
  // — otherwise the beneficiary IBAN comes back blank and the ordering party
  // wrongly shows the header sender BIC instead of the applicant's name.
  const g = msg.guarantee
  const beneficiaryParty = msg.beneficiary ?? g?.beneficiary ?? msg.beneficiaryInstitution
  const beneficiaryIban = beneficiaryParty?.account ?? ""
  const beneficiaryName = firstLine(beneficiaryParty?.nameAndAddress) || beneficiaryParty?.bic || ""
  // The receiving institution: the account-with-institution (:57a:) is the
  // beneficiary's bank; fall back to the message destination in the header.
  const receiverBic =
    msg.accountWithInstitution?.bic ??
    msg.beneficiaryInstitution?.bic ??
    g?.beneficiary?.bic ??
    msg.applicationHeader?.counterpartyBic ??
    ""
  const senderBic =
    msg.orderingInstitution?.bic ?? msg.orderingCustomer?.bic ?? g?.applicant?.bic ?? msg.basicHeader?.senderBic ?? ""
  // Instructing / ordering party: MT103 :50a: (msg.orderingCustomer) or an
  // MT760 applicant (:50:). Only fall back to the sender BIC when there is NO
  // named party — otherwise the card shows a BIC where a name belongs.
  const orderingParty = msg.orderingCustomer ?? g?.applicant
  const orderingCustomer = firstLine(orderingParty?.nameAndAddress) || orderingParty?.bic || senderBic || ""
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

export async function markAllMyIncomingSwiftRead(): Promise<{ ok: boolean; count: number }> {
  const { ok, ids } = await sessionMemberIds()
  if (!ok) return { ok: false, count: 0 }
  try {
    const count = await markAllIncomingSwiftRead(ids)
    return { ok: true, count }
  } catch {
    return { ok: false, count: 0 }
  }
}

// ---------------------------------------------------------------------------
// Customer: upload a SWIFT printout (e.g. an inbound MT760 the customer was
// informed of) and submit it to the platform. The message is attributed to the
// uploader and lands in the administrator's verify queue (status 'assigned',
// not yet credited) — for an MT760 the admin then books it as a pledgeable
// blocked-funds guarantee via recordGuaranteeInstrumentAdmin. Never credits or
// books anything itself; verification stays with the administrator.
// ---------------------------------------------------------------------------

export interface SubmitUploadInput {
  /** The SWIFT FIN message text (recovered from the printout, customer-confirmed). */
  raw: string
  /** Blob pathname of the uploaded source printout, if the customer attached one. */
  sourceDocPathname?: string | null
  /** Original filename of the uploaded printout. */
  sourceDocName?: string | null
}

export interface SubmitUploadResult {
  ok: boolean
  error?: string
  messageId?: string
  messageType?: string
  amount?: string
}

export async function submitIncomingSwiftUpload(input: SubmitUploadInput): Promise<SubmitUploadResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "You must be signed in to submit a SWIFT printout." }

  const text = (input.raw ?? "").trim()
  if (!text) return { ok: false, error: "Provide the SWIFT FIN message text from the printout." }

  try {
    const ex = extractIncoming(text)
    if (!ex.msg.type) {
      return {
        ok: false,
        error:
          "That does not look like a valid SWIFT message. Paste the full FIN text (with the :20:, :32B:/:39:, :59: fields) from the printout.",
      }
    }

    // Resolve the uploader's display name for the queue.
    const profile = await resolveAccountProfileById(session.id)
    const holder = profile?.fullName || profile?.company || session.id
    const amountStr = fmtMoney(ex.msg.amount, ex.msg.currency)

    const stored = await insertIncomingSwift({
      // Attributed to the uploader: it is THEIR inbound message. It surfaces in
      // their own SWIFT inbox and in the admin verify queue simultaneously.
      userId: session.id,
      status: "assigned",
      messageType: ex.msg.type,
      senderBic: ex.senderBic,
      receiverBic: ex.receiverBic,
      beneficiaryIban: ex.beneficiaryIban,
      beneficiaryName: ex.beneficiaryName || holder,
      orderingCustomer: ex.orderingCustomer,
      amount: amountStr || null,
      currency: ex.msg.currency || null,
      reference: ex.reference || null,
      valueDate: ex.msg.valueDate || null,
      uetr: ex.msg.uetr || null,
      raw: text,
      matchedAccountId: null,
      matchedAccountHolder: holder,
      bicConfirmed: false,
      matchReason: "Customer-uploaded SWIFT printout — awaiting administrator verification.",
      customerSubmitted: true,
      sourceDocPathname: input.sourceDocPathname ?? null,
      sourceDocName: input.sourceDocName ?? null,
    })

    await insertNotification({
      userId: session.id,
      tone: "info",
      title: `SWIFT ${ex.msg.type} printout submitted`,
      body:
        ex.msg.type === "MT760"
          ? `Your MT760 blocked-funds guarantee${amountStr ? ` (${amountStr})` : ""} was submitted for verification. Once an administrator confirms it, it will be booked to your Bank Instruments and you can pledge it for a treasury leverage line.`
          : `Your SWIFT ${ex.msg.type} printout${amountStr ? ` (${amountStr})` : ""} was submitted for administrator verification.`,
      href: "/dashboard/swift",
    })

    // Signal the administrators so the submission surfaces in their notification
    // bell (and not only inside the SWIFT delivery tab they must remember to open).
    await notifyAdminsOfCustomerSwift({ holder, messageType: ex.msg.type, amountStr })

    await logActivity({
      action: `Uploaded a SWIFT ${ex.msg.type} printout${amountStr ? ` (${amountStr})` : ""} for verification`,
      category: "SWIFT",
      details: {
        summary: `Customer ${holder} uploaded a SWIFT ${ex.msg.type} printout (${stored.id}${ex.beneficiaryIban ? `, beneficiary IBAN ${ex.beneficiaryIban}` : ""}${ex.msg.uetr ? `, UETR ${ex.msg.uetr}` : ""}) and submitted it to the platform for administrator verification.`,
        messageId: stored.id,
        messageType: ex.msg.type,
        amount: amountStr || "n/a",
        sourceDocument: input.sourceDocName || "(FIN text only)",
      },
    })

    return { ok: true, messageId: stored.id, messageType: ex.msg.type, amount: amountStr || undefined }
  } catch (err) {
    console.log("[v0] submitIncomingSwiftUpload failed:", (err as Error).message)
    return { ok: false, error: "Could not submit the SWIFT printout. Please try again." }
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

// ---------------------------------------------------------------------------
// Admin: execute the credit for a verified inbound SWIFT message.
//
// Only messages that concern a platform bank account (status matched/assigned
// with an owning customer) can be credited. The funds are posted to that
// customer's Master Account ledger — mirroring the reconciliation credit engine
// (data-owner ledger, deterministic idempotent id, automatic FX into the
// account currency) — then the customer is notified and the action is audited.
// ---------------------------------------------------------------------------

export async function listCreditableIncomingSwiftAdmin(
  passcode: string,
): Promise<{ ok: boolean; error?: string; messages: IncomingSwiftMessage[] }> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed.", messages: [] }
  }
  try {
    return { ok: true, messages: await listCreditableIncomingSwift() }
  } catch {
    return { ok: true, messages: [] }
  }
}

export interface RejectResult {
  ok: boolean
  error?: string
  alreadyResolved?: boolean
}

/**
 * Administrator DECLINES an inbound message instead of crediting it. Crediting
 * is not mandatory — a message that is unverifiable, a duplicate, or should not
 * be booked can be rejected. Guarded so an already-credited message can't be
 * rejected. On success the message leaves the "Awaiting credit" queue and the
 * customer's inbox, the customer is notified, and the decision is audited.
 */
export async function rejectIncomingSwiftAdmin(
  passcode: string,
  id: string,
  reason?: string,
): Promise<RejectResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }

  const message = await getIncomingSwiftById(id)
  if (!message) return { ok: false, error: "Message not found." }
  if (message.creditedAt) {
    return { ok: false, alreadyResolved: true, error: "This message was already credited and cannot be rejected." }
  }
  if (message.status === "rejected") {
    return { ok: false, alreadyResolved: true, error: "This message was already rejected." }
  }

  const trimmed = (reason ?? "").trim()
  const finalReason = trimmed
    ? `Rejected by the administrator: ${trimmed}`
    : "Rejected by the administrator after review."

  try {
    const updated = await rejectIncomingSwift(id, finalReason)
    if (!updated) {
      return { ok: false, alreadyResolved: true, error: "This message was already resolved." }
    }

    if (message.userId) {
      await insertNotification({
        userId: message.userId,
        tone: "warning",
        title: `SWIFT ${message.messageType} declined`,
        body: `Your inbound SWIFT ${message.messageType}${
          message.amount ? ` (${message.amount})` : ""
        } was reviewed and could not be credited.${trimmed ? ` Reason: ${trimmed}` : ""} Please contact us if you believe this is an error.`,
        href: "/dashboard/swift",
      }).catch(() => undefined)
    }

    await logActivity({
      action: `Inbound SWIFT ${message.messageType} rejected${message.matchedAccountHolder ? ` for ${message.matchedAccountHolder}` : ""}`,
      category: "SWIFT",
      details: {
        summary: `Administrator declined inbound SWIFT ${message.messageType} (${message.id}, beneficiary IBAN ${message.beneficiaryIban || "n/a"}${message.uetr ? `, UETR ${message.uetr}` : ""}). ${finalReason}`,
        messageId: message.id,
        matchedUserId: message.userId,
        decision: "Rejected",
      },
    }).catch(() => undefined)

    return { ok: true }
  } catch (err) {
    console.log("[v0] rejectIncomingSwiftAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not reject the message." }
  }
}

export interface CreditResult {
  ok: boolean
  error?: string
  creditedLabel?: string
  creditedTo?: string
  alreadyCredited?: boolean
}

export async function creditIncomingSwiftAdmin(passcode: string, id: string): Promise<CreditResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }

  const message = await getIncomingSwiftById(id)
  if (!message) return { ok: false, error: "Message not found." }
  if (!message.userId || (message.status !== "matched" && message.status !== "assigned")) {
    return { ok: false, error: "This message is not matched to a platform account." }
  }
  if (message.creditedAt) {
    return { ok: false, alreadyCredited: true, error: "This message has already been credited." }
  }

  try {
    // Re-parse the raw FIN so the credited amount is authoritative (never a
    // hand-edited display string).
    const parsed = parseSwiftMessage(message.raw)
    // An MT760 is a bank guarantee (blocked funds), NOT a cash transfer — it must
    // never hit the spendable Master Account balance. It is booked as a pledgeable
    // bank instrument via recordGuaranteeInstrumentAdmin instead. This check is
    // deliberately broad (see looksLikeBlockedFundsGuarantee) so a guarantee that
    // used a non-standard header can never slip through and be credited as cash.
    if (looksLikeBlockedFundsGuarantee(parsed, message.raw)) {
      return {
        ok: false,
        error:
          "This is a blocked-funds bank guarantee (MT760 / SBLC), not a cash transfer. Use “Record blocked-funds guarantee” to book it as a pledgeable bank instrument.",
      }
    }
    const receivedAmount = Number(parsed.amount ?? 0)
    const receivedCurrency = (parsed.currency ?? message.currency ?? "").toUpperCase()
    if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) {
      return { ok: false, error: "The message has no positive amount to credit." }
    }
    if (!receivedCurrency) return { ok: false, error: "The message has no currency to credit." }

    const account = await readActiveGatewayAccount(message.userId, message.matchedAccountId)
    // Credit in the ACCOUNT currency when we can resolve it (so a balance never
    // mixes currencies); otherwise fall back to the received currency.
    const accountCurrency = (account?.currency ?? receivedCurrency).toUpperCase()

    const isFx = receivedCurrency !== accountCurrency
    const grossConverted = isFx ? convertCurrency(receivedAmount, receivedCurrency, accountCurrency) : receivedAmount
    const fxRate = isFx && receivedAmount > 0 ? grossConverted / receivedAmount : 1
    const fxFee = isFx ? round2(grossConverted * GATEWAY_FX_FEE_RATE) : 0
    // Tiered incoming-transaction fee on the converted amount, deducted from
    // the credit (in ADDITION to any FX fee). Same-currency credits get only this.
    // Admin-set SWIFT cashback reduces it.
    const standardIncomingFee = incomingTransactionFee(grossConverted, await getFeeTiers())
    const incomingCashback = await applyCashbackForOwner(
      (await resolveDataOwnerIdFor(message.userId)) ?? message.userId,
      "swift",
      standardIncomingFee,
    )
    const incomingFee = incomingCashback.netFee
    const amount = round2(grossConverted - fxFee - incomingFee)
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "The credit amount could not be computed." }
    }

    const senderName = message.orderingCustomer || message.senderBic || "the ordering party"
    const bankName = account?.coordinates?.partnerBankName ?? message.senderBic ?? null
    const reference = message.reference?.trim() || account?.coordinates?.reference || account?.id || message.id
    const creditedLabel = `${accountCurrency} ${amount.toLocaleString("en-US")}`

    const fxNote = isFx
      ? ` Received ${receivedCurrency} ${receivedAmount.toLocaleString("en-US")}, converted to ${accountCurrency} at ${fxRate.toFixed(6)} (FX fee ${accountCurrency} ${fxFee.toLocaleString("en-US")}), net credited ${creditedLabel}.`
      : ""
    const feeNote =
      incomingCashback.originalFee > 0
        ? ` An incoming-transaction fee of ${accountCurrency} ${incomingFee.toLocaleString("en-US")} (${((incomingFee / grossConverted) * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% effective, tiered) was deducted.${cashbackNote(incomingCashback, accountCurrency)}`
        : ""

    // Deterministic idempotency key derived from the message id.
    const ledgerEntryId = `ISWC-${message.id}`
    const ledgerOwnerId = (await resolveDataOwnerIdFor(message.userId)) ?? message.userId

    await query(
      `INSERT INTO ledger_entries
         (user_id, entry_id, direction, amount, currency, status, entry_date,
          counterparty, account, bank, reference, comment, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [
        ledgerOwnerId,
        ledgerEntryId,
        "credit",
        amount,
        accountCurrency,
        "completed",
        new Date().toISOString(),
        senderName,
        account?.id ?? null,
        bankName,
        reference,
        `Inbound SWIFT ${message.messageType} from ${senderName} (reference ${reference}${message.uetr ? `, UETR ${message.uetr}` : ""}) verified and credited to the Master Account by the administrator.${fxNote}${feeNote}`,
        isFx ? "Inbound SWIFT Credit (FX)" : "Inbound SWIFT Credit",
      ],
    )

    // Stamp credited (idempotency-guarded). If another call already stamped it,
    // stop here so we never notify or audit twice.
    const stamped = await markIncomingSwiftCredited(message.id, ledgerEntryId, creditedLabel)
    if (!stamped) {
      return { ok: false, alreadyCredited: true, error: "This message has already been credited." }
    }

    await insertNotification({
      userId: message.userId,
      tone: "success",
      title: `Payment received — ${creditedLabel}`,
      body: `You received ${creditedLabel} from ${senderName}${
        reference ? ` (reference ${reference})` : ""
      } via SWIFT ${message.messageType}. The funds were credited to your Master Account.${feeNote}`,
      href: "/dashboard",
    })

    await logActivity({
      action: `Inbound SWIFT ${message.messageType} verified and credited ${creditedLabel} to ${message.matchedAccountHolder ?? message.userId}`,
      category: "SWIFT",
      details: {
        summary: `Administrator executed the credit for inbound SWIFT ${message.messageType} (${message.id}, beneficiary IBAN ${message.beneficiaryIban || "n/a"}${message.uetr ? `, UETR ${message.uetr}` : ""}) and credited ${creditedLabel} to the Master Account of ${message.matchedAccountHolder ?? message.userId} under ledger reference ${ledgerEntryId}.${fxNote}${feeNote}`,
        messageId: message.id,
        matchedUserId: message.userId,
        ledgerReference: ledgerEntryId,
        amount: creditedLabel,
        decision: isFx ? "Credited with FX conversion" : "Credited",
      },
    })

    return { ok: true, creditedLabel, creditedTo: message.matchedAccountHolder ?? undefined }
  } catch (err) {
    console.log("[v0] creditIncomingSwiftAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not execute the credit." }
  }
}

// ---------------------------------------------------------------------------
// Admin: book a received MT760 as a BLOCKED-FUNDS bank guarantee.
//
// An MT760 is a bank guarantee / standby LC — it transfers a BLOCKED undertaking,
// not spendable cash. So instead of crediting the Master Account balance we
// materialise it as a pledgeable bank INSTRUMENT (face value = the undertaking
// amount) owned by the customer, and charge the 0.2% receipt fee to their Master
// Account. The customer can then pledge that instrument for a treasury leverage
// line via Leverage → funding source "Bank Instruments" (the standard flow).
// ---------------------------------------------------------------------------

export interface GuaranteeResult {
  ok: boolean
  error?: string
  instrumentLabel?: string
  feeLabel?: string
  bookedTo?: string
  alreadyBooked?: boolean
}

export async function recordGuaranteeInstrumentAdmin(
  passcode: string,
  id: string,
  // Optional cashback the administrator applies AT CONFIRM TIME (fraction 0..1),
  // reducing the 0.2% receipt fee. When omitted, the customer's preset SWIFT
  // cashback (if any) applies instead.
  cashbackRateOverride?: number,
  // Optional booking overrides. The admin recognizes the printout and picks the
  // instrument type (BG / SBLC / DLC / MTN / Bond / …) plus confirms the face
  // value + currency (auto-filled from the parse, but editable — MTN/Bond
  // printouts are not SWIFT guarantee messages so the parse can be partial).
  overrides?: { instrumentTypeCode?: string; faceValue?: number; currency?: string },
): Promise<GuaranteeResult> {
  if (!(await adminActionAuthorized(passcode))) {
    return { ok: false, error: "Administrator authorization failed." }
  }

  const message = await getIncomingSwiftById(id)
  if (!message) return { ok: false, error: "Message not found." }
  if (!message.userId || (message.status !== "matched" && message.status !== "assigned")) {
    return { ok: false, error: "This message is not matched to a platform account." }
  }
  if (message.creditedAt) {
    return { ok: false, alreadyBooked: true, error: "This message has already been processed." }
  }

  try {
    // Re-parse the raw FIN so every value is authoritative. BG/SBLC arrive as an
    // MT760, but DLC (MT700) and MTN/Bond printouts are not guarantee messages —
    // the admin recognises the printout and picks the type, so we accept the
    // parse as a best-effort source for amount/currency/parties, overridable.
    const parsed = parseSwiftMessage(message.raw)
    const g = parsed.guarantee
    const parsedFace = Number(g?.amount ?? parsed.amount ?? 0)
    const parsedCurrency = (g?.currency ?? parsed.currency ?? message.currency ?? "").toUpperCase()
    const faceValue =
      typeof overrides?.faceValue === "number" && Number.isFinite(overrides.faceValue) && overrides.faceValue > 0
        ? overrides.faceValue
        : parsedFace
    const currency = (overrides?.currency || parsedCurrency).toUpperCase()
    if (!Number.isFinite(faceValue) || faceValue <= 0) {
      return { ok: false, error: "Enter a valid face value for this instrument." }
    }
    if (!currency) return { ok: false, error: "Enter the instrument currency." }

    // Resolve the chosen instrument type from the catalog (assignable/monetizable
    // rules per type). Falls back to the MT760 blocked-funds treatment when the
    // admin does not pick a type AND the message is an MT760 guarantee.
    const typeMeta = overrides?.instrumentTypeCode
      ? findInstrumentType(overrides.instrumentTypeCode)
      : undefined
    if (overrides?.instrumentTypeCode && !typeMeta) {
      return { ok: false, error: "Unknown instrument type." }
    }
    if (!typeMeta && parsed.type !== "MT760") {
      return {
        ok: false,
        error: "Choose the instrument type (BG / SBLC / DLC / MTN / Bond) to book this printout.",
      }
    }

    // -----------------------------------------------------------------------
    // Solvency gate — the customer must be able to cover the 0.2% receipt fee,
    // INCLUDING their controlled-overdraft allowance. If they cannot, the MT760
    // is REJECTED (never booked): a blocked-funds guarantee cannot be received
    // if its receipt fee is unpayable even on overdraft.
    // -----------------------------------------------------------------------
    const ledgerOwnerId = (await resolveDataOwnerIdFor(message.userId)) ?? message.userId
    // Cashback reduces the MT760 receipt fee. If the administrator authorised a
    // cashback at confirm time it wins; otherwise the customer's preset SWIFT
    // cashback (if any) applies. The net fee is what is actually charged.
    const standardReceiptFee = round2(faceValue * GUARANTEE_RECEIPT_FEE_RATE)
    const receiptCashback =
      typeof cashbackRateOverride === "number" && Number.isFinite(cashbackRateOverride) && cashbackRateOverride > 0
        ? applyCashback(standardReceiptFee, cashbackRateOverride)
        : await applyCashbackForOwner(ledgerOwnerId, "swift", standardReceiptFee)
    const feeAmount = receiptCashback.netFee
    const feeLabel = `${currency} ${feeAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

    if (feeAmount > 0) {
      try {
        const entries = await readLedgerEntries(ledgerOwnerId)
        const avail = availableByCurrency(entries)
        let availableInFeeCcy = 0
        for (const [cur, amt] of Object.entries(avail)) {
          availableInFeeCcy += cur === currency ? amt : convertCurrency(amt, cur, currency)
        }
        const od = await getOverdraftStatusForOwner(ledgerOwnerId)
        const overdraftInFeeCcy = od.remainingEur > 0 ? convertCurrency(od.remainingEur, "EUR", currency) : 0
        const spendable = availableInFeeCcy + overdraftInFeeCcy

        if (feeAmount > spendable + 0.01) {
          // Remove it from the queue with a clear reason + notify the customer.
          await rejectIncomingSwift(
            message.id,
            `Rejected automatically: the ${feeLabel} receipt fee (0.2%) exceeds the customer's available funds and overdraft allowance.`,
          ).catch(() => undefined)
          await insertNotification({
            userId: message.userId,
            tone: "warning",
            title: "MT760 could not be received",
            body: `Your MT760 blocked-funds guarantee could not be booked because the ${feeLabel} receipt fee (0.2%) exceeds your available funds and overdraft allowance. Add funds to your Master Account and re-submit the printout.`,
            href: "/dashboard/swift",
          }).catch(() => undefined)
          await logActivity({
            action: `MT760 guarantee rejected — ${feeLabel} receipt fee unaffordable for ${message.matchedAccountHolder ?? message.userId}`,
            category: "SWIFT",
            details: {
              summary: `Administrator tried to book inbound MT760 (${message.id}) but the 0.2% receipt fee ${feeLabel} exceeded the customer's available funds (${currency} ${round2(availableInFeeCcy).toLocaleString("en-US")}) plus overdraft allowance (${currency} ${round2(overdraftInFeeCcy).toLocaleString("en-US")}). The message was rejected.`,
              messageId: message.id,
              matchedUserId: message.userId,
              fee: feeLabel,
              decision: "Rejected — receipt fee unaffordable",
            },
          }).catch(() => undefined)
          return {
            ok: false,
            error: `The customer cannot cover the ${feeLabel} receipt fee (0.2%) even with their overdraft allowance, so the MT760 was rejected. Ask them to fund the Master Account and re-submit.`,
          }
        }
      } catch (err) {
        // A transient FX/DB error must not wrongly block a funded customer.
        console.log("[v0] guarantee fee solvency check failed (proceeding):", (err as Error).message)
      }
    }

    const ex = extractIncoming(message.raw)
    const issuer = message.senderBic || ex.orderingCustomer || "Issuing Bank"
    const applicantName = firstLine(g?.applicant?.nameAndAddress) || ex.orderingCustomer || ""
    const now = new Date()
    const issuedDate = now.toISOString()
    const expiryDate = g?.expiryDate
      ? new Date(g.expiryDate).toISOString()
      : new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const daysRemaining = Math.max(0, Math.round((new Date(expiryDate).getTime() - now.getTime()) / 86_400_000))
    const formLabel =
      g?.form === "STBY" ? "Standby Letter of Credit" : g?.form === "DGAR" ? "Demand Guarantee" : "Bank Guarantee"

    // The instrument's shape depends on whether the admin recognised a specific
    // type (BG/SBLC/DLC/MTN/Bond/…) or is booking a bare MT760 blocked-funds
    // guarantee. A typed instrument follows the catalog's assignable/monetizable
    // rules; the MT760 fallback stays single-use blocked-funds collateral.
    const typeCode = typeMeta?.code ?? "MT760"
    const typeFull = typeMeta
      ? typeMeta.full
      : `MT760 ${formLabel} (Blocked Funds)`
    const instrumentId = `${typeCode}-${message.id}`
    const instrument: Record<string, unknown> = {
      id: instrumentId,
      type: typeCode,
      typeFull,
      issuer,
      issuerBic: message.senderBic || undefined,
      faceValue,
      currency,
      rating: "AAA",
      purpose: typeMeta
        ? `${typeMeta.purpose} — pledgeable as treasury leverage / PPP collateral`
        : "Blocked-funds guarantee — pledgeable as treasury leverage collateral",
      // Capability follows the catalog per type. The MT760 fallback is single-use
      // blocked-funds collateral: monetizable + pledgeable but NEVER assignable
      // (funds blocked on behalf of the holder). A typed instrument uses its
      // catalog rules (e.g. BG/SBLC/MTN/Bond assignable + monetizable; DLC
      // monetizable only). All remain pledgeable for a Leverage/PPP line.
      assignable: typeMeta ? typeMeta.assignable : false,
      monetizable: typeMeta ? typeMeta.monetizable : true,
      blocked: false, // "blocked" here means an upgrade-in-progress lock, which does NOT apply
      owner: message.matchedAccountHolder || applicantName || undefined,
      issuedDate,
      expiryDate,
      daysRemaining,
      deliveryMethod: `SWIFT ${parsed.type ?? "printout"}`,
      form: typeMeta ? undefined : formLabel,
      governingLaw: g?.applicableRules || (typeMeta ? undefined : "URDG 758"),
      placeOfIssue: undefined,
      // Trade-finance provenance for the instrument detail view.
      tradeType: typeMeta
        ? `Received via SWIFT (${parsed.type ?? "printout"})`
        : "Blocked-funds guarantee (MT760)",
    }

    // Materialise the instrument in the customer's portfolio (reuses the audited,
    // notified admin-issuance path; born approved/active).
    const issued = await adminIssueInstrument(passcode, message.userId, instrument)
    if (!issued.ok) {
      return { ok: false, error: issued.error ?? "The guarantee instrument could not be created." }
    }
    const approvalId = issued.request.id

    // Human label for the booked instrument (e.g. "Bank Guarantee (BG)" or
    // "MT760 blocked-funds guarantee"), reused across the fee note, stamp,
    // notification and audit log.
    const bookLabel = typeMeta ? `${typeMeta.full} (${typeMeta.code})` : "MT760 blocked-funds guarantee"

    // Charge the 0.2% receipt fee to the customer's Master Account (data owner).
    // feeAmount / feeLabel / ledgerOwnerId were computed and affordability-gated above.
    if (feeAmount > 0) {
      const feeEntry: LedgerEntry = {
        id: `INSTR-RECEIPT-FEE-${approvalId}`,
        direction: "debit",
        amount: feeAmount,
        currency,
        status: "completed",
        date: issuedDate,
        counterparty: "NAFTAhub Treasury",
        reference: instrumentId,
        category: "Bank Instrument Receipt Fee (0.2%)",
        comment: `0.2% receipt fee on a ${currency} ${faceValue.toLocaleString("en-US")} ${bookLabel} from ${issuer}${message.uetr ? ` (UETR ${message.uetr})` : ""}. If ${currency} is short it is auto-covered from your strongest funded currency.${cashbackNote(receiptCashback, currency)}`,
      }
      try {
        await upsertLedgerEntry(ledgerOwnerId, feeEntry)
      } catch (err) {
        console.log("[v0] instrument receipt fee post failed:", (err as Error).message)
      }
    }

    const instrumentLabel = `${currency} ${faceValue.toLocaleString("en-US")}`

    // Leave the creditable queue + mark processed (reuse the credited stamp with
    // the instrument approval id as the settlement reference). Idempotent.
    const stamped = await markIncomingSwiftCredited(
      message.id,
      approvalId,
      `${instrumentLabel} ${bookLabel} (fee ${feeLabel})`,
    )
    if (!stamped) {
      return { ok: false, alreadyBooked: true, error: "This message has already been processed." }
    }

    await insertNotification({
      userId: message.userId,
      tone: "success",
      title: `Bank instrument received — ${instrumentLabel}`,
      body: `A ${bookLabel} of ${instrumentLabel} from ${issuer} was booked to your Bank Instruments. A ${feeLabel} receipt fee (0.2%) was applied. You can pledge it for a treasury leverage / PPP line under Leverage → Bank Instruments.`,
      href: "/dashboard/instruments",
    })

    await logActivity({
      action: `${bookLabel} (${instrumentLabel}) booked for ${message.matchedAccountHolder ?? message.userId} and 0.2% receipt fee ${feeLabel} charged`,
      category: "SWIFT",
      details: {
        summary: `Administrator booked inbound SWIFT (${message.id}, beneficiary IBAN ${message.beneficiaryIban || "n/a"}${message.uetr ? `, UETR ${message.uetr}` : ""}) as a pledgeable ${bookLabel} instrument ${instrumentId} (approval ${approvalId}) of ${instrumentLabel} for ${message.matchedAccountHolder ?? message.userId}, and charged a ${feeLabel} receipt fee (0.2%) to the Master Account.`,
        messageId: message.id,
        matchedUserId: message.userId,
        instrumentId,
        approvalId,
        instrumentType: typeCode,
        faceValue: instrumentLabel,
        fee: feeLabel,
        decision: "Bank instrument booked",
      },
    })

    return {
      ok: true,
      instrumentLabel,
      feeLabel,
      bookedTo: message.matchedAccountHolder ?? undefined,
    }
  } catch (err) {
    console.log("[v0] recordGuaranteeInstrumentAdmin failed:", (err as Error).message)
    return { ok: false, error: "Could not book the guarantee instrument." }
  }
}
