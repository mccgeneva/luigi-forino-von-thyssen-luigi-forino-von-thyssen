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
    const hit = list.find((r) => test(r.label.toLowerCase()))?.value?.trim()
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
 * Build the `banking` payload from a profile's banking rows. The per-currency
 * `accounts` array carries one entry per set of coordinates actually on file
 * (today that is the single stored set); it is empty when no IBAN exists.
 */
export function buildBankingPayload(rows: BankingRow[] | undefined): BankingPayload {
  const { iban, bic, bankName, accountNumber, currency } = extractBankingCoordinates(rows)
  const accounts: BankingAccountEntry[] = iban ? [{ currency, iban, bic, bankName }] : []
  return { iban, bic, bankName, accountNumber, currency, accounts }
}
