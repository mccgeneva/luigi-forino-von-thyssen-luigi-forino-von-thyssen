"use client"

// On-screen, print-friendly rendering of a bank-style account statement. Mirrors
// the layout and balance math of lib/statement-pdf.ts so the preview the client
// sees on screen matches the PDF they download exactly. All data is passed in
// already scoped to the signed-in user's ledger — this component never fetches.

import { Card, CardContent } from "@/components/ui/card"

export interface StatementDocEntry {
  id: string
  date: string // ISO
  direction: "credit" | "debit"
  amount: number // always positive
  currency: string
  status: string // "completed" | "hold" | ...
  counterparty: string
  reference?: string
  category?: string
}

export interface StatementDocProps {
  holderName: string
  holderCompany?: string
  /** Full name of the legal representative, shown in parentheses after the name. */
  holderRepresentative?: string
  /** Account holder's registered / correspondence address. */
  holderAddress?: string
  bankName?: string
  bankAddress?: string
  iban?: string
  bic?: string
  accountEmail?: string
  accountLabel: string
  periodFrom?: Date
  periodTo?: Date
  statementNo: string
  entries: StatementDocEntry[]
}

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
  return `${symbol}${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

interface CurrencySection {
  currency: string
  opening: number
  closing: number
  totalCredits: number
  totalDebits: number
  rows: Array<{
    entry: StatementDocEntry
    running: number | null // null when the entry does not count toward the balance (on hold)
  }>
}

// Build per-currency sections with opening balance, running balance and totals
// using exactly the same rules as the PDF generator.
function buildSections(props: StatementDocProps): CurrencySection[] {
  const from = props.periodFrom ? new Date(props.periodFrom) : undefined
  if (from) from.setHours(0, 0, 0, 0)
  const to = props.periodTo ? new Date(props.periodTo) : undefined
  if (to) to.setHours(23, 59, 59, 999)
  const inPeriod = (d: Date) => {
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  }

  const currencies = Array.from(new Set(props.entries.map((e) => e.currency))).sort()

  return currencies.map((currency) => {
    const all = props.entries
      .filter((e) => e.currency === currency)
      .map((e) => ({ ...e, _d: new Date(e.date) }))
      .filter((e) => !Number.isNaN(e._d.getTime()))
      .sort((a, b) => a._d.getTime() - b._d.getTime())

    const opening = all
      .filter((e) => e.status === "completed" && from && e._d < from)
      .reduce((s, e) => s + (e.direction === "credit" ? e.amount : -e.amount), 0)

    const periodEntries = all.filter((e) => inPeriod(e._d))

    let running = opening
    let totalCredits = 0
    let totalDebits = 0
    const rows = periodEntries.map((e) => {
      const counts = e.status === "completed"
      if (counts) {
        running += e.direction === "credit" ? e.amount : -e.amount
        if (e.direction === "credit") totalCredits += e.amount
        else totalDebits += e.amount
      }
      return { entry: e, running: counts ? running : null }
    })

    return { currency, opening, closing: running, totalCredits, totalDebits, rows }
  })
}

export function StatementDocument(props: StatementDocProps) {
  const sections = buildSections(props)
  const periodLabel =
    props.periodFrom || props.periodTo
      ? `${props.periodFrom ? formatDate(props.periodFrom) : "Beginning"} — ${
          props.periodTo ? formatDate(props.periodTo) : "Present"
        }`
      : "All transactions"

  return (
    <Card className="bg-card border-border overflow-hidden">
      {/* Branded header band */}
      <div className="bg-zinc-950 px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-zinc-900 font-bold text-lg">
            M
          </div>
          <div>
            <p className="text-base font-semibold text-white leading-tight">MCC Capital</p>
            <p className="text-[11px] text-zinc-400">MCC Banking &amp; Trade Platform</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-primary">ACCOUNT STATEMENT</p>
          <p className="text-[11px] text-zinc-400">No. {props.statementNo}</p>
        </div>
      </div>

      <CardContent className="p-6">
        {/* Account holder + statement meta */}
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Account Holder</p>
          <p className="mt-1.5 text-sm font-semibold text-foreground">
            {props.holderName || "—"}
            {props.holderRepresentative ? ` (${props.holderRepresentative})` : ""}
          </p>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {props.holderCompany && <p>{props.holderCompany}</p>}
            {props.holderAddress && <p>{props.holderAddress}</p>}
            {props.bankName && <p>Bank: {props.bankName}</p>}
              {props.bankAddress && <p>{props.bankAddress}</p>}
              {props.iban && <p>IBAN: {props.iban}</p>}
              {props.bic && <p>BIC/SWIFT: {props.bic}</p>}
              {props.accountEmail && <p>{props.accountEmail}</p>}
            </div>
          </div>
          <div className="sm:text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Statement Details</p>
            <dl className="mt-1.5 space-y-1 text-xs">
              <div className="flex justify-between sm:justify-end sm:gap-3">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="font-medium text-foreground">{props.accountLabel}</dd>
              </div>
              <div className="flex justify-between sm:justify-end sm:gap-3">
                <dt className="text-muted-foreground">Statement Period</dt>
                <dd className="font-medium text-foreground">{periodLabel}</dd>
              </div>
              <div className="flex justify-between sm:justify-end sm:gap-3">
                <dt className="text-muted-foreground">Issue Date</dt>
                <dd className="font-medium text-foreground">{formatDate(new Date())}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="my-5 h-px bg-border" />

        {sections.length === 0 ? (
          <p className="py-8 text-center text-sm italic text-muted-foreground">
            No transactions are recorded for this account.
          </p>
        ) : (
          <div className="space-y-8">
            {sections.map((section) => (
              <div key={section.currency}>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-foreground">{section.currency} Account</h3>
                  <p className="text-xs text-muted-foreground">
                    Opening balance:{" "}
                    <span className="font-medium text-foreground">{money(section.opening, section.currency)}</span>
                  </p>
                </div>

                <div className="mt-3 overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-zinc-950 text-left text-zinc-300">
                        <th className="px-3 py-2 font-semibold">Date</th>
                        <th className="px-3 py-2 font-semibold">Reference</th>
                        <th className="px-3 py-2 font-semibold">Description</th>
                        <th className="px-3 py-2 text-right font-semibold">Debit</th>
                        <th className="px-3 py-2 text-right font-semibold">Credit</th>
                        <th className="px-3 py-2 text-right font-semibold">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-4 text-center italic text-muted-foreground">
                            No transactions in this period.
                          </td>
                        </tr>
                      ) : (
                        section.rows.map(({ entry, running }, i) => {
                          const isCredit = entry.direction === "credit"
                          const counts = entry.status === "completed"
                          return (
                            <tr
                              key={entry.id + i}
                              className={i % 2 === 0 ? "bg-secondary/40" : "bg-transparent"}
                            >
                              <td className="whitespace-nowrap px-3 py-2 text-foreground">{formatDate(entry.date)}</td>
                              <td className="px-3 py-2 font-mono text-muted-foreground">{entry.reference || entry.id}</td>
                              <td className="px-3 py-2 text-foreground">
                                {entry.counterparty}
                                {entry.category ? ` · ${entry.category}` : ""}
                                {!counts && <span className="text-amber-400"> (on hold)</span>}
                              </td>
                              <td className="px-3 py-2 text-right text-red-400">
                                {!isCredit && counts ? money(entry.amount, entry.currency) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-emerald-400">
                                {isCredit && counts ? money(entry.amount, entry.currency) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right font-medium text-foreground">
                                {running === null ? "—" : money(running, entry.currency)}
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Closing summary */}
                <div className="mt-3 grid grid-cols-2 gap-3 rounded-md bg-secondary/40 p-4 sm:grid-cols-4">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Opening balance</p>
                    <p className="text-sm font-semibold text-foreground">{money(section.opening, section.currency)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Total credits</p>
                    <p className="text-sm font-semibold text-emerald-400">+ {money(section.totalCredits, section.currency)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Total debits</p>
                    <p className="text-sm font-semibold text-red-400">- {money(section.totalDebits, section.currency)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Closing balance</p>
                    <p className="text-sm font-semibold text-primary">{money(section.closing, section.currency)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 border-t border-border pt-3">
          <p className="text-[10px] text-muted-foreground">
            Electronically generated account statement — valid without signature. MCC Capital · Statement{" "}
            {props.statementNo}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
