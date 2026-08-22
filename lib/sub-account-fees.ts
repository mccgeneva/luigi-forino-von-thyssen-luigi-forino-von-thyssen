import type { LedgerEntry } from "@/lib/ledger-store"
import type { SubAccount } from "@/lib/sub-account-types"

// Sub-account tariffs, denominated in EUR and always reflected on the client's
// MASTER account (the fees reduce the master/main balance, never a compartment).
// Kept in this plain, dependency-free module so BOTH the client UI (to show the
// tariffs) and the server (to charge them) can import it.
//
//  - Service fee (one-time, at administrator activation): €800 for an ALIAS
//    sub-account, €1,500 for a fully DECLARED UBO.
//  - Annual fee: €1,000, billed in advance from the activation date and every
//    anniversary thereafter while the sub-account is active.
//  - Closing fee: €350, charged when an administrator closes the sub-account.

export const SUB_ACCOUNT_FEE_CURRENCY = "EUR"

export const SUB_ACCOUNT_SERVICE_FEE = {
  alias: 800,
  declared: 1500,
} as const

export const SUB_ACCOUNT_ANNUAL_FEE = 1000
export const SUB_ACCOUNT_CLOSING_FEE = 350

/** The one-time service fee (EUR) for a sub-account, by UBO verification mode. */
export function serviceFeeFor(verification: SubAccount["verification"]): number {
  return verification === "declared" ? SUB_ACCOUNT_SERVICE_FEE.declared : SUB_ACCOUNT_SERVICE_FEE.alias
}

/** Format an EUR amount as `€1,500.00`. */
export function formatSubAccountFee(amount: number): string {
  return `€${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}

function feeEntry(
  id: string,
  amount: number,
  category: string,
  when: Date,
  sub: SubAccount,
  suffix?: string,
): LedgerEntry {
  return {
    id,
    direction: "debit",
    amount,
    currency: SUB_ACCOUNT_FEE_CURRENCY,
    status: "completed",
    date: when.toISOString(),
    counterparty: "NAFTAhub",
    category,
    reference: sub.id,
    comment: `${category} — sub-account "${sub.label}"${suffix ? ` (${suffix})` : ""}`,
    // Intentionally NOT tagged with subAccountId: these charges hit the MASTER
    // (main) balance, so the tariff is reflected on the Master Account.
  }
}

/**
 * Deterministic, idempotent ledger posts for every tariff a sub-account has
 * accrued up to `nowIso`. Same-id posts across calls are stable, so the admin
 * route (immediate charge on authorization) and the ledger-read reconciler
 * (recurring annual accrual) can both call this without ever double-charging.
 *
 * Pending/rejected requests incur nothing — fees begin only once activated.
 */
export function buildSubAccountFeeEntries(sub: SubAccount, nowIso: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  if (sub.status !== "active" && sub.status !== "closed") return out
  if (!sub.activatedAt) return out

  const activation = new Date(sub.activatedAt)
  const now = new Date(nowIso)
  const closed = sub.status === "closed" && sub.closedAt ? new Date(sub.closedAt) : null

  // One-time service fee (by alias vs declared) — dated at activation.
  out.push(feeEntry(`SUBA-SVC-${sub.id}`, serviceFeeFor(sub.verification), "Sub-Account Service Fee", activation, sub))

  // Annual fee, billed in advance from activation and each anniversary, capped
  // at "now" and at the close date (no annual fee accrues after closure).
  const annualCeiling = Math.min(now.getTime(), closed ? closed.getTime() : now.getTime())
  for (let n = 1; n <= 100; n++) {
    const due = addYears(activation, n - 1)
    if (due.getTime() > annualCeiling + 1000) break
    out.push(
      feeEntry(`SUBA-ANNUAL-${sub.id}-Y${n}`, SUB_ACCOUNT_ANNUAL_FEE, "Sub-Account Annual Fee", due, sub, `Year ${n}`),
    )
  }

  // Closing fee — dated at closure.
  if (closed) {
    out.push(feeEntry(`SUBA-CLOSE-${sub.id}`, SUB_ACCOUNT_CLOSING_FEE, "Sub-Account Closing Fee", closed, sub))
  }

  return out
}
