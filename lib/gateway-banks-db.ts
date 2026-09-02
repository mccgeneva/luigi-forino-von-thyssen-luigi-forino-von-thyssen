import "server-only"

import { query } from "@/lib/db"
import {
  PARTNER_BANKS,
  BANK_REGIONS,
  type PartnerBank,
  type BankRegion,
} from "@/lib/partner-banks"

// ---------------------------------------------------------------------------
// Database-backed partner-bank directory.
//
// The 260 curated banks in lib/partner-banks.ts are the COMPILED baseline. This
// table stores banks an administrator adds at runtime, so new correspondent
// banks appear WITHOUT a code change or redeploy. Every read merges the code
// baseline with these custom rows (custom overrides/extends by key), and always
// falls back to the code baseline if the table is briefly unavailable — so the
// directory can never regress below the 260.
//
// IMPORTANT: a bank's BIC is the real routing anchor. A custom bank must carry a
// genuine 8/11-char BIC whose characters 5-6 are its ISO country code, or the
// IBAN/BIC it generates will look valid but route nowhere. Adding a bank in a
// brand-new country that has no IBAN structure in lib/iban.ts settles on
// domestic coordinates (no IBAN) — that remains a code-level addition.
// ---------------------------------------------------------------------------

export type CustomBankInput = {
  // Optional: derived from `name` when omitted (see upsertCustomBank).
  key?: string
  name: string
  country: string
  countryCode: string
  bic: string
  currencies: string[]
  region: BankRegion
  nationalBankCode?: string
}

const BIC_RE = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_custom_banks (
       bank_key           text        PRIMARY KEY,
       name               text        NOT NULL,
       country            text        NOT NULL,
       country_code       text        NOT NULL,
       bic                text        NOT NULL,
       currencies         text[]      NOT NULL,
       region             text        NOT NULL,
       national_bank_code text,
       created_at         timestamptz NOT NULL DEFAULT now()
     )`,
  )
  ensured = true
}

function rowToBank(row: Record<string, unknown>): PartnerBank {
  return {
    key: row.bank_key as string,
    name: row.name as string,
    country: row.country as string,
    countryCode: row.country_code as string,
    bic: row.bic as string,
    currencies: (row.currencies as string[]) ?? [],
    region: row.region as BankRegion,
    nationalBankCode: (row.national_bank_code as string | null) ?? undefined,
  }
}

/** Every admin-added bank. Empty (not throwing) if the table is unavailable. */
export async function listCustomBanks(): Promise<PartnerBank[]> {
  try {
    await ensureTable()
    const { rows } = await query(`SELECT * FROM gateway_custom_banks ORDER BY name`)
    return rows.map(rowToBank)
  } catch (err) {
    console.log("[v0] listCustomBanks failed:", (err as Error).message)
    return []
  }
}

/**
 * The full live directory: the compiled 260 overlaid with admin-added/edited
 * rows (custom wins by key). Always returns at least the code baseline.
 */
export async function mergedPartnerBanks(): Promise<PartnerBank[]> {
  const custom = await listCustomBanks()
  if (custom.length === 0) return PARTNER_BANKS
  const byKey = new Map<string, PartnerBank>()
  for (const b of PARTNER_BANKS) byKey.set(b.key, b)
  for (const b of custom) byKey.set(b.key, b) // custom overrides/extends
  return Array.from(byKey.values())
}

/** Resolve a single bank by key across the merged directory. */
export async function resolvePartnerBank(bankKey: string): Promise<PartnerBank | undefined> {
  const custom = await listCustomBanks()
  return (
    custom.find((b) => b.key === bankKey) ??
    PARTNER_BANKS.find((b) => b.key === bankKey)
  )
}

/** Banks (merged) that can issue an account in the given currency. */
export async function mergedBanksForCurrency(currency: string): Promise<PartnerBank[]> {
  const all = await mergedPartnerBanks()
  return all.filter((b) => b.currencies.includes(currency))
}

export type SaveBankResult = { ok: true; bank: PartnerBank } | { ok: false; error: string }

/** Validate + upsert a custom bank. Returns a friendly error on bad input. */
export async function upsertCustomBank(input: CustomBankInput): Promise<SaveBankResult> {
  const key = (input.key || input.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40)
  const name = input.name?.trim()
  const country = input.country?.trim()
  const countryCode = input.countryCode?.trim().toUpperCase()
  const bic = input.bic?.trim().toUpperCase()
  const currencies = Array.from(
    new Set((input.currencies ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean)),
  )
  const region = input.region
  const nationalBankCode = input.nationalBankCode?.trim() || undefined

  if (!key) return { ok: false, error: "A bank key or name is required." }
  if (!name) return { ok: false, error: "Bank name is required." }
  if (!country) return { ok: false, error: "Country is required." }
  if (!/^[A-Z]{2}$/.test(countryCode || "")) {
    return { ok: false, error: "Country code must be the 2-letter ISO code (e.g. GB, US, AE)." }
  }
  if (!BIC_RE.test(bic || "")) {
    return { ok: false, error: "BIC/SWIFT must be 8 or 11 uppercase letters/digits." }
  }
  if (bic!.slice(4, 6) !== countryCode) {
    return {
      ok: false,
      error: `The BIC's country (characters 5-6 = "${bic!.slice(4, 6)}") must match the ISO country code "${countryCode}". A mismatched BIC will not route.`,
    }
  }
  if (currencies.length === 0) {
    return { ok: false, error: "Add at least one currency the bank can issue an account in." }
  }
  if (!BANK_REGIONS.includes(region)) {
    return { ok: false, error: "Select a valid region." }
  }
  // A code-baseline bank cannot be shadowed by accident with a different identity
  // unless the admin is deliberately editing that exact key.
  const codeBank = PARTNER_BANKS.find((b) => b.key === key)
  if (codeBank && codeBank.countryCode !== countryCode) {
    return {
      ok: false,
      error: `"${key}" is already a built-in bank in ${codeBank.country}. Choose a different key.`,
    }
  }

  try {
    await ensureTable()
    const { rows } = await query(
      `INSERT INTO gateway_custom_banks
         (bank_key, name, country, country_code, bic, currencies, region, national_bank_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (bank_key) DO UPDATE SET
         name = EXCLUDED.name,
         country = EXCLUDED.country,
         country_code = EXCLUDED.country_code,
         bic = EXCLUDED.bic,
         currencies = EXCLUDED.currencies,
         region = EXCLUDED.region,
         national_bank_code = EXCLUDED.national_bank_code
       RETURNING *`,
      [key, name, country, countryCode, bic, currencies, region, nationalBankCode ?? null],
    )
    return { ok: true, bank: rowToBank(rows[0]) }
  } catch (err) {
    console.log("[v0] upsertCustomBank failed:", (err as Error).message)
    return { ok: false, error: "The bank could not be saved. Please try again." }
  }
}

/** Remove a custom bank (built-in code banks cannot be deleted this way). */
export async function deleteCustomBank(bankKey: string): Promise<{ ok: boolean; error?: string }> {
  if (PARTNER_BANKS.some((b) => b.key === bankKey)) {
    return { ok: false, error: "Built-in banks cannot be removed." }
  }
  try {
    await ensureTable()
    await query(`DELETE FROM gateway_custom_banks WHERE bank_key = $1`, [bankKey])
    return { ok: true }
  } catch (err) {
    console.log("[v0] deleteCustomBank failed:", (err as Error).message)
    return { ok: false, error: "The bank could not be removed. Please try again." }
  }
}
