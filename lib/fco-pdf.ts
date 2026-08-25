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

// Hardcoded, non-editable standard procedure. Anti-fraud safeguards are
// preserved: no payment is requested and no bank account is disclosed before a
// signed SPA exists; the 2% is a REFUNDABLE performance deposit that is a term
// of the signed SPA and is credited in full against the final invoice; full
// payment follows independent SGS Full POP verification; title transfers only
// after cleared funds — see the compliance note at the top of the file.
const PROCEDURE_INTRO =
  "The following procedure governs all transactions, reviewed and approved by MCC's legal counsel in compliance with " +
  "ICC standards and international commodity trade practice. All payment terms and MCC's designated bank account are " +
  "disclosed together within the signed Sales and Purchase Agreement (SPA) — no payment is requested, and no account is " +
  "disclosed, before the SPA exists."

const PROCEDURE_STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Step 1 — ICPO, BCL & Due-Diligence Engagement",
    body: "Buyer issues an Irrevocable Corporate Purchase Order (ICPO) to MCC Oil Gas specifying product grade, quantity, delivery basis (CIF/FOB), and destination port, accompanied by a Bank Comfort Letter (BCL) from the Buyer's principal bank evidencing financial capacity. Upon the Buyer's acceptance of this offer, MCC engages its independent law firm and accredited third-party firms to perform full KYC due diligence, AML and sanctions screening, and counterparty compliance verification. These are real, verifiable third-party costs incurred by MCC to onboard the Buyer and open the transaction. To fairly allocate this exposure, the diligence cost is a mandatory term of the transaction, recovered from the Buyer as the transparent cost-recovery line item set out in the SPA (Step 2 / Section 3): a fixed EUR 20,000, unless higher documented third-party costs are expressly agreed by the Buyer in writing within the SPA, and credited in full against the final invoice. For the avoidance of doubt, this amount is defined and payable within the signed SPA — no payment is requested, and no MCC bank account is disclosed, before the SPA is signed by both parties.",
  },
  {
    title: "Step 2 — SPA Issuance",
    body: "Upon completion of due diligence, MCC Oil Gas issues a Sales and Purchase Agreement, on behalf of MCC Petroli Company as product owner, stating product specification, volume, delivery basis, full pricing, payment schedule, the mandatory due-diligence cost-recovery line item (Section 3, a fixed EUR 20,000 unless higher documented third-party costs are agreed in writing, credited against the final invoice), the 2% performance deposit, and MCC's designated payment account — all within this single, signed document. Execution of the SPA is the commencement of the transaction, at which point the Buyer's cost-recovery and performance-deposit obligations become due as contract terms.",
  },
  {
    title: "Step 3 — SPA Execution & Partial POP",
    body: "Buyer signs and returns the executed SPA. Within five (5) banking days after receipt of the fully executed SPA and completion of contractual onboarding requirements, MCC Oil Gas issues a Partial Proof of Product (Partial POP) confirming product allocation and MCC Petroli Company's ownership under its active refinery mandate.",
  },
  {
    title: "Step 4 — 2% Performance Deposit",
    body: "Following SPA execution and receipt of Partial POP, Buyer remits a 2% performance deposit of total cargo value, credited in full against the final invoice. This deposit is a standard term of the signed SPA and is refundable if MCC fails to deliver Partial or Full POP within the timeframes stated in the SPA.",
  },
  {
    title: "Step 5 — Shipping & Discharge to Destination Port Storage",
    body: "Upon receipt of the performance deposit, MCC activates the logistics chain. [CIF Basis] MCC's nominated vessel loads the product at the source refinery and sails to the Buyer's destination port, where cargo is discharged into the agreed storage facility. [FOB Basis] Buyer's nominated vessel loads at the refinery terminal per agreed laycan.",
  },
  {
    title: "Step 6 — Full POP & Commercial Invoice",
    body: "Once the vessel has discharged and SGS has independently verified the product is physically present in destination storage, MCC issues: (i) Full Proof of Product, comprising the SGS Quantity & Quality Inspection Report and Dip Test Authorisation; and (ii) the Commercial Invoice.",
  },
  {
    title: "Step 7 — Full Cargo Payment",
    body: "Buyer has three (3) business days from issuance of Full POP to remit full cargo payment by bank wire transfer to MCC's account as stated in the signed SPA. MCC issues written receipt confirmation within one (1) business day of clearance.",
  },
  {
    title: "Step 8 — Title Transfer & Product Withdrawal",
    body: "Upon written confirmation of full receipt of cleared funds, MCC Petroli Company formally transfers legal title of the oil to the Buyer. The Buyer is then authorised to withdraw the product and arrange onward distribution. SGS undertakes a final quantity verification at the point of withdrawal.",
  },
]

// Callouts rendered under the procedure steps.
const VERIFICATION_CALLOUT = {
  title: "INDEPENDENT VERIFICATION — BUYER'S RIGHT",
  rows: [
    ["Inspector", "SGS (or agreed equivalent), engaged to report directly and independently to both parties."],
    ["Buyer's right", "The Buyer or nominated agent may contact SGS directly to confirm authenticity of the Full POP report before remitting final payment."],
    ["Timing", "Verification available prior to the Step 7 payment deadline above."],
  ] as Array<[string, string]>,
}

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
    "Payment Only Under a Signed SPA",
    "No payment is requested and no bank account is disclosed before a Sales & Purchase Agreement is signed by both parties. Two amounts become due as terms of the signed SPA: (i) a mandatory due-diligence cost-recovery amount (a fixed EUR 20,000, unless higher documented third-party costs are expressly agreed by the Buyer in writing within the SPA, covering MCC's independent legal, KYC, AML and sanctions-screening costs), credited in full against the final invoice; and (ii) a 2% performance deposit, credited in full against the final invoice and refundable if MCC fails to deliver Partial or Full POP within the SPA timeframes.",
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

// Format a monetary value with thousands separators. A value that is purely a
// number (optionally with existing commas / decimals) is normalized to grouped
// form (e.g. "24600000" → "24,600,000"); any value carrying other text is left
// exactly as entered so free-text notes are never mangled.
const money = (v: string | undefined | null): string => {
  const t = (v ?? "").trim()
  if (!t) return "—"
  const cleaned = t.replace(/,/g, "")
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return t
  const [intPart, decPart] = cleaned.split(".")
  const grouped = Number(intPart).toLocaleString("en-US")
  return decPart != null ? `${grouped}.${decPart}` : grouped
}

// Group the leading numeric token of a quantity string while leaving the unit
// text intact — e.g. "100000 MONTHS" → "100,000 MONTHS", "30,000 MT" stays.
const qty = (v: string | undefined | null): string => {
  const t = (v ?? "").trim()
  if (!t) return "—"
  return t.replace(/\d[\d,]*(\.\d+)?/, (m) => money(m))
}

// Simplify a delivery term to "<INCOTERM> <Destination>" to remove ambiguity
// (e.g. "CIF Taichung Port, Taiwan" + destination "Taiwan" → "CIF Taiwan").
// Falls back to the raw term if no incoterm / destination is available.
const INCOTERM_RE = /^(CIF|CFR|CIP|FOB|FCA|FAS|EXW|DAP|DPU|DDP|CPT)\b/i
const deliveryLine = (term: string | undefined | null, dest: string | undefined | null): string => {
  const t = dash(term)
  if (t === "—") return "—"
  const m = t.match(INCOTERM_RE)
  const incoterm = m ? m[1].toUpperCase() : ""
  const d = dash(dest)
  return incoterm && d !== "—" ? `${incoterm} ${d}` : t
}

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

  // Procedure steps: a bold "Step N — Title" line followed by the wrapped body.
  const procedureSteps = (steps: Array<{ title: string; body: string }>) => {
    const indent = 14
    steps.forEach((step) => {
      const bodyLines = doc.splitTextToSize(step.body, contentWidth - indent) as string[]
      ensureSpace(15 + bodyLines.length * 13 + 8)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9.5)
      doc.setTextColor(...BRAND.ink)
      doc.text(step.title, margin, y)
      y += 14
      doc.setFont("helvetica", "normal")
      doc.setFontSize(9.5)
      doc.setTextColor(...BRAND.ink)
      bodyLines.forEach((ln) => {
        ensureSpace(13)
        doc.text(ln, margin + indent, y)
        y += 13
      })
      y += 8
    })
  }

  // Bordered light-panel callout with a heading and label/value rows.
  const calloutBox = (title: string, rows: Array<[string, string]>) => {
    const labelW = 96
    const valueX = margin + 14 + labelW + 8
    const valueW = contentWidth - 28 - labelW - 8
    const lineH = 12
    // Measure height first so the whole box moves to a new page if needed.
    let bodyH = 0
    const wrapped = rows.map(([label, value]) => {
      const vLines = doc.splitTextToSize(value, valueW) as string[]
      bodyH += Math.max(lineH, vLines.length * lineH) + 6
      return { label, vLines }
    })
    const boxH = 26 + bodyH + 8
    ensureSpace(boxH + 6)
    doc.setDrawColor(...BRAND.line)
    doc.setFillColor(...BRAND.light)
    doc.rect(margin, y, contentWidth, boxH, "FD")
    let iy = y + 20
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND.ink)
    doc.text(title, margin + 14, iy)
    iy += 16
    wrapped.forEach(({ label, vLines }) => {
      doc.setFont("helvetica", "bold")
      doc.setFontSize(8.5)
      doc.setTextColor(...BRAND.slate)
      doc.text(`${label}:`, margin + 14, iy)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8.5)
      doc.setTextColor(...BRAND.ink)
      vLines.forEach((ln, i) => doc.text(ln, valueX, iy + i * lineH))
      iy += Math.max(lineH, vLines.length * lineH) + 6
    })
    y += boxH + 12
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
    dash(input.loadPort) !== "���" ? input.loadPort.trim() : "",
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
    ["Trial Quantity", qty(input.trialQuantity)],
    ["Contract Quantity", qty(input.contractQuantity)],
    ["Contract Duration", dash(input.contractDuration) === "—" ? "—" : `${input.contractDuration.trim()} — renewable upon mutual agreement`],
    ["Delivery Terms", deliveryLine(input.deliveryTerm, input.destinationCountry)],
    ["Origins Available", dash(input.originsAvailable)],
    [
      "Origin / Destination",
      dash(input.originCountry) === "—" && dash(input.destinationCountry) === "—"
        ? "—"
        : `${dash(input.originCountry)} to ${dash(input.destinationCountry)}`,
    ],
    ["Payment Instrument", dash(input.paymentInstrument)],
    ["Incoterms", dash(input.incotermsVersion) === "—" ? "Incoterms 2020" : input.incotermsVersion.trim()],
    ["Offer Validity", `${Math.max(1, input.offerValidityDays || 7)} calendar days from date of issuance`],
    ["Unit Price", dash(input.unitPrice) === "—" ? "—" : `${ccy}${money(input.unitPrice)}`],
    ["Trial Cargo Total Value", dash(input.trialCargoValue) === "—" ? "—" : `${ccy}${money(input.trialCargoValue)}`],
    ["Contract Period Value", dash(input.contractPeriodValue) === "—" ? "—" : `${ccy}${money(input.contractPeriodValue)}`],
    ["Annual Contract Value", dash(input.annualContractValue) === "—" ? "—" : `${ccy}${money(input.annualContractValue)}`],
  ])

  // ===== 4. Standard Transaction Procedure (hardcoded) =====
  sectionTitle("4. Standard Transaction Procedure — CIF / FOB")
  paragraph(PROCEDURE_INTRO, { color: BRAND.slate, size: 9 })
  procedureSteps(PROCEDURE_STEPS)
  calloutBox(VERIFICATION_CALLOUT.title, VERIFICATION_CALLOUT.rows)

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
    "This Full Corporate Offer is issued in good faith and is non-binding until countersigned by both parties and reflected in an executed SPA. No payment is due from the Buyer, and no bank account is disclosed, before a Sales & Purchase Agreement is signed by both parties.",
    { color: BRAND.slate, size: 8 },
  )

  const safeProduct = dash(input.product) === "—" ? "Offer" : input.product.trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").slice(0, 40)
  return { doc, filename: `FCO-${safeProduct}-${docRef}.pdf`, title: `Full Corporate Offer — ${dash(input.product) === "—" ? seller : input.product.trim()}` }
}
