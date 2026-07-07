// ---------------------------------------------------------------------------
// Shared KYC / passport document analysis — server-only.
//
// Wraps the multimodal model call that reads an uploaded identity document out
// of Blob. Extracted from the admin `/api/kyc/analyze` route so it can be reused
// by the login-time identity-verification gate WITHOUT going through the
// admin-passcode-gated HTTP route.
// ---------------------------------------------------------------------------

import "server-only"
import { get } from "@vercel/blob"
import { generateText, Output } from "ai"
import * as z from "zod"
import type {
  KycDocument,
  KycDocumentType,
  KycAnalysisResult,
  DocComplianceAnalysis,
  KycVerdict,
} from "@/lib/kyc-types"

const DOCUMENT_TYPES = [
  "passport",
  "id_card",
  "drivers_license",
  "proof_of_address",
  "bank_statement",
  "company_registration",
  "selfie",
  "other",
] as const

// Structured output the model returns: identity fields to pre-fill the form,
// the passport bio-data, and a per-page classification of every PDF page.
export const analysisSchema = z.object({
  fields: z.object({
    fullName: z
      .string()
      .describe(
        "Full name of the individual account holder / principal in natural display order " +
          '(given names first, then surname), including any honorific/title and noble designation, e.g. "Dr. Luigi Forino Von Thyssen". ' +
          'Do NOT use the "SURNAME, Given" passport format.',
      ),
    company: z.string().describe("Company or entity name, if any. Empty string if none."),
    role: z.string().describe("Job title or role of the person (e.g. Director). Empty string if unknown."),
    email: z.string().describe("Email address. Empty string if none found."),
    phone: z.string().describe("Phone / mobile number. Empty string if none found."),
    nationality: z.string().describe("Nationality or citizenship (country name). Empty string if unknown."),
    address: z.string().describe("Full residential address. Empty string if none found."),
    website: z.string().describe("Website URL. Empty string if none found."),
  }),
  passport: z
    .object({
      type: z.string().describe('Document type, e.g. "Passport" or "National ID".'),
      passportNo: z.string().describe("Document / passport number."),
      surname: z.string().describe("Surname / family name."),
      givenNames: z.string().describe("Given names."),
      validUntil: z.string().describe("Expiry date as printed (e.g. 12 MAR 2031)."),
      country: z.string().describe("Issuing country."),
    })
    .nullable()
    .describe("Passport / identity-document bio-data, or null if no passport is present."),
  pages: z
    .array(
      z.object({
        pageNumber: z.number().int().describe("1-based page number this classification refers to."),
        type: z.enum(DOCUMENT_TYPES).describe("The kind of document shown on this page."),
        label: z.string().describe('Short human label, e.g. "Passport — bio page" or "Utility bill".'),
        isDocument: z
          .boolean()
          .describe(
            "True if this page is an actual identity/KYC document worth storing; false for cover pages, blank pages, or pure instructions.",
          ),
      }),
    )
    .describe("One entry per page of the PDF, in order."),
})

export type KycAnalysisOutput = z.infer<typeof analysisSchema>

/** Read an uploaded Blob into a Buffer for the multimodal model call. */
export async function readBlobBuffer(pathname: string): Promise<Buffer> {
  const result = await get(pathname, { access: "public" })
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Could not read uploaded file: ${pathname}`)
  }
  const arrayBuffer = await new Response(result.stream).arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Run the full KYC pack analysis on an uploaded document (PDF or image) and
 * return the raw structured output. Shared by the admin analyze route.
 */
export async function analyzeKycDocument(pathname: string, mediaType: string): Promise<KycAnalysisOutput> {
  const buffer = await readBlobBuffer(pathname)
  const { output } = await generateText({
    model: "google/gemini-3-flash",
    output: Output.object({ schema: analysisSchema }),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "You are a KYC analyst for a financial institution. The attached file is a single client onboarding / KYC pack. " +
              "Extract the account holder's identity details to pre-fill an onboarding form, read any passport or identity document bio-data, and classify EACH page. " +
              "Use empty strings for fields you cannot find. Page numbers are 1-based, in document order.",
          },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType },
        ],
      },
    ],
  })
  return output
}

/** Map a KYC analysis output to storable document references for a given pathname. */
export function mapAnalysisToResult(output: KycAnalysisOutput, pdfPathname: string): KycAnalysisResult {
  const documents: KycDocument[] = []
  for (const page of output.pages) {
    if (!page.isDocument) continue
    documents.push({
      pathname: pdfPathname,
      type: page.type as KycDocumentType,
      label: page.label || "Document",
      pageNumber: page.pageNumber,
    })
  }
  return {
    fields: output.fields,
    passportMeta: output.passport,
    passportImagePathname: null,
    documents,
    pdfPathname,
  }
}

// --- Identity-gate passport verification -----------------------------------

const passportCheckSchema = z.object({
  isPassport: z
    .boolean()
    .describe(
      "True ONLY if the image is a genuine-looking government PASSPORT bio-data page (or a national identity card). " +
        "False for utility bills, screenshots, blank pages, random photos, or any non-identity document.",
    ),
  hasFacePhoto: z
    .boolean()
    .describe("True if a clear photographic portrait of the holder is visible on the document."),
  hasMrz: z
    .boolean()
    .describe("True if the machine-readable zone (the two/three rows of >>>-style characters) is present."),
  passport: z
    .object({
      passportNo: z.string().describe("Document / passport number. Empty string if unreadable."),
      surname: z.string().describe("Surname / family name. Empty string if unreadable."),
      givenNames: z.string().describe("Given names. Empty string if unreadable."),
      country: z.string().describe("Issuing country name. Empty string if unreadable."),
      validUntil: z.string().describe("Expiry date as printed. Empty string if unreadable."),
    })
    .nullable()
    .describe("Passport bio-data, or null if none could be read."),
  reason: z
    .string()
    .describe("If isPassport is false, a short reason (e.g. 'This looks like a utility bill'). Empty otherwise."),
})

export interface PassportVerification {
  isPassport: boolean
  hasFacePhoto: boolean
  hasMrz: boolean
  passportNo: string
  fullName: string
  country: string
  validUntil: string
  reason: string
}

/**
 * Focused check for the login identity gate: does this uploaded image actually
 * read as a passport (photo + MRZ + bio-data)? This is an in-app document check
 * — it confirms the document LOOKS like a valid passport and extracts its
 * bio-data. It is NOT a licensed government-document-authenticity attestation.
 */
export async function verifyPassportImage(pathname: string, mediaType: string): Promise<PassportVerification> {
  const buffer = await readBlobBuffer(pathname)
  const { output } = await generateText({
    model: "google/gemini-3-flash",
    output: Output.object({ schema: passportCheckSchema }),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "You are verifying an identity document for account login. Decide whether the attached image is a genuine-looking " +
              "government PASSPORT bio-data page (a national identity card is also acceptable). Confirm whether a clear face photo " +
              "and a machine-readable zone (MRZ) are present, and read the bio-data. Be strict: reject anything that is not an " +
              "identity document.",
          },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType },
        ],
      },
    ],
  })
  const p = output.passport
  const fullName = p ? `${p.givenNames} ${p.surname}`.trim() : ""
  return {
    isPassport: output.isPassport,
    hasFacePhoto: output.hasFacePhoto,
    hasMrz: output.hasMrz,
    passportNo: p?.passportNo || "",
    fullName,
    country: p?.country || "",
    validUntil: p?.validUntil || "",
    reason: output.reason || "",
  }
}

// --- Security-Audit dossier: per-document compliance analysis ---------------

const RISK_LEVELS = ["low", "medium", "high"] as const

// One AI pass per uploaded document. The model reads the file (image OR PDF —
// gemini reads PDFs natively) and returns a compliance-oriented breakdown that
// is embedded, per document, into the KYC & Activity dossier.
const docComplianceSchema = z.object({
  detectedType: z
    .string()
    .describe('What this document actually is, e.g. "Passport bio-data page", "Utility bill", "Bank statement".'),
  personName: z.string().describe("Full name of the person the document belongs to, if present. Empty string if none."),
  documentNumber: z
    .string()
    .describe("The primary document / reference number (passport no., account no., invoice no.). Empty if none."),
  issuingAuthority: z
    .string()
    .describe("Issuing authority, bank, government body or company that produced the document. Empty if unknown."),
  issueDate: z.string().describe("Issue / statement date as printed. Empty string if none."),
  expiryDate: z.string().describe("Expiry / valid-until date as printed. Empty string if none/not applicable."),
  extractedFields: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe("Up to 8 of the most important extracted fields as label/value pairs (dates, numbers, addresses, amounts)."),
  consistencyNotes: z
    .string()
    .describe(
      "How well this document matches the account identity on file (name and country provided in the prompt). " +
        "State clearly if the name matches, partially matches, or conflicts.",
    ),
  redFlags: z
    .array(z.string())
    .describe(
      "Concrete compliance concerns: expired document, name mismatch, signs of tampering/editing, low legibility, " +
        "wrong document type, missing MRZ on a passport, etc. Empty array if none.",
    ),
  riskLevel: z.enum(RISK_LEVELS).describe("Overall risk this single document contributes: low, medium, or high."),
  summary: z.string().describe("A 1-2 sentence plain-English summary of the document and its KYC relevance."),
})

/**
 * Analyse one uploaded document for the dossier. Never throws — on any failure
 * it returns a populated `error` so a single bad file can't abort the batch.
 */
export async function analyzeDocumentCompliance(
  doc: { id: string; label: string; filename: string; pathname: string; contentType: string; isImage: boolean },
  identity: { fullName: string; country: string },
): Promise<DocComplianceAnalysis> {
  const base: DocComplianceAnalysis = {
    docId: doc.id,
    label: doc.label,
    filename: doc.filename,
    detectedType: "",
    documentNumber: "",
    issuingAuthority: "",
    issueDate: "",
    expiryDate: "",
    personName: "",
    extractedFields: [],
    consistencyNotes: "",
    redFlags: [],
    riskLevel: "medium",
    summary: "",
  }
  try {
    const buffer = await readBlobBuffer(doc.pathname)
    const mediaType = doc.contentType || (doc.isImage ? "image/jpeg" : "application/pdf")
    const { output } = await generateText({
      model: "google/gemini-3-flash",
      output: Output.object({ schema: docComplianceSchema }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "You are a KYC / AML compliance analyst at a financial institution reviewing ONE document from a client's " +
                "onboarding file. Read it carefully and extract its key data, then assess it for compliance.\n\n" +
                `Account identity on file — name: "${identity.fullName || "unknown"}", country: "${identity.country || "unknown"}".\n` +
                `This document is labelled "${doc.label}" (file: ${doc.filename}).\n\n` +
                "Compare the document against the identity on file, flag any concerns, and assign a risk level. " +
                "Use empty strings / empty arrays where information is absent. Be precise and factual.",
            },
            { type: "file" as const, data: new Uint8Array(buffer), mediaType },
          ],
        },
      ],
    })
    return {
      ...base,
      detectedType: output.detectedType || doc.label,
      personName: output.personName || "",
      documentNumber: output.documentNumber || "",
      issuingAuthority: output.issuingAuthority || "",
      issueDate: output.issueDate || "",
      expiryDate: output.expiryDate || "",
      extractedFields: (output.extractedFields || []).filter((f) => f.label || f.value).slice(0, 8),
      consistencyNotes: output.consistencyNotes || "",
      redFlags: (output.redFlags || []).filter(Boolean),
      riskLevel: output.riskLevel,
      summary: output.summary || "",
    }
  } catch (err) {
    return {
      ...base,
      detectedType: doc.label,
      riskLevel: "medium",
      summary: "This document could not be analysed automatically and should be reviewed manually.",
      error: err instanceof Error ? err.message : "Analysis failed.",
    }
  }
}

// --- Security-Audit dossier: overall KYC verdict ----------------------------

const kycVerdictSchema = z.object({
  completeness: z
    .enum(["complete", "partial", "insufficient"])
    .describe("Whether the document set is complete, partial, or insufficient for standard KYC."),
  overallRisk: z.enum(RISK_LEVELS).describe("Overall KYC risk across the whole file."),
  presentDocumentTypes: z.array(z.string()).describe("Distinct categories of documents present in the file."),
  missingRecommended: z
    .array(z.string())
    .describe("Recommended KYC documents that appear to be missing (e.g. proof of address, valid photo ID)."),
  keyFindings: z.array(z.string()).describe("The most important factual findings, as short bullet points."),
  redFlags: z.array(z.string()).describe("Aggregated compliance red flags across all documents. Empty if none."),
  narrative: z
    .string()
    .describe("A concise 2-4 paragraph compliance narrative an administrator could hand to authorities."),
})

/**
 * Synthesise an overall KYC verdict from the per-document analyses. Never throws
 * — returns null on failure so the dossier still builds with the per-doc detail.
 */
export async function synthesizeKycVerdict(
  identity: { fullName: string; country: string; verified: boolean; passportNo: string | null },
  analyses: DocComplianceAnalysis[],
): Promise<KycVerdict | null> {
  try {
    const docDigest = analyses
      .map(
        (a, i) =>
          `${i + 1}. ${a.detectedType || a.label} (${a.filename}) — risk ${a.riskLevel}. ` +
          `Person: ${a.personName || "—"}. Number: ${a.documentNumber || "—"}. Expiry: ${a.expiryDate || "—"}. ` +
          `Consistency: ${a.consistencyNotes || "—"}. Red flags: ${a.redFlags.length ? a.redFlags.join("; ") : "none"}.` +
          (a.error ? ` (ANALYSIS ERROR: ${a.error})` : ""),
      )
      .join("\n")
    const { output } = await generateText({
      model: "google/gemini-3-flash",
      output: Output.object({ schema: kycVerdictSchema }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "You are a senior KYC / AML compliance officer producing the overall verdict for a client file. " +
                "Below is the identity on record and a per-document analysis of everything in the file. " +
                "Assess completeness and overall risk, list present document categories, note recommended documents that " +
                "are missing, summarise the key findings and any aggregated red flags, and write a concise compliance " +
                "narrative.\n\n" +
                `IDENTITY ON FILE — name: "${identity.fullName || "unknown"}", country: "${identity.country || "unknown"}", ` +
                `identity verified: ${identity.verified ? "yes" : "no"}, passport number on record: ${identity.passportNo ? "yes" : "no"}.\n\n` +
                `DOCUMENTS ANALYSED (${analyses.length}):\n${docDigest || "No documents were provided."}`,
            },
          ],
        },
      ],
    })
    return {
      completeness: output.completeness,
      overallRisk: output.overallRisk,
      presentDocumentTypes: (output.presentDocumentTypes || []).filter(Boolean),
      missingRecommended: (output.missingRecommended || []).filter(Boolean),
      keyFindings: (output.keyFindings || []).filter(Boolean),
      redFlags: (output.redFlags || []).filter(Boolean),
      narrative: output.narrative || "",
    }
  } catch (err) {
    console.log("[v0] KYC verdict synthesis failed:", err instanceof Error ? err.message : err)
    return null
  }
}
