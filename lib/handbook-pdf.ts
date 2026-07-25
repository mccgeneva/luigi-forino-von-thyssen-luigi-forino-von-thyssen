// Generates a professional, multi-page MCC Capital Client Handbook PDF entirely
// in the browser using jsPDF. Shares its content with the on-screen handbook
// page via lib/handbook-content.ts so the two never drift apart.

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import {
  HANDBOOK_META,
  HANDBOOK_SECTIONS,
  type HandbookExample,
  type HandbookSection,
} from "./handbook-content"
import { drawBrandMark } from "@/lib/pdf-logos"

// A preloaded screenshot, keyed by its /public path. Loaded by the caller
// (the handbook page) before generation because jsPDF's addImage is synchronous
// and needs pixel data + intrinsic dimensions up front.
export interface LoadedImage {
  dataUrl: string
  width: number
  height: number
}
export type HandbookImageMap = Record<string, LoadedImage>

const BRAND = {
  gold: [245, 140, 0] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [225, 227, 231] as [number, number, number],
  light: [248, 249, 250] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
}

export function generateHandbookPdf(images: HandbookImageMap = {}): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 56
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - 70

  let y = 0
  let pageNo = 0

  // ---- Footer with page number (drawn on every content page) ------------
  const drawFooter = () => {
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, bottomLimit + 16, pageWidth - margin, bottomLimit + 16)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(...BRAND.slate)
    doc.text(`${HANDBOOK_META.brand} · ${HANDBOOK_META.title}`, margin, bottomLimit + 32)
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 32, { align: "right" })
  }

  // ---- Running header band on content pages -----------------------------
  const drawContentHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 44, "F")
    const markW = drawBrandMark(doc, "capital", margin, 10, 60, 24, { panel: true, radius: 4 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text(HANDBOOK_META.brand, margin + markW + 10, 26)
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text(HANDBOOK_META.title, pageWidth - margin, 26, { align: "right" })
  }

  const newContentPage = () => {
    doc.addPage()
    pageNo += 1
    drawContentHeader()
    drawFooter()
    y = 72
  }

  // Ensure there's room for the next block; otherwise start a new page.
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

  const addBullet = (text: string) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10.5)
    doc.setTextColor(...BRAND.ink)
    const indent = 16
    const lines = doc.splitTextToSize(text, contentWidth - indent) as string[]
    const lineHeight = 15
    lines.forEach((ln, i) => {
      ensureSpace(lineHeight)
      if (i === 0) {
        doc.setFillColor(...BRAND.gold)
        doc.circle(margin + 3, y - 3.5, 2, "F")
      }
      doc.text(ln, margin + indent, y)
      y += lineHeight
    })
    y += 3
  }

  const addSubheading = (text: string) => {
    ensureSpace(34)
    y += 6
    doc.setFont("helvetica", "bold")
    doc.setFontSize(12)
    doc.setTextColor(...BRAND.ink)
    doc.text(text, margin, y)
    y += 8
    doc.setDrawColor(...BRAND.gold)
    doc.setLineWidth(1.5)
    doc.line(margin, y, margin + 28, y)
    y += 16
  }

  // Numbered step within a worked example (gold circle + wrapped text).
  const addNumberedStep = (n: number, text: string) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.setTextColor(...BRAND.ink)
    const indent = 22
    const lines = doc.splitTextToSize(text, contentWidth - indent - 8) as string[]
    const lineHeight = 14
    lines.forEach((ln, i) => {
      ensureSpace(lineHeight)
      if (i === 0) {
        doc.setFillColor(...BRAND.gold)
        doc.circle(margin + 6, y - 3.5, 7, "F")
        doc.setTextColor(...BRAND.white)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.text(String(n), margin + 6, y - 1, { align: "center" })
        doc.setFont("helvetica", "normal")
        doc.setFontSize(10)
        doc.setTextColor(...BRAND.ink)
      }
      doc.text(ln, margin + indent, y)
      y += lineHeight
    })
    y += 4
  }

  // A worked example: title strip, screenshot, caption, then numbered steps.
  const addExample = (ex: HandbookExample) => {
    const img = images[ex.image]
    y += 8

    // Title strip
    ensureSpace(26)
    doc.setFillColor(...BRAND.light)
    doc.rect(margin, y - 12, contentWidth, 22, "F")
    doc.setDrawColor(...BRAND.gold)
    doc.setLineWidth(2)
    doc.line(margin, y - 12, margin, y + 10)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.setTextColor(...BRAND.ink)
    doc.text(ex.title, margin + 10, y + 2)
    y += 20

    // Screenshot, scaled to content width, kept whole on one page.
    if (img) {
      const drawW = contentWidth
      const drawH = (img.height / img.width) * drawW
      if (y + drawH > bottomLimit) newContentPage()
      doc.setDrawColor(...BRAND.line)
      doc.setLineWidth(1)
      doc.rect(margin, y, drawW, drawH)
      try {
        doc.addImage(img.dataUrl, "PNG", margin, y, drawW, drawH, undefined, "FAST")
      } catch {
        // If an image fails to embed, skip it gracefully rather than breaking the PDF.
      }
      y += drawH + 6
    }

    // Caption
    doc.setFont("helvetica", "italic")
    doc.setFontSize(8.5)
    const capLines = doc.splitTextToSize(ex.caption, contentWidth) as string[]
    capLines.forEach((ln) => {
      ensureSpace(12)
      doc.setTextColor(...BRAND.slate)
      doc.text(ln, margin, y)
      y += 12
    })
    doc.setFont("helvetica", "normal")
    y += 6

    // Numbered steps
    ex.steps.forEach((step, i) => addNumberedStep(i + 1, step))
    y += 6
  }

  const addSectionTitle = (section: HandbookSection) => {
    // Section titles always begin near the top of a fresh page for clarity.
    newContentPage()
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.text(`SECTION ${section.number}`, margin, y)
    y += 26
    doc.setTextColor(...BRAND.ink)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(22)
    const titleLines = doc.splitTextToSize(section.title, contentWidth) as string[]
    titleLines.forEach((ln) => {
      doc.text(ln, margin, y)
      y += 26
    })
    y += 4
    if (section.intro) {
      addParagraph(section.intro, { color: BRAND.slate, size: 11 })
      y += 4
    }
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, y, pageWidth - margin, y)
    y += 20
  }

  // ===== Cover page ======================================================
  pageNo = 1
  doc.setFillColor(...BRAND.ink)
  doc.rect(0, 0, pageWidth, pageHeight, "F")

  // Brand logo mark on a clean white card
  drawBrandMark(doc, "capital", margin, 138, 210, 92, { panel: true, radius: 10 })

  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(HANDBOOK_META.brand, margin, 252)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text(HANDBOOK_META.address, margin, 270)

  // Title block
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("CLIENT HANDBOOK", margin, 380)
  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(40)
  doc.text("Complete", margin, 430)
  doc.text("User Guide", margin, 476)

  doc.setTextColor(200, 202, 206)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(12)
  const subLines = doc.splitTextToSize(HANDBOOK_META.subtitle, contentWidth) as string[]
  let cy = 520
  subLines.forEach((ln) => {
    doc.text(ln, margin, cy)
    cy += 18
  })

  // Bottom meta row
  doc.setDrawColor(80, 82, 86)
  doc.setLineWidth(1)
  doc.line(margin, pageHeight - 150, pageWidth - margin, pageHeight - 150)
  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.text(`${HANDBOOK_META.version}  ·  ${HANDBOOK_META.lastUpdated}`, margin, pageHeight - 124)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(
    `${HANDBOOK_META.legalEntity}  ·  ${HANDBOOK_META.email}`,
    margin,
    pageHeight - 108,
  )

  // ===== Table of contents ===============================================
  newContentPage()
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(22)
  doc.text("Contents", margin, y)
  y += 14
  doc.setDrawColor(...BRAND.gold)
  doc.setLineWidth(1.5)
  doc.line(margin, y, margin + 28, y)
  y += 26

  HANDBOOK_SECTIONS.forEach((section) => {
    ensureSpace(28)
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
  HANDBOOK_SECTIONS.forEach((section) => {
    addSectionTitle(section)
    section.subsections.forEach((sub) => {
      addSubheading(sub.heading)
      sub.paragraphs?.forEach((p) => addParagraph(p))
      sub.bullets?.forEach((b) => addBullet(b))
      sub.examples?.forEach((ex) => addExample(ex))
      y += 6
    })
  })

  return { doc, filename: "MCC-Capital-Client-Handbook.pdf", title: "Client Handbook" }
}
