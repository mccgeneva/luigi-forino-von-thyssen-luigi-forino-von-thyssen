// Generates a professional, Bloomberg-style PDF "Payment Instructions" artifact
// for a single bank account, entirely in the browser using jsPDF. Wired to the
// "Export Details" action on the account detail page.
//
// SCOPE: this document exists ONLY to guide a third party to remit funds into
// the account. It therefore discloses the beneficiary and the banking
// coordinates required to route a payment — and nothing else. It MUST NOT
// contain balances, limits, transaction volume, activity, relationship tier,
// or any other internal account information.
//
// Follows the shared MCC house style (see lib/pdf-core.ts) so it sits visually
// alongside statements, receipts, certificates and instrument documents.

import { jsPDF } from "jspdf"
import { BRAND, makeDocRef, type GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface AccountDetailsData {
  /** The beneficiary / account holder name funds should be paid to. */
  accountName: string
  /** The beneficiary bank. */
  bankName: string
  country: string
  currency: string
  accountNumber: string
  iban: string
  swift: string
  sortCode?: string
  routingNumber?: string
  bsb?: string
  branchCode?: string
  branchAddress: string
}

export function generateAccountDetailsPdf(data: AccountDetailsData): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  const contentWidth = pageWidth - margin * 2
  const reference = makeDocRef("MCC-PAY")

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
  doc.text("PAYMENT INSTRUCTIONS", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Ref: ${reference}`, pageWidth - margin, 64, { align: "right" })

  // ---- Purpose line ------------------------------------------------------
  let y = 132
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(16)
  doc.text("Remittance Details", margin, y)

  y += 16
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9.5)
  doc.setTextColor(...BRAND.slate)
  const intro = doc.splitTextToSize(
    "Use the beneficiary and banking coordinates below to remit funds into this account. " +
      "Please quote the reference above with your payment. No other account information is disclosed.",
    contentWidth,
  ) as string[]
  doc.text(intro, margin, y)
  y += intro.length * 12 + 6

  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Section table helper ----------------------------------------------
  const section = (title: string, rows: Array<[string, string]>) => {
    const visible = rows.filter(([, v]) => v && v !== "—" && v !== "")
    if (visible.length === 0) return
    y += 26
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(...BRAND.ink)
    doc.text(title, margin, y)
    y += 6
    visible.forEach((row, i) => {
      const rowY = y + 12 + i * 26
      if (i % 2 === 0) {
        doc.setFillColor(...BRAND.light)
        doc.rect(margin, rowY - 5, contentWidth, 26, "F")
      }
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9.5)
      doc.setTextColor(...BRAND.slate)
      doc.text(row[0], margin + 12, rowY + 12)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(10.5)
      doc.setTextColor(...BRAND.ink)
      doc.text(row[1], pageWidth - margin - 12, rowY + 12, { align: "right" })
    })
    y = y + 12 + visible.length * 26
  }

  section("Beneficiary", [
    ["Beneficiary Name", data.accountName],
    ["Beneficiary Bank", data.bankName],
    ["Bank Country", data.country],
    ["Bank Address", data.branchAddress],
  ])

  section("Banking Coordinates", [
    ["Currency", data.currency],
    ["Account Number", data.accountNumber],
    ["IBAN", data.iban],
    ["SWIFT / BIC", data.swift],
    ["Sort Code", data.sortCode ?? ""],
    ["Routing Number (ABA)", data.routingNumber ?? ""],
    ["BSB", data.bsb ?? ""],
    ["Branch Code", data.branchCode ?? ""],
  ])

  // ---- Footer ------------------------------------------------------------
  const footerY = pageHeight - 70
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  doc.text(
    "This document provides payment routing details only and is valid without signature.",
    margin,
    footerY + 16,
  )
  doc.text(`${BRAND.name}  ·  ${BRAND.address}  ·  ${BRAND.email}`, margin, footerY + 30)
  doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, pageWidth - margin, footerY + 30, {
    align: "right",
  })

  return {
    doc,
    filename: `MCC-Payment-Instructions-${(data.accountNumber || reference).replace(/\s+/g, "")}.pdf`,
    title: "Payment Instructions",
  }
}
