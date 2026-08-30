// Generates a bank-style PDF "ROI & Payout Summary" for an active Yield / PPP
// program, entirely in the browser with jsPDF. Opened from the card's
// "ROI details" → "Download PDF" action so the client has a professional,
// detailed record of when their ROI reflects, how much, and whether it is
// immediately withdrawable or locked until maturity.

import { jsPDF } from "jspdf"
import { BRAND, money, formatDate, type GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"
import type { PppRoiInfo } from "@/lib/ppp-roi-info"

export interface PppRoiInfoPdfData {
  reference: string
  programName: string
  holderName?: string
  info: PppRoiInfo
}

export function generatePppRoiInfoPdf(data: PppRoiInfoPdfData): GeneratedPdf {
  const { info } = data
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
  doc.text("ROI & PAYOUT SUMMARY", pageWidth - margin, 48, { align: "right" })
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Ref: ${data.reference}`, pageWidth - margin, 64, { align: "right" })

  // ---- Headline: ROI to the client per period ---------------------------
  let y = 140
  doc.setTextColor(...BRAND.slate)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  const headlineLabel =
    info.periodUnit === "maturity"
      ? "ROI credited to you at maturity"
      : `ROI credited to you (${info.periodLabel})`
  doc.text(headlineLabel, margin, y)

  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(26)
  doc.text(money(info.clientPerPeriod, info.currency), margin, y + 30)

  // Withdrawable / locked pill (right aligned)
  const pillText = info.withdrawable ? "WITHDRAWABLE" : "LOCKED UNTIL MATURITY"
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9)
  const pillW = doc.getTextWidth(pillText) + 24
  const pillX = pageWidth - margin - pillW
  if (info.withdrawable) {
    doc.setFillColor(232, 245, 238)
    doc.roundedRect(pillX, y + 8, pillW, 22, 11, 11, "F")
    doc.setTextColor(...BRAND.green)
  } else {
    doc.setFillColor(253, 242, 232)
    doc.roundedRect(pillX, y + 8, pillW, 22, 11, 11, "F")
    doc.setTextColor(...BRAND.gold)
  }
  doc.text(pillText, pillX + pillW / 2, y + 23, { align: "center" })

  y += 56
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)

  // ---- Program header ----------------------------------------------------
  y += 26
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.text("PROGRAM", margin, y)
  y += 16
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text(data.programName, margin, y)
  y += 22

  // ---- Details table -----------------------------------------------------
  const rows: [string, string][] = [
    ...(data.holderName ? [["Account Holder", data.holderName] as [string, string]] : []),
    ["Invested Capital", money(info.amount, info.currency)],
    ["Expected Return", `${info.ratePct}% ${info.periodLabel}`],
    ["Payout Frequency", info.periodUnit === "maturity" ? "Single payout at maturity" : `Paid ${info.periodLabel}, in arrears`],
    ["Program Activated", formatDate(info.activation.toISOString())],
    ["First Payout", formatDate(info.firstPayout.toISOString())],
    ...(info.periodUnit !== "maturity"
      ? [["Next Payout", formatDate(info.nextPayout.toISOString())] as [string, string]]
      : []),
    ["Term Ends (Maturity)", formatDate(info.termEnd.toISOString())],
    ...(info.periodUnit !== "maturity"
      ? [["Payouts Over Term", `${info.periodsInTerm} (${info.periodsElapsed} matured so far)`] as [string, string]]
      : []),
    ["Gross ROI per Period", money(info.grossPerPeriod, info.currency)],
    ...(info.hasSplit
      ? ([
          ["Benefit Split", `${info.mccRatePct}% MCC HOLDING SA / ${info.clientRatePct}% you`],
          ["Your Share per Period", money(info.clientPerPeriod, info.currency)],
        ] as [string, string][])
      : ([["Your Share", "100% (funded from your own means)"]] as [string, string][])),
    ["Projected Total to You (Term)", money(info.totalClientProjected, info.currency)],
    ["Funding", info.cashFunded ? "Cash from Master Account" : `Pledged instrument${info.fundingInstrumentLabel ? ` — ${info.fundingInstrumentLabel}` : ""}`],
    [
      "Withdrawable?",
      info.withdrawable
        ? "Yes — each credit is immediately spendable"
        : `No — credited but locked until ${formatDate(info.termEnd.toISOString())}`,
    ],
  ]

  rows.forEach((row, i) => {
    const rowY = y + 12 + i * 23
    if (i % 2 === 0) {
      doc.setFillColor(248, 249, 250)
      doc.rect(margin, rowY - 4, contentWidth, 23, "F")
    }
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(row[0], margin + 12, rowY + 11)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(...BRAND.ink)
    const valLines = doc.splitTextToSize(row[1], contentWidth * 0.58)
    doc.text(valLines[0], pageWidth - margin - 12, rowY + 11, { align: "right" })
  })

  y = y + 12 + rows.length * 23 + 20

  // ---- How your ROI works narrative -------------------------------------
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text("How your ROI works", margin, y)
  y += 14

  const cycleSentence =
    info.periodUnit === "maturity"
      ? `Your ROI is paid as a single payout of ${money(info.clientPerPeriod, info.currency)} at maturity on ${formatDate(info.termEnd.toISOString())}.`
      : `Your ROI is paid ${info.periodLabel}, in arrears: the first credit of ${money(info.clientPerPeriod, info.currency)} posts on ${formatDate(info.firstPayout.toISOString())}, then every cycle until the program matures on ${formatDate(info.termEnd.toISOString())} — ${info.periodsInTerm} payouts in total.`
  const splitSentence = info.hasSplit
    ? ` Because this program is funded by an MCC HOLDING SA instrument, each gross payout of ${money(info.grossPerPeriod, info.currency)} is split ${info.mccRatePct}% to MCC HOLDING SA and ${info.clientRatePct}% to you.`
    : ` You keep 100% of the return as the program is funded from your own means.`
  const lockSentence = info.withdrawable
    ? ` Each credit lands on your Master Account and is immediately available to withdraw or spend.`
    : ` Because this program is funded with leveraged/borrowed money, each credit reflects on your Master Account but is LOCKED — not withdrawable — until the program matures on ${formatDate(info.termEnd.toISOString())}, when it unlocks automatically. Your invested capital is not returned until maturity or a completed early exit.`

  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...BRAND.slate)
  const narrative = doc.splitTextToSize(cycleSentence + splitSentence + lockSentence, contentWidth)
  doc.text(narrative, margin, y)
  y += narrative.length * 12 + 12

  // ---- Disclaimer --------------------------------------------------------
  doc.setFont("helvetica", "italic")
  doc.setFontSize(8.5)
  doc.setTextColor(...BRAND.slate)
  const disclaimer = doc.splitTextToSize(
    "Returns are projected, not guaranteed, and are distributed per the program schedule. Figures are computed from the program's stated rate, frequency and term and may differ from the final settled amounts.",
    contentWidth,
  )
  doc.text(disclaimer, margin, y)

  // ---- Footer ------------------------------------------------------------
  const pageHeight = doc.internal.pageSize.getHeight()
  const footerY = pageHeight - 64
  doc.setDrawColor(...BRAND.line)
  doc.line(margin, footerY, pageWidth - margin, footerY)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.slate)
  doc.text(
    "This document is an electronically generated ROI summary and is valid without signature.",
    margin,
    footerY + 16,
  )
  doc.text(`${BRAND.name}  ·  ${BRAND.address}  ·  ${BRAND.email}`, margin, footerY + 30)
  doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, pageWidth - margin, footerY + 30, {
    align: "right",
  })

  return {
    doc,
    filename: `MCC-ROI-Summary-${data.reference}.pdf`,
    title: "ROI & Payout Summary",
  }
}
