"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  ArrowUpRight,
  ArrowDownLeft,
  ArrowLeftRight,
  Download,
  Filter,
  Search,
  Calendar,
  MoreHorizontal,
  FileText,
  Building2,
  CreditCard,
  TrendingUp,
  ExternalLink,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import type { DateRange } from "react-day-picker"
import { cn } from "@/lib/utils"
import { exportToCsv } from "@/lib/export-utils"
import { generateReceiptPdf } from "@/lib/receipt-pdf"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { useActivityLog } from "@/components/activity-tracker"
import { toast } from "sonner"
import { useLedger, convertCurrency } from "@/lib/ledger-store"
import { useHolderIdentity } from "@/lib/holder-identity"

// The core multi-currency accounts every client holds. Transactions for all of
// these settle into the master account, so the page must surface them — not
// just EUR.
const CORE_CURRENCIES = ["EUR", "GBP", "USD", "CHF"]

type Transaction = {
  id: string
  type: string
  direction: string
  amount: string
  amountValue: number
  currency: string
  fee: string
  feeValue: number
  counterparty: string
  account: string
  category: string
  status: string
  date: string
  time: string
}

const currencySymbols: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF",
}

function formatAmount(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || currency
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const typeIcons = {
  payment: CreditCard,
  instrument: FileText,
  exchange: ArrowLeftRight,
  yield: TrendingUp,
}

const typeColors = {
  payment: "bg-blue-500/10 text-blue-400",
  instrument: "bg-orange-500/10 text-orange-400",
  exchange: "bg-purple-500/10 text-purple-400",
  yield: "bg-green-500/10 text-green-400",
}

export default function TransactionsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")
  const [filterCurrency, setFilterCurrency] = useState("all")
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null)
  const logActivity = useActivityLog()
  const router = useRouter()
  const { entries } = useLedger()
  const { show } = usePdfViewer()

  // Account-holder identity + registered address printed at the top of the
  // exported PDF ("PREPARED FOR" block), shared with every other extract page.
  const { holderName, holderCompany, holderAddress } = useHolderIdentity()

  // Build the transaction list from the persisted ledger so every recorded
  // incoming payment (and outgoing payment) appears here automatically. The 2%
  // platform fee is posted as a separate "<id>-FEE" debit at approval time; we
  // surface it both as its own row AND inline on the principal payment it
  // belongs to, so the payment and fee details read clearly together.
  const feeByPrincipal = new Map<string, { amount: number; currency: string }>()
  for (const e of entries) {
    if (e.id.endsWith("-FEE")) {
      feeByPrincipal.set(e.id.slice(0, -"-FEE".length), { amount: e.amount, currency: e.currency })
    }
  }

  const transactions: Transaction[] = entries.map((e) => {
    const d = new Date(e.date)
    const isFeeRow = e.id.endsWith("-FEE")
    const linkedFee = feeByPrincipal.get(e.id)
    return {
      id: e.id,
      type: "payment",
      direction: e.direction === "credit" ? "incoming" : "outgoing",
      amount: formatAmount(e.amount, e.currency),
      amountValue: e.amount,
      currency: e.currency,
      // Show the linked 2% platform fee inline on the principal payment row.
      fee: linkedFee ? formatAmount(linkedFee.amount, linkedFee.currency) : formatAmount(0, e.currency),
      feeValue: linkedFee?.amount ?? 0,
      counterparty: e.counterparty,
      account: e.account || "MCC Capital",
      category:
        e.category ||
        (isFeeRow
          ? "Platform Fee (2%)"
          : e.direction === "credit"
          ? "Incoming Transfer"
          : "Outgoing Payment"),
      status: e.status === "completed" ? "completed" : "pending",
      date: Number.isNaN(d.getTime()) ? e.date : d.toISOString().split("T")[0],
      time: Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    }
  })

  const filteredTransactions = transactions.filter((txn) => {
    const matchesSearch =
      txn.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      txn.counterparty.toLowerCase().includes(searchQuery.toLowerCase()) ||
      txn.category.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType = filterType === "all" || txn.type === filterType
    const matchesStatus = filterStatus === "all" || txn.status === filterStatus
    const matchesCurrency = filterCurrency === "all" || txn.currency === filterCurrency

    let matchesDate = true
    if (dateRange?.from) {
      const txnDate = new Date(txn.date)
      if (!Number.isNaN(txnDate.getTime())) {
        const from = new Date(dateRange.from)
        from.setHours(0, 0, 0, 0)
        const to = dateRange.to ? new Date(dateRange.to) : new Date(dateRange.from)
        to.setHours(23, 59, 59, 999)
        matchesDate = txnDate >= from && txnDate <= to
      }
    }

    return matchesSearch && matchesType && matchesStatus && matchesCurrency && matchesDate
  })

  // KPIs are derived from the transactions actually shown (after filters) so the
  // numbers always stay consistent with the list. Total Volume now covers EVERY
  // currency (EUR, GBP, USD, CHF, …): when a specific currency is selected we sum
  // it natively; otherwise we convert each entry into EUR so the headline figure
  // reflects the client's full multi-currency activity, not just EUR.
  const now = new Date()
  const volumeCurrency = filterCurrency === "all" ? "EUR" : filterCurrency
  const totalVolume = filteredTransactions.reduce(
    (sum, t) => sum + convertCurrency(Math.abs(t.amountValue), t.currency, volumeCurrency),
    0,
  )
  const todayCount = filteredTransactions.filter((t) => {
    const d = new Date(t.date)
    return !Number.isNaN(d.getTime()) && d.toDateString() === now.toDateString()
  }).length
  const hasDateFilter = Boolean(dateRange?.from)

  const stats = [
    {
      title: "Total Volume",
      value: formatAmount(totalVolume, volumeCurrency),
      subtext:
        filterCurrency === "all"
          ? hasDateFilter
            ? "All currencies · selected period"
            : "All currencies (in EUR)"
          : hasDateFilter
            ? `${filterCurrency} · selected period`
            : `${filterCurrency} transactions`,
      icon: TrendingUp,
      color: "text-primary",
    },
    {
      title: "Transactions",
      value: `${filteredTransactions.length}`,
      subtext: `${todayCount} today`,
      icon: CreditCard,
      color: "text-blue-400",
    },
    {
      title: "Instruments Traded",
      value: "0",
      subtext: "SBLC, MTN, BG",
      icon: FileText,
      color: "text-orange-400",
    },
    {
      title: "FX Conversions",
      value: formatAmount(0, "EUR"),
      subtext: "0 exchanges",
      icon: ArrowLeftRight,
      color: "text-purple-400",
    },
  ]

  const formatRangeLabel = () => {
    if (!dateRange?.from) return "Date Range"
    const fmt = (d: Date) =>
      d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    if (!dateRange.to || dateRange.from.getTime() === dateRange.to.getTime()) {
      return fmt(dateRange.from)
    }
    return `${fmt(dateRange.from)} – ${fmt(dateRange.to)}`
  }

  const handleExportCsv = () => {
    if (filteredTransactions.length === 0) {
      toast.info("No transactions to export", {
        description: "There are no transactions matching the current filters.",
      })
      return
    }
    const count = exportToCsv("transactions", filteredTransactions, [
      { key: "id", label: "Transaction ID" },
      { key: "type", label: "Type" },
      { key: "direction", label: "Direction" },
      { key: "amount", label: "Amount" },
      { key: "fee", label: "Fee" },
      { key: "counterparty", label: "Counterparty" },
      { key: "account", label: "Account" },
      { key: "category", label: "Category" },
      { key: "status", label: "Status" },
      { key: "date", label: "Date" },
      { key: "time", label: "Time" },
    ])
    logActivity({
      action: `Exported ${count} transaction${count === 1 ? "" : "s"} to CSV`,
      category: "Transactions",
      details: {
        summary: `Client exported ${count} transaction record${count === 1 ? "" : "s"} (current filters applied) to a CSV file.`,
        recordCount: `${count}`,
        format: "CSV",
      },
    })
    toast.success(`Exported ${count} transaction${count === 1 ? "" : "s"}`, {
      description: "Your CSV download has started.",
    })
  }

  const handleExportPdf = () => {
    if (filteredTransactions.length === 0) {
      toast.info("No transactions to export", {
        description: "There are no transactions matching the current filters.",
      })
      return
    }
    const doc = generateTablePdf({
      title: "Transaction History",
      refPrefix: "TXN",
      holderName,
      holderCompany,
      holderAddress,
      meta: [
        { label: "Records", value: `${filteredTransactions.length}` },
        { label: "Period", value: formatRangeLabel() === "Date Range" ? "All dates" : formatRangeLabel() },
      ],
      columns: [
        { key: "date", header: "Date" },
        { key: "id", header: "Reference" },
        { key: "type", header: "Type" },
        { key: "counterparty", header: "Counterparty" },
        { key: "direction", header: "Dir." },
        { key: "amount", header: "Amount", align: "right" },
        { key: "status", header: "Status" },
      ],
      rows: filteredTransactions as unknown as Record<string, unknown>[],
      footNote:
        "Transaction history exported from the MCC Capital platform with the filters active at the time of export.",
    })
    show({ doc, filename: tablePdfFilename("Transaction-History"), title: "Transaction History" })
    logActivity({
      action: `Exported ${filteredTransactions.length} transaction${filteredTransactions.length === 1 ? "" : "s"} to PDF`,
      category: "Transactions",
      details: {
        summary: `Client previewed/exported ${filteredTransactions.length} transaction record(s) as a professional PDF.`,
        recordCount: `${filteredTransactions.length}`,
        format: "PDF",
      },
    })
  }

  const handleViewDetails = (txn: Transaction) => {
    logActivity({
      action: `Viewed transaction ${txn.id}`,
      category: "Transactions",
      details: {
        summary: `Client opened the details for transaction ${txn.id}.`,
        transaction: txn.id,
        amount: txn.amount,
      },
    })
    router.push(`/dashboard/transactions/${encodeURIComponent(txn.id)}`)
  }

  const handleDownloadReceipt = (txn: Transaction) => {
    // Find the originating ledger entry to recover full payment details
    // (bank, BIC, IBAN, notes) for a complete receipt.
    const entry = entries.find((e) => e.id === txn.id)
    const bank = entry?.bank
    const bicMatch = bank?.match(/\(?\b(?:BIC|SWIFT)[:\s]+([A-Z0-9]{8,11})\)?/i)
    const bankName = bank?.replace(/\s*\(?\b(?:BIC|SWIFT)[:\s]+[A-Z0-9]{8,11}\)?/i, "").trim()
    show(generateReceiptPdf({
      reference: entry?.reference || txn.id,
      direction: txn.direction === "incoming" ? "credit" : "debit",
      amount: txn.amount,
      currency: txn.currency,
      status: txn.status,
      date: entry?.date || txn.date,
      category: txn.category,
      counterparty: txn.counterparty,
      bank: bankName || bank,
      bic: bicMatch?.[1],
      iban: entry?.account || (txn.account !== "MCC Capital" ? txn.account : undefined),
      notes: entry?.comment,
    }))
    logActivity({
      action: `Downloaded receipt for ${txn.id}`,
      category: "Transactions",
      details: {
        summary: `Client downloaded the PDF receipt for transaction ${txn.id} (${txn.amount}).`,
        transaction: txn.id,
        format: "PDF",
      },
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Complete transaction history across all accounts
          </p>
        </div>
        <div className="flex gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(dateRange?.from && "border-primary text-primary")}
              >
                <Calendar className="mr-2 h-4 w-4" />
                {formatRangeLabel()}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <CalendarPicker
                mode="range"
                selected={dateRange}
                onSelect={setDateRange}
                numberOfMonths={1}
                initialFocus
              />
              {dateRange?.from && (
                <div className="flex justify-end border-t border-border p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDateRange(undefined)}
                  >
                    Clear
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportPdf}>
                <FileText className="mr-2 h-4 w-4" />
                Export as PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportCsv}>
                <Download className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold text-foreground mt-1">
                    {stat.value}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stat.subtext}
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <stat.icon className={cn("h-5 w-5", stat.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Transactions Table */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <CardTitle className="text-lg font-semibold">
              All Transactions
            </CardTitle>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search transactions..."
                  className="pl-9 w-full sm:w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="payment">Payments</SelectItem>
                  <SelectItem value="instrument">Instruments</SelectItem>
                  <SelectItem value="exchange">Exchange</SelectItem>
                  <SelectItem value="yield">Yield</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterCurrency} onValueChange={setFilterCurrency}>
                <SelectTrigger className="w-full sm:w-[140px]">
                  <SelectValue placeholder="Currency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Currencies</SelectItem>
                  {CORE_CURRENCIES.map((cur) => (
                    <SelectItem key={cur} value={cur}>
                      {cur}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Transaction</TableHead>
                  <TableHead className="text-muted-foreground">Type</TableHead>
                  <TableHead className="text-muted-foreground">Counterparty</TableHead>
                  <TableHead className="text-muted-foreground">Account</TableHead>
                  <TableHead className="text-muted-foreground text-right">Amount</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Date</TableHead>
                  <TableHead className="text-muted-foreground w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTransactions.length === 0 ? (
                  <TableRow className="border-border hover:bg-transparent">
                    <TableCell colSpan={8}>
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
                          <ArrowLeftRight className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium text-foreground">No transactions yet</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Your transaction history will appear here
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTransactions.map((txn) => {
                  const TypeIcon = typeIcons[txn.type as keyof typeof typeIcons]
                  const typeColor = typeColors[txn.type as keyof typeof typeColors]

                  return (
                    <TableRow
                      key={txn.id}
                      className="border-border cursor-pointer transition-colors hover:bg-secondary/40"
                      onClick={() => router.push(`/dashboard/transactions/${encodeURIComponent(txn.id)}`)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "flex h-8 w-8 items-center justify-center rounded-full",
                              txn.direction === "incoming"
                                ? "bg-green-500/10"
                                : txn.direction === "outgoing"
                                ? "bg-red-500/10"
                                : "bg-purple-500/10"
                            )}
                          >
                            {txn.direction === "incoming" ? (
                              <ArrowDownLeft className="h-4 w-4 text-green-500" />
                            ) : txn.direction === "outgoing" ? (
                              <ArrowUpRight className="h-4 w-4 text-red-500" />
                            ) : (
                              <ArrowLeftRight className="h-4 w-4 text-purple-500" />
                            )}
                          </div>
                          <div>
                            <code className="text-xs font-medium text-foreground">
                              {txn.id}
                            </code>
                            <p className="text-xs text-muted-foreground">
                              {txn.category}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] capitalize", typeColor)}
                        >
                          <TypeIcon className="mr-1 h-3 w-3" />
                          {txn.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-foreground">{txn.counterparty}</p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-muted-foreground">{txn.account}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        <p
                          className={cn(
                            "text-sm font-semibold",
                            txn.direction === "incoming"
                              ? "text-green-500"
                              : txn.direction === "outgoing"
                              ? "text-foreground"
                              : "text-purple-400"
                          )}
                        >
                          {txn.direction === "incoming" && "+"}
                          {txn.direction === "outgoing" && "-"}
                          {txn.amount}
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {txn.currency}
                          </span>
                        </p>
                        {txn.feeValue > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            +2% fee: {txn.fee}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] capitalize",
                            txn.status === "completed"
                              ? "bg-green-500/10 text-green-500 border-green-500/20"
                              : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                          )}
                        >
                          {txn.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-foreground">{txn.date}</p>
                        <p className="text-xs text-muted-foreground">{txn.time}</p>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => handleViewDetails(txn)}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => handleDownloadReceipt(txn)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download Receipt
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Transaction details */}
      <Dialog open={!!selectedTxn} onOpenChange={(open) => !open && setSelectedTxn(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transaction Details</DialogTitle>
            <DialogDescription>
              {selectedTxn?.category} &middot; {selectedTxn?.date} {selectedTxn?.time}
            </DialogDescription>
          </DialogHeader>
          {selectedTxn && (
            <div className="space-y-3">
              {(() => {
                const linkedFee = feeByPrincipal.get(selectedTxn.id)
                const showTotal = selectedTxn.direction === "outgoing" && !!linkedFee
                const total = selectedTxn.amountValue + (linkedFee?.amount ?? 0)
                const rows = [
                  { label: "Transaction ID", value: selectedTxn.id },
                  { label: "Type", value: selectedTxn.type },
                  { label: "Direction", value: selectedTxn.direction },
                  { label: "Counterparty", value: selectedTxn.counterparty },
                  { label: "Account", value: selectedTxn.account },
                  { label: "Amount", value: selectedTxn.amount },
                  ...(linkedFee
                    ? [{ label: "Platform Fee (2%)", value: selectedTxn.fee }]
                    : []),
                  ...(showTotal
                    ? [{ label: "Total Debited", value: formatAmount(total, selectedTxn.currency) }]
                    : []),
                  { label: "Status", value: selectedTxn.status },
                ]
                return rows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between gap-4 border-b border-border pb-2 last:border-0"
                  >
                    <span className="text-xs text-muted-foreground">{row.label}</span>
                    <span className="text-sm font-medium text-foreground capitalize text-right break-all">
                      {row.value || "—"}
                    </span>
                  </div>
                ))
              })()}
              <Button
                className="w-full"
                variant="outline"
                onClick={() => handleDownloadReceipt(selectedTxn)}
              >
                <Download className="mr-2 h-4 w-4" />
                Download Receipt
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
