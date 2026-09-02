// ---------------------------------------------------------------------------
// Gateway catalogue (server-safe)
//
// The canonical list of gateway account types and supported currencies. This
// module deliberately has NO "use client" directive so it can be imported by
// server actions (e.g. the admin config that enables/disables them globally)
// as well as by client components. The client store re-exports these so
// existing `@/lib/gateway-store` imports keep working unchanged.
// ---------------------------------------------------------------------------

export type GatewayAccountType = "collection" | "multicurrency" | "virtual_iban"

export const ACCOUNT_TYPES: Record<
  GatewayAccountType,
  { label: string; blurb: string }
> = {
  virtual_iban: {
    label: "Virtual IBAN",
    blurb: "A dedicated IBAN in the client's name for receiving funds, routed through a partner bank.",
  },
  collection: {
    label: "Collection Account",
    blurb: "A named collection account to aggregate incoming payments before sweeping to the Master Account.",
  },
  multicurrency: {
    label: "Multi-Currency Account",
    blurb: "A single account able to hold and receive multiple currencies via the partner network.",
  },
}

/** Canonical ordered list of account-type keys. */
export const ACCOUNT_TYPE_KEYS = Object.keys(ACCOUNT_TYPES) as GatewayAccountType[]

export const GATEWAY_CURRENCIES = [
  "EUR", "USD", "GBP", "CHF", "SGD", "CAD", "HKD", "JPY", "CNY", "AUD", "NZD",
  "AED", "SAR", "QAR", "INR", "ZAR", "BRL", "MXN", "SEK", "NOK", "DKK", "KRW", "MYR",
]

/** True when the given string is a known account-type key. */
export function isAccountTypeKey(key: string): key is GatewayAccountType {
  return key in ACCOUNT_TYPES
}

/** True when the given string is a known gateway currency. */
export function isGatewayCurrency(code: string): boolean {
  return GATEWAY_CURRENCIES.includes(code)
}

/**
 * One-time ("una tantum") fee charged to the client's Master Account each time
 * they add a bank account through the Payment Gateway. Denominated in EUR. Kept
 * in this server-safe module so both the client page and the server action can
 * import it (a "use server" file may only export async functions).
 */
export const GATEWAY_ACCOUNT_FEE = 500
export const GATEWAY_FEE_CURRENCY = "EUR"

/**
 * One-time termination cost charged to the client's Master Account when they
 * close / delete a gateway bank account. Denominated in EUR. Charged on ANY
 * close (including a still-pending request). Any funds already received into
 * the account were swept to the Master Account, so closing never loses money —
 * it only removes the account and books this administrative closing fee.
 */
export const GATEWAY_TERMINATION_FEE = 100
