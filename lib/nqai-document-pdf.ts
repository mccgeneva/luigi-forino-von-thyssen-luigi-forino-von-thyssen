// Generates a branded MCC Capital PDF from a document NQAi has authored. The
// model returns a title + Markdown body (via the createDocument tool); this
// renderer turns that into a professional, multi-page PDF using the shared
// house style (lib/pdf-core) so NQAi's documents look like every other export.
//
// Runs in the browser (jsPDF), consistent with the other PDF generators, and
// is opened through the shared PDF viewer for preview + download.

import { jsPDF } from "jspdf"
import { BRAND, formatDateTime, makeDocRef, type GeneratedPdf } from "@/lib/pdf-core"
import { BRAND_LABELS, drawBrandMark, pickPdfBrand, type PdfBrand } from "@/lib/pdf-logos"

interface NqaiDocInput {
  title: string
  markdown: string
  /** Signed-in client name, shown on the cover ("Prepared for"). */
  clientName?: string
  /** Which brand mark to stamp. When omitted it is inferred from the content. */
  brand?: PdfBrand
}

// Strip inline Markdown emphasis markers we don't render as styled runs, so the
// text reads cleanly (we render whole-line emphasis via font weight instead).
function cleanInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim()
}

export function generateNqaiDocumentPdf({ title, markdown, clientName, brand }: NqaiDocInput): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 56
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - 70
  const docRef = makeDocRef("NQAI-DOC")
  const cleanTitle = (title || "NQAi Document").trim()
  const activeBrand: PdfBrand = brand ?? pickPdfBrand(title, markdown)
  const label = BRAND_LABELS[activeBrand]

  let y = 0
  let pageNo = 0

  const drawFooter = () => {
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, bottomLimit + 16, pageWidth - margin, bottomLimit + 16)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(...BRAND.slate)
    doc.text(`${label.name} · Prepared by NQAi · ${docRef}`, margin, bottomLimit + 32)
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 32, { align: "right" })
  }

  const drawContentHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 44, "F")
    const markW = drawBrandMark(doc, activeBrand, margin, 10, 60, 24, { panel: true, radius: 4 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text(label.name, margin + markW + 10, 26)
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text("NQAi · Document", pageWidth - margin, 26, { align: "right" })
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

  const addParagraph = (text: string, opts?: { color?: [number, number, number]; size?: number; bold?: boolean }) => {
    if (!text) {
      y += 6
      return
    }
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal")
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

  const addBullet = (text: string, ordered?: string) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10.5)
    doc.setTextColor(...BRAND.ink)
    const indent = ordered ? 22 : 16
    const lines = doc.splitTextToSize(text, contentWidth - indent) as string[]
    const lineHeight = 15
    lines.forEach((ln, i) => {
      ensureSpace(lineHeight)
      if (i === 0) {
        if (ordered) {
          doc.setFont("helvetica", "bold")
          doc.setTextColor(...BRAND.gold)
          doc.text(ordered, margin, y)
          doc.setFont("helvetica", "normal")
          doc.setTextColor(...BRAND.ink)
        } else {
          doc.setFillColor(...BRAND.gold)
          doc.circle(margin + 3, y - 3.5, 2, "F")
        }
      }
      doc.text(ln, margin + indent, y)
      y += lineHeight
    })
    y += 3
  }

  const addHeading = (text: string, level: number) => {
    ensureSpace(34)
    y += level <= 2 ? 8 : 4
    doc.setFont("helvetica", "bold")
    doc.setFontSize(level <= 1 ? 15 : level === 2 ? 13 : 11.5)
    doc.setTextColor(...BRAND.ink)
    const lines = doc.splitTextToSize(text, contentWidth) as string[]
    lines.forEach((ln) => {
      ensureSpace(20)
      doc.text(ln, margin, y)
      y += level <= 2 ? 20 : 17
    })
    if (level <= 2) {
      doc.setDrawColor(...BRAND.gold)
      doc.setLineWidth(1.5)
      doc.line(margin, y - 6, margin + 28, y - 6)
      y += 8
    } else {
      y += 4
    }
  }

  const addTableRow = (cells: string[], header: boolean) => {
    const colW = contentWidth / cells.length
    const lineHeight = 14
    // Measure tallest cell
    const wrapped = cells.map((c) => doc.splitTextToSize(cleanInline(c), colW - 8) as string[])
    const rowLines = Math.max(1, ...wrapped.map((w) => w.length))
    const rowH = rowLines * lineHeight + 6
    ensureSpace(rowH)
    if (header) {
      doc.setFillColor(...BRAND.light)
      doc.rect(margin, y - 11, contentWidth, rowH, "F")
    }
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(0.5)
    doc.rect(margin, y - 11, contentWidth, rowH)
    doc.setFont("helvetica", header ? "bold" : "normal")
    doc.setFontSize(9.5)
    doc.setTextColor(...(header ? BRAND.ink : BRAND.slate))
    cells.forEach((_, ci) => {
      const cx = margin + ci * colW + 4
      if (ci > 0) {
        doc.setDrawColor(...BRAND.line)
        doc.line(margin + ci * colW, y - 11, margin + ci * colW, y - 11 + rowH)
      }
      wrapped[ci].forEach((ln, li) => {
        doc.text(ln, cx, y + li * lineHeight)
      })
    })
    y += rowH
  }

  // ===== Cover =====
  pageNo = 1
  doc.setFillColor(...BRAND.ink)
  doc.rect(0, 0, pageWidth, pageHeight, "F")
  // Context brand mark on a clean white card.
  drawBrandMark(doc, activeBrand, margin, 138, 210, 92, { panel: true, radius: 10 })

  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(label.name, margin, 268)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text(label.tagline, margin, 285)
  doc.text(BRAND.address, margin, 300)

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("NQAi — INTELLIGENCE DOCUMENT", margin, 380)
  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(30)
  const titleLines = doc.splitTextToSize(cleanTitle, contentWidth) as string[]
  let ty = 426
  titleLines.slice(0, 4).forEach((ln) => {
    doc.text(ln, margin, ty)
    ty += 38
  })

  doc.setDrawColor(80, 82, 86)
  doc.setLineWidth(1)
  doc.line(margin, pageHeight - 170, pageWidth - margin, pageHeight - 170)
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text(docRef, margin, pageHeight - 144)
  doc.setTextColor(200, 202, 206)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Generated ${formatDateTime(new Date())}`, margin, pageHeight - 128)
  if (clientName) doc.text(`Prepared for: ${clientName}`, margin, pageHeight - 112)
  doc.setTextColor(150, 152, 156)
  doc.setFontSize(8)
  doc.text(
    "Indicative analysis prepared by NQAi. Confirm firm pricing and terms with the desk before execution.",
    margin,
    pageHeight - 84,
    { maxWidth: contentWidth },
  )

  // ===== Body =====
  newContentPage()

  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n")
  let tableBuffer: string[][] = []
  let tableHeaderSeen = false

  const flushTable = () => {
    if (!tableBuffer.length) return
    tableBuffer.forEach((row, i) => addTableRow(row, i === 0))
    y += 8
    tableBuffer = []
    tableHeaderSeen = false
  }

  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
  const isTableDivider = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-")

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    if (isTableRow(line)) {
      if (isTableDivider(line) && tableBuffer.length) {
        tableHeaderSeen = true
        continue
      }
      const cells = line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim())
      tableBuffer.push(cells)
      void tableHeaderSeen
      continue
    } else if (tableBuffer.length) {
      flushTable()
    }

    const trimmed = line.trim()
    if (!trimmed) {
      y += 4
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      addHeading(cleanInline(heading[2]), heading[1].length)
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      addBullet(cleanInline(bullet[1]))
      continue
    }

    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (ordered) {
      addBullet(cleanInline(ordered[2]), `${ordered[1]}.`)
      continue
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      ensureSpace(14)
      doc.setDrawColor(...BRAND.line)
      doc.setLineWidth(1)
      doc.line(margin, y, pageWidth - margin, y)
      y += 12
      continue
    }

    // Quote
    const quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote) {
      addParagraph(cleanInline(quote[1]), { color: BRAND.slate })
      continue
    }

    addParagraph(cleanInline(trimmed))
  }
  flushTable()

  const safeFile = cleanTitle.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60) || "NQAi-Document"
  return { doc, filename: `${safeFile}.pdf`, title: cleanTitle }
}
