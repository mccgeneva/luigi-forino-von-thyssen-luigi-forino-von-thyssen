import { jsPDF } from "jspdf"

// Reproduces ONLY the account-particulars block rendering from
// lib/certificate-pdf.ts (generateAccountCertificate) so we can visually verify
// the label/value layout without the browser-only logo pipeline.
const BRAND = {
  ink: [17, 17, 17],
  slate: [110, 116, 128],
}
const doc = new jsPDF({ unit: "pt", format: "a4" })
const pageWidth = doc.internal.pageSize.getWidth()
const margin = 48
const contentWidth = pageWidth - margin * 2

const rows = [
  ["Account Holder", "MCC Petroli Company Inc"],
  ["Settlement Bank", "MCC Capital"],
  ["Account", "Master Account — All Currencies"],
  ["Platform Operator", "NAFTAhub plc"],
]

let y = 120
doc.setFontSize(9.5)
const valueX = pageWidth - margin - 12
rows.forEach((row, i) => {
  const rowY = y + i * 20
  if (i % 2 === 0) {
    doc.setFillColor(250, 250, 251)
    doc.rect(margin, rowY - 13, contentWidth, 20, "F")
  }
  doc.setFont("helvetica", "bold")
  doc.setTextColor(...BRAND.ink)
  doc.text(row[1], valueX, rowY, { align: "right" })
  const valueWidth = doc.getTextWidth(row[1])
  doc.setFont("helvetica", "normal")
  doc.setTextColor(...BRAND.slate)
  doc.text(`${row[0]}:`, valueX - valueWidth - 10, rowY, { align: "right" })
})

const buf = Buffer.from(doc.output("arraybuffer"))
const fs = await import("node:fs")
fs.writeFileSync("/tmp/cert-block.pdf", buf)
console.log("[v0] wrote /tmp/cert-block.pdf", buf.length, "bytes; pageWidth", pageWidth)
