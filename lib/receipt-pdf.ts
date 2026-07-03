// Generates a professional, bank-style PDF payment receipt entirely in the
// browser using jsPDF. Used for single-transaction "Download Receipt" actions.

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface ReceiptData {
  reference: string
  direction: "credit" | "debit" | string
  amount: string // pre-formatted, e.g. "€50,000.00"
  currency: string
  status: string
  date: string // ISO or display string
  category?: string
  /** Sender (for incoming) or beneficiary (for outgoing). */
  counterparty: string
  counterpartyAddress?: string
  bank?: string
  bic?: string
  iban?: string
  fee?: string
  notes?: string
  /** SWIFT gpi Unique End-to-End Transaction Reference (UUID v4). */
  uetr?: string
}

const BRAND = {
  name: "MCC Capital",
  tagline: "MCC Banking & Trade Platform",
  address: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  email: "support@mcc-capital.com",
  // Bloomberg amber + dark ink, matching the platform theme.
  gold: [245, 140, 0] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [225, 227, 231] as [number, number, number],
  green: [22, 140, 90] as [number, number, number],
  red: [193, 60, 60] as [number, number, number],
}

function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })
}

function formatTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

export function generateReceiptPdf(data: ReceiptData): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 48
  const contentWidth = pageWidth - margin * 2
  const isCredit = data.direction === "credit"

  // ---- Header band -------------------------------------------------------
  doc.setFillColor(...BRAND.ink)
  doc.rect(0, 0, pageWidth, 96, "F")

  // Brand logo mark
  drawBrandMark(doc, "capital", margin, 30, 36, 36, { panel: true, radius: 6 })

  // Brand name + tagline
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(17)
  doc.text(BRAND.name, margin + 50, 48)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(190, 192, 196)
  doc.text(BRAND.tagline, margin + 50, 64)

  // Receipt label (right)
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("PAYMENT RECEIPT", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Ref: ${data.reference}`, pageWidth - margin, 64, { align: "right" })

  // ---- Amount summary ----------------------------------------------------
  let y = 140
  doc.setTextColor(...BRAND.slate)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text(isCredit ? "Amount Received" : "Amount Sent", margin, y)

  doc.setTextColor(...(isCredit ? BRAND.green : BRAND.ink))
  doc.setFont("helvetica", "bold")
  doc.setFontSize(28)
  doc.text(`${isCredit ? "+" : "-"} ${data.amount}`, margin, y + 30)

  // Status pill (right aligned)
  const statusText = data.status.toUpperCase()
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  const pillW = doc.getTextWidth(statusText) + 24
  const pillX = pageWidth - margin - pillW
  const completed = data.status.toLowerCase() === "completed"
  if (completed) doc.setFillColor(232, 245, 238)
  else doc.setFillColor(248, 244, 232)
  doc.roundedRect(pillX, y + 8, pillW, 22, 11, 11, "F")
  doc.setTextColor(...(completed ? BRAND.green : BRAND.gold))
  doc.text(statusText, pillX + pillW / 2, y + 23, { align: "center" })

  y += 56
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Two-column parties ------------------------------------------------
  y += 28
  const colGap = 24
  const colWidth = (contentWidth - colGap) / 2
  const rightX = margin + colWidth + colGap

  const senderTitle = isCredit ? "FROM (SENDER)" : "FROM (ACCOUNT HOLDER)"
  const beneTitle = isCredit ? "TO (BENEFICIARY)" : "TO (BENEFICIARY)"

  const drawParty = (
    x: number,
    title: string,
    name: string,
    lines: string[],
  ): number => {
    let yy = y
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.text(title, x, yy)
    yy += 16
    doc.setTextColor(...BRAND.ink)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.text(name || "—", x, yy)
    yy += 15
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.slate)
    lines
      .filter(Boolean)
      .forEach((ln) => {
        const wrapped = doc.splitTextToSize(ln, colWidth)
        wrapped.forEach((w: string) => {
          doc.text(w, x, yy)
          yy += 13
        })
      })
    return yy
  }

  // Account holder is the platform client; counterparty is the other party.
  const clientParty = {
    name: BRAND.name,
    lines: [BRAND.address],
  }
  const otherParty = {
    name: data.counterparty,
    lines: [
      data.counterpartyAddress || "",
      data.bank ? `Bank: ${data.bank}` : "",
      data.bic ? `BIC/SWIFT: ${data.bic}` : "",
      data.iban ? `IBAN: ${data.iban}` : "",
    ],
  }

  // For credits: sender = counterparty, beneficiary = client.
  // For debits: sender = client, beneficiary = counterparty.
  const leftParty = isCredit ? otherParty : clientParty
  const rightParty = isCredit ? clientParty : otherParty

  const leftEnd = drawParty(margin, senderTitle, leftParty.name, leftParty.lines)
  const rightEnd = drawParty(rightX, beneTitle, rightParty.name, rightParty.lines)

  y = Math.max(leftEnd, rightEnd) + 14
  doc.setDrawColor(...BRAND.line)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Transaction details table ----------------------------------------
  y += 26
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.text("Transaction Details", margin, y)
  y += 10

  const rows: [string, string][] = [
    ["Reference Number", data.reference],
    ...(data.uetr ? [["UETR (SWIFT gpi)", data.uetr] as [string, string]] : []),
    ["Date & Time", `${formatDate(data.date)}${formatTime(data.date) ? " · " + formatTime(data.date) : ""}`],
    ["Type", isCredit ? "Incoming Transfer (Credit)" : "Outgoing Payment (Debit)"],
    ["Category", data.category || "—"],
    ["Amount", data.amount],
    ...(data.fee ? [["Platform Fee", data.fee] as [string, string]] : []),
    ["Currency", data.currency],
    ["Status", data.status.charAt(0).toUpperCase() + data.status.slice(1)],
  ]

  rows.forEach((row, i) => {
    const rowY = y + 12 + i * 24
    if (i % 2 === 0) {
      doc.setFillColor(248, 249, 250)
      doc.rect(margin, rowY - 4, contentWidth, 24, "F")
    }
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(row[0], margin + 12, rowY + 11)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(...BRAND.ink)
    doc.text(row[1], pageWidth - margin - 12, rowY + 11, { align: "right" })
  })

  y = y + 12 + rows.length * 24 + 16

  // gpi confirmation line
  if (data.uetr) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND.slate)
    const gpiLine = doc.splitTextToSize(
      "Payment executed via SWIFT gpi (Global Payments Innovation) with full tracking capability.",
      contentWidth,
    )
    doc.text(gpiLine, margin, y)
    y += gpiLine.length * 12 + 6
  }

  // Notes
  if (data.notes) {
    doc.setDrawColor(...BRAND.line)
    doc.line(margin, y, pageWidth - margin, y)
    y += 20
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.slate)
    doc.text("NOTES", margin, y)
    y += 14
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.ink)
    const wrapped = doc.splitTextToSize(data.notes, contentWidth)
    doc.text(wrapped, margin, y)
    y += wrapped.length * 13 + 8
  }

  // ---- Footer ------------------------------------------------------------
  const pageHeight = doc.internal.pageSize.getHeight()
  const footerY = pageHeight - 70
  doc.setDrawColor(...BRAND.line)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  doc.text(
    "This document is an electronically generated payment receipt and is valid without signature.",
    margin,
    footerY + 16,
  )
  doc.text(
    `${BRAND.name}  ·  ${BRAND.address}  ·  ${BRAND.email}`,
    margin,
    footerY + 30,
  )
  doc.text(
    `Generated ${new Date().toLocaleString("en-GB")}`,
    pageWidth - margin,
    footerY + 30,
    { align: "right" },
  )

  return { doc, filename: `receipt-${data.reference}.pdf`, title: "Payment Receipt" }
}
