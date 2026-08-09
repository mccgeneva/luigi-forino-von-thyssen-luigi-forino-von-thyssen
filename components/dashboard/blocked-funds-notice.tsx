"use client"

import { Lock } from "lucide-react"
import { useLedger, type LedgerEntry } from "@/lib/ledger-store"

/** Administrative holds are posted with this deterministic id prefix. */
const ADMIN_BLOCK_PREFIX = "ADMIN-BLOCK-"

const currencySymbols: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF ",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
}

function formatMoney(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || `${currency} `
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Prominent, client-facing notice shown under the account balances whenever an
 * administrator has manually blocked (reserved) funds on the Master Account.
 * Renders nothing when there are no administrative holds. Each block lists the
 * amount and the reason the administrator entered, so the client always knows
 * why part of their balance is unavailable.
 */
export function BlockedFundsNotice() {
  const { entries } = useLedger()

  const blocks: LedgerEntry[] = entries
    .filter((e) => e.id.startsWith(ADMIN_BLOCK_PREFIX) && e.status === "hold" && e.direction === "debit")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  if (blocks.length === 0) return null

  return (
    <div
      role="status"
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20">
          <Lock className="h-4 w-4 text-amber-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-500">
            {blocks.length === 1 ? "Funds blocked on your account" : `${blocks.length} fund blocks on your account`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
            The amounts below have been blocked by MCC Capital and are temporarily unavailable to
            spend. They remain in your account until released.
          </p>

          <ul className="mt-3 space-y-2">
            {blocks.map((b) => (
              <li
                key={b.id}
                className="rounded-md border border-amber-500/30 bg-background/60 p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-bold text-amber-700 dark:text-amber-500">
                    {formatMoney(b.amount, b.currency)}
                  </span>
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-600/80">
                    Blocked
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground text-pretty">
                  <span className="font-medium text-muted-foreground">Reason: </span>
                  {b.comment?.trim() || "No reason provided."}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
