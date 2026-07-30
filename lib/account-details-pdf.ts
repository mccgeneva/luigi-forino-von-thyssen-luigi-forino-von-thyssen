// Generates a professional, Bloomberg-style PDF "Account Details" artifact for
// a single bank account, entirely in the browser using jsPDF. Wired to the
// "Export Details" action on the account detail page. Follows the shared MCC
// house style (see lib/pdf-core.ts) so it sits visually alongside statements,
// receipts, certificates and instrument documents.

import { jsPDF } from "jspdf"
import { BRAND, money, formatDate, formatDateTime, makeDocRef, type GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface AccountDetailsData {
  bankName: string
  bankLogo?: string
  country: string
  rating: string
  status: string
  accountName: string
  accountType: string
  accountNumber: string
  currency: string
  iban: string
  swift: string
  sortCode?: string
  routingNumber?: string
  bsb?: string
  branchCode?: string
  /** Resolved balance figures (already account-scoped by the caller). */
  total: number
  available: number
  reserved: number
  /** Label for the "total" tile — "Total Balance" or "Received Here". */
  totalLabel: string
  openDate: string
  lastActivity: string
  dailyLimit: number
  monthlyVolume: number
  relationship: string
  branchAddress: string
  /** True for a registered external account (adds an explanatory note). */
  isRegistered: boolean
}

export function generateAccountDetailsPdf(data: AccountDetailsData): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 48
  const contentWidth = pageWidth - margin * 2
  const reference = makeDocRef("MCC-ACC")

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
  doc.text("ACCOUNT DETAILS", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Ref: ${reference}`, pageWidth - margin, 64, { align: "right" })

  // ---- Account identity --------------------------------------------------
  let y = 136
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text(data.accountName || data.bankName, margin, y)

  y += 18
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.setTextColor(...BRAND.slate)
  doc.text(`${data.bankName}  ·  ${data.country}`, margin, y)

  // Status + rating pills (right aligned, on the identity row)
  const pill = (label: string, xRight: number, topY: number, accent: [number, number, number]) => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    const w = doc.getTextWidth(label) + 22
    const x = xRight - w
    doc.setFillColor(accent[0], accent[1], accent[2])
    // light tint background
    doc.setFillColor(Math.min(accent[0] + 210, 250), Math.min(accent[1] + 210, 250), Math.min(accent[2] + 210, 250))
    doc.roundedRect(x, topY, w, 20, 10, 10, "F")
    doc.setTextColor(...accent)
    doc.text(label, x + w / 2, topY + 13.5, { align: "center" })
    return x
  }
  const statusAccent = data.status.toLowerCase().includes("active") ? BRAND.green : BRAND.gold
  const statusX = pill(data.status.toUpperCase(), pageWidth - margin, 122, statusAccent)
  pill(data.rating.toUpperCase(), statusX - 8, 122, BRAND.slate)

  y += 20
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Balance summary tiles (Bloomberg-style) ---------------------------
  y += 24
  const gap = 14
  const tileW = (contentWidth - gap * 2) / 3
  const tileH = 74
  const tiles: Array<{ label: string; value: string; accent: [number, number, number] }> = [
    { label: data.totalLabel, value: money(data.total, data.currency), accent: BRAND.ink },
    { label: "Available", value: money(data.available, data.currency), accent: BRAND.green },
    { label: "Reserved", value: money(data.reserved, data.currency), accent: BRAND.gold },
  ]
  tiles.forEach((t, i) => {
    const x = margin + i * (tileW + gap)
    doc.setFillColor(...BRAND.light)
    doc.roundedRect(x, y, tileW, tileH, 8, 8, "F")
    doc.setDrawColor(...BRAND.line)
    doc.roundedRect(x, y, tileW, tileH, 8, 8, "S")
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(t.label.toUpperCase(), x + 14, y + 22)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(14)
    doc.setTextColor(...t.accent)
    const valLines = doc.splitTextToSize(t.value, tileW - 28) as string[]
    doc.text(valLines[0], x + 14, y + 48)
  })
  y += tileH + 8

  // ---- Section table helper ----------------------------------------------
  const section = (title: string, rows: Array<[string, string]>) => {
    const visible = rows.filter(([, v]) => v && v !== "—" && v !== "")
    if (visible.length === 0) return
    y += 24
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(...BRAND.ink)
    doc.text(title, margin, y)
    y += 6
    visible.forEach((row, i) => {
      const rowY = y + 12 + i * 24
      if (i % 2 === 0) {
        doc.setFillColor(...BRAND.light)
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
    y = y + 12 + visible.length * 24
  }

  section("Account Information", [
    ["Account Name", data.accountName],
    ["Account Type", data.accountType],
    ["Account Number", data.accountNumber],
    ["Currency", data.currency],
    ["Opened", formatDate(data.openDate)],
    ["Last Activity", formatDateTime(data.lastActivity)],
    ["Relationship Tier", data.relationship],
  ])

  section("Banking Coordinates", [
    ["IBAN", data.iban],
    ["SWIFT / BIC", data.swift],
    ["Sort Code", data.sortCode ?? ""],
    ["Routing Number (ABA)", data.routingNumber ?? ""],
    ["BSB", data.bsb ?? ""],
    ["Branch Code", data.branchCode ?? ""],
    ["Branch Address", data.branchAddress],
  ])

  section("Limits & Volume", [
    ["Daily Limit", data.dailyLimit > 0 ? money(data.dailyLimit, data.currency) : "Unlimited"],
    ["Monthly Volume", money(data.monthlyVolume, data.currency)],
  ])

  // Registered-account explanatory note
  if (data.isRegistered) {
    y += 20
    doc.setFillColor(255, 248, 235)
    const note = doc.splitTextToSize(
      "This is a registered external account. The balances above track funds received at this specific bank. " +
        `The same funds also settle into your ${data.currency} Settlement Account and are reflected in your master balance.`,
      contentWidth - 24,
    ) as string[]
    const noteH = note.length * 12 + 20
    doc.roundedRect(margin, y, contentWidth, noteH, 6, 6, "F")
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(note, margin + 12, y + 16)
    y += noteH
  }

  // ---- Footer ------------------------------------------------------------
  const footerY = pageHeight - 70
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  doc.text(
    "This document is an electronically generated account summary and is valid without signature.",
    margin,
    footerY + 16,
  )
  doc.text(`${BRAND.name}  ·  ${BRAND.address}  ·  ${BRAND.email}`, margin, footerY + 30)
  doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, pageWidth - margin, footerY + 30, {
    align: "right",
  })

  return {
    doc,
    filename: `MCC-Account-${(data.accountNumber || reference).replace(/\s+/g, "")}.pdf`,
    title: "Account Details",
  }
}
