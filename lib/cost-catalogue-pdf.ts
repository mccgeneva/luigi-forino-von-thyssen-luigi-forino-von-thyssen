// Generates the platform "Terms & Costs" complete fee catalogue as a
// professional, multi-page PDF entirely in the browser using jsPDF. Shares its
// content with the on-screen page via lib/cost-catalogue.ts so the two never
// drift. Follows the house style of the Terms of Use generator (brand band,
// gold mark, Geneva footer) and RETURNS a GeneratedPdf so the caller previews
// it in the shared PDF viewer (Download / Print / Open-in-tab).

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"
import {
  COST_CATALOGUE_META,
  COST_CATALOGUE_REVISIONS,
  COST_SECTIONS,
  LEVERAGE_RATE_LADDER,
  type CostSection,
} from "@/lib/cost-catalogue"

const BRAND = {
  gold: [245, 140, 0] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [225, 227, 231] as [number, number, number],
  light: [248, 249, 250] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
}

export function generateCostCataloguePdf(): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 56
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - 70

  let y = 0
  let pageNo = 0

  const drawFooter = () => {
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, bottomLimit + 16, pageWidth - margin, bottomLimit + 16)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(...BRAND.slate)
    doc.text(`${COST_CATALOGUE_META.brand} · ${COST_CATALOGUE_META.title}`, margin, bottomLimit + 32)
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 32, { align: "right" })
  }

  const drawContentHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 44, "F")
    const markW = drawBrandMark(doc, "capital", margin, 10, 60, 24, { panel: true, radius: 4 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text(COST_CATALOGUE_META.brand, margin + markW + 10, 26)
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text("Terms & Costs", pageWidth - margin, 26, { align: "right" })
  }

  const newContentPage = () => {
    doc.addPage()
    pageNo += 1
    drawContentHeader()
    drawFooter()
    y = 72
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > bottomLimit) newContentPage()
  }

  const addParagraph = (text: string, opts?: { color?: [number, number, number]; size?: number }) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(opts?.size ?? 10.5)
    doc.setTextColor(...(opts?.color ?? BRAND.ink))
    const lines = doc.splitTextToSize(text, contentWidth) as string[]
    const lineHeight = 15
    lines.forEach((ln) => {
      ensureSpace(lineHeight)
      doc.text(ln, margin, y)
      y += lineHeight
    })
    y += 6
  }

  // Three-column fee table: Item | Fee | When it applies.
  const col1 = contentWidth * 0.3 // Item
  const col2 = contentWidth * 0.24 // Fee
  const col3 = contentWidth * 0.46 // When
  const x1 = margin
  const x2 = margin + col1 + 8
  const x3 = margin + col1 + col2 + 16
  const cellPadX = 6
  const rowPadY = 8
  const lineH = 12

  const drawTableHeader = () => {
    ensureSpace(26)
    doc.setFillColor(...BRAND.ink)
    doc.rect(margin, y, contentWidth, 22, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.white)
    doc.text("FEE / CHARGE", x1 + cellPadX, y + 15)
    doc.text("RATE / AMOUNT", x2 + cellPadX, y + 15)
    doc.text("WHEN IT APPLIES", x3 + cellPadX, y + 15)
    y += 22
  }

  const addTableRow = (item: string, fee: string, when: string, zebra: boolean) => {
    doc.setFontSize(9.5)
    const itemLines = doc.splitTextToSize(item, col1 - cellPadX * 2) as string[]
    const feeLines = doc.splitTextToSize(fee, col2 - cellPadX * 2) as string[]
    const whenLines = doc.splitTextToSize(when, col3 - cellPadX * 2) as string[]
    const rows = Math.max(itemLines.length, feeLines.length, whenLines.length)
    const rowH = rows * lineH + rowPadY * 2

    // Page-break the whole row together; redraw the table header on the new page.
    if (y + rowH > bottomLimit) {
      newContentPage()
      drawTableHeader()
    }

    if (zebra) {
      doc.setFillColor(...BRAND.light)
      doc.rect(margin, y, contentWidth, rowH, "F")
    }

    let ty = y + rowPadY + 9
    doc.setTextColor(...BRAND.ink)
    doc.setFont("helvetica", "bold")
    itemLines.forEach((ln, i) => doc.text(ln, x1 + cellPadX, ty + i * lineH))
    doc.setFont("helvetica", "bold")
    doc.setTextColor(...BRAND.gold)
    feeLines.forEach((ln, i) => doc.text(ln, x2 + cellPadX, ty + i * lineH))
    doc.setFont("helvetica", "normal")
    doc.setTextColor(...BRAND.slate)
    whenLines.forEach((ln, i) => doc.text(ln, x3 + cellPadX, ty + i * lineH))

    y += rowH
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(0.5)
    doc.line(margin, y, pageWidth - margin, y)
  }

  const addSectionTitle = (section: CostSection) => {
    newContentPage()
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.text(`SECTION ${section.number}`, margin, y)
    y += 24
    doc.setTextColor(...BRAND.ink)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(20)
    const titleLines = doc.splitTextToSize(section.title, contentWidth) as string[]
    titleLines.forEach((ln) => {
      doc.text(ln, margin, y)
      y += 24
    })
    y += 2
    if (section.intro) addParagraph(section.intro, { color: BRAND.slate, size: 10.5 })
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, y, pageWidth - margin, y)
    y += 14
  }

  // ===== Cover page ======================================================
  pageNo = 1
  doc.setFillColor(...BRAND.ink)
  doc.rect(0, 0, pageWidth, pageHeight, "F")

  drawBrandMark(doc, "capital", margin, 138, 210, 92, { panel: true, radius: 10 })

  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(COST_CATALOGUE_META.brand, margin, 252)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text(COST_CATALOGUE_META.address, margin, 270)

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("TERMS & COSTS", margin, 380)
  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(34)
  doc.text("Complete Fee", margin, 428)
  doc.text("Catalogue", margin, 466)

  doc.setTextColor(200, 202, 206)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(12)
  const subLines = doc.splitTextToSize(COST_CATALOGUE_META.subtitle, contentWidth) as string[]
  let cy = 508
  subLines.forEach((ln) => {
    doc.text(ln, margin, cy)
    cy += 18
  })

  doc.setDrawColor(80, 82, 86)
  doc.setLineWidth(1)
  doc.line(margin, pageHeight - 150, pageWidth - margin, pageHeight - 150)
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text(`${COST_CATALOGUE_META.version}  ·  Effective ${COST_CATALOGUE_META.effectiveDate}`, margin, pageHeight - 124)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`${COST_CATALOGUE_META.legalEntity}  ·  ${COST_CATALOGUE_META.email}`, margin, pageHeight - 108)

  // ===== Contents ========================================================
  newContentPage()
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text("Contents", margin, y)
  y += 12
  doc.setDrawColor(...BRAND.gold)
  doc.setLineWidth(1.5)
  doc.line(margin, y, margin + 28, y)
  y += 24

  COST_SECTIONS.forEach((section) => {
    ensureSpace(26)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(...BRAND.gold)
    doc.text(section.number, margin, y)
    doc.setTextColor(...BRAND.ink)
    doc.text(section.title, margin + 34, y)
    y += 8
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(0.5)
    doc.line(margin + 34, y, pageWidth - margin, y)
    y += 18
  })

  // ===== Sections ========================================================
  COST_SECTIONS.forEach((section) => {
    addSectionTitle(section)
    drawTableHeader()
    section.rows.forEach((row, i) => addTableRow(row.item, row.fee, row.when, i % 2 === 1))
    y += 10
    if (section.note) addParagraph(section.note, { color: BRAND.slate, size: 9.5 })

    // Detailed leverage ladder under the leverage section.
    if (section.id === "leverage") {
      y += 6
      ensureSpace(30)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(11)
      doc.setTextColor(...BRAND.ink)
      doc.text("Leverage debit-interest ladder (annual)", margin, y)
      y += 16
      LEVERAGE_RATE_LADDER.forEach((r, i) => {
        ensureSpace(18)
        if (i % 2 === 1) {
          doc.setFillColor(...BRAND.light)
          doc.rect(margin, y - 12, contentWidth, 18, "F")
        }
        doc.setFont("helvetica", "bold")
        doc.setFontSize(10)
        doc.setTextColor(...BRAND.ink)
        doc.text(r.ratio, margin + 6, y)
        doc.setTextColor(...BRAND.gold)
        doc.text(r.rate, margin + 120, y)
        y += 18
      })
    }
  })

  // ===== Revision history (versioning / audit trail) =====================
  newContentPage()
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.text("APPENDIX", margin, y)
  y += 24
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.text("Revision History", margin, y)
  y += 24
  addParagraph(
    "Each published version of this cost catalogue is recorded below so historical fee schedules remain available for reference.",
    { color: BRAND.slate, size: 10.5 },
  )
  doc.setDrawColor(...BRAND.line)
  doc.setLineWidth(1)
  doc.line(margin, y, pageWidth - margin, y)
  y += 16
  COST_CATALOGUE_REVISIONS.forEach((rev) => {
    ensureSpace(30)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(...BRAND.ink)
    doc.text(`${rev.version}`, margin, y)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(...BRAND.slate)
    doc.text(rev.date, pageWidth - margin, y, { align: "right" })
    y += 16
    addParagraph(rev.summary, { color: BRAND.slate, size: 10 })
    y += 4
  })

  return {
    doc,
    filename: "MCC-Capital-Terms-and-Costs.pdf",
    title: "Terms & Costs — Complete Fee Catalogue",
  }
}
