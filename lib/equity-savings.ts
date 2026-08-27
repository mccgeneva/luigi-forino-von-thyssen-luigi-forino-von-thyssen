import "server-only"
import { readLedgerEntries } from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"

/**
 * EQUITY SAVING — a segregated, fully-blocked collateral pot inside the
 * customer's own Master Account ledger.
 *
 * MODEL: each currency's blocked equity is a single aggregate `hold` DEBIT row
 * with a deterministic id `EQSAV-<CUR>`. A held debit is exactly what "blocked /
 * not spendable" means on this ledger — it is subtracted by
 * `availableByCurrency` (so every payment / leverage / solvency gate already
 * treats it as unavailable) while the SETTLED (completed-only) balance is
 * untouched, so the money is still owned, just committed as collateral. Moving
 * funds in/out is a free upsert (grow) / reduce-or-delete (release) of this row,
 * which instantly recomputes the customer's available balance.
 *
 * The blocked equity is fed into the Guarantees Accumulator as posted
 * collateral (raising coverage) and additionally earns a direct risk-score
 * credit, so committing equity measurably improves the trust score.
 */

export const EQUITY_ID_PREFIX = "EQSAV-"
export const EQUITY_CATEGORY = "Equity Saving"
export const EQUITY_COUNTERPARTY = "NAFTAhub Equity Saving"
const BASE = "EUR"

/** Deterministic per-currency ledger id for the aggregate equity hold. */
export function equityEntryId(currency: string): string {
  return `${EQUITY_ID_PREFIX}${(currency || BASE).toUpperCase()}`
}

/** True if a ledger entry id belongs to the equity-saving pot. */
export function isEquityEntryId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(EQUITY_ID_PREFIX)
}

/**
 * Current blocked equity per currency for an owner (positive amounts only).
 * Reads the authoritative ledger directly.
 */
export async function readEquityHoldings(ownerId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  try {
    const entries = await readLedgerEntries(ownerId)
    for (const e of entries) {
      if (!isEquityEntryId(e.id)) continue
      if (e.status !== "hold" || e.direction !== "debit") continue
      const cur = (e.currency || BASE).toUpperCase()
      const amt = Number(e.amount)
      if (Number.isFinite(amt) && amt > 0) out[cur] = (out[cur] ?? 0) + amt
    }
  } catch {
    /* degrade to no holdings on any read failure */
  }
  return out
}

/** EUR-equivalent total of all blocked equity for an owner. */
export async function readEquitySavingsEur(ownerId: string): Promise<number> {
  const holdings = await readEquityHoldings(ownerId)
  let total = 0
  for (const [cur, amt] of Object.entries(holdings)) {
    if (cur === BASE) {
      total += amt
    } else {
      try {
        total += convertCurrency(amt, cur, BASE)
      } catch {
        total += amt
      }
    }
  }
  return total
}
