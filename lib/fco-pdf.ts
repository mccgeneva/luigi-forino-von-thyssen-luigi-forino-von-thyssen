// Generates a professional FULL CORPORATE OFFER (FCO) PDF for a commodity deal,
// faithfully adopting the standard FCO template structure (7 sections + KYC
// list + key conditions + acceptance block).
//
// IMPORTANT — compliance guardrail: the transaction procedure (Section 4) and
// the key commercial conditions (Section 6) are HARDCODED from the approved
// template and are NOT editable. They enshrine that inspection and title
// transfer precede payment and that NO fee is payable by the buyer before
// inspection/title/delivery. An FCO that demanded an upfront buyer fee would be
// an advance-fee-fraud instrument; this generator never produces one.
//
// Runs in the browser (jsPDF) like every other PDF generator and is opened via
// the shared PDF viewer (usePdfViewer().show()).

import { jsPDF } from "jspdf"
import { BRAND, formatDate, makeDocRef, type GeneratedPdf } from "@/lib/pdf-core"
import { drawBrandMark } from "@/lib/pdf-logos"

export interface FcoInput {
  // Parties
  sellerName: string
  sellerAddress: string
  sellerEmail: string
  sellerAttn: string
  buyerName: string
  buyerAddress: string
  buyerRegNo: string
  buyerAttn: string
  buyerEmail: string
  transmittedVia: string
  inResponseTo: string
  // Product
  product: string
  specificationStandard: string
  keyParameters: string
  inspectionAgency: string
  certification: string
  // Commercial
  trialQuantity: string
  contractQuantity: string
  contractDuration: string
  deliveryTerm: string
  loadPort: string
  originsAvailable: string
  paymentInstrument: string
  incotermsVersion: string
  offerValidityDays: number
  currency: string
  unitPrice: string
  trialCargoValue: string
  contractPeriodValue: string
  annualContractValue: string
  originCountry: string
  destinationCountry: string
  governingLaw: string
}

// Hardcoded, non-editable — see the compliance note at the top of the file.
const PROCEDURE_INTRO =
  "This offer follows standard trade sequencing: inspection and title transfer of the goods precede final payment. " +
  "No fee is payable by the Buyer as a precondition to receiving inspection results, title documents, or product access. " +
  "Any compliance or due-diligence costs referenced below are the Seller's own operational cost unless expressly agreed " +
  "otherwise in writing."

const PROCEDURE_STEPS: string[] = [
  "Buyer reviews and countersigns this offer, confirming acceptance of the terms herein, and returns the signed copy within the stated window.",
  "Seller and Buyer execute a Sales & Purchase Agreement (SPA) reflecting the terms of this offer.",
  "Buyer submits standard KYC/AML documentation (see Section 5). Seller conducts its own compliance review at its own cost.",
  "Upon compliance clearance, Seller confirms product availability and provides supporting documentation (e.g. storage/availability confirmation).",
  "Independent inspection (quantity & quality) is conducted at the load port. The inspection report is issued to both parties.",
  "Upon satisfactory inspection, title transfer documentation is issued to Buyer. Payment is remitted by Buyer per the agreed instrument and settlement window, concurrent with or following receipt of title documents, per SPA terms.",
  "Seller issues full shipping documentation: Bill of Lading, Certificate of Origin, Title Transfer Certificate, inspection report, and other documents specified in the SPA.",
  "Upon successful completion of the trial shipment, the parties may proceed to execute a longer-term supply agreement on the terms agreed.",
]

const KYC_ITEMS: Array<[string, string]> = [
  ["Proof of Funds", "Bank-confirmed, covering the trial cargo value, issued by Buyer's bank on official letterhead."],
  ["Company Registration", "Certified corporate registration extract."],
  ["Signatory ID", "Certified copy of passport or equivalent government ID for the authorized signatory."],
  ["Bank Confirmation", "Letter from Buyer's bank confirming the account relationship."],
  ["Board Resolution", "Corporate resolution authorizing the signatory for this transaction."],
  ["Source of Funds", "Signed declaration of the origin of funds."],
]

const KEY_CONDITIONS: Array<[string, string]> = [
  [
    "No Upfront Fee to Trade",
    "No fee, deposit, or charge of any kind is required from the Buyer prior to inspection, title transfer, or delivery of product.",
  ],
  [
    "Non-Binding Status",
    "This offer does not constitute a binding contractual commitment until countersigned by both parties and reflected in an executed SPA.",
  ],
  [
    "Withdrawal Right",
    "Seller reserves the right to withdraw this offer if not accepted within the stated validity period.",
  ],
  [
    "Confidentiality",
    "This document is confidential and intended solely for the addressee. It may not be disclosed to third parties without prior written consent.",
  ],
]

const dash = (v: string | undefined | null) => (v && v.trim() ? v.trim() : "—")

export function generateFcoPdf(input: FcoInput): GeneratedPdf {
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 52
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - 60

  const docRef = makeDocRef("FCO")
  const issue = new Date()
  const validUntil = new Date(issue.getTime() + Math.max(1, input.offerValidityDays || 7) * 86400000)
  const seller = dash(input.sellerName) === "—" ? "Seller" : input.sellerName.trim()

  let y = 0
  let pageNo = 0

  const drawFooter = () => {
    doc.setDrawColor(...BRAND.line)
    doc.setLineWidth(1)
    doc.line(margin, bottomLimit + 16, pageWidth - margin, bottomLimit + 16)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(`${seller} · Full Corporate Offer · ${docRef}`, margin, bottomLimit + 30)
    doc.text("CONFIDENTIAL — FOR ADDRESSEE ONLY", pageWidth - margin, bottomLimit + 30, { align: "right" })
    doc.text(`Page ${pageNo}`, pageWidth - margin, bottomLimit + 42, { align: "right" })
  }

  const drawHeaderBand = () => {
    doc.setFillColor(...BRAND.ink)
    doc.rect(0, 0, pageWidth, 44, "F")
    // Adopted brand logo at the top-left of every page (on a white panel so it
    // stays crisp against the dark band). Falls back to the gold "M" badge if
    // the logo cache is cold.
    const markW = drawBrandMark(doc, "fco", margin, 7, 72, 30, { panel: true, radius: 4 })
    doc.setTextColor(...BRAND.white)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    doc.text(seller.toUpperCase(), margin + markW + 12, 26)
    doc.setTextColor(...BRAND.gold)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.text("FULL CORPORATE OFFER", pageWidth - margin, 26, { align: "right" })
  }

  const newPage = () => {
    doc.addPage()
    pageNo += 1
    drawHeaderBand()
    drawFooter()
    y = 64
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > bottomLimit) newPage()
  }

  const sectionTitle = (text: string) => {
    ensureSpace(34)
    y += 6
    doc.setFont("helvetica", "bold")
    doc.setFontSize(12)
    doc.setTextColor(...BRAND.ink)
    doc.text(text, margin, y)
    y += 8
    doc.setDrawColor(...BRAND.gold)
    doc.setLineWidth(1.5)
    doc.line(margin, y, margin + 30, y)
    y += 12
  }

  const paragraph = (text: string, opts?: { color?: [number, number, number]; size?: number; bold?: boolean }) => {
    if (!text) return
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal")
    doc.setFontSize(opts?.size ?? 9.5)
    doc.setTextColor(...(opts?.color ?? BRAND.ink))
    const lines = doc.splitTextToSize(text, contentWidth) as string[]
    lines.forEach((ln) => {
      ensureSpace(14)
      doc.text(ln, margin, y)
      y += 14
    })
    y += 4
  }

  // Two-column label/value rows. The label column is fixed; the value wraps.
  const kvRows = (rows: Array<[string, string]>) => {
    const labelW = 150
    const valueX = margin + labelW + 10
    const valueW = contentWidth - labelW - 10
    const lineHeight = 13
    rows.forEach(([label, value]) => {
      const vLines = doc.splitTextToSize(value || "—", valueW) as string[]
      const rowH = Math.max(lineHeight, vLines.length * lineHeight) + 6
      ensureSpace(rowH)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9)
      doc.setTextColor(...BRAND.slate)
      doc.text(label, margin, y)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9.5)
      doc.setTextColor(...BRAND.ink)
      vLines.forEach((ln, i) => doc.text(ln, valueX, y + i * lineHeight))
      y += rowH
    })
    y += 4
  }

  const numberedSteps = (steps: string[]) => {
    doc.setFontSize(9.5)
    const indent = 24
    steps.forEach((step, idx) => {
      const lines = doc.splitTextToSize(step, contentWidth - indent) as string[]
      const rowH = lines.length * 13 + 6
      ensureSpace(rowH)
      doc.setFont("helvetica", "bold")
      doc.setTextColor(...BRAND.gold)
      doc.text(`${idx + 1}.`, margin, y)
      doc.setFont("helvetica", "normal")
      doc.setTextColor(...BRAND.ink)
      lines.forEach((ln, i) => doc.text(ln, margin + indent, y + i * 13))
      y += rowH
    })
    y += 4
  }

  // ===== Document header =====
  pageNo = 1
  drawHeaderBand()
  drawFooter()
  y = 66

  doc.setFont("helvetica", "bold")
  doc.setFontSize(20)
  doc.setTextColor(...BRAND.ink)
  doc.text("FULL CORPORATE OFFER", margin, y)
  y += 22

  const subtitle = [
    dash(input.product) !== "—" ? input.product.trim() : "",
    dash(input.deliveryTerm) !== "—" ? input.deliveryTerm.trim() : "",
    dash(input.loadPort) !== "—" ? input.loadPort.trim() : "",
    dash(input.trialQuantity) !== "—" ? `${input.trialQuantity.trim()} Trial` : "",
    dash(input.contractQuantity) !== "—" ? `${input.contractQuantity.trim()} Contract` : "",
  ]
    .filter(Boolean)
    .join(" — ")
  if (subtitle) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.setTextColor(...BRAND.slate)
    const subLines = doc.splitTextToSize(subtitle, contentWidth) as string[]
    subLines.forEach((ln) => {
      doc.text(ln, margin, y)
      y += 14
    })
  }
  y += 6

  // Meta box
  doc.setDrawColor(...BRAND.line)
  doc.setFillColor(...BRAND.light)
  const metaH = 58
  doc.rect(margin, y, contentWidth, metaH, "FD")
  const colW = contentWidth / 4
  const metas: Array<[string, string]> = [
    ["Document Ref", docRef],
    ["Date of Issue", formatDate(issue)],
    ["Valid Until", formatDate(validUntil)],
    ["Classification", "CONFIDENTIAL"],
  ]
  metas.forEach(([label, value], i) => {
    const cx = margin + i * colW + 10
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    doc.setTextColor(...BRAND.slate)
    doc.text(label.toUpperCase(), cx, y + 20)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9.5)
    doc.setTextColor(...BRAND.ink)
    const vLines = doc.splitTextToSize(value, colW - 16) as string[]
    vLines.slice(0, 2).forEach((ln, li) => doc.text(ln, cx, y + 36 + li * 12))
  })
  y += metaH + 12

  // ===== 1. Parties =====
  sectionTitle("1. Parties")
  paragraph("SELLER", { bold: true, size: 8, color: BRAND.gold })
  kvRows([
    ["Legal name", dash(input.sellerName)],
    ["Registered address", dash(input.sellerAddress)],
    ["Email", dash(input.sellerEmail)],
    ["Attn", dash(input.sellerAttn)],
  ])
  paragraph("BUYER", { bold: true, size: 8, color: BRAND.gold })
  kvRows([
    ["Legal name", dash(input.buyerName)],
    ["Registered address", dash(input.buyerAddress)],
    ["Registration number", dash(input.buyerRegNo)],
    ["Email", dash(input.buyerEmail)],
    ["Attn", dash(input.buyerAttn)],
  ])
  if (dash(input.transmittedVia) !== "—" || dash(input.inResponseTo) !== "—") {
    paragraph(
      `Transmitted via: ${dash(input.transmittedVia)}   |   In response to: ${dash(input.inResponseTo)}`,
      { color: BRAND.slate, size: 9 },
    )
  }

  // ===== 2. Product Specification =====
  sectionTitle("2. Product Specification")
  kvRows([
    ["Product", dash(input.product)],
    ["Specification", dash(input.specificationStandard)],
    ["Key parameters", dash(input.keyParameters)],
    ["Inspection", dash(input.inspectionAgency) === "—" ? "Independent agency — Quantity & Quality at load port" : `${input.inspectionAgency.trim()} — Quantity & Quality at load port`],
    ["Certification", dash(input.certification) === "—" ? "Certificate of Origin / product certificates per SPA" : input.certification.trim()],
  ])

  // ===== 3. Commercial Terms =====
  sectionTitle("3. Commercial Terms")
  const ccy = dash(input.currency) === "—" ? "" : `${input.currency.trim()} `
  kvRows([
    ["Trial Quantity", dash(input.trialQuantity)],
    ["Contract Quantity", dash(input.contractQuantity)],
    ["Contract Duration", dash(input.contractDuration) === "—" ? "—" : `${input.contractDuration.trim()} — renewable upon mutual agreement`],
    ["Delivery Terms", [dash(input.deliveryTerm) !== "—" ? input.deliveryTerm.trim() : "", dash(input.loadPort) !== "—" ? input.loadPort.trim() : ""].filter(Boolean).join(" — ") || "—"],
    ["Origins Available", dash(input.originsAvailable)],
    ["Origin / Destination", `${dash(input.originCountry)}  →  ${dash(input.destinationCountry)}`],
    ["Payment Instrument", dash(input.paymentInstrument)],
    ["Incoterms", dash(input.incotermsVersion) === "—" ? "Incoterms 2020" : input.incotermsVersion.trim()],
    ["Offer Validity", `${Math.max(1, input.offerValidityDays || 7)} calendar days from date of issuance`],
    ["Unit Price", dash(input.unitPrice) === "—" ? "—" : `${ccy}${input.unitPrice.trim()}`],
    ["Trial Cargo Total Value", dash(input.trialCargoValue) === "—" ? "—" : `${ccy}${input.trialCargoValue.trim()}`],
    ["Contract Period Value", dash(input.contractPeriodValue) === "—" ? "—" : `${ccy}${input.contractPeriodValue.trim()}`],
    ["Annual Contract Value", dash(input.annualContractValue) === "—" ? "—" : `${ccy}${input.annualContractValue.trim()}`],
  ])

  // ===== 4. Transaction Procedure (hardcoded) =====
  sectionTitle("4. Transaction Procedure")
  paragraph(PROCEDURE_INTRO, { color: BRAND.slate, size: 9 })
  numberedSteps(PROCEDURE_STEPS)

  // ===== 5. KYC / AML =====
  sectionTitle("5. Standard KYC / AML Documentation Requested from Buyer")
  kvRows(KYC_ITEMS)

  // ===== 6. Key Commercial Conditions (hardcoded) =====
  sectionTitle("6. Key Commercial Conditions")
  kvRows(KEY_CONDITIONS)
  kvRows([["Governing Law", dash(input.governingLaw)]])

  // ===== 7. Acceptance =====
  sectionTitle("7. Acceptance")
  paragraph(
    `To accept this offer, the Buyer should return a countersigned copy to the Seller by ${formatDate(validUntil)}.`,
  )
  ensureSpace(140)
  y += 6
  const halfW = contentWidth / 2 - 10
  const blockTop = y
  const drawSignBlock = (x: number, heading: string, lines: string[]) => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.ink)
    doc.text(heading, x, blockTop)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.setTextColor(...BRAND.slate)
    let ly = blockTop + 40
    lines.forEach((label) => {
      doc.setDrawColor(...BRAND.line)
      doc.setLineWidth(0.75)
      doc.line(x, ly, x + halfW, ly)
      doc.text(label, x, ly + 12)
      ly += 40
    })
  }
  drawSignBlock(margin, "FOR AND ON BEHALF OF SELLER", ["Name / Title", "Signature", "Date"])
  drawSignBlock(margin + contentWidth / 2 + 10, "ACCEPTED BY BUYER", ["Name / Title", "Signature", "Date / Company Seal"])
  y = blockTop + 40 * 3 + 20

  paragraph(
    "This Full Corporate Offer is issued in good faith and is non-binding until countersigned by both parties and reflected in an executed SPA. No payment is due from the Buyer prior to inspection or title transfer.",
    { color: BRAND.slate, size: 8 },
  )

  const safeProduct = dash(input.product) === "—" ? "Offer" : input.product.trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 40)
  return { doc, filename: `FCO-${safeProduct}-${docRef}.pdf`, title: `Full Corporate Offer — ${dash(input.product) === "—" ? seller : input.product.trim()}` }
}
