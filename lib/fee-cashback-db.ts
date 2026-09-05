import "server-only"
import { query } from "@/lib/db"
import {
  applyCashback,
  isCashbackProduct,
  normalizeCashbackRate,
  resolveCashbackRate,
  type CashbackProduct,
  type CashbackResult,
  type CashbackRule,
} from "@/lib/fee-cashback"

/**
 * Persistence + resolution for admin-controlled fee CASHBACK.
 *
 * A `fee_cashback_rules` table holds one row per (user, product) scope. Either
 * column may be NULL to act as a wildcard:
 *   • user_id NULL, product NULL  → global default for everyone/everything
 *   • user_id NULL, product P     → global rate for product P
 *   • user_id U,    product NULL  → this user, every product
 *   • user_id U,    product P     → this user, this product
 *
 * A deterministic primary key (`<user|global>:<product|all>`) means each scope
 * has exactly one row and upserts are idempotent.
 *
 * Reads NEVER throw — they degrade to a 0% cashback (customer simply pays the
 * standard fee) so fee charging can never break because of this table.
 */

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS fee_cashback_rules (
      id         text PRIMARY KEY,
      user_id    text,
      product    text,
      rate       numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    )
  `)
  ensured = true
}

function ruleId(userId: string | null, product: CashbackProduct | null): string {
  return `${userId ?? "global"}:${product ?? "all"}`
}

function rowToRule(row: Record<string, unknown>): CashbackRule {
  const product = row.product == null ? null : String(row.product)
  return {
    userId: row.user_id == null ? null : String(row.user_id),
    product: isCashbackProduct(product) ? product : null,
    rate: normalizeCashbackRate(row.rate),
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : undefined,
  }
}

/** Every configured cashback rule (for the admin editor). Never throws. */
export async function listCashbackRules(): Promise<CashbackRule[]> {
  try {
    await ensureTable()
    const { rows } = await query(
      `SELECT user_id, product, rate, updated_at FROM fee_cashback_rules ORDER BY user_id NULLS FIRST, product NULLS FIRST`,
    )
    return rows.map((r) => rowToRule(r as Record<string, unknown>))
  } catch {
    return []
  }
}

/**
 * Resolve the applicable cashback rate for one (userId, product), most-specific
 * wins. Queries only the up-to-four candidate rows. Returns 0 on any error.
 */
export async function getCashbackRateForOwner(
  userId: string | null | undefined,
  product: CashbackProduct,
): Promise<number> {
  try {
    await ensureTable()
    const uid = userId ?? null
    const ids = [ruleId(uid, product), ruleId(uid, null), ruleId(null, product), ruleId(null, null)]
    const { rows } = await query(`SELECT user_id, product, rate FROM fee_cashback_rules WHERE id = ANY($1)`, [ids])
    const rules = rows.map((r) => rowToRule(r as Record<string, unknown>))
    return resolveCashbackRate(rules, uid, product)
  } catch {
    return 0
  }
}

/**
 * Server helper: apply the resolved cashback to a standard fee for an owner.
 * Returns the full breakdown (original fee, rate, cashback amount, net fee).
 */
export async function applyCashbackForOwner(
  userId: string | null | undefined,
  product: CashbackProduct,
  standardFee: number,
): Promise<CashbackResult> {
  if (!(Number.isFinite(standardFee) && standardFee > 0)) {
    return applyCashback(standardFee, 0)
  }
  const rate = await getCashbackRateForOwner(userId, product)
  return applyCashback(standardFee, rate)
}

/** Resolve the cashback rate for every product for one user (client previews). */
export async function getResolvedCashbackForUser(
  userId: string | null | undefined,
): Promise<Record<CashbackProduct, number>> {
  const products: CashbackProduct[] = ["transaction", "instrument", "swift", "platform"]
  const out = {} as Record<CashbackProduct, number>
  await Promise.all(
    products.map(async (p) => {
      out[p] = await getCashbackRateForOwner(userId, p)
    }),
  )
  return out
}

/** Upsert a cashback rule. `rate` clamped to 0..1. Returns the stored rule. */
export async function saveCashbackRule(
  userId: string | null,
  product: CashbackProduct | null,
  rate: number,
  updatedBy?: string,
): Promise<CashbackRule> {
  const clean = normalizeCashbackRate(rate)
  await ensureTable()
  const id = ruleId(userId, product)
  await query(
    `INSERT INTO fee_cashback_rules (id, user_id, product, rate, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (id) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [id, userId, product, clean, updatedBy ?? null],
  )
  return { userId, product, rate: clean }
}

/** Delete a cashback rule (revert that scope to the next-most-specific / 0%). */
export async function deleteCashbackRule(userId: string | null, product: CashbackProduct | null): Promise<void> {
  await ensureTable()
  await query(`DELETE FROM fee_cashback_rules WHERE id = $1`, [ruleId(userId, product)])
}
