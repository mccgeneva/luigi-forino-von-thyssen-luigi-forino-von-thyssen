// Professional, paginated table PDF generator for the dashboard's list exports
// (transactions, payments, beneficiaries, instruments, SWIFT log, SKR registry,
// etc.). Uses jspdf-autotable for clean pagination and shares the MCC house
// style (dark brand band, gold mark, Geneva footer) defined in lib/pdf-core.ts.
//
// Returns the jsPDF document so callers can preview it in-browser and then
// download or print it via the shared PDF viewer.

import { jsPDF } from "jspdf"
import autoTable from "jspdf-autotable"
import { BRAND, formatDateTime, makeDocRef, type PdfDoc } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface TableColumn {
  /** Object key to read from each row. */
  key: string
  /** Column header label. */
  header: string
  /** Text alignment for body + header cells. */
  align?: "left" | "right" | "center"
  /** Optional fixed column width in points. */
  width?: number
}

export interface TablePdfMeta {
  label: string
  value: string
}

export interface TablePdfInput {
  /** Document title, e.g. "Transaction History". */
  title: string
  /** Short prefix for the document reference, e.g. "TXN". */
  refPrefix: string
  /** Account holder / entity the export belongs to (shown in the meta block). */
  holderName?: string
  holderCompany?: string
  /** Extra key/value rows shown beneath the title (period, filters, totals…). */
  meta?: TablePdfMeta[]
  /** Optional heading printed directly above the table (e.g. "Transaction History"). */
  sectionTitle?: string
  columns: TableColumn[]
  rows: Record<string, unknown>[]
  /** Message shown in place of the table when there are no rows. */
  emptyMessage?: string
  /** Optional note printed under the table (e.g. disclaimer). */
  footNote?: string
}

/**
 * Build a branded, multi-page table PDF and return the jsPDF document.
 */
export function generateTablePdf(input: TablePdfInput): PdfDoc {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 40
  const docRef = makeDocRef(`MCC-${input.refPrefix}`)
  const generatedAt = formatDateTime(new Date())

  // --- Header band (drawn on every page via autotable's didDrawPage) --------
  const drawHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 78, "F")
    drawBrandMark(doc, "capital", margin, 22, 30, 30, { panel: true, radius: 6 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(14)
    doc.text(BRAND.name, margin + 42, 38)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(190, 192, 196)
    doc.text(BRAND.tagline, margin + 42, 51)
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(12)
    doc.text(input.title.toUpperCase(), pageWidth - margin, 38, { align: "right" })
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text(`No. ${docRef}`, pageWidth - margin, 51, { align: "right" })
  }

  // --- Footer (drawn on every page) -----------------------------------------
  const drawFooter = (pageNumber: number) => {
    const fy = pageHeight - 30
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, fy - 8, pageWidth - margin, fy - 8)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(`${BRAND.name}  ·  ${BRAND.address}`, margin, fy + 2)
    doc.text(`Generated ${generatedAt}`, margin, fy + 12)
    doc.text(`Page ${pageNumber}`, pageWidth - margin, fy + 12, { align: "right" })
    doc.text("Electronically generated — valid without signature.", pageWidth - margin, fy + 2, {
      align: "right",
    })
  }

  // --- Meta block (only on the first page, before the table) ----------------
  // We compute its height so the table starts below it on page 1.
  const metaLines: string[] = []
  if (input.holderName) metaLines.push(input.holderName)
  if (input.holderCompany) metaLines.push(input.holderCompany)
  const metaPairs = input.meta ?? []
  const sectionTitleHeight = input.sectionTitle ? 22 : 0
  const firstPageTableTop = 78 + 20 + 18 + metaLines.length * 13 + metaPairs.length * 13 + 16 + sectionTitleHeight

  const drawMetaBlock = () => {
    let y = 78 + 26
    if (input.holderName || metaPairs.length || input.holderCompany) {
      doc.setTextColor(...BRAND.gold)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(8)
      doc.text("PREPARED FOR", margin, y)
      y += 14
    }
    doc.setTextColor(...BRAND.ink)
    metaLines.forEach((line, i) => {
      doc.setFont("helvetica", i === 0 ? "bold" : "normal")
      doc.setFontSize(i === 0 ? 11 : 9)
      doc.setTextColor(i === 0 ? BRAND.ink[0] : BRAND.slate[0], i === 0 ? BRAND.ink[1] : BRAND.slate[1], i === 0 ? BRAND.ink[2] : BRAND.slate[2])
      doc.text(line, margin, y)
      y += 13
    })
    metaPairs.forEach((pair) => {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9)
      doc.setTextColor(...BRAND.slate)
      doc.text(`${pair.label}:`, margin, y)
      doc.setFont("helvetica", "bold")
      doc.setTextColor(...BRAND.ink)
      doc.text(pair.value, margin + 150, y)
      y += 13
    })
    if (input.sectionTitle) {
      y += 8
      doc.setFont("helvetica", "bold")
      doc.setFontSize(10)
      doc.setTextColor(...BRAND.ink)
      doc.text(input.sectionTitle, margin, y)
    }
  }

  const head = [input.columns.map((c) => c.header)]
  const body = input.rows.map((row) =>
    input.columns.map((c) => {
      const v = row[c.key]
      return v === null || v === undefined ? "" : String(v)
    }),
  )

  const columnStyles: Record<number, { halign?: "left" | "right" | "center"; cellWidth?: number }> = {}
  input.columns.forEach((c, i) => {
    columnStyles[i] = {}
    if (c.align) columnStyles[i].halign = c.align
    if (c.width) columnStyles[i].cellWidth = c.width
  })

  autoTable(doc, {
    head,
    body: body.length > 0 ? body : [[{ content: input.emptyMessage ?? "No records to display.", colSpan: input.columns.length, styles: { halign: "center", textColor: BRAND.slate, fontStyle: "italic" } } as never]],
    startY: firstPageTableTop,
    margin: { top: 96, left: margin, right: margin, bottom: 46 },
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: { top: 5, bottom: 5, left: 6, right: 6 },
      textColor: BRAND.ink,
      lineColor: BRAND.line,
      lineWidth: 0.5,
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: BRAND.ink,
      textColor: BRAND.white,
      fontStyle: "bold",
      fontSize: 8.5,
      cellPadding: { top: 6, bottom: 6, left: 6, right: 6 },
    },
    alternateRowStyles: { fillColor: BRAND.light },
    columnStyles,
    didDrawPage: (data) => {
      drawHeader()
      if (data.pageNumber === 1) drawMetaBlock()
      drawFooter(data.pageNumber)
    },
  })

  // Optional foot note under the table on the last page.
  if (input.footNote) {
    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? firstPageTableTop
    if (finalY < pageHeight - 70) {
      doc.setFont("helvetica", "italic")
      doc.setFontSize(8)
      doc.setTextColor(...BRAND.slate)
      const wrapped = doc.splitTextToSize(input.footNote, pageWidth - margin * 2)
      doc.text(wrapped, margin, finalY + 18)
    }
  }

  return doc
}

/** Convenience: the standard filename for a table export. */
export function tablePdfFilename(title: string): string {
  const slug = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")
  const stamp = new Date().toISOString().slice(0, 10)
  return `MCC-${slug}-${stamp}.pdf`
}
