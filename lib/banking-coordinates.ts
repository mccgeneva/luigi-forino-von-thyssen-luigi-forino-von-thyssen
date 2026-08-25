import "server-only"

/**
 * Bank-account coordinate helpers shared with NQAi.cloud through the account
 * APIs (`/accounts/master`, `/api/v1/customer`).
 *
 * Coordinates are stored per user as free-form label/value rows in
 * `profile.banking` (edited by the administrator in the Master Account
 * manager). These helpers turn those rows into the stable, documented JSON
 * shape NQAi.cloud consumes:
 *
 *   banking: {
 *     iban, bic, bankName, accountNumber, currency,
 *     accounts: [{ currency, iban, bic, bankName }, ...]
 *   }
 *
 * Matching is label-keyword based and tolerant of the various labels used
 * across the platform (mirrors admin `extractBankingCoordinates`). Nothing is
 * fabricated: a field the profile does not carry is returned as null, and the
 * per-currency `accounts` array is derived only from coordinates that are
 * actually on file.
 */

/** A single label/value banking row — satisfied by both the live `ProfileItem`
 *  and the stored `SerializableProfileItem`. */
export interface BankingRow {
  label: string
  value: string
}

/** One settlement account in the per-currency `accounts` array. */
export interface BankingAccountEntry {
  currency: string | null
  iban: string | null
  bic: string | null
  bankName: string | null
}

/** The `banking` object exposed on the account/customer API responses. */
export interface BankingPayload {
  iban: string | null
  bic: string | null
  bankName: string | null
  accountNumber: string | null
  currency: string | null
  accounts: BankingAccountEntry[]
}

/** ISO currency codes that may prefix a PER-CURRENCY banking label, e.g.
 *  "USD IBAN". The primary (master / EUR) account is stored under UN-prefixed
 *  labels ("IBAN", "SWIFT / BIC", "Bank"), so the primary extractor must skip
 *  any currency-prefixed row — otherwise a "USD IBAN" could shadow the master
 *  IBAN when it happens to appear first in the free-form rows. */
export const CURRENCY_LABEL_PREFIX_RE = /^(usd|gbp|chf|eur|jpy|aud|cad|sgd|hkd|aed)\s+/i

function isCurrencyPrefixedLabel(label: string): boolean {
  return CURRENCY_LABEL_PREFIX_RE.test(label.trim())
}

/** Pull the primary banking coordinates out of a profile's free-form rows. */
export function extractBankingCoordinates(rows: BankingRow[] | undefined): {
  iban: string | null
  bic: string | null
  bankName: string | null
  accountNumber: string | null
  currency: string | null
} {
  const list = rows ?? []
  const find = (test: (label: string) => boolean): string | null => {
    const hit = list
      .find((r) => !isCurrencyPrefixedLabel(r.label) && test(r.label.toLowerCase()))
      ?.value?.trim()
    return hit ? hit : null
  }
  const iban = find((l) => l.includes("iban"))
  const bic = find((l) => l.includes("swift") || l.includes("bic"))
  const currency = find((l) => l.includes("currency"))
  // "Account number" / "Account no." / "Acct #" — but never "account currency".
  const accountNumber = find((l) => /account\s*(number|no\.?|#)/.test(l) || l.includes("kontonummer"))
  // "Bank name" / "Bank" but never the IBAN/SWIFT/BIC or "Bank Address" rows.
  const bankName = find(
    (l) =>
      l.includes("bank") &&
      !l.includes("iban") &&
      !l.includes("swift") &&
      !l.includes("bic") &&
      !l.includes("address"),
  )
  return { iban, bic, bankName, accountNumber, currency }
}

/**
 * Coordinates for a SPECIFIC currency's settlement account. EUR is the primary
 * master account (stored under un-prefixed labels); every other currency is
 * stored under "<CCY> …" labels (e.g. "USD IBAN", "USD SWIFT / BIC", "USD
 * Bank"). Returns nulls when that currency has nothing on file.
 */
export function extractCurrencyBankingCoordinates(
  rows: BankingRow[] | undefined,
  currency: string,
): { iban: string | null; bic: string | null; bankName: string | null } {
  const cur = currency.trim().toUpperCase()
  if (!cur) return { iban: null, bic: null, bankName: null }
  // EUR = the primary master account under un-prefixed labels.
  if (cur === "EUR") {
    const c = extractBankingCoordinates(rows)
    return { iban: c.iban, bic: c.bic, bankName: c.bankName }
  }
  const prefix = new RegExp(`^${cur}\\s+`, "i")
  const scoped = (rows ?? [])
    .filter((r) => prefix.test(r.label.trim()))
    .map((r) => ({ label: r.label.trim().replace(prefix, "").toLowerCase(), value: r.value }))
  const find = (test: (label: string) => boolean): string | null => {
    const hit = scoped.find((r) => test(r.label))?.value?.trim()
    return hit ? hit : null
  }
  const iban = find((l) => l.includes("iban"))
  const bic = find((l) => l.includes("swift") || l.includes("bic"))
  const bankName = find(
    (l) =>
      l.includes("bank") &&
      !l.includes("iban") &&
      !l.includes("swift") &&
      !l.includes("bic") &&
      !l.includes("address"),
  )
  return { iban, bic, bankName }
}

/** Every non-EUR currency that has at least one "<CCY> …" banking row on file. */
export function currenciesWithBankingRows(rows: BankingRow[] | undefined): string[] {
  const out = new Set<string>()
  for (const r of rows ?? []) {
    const m = r.label.trim().match(CURRENCY_LABEL_PREFIX_RE)
    if (m) {
      const cur = m[1].toUpperCase()
      if (cur !== "EUR") out.add(cur)
    }
  }
  return [...out]
}

/**
 * Build the `banking` payload from a profile's banking rows. The per-currency
 * `accounts` array carries the primary (EUR / master) account plus one entry
 * per additional currency that has coordinates on file; it is empty when no
 * IBAN exists at all.
 */
export function buildBankingPayload(rows: BankingRow[] | undefined): BankingPayload {
  const { iban, bic, bankName, accountNumber, currency } = extractBankingCoordinates(rows)
  const accounts: BankingAccountEntry[] = []
  if (iban) accounts.push({ currency: currency ?? "EUR", iban, bic, bankName })
  for (const cur of currenciesWithBankingRows(rows)) {
    const c = extractCurrencyBankingCoordinates(rows, cur)
    if (c.iban || c.bic || c.bankName) {
      accounts.push({ currency: cur, iban: c.iban, bic: c.bic, bankName: c.bankName })
    }
  }
  return { iban, bic, bankName, accountNumber, currency, accounts }
}
