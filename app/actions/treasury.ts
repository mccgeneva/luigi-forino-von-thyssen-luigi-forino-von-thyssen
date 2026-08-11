"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveAccountProfileById, resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { readLedgerEntries, upsertLedgerEntry, availableByCurrency, assertOwnerSolvent } from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
import { captureServerError } from "@/lib/debug-log-db"
import { buildTreasuryFinancingLedgerPosts, treasuryFinancingTxns } from "@/lib/treasury-financing"
import { debitInterestRateFor } from "@/lib/leverage-rates"
import { insertNotification } from "@/lib/notifications-db"
import { round2 } from "@/lib/interest-accrual"
import type { LedgerEntry } from "@/lib/ledger-store"
import type {
  TreasuryAccount,
  TreasuryProfileKey,
  TreasuryStatus,
  TreasuryTransaction,
  TreasuryTxnType,
} from "@/lib/treasury-store"

// Fallback annual debit cycle fee rate for a non-leveraged record (kept in sync
// with lib/treasury-store.ts).
const DEBIT_CYCLE_FEE_RATE = 0.018

// The debit interest rate persisted for a treasury facility. When a leverage
// facility is approved the rate follows the risk-based scale (1:5 → 10%,
// 1:10 → 8%); with no leverage there is nothing borrowed, so the fallback rate
// applies.
function treasuryFeeRate(leverageEnabled: boolean, ratio: number): number {
  return leverageEnabled ? debitInterestRateFor(ratio) : DEBIT_CYCLE_FEE_RATE
}

// Leverage facilities the administrator may approve — full ladder 1:2 … 1:30.
// Kept in sync with TREASURY_LEVERAGE_RATIOS in lib/treasury-store.ts.
const TREASURY_LEVERAGE_RATIOS = [2, 5, 10, 15, 20, 25, 30]

// Maximum leverage approved on a security deposit (1:30). Kept in sync with
// MAX_LEVERAGE_RATIO in lib/treasury-store.ts.
const MAX_LEVERAGE_RATIO = TREASURY_LEVERAGE_RATIOS[TREASURY_LEVERAGE_RATIOS.length - 1]

// Snap a value to an approved facility level; legacy/observed ratios default to
// the historical 1:10 facility so financing capacity never regresses.
function normalizeLeverageRatio(ratio: number | undefined | null): number {
  const n = Number(ratio)
  return TREASURY_LEVERAGE_RATIOS.includes(n) ? n : 10
}

// --- Session / admin helpers ------------------------------------------------

async function getSessionUser(): Promise<UserProfile | undefined> {
  const session = await resolveCurrentSession()
  return session?.profile
}

// An admin action requires (a) a valid session and (b) the administrator
// passcode, verified here on the server rather than trusting the client gate.
async function requireAdmin(passcode: string): Promise<UserProfile> {
  const user = await getSessionUser()
  if (!user) throw new Error("Your session has expired. Please sign in again.")
  // Full server-side gate: authorized admin ACCOUNT + correct PIN. The account
  // role check is what prevents a signed-in client from calling admin actions.
  if (!(await adminActionAuthorized(passcode))) throw new Error("Administrator authorization failed.")
  return user
}

// --- Default + row mapping --------------------------------------------------

function emptyAccount(): TreasuryAccount {
  return {
    profile: "pro",
    currency: "EUR",
    requiredDeposit: 0,
    customerContribution: 0,
    leverageEnabled: false,
    leverageRatio: 1,
    financedAmount: 0,
    transactionExposure: 0,
    skrCollateral: 0,
    feeRate: DEBIT_CYCLE_FEE_RATE,
    status: "none",
    transactions: [],
  }
}

function rowToAccount(row: Record<string, unknown>): TreasuryAccount {
  const txns = Array.isArray(row.transactions) ? (row.transactions as TreasuryTransaction[]) : []
  return {
    profile: (row.profile as TreasuryProfileKey) ?? "pro",
    currency: (row.currency as string) ?? "EUR",
    requiredDeposit: Number(row.required_deposit) || 0,
    customerContribution: Number(row.customer_contribution) || 0,
    leverageEnabled: Boolean(row.leverage_enabled),
    leverageRatio: Number(row.leverage_ratio) || 1,
    financedAmount: Number(row.financed_amount) || 0,
    transactionExposure: Number(row.transaction_exposure) || 0,
    skrCollateral: Number(row.skr_collateral) || 0,
    feeRate: Number(row.fee_rate) || DEBIT_CYCLE_FEE_RATE,
    status: (row.status as TreasuryStatus) ?? "pending",
    establishedAt: row.established_at ? new Date(row.established_at as string).toISOString() : undefined,
    securedAt: row.secured_at ? new Date(row.secured_at as string).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : undefined,
    note: (row.note as string) ?? undefined,
    transactions: txns,
  }
}

async function readAccount(userId: string): Promise<TreasuryAccount> {
  const { rows } = await query(`SELECT * FROM treasury_accounts WHERE user_id = $1`, [userId])
  if (rows.length === 0) return emptyAccount()
  return rowToAccount(rows[0])
}

// --- Debit-interest reconciliation (server authoritative) -------------------

/**
 * Post any monthly treasury-financing debit interest (3% p.a., charged monthly
 * pro-rata from the financing date) that has come due but is not yet on the
 * ledger — SERVER-SIDE, so a client's monthly charge lands reliably whether or
 * not they ever open their dashboard.
 *
 * Historically the ONLY thing that posted these charges was the client-side
 * `TreasuryFinancingReconciler`, which runs on dashboard mount. If a client did
 * not sign in for a month, that month was silently never charged into their
 * master account. Running the same deterministic accrual here — on every
 * treasury read, including the admin's — closes that gap.
 *
 * Idempotent: each charge has a deterministic `TRY-INT-<txnId>-<yearMonth>` id
 * and we skip any id already present, so posting on every read never
 * double-charges. Never throws: a reconciliation failure must not break the
 * treasury read it piggybacks on. Returns the number of charges newly posted.
 */
async function reconcileTreasuryInterest(treasuryUserId: string, account: TreasuryAccount): Promise<number> {
  try {
    // Cheap guard: nothing to accrue unless there is financed principal.
    if (treasuryFinancingTxns(account).length === 0) return 0

    // The shared balance lives on the data owner's (Master) ledger — a
    // sub-account's charges must post to its Master, exactly like every other
    // ledger effect in the platform.
    const ledgerOwnerId = await resolveDataOwnerIdFor(treasuryUserId)
    const existing = new Set((await readLedgerEntries(ledgerOwnerId)).map((e) => e.id))

    const posts = buildTreasuryFinancingLedgerPosts(account, existing)
    let posted = 0
    for (const post of posts) {
      await upsertLedgerEntry(ledgerOwnerId, { ...post.entry, direction: post.direction })
      posted += 1
    }
    return posted
  } catch (err) {
    console.log("[v0] reconcileTreasuryInterest failed:", (err as Error).message)
    void captureServerError(err, {
      kind: "treasury.reconcileInterest",
      userId: treasuryUserId,
      meta: { profile: account.profile, currency: account.currency },
    })
    return 0
  }
}

// --- Customer-facing read (own record only) ---------------------------------

/** Return the signed-in user's treasury record, scoped to their session. */
export async function getMyTreasury(): Promise<TreasuryAccount> {
  const user = await getSessionUser()
  if (!user) return emptyAccount()
  try {
    const account = await readAccount(user.id)
    // Post any monthly debit interest that has come due (idempotent, server-side)
    // so the charge lands even if the client-side reconciler never runs.
    await reconcileTreasuryInterest(user.id, account)
    return account
  } catch (err) {
    console.log("[v0] getMyTreasury query failed:", (err as Error).message)
    return emptyAccount()
  }
}

// --- Admin reads/writes (any client) ----------------------------------------

export type AdminTreasuryResult =
  | { ok: true; account: TreasuryAccount }
  | { ok: false; error: string }

/** Admin: read any client's treasury record. */
export async function getTreasuryForUserAdmin(
  passcode: string,
  userId: string,
): Promise<AdminTreasuryResult> {
  try {
    await requireAdmin(passcode)
    const account = await readAccount(userId)
    // Bring the client's ledger current: post any monthly debit interest due on
    // their treasury financing, so the admin sees every month charged even if
    // the client has not opened their dashboard since the last month-end.
    await reconcileTreasuryInterest(userId, account)
    return { ok: true, account }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// --- Client available cash-flow (master account balance) --------------------

/**
 * Compute a client's AVAILABLE master-account balance, expressed as a single
 * EUR figure plus the per-currency breakdown. "Available" already nets out any
 * pending holds (see `availableByCurrency`). Every currency bucket is converted
 * to EUR so it can be compared against a EUR treasury contribution. Balances
 * always live on the data owner's (Master) ledger, so a sub-account's cash flow
 * is read from its Master — exactly like every other ledger effect.
 */
async function readClientAvailableEur(
  userId: string,
): Promise<{ eur: number; byCurrency: Record<string, number> }> {
  const ledgerOwnerId = await resolveDataOwnerIdFor(userId)
  const byCurrency = availableByCurrency(await readLedgerEntries(ledgerOwnerId))
  let eur = 0
  for (const [cur, amount] of Object.entries(byCurrency)) {
    eur += cur === "EUR" ? amount : convertCurrency(amount, cur, "EUR")
  }
  return { eur: round2(eur), byCurrency }
}

export type ClientBalanceResult =
  | { ok: true; availableEur: number; byCurrency: Record<string, number> }
  | { ok: false; error: string }

/**
 * Admin: read a client's real-time available master-account balance (EUR
 * equivalent). Used by the treasury manager to validate, live, that a customer
 * contribution actually fits the client's cash flow before it is saved.
 */
export async function getClientAvailableBalanceAdmin(
  passcode: string,
  userId: string,
): Promise<ClientBalanceResult> {
  try {
    await requireAdmin(passcode)
    const { eur, byCurrency } = await readClientAvailableEur(userId)
    return { ok: true, availableEur: eur, byCurrency }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Admin: create or update a client's treasury record. The leverage math
 * (financed amount, applied ratio) is computed authoritatively on the server.
 */
export async function saveTreasuryRecordAdmin(
  passcode: string,
  userId: string,
  fields: {
    profile: TreasuryProfileKey
    requiredDeposit: number
    customerContribution: number
    leverageEnabled: boolean
    /** Approved facility level (1:5 or 1:10). Defaults to 1:10 when omitted. */
    leverageRatio?: number
    transactionExposure: number
    status: TreasuryStatus
    note?: string
  },
): Promise<AdminTreasuryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const required = Math.max(0, Number(fields.requiredDeposit) || 0)
  if (required <= 0) return { ok: false, error: "Enter a valid required security deposit." }

  const contribution = Math.max(0, Number(fields.customerContribution) || 0)
  const leverageEnabled = Boolean(fields.leverageEnabled)

  const exposure = leverageEnabled ? Math.max(0, Number(fields.transactionExposure) || 0) : 0

  // Approved facility level chosen by the administrator (1:5 or 1:10). When the
  // facility is off we store 1 (no leverage). This is the AUTHORITATIVE ratio —
  // it drives the financing cap, the minimum contribution, and what the client
  // sees, rather than an observed required/contribution figure.
  const ratio = leverageEnabled ? normalizeLeverageRatio(fields.leverageRatio) : 1

  const note = fields.note?.toString().trim() || null
  const now = new Date().toISOString()

  const target = await resolveAccountProfileById(userId)

  // Rolls back the contribution ledger debit if the record write later fails,
  // so money moved out of the client's balance and the saved record never
  // diverge. Assigned once the debit adjustment is applied below.
  let rollbackContribution: (() => Promise<void>) | null = null

  try {
    const prev = await readAccount(userId)

    // Real-time cash-flow gate: the customer contribution is funded from the
    // client's own money, so any ADDITIONAL contribution beyond what is already
    // on record must fit their available master-account balance. We check the
    // increase (not the absolute figure) so re-saving or lowering an existing
    // record is never blocked, and we read the balance live at save time so the
    // decision reflects the client's real cash flow — not a stale UI value.
    const addedContribution = round2(Math.max(0, contribution - (prev.customerContribution || 0)))
    if (addedContribution > 0) {
      const { eur: availableEur } = await readClientAvailableEur(userId)
      // Allow a 1-cent tolerance for rounding across FX conversion.
      if (addedContribution > availableEur + 0.01) {
        return {
          ok: false,
          error: `Customer contribution exceeds the client's available balance. ${target.fullName} has EUR ${availableEur.toLocaleString(
            "en-US",
            { maximumFractionDigits: 2 },
          )} available, but this adds EUR ${addedContribution.toLocaleString("en-US", {
            maximumFractionDigits: 2,
          })} of new contribution. Reduce the contribution or fund the client's account first.`,
        }
      }
    }

    // Pledged SKR collateral is preserved across administrator edits and counts
    // toward the secured deposit, reducing the amount MCC HOLDING SA finances.
    const collateral = Math.max(0, prev.skrCollateral || 0)
    // The approved facility (1:5 or 1:10) can finance at most (ratio − 1)× the
    // client's own contribution; we finance the gap to the required deposit but
    // never beyond that cap, so a thin contribution leaves a real shortfall.
    const maxFinanceable = leverageEnabled ? contribution * (ratio - 1) : 0
    const financed = leverageEnabled
      ? Math.min(Math.max(0, required - contribution - collateral), maxFinanceable)
      : 0
    const secured = contribution + financed + collateral

    // Derive the stored status from the real coverage so it can never be saved as
    // "secured" while the deposit is actually uncovered. "closed" stays explicit.
    let status: TreasuryStatus
    if (fields.status === "closed") status = "closed"
    else if (required > 0 && secured >= required) status = "secured"
    else if (secured > 0) status = "shortfall"
    else status = "pending"

    const establishedAt = prev.establishedAt ?? now
    // Stamp securedAt the first time the deposit becomes secured (fee accrual start).
    const securedAt = status === "secured" ? prev.securedAt ?? now : prev.securedAt ?? null

    // --- Move the customer contribution OUT of the master balance ------------
    // The contribution is the client's own money pledged as the security
    // deposit, so it must LEAVE the master balance — recording the figure alone
    // (the previous behaviour) left the cash visibly sitting in the client's
    // account. We manage a single deterministic contribution debit per account
    // and settle it to the target amount, so administrator edits (up OR down)
    // are idempotent and refund the difference on a decrease. Any portion the
    // client already self-funded (TRYDEP- deposits) is NOT re-charged.
    const ledgerOwnerId = await resolveDataOwnerIdFor(userId)
    const ledgerEntries = await readLedgerEntries(ledgerOwnerId)
    const adminDepositId = `TRYADMDEP-${userId}`
    const prevAdminEntry = ledgerEntries.find((e) => e.id === adminDepositId && e.direction === "debit")
    const selfFunded = round2(
      ledgerEntries
        .filter((e) => e.direction === "debit" && e.category === "Treasury Deposit" && e.id !== adminDepositId)
        .reduce((sum, e) => sum + e.amount, 0),
    )
    const targetAdminDebit = round2(Math.max(0, contribution - selfFunded))

    rollbackContribution = async () => {
      try {
        if (prevAdminEntry) await upsertLedgerEntry(ledgerOwnerId, prevAdminEntry)
        else await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, adminDepositId])
      } catch {
        /* best-effort rollback */
      }
    }

    try {
      if (targetAdminDebit <= 0.01) {
        await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, adminDepositId])
      } else {
        const debit: LedgerEntry = {
          id: adminDepositId,
          direction: "debit",
          amount: targetAdminDebit,
          currency: "EUR",
          status: "completed",
          date: now,
          counterparty: "MCC Capital — Treasury Security Deposit",
          reference: adminDepositId,
          category: "Treasury Deposit",
          comment: `Security-deposit contribution held from the master account (${
            leverageEnabled ? `1:${Math.round(ratio)} leverage facility` : "no leverage"
          }).`,
        }
        await upsertLedgerEntry(ledgerOwnerId, debit)
      }
      await assertOwnerSolvent(ledgerOwnerId)
    } catch (err) {
      await rollbackContribution()
      rollbackContribution = null
      const msg = (err as Error).message
      if (msg.startsWith("INSUFFICIENT_FUNDS")) {
        return {
          ok: false,
          error: `The client's master balance can't cover this contribution. ${target.fullName} does not have enough available EUR to move to the security deposit. Nothing was changed.`,
        }
      }
      console.log("[v0] saveTreasuryRecordAdmin contribution debit failed:", msg)
      return { ok: false, error: "The contribution could not be moved from the client's balance. Please try again." }
    }

    const { rows } = await query(
      `INSERT INTO treasury_accounts
         (user_id, profile, currency, required_deposit, customer_contribution,
          leverage_enabled, leverage_ratio, financed_amount, transaction_exposure,
          fee_rate, status, established_at, secured_at, updated_at, note, skr_collateral)
       VALUES ($1,$2,'EUR',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id) DO UPDATE SET
         profile = EXCLUDED.profile,
         required_deposit = EXCLUDED.required_deposit,
         customer_contribution = EXCLUDED.customer_contribution,
         leverage_enabled = EXCLUDED.leverage_enabled,
         leverage_ratio = EXCLUDED.leverage_ratio,
         financed_amount = EXCLUDED.financed_amount,
         transaction_exposure = EXCLUDED.transaction_exposure,
         fee_rate = EXCLUDED.fee_rate,
         status = EXCLUDED.status,
         established_at = EXCLUDED.established_at,
         secured_at = EXCLUDED.secured_at,
         updated_at = EXCLUDED.updated_at,
         note = EXCLUDED.note,
         skr_collateral = EXCLUDED.skr_collateral
       RETURNING *`,
      [
        userId,
        fields.profile,
        required,
        contribution,
        leverageEnabled,
        ratio,
        financed,
        exposure,
        treasuryFeeRate(leverageEnabled, ratio),
        status,
        establishedAt,
        securedAt,
        now,
        note,
        collateral,
      ],
    )

    await logActivity({
      action: `Administrator updated the treasury record for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        targetAccount: `${target.fullName} — ${target.email}`,
        requiredDeposit: `EUR ${required.toLocaleString("en-US")}`,
        customerContribution: `EUR ${contribution.toLocaleString("en-US")}`,
        leverage: leverageEnabled ? `1:${Math.round(ratio)} — EUR ${financed.toLocaleString("en-US")} financed by MCC HOLDING SA` : "None",
        status,
      },
    })

    return { ok: true, account: rowToAccount(rows[0]) }
  } catch (err) {
    // The record write failed after the contribution debit was applied — undo
    // the money movement so the balance and the saved record stay consistent.
    if (rollbackContribution) await rollbackContribution()
    console.log("[v0] saveTreasuryRecordAdmin failed:", (err as Error).message)
    return { ok: false, error: "The treasury record could not be saved. Please try again." }
  }
}

function genTreasuryId(prefix = "TRY"): string {
  const n = Math.floor(1_000_000 + Math.random() * 9_000_000)
  return `${prefix}${n}`
}

/** Admin: post a treasury transaction to a client's record. */
export async function postTreasuryTxnAdmin(
  passcode: string,
  userId: string,
  input: { type: TreasuryTxnType; label: string; amount: number; note?: string },
): Promise<AdminTreasuryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid transaction amount." }
  }

  try {
    const prev = await readAccount(userId)
    if (prev.status === "none") {
      return { ok: false, error: "Establish the treasury record first (save the record above)." }
    }
    const txn: TreasuryTransaction = {
      id: genTreasuryId(),
      date: new Date().toISOString(),
      type: input.type,
      label: input.label.trim() || input.type,
      amount,
      currency: "EUR",
      note: input.note?.toString().trim() || undefined,
    }
    const transactions = [txn, ...prev.transactions]
    const { rows } = await query(
      `UPDATE treasury_accounts
          SET transactions = $2::jsonb, updated_at = $3
        WHERE user_id = $1
        RETURNING *`,
      [userId, JSON.stringify(transactions), txn.date],
    )

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator posted a treasury ${input.type} of EUR ${amount.toLocaleString("en-US")} for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: txn.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        type: txn.label,
        amount: `EUR ${amount.toLocaleString("en-US")}`,
        note: txn.note ?? "(none)",
      },
    })

    return { ok: true, account: rowToAccount(rows[0]) }
  } catch (err) {
    console.log("[v0] postTreasuryTxnAdmin failed:", (err as Error).message)
    return { ok: false, error: "The transaction could not be posted. Please try again." }
  }
}

/** Admin: delete a treasury transaction from a client's record. */
export async function deleteTreasuryTxnAdmin(
  passcode: string,
  userId: string,
  txnId: string,
): Promise<AdminTreasuryResult> {
  try {
    await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    const prev = await readAccount(userId)
    const transactions = prev.transactions.filter((t) => t.id !== txnId)
    const { rows } = await query(
      `UPDATE treasury_accounts
          SET transactions = $2::jsonb, updated_at = $3
        WHERE user_id = $1
        RETURNING *`,
      [userId, JSON.stringify(transactions), new Date().toISOString()],
    )
    if (rows.length === 0) return { ok: false, error: "No treasury record found for this client." }
    return { ok: true, account: rowToAccount(rows[0]) }
  } catch (err) {
    console.log("[v0] deleteTreasuryTxnAdmin failed:", (err as Error).message)
    return { ok: false, error: "The transaction could not be removed. Please try again." }
  }
}

/**
 * Admin: completely remove a client's treasury facility.
 *
 * Deleting the row is what makes the removal actually "stick": the customer's
 * `getMyTreasury` / `/api/treasury` read falls back to `emptyAccount()` (status
 * "none"), so the client's Treasury page shows the "No treasury account
 * established" empty state on their next load/refresh — not a stale "Fully
 * Secured" deposit. Returns the empty account so the admin editor resets too.
 */
export async function deleteTreasuryRecordAdmin(
  passcode: string,
  userId: string,
): Promise<AdminTreasuryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    const prev = await readAccount(userId)
    if (prev.status === "none") {
      // Nothing on record — treat as already removed (idempotent).
      return { ok: true, account: emptyAccount() }
    }

    await query(`DELETE FROM treasury_accounts WHERE user_id = $1`, [userId])

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator removed the treasury facility for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        targetAccount: `${target.fullName} — ${target.email}`,
        removedDeposit: `EUR ${prev.requiredDeposit.toLocaleString("en-US")}`,
        removedContribution: `EUR ${prev.customerContribution.toLocaleString("en-US")}`,
        priorStatus: prev.status,
      },
    })

    return { ok: true, account: emptyAccount() }
  } catch (err) {
    console.log("[v0] deleteTreasuryRecordAdmin failed:", (err as Error).message)
    return { ok: false, error: "The treasury facility could not be removed. Please try again." }
  }
}

// --- SKR collateral → treasury balance --------------------------------------
//
// When the custody desk credits a Safe Keeping Receipt to a client's treasury,
// the SKR's value is pledged as collateral and added to the secured balance the
// client can use for trading. It counts toward the required deposit (reducing
// any shortfall and the amount MCC HOLDING SA must finance) but is not itself
// leveraged. Crediting is idempotent per SKR — the SKR manager records that a
// receipt has been credited and reverses it on un-credit or deletion.

// PRO profile baseline deposit (EUR), used to establish a treasury record on the
// fly the first time SKR collateral is credited to a client with none. Kept in
// sync with TREASURY_PROFILES["pro"].requiredDeposit in lib/treasury-store.ts.
const DEFAULT_REQUIRED_DEPOSIT = 500_000

/** Derive the financed/secured/ratio/status from real coverage incl. collateral. */
function deriveCoverage(opts: {
  required: number
  contribution: number
  leverageEnabled: boolean
  collateral: number
  explicitClosed: boolean
  /** Approved facility level to preserve (1:5 or 1:10); defaults to 1:10. */
  approvedRatio?: number
}): { financed: number; secured: number; ratio: number; status: TreasuryStatus } {
  const { required, contribution, leverageEnabled, collateral } = opts
  // Keep the administrator's approved facility; never overwrite it with an
  // observed required/contribution figure when collateral moves.
  const ratio = leverageEnabled ? normalizeLeverageRatio(opts.approvedRatio) : 1
  const maxFin = leverageEnabled ? contribution * (ratio - 1) : 0
  const financed = leverageEnabled
    ? Math.min(Math.max(0, required - contribution - collateral), maxFin)
    : 0
  const secured = contribution + financed + collateral
  let status: TreasuryStatus
  if (opts.explicitClosed) status = "closed"
  else if (required > 0 && secured >= required) status = "secured"
  else if (secured > 0) status = "shortfall"
  else status = "pending"
  return { financed, secured, ratio, status }
}

/** Full upsert of a treasury record including its transaction ledger. */
async function upsertTreasuryWithLedger(p: {
  userId: string
  profile: TreasuryProfileKey
  required: number
  contribution: number
  leverageEnabled: boolean
  ratio: number
  financed: number
  exposure: number
  status: TreasuryStatus
  establishedAt: string
  securedAt: string | null
  now: string
  note: string | null
  collateral: number
  transactions: TreasuryTransaction[]
}): Promise<TreasuryAccount> {
  const { rows } = await query(
    `INSERT INTO treasury_accounts
       (user_id, profile, currency, required_deposit, customer_contribution,
        leverage_enabled, leverage_ratio, financed_amount, transaction_exposure,
        fee_rate, status, established_at, secured_at, updated_at, note,
        skr_collateral, transactions)
     VALUES ($1,$2,'EUR',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       profile = EXCLUDED.profile,
       required_deposit = EXCLUDED.required_deposit,
       customer_contribution = EXCLUDED.customer_contribution,
       leverage_enabled = EXCLUDED.leverage_enabled,
       leverage_ratio = EXCLUDED.leverage_ratio,
       financed_amount = EXCLUDED.financed_amount,
       transaction_exposure = EXCLUDED.transaction_exposure,
       status = EXCLUDED.status,
       established_at = EXCLUDED.established_at,
       secured_at = EXCLUDED.secured_at,
       updated_at = EXCLUDED.updated_at,
       skr_collateral = EXCLUDED.skr_collateral,
       transactions = EXCLUDED.transactions
     RETURNING *`,
    [
      p.userId,
      p.profile,
      p.required,
      p.contribution,
      p.leverageEnabled,
      p.ratio,
      p.financed,
      p.exposure,
      treasuryFeeRate(p.leverageEnabled, p.ratio),
      p.status,
      p.establishedAt,
      p.securedAt,
      p.now,
      p.note,
      p.collateral,
      JSON.stringify(p.transactions),
    ],
  )
  return rowToAccount(rows[0])
}

/**
 * Admin: credit an SKR's value to a client's treasury balance as pledged
 * collateral. Establishes a PRO treasury record on the fly if the client has
 * none, so the collateral is immediately reflected.
 */
export async function creditSkrCollateralAdmin(
  passcode: string,
  userId: string,
  input: { skrId: string; amount: number; currency?: string; note?: string },
): Promise<AdminTreasuryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid SKR value to credit (in EUR)." }
  }

  try {
    const prev = await readAccount(userId)
    const wasNone = prev.status === "none"
    const required = wasNone ? DEFAULT_REQUIRED_DEPOSIT : prev.requiredDeposit
    const profile: TreasuryProfileKey = wasNone ? "pro" : prev.profile
    const collateral = Math.max(0, prev.skrCollateral || 0) + amount

    const { financed, secured, ratio, status } = deriveCoverage({
      required,
      contribution: prev.customerContribution,
      leverageEnabled: prev.leverageEnabled,
      collateral,
      explicitClosed: prev.status === "closed",
      approvedRatio: prev.leverageRatio,
    })

    const now = new Date().toISOString()
    const establishedAt = prev.establishedAt ?? now
    const securedAt = status === "secured" ? prev.securedAt ?? now : prev.securedAt ?? null

    const sourceNote =
      input.note?.toString().trim() ||
      (input.currency && input.currency !== "EUR"
        ? `Pledged value of SKR ${input.skrId} (${input.currency} original)`
        : `Pledged value of SKR ${input.skrId}`)

    const txn: TreasuryTransaction = {
      id: genTreasuryId("SKR"),
      date: now,
      type: "collateral",
      label: `SKR Collateral — ${input.skrId}`,
      amount,
      currency: "EUR",
      note: sourceNote,
    }

    const account = await upsertTreasuryWithLedger({
      userId,
      profile,
      required,
      contribution: prev.customerContribution,
      leverageEnabled: prev.leverageEnabled,
      ratio,
      financed,
      exposure: prev.transactionExposure,
      status,
      establishedAt,
      securedAt,
      now,
      note: prev.note ?? null,
      collateral,
      transactions: [txn, ...prev.transactions],
    })

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator credited SKR ${input.skrId} (EUR ${amount.toLocaleString("en-US")}) to the treasury balance of ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: input.skrId,
        targetAccount: `${target.fullName} — ${target.email}`,
        creditedValue: `EUR ${amount.toLocaleString("en-US")}`,
        totalSkrCollateral: `EUR ${collateral.toLocaleString("en-US")}`,
        treasuryBalance: `EUR ${secured.toLocaleString("en-US")}`,
        status,
      },
    })

    return { ok: true, account }
  } catch (err) {
    console.log("[v0] creditSkrCollateralAdmin failed:", (err as Error).message)
    return { ok: false, error: "The SKR value could not be credited to treasury. Please try again." }
  }
}

/**
 * Admin: reverse a previously credited SKR. Removes the matching collateral
 * ledger entries and reduces the pledged collateral accordingly. Safe to call
 * even if the SKR was never credited (no-op on a clean record).
 */
export async function reverseSkrCollateralAdmin(
  passcode: string,
  userId: string,
  input: { skrId: string },
): Promise<AdminTreasuryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    const prev = await readAccount(userId)
    const label = `SKR Collateral — ${input.skrId}`
    const matching = prev.transactions.filter((t) => t.type === "collateral" && t.label === label)
    if (matching.length === 0 && (prev.skrCollateral || 0) <= 0) {
      // Nothing credited for this SKR — return the record unchanged.
      return { ok: true, account: prev }
    }

    const removed = matching.reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
    const collateral = Math.max(0, (prev.skrCollateral || 0) - removed)
    const transactions = prev.transactions.filter((t) => !(t.type === "collateral" && t.label === label))

    const { financed, secured, ratio, status } = deriveCoverage({
      required: prev.requiredDeposit,
      contribution: prev.customerContribution,
      leverageEnabled: prev.leverageEnabled,
      collateral,
      explicitClosed: prev.status === "closed",
      approvedRatio: prev.leverageRatio,
    })

    const now = new Date().toISOString()
    const securedAt = status === "secured" ? prev.securedAt ?? now : prev.securedAt ?? null

    const account = await upsertTreasuryWithLedger({
      userId,
      profile: prev.profile,
      required: prev.requiredDeposit,
      contribution: prev.customerContribution,
      leverageEnabled: prev.leverageEnabled,
      ratio,
      financed,
      exposure: prev.transactionExposure,
      status,
      establishedAt: prev.establishedAt ?? now,
      securedAt,
      now,
      note: prev.note ?? null,
      collateral,
      transactions,
    })

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator reversed the SKR ${input.skrId} treasury credit for ${target.fullName}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: input.skrId,
        targetAccount: `${target.fullName} — ${target.email}`,
        reversedValue: `EUR ${removed.toLocaleString("en-US")}`,
        remainingSkrCollateral: `EUR ${collateral.toLocaleString("en-US")}`,
        treasuryBalance: `EUR ${secured.toLocaleString("en-US")}`,
        status,
      },
    })

    return { ok: true, account }
  } catch (err) {
    console.log("[v0] reverseSkrCollateralAdmin failed:", (err as Error).message)
    return { ok: false, error: "The SKR treasury credit could not be reversed. Please try again." }
  }
}

// --- Client self-service: fund the security deposit from the master balance --
//
// A client may top up their own security-deposit contribution with their own
// money from the master account. The applied cash raises their contribution,
// which first fills any remaining shortfall and then buys DOWN the
// leverage-financed portion (MCC HOLDING SA financing), reducing the financed
// amount and therefore the 1.8% debit cycle fee. Fully server-authoritative:
// the amount is balance-gated against the master EUR balance, capped so it can
// never over-fund beyond a fully self-secured deposit, the EUR debit is posted
// with a hard solvency assertion (rolled back on any overdraft), and the
// coverage (financed / secured / status) is recomputed with the same
// `deriveCoverage` used everywhere else so the two channels always agree.

const DEPOSIT_CURRENCY = "EUR"

export type FundDepositResult =
  | {
      ok: true
      applied: number
      contribution: number
      financed: number
      secured: number
      shortfall: number
      status: TreasuryStatus
    }
  | { ok: false; error: string }

export async function fundTreasuryDepositFromBalance(amountInput: number): Promise<FundDepositResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const amount = Number(amountInput)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid amount to apply to your security deposit." }
  }

  const prev = await readAccount(session.id)
  if (prev.status === "none" || prev.status === "closed") {
    return {
      ok: false,
      error: "A treasury account must be established before you can fund its security deposit.",
    }
  }

  const fmt = (n: number) =>
    `${DEPOSIT_CURRENCY} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const collateral = Math.max(0, prev.skrCollateral || 0)
  // The most own-cash that still does something useful: enough to fully secure
  // the deposit with the client's own money (no leverage). Beyond this, extra
  // cash would just be locked, so we never charge more than this.
  const maxUseful = round2(Math.max(0, prev.requiredDeposit - collateral - prev.customerContribution))
  if (maxUseful <= 0.01) {
    return {
      ok: false,
      error:
        "Your security deposit is already fully funded by your own contribution — there is nothing left to buy down.",
    }
  }

  const ledgerOwnerId = session.dataOwnerId || (await resolveDataOwnerIdFor(session.id))
  const entries = await readLedgerEntries(ledgerOwnerId)
  const availableEur = round2(availableByCurrency(entries)[DEPOSIT_CURRENCY] ?? 0)

  // Apply the smallest of: what they asked for, what is still useful, and what
  // their balance can actually cover.
  const applied = round2(Math.min(amount, maxUseful, availableEur))
  if (applied <= 0.01) {
    return {
      ok: false,
      error: `Your master account balance can’t cover this. Available ${fmt(Math.max(0, availableEur))}. Nothing was charged.`,
    }
  }

  const now = new Date().toISOString()
  const profileLabel = prev.profile === "avantgarde" ? "Avant-Garde Account" : "PRO Account"
  const entryId = `TRYDEP-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const debit: LedgerEntry = {
    id: entryId,
    direction: "debit",
    amount: applied,
    currency: DEPOSIT_CURRENCY,
    status: "completed",
    date: now,
    counterparty: "MCC Capital — Treasury Security Deposit",
    reference: entryId,
    category: "Treasury Deposit",
    comment: `Security-deposit contribution funded from the master account (${profileLabel}).`,
  }

  // Post the EUR debit and assert solvency; roll back on any overdraft.
  try {
    await upsertLedgerEntry(ledgerOwnerId, debit)
    await assertOwnerSolvent(ledgerOwnerId)
  } catch (err) {
    try {
      await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, entryId])
    } catch {
      /* best-effort rollback */
    }
    const msg = (err as Error).message
    if (msg.startsWith("INSUFFICIENT_FUNDS")) {
      return { ok: false, error: "Your master account balance can’t cover this amount. Nothing was charged." }
    }
    console.log("[v0] fundTreasuryDepositFromBalance debit failed:", msg)
    return { ok: false, error: "The deposit funding could not be charged. Please try again." }
  }

  // Buy-down semantics: the applied own-cash raises the client's contribution
  // and reduces the leverage-financed portion pound-for-pound (it does NOT get
  // re-multiplied by the leverage ratio — that is the whole point of funding it
  // yourself). We derive the NEW financed amount directly from the previous
  // one rather than through `deriveCoverage`, whose ratio-based model would
  // otherwise grow the financed figure as the contribution rises.
  const contribution = round2(prev.customerContribution + applied)
  const ratio = prev.leverageEnabled ? prev.leverageRatio : 1
  const prevFinanced = Math.max(0, prev.financedAmount || 0)
  // Own cash first covers any uncovered gap, then buys down financing.
  const prevSecured = prev.customerContribution + prevFinanced + collateral
  const prevShortfall = Math.max(0, prev.requiredDeposit - prevSecured)
  const towardShortfall = Math.min(applied, prevShortfall)
  const towardBuyDown = round2(applied - towardShortfall)
  const financed = round2(Math.max(0, prevFinanced - towardBuyDown))
  const secured = round2(contribution + financed + collateral)
  const status: TreasuryStatus =
    prev.requiredDeposit > 0 && secured >= prev.requiredDeposit - 0.01
      ? "secured"
      : secured > 0
        ? "shortfall"
        : "pending"
  const establishedAt = prev.establishedAt ?? now
  const securedAt = status === "secured" ? prev.securedAt ?? now : prev.securedAt ?? null

  const txn: TreasuryTransaction = {
    id: genTreasuryId("DEP"),
    date: now,
    type: "deposit",
    label: "Security Deposit — Self-funded",
    amount: applied,
    currency: DEPOSIT_CURRENCY,
    note: "Funded from the master account balance by the client.",
  }

  try {
    const account = await upsertTreasuryWithLedger({
      userId: session.id,
      profile: prev.profile,
      required: prev.requiredDeposit,
      contribution,
      leverageEnabled: prev.leverageEnabled,
      ratio,
      financed,
      exposure: prev.transactionExposure,
      status,
      establishedAt,
      securedAt,
      now,
      note: prev.note ?? null,
      collateral,
      transactions: [txn, ...prev.transactions],
    })

    const shortfall = round2(Math.max(0, prev.requiredDeposit - secured))
    void logActivity({
      action: `Funded treasury security deposit from master balance (${fmt(applied)})`,
      category: "Treasury",
      userId: session.id,
      details: {
        facility: profileLabel,
        applied: fmt(applied),
        newContribution: fmt(contribution),
        financedRemaining: fmt(financed),
        shortfallRemaining: fmt(shortfall),
        status,
        decision: "Funded from master balance (client self-service)",
      },
    }).catch(() => {})

    try {
      await insertNotification({
        userId: session.id,
        tone: "success",
        title: "Security deposit funded",
        body:
          `${fmt(applied)} was applied to your ${profileLabel} security deposit from your master account. ` +
          (financed > 0
            ? `The leverage-financed portion is now ${fmt(financed)}.`
            : `Your deposit is now fully secured by your own contribution.`),
        href: "/dashboard/treasury",
      })
    } catch {
      /* notification is best-effort */
    }

    return { ok: true, applied, contribution, financed, secured, shortfall, status }
  } catch (err) {
    // The debit posted but the record write failed — roll the debit back so
    // money and coverage never diverge.
    try {
      await query(`DELETE FROM ledger_entries WHERE user_id = $1 AND entry_id = $2`, [ledgerOwnerId, entryId])
    } catch {
      /* best-effort rollback */
    }
    console.log("[v0] fundTreasuryDepositFromBalance record write failed:", (err as Error).message)
    return { ok: false, error: "The deposit funding could not be recorded. Please try again. Nothing was charged." }
  }
}
