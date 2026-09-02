"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveCurrentSession } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { type PartnerBank } from "@/lib/partner-banks"
import { mergedPartnerBanks, mergedBanksForCurrency, resolvePartnerBank } from "@/lib/gateway-banks-db"

// ---------------------------------------------------------------------------
// Partner-bank account inventory.
//
// Each partner bank holds a finite pool of issuable accounts per currency. A
// client may only request — and an administrator may only approve — an account
// at a bank that (a) supports the currency, (b) is enabled by an administrator,
// and (c) still has spare capacity in that currency's pool. Approving an
// account allocates one slot; when a pool is exhausted, issuance is blocked.
//
// Rows are created lazily: a bank+currency with no row is treated as ENABLED
// with the default capacity below. Administrators materialise a row the moment
// they change availability or capacity, and allocation always upserts a row so
// the live count is authoritative.
// ---------------------------------------------------------------------------

/** Default issuable-account capacity for a bank+currency with no explicit row. */
const DEFAULT_BANK_CAPACITY = 25

export interface BankInventoryRow {
  bankKey: string
  currency: string
  enabled: boolean
  capacity: number
  allocated: number
}

/** A bank's availability for a specific currency, resolved for the client UI. */
export interface BankAvailability {
  bankKey: string
  currency: string
  enabled: boolean
  capacity: number
  allocated: number
  remaining: number
  available: boolean // enabled AND remaining > 0
  // Bank identity is carried alongside availability so the client can render
  // database-added banks without importing the compiled directory.
  bankName?: string
  country?: string
  countryCode?: string
  bic?: string
  region?: string
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

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_bank_inventory (
       bank_key   text        NOT NULL,
       currency   text        NOT NULL,
       enabled    boolean     NOT NULL DEFAULT true,
       capacity   integer     NOT NULL DEFAULT ${DEFAULT_BANK_CAPACITY},
       allocated  integer     NOT NULL DEFAULT 0,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (bank_key, currency)
     )`,
  )
  ensured = true
}

function rowToInventory(row: Record<string, unknown>): BankInventoryRow {
  return {
    bankKey: row.bank_key as string,
    currency: row.currency as string,
    enabled: row.enabled as boolean,
    capacity: Number(row.capacity),
    allocated: Number(row.allocated),
  }
}

/** Read every explicit inventory row (admin panel). Sparse by design. */
async function readInventory(): Promise<Map<string, BankInventoryRow>> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM gateway_bank_inventory`)
  const map = new Map<string, BankInventoryRow>()
  for (const r of rows) {
    const row = rowToInventory(r)
    map.set(`${row.bankKey}::${row.currency}`, row)
  }
  return map
}

/** Resolve a bank+currency to availability, applying lazy defaults. */
function resolveAvailability(
  bank: PartnerBank,
  currency: string,
  explicit: Map<string, BankInventoryRow>,
): BankAvailability {
  const row = explicit.get(`${bank.key}::${currency}`)
  const enabled = row ? row.enabled : true
  const capacity = row ? row.capacity : DEFAULT_BANK_CAPACITY
  const allocated = row ? row.allocated : 0
  const remaining = Math.max(0, capacity - allocated)
  return {
    bankKey: bank.key,
    currency,
    enabled,
    capacity,
    allocated,
    remaining,
    available: enabled && remaining > 0,
    bankName: bank.name,
    country: bank.country,
    countryCode: bank.countryCode,
    bic: bank.bic,
    region: bank.region,
  }
}

// ---------------------------------------------------------------------------
// Client-callable reads (no passcode — non-sensitive availability only).
// ---------------------------------------------------------------------------

/**
 * Availability of every partner bank that supports the currency. Used by the
 * client request form so customers only ever see banks they can actually be
 * issued an account at right now.
 */
export async function getBankAvailabilityForCurrency(
  currency: string,
): Promise<BankAvailability[]> {
  try {
    const [explicit, banks] = await Promise.all([readInventory(), mergedBanksForCurrency(currency)])
    return banks.map((b) => resolveAvailability(b, currency, explicit))
  } catch (err) {
    console.log("[v0] getBankAvailabilityForCurrency failed:", (err as Error).message)
    // Fail open to directory-level support so the form still works if the
    // inventory table is briefly unavailable; allocation remains the gate.
    const banks = await mergedBanksForCurrency(currency).catch(() => [])
    return banks.map((b) => ({
      bankKey: b.key,
      currency,
      enabled: true,
      capacity: DEFAULT_BANK_CAPACITY,
      allocated: 0,
      remaining: DEFAULT_BANK_CAPACITY,
      available: true,
      bankName: b.name,
      country: b.country,
      countryCode: b.countryCode,
      bic: b.bic,
      region: b.region,
    }))
  }
}

// ---------------------------------------------------------------------------
// Admin reads & configuration (passcode verified server-side).
// ---------------------------------------------------------------------------

export type BankInventoryResult =
  | { ok: true; inventory: BankAvailability[] }
  | { ok: false; error: string }

/**
 * Full inventory matrix for the admin panel: every (bank, supported currency)
 * pair with its resolved availability, including lazily-defaulted rows.
 */
export async function getBankInventoryAdmin(passcode: string): Promise<BankInventoryResult> {
  try {
    await requireAdmin(passcode)
    const [explicit, banks] = await Promise.all([readInventory(), mergedPartnerBanks()])
    const inventory: BankAvailability[] = []
    for (const bank of banks) {
      for (const currency of bank.currencies) {
        inventory.push(resolveAvailability(bank, currency, explicit))
      }
    }
    return { ok: true, inventory }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Admin: set enabled flag and/or capacity for a single bank+currency pool. */
export async function setBankAvailabilityAdmin(
  passcode: string,
  bankKey: string,
  currency: string,
  patch: { enabled?: boolean; capacity?: number },
): Promise<BankInventoryResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const bank = await resolvePartnerBank(bankKey)
  if (!bank) return { ok: false, error: "Unknown partner bank." }
  if (!bank.currencies.includes(currency)) {
    return { ok: false, error: `${bank.name} does not support ${currency}.` }
  }
  if (patch.capacity !== undefined && (!Number.isFinite(patch.capacity) || patch.capacity < 0)) {
    return { ok: false, error: "Capacity must be zero or a positive whole number." }
  }

  try {
    await ensureTable()
    // Read the current (possibly defaulted) state so we can preserve fields the
    // caller didn't change and validate capacity against what's allocated.
    const { rows: existingRows } = await query(
      `SELECT * FROM gateway_bank_inventory WHERE bank_key = $1 AND currency = $2`,
      [bankKey, currency],
    )
    const existing = existingRows[0] ? rowToInventory(existingRows[0]) : undefined
    const enabled = patch.enabled ?? existing?.enabled ?? true
    const allocated = existing?.allocated ?? 0
    const capacity = Math.round(patch.capacity ?? existing?.capacity ?? DEFAULT_BANK_CAPACITY)

    if (capacity < allocated) {
      return {
        ok: false,
        error: `Capacity cannot be set below the ${allocated} account${allocated === 1 ? "" : "s"} already issued in ${currency}.`,
      }
    }

    await query(
      `INSERT INTO gateway_bank_inventory (bank_key, currency, enabled, capacity, allocated, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (bank_key, currency) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         capacity = EXCLUDED.capacity,
         updated_at = now()`,
      [bankKey, currency, enabled, capacity, allocated],
    )

    await logActivity({
      action: `Administrator updated ${bank.name} ${currency} account pool`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator set ${bank.name}'s ${currency} issuing pool to ${enabled ? "enabled" : "disabled"} with a capacity of ${capacity} account${capacity === 1 ? "" : "s"} (${allocated} already issued, ${Math.max(0, capacity - allocated)} remaining).`,
        partnerBank: bank.name,
        currency,
        enabled: enabled ? "Enabled" : "Disabled",
        capacity,
        allocated,
        remaining: Math.max(0, capacity - allocated),
      },
    })

    const refreshed = await getBankInventoryAdmin(passcode)
    return refreshed
  } catch (err) {
    console.log("[v0] setBankAvailabilityAdmin failed:", (err as Error).message)
    return { ok: false, error: "The pool could not be updated. Please try again." }
  }
}

export type AllocationResult =
  | { ok: true; remaining: number; capacity: number }
  | { ok: false; error: string }

/**
 * Atomically reserve one account slot from a bank's currency pool. Returns an
 * error (without mutating anything) when the bank is disabled for the currency
 * or the pool is exhausted. Called server-side at approval time.
 */
export async function allocateBankSlotAdmin(
  passcode: string,
  bankKey: string,
  currency: string,
): Promise<AllocationResult> {
  try {
    await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const bank = await resolvePartnerBank(bankKey)
  if (!bank) return { ok: false, error: "Unknown partner bank." }
  if (!bank.currencies.includes(currency)) {
    return { ok: false, error: `${bank.name} cannot issue a ${currency} account.` }
  }

  try {
    await ensureTable()
    // Single round-trip atomic reservation. The INSERT path covers banks with no
    // explicit row yet (allocated starts at 1); the UPDATE path only fires when
    // the pool is enabled and has spare capacity, so an exhausted/disabled pool
    // yields zero rows and no mutation.
    const { rows } = await query(
      `INSERT INTO gateway_bank_inventory (bank_key, currency, enabled, capacity, allocated, updated_at)
       VALUES ($1, $2, true, ${DEFAULT_BANK_CAPACITY}, 1, now())
       ON CONFLICT (bank_key, currency) DO UPDATE SET
         allocated = gateway_bank_inventory.allocated + 1,
         updated_at = now()
       WHERE gateway_bank_inventory.enabled = true
         AND gateway_bank_inventory.allocated < gateway_bank_inventory.capacity
       RETURNING allocated, capacity`,
      [bankKey, currency],
    )

    if (!rows[0]) {
      return {
        ok: false,
        error: `${bank.name} has no remaining ${currency} account capacity. Choose another partner bank or increase its pool.`,
      }
    }

    const allocated = Number(rows[0].allocated)
    const capacity = Number(rows[0].capacity)
    return { ok: true, remaining: Math.max(0, capacity - allocated), capacity }
  } catch (err) {
    console.log("[v0] allocateBankSlotAdmin failed:", (err as Error).message)
    return { ok: false, error: "The account pool could not be reserved. Please try again." }
  }
}

/**
 * Release one previously-allocated slot back into a bank's currency pool — used
 * when an issued account is later closed. Never drops below zero.
 */
export async function releaseBankSlotAdmin(
  passcode: string,
  bankKey: string,
  currency: string,
): Promise<{ ok: boolean }> {
  try {
    await requireAdmin(passcode)
    await ensureTable()
    await query(
      `UPDATE gateway_bank_inventory
         SET allocated = GREATEST(0, allocated - 1), updated_at = now()
       WHERE bank_key = $1 AND currency = $2`,
      [bankKey, currency],
    )
    return { ok: true }
  } catch (err) {
    console.log("[v0] releaseBankSlotAdmin failed:", (err as Error).message)
    return { ok: false }
  }
}
