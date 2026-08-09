// Generates a professional, bank-style single-SWIFT-message PDF entirely in the
// browser using jsPDF. Used for per-message "Export as PDF" actions in the
// SWIFT Messaging inbox/outbox.
//
// GUARDRAIL: this document is explicitly labelled a system-generated FIN
// transmission COPY for information — it deliberately does NOT fabricate SWIFT
// network authentication (ACK/MAC/PKI trailers, session/sequence/MIR numbers),
// so it reads professionally without impersonating a network-authenticated
// proof of settlement.

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface SwiftMessagePdfData {
  id: string
  type: string
  direction?: string
  status?: string
  sender: string
  receiver: string
  amount?: string
  currency?: string
  beneficiary?: string
  beneficiaryAccount?: string
  orderingCustomer?: string
  reference?: string
  valueDate?: string
  date?: string
  uetr?: string
  raw?: string
}

const BRAND = {
  name: "MCC Capital",
  tagline: "SWIFT FIN · Financial Messaging",
  address: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  email: "support@mcc-capital.com",
  navy: [10, 37, 64] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [213, 221, 229] as [number, number, number],
  panel: [244, 247, 250] as [number, number, number],
}

function mtNumber(type: string): string {
  return (type || "").replace(/^MT/i, "").trim()
}

export function generateSwiftMessagePdf(data: SwiftMessagePdfData): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 48
  const contentWidth = pageWidth - margin * 2
  const mt = mtNumber(data.type)
  const amount = data.amount ? `${data.currency ?? ""} ${data.amount}`.trim() : "—"

  // ---- Header band -------------------------------------------------------
  doc.setFillColor(...BRAND.navy)
  doc.rect(0, 0, pageWidth, 96, "F")
  drawBrandMark(doc, "capital", margin, 30, 36, 36, { panel: true, radius: 6 })
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(17)
  doc.text(BRAND.name, margin + 50, 48)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(190, 200, 214)
  doc.text(BRAND.tagline, margin + 50, 64)

  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("SWIFT TRANSMISSION COPY", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 200, 214)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`MT${mt}${data.id ? `  ·  ${data.id}` : ""}`, pageWidth - margin, 64, { align: "right" })

  // ---- Field table -------------------------------------------------------
  let y = 132
  const rows: [string, string][] = [
    ["Message Type", `MT${mt}`],
    ["Direction", (data.direction || "").toUpperCase() || "—"],
    ["Status", (data.status || "").toUpperCase() || "—"],
    ["Sender (BIC / SWIFT)", data.sender || "—"],
    ["Receiver (BIC / SWIFT)", data.receiver || "—"],
    ["Transaction Ref (:20:)", data.reference || "—"],
    ["Value / Amount (:32A:)", amount],
    ...(data.orderingCustomer ? [["Ordering Customer (:50:)", data.orderingCustomer] as [string, string]] : []),
    ...(data.beneficiaryAccount ? [["Beneficiary Account", data.beneficiaryAccount] as [string, string]] : []),
    ...(data.beneficiary ? [["Beneficiary (:59:)", data.beneficiary] as [string, string]] : []),
    ["Value Date", data.valueDate || "—"],
    ["UETR (:121:)", data.uetr || "—"],
  ]

  rows.forEach((row, i) => {
    const rowH = 24
    const rowY = y + i * rowH
    if (i % 2 === 0) {
      doc.setFillColor(...BRAND.panel)
      doc.rect(margin, rowY - 4, contentWidth, rowH, "F")
    }
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(row[0], margin + 12, rowY + 12)
    doc.setFont("courier", "bold")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.ink)
    const wrapped = doc.splitTextToSize(row[1], contentWidth / 2 - 12)
    doc.text(wrapped, pageWidth - margin - 12, rowY + 12, { align: "right" })
  })
  y += rows.length * 24 + 18

  // ---- Raw FIN block -----------------------------------------------------
  if (data.raw) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.slate)
    doc.text("FIN MESSAGE TEXT (BLOCK 4)", margin, y)
    y += 12

    const finLines = doc.splitTextToSize(data.raw, contentWidth - 24)
    const blockH = finLines.length * 12 + 20
    doc.setFillColor(...BRAND.navy)
    doc.roundedRect(margin, y, contentWidth, blockH, 6, 6, "F")
    doc.setFont("courier", "normal")
    doc.setFontSize(9)
    doc.setTextColor(230, 237, 245)
    doc.text(finLines, margin + 12, y + 16)
    y += blockH + 16
  }

  // ---- Footer ------------------------------------------------------------
  const pageHeight = doc.internal.pageSize.getHeight()
  const footerY = pageHeight - 70
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  const disclaimer = doc.splitTextToSize(
    "This is a system-generated SWIFT FIN copy transmitted for information by the MCC Capital platform. It is a reproduction of the message and is not a network-authenticated confirmation or proof of settlement.",
    contentWidth,
  )
  doc.text(disclaimer, margin, footerY + 16)
  doc.text(
    `${BRAND.name}  ·  ${BRAND.address}`,
    margin,
    footerY + 16 + disclaimer.length * 11 + 4,
  )
  doc.text(
    `Generated ${new Date().toLocaleString("en-GB")}`,
    pageWidth - margin,
    footerY + 16 + disclaimer.length * 11 + 4,
    { align: "right" },
  )

  return { doc, filename: `swift-${data.id || mt}.pdf`, title: `SWIFT MT${mt}` }
}

/**
 * Plain-text (.txt) representation of a single SWIFT message — a labelled field
 * header followed by the raw FIN Block 4. Suitable for the "Export as plain
 * text" action.
 */
export function swiftMessageToPlainText(data: SwiftMessagePdfData): string {
  const mt = mtNumber(data.type)
  const amount = data.amount ? `${data.currency ?? ""} ${data.amount}`.trim() : "—"
  const line = "=".repeat(64)
  const field = (label: string, value?: string) => `${label.padEnd(26)}: ${value || "—"}`

  const header = [
    line,
    "MCC CAPITAL — SWIFT FIN TRANSMISSION COPY",
    line,
    field("Message Type", `MT${mt}`),
    field("Message ID", data.id),
    field("Direction", (data.direction || "").toUpperCase()),
    field("Status", (data.status || "").toUpperCase()),
    field("Sender (BIC / SWIFT)", data.sender),
    field("Receiver (BIC / SWIFT)", data.receiver),
    field("Transaction Ref (:20:)", data.reference),
    field("Value / Amount (:32A:)", amount),
    ...(data.orderingCustomer ? [field("Ordering Customer (:50:)", data.orderingCustomer)] : []),
    ...(data.beneficiaryAccount ? [field("Beneficiary Account", data.beneficiaryAccount)] : []),
    ...(data.beneficiary ? [field("Beneficiary (:59:)", data.beneficiary)] : []),
    field("Value Date", data.valueDate),
    field("UETR (:121:)", data.uetr),
    line,
  ].join("\n")

  const raw = data.raw ? `\nFIN MESSAGE TEXT (BLOCK 4)\n${"-".repeat(64)}\n${data.raw}\n` : ""

  const footer = [
    line,
    "This is a system-generated SWIFT FIN copy transmitted for information.",
    "It is not a network-authenticated confirmation or proof of settlement.",
    `Generated ${new Date().toLocaleString("en-GB")}`,
    line,
  ].join("\n")

  return `${header}\n${raw}\n${footer}\n`
}
