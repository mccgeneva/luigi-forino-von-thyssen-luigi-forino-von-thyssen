// ---------------------------------------------------------------------------
// LOI / ICPO document extraction — server-only.
//
// Reads a buyer's Letter of Intent (LOI) or Irrevocable Corporate Purchase
// Order (ICPO) — PDF or image — and returns the structured commercial fields a
// trader needs to (a) pre-fill an editable commodity-deal form and (b) draft a
// Full Corporate Offer (FCO) in reply. The model reads the document natively
// (Claude Opus) so scanned PDFs and photographed letters both work.
//
// This ONLY reads what the buyer's document states; it never invents pricing or
// terms. Empty strings are used for anything absent so the trader fills the
// gaps manually before issuing an offer.
// ---------------------------------------------------------------------------

import "server-only"
import { generateText, Output } from "ai"
import * as z from "zod"
import { docAnalysisModel } from "@/lib/ai-models"
import { detectMediaType } from "@/lib/kyc-analyze"

const DOC_KINDS = ["LOI", "ICPO", "RFQ", "SPA", "Other"] as const

// Structured shape returned to the client. Every field is a string so the
// pre-fill form stays simple; numeric parsing happens client-side. Fields the
// document does not contain come back as empty strings.
export const loiSchema = z.object({
  documentType: z.enum(DOC_KINDS).describe("What the uploaded document actually is: LOI, ICPO, RFQ, SPA, or Other."),
  referenceNo: z.string().describe("The buyer's document reference / order number, if printed. Empty if none."),
  referenceDate: z.string().describe("The date printed on the buyer's document, as written. Empty if none."),

  // Product
  product: z.string().describe('Product / grade requested, e.g. "EN590 10ppm Diesel", "Jet A1", "D2 Gas Oil". Empty if none.'),
  specificationStandard: z
    .string()
    .describe('Governing specification/standard, e.g. "ISO 8217", "ASTM D975", "GOST". Empty if none.'),
  keyParameters: z
    .string()
    .describe("Key quality parameters as a single line (sulphur, density, flash point, etc.). Empty if none."),

  // Commercial
  trialQuantity: z.string().describe('Trial / first-lift quantity as written, e.g. "50,000 MT". Empty if none.'),
  contractQuantity: z.string().describe('Recurring contract quantity per period, e.g. "100,000 MT x 12". Empty if none.'),
  quantityUnit: z.string().describe('Primary quantity unit, one of "MT" or "bbl" if determinable, else empty.'),
  contractDuration: z.string().describe('Contract duration, e.g. "12 months". Empty if none.'),
  deliveryTerm: z.string().describe('Delivery term / INCOTERM, e.g. "CIF", "FOB", "TTO", "CIF Rotterdam". Empty if none.'),
  loadPort: z.string().describe("Load / origin port named in the document. Empty if none."),
  dischargePort: z.string().describe("Discharge / destination port named in the document. Empty if none."),
  originsAvailable: z.string().describe("Origins / source refineries mentioned. Empty if none."),
  originCountry: z.string().describe("Country of origin, if stated. Empty if none."),
  destinationCountry: z.string().describe("Destination country, if stated. Empty if none."),

  unitPrice: z.string().describe('Unit price the buyer proposes/accepts, e.g. "485.00" per MT. Number-only string, empty if none.'),
  currency: z.string().describe('Currency code, e.g. "USD", "EUR". Empty if none.'),
  totalValue: z.string().describe("Total contract/trial value if stated. Number-only string, empty if none."),
  paymentInstrument: z
    .string()
    .describe('Proposed payment mechanism, e.g. "MT103 TT", "SBLC", "DLC at sight". Empty if none.'),
  inspectionAgency: z.string().describe('Inspection agency, e.g. "SGS", "Intertek". Empty if none.'),

  // Parties
  buyerName: z.string().describe("Buyer legal entity name. Empty if none."),
  buyerAddress: z.string().describe("Buyer registered address. Empty if none."),
  buyerRegNo: z.string().describe("Buyer company registration number. Empty if none."),
  buyerAttn: z.string().describe("Buyer authorised signatory / contact name and title. Empty if none."),
  buyerEmail: z.string().describe("Buyer contact email. Empty if none."),
  sellerName: z.string().describe("Seller entity named as the intended supplier, if any. Empty if none."),

  notes: z
    .string()
    .describe("Any other material terms (delivery window, procedure, special conditions) in 1-3 short sentences. Empty if none."),
})

export type LoiExtraction = z.infer<typeof loiSchema>

/**
 * Run the extraction on an uploaded LOI/ICPO. Returns the structured fields.
 * Throws on model/decode failure so the route can surface a clear error.
 */
export async function extractLoiDocument(buffer: Buffer, mediaType: string): Promise<LoiExtraction> {
  const detected = detectMediaType(buffer, mediaType)
  const { output } = await generateText({
    model: docAnalysisModel(),
    output: Output.object({ schema: loiSchema }),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "You are a commodity-trading desk analyst. The attached file is a buyer's Letter of Intent (LOI) or " +
              "Irrevocable Corporate Purchase Order (ICPO) for a physical commodity (typically petroleum products). " +
              "Extract every commercial and party detail you can read, to pre-fill a deal form and draft a Full Corporate " +
              "Offer in reply.\n\n" +
              "Rules: report ONLY what the document actually states. Do NOT invent prices, quantities, parties, or terms. " +
              "Use empty strings for anything absent. For unitPrice/totalValue return digits only (no currency symbols or " +
              "commas). Put the quantity unit in quantityUnit as 'MT' or 'bbl' when determinable.",
          },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType: detected },
        ],
      },
    ],
  })
  return output
}
