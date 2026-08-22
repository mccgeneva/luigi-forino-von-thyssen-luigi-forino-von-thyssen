"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveAccountProfileById, resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { insertNotification } from "@/lib/notifications-db"
import type { GatewayAccount, FundingEvent } from "@/lib/gateway-store"
import type { LedgerEntry } from "@/lib/ledger-store"
import {
  matchPayment,
  type IncomingPayment,
  type MatchResult,
  type ReconciliationCandidate,
  type ReconciliationStatus,
} from "@/lib/reconciliation"
import { parseSwiftMessage, toReconciliationInput } from "@/lib/swift-mt"
import { getApprovalById } from "@/lib/approvals-db"
import { deleteLedgerEntry } from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"

/**
 * FX conversion fee applied when an inbound payment is auto-converted into the
 * receiving account's currency. 0.5% spread — deducted from the converted
 * amount and recorded transparently on the funding event and ledger entry.
 */
const GATEWAY_FX_FEE_RATE = 0.005

/** Strip a IBAN/account string down to comparable A–Z0–9 (uppercase). */
function normalizeIban(raw: string | undefined | null): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Round to 2 decimal places (currency-safe). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// ---------------------------------------------------------------------------
// Auth helpers (mirror app/actions/gateway.ts)
// ---------------------------------------------------------------------------

async function getSessionUser(): Promise<UserProfile | undefined> {
  const session = await resolveCurrentSession()
  return session?.profile
}

async function requireAdmin(passcode: string): Promise<UserProfile> {
  const user = await getSessionUser()
  if (!user) throw new Error("Your session has expired. Please sign in again.")
  if (!(await adminActionAuthorized(passcode))) throw new Error("Administrator authorization failed.")
  return user
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** A reconciliation record as stored / returned to the admin UI. */
export interface ReconciliationRecord {
  id: string
  payment: IncomingPayment
  status: ReconciliationStatus
  /** Candidate accounts from the last match run (best first). */
  candidates: ReconciliationCandidate[]
  summary: string
  /** Set once funds are credited (auto or via manual resolve). */
  matchedUserId?: string
  matchedRequestId?: string
  matchedAccountHolder?: string
  ledgerEntryId?: string
  createdAt: string
  updatedAt: string
  /** Admin note captured on manual resolve / ignore. */
  resolutionNote?: string
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS reconciliation_payments (
       id          text        PRIMARY KEY,
       status      text        NOT NULL,
       created_at  timestamptz NOT NULL DEFAULT now(),
       updated_at  timestamptz NOT NULL DEFAULT now(),
       payload     jsonb       NOT NULL
     )`,
  )
  ensured = true
}

function rowToRecord(row: Record<string, unknown>): ReconciliationRecord {
  const payload = (row.payload as ReconciliationRecord) ?? ({} as ReconciliationRecord)
  return {
    ...payload,
    id: row.id as string,
    status: (row.status as ReconciliationStatus) ?? payload.status,
  }
}

async function writeRecord(record: ReconciliationRecord): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO reconciliation_payments (id, status, created_at, updated_at, payload)
     VALUES ($1,$2,$3,now(),$4::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = now(),
       payload = EXCLUDED.payload`,
    [record.id, record.status, record.createdAt, JSON.stringify(record)],
  )
}

async function readRecord(id: string): Promise<ReconciliationRecord | undefined> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM reconciliation_payments WHERE id = $1`, [id])
  return rows[0] ? rowToRecord(rows[0]) : undefined
}

async function readAllRecords(): Promise<ReconciliationRecord[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM reconciliation_payments ORDER BY created_at DESC`,
  )
  return rows.map(rowToRecord)
}

// Read every user's active gateway accounts (the match targets).
async function readActiveAccounts(): Promise<GatewayAccount[]> {
  // gateway_accounts is created lazily by app/actions/gateway.ts; guard in case
  // reconciliation runs before any account has ever been written.
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_accounts (
       user_id text NOT NULL, request_id text NOT NULL, status text NOT NULL,
       submitted_at timestamptz, decided_at timestamptz,
       updated_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
       PRIMARY KEY (user_id, request_id))`,
  )
  const { rows } = await query(`SELECT payload, request_id, status FROM gateway_accounts WHERE status = 'active'`)
  return rows.map((row: Record<string, unknown>) => {
    const payload = (row.payload as GatewayAccount) ?? ({} as GatewayAccount)
    return { ...payload, id: row.request_id as string, status: "active" as const }
  })
}

// ---------------------------------------------------------------------------
// Credit primitive — credit a client's Master Account and stamp the gateway
// account with a reconciled funding event. Mirrors recordGatewayFundingAdmin
// but is callable internally with an already-resolved account.
// ---------------------------------------------------------------------------

async function creditMatchedAccount(
  account: GatewayAccount,
  payment: IncomingPayment,
): Promise<string> {
  const receiptRef = `RC-CR-${Date.now().toString().slice(-8)}`
  const reference = payment.reference?.trim() || account.coordinates?.reference || account.id
  const bankName = account.coordinates?.partnerBankName
  // Credit the gateway owner's DATA-OWNER ledger (a Sub-account's shared balance
  // lives under its Master) so the Master Account balance reflects the funds.
  const ledgerOwnerId = await resolveDataOwnerIdFor(account.userId)

  const entry: LedgerEntry = {
    id: receiptRef,
    direction: "credit",
    amount: payment.amount,
    currency: account.currency,
    status: "completed",
    date: new Date().toISOString(),
    counterparty: payment.payer.trim(),
    bank: bankName,
    reference: account.id,
    category: "Reconciled Collection",
    comment: `Inbound payment from ${payment.payer.trim()} (reference ${reference}${payment.senderBic ? `, sender BIC ${payment.senderBic}` : ""}) auto-reconciled to the Master Account via gateway account ${account.id}.`,
  }

  await query(
    `INSERT INTO ledger_entries
       (user_id, entry_id, direction, amount, currency, status, entry_date,
        counterparty, account, bank, reference, comment, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, entry_id) DO UPDATE SET
       direction = EXCLUDED.direction, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
       status = EXCLUDED.status, entry_date = EXCLUDED.entry_date, counterparty = EXCLUDED.counterparty,
       account = EXCLUDED.account, bank = EXCLUDED.bank, reference = EXCLUDED.reference,
       comment = EXCLUDED.comment, category = EXCLUDED.category`,
    [
      ledgerOwnerId,
      entry.id,
      entry.direction,
      entry.amount,
      entry.currency,
      entry.status,
      entry.date,
      entry.counterparty ?? "",
      entry.account ?? null,
      entry.bank ?? null,
      entry.reference ?? null,
      entry.comment ?? null,
      entry.category ?? null,
    ],
  )

  // Stamp a reconciled funding event onto the gateway account.
  const now = new Date().toISOString()
  const event: FundingEvent = {
    id: `FND-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    amount: payment.amount,
    currency: account.currency,
    reference,
    payer: payment.payer.trim(),
    recordedAt: now,
    reconciled: true,
    reconciledAt: now,
    ledgerEntryId: receiptRef,
  }
  const updated: GatewayAccount = { ...account, funding: [event, ...(account.funding ?? [])] }
  await query(
    `UPDATE gateway_accounts SET payload = $3::jsonb, updated_at = now()
     WHERE user_id = $1 AND request_id = $2`,
    [account.userId, account.id, JSON.stringify(updated)],
  )

  return receiptRef
}

// ---------------------------------------------------------------------------
// IBAN auto-match: bridge an APPROVED outgoing payment into a Collect-funds
// gateway account whose assigned IBAN equals the payment's beneficiary IBAN.
// ---------------------------------------------------------------------------

/**
 * When an outgoing payment is approved, if its beneficiary IBAN matches an
 * active gateway (Collect funds) account, record it as a received funding event
 * on that account and credit the gateway owner's Master Account.
 *
 * Safe to expose as a server action: it takes ONLY an approval id and derives
 * every monetary value from the server-stored, already-approved record — never
 * from client input. It is idempotent (keyed on a deterministic ledger entry id
 * `GWD-<approvalId>`), so re-approval / reconcile re-runs never double-credit.
 */
export async function recordGatewayDepositForApproval(
  approvalId: string,
): Promise<{ matched: boolean }> {
  try {
    const approval = await getApprovalById(approvalId)
    // Only genuine, fully-approved outgoing payments can fund a deposit account.
    if (!approval || approval.kind !== "payment" || approval.status !== "approved") {
      return { matched: false }
    }

    const payload = (approval.payload ?? {}) as {
      iban?: string
      recalled?: boolean
      recallStatus?: string
      record?: { iban?: string; amount?: number; beneficiary?: string; reference?: string }
    }

    // A recalled payment must NOT (re)fund a gateway. The recall reverses both
    // the sender debit and this recipient credit; without this guard the
    // idempotent backfill sweep would simply re-create the credit we removed.
    if (payload.recalled === true || payload.recallStatus === "recalled") {
      return { matched: false }
    }
    const record = payload.record ?? {}
    const beneficiaryIban = normalizeIban(payload.iban ?? record.iban)
    if (!beneficiaryIban) return { matched: false }

    // The sent amount is the PRINCIPAL (record.amount), not the total that
    // includes the 2% platform fee — the fee is not received by the payee.
    const sentAmount = Number(record.amount ?? approval.amount ?? 0)
    if (!Number.isFinite(sentAmount) || sentAmount <= 0) return { matched: false }

    const sentCurrency = (approval.currency ?? "").toUpperCase()
    if (!sentCurrency) return { matched: false }

    const accounts = await readActiveAccounts()
    const matches = accounts.filter(
      (a) =>
        // Match purely by beneficiary IBAN. "Collect funds" exists to RECEIVE
        // money from other parties, so the payer is normally NOT the gateway
        // owner — the funds are credited to whoever owns the matched IBAN. IBANs
        // are globally unique and we require a single unambiguous match below,
        // so this cannot leak funds to an unrelated account.
        a.coordinates?.scheme === "iban" &&
        normalizeIban(a.coordinates?.iban) === beneficiaryIban,
    )
    // Require an unambiguous single match before moving money. A currency
    // mismatch is NOT a reason to reject — it is handled by automatic FX
    // conversion below.
    if (matches.length !== 1) return { matched: false }
    const account = matches[0]
    const accountCurrency = account.currency.toUpperCase()

    // Idempotency: deterministic credit id derived from the approval. If the
    // funding event is already stamped we do NOT bail out — we still (re)post the
    // ledger credit below (ON CONFLICT DO NOTHING). This self-heals deposits that
    // were stamped on the gateway account but whose Master Account credit was
    // missing or previously landed on the wrong (non data-owner) ledger.
    const ledgerEntryId = `GWD-${approval.id}`
    const alreadyFunded = (account.funding ?? []).some((f) => f.ledgerEntryId === ledgerEntryId)

    // --- Automatic FX conversion on currency mismatch ----------------------
    // If the payer sent a different currency than the account is denominated
    // in, convert at the current rate and apply a configurable FX spread/fee.
    // The funds are always credited in the ACCOUNT's currency so a balance
    // never mixes currencies.
    const isFx = sentCurrency !== accountCurrency
    const grossConverted = isFx
      ? convertCurrency(sentAmount, sentCurrency, accountCurrency)
      : sentAmount
    // FX rate expressed as units of account currency per 1 unit sent.
    const fxRate = isFx ? grossConverted / sentAmount : 1
    const fxFee = isFx ? round2(grossConverted * GATEWAY_FX_FEE_RATE) : 0
    const amount = round2(grossConverted - fxFee)
    if (!Number.isFinite(amount) || amount <= 0) return { matched: false }

    // The payer is the client who SENT the funds (the approval owner).
    const sender = await resolveAccountProfileById(approval.userId)
    const reference = record.reference?.trim() || account.coordinates?.reference || account.id
    const bankName = account.coordinates?.partnerBankName

    const fxNote = isFx
      ? ` Received ${sentCurrency} ${sentAmount.toLocaleString("en-US")}, converted to ${accountCurrency} at ${fxRate.toFixed(6)} (FX fee ${accountCurrency} ${fxFee.toLocaleString("en-US")}), net credited ${accountCurrency} ${amount.toLocaleString("en-US")}.`
      : ""

    const entry: LedgerEntry = {
      id: ledgerEntryId,
      direction: "credit",
      amount,
      currency: account.currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: sender.fullName,
      bank: bankName,
      reference: account.id,
      category: isFx ? "Reconciled Collection (FX)" : "Reconciled Collection",
      comment: `Inbound transfer from ${sender.fullName} (approved payment ${approval.id}, reference ${reference}) auto-matched by IBAN to gateway account ${account.id} and credited to the Master Account.${fxNote}`,
    }

    // Post to the gateway owner's DATA-OWNER ledger (a Sub-account's Master
    // holds the shared balance) so the Master Account balance and the matching
    // currency card on the dashboard overview both reflect the collected funds.
    const ledgerOwnerId = await resolveDataOwnerIdFor(account.userId)

    await query(
      `INSERT INTO ledger_entries
         (user_id, entry_id, direction, amount, currency, status, entry_date,
          counterparty, account, bank, reference, comment, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [
        ledgerOwnerId,
        entry.id,
        entry.direction,
        entry.amount,
        entry.currency,
        entry.status,
        entry.date,
        entry.counterparty ?? "",
        entry.account ?? null,
        entry.bank ?? null,
        entry.reference ?? null,
        entry.comment ?? null,
        entry.category ?? null,
      ],
    )

    // Stamp the funding event + write the audit trail only for a genuinely new
    // deposit. When self-healing an existing one, the credit (re)post above is
    // enough and we must not duplicate the funding event or log line.
    if (!alreadyFunded) {
      const now = new Date().toISOString()
      const event: FundingEvent = {
        id: `FND-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        amount,
        currency: account.currency,
        reference,
        payer: sender.fullName,
        recordedAt: now,
        reconciled: true,
        reconciledAt: now,
        ledgerEntryId,
        // Persist the FX trail only when a conversion actually happened.
        ...(isFx
          ? {
              originalAmount: sentAmount,
              originalCurrency: sentCurrency,
              fxRate,
              fxFee,
            }
          : {}),
      }
      const updated: GatewayAccount = { ...account, funding: [event, ...(account.funding ?? [])] }
      await query(
        `UPDATE gateway_accounts SET payload = $3::jsonb, updated_at = now()
         WHERE user_id = $1 AND request_id = $2`,
        [account.userId, account.id, JSON.stringify(updated)],
      )

      await logActivity({
        action: `Approved payment ${approval.id} auto-matched by IBAN and credited ${account.currency} ${amount.toLocaleString("en-US")} to gateway account ${account.id}${isFx ? ` (FX from ${sentCurrency})` : ""}`,
        category: "Administration",
        details: {
          summary: `Outgoing payment ${approval.id} from ${sender.fullName} was matched by beneficiary IBAN to active gateway account ${account.id} (${account.accountHolder}) and recorded as received funding, crediting the Master Account under ledger reference ${ledgerEntryId}.${fxNote}`,
          referenceId: approval.id,
          amount: `${account.currency} ${amount.toLocaleString("en-US")}`,
          ...(isFx
            ? {
                originalAmount: `${sentCurrency} ${sentAmount.toLocaleString("en-US")}`,
                fxRate: fxRate.toFixed(6),
                fxFee: `${account.currency} ${fxFee.toLocaleString("en-US")}`,
              }
            : {}),
          ledgerReference: ledgerEntryId,
          decision: isFx ? "Auto-matched by IBAN with FX conversion" : "Auto-matched by IBAN",
        },
      })

      // Alert the account owner (the beneficiary) that funds landed and were
      // credited to their Master Account. Fires once per genuinely new deposit
      // (guarded by `!alreadyFunded`), so a self-heal re-post never re-notifies.
      // Best-effort: a notification failure must not undo the recorded credit.
      try {
        const creditedLabel = `${account.currency} ${amount.toLocaleString("en-US")}`
        await insertNotification({
          userId: account.userId,
          tone: "success",
          title: `Payment received — ${creditedLabel}`,
          body: `You received ${creditedLabel} from ${sender.fullName}${
            reference ? ` (reference ${reference})` : ""
          }. The funds were credited to your Master Account.`,
          href: "/dashboard",
        })
      } catch (err) {
        console.log("[v0] deposit notification failed:", (err as Error).message)
      }
    }

    return { matched: true }
  } catch (err) {
    console.log("[v0] recordGatewayDepositForApproval failed:", (err as Error).message)
    return { matched: false }
  }
}

/**
 * REVERSE a previously-recorded gateway deposit when its source payment is
 * recalled. Removes the funding event from the matched Collect-funds account and
 * deletes the `GWD-<approvalId>` credit from the gateway owner's ledger, so the
 * recipient's Master Account balance unwinds exactly as if the payment never
 * landed. A no-op when the payment never matched a gateway (e.g. a plain
 * external IBAN), which is the correct behaviour for those recalls.
 *
 * Idempotent and safe: derives everything from the deterministic `GWD-<id>` key.
 * Returns whether a recipient credit was actually reversed.
 */
export async function reverseGatewayDepositForApproval(
  originalApprovalId: string,
): Promise<{ reversed: boolean }> {
  try {
    const ledgerEntryId = `GWD-${originalApprovalId}`
    const accounts = await readActiveAccounts()
    const account = accounts.find((a) => (a.funding ?? []).some((f) => f.ledgerEntryId === ledgerEntryId))
    if (!account) return { reversed: false }

    // Remove the recipient credit from the gateway owner's (data-owner) ledger.
    const ledgerOwnerId = await resolveDataOwnerIdFor(account.userId)
    try {
      await deleteLedgerEntry(ledgerOwnerId, ledgerEntryId)
    } catch (err) {
      console.log("[v0] reverse gateway credit delete failed:", (err as Error).message)
    }

    // Drop the funding event from the account so its history and totals match.
    const reversedEvent = (account.funding ?? []).find((f) => f.ledgerEntryId === ledgerEntryId)
    const updated: GatewayAccount = {
      ...account,
      funding: (account.funding ?? []).filter((f) => f.ledgerEntryId !== ledgerEntryId),
    }
    await query(
      `UPDATE gateway_accounts SET payload = $3::jsonb, updated_at = now()
       WHERE user_id = $1 AND request_id = $2`,
      [account.userId, account.id, JSON.stringify(updated)],
    )

    await logActivity({
      action: `Recalled payment ${originalApprovalId} reversed a gateway collection of ${reversedEvent?.currency ?? account.currency} ${(reversedEvent?.amount ?? 0).toLocaleString("en-US")} on account ${account.id}`,
      category: "Administration",
      details: {
        summary: `The collected funds previously credited to gateway account ${account.id} (${account.accountHolder}) under ledger reference ${ledgerEntryId} were reversed because the source payment ${originalApprovalId} was recalled. The Master Account balance has been debited back accordingly.`,
        referenceId: originalApprovalId,
        ledgerReference: ledgerEntryId,
        decision: "Reversed on recall",
      },
    })

    return { reversed: true }
  } catch (err) {
    console.log("[v0] reverseGatewayDepositForApproval failed:", (err as Error).message)
    return { reversed: false }
  }
}

/**
 * Back-fill sweep for a gateway OWNER: ensure every APPROVED payment addressed
 * to one of this owner's active gateway IBANs — sent by ANY user — has been
 * recorded as a received deposit. "Collect funds" receives money from other
 * parties, so we sweep by destination IBAN, not by who sent the payment.
 *
 * Safe to call on every Collect-funds page load: idempotent (each match keys on
 * `GWD-<approvalId>`), so it only records deposits that are genuinely missing.
 * Catches payments approved through any path, including before the on-approval
 * hook existed or while an older (stricter) matcher was deployed.
 */
export async function backfillGatewayDepositsForUser(ownerUserId: string): Promise<void> {
  try {
    // The owner's active IBAN gateway destinations.
    const ownerIbans = new Set(
      (await readActiveAccounts())
        .filter((a) => a.userId === ownerUserId && a.coordinates?.scheme === "iban")
        .map((a) => normalizeIban(a.coordinates?.iban))
        .filter(Boolean),
    )
    if (ownerIbans.size === 0) return

    // All approved payments, regardless of sender; match by destination IBAN.
    const { rows } = await query<{ id: string; iban: string | null; rec_iban: string | null }>(
      `SELECT id,
              payload->>'iban' AS iban,
              payload->'record'->>'iban' AS rec_iban
         FROM approval_requests
        WHERE kind = 'payment' AND status = 'approved'`,
    )
    for (const row of rows) {
      const dest = normalizeIban(row.iban ?? row.rec_iban)
      if (dest && ownerIbans.has(dest)) {
        await recordGatewayDepositForApproval(row.id)
      }
    }
  } catch (err) {
    console.log("[v0] backfillGatewayDepositsForUser failed:", (err as Error).message)
  }
}

// ===========================================================================
// Registered external account auto-match
// ---------------------------------------------------------------------------
// Same automatic IBAN matching as the gateway flow above, but the match targets
// are the clients' APPROVED *registered external bank accounts* (kind
// "bank_account") instead of Collect-funds gateway accounts. When an approved
// outgoing payment is addressed to a registered account's IBAN, the receiving
// owner's Master Account is credited automatically and the credit is attributed
// to that specific bank (so the per-bank sub-balance updates too).
// ===========================================================================

interface RegisteredExternalAccount {
  approvalId: string
  ownerUserId: string
  iban: string
  currency: string
  bankName: string
}

/** Read every client's APPROVED registered external bank accounts (match targets). */
async function readApprovedRegisteredAccounts(): Promise<RegisteredExternalAccount[]> {
  const { rows } = await query<{
    id: string
    user_id: string
    iban: string | null
    currency: string | null
    bank: string | null
  }>(
    `SELECT id, user_id,
            payload->>'iban'     AS iban,
            payload->>'currency' AS currency,
            payload->>'bankName' AS bank
       FROM approval_requests
      WHERE kind = 'bank_account' AND status = 'approved'`,
  )
  return rows
    .map((r) => ({
      approvalId: r.id,
      ownerUserId: r.user_id,
      iban: r.iban ?? "",
      currency: (r.currency ?? "EUR").toUpperCase(),
      bankName: r.bank ?? "Registered account",
    }))
    .filter((a) => normalizeIban(a.iban).length > 0)
}

/**
 * When an outgoing payment is approved, if its beneficiary IBAN matches a single
 * approved registered external account, credit that account owner's Master
 * Account and tag the credit with the receiving IBAN so the per-bank sub-balance
 * reflects it. Mirrors recordGatewayDepositForApproval:
 *  - takes ONLY an approval id; every monetary value comes from the server-
 *    stored, already-approved record (never client input).
 *  - idempotent on a deterministic ledger entry id `RAD-<approvalId>`.
 *  - automatic FX conversion (with the same spread) on a currency mismatch.
 *  - recalled payments never (re)fund.
 *  - a payment to your OWN Master's registered account is a wash and is skipped.
 */
export async function recordRegisteredAccountDepositForApproval(
  approvalId: string,
): Promise<{ matched: boolean }> {
  try {
    const approval = await getApprovalById(approvalId)
    if (!approval || approval.kind !== "payment" || approval.status !== "approved") {
      return { matched: false }
    }

    const payload = (approval.payload ?? {}) as {
      iban?: string
      recalled?: boolean
      recallStatus?: string
      record?: { iban?: string; amount?: number; beneficiary?: string; reference?: string }
    }
    if (payload.recalled === true || payload.recallStatus === "recalled") {
      return { matched: false }
    }
    const record = payload.record ?? {}
    const beneficiaryIban = normalizeIban(payload.iban ?? record.iban)
    if (!beneficiaryIban) return { matched: false }

    // PRINCIPAL sent (excludes the 2% platform fee, which the payee never receives).
    const sentAmount = Number(record.amount ?? approval.amount ?? 0)
    if (!Number.isFinite(sentAmount) || sentAmount <= 0) return { matched: false }
    const sentCurrency = (approval.currency ?? "").toUpperCase()
    if (!sentCurrency) return { matched: false }

    const accounts = await readApprovedRegisteredAccounts()
    const matches = accounts.filter((a) => normalizeIban(a.iban) === beneficiaryIban)
    // Require a single unambiguous match before moving money.
    if (matches.length !== 1) return { matched: false }
    const account = matches[0]
    const accountCurrency = account.currency.toUpperCase()

    // Crediting a registered account that settles to the SAME Master as the payer
    // would just move money from a balance to itself — skip it.
    const payerOwnerId = await resolveDataOwnerIdFor(approval.userId)
    const recipientOwnerId = await resolveDataOwnerIdFor(account.ownerUserId)
    if (payerOwnerId === recipientOwnerId) return { matched: false }

    const ledgerEntryId = `RAD-${approval.id}`

    // --- Automatic FX conversion on currency mismatch (mirrors gateway) ------
    const isFx = sentCurrency !== accountCurrency
    const grossConverted = isFx ? convertCurrency(sentAmount, sentCurrency, accountCurrency) : sentAmount
    const fxRate = isFx ? grossConverted / sentAmount : 1
    const fxFee = isFx ? round2(grossConverted * GATEWAY_FX_FEE_RATE) : 0
    const amount = round2(grossConverted - fxFee)
    if (!Number.isFinite(amount) || amount <= 0) return { matched: false }

    const sender = await resolveAccountProfileById(approval.userId)
    const reference = record.reference?.trim() || account.approvalId
    const fxNote = isFx
      ? ` Received ${sentCurrency} ${sentAmount.toLocaleString("en-US")}, converted to ${accountCurrency} at ${fxRate.toFixed(6)} (FX fee ${accountCurrency} ${fxFee.toLocaleString("en-US")}), net credited ${accountCurrency} ${amount.toLocaleString("en-US")}.`
      : ""

    // Has this credit already been posted? (decide whether to also log.)
    const existing = await query(`SELECT 1 FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [
      recipientOwnerId,
      ledgerEntryId,
    ])
    const alreadyPosted = existing.rows.length > 0

    await query(
      `INSERT INTO ledger_entries
         (user_id, entry_id, direction, amount, currency, status, entry_date,
          counterparty, account, bank, reference, comment, category, received_account)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (user_id, entry_id) DO NOTHING`,
      [
        recipientOwnerId,
        ledgerEntryId,
        "credit",
        amount,
        account.currency,
        "completed",
        new Date().toISOString(),
        sender.fullName,
        account.iban,
        account.bankName,
        reference,
        `Inbound transfer from ${sender.fullName} (approved payment ${approval.id}, reference ${reference}) auto-matched by IBAN to registered account ${account.bankName} (${account.iban}) and credited to the Master Account.${fxNote}`,
        isFx ? "Reconciled Collection (FX)" : "Reconciled Collection",
        account.iban,
      ],
    )

    if (!alreadyPosted) {
      await logActivity({
        action: `Approved payment ${approval.id} auto-matched by IBAN and credited ${account.currency} ${amount.toLocaleString("en-US")} to registered account ${account.bankName}${isFx ? ` (FX from ${sentCurrency})` : ""}`,
        category: "Administration",
        details: {
          summary: `Outgoing payment ${approval.id} from ${sender.fullName} was matched by beneficiary IBAN to ${account.bankName} (${account.iban}) and credited to the receiving owner's Master Account under ledger reference ${ledgerEntryId}.${fxNote}`,
          referenceId: approval.id,
          amount: `${account.currency} ${amount.toLocaleString("en-US")}`,
          ...(isFx
            ? {
                originalAmount: `${sentCurrency} ${sentAmount.toLocaleString("en-US")}`,
                fxRate: fxRate.toFixed(6),
                fxFee: `${account.currency} ${fxFee.toLocaleString("en-US")}`,
              }
            : {}),
          ledgerReference: ledgerEntryId,
          decision: isFx ? "Auto-matched by IBAN with FX conversion" : "Auto-matched by IBAN",
        },
      })

      // Alert the receiving account owner (beneficiary) that funds landed on
      // their registered bank account and were credited to the Master Account.
      // Fires once per new credit (guarded by `!alreadyPosted`); best-effort.
      try {
        const creditedLabel = `${account.currency} ${amount.toLocaleString("en-US")}`
        await insertNotification({
          userId: account.ownerUserId,
          tone: "success",
          title: `Payment received — ${creditedLabel}`,
          body: `You received ${creditedLabel} from ${sender.fullName} into ${account.bankName}. The funds were credited to your Master Account.`,
          href: "/dashboard",
        })
      } catch (err) {
        console.log("[v0] registered-account deposit notification failed:", (err as Error).message)
      }
    }

    return { matched: true }
  } catch (err) {
    console.log("[v0] recordRegisteredAccountDepositForApproval failed:", (err as Error).message)
    return { matched: false }
  }
}

/**
 * REVERSE a registered-account deposit when its source payment is recalled.
 * Deletes the `RAD-<approvalId>` credit from the receiving owner's ledger so the
 * Master Account (and the per-bank sub-balance) unwind exactly. Idempotent; a
 * no-op when the payment never matched a registered account.
 */
export async function reverseRegisteredAccountDepositForApproval(
  originalApprovalId: string,
): Promise<{ reversed: boolean }> {
  try {
    const ledgerEntryId = `RAD-${originalApprovalId}`
    const approval = await getApprovalById(originalApprovalId)
    if (!approval) return { reversed: false }
    const payload = (approval.payload ?? {}) as { iban?: string; record?: { iban?: string } }
    const beneficiaryIban = normalizeIban(payload.iban ?? payload.record?.iban)
    if (!beneficiaryIban) return { reversed: false }

    const accounts = await readApprovedRegisteredAccounts()
    const match = accounts.find((a) => normalizeIban(a.iban) === beneficiaryIban)
    if (!match) return { reversed: false }

    const recipientOwnerId = await resolveDataOwnerIdFor(match.ownerUserId)
    try {
      await deleteLedgerEntry(recipientOwnerId, ledgerEntryId)
    } catch (err) {
      console.log("[v0] reverse registered credit delete failed:", (err as Error).message)
    }

    await logActivity({
      action: `Recalled payment reversed registered-account credit ${ledgerEntryId}`,
      category: "Administration",
      details: {
        summary: `The credit ${ledgerEntryId} previously auto-matched to registered account ${match.bankName} (${match.iban}) was reversed because its source payment ${originalApprovalId} was recalled.`,
        referenceId: originalApprovalId,
        ledgerReference: ledgerEntryId,
        decision: "Reversed on recall",
      },
    })
    return { reversed: true }
  } catch (err) {
    console.log("[v0] reverseRegisteredAccountDepositForApproval failed:", (err as Error).message)
    return { reversed: false }
  }
}

/**
 * Back-fill sweep for a registered-account OWNER: ensure every APPROVED payment
 * addressed to one of this owner's approved registered account IBANs — sent by
 * ANY user — has been credited. Idempotent (`RAD-<approvalId>`), safe on every
 * dashboard load. Catches payments approved before the on-approval hook existed.
 */
export async function backfillRegisteredAccountDepositsForUser(ownerUserId: string): Promise<void> {
  try {
    const ownerIbans = new Set(
      (await readApprovedRegisteredAccounts())
        .filter((a) => a.ownerUserId === ownerUserId)
        .map((a) => normalizeIban(a.iban))
        .filter(Boolean),
    )
    if (ownerIbans.size === 0) return

    const { rows } = await query<{ id: string; iban: string | null; rec_iban: string | null }>(
      `SELECT id,
              payload->>'iban' AS iban,
              payload->'record'->>'iban' AS rec_iban
         FROM approval_requests
        WHERE kind = 'payment' AND status = 'approved'`,
    )
    for (const row of rows) {
      const dest = normalizeIban(row.iban ?? row.rec_iban)
      if (dest && ownerIbans.has(dest)) {
        await recordRegisteredAccountDepositForApproval(row.id)
      }
    }
  } catch (err) {
    console.log("[v0] backfillRegisteredAccountDepositsForUser failed:", (err as Error).message)
  }
}

function genId() {
  return `RCN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
}

export type ReconciliationResult =
  | { ok: true; records: ReconciliationRecord[]; lastId?: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Public admin actions
// ---------------------------------------------------------------------------

/** Admin: list all reconciliation records for the history / review queue. */
export async function listReconciliationsAdmin(passcode: string): Promise<ReconciliationResult> {
  try {
    await requireAdmin(passcode)
    return { ok: true, records: await readAllRecords() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Admin: submit a new incoming payment. The engine matches it against active
 * gateway accounts; a single exact reference+currency match is auto-credited,
 * everything else is parked for manual review.
 */
export async function submitIncomingPaymentAdmin(
  passcode: string,
  input: {
    amount: number
    currency: string
    payer: string
    reference: string
    senderIban?: string
    senderBic?: string
    valueDate?: string
  },
): Promise<ReconciliationResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid amount greater than zero." }
  if (!input.payer.trim()) return { ok: false, error: "Enter the ordering customer / payer name." }
  if (!input.reference.trim()) return { ok: false, error: "Enter the remittance reference quoted by the sender." }
  if (!input.currency.trim()) return { ok: false, error: "Select the payment currency." }

  try {
    const payment: IncomingPayment = {
      id: genId(),
      amount,
      currency: input.currency.trim().toUpperCase(),
      payer: input.payer.trim(),
      reference: input.reference.trim(),
      senderIban: input.senderIban?.trim() || undefined,
      senderBic: input.senderBic?.trim().toUpperCase() || undefined,
      valueDate: input.valueDate || new Date().toISOString(),
    }
    return await matchRecordAndCredit(admin, payment)
  } catch (err) {
    console.log("[v0] submitIncomingPaymentAdmin failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be processed. Please try again." }
  }
}

/**
 * Shared core: match a payment against active gateway accounts, persist the
 * record, auto-credit a confident match, and write the audit trail. Used by
 * both manual entry and SWIFT-message ingestion.
 */
async function matchRecordAndCredit(
  admin: UserProfile,
  payment: IncomingPayment,
): Promise<ReconciliationResult> {
  const amount = payment.amount
  const accounts = await readActiveAccounts()
  const match: MatchResult = matchPayment(payment, accounts)

  const now = new Date().toISOString()
  const record: ReconciliationRecord = {
    id: payment.id,
    payment,
    status: match.classification,
    candidates: match.candidates,
    summary: match.summary,
    createdAt: now,
    updatedAt: now,
  }

  const channel = payment.swiftType ? `${payment.swiftType} message` : "incoming payment"

  if (match.classification === "reconciled" && match.confident) {
    const account = accounts.find(
      (a) => a.userId === match.confident!.userId && a.id === match.confident!.requestId,
    )
    if (account) {
      const ledgerEntryId = await creditMatchedAccount(account, payment)
      record.matchedUserId = account.userId
      record.matchedRequestId = account.id
      record.matchedAccountHolder = account.accountHolder
      record.ledgerEntryId = ledgerEntryId

      const target = await resolveAccountProfileById(account.userId)
      await logActivity({
        action: `Reconciliation engine auto-credited ${payment.currency} ${amount.toLocaleString("en-US")} to ${target.fullName}'s Master Account`,
        category: "Administration",
        user: `${admin.fullName} (${admin.company})`,
        details: {
          summary: `Inbound ${channel} ${payment.id} from ${payment.payer} (reference ${payment.reference}${payment.uetr ? `, UETR ${payment.uetr}` : ""}) was matched with full confidence to gateway account ${account.id} and auto-credited to ${target.fullName}'s Master Account under ledger reference ${ledgerEntryId}.`,
          referenceId: payment.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          amount: `${payment.currency} ${amount.toLocaleString("en-US")}`,
          remittanceReference: payment.reference,
          ledgerReference: ledgerEntryId,
          ...(payment.uetr ? { uetr: payment.uetr } : {}),
          ...(payment.swiftType ? { swiftMessageType: payment.swiftType } : {}),
          decision: "Auto-reconciled",
        },
      })

      // Alert the account owner in the Bell that funds landed. This is the one
      // incoming path (manual admin entry + SWIFT ingestion, both routed here)
      // that previously credited the balance WITHOUT notifying the client.
      // Best-effort: a notification failure must never undo the recorded credit.
      try {
        const creditedLabel = `${payment.currency} ${amount.toLocaleString("en-US")}`
        await insertNotification({
          userId: account.userId,
          tone: "success",
          title: `Payment received — ${creditedLabel}`,
          body: `You received ${creditedLabel} from ${payment.payer.trim()}${
            payment.reference?.trim() ? ` (reference ${payment.reference.trim()})` : ""
          }${payment.swiftType ? ` via SWIFT ${payment.swiftType}` : ""}. The funds were credited to your Master Account.`,
          href: "/dashboard",
        })
      } catch (err) {
        console.log("[v0] reconciliation credit notification failed:", (err as Error).message)
      }
    } else {
      // Should not happen, but never lose a payment — park for review.
      record.status = "needs_review"
      record.summary = "Matched account could not be loaded for crediting. Parked for manual review."
    }
  } else {
    await logActivity({
      action: `Reconciliation engine flagged inbound ${channel} ${payment.id} (${match.classification === "unmatched" ? "no match" : "needs review"})`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Inbound ${channel} ${payment.id} from ${payment.payer} (reference ${payment.reference}, ${payment.currency} ${amount.toLocaleString("en-US")}) could not be auto-credited (${match.classification}). ${match.summary}`,
        referenceId: payment.id,
        amount: `${payment.currency} ${amount.toLocaleString("en-US")}`,
        remittanceReference: payment.reference,
        ...(payment.uetr ? { uetr: payment.uetr } : {}),
        ...(payment.swiftType ? { swiftMessageType: payment.swiftType } : {}),
        decision: match.classification === "unmatched" ? "Unmatched" : "Needs review",
      },
    })
  }

  await writeRecord(record)
  return { ok: true, records: await readAllRecords(), lastId: record.id }
}

/**
 * Admin: ingest a raw SWIFT MT message (MT103 / MT202 / MT202 COV). The message
 * is parsed and validated, then the extracted payment is run through the same
 * reconciliation engine as manual entry. The raw FIN text and parsed metadata
 * (type, UETR) are retained on the record for audit and the inspector view.
 */
export async function submitSwiftMessageAdmin(
  passcode: string,
  rawMessage: string,
): Promise<ReconciliationResult & { parseErrors?: string[] }> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  if (!rawMessage?.trim()) return { ok: false, error: "Paste a SWIFT MT message to ingest." }

  const parsed = parseSwiftMessage(rawMessage)
  if (!parsed.valid) {
    return {
      ok: false,
      error: `The SWIFT message failed validation: ${parsed.errors[0] ?? "unknown error"}`,
      parseErrors: parsed.errors,
    }
  }
  if (parsed.type === "MT799") {
    return {
      ok: false,
      error: "MT799 is a free-format message and carries no settlement amount to reconcile. Use the SWIFT inspector to review it.",
    }
  }

  const extract = toReconciliationInput(parsed)
  if (extract.amount === undefined || extract.amount <= 0) {
    return { ok: false, error: "The SWIFT message does not contain a valid settlement amount (:32A:)." }
  }
  if (!extract.currency) return { ok: false, error: "The SWIFT message does not contain a settlement currency." }
  if (!extract.reference.trim()) {
    return { ok: false, error: "The SWIFT message does not contain a remittance reference to match on (:70:/:21:/:20:)." }
  }

  try {
    const payment: IncomingPayment = {
      id: genId(),
      amount: extract.amount,
      currency: extract.currency.toUpperCase(),
      payer: extract.payer,
      reference: extract.reference.trim(),
      senderIban: extract.senderIban,
      senderBic: extract.senderBic?.toUpperCase(),
      valueDate: extract.valueDate || new Date().toISOString(),
      uetr: extract.uetr,
      swiftType: parsed.type,
      swiftRaw: rawMessage.trim(),
    }
    return await matchRecordAndCredit(admin, payment)
  } catch (err) {
    console.log("[v0] submitSwiftMessageAdmin failed:", (err as Error).message)
    return { ok: false, error: "The SWIFT message could not be processed. Please try again." }
  }
}

/** Admin: re-run matching for every record still in review / unmatched. */
export async function rerunReconciliationAdmin(passcode: string): Promise<ReconciliationResult> {
  try {
    await requireAdmin(passcode)
    const accounts = await readActiveAccounts()
    const records = await readAllRecords()
    for (const record of records) {
      if (record.status !== "needs_review" && record.status !== "unmatched") continue
      const match = matchPayment(record.payment, accounts)
      record.candidates = match.candidates
      record.summary = match.summary
      record.status = match.classification
      record.updatedAt = new Date().toISOString()
      await writeRecord(record)
    }
    return { ok: true, records: await readAllRecords() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Admin: manually resolve a parked payment by crediting a chosen account.
 */
export async function resolveReconciliationAdmin(
  passcode: string,
  recordId: string,
  targetUserId: string,
  targetRequestId: string,
  note?: string,
): Promise<ReconciliationResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const record = await readRecord(recordId)
    if (!record) return { ok: false, error: "Reconciliation record not found." }
    if (record.status === "reconciled") return { ok: false, error: "This payment has already been reconciled." }

    const accounts = await readActiveAccounts()
    const account = accounts.find((a) => a.userId === targetUserId && a.id === targetRequestId)
    if (!account) return { ok: false, error: "The selected destination account is no longer active." }

    const ledgerEntryId = await creditMatchedAccount(account, record.payment)
    record.status = "reconciled"
    record.matchedUserId = account.userId
    record.matchedRequestId = account.id
    record.matchedAccountHolder = account.accountHolder
    record.ledgerEntryId = ledgerEntryId
    record.resolutionNote = note?.trim() || undefined
    record.summary = `Manually reconciled to ${account.accountHolder} (reference ${account.coordinates?.reference}) by the administrator.`
    record.updatedAt = new Date().toISOString()
    await writeRecord(record)

    const target = await resolveAccountProfileById(account.userId)
    await logActivity({
      action: `Administrator manually reconciled ${record.payment.currency} ${record.payment.amount.toLocaleString("en-US")} to ${target.fullName}'s Master Account`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator manually matched incoming payment ${record.payment.id} from ${record.payment.payer} (reference ${record.payment.reference}) to gateway account ${account.id} and credited ${target.fullName}'s Master Account under ledger reference ${ledgerEntryId}.${note?.trim() ? ` Note: ${note.trim()}.` : ""}`,
        referenceId: record.payment.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        amount: `${record.payment.currency} ${record.payment.amount.toLocaleString("en-US")}`,
        ledgerReference: ledgerEntryId,
        decision: "Manually reconciled",
      },
    })
    return { ok: true, records: await readAllRecords(), lastId: record.id }
  } catch (err) {
    console.log("[v0] resolveReconciliationAdmin failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be reconciled. Please try again." }
  }
}

/** Admin: mark a payment as ignored (e.g. duplicate / not ours) without crediting. */
export async function ignoreReconciliationAdmin(
  passcode: string,
  recordId: string,
  note?: string,
): Promise<ReconciliationResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const record = await readRecord(recordId)
    if (!record) return { ok: false, error: "Reconciliation record not found." }
    if (record.status === "reconciled") return { ok: false, error: "Reconciled payments cannot be ignored." }

    record.status = "ignored"
    record.resolutionNote = note?.trim() || undefined
    record.summary = "Marked as ignored by the administrator (no funds credited)."
    record.updatedAt = new Date().toISOString()
    await writeRecord(record)

    await logActivity({
      action: `Administrator ignored incoming payment ${record.payment.id}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator marked incoming payment ${record.payment.id} from ${record.payment.payer} (reference ${record.payment.reference}, ${record.payment.currency} ${record.payment.amount.toLocaleString("en-US")}) as ignored. No funds were credited.${note?.trim() ? ` Reason: ${note.trim()}.` : ""}`,
        referenceId: record.payment.id,
        decision: "Ignored",
        reason: note?.trim() || "(none provided)",
      },
    })
    return { ok: true, records: await readAllRecords() }
  } catch (err) {
    console.log("[v0] ignoreReconciliationAdmin failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be updated. Please try again." }
  }
}
