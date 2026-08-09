"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveAccountProfileById, resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { readLedgerEntries, upsertLedgerEntry } from "@/lib/ledger-db"
import { captureServerError } from "@/lib/debug-log-db"
import { buildTreasuryFinancingLedgerPosts, treasuryFinancingTxns } from "@/lib/treasury-financing"
import type {
  TreasuryAccount,
  TreasuryProfileKey,
  TreasuryStatus,
  TreasuryTransaction,
  TreasuryTxnType,
} from "@/lib/treasury-store"

// Annual debit cycle fee rate (kept in sync with lib/treasury-store.ts).
const DEBIT_CYCLE_FEE_RATE = 0.018

// Maximum leverage approved on a security deposit (1:10). Kept in sync with
// MAX_LEVERAGE_RATIO in lib/treasury-store.ts.
const MAX_LEVERAGE_RATIO = 10

// Leverage facilities the administrator may approve (1:5 or 1:10). Kept in sync
// with TREASURY_LEVERAGE_RATIOS in lib/treasury-store.ts.
const TREASURY_LEVERAGE_RATIOS = [5, 10]

// Snap a value to an approved facility level; legacy/observed ratios default to
// the historical 1:10 facility so financing capacity never regresses.
function normalizeLeverageRatio(ratio: number | undefined | null): number {
  const n = Number(ratio)
  return TREASURY_LEVERAGE_RATIOS.includes(n) ? n : MAX_LEVERAGE_RATIO
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

  try {
    const prev = await readAccount(userId)

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
        DEBIT_CYCLE_FEE_RATE,
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
      DEBIT_CYCLE_FEE_RATE,
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
