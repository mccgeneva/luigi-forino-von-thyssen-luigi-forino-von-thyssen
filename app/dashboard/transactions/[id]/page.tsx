"use client"

import { useMemo } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Copy,
  Building2,
  CalendarDays,
  Hash,
  Tag,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useLedger } from "@/lib/ledger-store"
import { generateReceiptPdf } from "@/lib/receipt-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { toast } from "sonner"

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

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })} · ${d.toLocaleTimeString(
    "en-GB",
    { hour: "2-digit", minute: "2-digit" },
  )}`
}

export default function TransactionDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { entries, hydrated } = useLedger()
  const { show } = usePdfViewer()

  const id = decodeURIComponent(params.id)
  const entry = useMemo(() => entries.find((e) => e.id === id), [entries, id])
  // The matching 2% platform fee, posted as a separate "<id>-FEE" debit.
  const feeEntry = useMemo(() => entries.find((e) => e.id === `${id}-FEE`), [entries, id])

  if (hydrated && !entry) {
    return (
      <div className="mx-auto max-w-2xl">
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href="/dashboard/transactions">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Transactions
          </Link>
        </Button>
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
              <Hash className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Transaction not found</p>
            <p className="text-xs text-muted-foreground mt-1">
              We couldn&apos;t find a transaction with reference{" "}
              <code className="text-foreground">{id}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="h-9 w-40 animate-pulse rounded-md bg-secondary" />
        <div className="mt-4 h-64 animate-pulse rounded-xl bg-secondary" />
      </div>
    )
  }

  const isCredit = entry.direction === "credit"

  const handleCopy = (value: string, label: string) => {
    navigator.clipboard?.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Could not copy"),
    )
  }

  const handleDownloadReceipt = () => {
    const bicMatch = entry.bank?.match(/\(?\b(?:BIC|SWIFT)[:\s]+([A-Z0-9]{8,11})\)?/i)
    const bankName = entry.bank?.replace(/\s*\(?\b(?:BIC|SWIFT)[:\s]+[A-Z0-9]{8,11}\)?/i, "").trim()
    show(generateReceiptPdf({
      reference: entry.reference || entry.id,
      direction: entry.direction,
      amount: formatAmount(entry.amount, entry.currency),
      currency: entry.currency,
      status: entry.status,
      date: entry.date,
      category: entry.category,
      counterparty: entry.counterparty,
      bank: bankName || entry.bank,
      bic: bicMatch?.[1],
      iban: entry.account,
      notes: entry.comment,
    }))
  }

  const rows: { label: string; value?: string; copy?: boolean; icon?: typeof Hash }[] = [
    { label: "Reference", value: entry.reference || entry.id, copy: true, icon: Hash },
    { label: "Category", value: entry.category, icon: Tag },
    { label: isCredit ? "Sender" : "Beneficiary", value: entry.counterparty, icon: Building2 },
    { label: "Bank", value: entry.bank, icon: Building2 },
    { label: "IBAN / Account", value: entry.account, copy: true, icon: Hash },
    { label: "Value date", value: formatDateTime(entry.date), icon: CalendarDays },
  ]

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button variant="outline" size="sm" onClick={handleDownloadReceipt}>
          <Download className="mr-2 h-4 w-4" />
          Receipt
        </Button>
      </div>

      <Card className="bg-card border-border overflow-hidden">
        <CardHeader className="border-b border-border bg-secondary/30">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-full",
                isCredit ? "bg-green-500/10" : "bg-red-500/10",
              )}
            >
              {isCredit ? (
                <ArrowDownLeft className="h-6 w-6 text-green-500" />
              ) : (
                <ArrowUpRight className="h-6 w-6 text-red-500" />
              )}
            </div>
            <div className="min-w-0">
              <CardTitle className="text-2xl font-bold text-foreground break-all">
                <span className={isCredit ? "text-green-500" : "text-foreground"}>
                  {isCredit ? "+" : "-"}
                  {formatAmount(entry.amount, entry.currency)}
                </span>
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {entry.currency}
                </span>
              </CardTitle>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] capitalize",
                    entry.status === "completed"
                      ? "bg-green-500/10 text-green-500 border-green-500/20"
                      : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
                  )}
                >
                  {entry.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {isCredit ? "Incoming / Credit" : "Outgoing / Debit"}
                </span>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <dl className="divide-y divide-border">
            {rows
              .filter((r) => r.value)
              .map((r) => {
                const Icon = r.icon
                return (
                  <div key={r.label} className="flex items-start justify-between gap-4 px-5 py-3.5">
                    <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                      {Icon && <Icon className="h-3.5 w-3.5" />}
                      {r.label}
                    </dt>
                    <dd className="flex items-center gap-2 text-right">
                      <span className="text-sm font-medium text-foreground break-all">{r.value}</span>
                      {r.copy && (
                        <button
                          type="button"
                          onClick={() => handleCopy(r.value as string, r.label)}
                          className="text-muted-foreground transition-colors hover:text-primary"
                          aria-label={`Copy ${r.label}`}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </dd>
                  </div>
                )
              })}

            {feeEntry && (
              <div className="flex items-start justify-between gap-4 px-5 py-3.5">
                <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Tag className="h-3.5 w-3.5" />
                  Transaction fee
                  {entry.amount > 0
                    ? ` (${((feeEntry.amount / entry.amount) * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% effective, tiered)`
                    : " (tiered)"}
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {formatAmount(feeEntry.amount, feeEntry.currency)}
                </dd>
              </div>
            )}
          </dl>

          {entry.comment && (
            <p className="mx-5 my-4 rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">
              {entry.comment}
            </p>
          )}

          <div className="border-t border-border p-5">
            <Button className="w-full" onClick={handleDownloadReceipt}>
              <Download className="mr-2 h-4 w-4" />
              Download Receipt
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
