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
import type { KycDocument, KycDocumentType, KycAnalysisResult } from "@/lib/kyc-types"

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
