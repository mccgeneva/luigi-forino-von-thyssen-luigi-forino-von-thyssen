"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ScrollText,
  Download,
  FileText,
  Calendar as CalendarIcon,
  TrendingUp,
  TrendingDown,
  Wallet,
  Percent,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import type { DateRange } from "react-day-picker"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useCurrentUser } from "@/lib/use-current-user"
import { useLedger, convertCurrency, type LedgerEntry } from "@/lib/ledger-store"
import { useActivityLog } from "@/components/activity-tracker"
import { generateStatementPdf } from "@/lib/statement-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { exportToCsv } from "@/lib/export-utils"
import { StatementDocument } from "@/components/dashboard/statement-document"

// Categorises a ledger entry as belonging to a "bank instrument" account
// (yield/PPP, leverage, SBLC/BG/MTN, treasury deposits, accrued interest, SKR).
const INSTRUMENT_RE = /yield|ppp|instrument|leverage|sblc|\bbg\b|\bmtn\b|interest|treasury|deposit|skr|fiduciary/i
function isInstrumentEntry(e: LedgerEntry): boolean {
  return INSTRUMENT_RE.test(`${e.category ?? ""} ${e.counterparty ?? ""}`)
}

// Entries that represent fees or accrued/leverage interest, surfaced separately
// in the statement summary.
const FEE_INTEREST_RE = /fee|interest/i
function isFeeOrInterest(e: LedgerEntry): boolean {
  return e.id.endsWith("-FEE") || FEE_INTEREST_RE.test(e.category ?? "")
}

type PeriodPreset = "all" | "7d" | "30d" | "90d" | "month" | "ytd" | "custom"

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
function money(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || `${currency} `
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Pull a labelled value out of the user's banking profile array.
function bankingValue(banking: { label: string; value: string }[], label: string): string | undefined {
  return banking.find((b) => b.label.toLowerCase() === label.toLowerCase())?.value
}

export default function StatementsPage() {
  const user = useCurrentUser()
  const { entries, currencies } = useLedger()
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()

  const [account, setAccount] = useState("master")

  // Honor an `?account=` deep link (e.g. from the Bank Accounts page) after mount
  // so SSR and the first client render stay identical (no hydration mismatch).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("account")
    if (fromUrl) setAccount(fromUrl)
  }, [])
  const [currencyFilter, setCurrencyFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [period, setPeriod] = useState<PeriodPreset>("all")
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined)

  const banking = (user.banking ?? []) as { label: string; value: string }[]
  const holderName = bankingValue(banking, "Account Holder") || user.fullName || user.company
  const bankName = bankingValue(banking, "Bank Name")
  const bankAddress = bankingValue(banking, "Bank Address")
  const companyInfo = (user.companyInfo ?? []) as { label: string; value: string }[]
  const holderAddress =
    bankingValue(banking, "Beneficiary Address") ||
    bankingValue(companyInfo, "Registered Address") ||
    bankingValue(companyInfo, "Address")
  const iban = bankingValue(banking, "IBAN")
  const bic = bankingValue(banking, "BIC / SWIFT")
  // Legal representative (the natural person acting for the entity), shown in
  // parentheses after the holder name. Omitted when it equals the holder name.
  const principal = (user.principal ?? []) as { label: string; value: string }[]
  const rep = bankingValue(principal, "Represented By") || user.fullName
  const holderRepresentative = rep && rep !== holderName ? rep : undefined

  // Build the list of selectable accounts from the user's real ledger so the
  // options always reflect the currencies and instrument activity they hold.
  const accountOptions = useMemo(() => {
    const opts = [{ id: "master", label: "Master Account — All Currencies" }]
    for (const cur of [...currencies].sort()) {
      opts.push({ id: `cur:${cur}`, label: `${cur} Settlement Account` })
    }
    if (entries.some(isInstrumentEntry)) {
      opts.push({ id: "instruments", label: "Bank Instruments & Structured Products" })
    }
    return opts
  }, [currencies, entries])

  const accountLabel = accountOptions.find((o) => o.id === account)?.label ?? "Master Account"

  // Resolve the active statement period into concrete from/to bounds.
  const { periodFrom, periodTo } = useMemo(() => {
    const now = new Date()
    const start = (d: Date) => {
      d.setHours(0, 0, 0, 0)
      return d
    }
    switch (period) {
      case "7d":
        return { periodFrom: start(new Date(now.getTime() - 6 * 864e5)), periodTo: now }
      case "30d":
        return { periodFrom: start(new Date(now.getTime() - 29 * 864e5)), periodTo: now }
      case "90d":
        return { periodFrom: start(new Date(now.getTime() - 89 * 864e5)), periodTo: now }
      case "month":
        return { periodFrom: start(new Date(now.getFullYear(), now.getMonth(), 1)), periodTo: now }
      case "ytd":
        return { periodFrom: start(new Date(now.getFullYear(), 0, 1)), periodTo: now }
      case "custom":
        return {
          periodFrom: customRange?.from ? start(new Date(customRange.from)) : undefined,
          periodTo: customRange?.to ?? customRange?.from,
        }
      default:
        return { periodFrom: undefined, periodTo: undefined }
    }
  }, [period, customRange])

  // Apply the account scope + currency + type + status filters. Period is handled
  // downstream (from/to) so opening balances are computed from prior activity.
  const scopedEntries = useMemo(() => {
    let list = entries
    if (account.startsWith("cur:")) {
      const cur = account.slice(4)
      list = list.filter((e) => e.currency === cur)
    } else if (account === "instruments") {
      list = list.filter(isInstrumentEntry)
    }
    if (currencyFilter !== "all") list = list.filter((e) => e.currency === currencyFilter)
    if (typeFilter === "credit") list = list.filter((e) => e.direction === "credit")
    else if (typeFilter === "debit") list = list.filter((e) => e.direction === "debit")
    else if (typeFilter === "fees") list = list.filter(isFeeOrInterest)
    else if (typeFilter === "instruments") list = list.filter(isInstrumentEntry)
    if (statusFilter !== "all") list = list.filter((e) => e.status === statusFilter)
    return list
  }, [entries, account, currencyFilter, typeFilter, statusFilter])

  // Summary across the selected period (completed entries only count toward money
  // movements, exactly like the statement body).
  const summary = useMemo(() => {
    const from = periodFrom ? new Date(periodFrom) : undefined
    const to = periodTo ? new Date(periodTo) : undefined
    if (to) to.setHours(23, 59, 59, 999)
    const inPeriod = (d: Date) => (!from || d >= from) && (!to || d <= to)

    let credits = 0
    let debits = 0
    let feesInterest = 0
    // When the statement spans multiple currencies, totals are converted into a
    // single display currency (the filtered currency, otherwise EUR) so the
    // headline figures are meaningful rather than a raw sum of mixed units.
    const summaryCurrency = currencyFilter !== "all" ? currencyFilter : "EUR"
    let mixed = false

    for (const e of scopedEntries) {
      const d = new Date(e.date)
      if (Number.isNaN(d.getTime()) || !inPeriod(d) || e.status !== "completed") continue
      if (e.currency !== summaryCurrency) mixed = true
      const value = convertCurrency(e.amount, e.currency, summaryCurrency)
      if (e.direction === "credit") credits += value
      else debits += value
      if (isFeeOrInterest(e)) feesInterest += value
    }
    return { credits, debits, feesInterest, summaryCurrency, mixed }
  }, [scopedEntries, periodFrom, periodTo, currencyFilter])

  // Derive the statement number deterministically from the current scope so the
  // server and client render identical markup (no Math.random / hydration drift).
  const statementNo = useMemo(() => {
    const scope = `${account}|${currencyFilter}|${typeFilter}|${statusFilter}|${period}|${customRange?.from ?? ""}|${customRange?.to ?? ""}`
    let hash = 0
    for (let i = 0; i < scope.length; i++) hash = (hash * 31 + scope.charCodeAt(i)) >>> 0
    const suffix = String(1000 + (hash % 9000))
    return `STM-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${suffix}`
  }, [account, currencyFilter, typeFilter, statusFilter, period, customRange])

  const periodHuman =
    period === "custom" && !customRange?.from
      ? "Select a custom range"
      : periodFrom || periodTo
        ? `${periodFrom ? periodFrom.toLocaleDateString("en-GB") : "Beginning"} — ${
            periodTo ? new Date(periodTo).toLocaleDateString("en-GB") : "Present"
          }`
        : "All transactions"

  const handleDownloadPdf = () => {
    if (scopedEntries.length === 0) {
      toast.info("Nothing to generate", {
        description: "There are no transactions for the selected account and filters.",
      })
      return
    }
    show(
      generateStatementPdf({
        holderName,
        holderCompany: user.company,
        holderRepresentative,
        holderAddress,
        bankName,
        iban,
        bic,
        accountEmail: user.accountEmail,
        periodFrom,
        periodTo: periodTo ? new Date(periodTo) : undefined,
        entries: scopedEntries.map((e) => ({
          id: e.id,
          date: e.date,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency,
          status: e.status,
          counterparty: e.counterparty,
          reference: e.reference,
          category: e.category,
        })),
      }),
    )
    logActivity({
      action: `Generated account statement for ${accountLabel}`,
      category: "Statements",
      details: {
        summary: `Client downloaded a PDF account statement for "${accountLabel}" covering ${periodHuman}.`,
        account: accountLabel,
        period: periodHuman,
        transactions: `${scopedEntries.length}`,
        format: "PDF (A4)",
      },
    })
  }

  const handleExportCsv = () => {
    if (scopedEntries.length === 0) {
      toast.info("Nothing to export", { description: "There are no transactions for the selected filters." })
      return
    }
    const count = exportToCsv(
      `statement-${account}`,
      scopedEntries.map((e) => ({
        date: new Date(e.date).toISOString().split("T")[0],
        reference: e.reference || e.id,
        description: e.counterparty,
        category: e.category || "",
        direction: e.direction,
        debit: e.direction === "debit" ? e.amount.toFixed(2) : "",
        credit: e.direction === "credit" ? e.amount.toFixed(2) : "",
        currency: e.currency,
        status: e.status,
      })),
      [
        { key: "date", label: "Date" },
        { key: "reference", label: "Reference" },
        { key: "description", label: "Description" },
        { key: "category", label: "Category" },
        { key: "direction", label: "Direction" },
        { key: "debit", label: "Debit" },
        { key: "credit", label: "Credit" },
        { key: "currency", label: "Currency" },
        { key: "status", label: "Status" },
      ],
    )
    toast.success(`Exported ${count} transaction${count === 1 ? "" : "s"}`, {
      description: "Your CSV download has started.",
    })
  }

  const stats = [
    {
      title: "Total Credits",
      value: money(summary.credits, summary.summaryCurrency),
      icon: TrendingUp,
      color: "text-emerald-400",
    },
    {
      title: "Total Debits",
      value: money(summary.debits, summary.summaryCurrency),
      icon: TrendingDown,
      color: "text-red-400",
    },
    {
      title: "Net Movement",
      value: money(summary.credits - summary.debits, summary.summaryCurrency),
      icon: Wallet,
      color: "text-primary",
    },
    {
      title: "Fees & Interest",
      value: money(summary.feesInterest, summary.summaryCurrency),
      icon: Percent,
      color: "text-amber-400",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <ScrollText className="h-6 w-6 text-primary" />
            Account Statements
          </h1>
          <p className="text-sm text-muted-foreground">
            Generate professional, downloadable statements for every account — {user.company}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCsv}>
            <FileText className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button
            size="sm"
            onClick={handleDownloadPdf}
            className="bg-amber-500 text-zinc-900 hover:bg-amber-600"
          >
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </div>

      {/* Controls */}
      <Card className="bg-card border-border">
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Account</Label>
            <Select value={account} onValueChange={setAccount}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Statement Period</Label>
            <Select value={period} onValueChange={(v) => setPeriod(v as PeriodPreset)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All transactions</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="ytd">Year to date</SelectItem>
                <SelectItem value="custom">Custom range…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {period === "custom" ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Custom Range</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn("w-full justify-start font-normal", customRange?.from && "border-primary text-primary")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customRange?.from
                      ? `${customRange.from.toLocaleDateString("en-GB")}${
                          customRange.to ? ` – ${customRange.to.toLocaleDateString("en-GB")}` : ""
                        }`
                      : "Pick a date range"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarPicker
                    mode="range"
                    selected={customRange}
                    onSelect={setCustomRange}
                    numberOfMonths={1}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Currency</Label>
              <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All currencies</SelectItem>
                  {[...currencies].sort().map((cur) => (
                    <SelectItem key={cur} value={cur}>
                      {cur}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {period === "custom" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Currency</Label>
              <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All currencies</SelectItem>
                  {[...currencies].sort().map((cur) => (
                    <SelectItem key={cur} value={cur}>
                      {cur}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Transaction Type</Label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="credit">Credits (incoming)</SelectItem>
                <SelectItem value="debit">Debits (outgoing)</SelectItem>
                <SelectItem value="fees">Fees &amp; interest</SelectItem>
                <SelectItem value="instruments">Instruments &amp; yield</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="hold">On hold / pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{stat.title}</p>
                  <p className="mt-1 text-xl font-bold text-foreground">{stat.value}</p>
                  {summary.mixed && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      Multi-currency · shown in {summary.summaryCurrency}
                    </p>
                  )}
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <stat.icon className={cn("h-5 w-5", stat.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="bg-primary/15 text-primary">
          {scopedEntries.length} transaction{scopedEntries.length === 1 ? "" : "s"}
        </Badge>
        <span className="text-xs text-muted-foreground">{periodHuman}</span>
      </div>

      {/* Live statement preview */}
      <StatementDocument
        holderName={holderName}
        holderCompany={user.company}
        bankName={bankName}
        bankAddress={bankAddress}
        iban={iban}
        bic={bic}
        accountEmail={user.accountEmail}
        accountLabel={accountLabel}
        periodFrom={periodFrom}
        periodTo={periodTo ? new Date(periodTo) : undefined}
        statementNo={statementNo}
        entries={scopedEntries.map((e) => ({
          id: e.id,
          date: e.date,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency,
          status: e.status,
          counterparty: e.counterparty,
          reference: e.reference,
          category: e.category,
        }))}
      />
    </div>
  )
}
