/**
 * The additional per-currency settlement accounts an administrator can insert
 * on a master account. EUR is the primary master account (edited via the
 * top-level IBAN / SWIFT / bank-name coordinates); every currency listed here
 * can carry its own dedicated settlement-account coordinates that reflect into
 * the client's accounts overview.
 *
 * This is a plain (non server-only, non client-only) module so it can be shared
 * by both the "use server" admin actions and the admin client UI. A "use
 * server" file may only export async functions, and `lib/banking-coordinates`
 * is `server-only`, so neither can hold a value the client also needs.
 */
export const MANAGED_BANK_CURRENCIES = ["USD", "GBP", "CHF"] as const
