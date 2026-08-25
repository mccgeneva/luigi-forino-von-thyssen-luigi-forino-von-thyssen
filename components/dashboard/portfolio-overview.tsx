"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowUpRight, ArrowDownRight, TrendingUp, Wallet, Building2, FileText, ChevronRight, Lock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useLedger, convertCurrency, type LedgerEntry } from "@/lib/ledger-store"
import { useInstrumentRequests } from "@/lib/instrument-requests-store"
import { useBeneficiaries } from "@/lib/beneficiaries-store"
import { BlockedFundsNotice } from "@/components/dashboard/blocked-funds-notice"

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

const currencyNames: Record<string, string> = {
  EUR: "Euro",
  USD: "US Dollar",
  GBP: "British Pound",
  CHF: "Swiss Franc",
  JPY: "Japanese Yen",
  AUD: "Australian Dollar",
  CAD: "Canadian Dollar",
  SGD: "Singapore Dollar",
}

function formatMoney(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || `${currency} `
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatEur(amount: number): string {
  return formatMoney(amount, "EUR")
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}

export function PortfolioOverview() {
  const { balanceFor, reservedFor, entries, currencies } = useLedger()
  const { instruments } = useInstrumentRequests()
  const { beneficiaries } = useBeneficiaries()

  // Which currency's reserved-funds breakdown is open (null = dialog closed).
  const [reservedCurrency, setReservedCurrency] = useState<string | null>(null)

  // The individual held debits that make up the reserved total for the open
  // currency. Each one carries the counterparty / category / reference that
  // explains WHY the funds are locked (e.g. a commodity settlement on hold).
  const reservedEntries: LedgerEntry[] = reservedCurrency
    ? entries
        .filter(
          (e) => e.currency === reservedCurrency && e.status === "hold" && e.direction === "debit",
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    : []
  const reservedTotal = reservedEntries.reduce((sum, e) => sum + e.amount, 0)

  // Core multi-currency settlement accounts that make up the master account.
  // These are always displayed so the client sees the complete picture of every
  // currency balance the platform tracks, even those still at 0.00.
  const CORE_CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

  // One balance line per currency: the core set first, then any other currency
  // the client holds (e.g. proceeds from a less common currency exchange).
  const orderedCurrencies = [
    ...CORE_CURRENCIES,
    ...currencies.filter((c) => !CORE_CURRENCIES.includes(c)),
  ].filter((c, i, arr) => arr.indexOf(c) === i)
  const heldCurrencies = orderedCurrencies.length
  const currencyBalances = orderedCurrencies.map((cur) => {
    // balanceFor = settled (completed credits − debits) − reserved holds.
    const raw = balanceFor(cur)
    const reserved = reservedFor(cur)
    // settled = the real cash position, independent of pending holds.
    const settled = raw + reserved
    // Only clamp the display to 0 when the negativity is caused by a PENDING
    // reservation (settled cash is still ≥ 0 but a hold exceeds it — e.g. a large
    // fund subscription awaiting approval). A genuinely overdrawn balance
    // (settled < 0) is a REAL figure and MUST be shown — clamping it to 0 hid
    // the deficit and made currency exchanges look like they "didn't reflect"
    // because the balance stayed pinned at 0.00 while the true balance changed.
    const available = settled < 0 ? raw : Math.max(0, raw)
    return {
      currency: cur,
      name: currencyNames[cur] || cur,
      balance: available,
      formatted: formatMoney(available, cur),
      reserved: reservedFor(cur),
      reservedFormatted: formatMoney(reservedFor(cur), cur),
    }
  })

  // Total available across every currency, converted to EUR. Built from the
  // clamped per-currency figures so an over-reserved currency can never drag
  // the headline total negative.
  const totalBalance = currencyBalances.reduce(
    (sum, cb) => sum + convertCurrency(cb.balance, cb.currency, "EUR"),
    0,
  )

  // Volume received over the trailing 30 days, aggregating every currency's
  // completed credits into their EUR equivalent so the figure reflects the
  // whole portfolio rather than EUR-only inflows.
  const now = new Date()
  const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000
  const monthlyVolume = entries
    .filter((e) => e.direction === "credit" && e.status === "completed" && new Date(e.date).getTime() >= thirtyDaysAgo)
    .reduce((sum, e) => sum + convertCurrency(e.amount, e.currency, "EUR"), 0)

  const receiptCount = entries.filter((e) => e.direction === "credit").length

  // Active bank instruments (SBLC / MTN / BG) currently on file.
  const activeInstruments = instruments.filter((i) => i.status === "active").length

  // Distinct partner banks across active beneficiaries.
  const activeBeneficiaries = beneficiaries.filter((b) => b.status === "active")
  const bankPartners = new Set(activeBeneficiaries.map((b) => b.bankName)).size

  const stats = [
    {
      title: "Active Instruments",
      value: `${activeInstruments}`,
      change: `${activeInstruments}`,
      trend: "up" as const,
      icon: FileText,
      description: "SBLC, MTN, BG",
      href: "/dashboard/instruments",
    },
    {
      title: "Volume (30d)",
      value: formatEur(monthlyVolume),
      change: `${receiptCount}`,
      trend: "up" as const,
      icon: TrendingUp,
      description: "Payments received",
      href: "/dashboard/transactions",
    },
    {
      title: "Bank Partners",
      value: `${bankPartners}`,
      change: `${activeBeneficiaries.length}`,
      trend: "up" as const,
      icon: Building2,
      description: "Active connections",
      href: "/dashboard/beneficiaries",
    },
  ]

  return (
    <div className="space-y-4">
      {/* Per-currency balances */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Account Balances
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Master multi-currency account
            </p>
          </div>
          <div className="rounded-lg bg-secondary p-2">
            <Wallet className="h-4 w-4 text-primary" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {currencyBalances.map((cb) => (
              <div
                key={cb.currency}
                className="group rounded-lg border border-border bg-secondary/40 p-4 transition-colors hover:border-primary/40 hover:bg-secondary/70"
              >
                <Link
                  href={`/dashboard/accounts/${cb.currency === "EUR" ? "ACC-001" : `ACC-${cb.currency}`}`}
                  aria-label={`View ${cb.name} account`}
                  className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary">
                      {cb.currency}
                    </span>
                    <span className="text-xs text-muted-foreground">{cb.name}</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/50 transition-colors group-hover:text-primary" />
                  </div>
                  <div className="mt-2 text-xl font-bold text-foreground break-all">
                    {cb.formatted}
                  </div>
                </Link>
                {cb.reserved > 0 && (
                  <button
                    type="button"
                    onClick={() => setReservedCurrency(cb.currency)}
                    aria-label={`See why ${cb.reservedFormatted} is reserved in your ${cb.name} account`}
                    className="mt-1 flex w-full items-center gap-1 rounded-md text-[11px] font-medium text-amber-600 transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Lock className="h-3 w-3" />
                    <span>{cb.reservedFormatted} reserved</span>
                    <span className="ml-auto inline-flex items-center gap-0.5 text-amber-600/80 underline underline-offset-2">
                      View details
                      <ChevronRight className="h-3 w-3" />
                    </span>
                  </button>
                )}
              </div>
            ))}
          </div>
          <Link
            href="/dashboard/accounts"
            className="group mt-4 flex items-center justify-between border-t border-border pt-3 transition-colors hover:text-primary focus-visible:outline-none"
          >
            <span className="text-xs text-muted-foreground transition-colors group-hover:text-primary">
              Total across {heldCurrencies} currencies (EUR equivalent)
            </span>
            <span className="flex items-center gap-1 text-sm font-bold text-foreground transition-colors group-hover:text-primary">
              {formatEur(totalBalance)}
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 transition-colors group-hover:text-primary" />
            </span>
          </Link>
        </CardContent>
      </Card>

      {/* Administrative fund blocks — visible directly under the balances so the
          client always sees what is blocked and why. Renders nothing when none. */}
      <BlockedFundsNotice />

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <Link
          key={stat.title}
          href={stat.href}
          aria-label={`View ${stat.title}`}
          className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Card className="h-full bg-card border-border transition-colors group-hover:border-primary/40 group-hover:bg-secondary/30">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <div className="rounded-lg bg-secondary p-2 transition-colors group-hover:bg-primary/15">
                <stat.icon className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="text-2xl font-bold text-foreground">{stat.value}</div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div
                  className={cn(
                    "flex items-center text-xs font-medium",
                    stat.trend === "up" ? "text-green-500" : "text-red-500"
                  )}
                >
                  {stat.trend === "up" ? (
                    <ArrowUpRight className="h-3 w-3 mr-0.5" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3 mr-0.5" />
                  )}
                  {stat.change}
                </div>
                <span className="text-xs text-muted-foreground">{stat.description}</span>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
      </div>

      {/* Reserved-funds breakdown: shows every held debit that locks part of the
          balance, so the client can see exactly what each reservation is for. */}
      <Dialog open={reservedCurrency !== null} onOpenChange={(open) => !open && setReservedCurrency(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-amber-600" />
              Reserved funds
              {reservedCurrency ? ` · ${reservedCurrency}` : ""}
            </DialogTitle>
            <DialogDescription>
              These transactions are on hold, so their total is set aside from your available
              balance until each one settles or is released.
            </DialogDescription>
          </DialogHeader>

          {reservedCurrency && (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">Total reserved</span>
                <span className="text-sm font-bold text-amber-600">
                  {formatMoney(reservedTotal, reservedCurrency)}
                </span>
              </div>

              {reservedEntries.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No reserved transactions.
                </p>
              ) : (
                <ul className="max-h-80 space-y-2 overflow-y-auto">
                  {reservedEntries.map((e) => (
                    <li
                      key={e.id}
                      className="rounded-lg border border-border bg-secondary/40 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground break-words">
                            {e.counterparty || e.category || "Reserved transaction"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(e.date)}
                            {e.category ? ` · ${e.category}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-sm font-semibold text-amber-600">
                          {formatMoney(e.amount, e.currency)}
                        </span>
                      </div>
                      {(e.comment || e.reference || e.bank) && (
                        <p className="mt-1.5 text-xs text-muted-foreground text-pretty break-words">
                          {e.comment || `Held pending settlement`}
                          {e.bank ? ` · ${e.bank}` : ""}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] font-mono text-muted-foreground/70">
                        Ref {e.reference || e.id}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-[11px] text-muted-foreground text-pretty">
                Reserved funds stay in your account but cannot be spent until the underlying
                transaction completes. Once settled or cancelled, the hold is released back to your
                available balance.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
