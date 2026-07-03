// Generates a bank-style PDF "Investment Confirmation" for an approved
// PPP / Yield Program investment, entirely in the browser with jsPDF.
// Used by the PPP page's "View Details" → "Download Confirmation" action so
// clients have a downloadable record of their active investment.

import { jsPDF } from "jspdf"
import { BRAND, money, formatDate, formatDateTime, type GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface PPPConfirmationData {
  reference: string
  programName: string
  amount: number
  currency: string
  expectedReturn: string
  returnFrequency: string
  duration: string
  sourceOfFunds: string
  payoutAccount: string
  submittedAt: string
  decidedAt?: string
  holderName?: string
}

export function generatePPPConfirmationPdf(data: PPPConfirmationData): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 48
  const contentWidth = pageWidth - margin * 2

  // ---- Header band -------------------------------------------------------
  doc.setFillColor(...BRAND.ink)
  doc.rect(0, 0, pageWidth, 96, "F")

  drawBrandMark(doc, "capital", margin, 30, 36, 36, { panel: true, radius: 6 })

  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(17)
  doc.text(BRAND.name, margin + 50, 48)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(190, 192, 196)
  doc.text(BRAND.tagline, margin + 50, 64)

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("INVESTMENT CONFIRMATION", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Ref: ${data.reference}`, pageWidth - margin, 64, { align: "right" })

  // ---- Invested amount summary ------------------------------------------
  let y = 140
  doc.setTextColor(...BRAND.slate)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text("Invested Amount", margin, y)

  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(28)
  doc.text(money(data.amount, data.currency), margin, y + 30)

  // Active status pill (right aligned)
  const statusText = "ACTIVE"
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  const pillW = doc.getTextWidth(statusText) + 24
  const pillX = pageWidth - margin - pillW
  doc.setFillColor(232, 245, 238)
  doc.roundedRect(pillX, y + 8, pillW, 22, 11, 11, "F")
  doc.setTextColor(...BRAND.green)
  doc.text(statusText, pillX + pillW / 2, y + 23, { align: "center" })

  y += 56
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Program header ----------------------------------------------------
  y += 28
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.text("PROGRAM", margin, y)
  y += 16
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text(data.programName, margin, y)
  y += 24

  // ---- Details table -----------------------------------------------------
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.text("Investment Details", margin, y)
  y += 10

  const rows: [string, string][] = [
    ["Investment Reference", data.reference],
    ...(data.holderName ? [["Account Holder", data.holderName] as [string, string]] : []),
    ["Invested Amount", money(data.amount, data.currency)],
    ["Currency", data.currency],
    ["Expected Return", `${data.expectedReturn} (${data.returnFrequency})`],
    ["Duration", data.duration],
    ["Source of Funds", data.sourceOfFunds],
    ["Payout Account", data.payoutAccount],
    ["Application Submitted", formatDateTime(data.submittedAt)],
    ...(data.decidedAt ? [["Approved On", formatDate(data.decidedAt)] as [string, string]] : []),
    ["Status", "Active"],
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

  y = y + 12 + rows.length * 24 + 18

  // ---- Disclaimer --------------------------------------------------------
  doc.setFont("helvetica", "italic")
  doc.setFontSize(8.5)
  doc.setTextColor(...BRAND.slate)
  const disclaimer = doc.splitTextToSize(
    "This confirmation records an approved Private Placement Program investment held with MCC Capital. " +
      "Returns are projected, not guaranteed, and are distributed per the program schedule to the nominated payout account.",
    contentWidth,
  )
  doc.text(disclaimer, margin, y)

  // ---- Footer ------------------------------------------------------------
  const pageHeight = doc.internal.pageSize.getHeight()
  const footerY = pageHeight - 70
  doc.setDrawColor(...BRAND.line)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  doc.text(
    "This document is an electronically generated investment confirmation and is valid without signature.",
    margin,
    footerY + 16,
  )
  doc.text(`${BRAND.name}  ·  ${BRAND.address}  ·  ${BRAND.email}`, margin, footerY + 30)
  doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, pageWidth - margin, footerY + 30, {
    align: "right",
  })

  return {
    doc,
    filename: `MCC-Investment-Confirmation-${data.reference}.pdf`,
    title: "Investment Confirmation",
  }
}
