"use client"

import { useMemo, useState } from "react"
import { Receipt, Download, ArrowUpRight, CalendarDays, CreditCard, Hash, Tag, FileText, Building2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useLedger, type LedgerEntry } from "@/lib/ledger-store"
import { useCurrentUser } from "@/lib/use-current-user"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { useActivityLog } from "@/components/activity-tracker"
import { generateCardTransactionsPdf, type CardTxnRow } from "@/lib/card-transactions-pdf"

const CARD_TXN_PREFIX = "Card Transaction"
const CARD_FEE_PREFIX = "Card Transaction Fee"
const KNOWN_NETWORKS = /\b(visa|mastercard|amex|american express|maestro|unionpay|discover|jcb|diners)\b/i
const BOILERPLATE_NOTE = /^Card transaction recorded by administrator/i

/** A recorded card transaction (the main debit) paired with its 2% fee. */
interface CardTxn extends CardTxnRow {
  id: string
  network?: string
  status?: string
  category?: string
  /** The stored reading of the uploaded receipt (OCR summary) or admin note. */
  note?: string
}

function fmtMoney(amount: number, currency: string): string {
  const symbols: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF ", JPY: "¥" }
  return `${symbols[currency] || `${currency} `}${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/** Pull the trailing card last-4 out of a "Card Transaction ····7575" category. */
function last4From(category?: string): string | undefined {
  const m = (category || "").match(/(\d{3,4})\s*$/)
  return m ? m[1] : undefined
}

/** Split "MERCHANT (Visa)" → { merchant, network } only when the parens hold a real network. */
function splitMerchant(counterparty: string): { merchant: string; network?: string } {
  const m = counterparty.match(/^(.*)\s+\(([^)]+)\)\s*$/)
  if (m && KNOWN_NETWORKS.test(m[2])) return { merchant: m[1].trim(), network: m[2].trim() }
  return { merchant: counterparty }
}

export function CardTransactions() {
  const { entries } = useLedger()
  const user = useCurrentUser()
  const pdf = usePdfViewer()
  const log = useActivityLog()
  const [selected, setSelected] = useState<CardTxn | null>(null)

  const txns = useMemo<CardTxn[]>(() => {
    const cardEntries = entries.filter((e) => (e.category || "").startsWith(CARD_TXN_PREFIX))
    const mains = cardEntries.filter((e) => !(e.category || "").startsWith(CARD_FEE_PREFIX))
    const feeById = new Map<string, LedgerEntry>()
    for (const e of cardEntries) {
      if ((e.category || "").startsWith(CARD_FEE_PREFIX)) feeById.set(e.id, e)
    }
    return mains
      .map((m) => {
        const fee = feeById.get(`${m.id}-FEE`)
        const { merchant, network } = splitMerchant(m.counterparty || "Card transaction")
        const note = (m.comment || "").trim()
        return {
          id: m.id,
          date: m.date,
          merchant,
          network,
          reference: m.reference && m.reference !== m.id ? m.reference : undefined,
          cardLast4: last4From(m.category),
          currency: m.currency,
          amount: m.amount,
          fee: fee?.amount ?? 0,
          status: m.status,
          category: m.category,
          note: note && !BOILERPLATE_NOTE.test(note) ? note : undefined,
        }
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [entries])

  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { amount: number; fee: number }>()
    for (const t of txns) {
      const cur = map.get(t.currency) ?? { amount: 0, fee: 0 }
      cur.amount += t.amount
      cur.fee += t.fee
      map.set(t.currency, cur)
    }
    return Array.from(map.entries())
  }, [txns])

  const holderName = user.cardHolderCompany || user.company || user.fullName || ""
  const representative = user.cardHolderPerson || user.fullName || undefined

  const handleExport = () => {
    const rows: CardTxnRow[] = txns.map((t) => ({
      date: t.date,
      merchant: t.merchant,
      reference: t.reference,
      cardLast4: t.cardLast4,
      currency: t.currency,
      amount: t.amount,
      fee: t.fee,
    }))
    pdf.show(
      generateCardTransactionsPdf({
        holderName,
        holderCompany: user.company || undefined,
        holderRepresentative: representative && representative !== holderName ? representative : undefined,
        accountEmail: user.email || undefined,
        rows,
      }),
    )
    log({
      action: "Exported card transactions extract (PDF)",
      category: "Cards",
      details: { summary: `Client exported a PDF extract of ${txns.length} card transaction${txns.length === 1 ? "" : "s"}.` },
    })
  }

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Receipt className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Card transactions</h2>
              <p className="text-xs text-muted-foreground">
                {txns.length === 0
                  ? "A live record of every card transaction charged to your account."
                  : `${txns.length} transaction${txns.length === 1 ? "" : "s"} · live · tap one for details`}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport} disabled={txns.length === 0}>
            <Download className="h-4 w-4" />
            Export PDF
          </Button>
        </div>

        {/* Per-currency totals */}
        {totalsByCurrency.length > 0 && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {totalsByCurrency.map(([currency, t]) => (
              <div key={currency} className="rounded-lg border border-border bg-secondary/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{currency} charged</p>
                <p className="text-lg font-bold text-foreground">{fmtMoney(t.amount + t.fee, currency)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {fmtMoney(t.amount, currency)} + {fmtMoney(t.fee, currency)} fees
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Live list */}
        <div className="mt-4">
          {txns.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
              <Receipt className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">No transactions yet</p>
              <p className="text-xs text-muted-foreground">
                Card transactions appear here automatically as they are recorded.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {txns.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(t)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg py-3 pl-1 pr-1 text-left transition-colors hover:bg-secondary/40"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/50">
                        <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{t.merchant}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {fmtDate(t.date)}
                          {t.cardLast4 ? ` · ••${t.cardLast4}` : ""}
                          {t.reference ? ` · ref ${t.reference}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm font-semibold text-foreground">
                        -{fmtMoney(t.amount + t.fee, t.currency)}
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {fmtMoney(t.amount, t.currency)} + {fmtMoney(t.fee, t.currency)} fee
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      {/* Transaction detail — zoom */}
      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="flex max-h-[88dvh] max-w-md flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-primary" />
              Transaction details
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {/* Headline */}
              <div className="rounded-xl border border-border bg-secondary/30 p-4 text-center">
                <p className="truncate text-sm text-muted-foreground">{selected.merchant}</p>
                <p className="mt-1 font-mono text-3xl font-bold text-foreground">
                  -{fmtMoney(selected.amount + selected.fee, selected.currency)}
                </p>
                <div className="mt-2 flex items-center justify-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {selected.status || "completed"}
                  </Badge>
                  {selected.network && <Badge variant="outline">{selected.network}</Badge>}
                </div>
              </div>

              {/* Amount breakdown */}
              <div className="divide-y divide-border rounded-lg border border-border">
                <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">Transaction amount</span>
                  <span className="font-mono font-medium text-foreground">{fmtMoney(selected.amount, selected.currency)}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                  <span className="text-muted-foreground">Platform fee (2%)</span>
                  <span className="font-mono font-medium text-foreground">{fmtMoney(selected.fee, selected.currency)}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                  <span className="font-semibold text-foreground">Total charged</span>
                  <span className="font-mono font-bold text-foreground">
                    {fmtMoney(selected.amount + selected.fee, selected.currency)}
                  </span>
                </div>
              </div>

              {/* Field grid */}
              <dl className="grid grid-cols-2 gap-3">
                <DetailField icon={CalendarDays} label="Date" value={fmtDate(selected.date)} />
                <DetailField icon={Building2} label="Currency" value={selected.currency} />
                {selected.cardLast4 && (
                  <DetailField icon={CreditCard} label="Card" value={`•••• ${selected.cardLast4}`} mono />
                )}
                {selected.network && <DetailField icon={CreditCard} label="Network" value={selected.network} />}
                {selected.reference && <DetailField icon={Hash} label="Reference" value={selected.reference} mono />}
                {selected.category && <DetailField icon={Tag} label="Category" value={selected.category} />}
              </dl>

              {/* Stored receipt reading */}
              {selected.note && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    Reading from receipt
                  </p>
                  <p className="text-sm text-foreground text-pretty">{selected.note}</p>
                </div>
              )}

              <p className="text-center font-mono text-[10px] text-muted-foreground">Ref ID: {selected.id}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function DetailField({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <dt className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className={`truncate text-sm font-medium text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  )
}
