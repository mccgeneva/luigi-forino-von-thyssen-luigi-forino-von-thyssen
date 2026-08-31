// Generates a professional, multi-page CARD TRANSACTIONS extract PDF in the
// browser using jsPDF. Always scoped to a single user's ledger (the caller
// passes that user's identity + rows), so there is no shared or cross-user
// data. Shares the brand styling used by lib/statement-pdf.ts.

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface CardTxnRow {
  date: string // ISO
  merchant: string
  reference?: string
  cardLast4?: string
  cardLabel?: string
  currency: string
  amount: number // transaction amount (positive)
  fee: number // 2% platform fee (positive)
}

export interface CardTransactionsInput {
  holderName: string
  holderCompany?: string
  holderRepresentative?: string
  accountEmail?: string
  rows: CardTxnRow[]
}

const BRAND = {
  name: "MCC Capital",
  tagline: "MCC Banking & Trade Platform",
  gold: [245, 140, 0] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [225, 227, 231] as [number, number, number],
  light: [248, 249, 250] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
  red: [193, 60, 60] as [number, number, number],
}

const currencySymbols: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF ",
  JPY: "¥",
}

function money(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || `${currency} `
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function generateCardTransactionsPdf(input: CardTransactionsInput): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - 64

  const extractNo = `CTX-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.floor(
    Math.random() * 9000 + 1000,
  )}`

  let pageNo = 0
  const drawFooter = () => {
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, bottomLimit + 14, pageWidth - margin, bottomLimit + 14)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND.slate)
    doc.text("Electronically generated card transactions extract — valid without signature.", margin, bottomLimit + 28)
    doc.text(`${BRAND.name}  ·  Extract ${extractNo}`, margin, bottomLimit + 39)
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 39, { align: "right" })
  }

  const drawHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 92, "F")
    drawBrandMark(doc, "capital", margin, 28, 34, 34, { panel: true, radius: 6 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(16)
    doc.text(BRAND.name, margin + 48, 46)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.setTextColor(190, 192, 196)
    doc.text(BRAND.tagline, margin + 48, 61)
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(13)
    doc.text("CARD TRANSACTIONS", pageWidth - margin, 46, { align: "right" })
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.text(`No. ${extractNo}`, pageWidth - margin, 61, { align: "right" })
  }

  let y = 0
  const newPage = () => {
    doc.addPage()
    pageNo += 1
    drawHeader()
    drawFooter()
    y = 116
  }
  const ensureSpace = (needed: number) => {
    if (y + needed > bottomLimit) newPage()
  }

  pageNo = 1
  drawHeader()
  drawFooter()
  y = 116

  // ---- Account holder + extract meta (two columns) ----------------------
  const colGap = 24
  const colWidth = (contentWidth - colGap) / 2
  const rightX = margin + colWidth + colGap

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.text("ACCOUNT HOLDER", margin, y)
  let ly = y + 16
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(12)
  const holderLine = input.holderRepresentative
    ? `${input.holderName || "—"} (${input.holderRepresentative})`
    : input.holderName || "—"
  doc.splitTextToSize(holderLine, colWidth).forEach((w: string) => {
    doc.text(w, margin, ly)
    ly += 15
  })
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...BRAND.slate)
  ;[input.holderCompany, input.accountEmail].filter(Boolean).forEach((line) => {
    doc.splitTextToSize(line as string, colWidth).forEach((w: string) => {
      doc.text(w, margin, ly)
      ly += 13
    })
  })

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.text("EXTRACT DETAILS", rightX, y)
  let ry = y + 16
  const metaRows: [string, string][] = [
    ["Issue Date", formatDate(new Date())],
    ["Extract No.", extractNo],
    ["Transactions", String(input.rows.length)],
  ]
  metaRows.forEach(([label, value]) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.slate)
    doc.text(label, rightX, ry)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(...BRAND.ink)
    doc.text(value, pageWidth - margin, ry, { align: "right" })
    ry += 15
  })

  y = Math.max(ly, ry) + 8
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)
  y += 24

  if (input.rows.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(10.5)
    doc.setTextColor(...BRAND.slate)
    doc.text("No card transactions are recorded for this account.", margin, y)
    return { doc, filename: `MCC-Card-Transactions-${extractNo}.pdf`, title: "Card Transactions" }
  }

  // ---- Table geometry ---------------------------------------------------
  const cellPad = 6
  const numColW = 82
  const dateW = 62
  const cardW = 58
  const tableRight = margin + contentWidth
  const totalLeft = tableRight - numColW
  const feeLeft = totalLeft - numColW
  const amtLeft = feeLeft - numColW
  const cols = {
    date: margin + cellPad,
    desc: margin + cellPad + dateW,
    amtR: amtLeft + numColW - cellPad,
    feeR: feeLeft + numColW - cellPad,
    totalR: totalLeft + numColW - cellPad,
  }
  const descWidth = amtLeft - cols.desc - cellPad - cardW
  const cardX = amtLeft - cardW
  const numTextMax = numColW - cellPad * 2

  const drawAmount = (
    text: string,
    rightX: number,
    baselineY: number,
    color: [number, number, number],
    style: "normal" | "bold" = "normal",
  ) => {
    doc.setFont("helvetica", style)
    doc.setTextColor(...color)
    let size = 8.5
    doc.setFontSize(size)
    while (size > 6 && doc.getTextWidth(text) > numTextMax) {
      size -= 0.5
      doc.setFontSize(size)
    }
    doc.text(text, rightX, baselineY, { align: "right" })
    doc.setFontSize(8.5)
  }

  const drawTableHead = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(margin, y, contentWidth, 22, "F")
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    const ty = y + 14
    doc.text("DATE", cols.date, ty)
    doc.text("MERCHANT / DESCRIPTION", cols.desc, ty)
    doc.text("CARD", cardX, ty)
    doc.text("AMOUNT", cols.amtR, ty, { align: "right" })
    doc.text("FEE 2%", cols.feeR, ty, { align: "right" })
    doc.text("TOTAL", cols.totalR, ty, { align: "right" })
    y += 22
  }

  const currencies = Array.from(new Set(input.rows.map((r) => r.currency))).sort()

  currencies.forEach((currency) => {
    const rows = input.rows
      .filter((r) => r.currency === currency)
      .map((r) => ({ ...r, _d: new Date(r.date) }))
      .sort((a, b) => b._d.getTime() - a._d.getTime())

    ensureSpace(60)
    doc.setTextColor(...BRAND.ink)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(13)
    doc.text(`${currency} Transactions`, margin, y)
    y += 14
    drawTableHead()

    let totalAmount = 0
    let totalFee = 0

    rows.forEach((r, i) => {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8.5)
      const descLines = doc.splitTextToSize(
        `${r.merchant}${r.reference ? ` · ref ${r.reference}` : ""}`,
        descWidth,
      ) as string[]
      const rowH = Math.max(20, descLines.length * 11 + 9)
      ensureSpace(rowH)

      if (i % 2 === 0) {
        doc.setFillColor(...BRAND.light)
        doc.rect(margin, y, contentWidth, rowH, "F")
      }
      const ty = y + 13
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8.5)
      doc.setTextColor(...BRAND.ink)
      doc.text(formatDate(r._d), cols.date, ty)
      descLines.forEach((ln, li) => doc.text(ln, cols.desc, ty + li * 11))
      doc.setTextColor(...BRAND.slate)
      doc.text(r.cardLast4 ? `••${r.cardLast4}` : "—", cardX, ty)
      drawAmount(money(r.amount, currency), cols.amtR, ty, BRAND.ink)
      drawAmount(money(r.fee, currency), cols.feeR, ty, BRAND.red)
      drawAmount(money(r.amount + r.fee, currency), cols.totalR, ty, BRAND.ink, "bold")
      y += rowH
      totalAmount += r.amount
      totalFee += r.fee
    })

    // ---- Currency summary box ----
    ensureSpace(72)
    y += 6
    doc.setFillColor(...BRAND.light)
    doc.roundedRect(margin, y, contentWidth, 58, 4, 4, "F")
    const sy = y + 18
    const summary: [string, string, [number, number, number]][] = [
      ["Transactions total", money(totalAmount, currency), BRAND.ink],
      ["Fees total (2%)", money(totalFee, currency), BRAND.red],
      ["Charged to account", money(totalAmount + totalFee, currency), BRAND.ink],
    ]
    summary.forEach(([label, value, color], idx) => {
      const x = margin + 16 + idx * ((contentWidth - 32) / 3)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8.5)
      doc.setTextColor(...BRAND.slate)
      doc.text(label, x, sy)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(11)
      doc.setTextColor(...color)
      doc.text(value, x, sy + 16)
    })
    doc.setDrawColor(...BRAND.line)
    doc.line(margin + 12, y + 40, pageWidth - margin - 12, y + 40)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10.5)
    doc.setTextColor(...BRAND.ink)
    doc.text("Total charged to Master Account", margin + 16, y + 52)
    doc.setTextColor(...BRAND.gold)
    doc.text(money(totalAmount + totalFee, currency), pageWidth - margin - 16, y + 52, { align: "right" })
    y += 58 + 26
  })

  return { doc, filename: `MCC-Card-Transactions-${extractNo}.pdf`, title: "Card Transactions" }
}
