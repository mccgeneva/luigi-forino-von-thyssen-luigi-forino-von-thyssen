// Generates the platform Terms of Use & User Agreement as a professional,
// multi-page PDF entirely in the browser using jsPDF. Shares its content with
// the on-screen terms page via lib/terms-content.ts so the two never drift.
//
// Follows the house style used by the handbook generator (brand band, gold
// mark, Geneva footer) and RETURNS a GeneratedPdf so the caller previews it in
// the shared PDF viewer, which offers Download / Print / Open-in-tab.

import { jsPDF } from "jspdf"
import type { GeneratedPdf } from "@/lib/pdf-core"
import { TERMS_META, TERMS_SECTIONS, type TermsSection } from "./terms-content"
import { drawBrandMark } from "@/lib/pdf-logos"

const BRAND = {
  gold: [245, 140, 0] as [number, number, number],
  ink: [17, 17, 17] as [number, number, number],
  slate: [110, 116, 128] as [number, number, number],
  line: [225, 227, 231] as [number, number, number],
  light: [248, 249, 250] as [number, number, number],
  white: [255, 255, 255] as [number, number, number],
}

export function generateTermsPdf(): GeneratedPdf {
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
    doc.text(`${TERMS_META.brand} · ${TERMS_META.title}`, margin, bottomLimit + 32)
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 32, { align: "right" })
  }

  const drawContentHeader = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 44, "F")
    const markW = drawBrandMark(doc, "capital", margin, 10, 60, 24, { panel: true, radius: 4 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text(TERMS_META.brand, margin + markW + 10, 26)
    doc.setTextColor(190, 192, 196)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.text(TERMS_META.title, pageWidth - margin, 26, { align: "right" })
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

  const addSectionTitle = (section: TermsSection) => {
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

  drawBrandMark(doc, "capital", margin, 138, 210, 92, { panel: true, radius: 10 })

  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text(TERMS_META.brand, margin, 252)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.text(TERMS_META.address, margin, 270)

  doc.setTextColor(...BRAND.gold)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(13)
  doc.text("TERMS OF USE", margin, 380)
  doc.setTextColor(...BRAND.white)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(38)
  doc.text("Platform Terms", margin, 430)
  doc.text("& User Agreement", margin, 474)

  doc.setTextColor(200, 202, 206)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(12)
  const subLines = doc.splitTextToSize(TERMS_META.subtitle, contentWidth) as string[]
  let cy = 518
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
  doc.text(`${TERMS_META.version}  ·  ${TERMS_META.lastUpdated}`, margin, pageHeight - 124)
  doc.setTextColor(190, 192, 196)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`${TERMS_META.legalEntity}  ·  ${TERMS_META.email}`, margin, pageHeight - 108)

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

  TERMS_SECTIONS.forEach((section) => {
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
  TERMS_SECTIONS.forEach((section) => {
    addSectionTitle(section)
    section.subsections.forEach((sub) => {
      addSubheading(sub.heading)
      sub.paragraphs?.forEach((p) => addParagraph(p))
      sub.bullets?.forEach((b) => addBullet(b))
      y += 6
    })
  })

  return { doc, filename: "MCC-Capital-Terms-of-Use.pdf", title: "Terms of Use & User Agreement" }
}
