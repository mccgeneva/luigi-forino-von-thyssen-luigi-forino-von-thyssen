"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized, adminEmails } from "@/lib/admin-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { type UserProfile } from "@/lib/users"
import { resolveAccountProfileById, resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { backfillGatewayDepositsForUser } from "@/app/actions/reconciliation"
import { readLedgerEntries, availableByCurrency } from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
import { insertNotification } from "@/lib/notifications-db"
import {
  ACCOUNT_TYPES,
  isAccountTypeKey,
  isGatewayCurrency,
  GATEWAY_ACCOUNT_FEE,
  GATEWAY_FEE_CURRENCY,
} from "@/lib/gateway-catalog"
import { resolvePartnerBank } from "@/lib/gateway-banks-db"
import type {
  GatewayAccount,
  AccountCoordinates,
  FundingEvent,
} from "@/lib/gateway-store"
import type { LedgerEntry } from "@/lib/ledger-store"

function genRequestId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`
}

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

// The full account-request object lives in a jsonb payload, with a few promoted
// columns (status / timestamps) used for ordering and authoritative reads. The
// table is created on first use so no separate migration step is required.
let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_accounts (
       user_id     text        NOT NULL,
       request_id  text        NOT NULL,
       status      text        NOT NULL,
       submitted_at timestamptz,
       decided_at  timestamptz,
       updated_at  timestamptz NOT NULL DEFAULT now(),
       payload     jsonb       NOT NULL,
       PRIMARY KEY (user_id, request_id)
     )`,
  )
  ensured = true
}

function rowToAccount(row: Record<string, unknown>): GatewayAccount {
  const payload = (row.payload as GatewayAccount) ?? ({} as GatewayAccount)
  return {
    ...payload,
    id: row.request_id as string,
    status: (row.status as GatewayAccount["status"]) ?? payload.status,
  }
}

async function readAccounts(userId: string): Promise<GatewayAccount[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM gateway_accounts WHERE user_id = $1 ORDER BY submitted_at DESC NULLS LAST`,
    [userId],
  )
  // Defense-in-depth ownership tripwire: the WHERE clause already scopes by
  // user_id, but we re-verify every row's owning column matches the requested
  // owner before returning. This guarantees a foreign client's gateway account
  // (and its funding history) can NEVER render for another signed-in user, even
  // if a future change or a stale build weakens the query above. Any mismatch is
  // dropped and logged loudly rather than leaked.
  const owned: GatewayAccount[] = []
  for (const row of rows) {
    const rowOwner = row.user_id as string
    if (rowOwner !== userId) {
      console.log(
        `[v0] gateway ownership tripwire: dropped account ${String(row.request_id)} owned by ${rowOwner} from read scoped to ${userId}`,
      )
      continue
    }
    owned.push(rowToAccount(row))
  }
  return owned
}

/** Read every user's gateway accounts (admin queue). */
async function readAllAccounts(): Promise<GatewayAccount[]> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM gateway_accounts ORDER BY submitted_at DESC NULLS LAST`,
  )
  return rows.map(rowToAccount)
}

/** Insert or update a single account row for a given user. */
async function writeAccount(userId: string, account: GatewayAccount): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO gateway_accounts
       (user_id, request_id, status, submitted_at, decided_at, updated_at, payload)
     VALUES ($1,$2,$3,$4,$5,now(),$6::jsonb)
     ON CONFLICT (user_id, request_id) DO UPDATE SET
       status = EXCLUDED.status,
       submitted_at = EXCLUDED.submitted_at,
       decided_at = EXCLUDED.decided_at,
       updated_at = now(),
       payload = EXCLUDED.payload`,
    [
      userId,
      account.id,
      account.status,
      account.submittedAt ?? null,
      account.decidedAt ?? null,
      JSON.stringify(account),
    ],
  )
}

/** Read a single account by user + request id. */
async function readAccount(userId: string, requestId: string): Promise<GatewayAccount | undefined> {
  await ensureTable()
  const { rows } = await query(
    `SELECT * FROM gateway_accounts WHERE user_id = $1 AND request_id = $2`,
    [userId, requestId],
  )
  return rows[0] ? rowToAccount(rows[0]) : undefined
}

/** Return the signed-in user's gateway account requests. */
export async function getMyGatewayAccounts(): Promise<GatewayAccount[]> {
  // getSessionUser() resolves through resolveCurrentSession(), which is
  // impersonation-aware: under an admin "Sign in as", `user.id` is the TARGET
  // client's id (not the operator's), so the gateway is always read as the
  // person whose account is on screen. All reads/writes key strictly on this id.
  const user = await getSessionUser()
  if (!user?.id) return []
  try {
    // Back-fill any approved outgoing payment addressed to one of this user's
    // gateway IBANs into a received deposit before reading, so funds auto-matched
    // by IBAN always surface here (idempotent — never double-credits).
    await backfillGatewayDepositsForUser(user.id)
    return await readAccounts(user.id)
  } catch (err) {
    console.log("[v0] getMyGatewayAccounts query failed:", (err as Error).message)
    return []
  }
}

/** Insert or update a single gateway account request for the signed-in user. */
export async function saveGatewayAccount(account: GatewayAccount): Promise<{ ok: boolean }> {
  const user = await getSessionUser()
  if (!user) return { ok: false }
  try {
    await writeAccount(user.id, account)
    return { ok: true }
  } catch (err) {
    console.log("[v0] saveGatewayAccount failed:", (err as Error).message)
    return { ok: false }
  }
}

/** Remove a single gateway account request for the signed-in user. */
export async function removeGatewayAccount(requestId: string): Promise<{ ok: boolean }> {
  const user = await getSessionUser()
  if (!user) return { ok: false }
  try {
    await ensureTable()
    await query(`DELETE FROM gateway_accounts WHERE user_id = $1 AND request_id = $2`, [
      user.id,
      requestId,
    ])
    return { ok: true }
  } catch (err) {
    console.log("[v0] removeGatewayAccount failed:", (err as Error).message)
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Client: add a bank account (charges the one-time gateway fee)
// ---------------------------------------------------------------------------

export type RequestGatewayResult =
  | { ok: true; account: GatewayAccount; feeReference: string }
  | { ok: false; error: string }

const fmtEur = (n: number) =>
  `€${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Submit a new Payment Gateway account request AND charge the one-time
 * GATEWAY_ACCOUNT_FEE to the client's Master Account, atomically and
 * authoritatively on the server:
 *
 *   1. Real-time solvency check — the fee is in EUR, so the client's whole
 *      spendable balance is converted to EUR (mirroring the approvals gate).
 *      If it can't cover the fee the request is REJECTED immediately and NO
 *      account is created and NO money moves.
 *   2. The request row is written (status "pending").
 *   3. A completed EUR debit is posted to the Master (data-owner) ledger with a
 *      DETERMINISTIC id (`GW-FEE-<requestId>`) so a retry can never double-charge.
 *      If the debit fails the pending request is rolled back.
 *
 * The client identity (id / holder / company) is taken from the session, never
 * trusted from the caller.
 */
export async function requestGatewayAccountWithFee(input: {
  type: string
  currency: string
  preferredBankKey: string
  purpose: string
}): Promise<RequestGatewayResult> {
  const user = await getSessionUser()
  if (!user?.id) return { ok: false, error: "Your session has expired. Please sign in again." }

  // Validate the request against the canonical catalogue (never trust the client).
  const type = input.type
  if (!isAccountTypeKey(type)) return { ok: false, error: "Choose a valid account type." }
  const currency = input.currency
  if (!isGatewayCurrency(currency)) return { ok: false, error: "Choose a valid currency." }
  // Any partner bank can open an account in any platform currency — the
  // currency is the customer's choice, not a per-bank restriction. We only
  // verify the bank exists in the (database-backed) directory.
  const bank = await resolvePartnerBank(input.preferredBankKey)
  if (!bank) return { ok: false, error: "Select your preferred banking partner." }
  const purpose = input.purpose.trim()
  if (!purpose) return { ok: false, error: "Describe the purpose of the account." }

  try {
    // The fee is charged against the client's Master (data-owner) balance — a
    // Sub-account's spendable funds live under its Master.
    const ownerId = await resolveDataOwnerIdFor(user.id)

    // 1) Real-time affordability check.
    const available = availableByCurrency(await readLedgerEntries(ownerId))
    const availableEur = Object.entries(available).reduce(
      (sum, [cur, amt]) => sum + convertCurrency(amt, cur, GATEWAY_FEE_CURRENCY),
      0,
    )
    if (GATEWAY_ACCOUNT_FEE > availableEur + 0.01) {
      return {
        ok: false,
        error: `Adding a bank account carries a one-time ${fmtEur(GATEWAY_ACCOUNT_FEE)} setup fee, but your Master Account has only ${fmtEur(
          Math.max(0, availableEur),
        )} available. Please fund your account and try again.`,
      }
    }

    // 2) Persist the pending request first (identity from the session).
    const account: GatewayAccount = {
      id: genRequestId("GW"),
      userId: user.id,
      accountHolder: user.fullName,
      company: user.company,
      type,
      currency,
      purpose,
      preferredBankKey: input.preferredBankKey,
      status: "pending",
      submittedAt: new Date().toISOString(),
      funding: [],
    }
    await writeAccount(user.id, account)

    // 3) Charge the one-time fee to the Master ledger (idempotent id).
    const feeReference = `GW-FEE-${account.id}`
    try {
      await query(
        `INSERT INTO ledger_entries
           (user_id, entry_id, direction, amount, currency, status, entry_date,
            counterparty, account, bank, reference, comment, category)
         VALUES ($1,$2,'debit',$3,$4,'completed',$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, entry_id) DO NOTHING`,
        [
          ownerId,
          feeReference,
          GATEWAY_ACCOUNT_FEE,
          GATEWAY_FEE_CURRENCY,
          new Date().toISOString(),
          "MCC Capital — Payment Gateway",
          null,
          bank.name,
          account.id,
          `One-time setup fee for Payment Gateway ${ACCOUNT_TYPES[type].label} ${account.id} (${currency}).`,
          "Payment Gateway Fee",
        ],
      )
    } catch (feeErr) {
      // Roll back the request so the client is never left with an account they
      // weren't charged for.
      await query(`DELETE FROM gateway_accounts WHERE user_id = $1 AND request_id = $2`, [
        user.id,
        account.id,
      ]).catch(() => {})
      console.log("[v0] requestGatewayAccountWithFee fee post failed:", (feeErr as Error).message)
      return { ok: false, error: "The setup fee could not be processed. Please try again." }
    }

    // NOTE: the client (gateway page) writes the user-facing activity-log entry
    // for this action via /api/log-activity, so we do NOT call logActivity here
    // — doing both would double-log to the same audit trail.

    // Best-effort bell notification so the charge is visible immediately.
    try {
      await insertNotification({
        userId: ownerId,
        tone: "info",
        title: "Payment Gateway fee charged",
        body: `A one-time ${fmtEur(GATEWAY_ACCOUNT_FEE)} setup fee was charged for your new ${ACCOUNT_TYPES[type].label} request (${account.id}), now pending approval.`,
        href: "/dashboard/gateway",
      })
    } catch {
      // notification is non-critical
    }

    // Alert EVERY administrator so any of them can review and approve the new
    // account request — this request form does NOT go through the approvals
    // backbone (which fans out via notifyAllAdminsOfSubmission), so without this
    // no admin was notified when a client added a bank account. Best-effort:
    // a notification failure must never fail the client's request.
    try {
      const admins = await Promise.all(adminEmails().map((e) => getDynamicUserByEmail(e).catch(() => undefined)))
      const seen = new Set<string>()
      await Promise.all(
        admins
          .filter((a): a is NonNullable<typeof a> => !!a && a.id !== ownerId && !seen.has(a.id) && (seen.add(a.id), true))
          .map((admin) =>
            insertNotification({
              userId: admin.id,
              tone: "warning",
              title: "New bank account request needs review",
              body: `${user.fullName} requested a new ${ACCOUNT_TYPES[type].label} (${account.id}, ${currency}) via the Payment Gateway — pending administrator approval. Open the Administrator panel to review and action it.`,
              href: "/dashboard/admin",
            }).catch(() => undefined),
          ),
      )
    } catch {
      // Admin fan-out is best-effort — never affect the client's request.
    }

    return { ok: true, account, feeReference }
  } catch (err) {
    console.log("[v0] requestGatewayAccountWithFee failed:", (err as Error).message)
    return { ok: false, error: "Your available balance could not be verified. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Admin cross-user actions (passcode verified server-side)
// ---------------------------------------------------------------------------

export type AdminGatewayResult =
  | { ok: true; accounts: GatewayAccount[] }
  | { ok: false; error: string }

/** Admin: read every client's gateway accounts for the review queue. */
export async function getAllGatewayAccountsAdmin(passcode: string): Promise<AdminGatewayResult> {
  try {
    await requireAdmin(passcode)
    return { ok: true, accounts: await readAllAccounts() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Admin: approve a pending request and assign partner-bank coordinates. */
export async function approveGatewayAccountAdmin(
  passcode: string,
  userId: string,
  requestId: string,
  coordinates: AccountCoordinates,
): Promise<AdminGatewayResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const account = await readAccount(userId, requestId)
    if (!account) return { ok: false, error: "Account request not found." }
    if (account.status !== "pending") return { ok: false, error: "This request has already been decided." }

    const updated: GatewayAccount = {
      ...account,
      status: "active",
      decidedAt: new Date().toISOString(),
      coordinates,
    }
    await writeAccount(userId, updated)

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator approved gateway account ${requestId} for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator approved ${target.fullName}'s ${account.type} request ${requestId} (${account.currency}) and assigned coordinates at ${coordinates.partnerBankName} — IBAN ${coordinates.iban}, BIC ${coordinates.bic}, reference ${coordinates.reference}. Incoming funds quoting this reference will be reconciled into the client's Master Account.`,
        referenceId: requestId,
        targetAccount: `${target.fullName} — ${target.email}`,
        currency: account.currency,
        partnerBank: coordinates.partnerBankName,
        iban: coordinates.iban,
        bic: coordinates.bic,
        remittanceReference: coordinates.reference,
        decision: "Approved",
      },
    })
    return { ok: true, accounts: await readAllAccounts() }
  } catch (err) {
    console.log("[v0] approveGatewayAccountAdmin failed:", (err as Error).message)
    return { ok: false, error: "The request could not be approved. Please try again." }
  }
}

/** Admin: decline a pending request with an optional reason. */
export async function rejectGatewayAccountAdmin(
  passcode: string,
  userId: string,
  requestId: string,
  reason?: string,
): Promise<AdminGatewayResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    const account = await readAccount(userId, requestId)
    if (!account) return { ok: false, error: "Account request not found." }
    if (account.status !== "pending") return { ok: false, error: "This request has already been decided." }

    const updated: GatewayAccount = {
      ...account,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      rejectionReason: reason,
    }
    await writeAccount(userId, updated)

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator declined gateway account ${requestId} for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator declined ${target.fullName}'s ${account.type} request ${requestId} (${account.currency}).${reason?.trim() ? ` Reason: ${reason.trim()}.` : ""}`,
        referenceId: requestId,
        decision: "Declined",
        reason: reason?.trim() || "(none provided)",
      },
    })
    return { ok: true, accounts: await readAllAccounts() }
  } catch (err) {
    console.log("[v0] rejectGatewayAccountAdmin failed:", (err as Error).message)
    return { ok: false, error: "The request could not be declined. Please try again." }
  }
}

/**
 * Admin: record an inbound funding event against an active account and
 * immediately reconcile it by crediting the *client's* Master Account in the
 * shared ledger. Both writes happen server-side so the credit lands on the
 * correct user and the reconciled flag can't be lost to a client race.
 */
export async function recordGatewayFundingAdmin(
  passcode: string,
  userId: string,
  requestId: string,
  funding: { amount: number; payer: string; reference?: string },
): Promise<AdminGatewayResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(funding.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter a valid amount." }
  if (!funding.payer.trim()) return { ok: false, error: "Enter the payer name." }

  try {
    const account = await readAccount(userId, requestId)
    if (!account) return { ok: false, error: "Account not found." }
    if (account.status !== "active") return { ok: false, error: "Funding can only be recorded on active accounts." }

    const reference = funding.reference?.trim() || account.coordinates?.reference || account.id
    const bankName = account.coordinates?.partnerBankName

    // The credit must land on the gateway owner's DATA-OWNER ledger (a
    // Sub-account's shared balance lives under its Master) so the Master Account
    // balance — which is read from the data-owner ledger — actually reflects it.
    const ledgerOwnerId = await resolveDataOwnerIdFor(userId)

    // 1) Credit the client's Master Account in the shared ledger.
    const receiptRef = `GW-CR-${Date.now().toString().slice(-8)}`
    const entry: LedgerEntry = {
      id: receiptRef,
      direction: "credit",
      amount,
      currency: account.currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: funding.payer.trim(),
      bank: bankName,
      reference: account.id,
      category: "Gateway Collection",
      comment: `Inbound collection received via ${account.type} ${account.id}${bankName ? ` at ${bankName}` : ""} (reference ${reference}) and reconciled to the Master Account.`,
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

    // 2) Record the funding event on the account, already reconciled.
    const now = new Date().toISOString()
    const event: FundingEvent = {
      id: `FND-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      amount,
      currency: account.currency,
      reference,
      payer: funding.payer.trim(),
      recordedAt: now,
      reconciled: true,
      reconciledAt: now,
      ledgerEntryId: receiptRef,
    }
    const updated: GatewayAccount = { ...account, funding: [event, ...account.funding] }
    await writeAccount(userId, updated)

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator reconciled ${account.currency} ${amount.toLocaleString("en-US")} into ${target.fullName}'s Master Account via gateway account ${account.id}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator recorded and reconciled an inbound collection of ${account.currency} ${amount.toLocaleString("en-US")} from ${funding.payer.trim()} received at ${bankName ?? "the partner bank"} against gateway account ${account.id}. The funds were credited to ${target.fullName}'s Master Account under ledger reference ${receiptRef}.`,
        referenceId: account.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        payer: funding.payer.trim(),
        amount: `${account.currency} ${amount.toLocaleString("en-US")}`,
        partnerBank: bankName ?? "—",
        ledgerReference: receiptRef,
        decision: "Reconciled",
      },
    })
    return { ok: true, accounts: await readAllAccounts() }
  } catch (err) {
    console.log("[v0] recordGatewayFundingAdmin failed:", (err as Error).message)
    return { ok: false, error: "The funding could not be reconciled. Please try again." }
  }
}
