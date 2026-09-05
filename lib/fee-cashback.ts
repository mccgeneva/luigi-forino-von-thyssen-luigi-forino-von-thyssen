// Admin-controlled CASHBACK on platform fees.
//
// For every applicable fee the customer is charged the standard (tiered) fee
// MINUS an administrator-authorised cashback percentage:
//
//     net fee debited = standard fee − (standard fee × cashback rate)
//
// Cashback is a CONFIGURABLE RATE (never a hardcoded discount), resolved with a
// most-specific-wins precedence across three scopes:
//
//     (this user, this product)  >  (this user, all products)
//       >  (all users, this product)  >  (all users, all products)
//
// This module is PURE + framework-free so it can be imported by "use server"
// modules and client components alike. Persistence + resolution against the DB
// live in lib/fee-cashback-db.ts.

/** The fee streams cashback can apply to. */
export type CashbackProduct = "transaction" | "instrument" | "swift" | "platform"

export const CASHBACK_PRODUCTS: { id: CashbackProduct; label: string; description: string }[] = [
  {
    id: "transaction",
    label: "Transactions",
    description: "Incoming, outgoing and internal transfer fees (the tiered transaction fee).",
  },
  {
    id: "instrument",
    label: "Bank instruments",
    description: "Instrument management/settlement and transformation upgrade fees.",
  },
  {
    id: "swift",
    label: "SWIFT operations",
    description: "Inbound SWIFT credit fee and MT760 blocked-funds receipt fee.",
  },
  {
    id: "platform",
    label: "Other platform charges",
    description: "Cards, payment-gateway accounts, leverage and monetization fees.",
  },
]

const PRODUCT_IDS = new Set<string>(CASHBACK_PRODUCTS.map((p) => p.id))

export function isCashbackProduct(v: unknown): v is CashbackProduct {
  return typeof v === "string" && PRODUCT_IDS.has(v)
}

export function cashbackProductLabel(product: CashbackProduct | null | undefined): string {
  if (!product) return "All products"
  return CASHBACK_PRODUCTS.find((p) => p.id === product)?.label ?? product
}

/** A single stored cashback rule. `userId`/`product` null = wildcard (all). */
export interface CashbackRule {
  /** null = applies to every user. */
  userId: string | null
  /** null = applies to every product/fee type. */
  product: CashbackProduct | null
  /** Fraction 0..1 (e.g. 0.2 = 20% cashback). */
  rate: number
  updatedAt?: string
}

/** The resolved cashback for a fee: everything needed to display + audit it. */
export interface CashbackResult {
  /** The standard fee before cashback. */
  originalFee: number
  /** The authorised cashback fraction actually applied (0..1). */
  cashbackRate: number
  /** The cashback amount (originalFee × cashbackRate), rounded to 2dp. */
  cashbackAmount: number
  /** The amount actually debited (originalFee − cashbackAmount), never < 0. */
  netFee: number
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Clamp an incoming rate to a safe 0..1 fraction (0 when invalid). */
export function normalizeCashbackRate(rate: unknown): number {
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(1, n)
}

/**
 * Resolve the applicable cashback rate for a (userId, product) pair from a set
 * of rules, most-specific-wins. Returns 0 when nothing matches.
 */
export function resolveCashbackRate(
  rules: CashbackRule[],
  userId: string | null | undefined,
  product: CashbackProduct,
): number {
  const uid = userId ?? null
  const candidates: Array<{ userId: string | null; product: CashbackProduct | null; priority: number }> = [
    { userId: uid, product, priority: 4 },
    { userId: uid, product: null, priority: 3 },
    { userId: null, product, priority: 2 },
    { userId: null, product: null, priority: 1 },
  ]
  let best: { priority: number; rate: number } | null = null
  for (const rule of rules) {
    for (const c of candidates) {
      // A wildcard-user rule (rule.userId null) can only satisfy a wildcard-user
      // candidate; a specific-user rule must match the exact user.
      const userMatch = rule.userId === c.userId
      const productMatch = rule.product === c.product
      if (userMatch && productMatch) {
        if (!best || c.priority > best.priority) {
          best = { priority: c.priority, rate: normalizeCashbackRate(rule.rate) }
        }
      }
    }
  }
  return best ? best.rate : 0
}

/**
 * Apply a cashback rate to a computed fee. The net fee can never go below zero
 * (rate is clamped to 0..1). Returns the full breakdown for display + audit.
 */
export function applyCashback(fee: number, rate: number): CashbackResult {
  const originalFee = Number.isFinite(fee) && fee > 0 ? round2(fee) : 0
  const cashbackRate = normalizeCashbackRate(rate)
  const cashbackAmount = round2(originalFee * cashbackRate)
  const netFee = Math.max(0, round2(originalFee - cashbackAmount))
  return { originalFee, cashbackRate, cashbackAmount, netFee }
}

/** Human-readable percent for a fraction, e.g. 0.2 → "20%". */
export function formatCashbackPct(rate: number): string {
  return `${(normalizeCashbackRate(rate) * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
}

/** A short, auditable note describing the cashback applied to a fee. */
export function cashbackNote(cb: CashbackResult, currency: string): string {
  if (cb.cashbackRate <= 0 || cb.cashbackAmount <= 0) return ""
  return ` Cashback ${formatCashbackPct(cb.cashbackRate)} (−${currency} ${cb.cashbackAmount.toLocaleString("en-US")}) applied: standard fee ${currency} ${cb.originalFee.toLocaleString("en-US")} → net ${currency} ${cb.netFee.toLocaleString("en-US")}.`
}
