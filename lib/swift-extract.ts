// ---------------------------------------------------------------------------
// SWIFT printout extraction — server-only.
//
// A customer receives a SWIFT message (typically an MT760 blocked-funds bank
// guarantee) from their counterparty's bank as a printout / advice (PDF or
// image) and uploads it here so the platform can action it. The model reads the
// document natively (Claude Opus) and recovers the SWIFT FIN message text plus a
// short summary, so the customer can confirm/correct it and submit it to the
// platform's inbound-SWIFT queue for administrator verification.
//
// It ONLY transcribes what the printout shows; it never invents amounts, BICs,
// IBANs, or references. Anything absent comes back as an empty string.
// ---------------------------------------------------------------------------

import "server-only"
import { generateText, Output } from "ai"
import * as z from "zod"
import { docAnalysisModel } from "@/lib/ai-models"
import { detectMediaType } from "@/lib/kyc-analyze"

export const swiftExtractSchema = z.object({
  finMessage: z
    .string()
    .describe(
      "The full SWIFT FIN message text. If the printout already shows raw FIN blocks ({1:...}{2:...}{4:...}) or tagged " +
        "fields (:20:, :23:, :32B:, :40C:, :59:, :77C:, etc.), transcribe them VERBATIM into a FIN message block. If it " +
        "is a narrative bank advice, reconstruct a best-effort FIN block from the visible fields using standard SWIFT " +
        "tags for the detected message type. Preserve line breaks. Empty string only if the document is unreadable.",
    ),
  messageType: z
    .string()
    .describe('The SWIFT MT message type, e.g. "MT760", "MT103", "MT799", "MT700". Empty if not determinable.'),
  senderBic: z.string().describe("Sender / issuing bank BIC (SWIFT code). Empty if none."),
  receiverBic: z.string().describe("Receiver / beneficiary bank BIC (SWIFT code). Empty if none."),
  currency: z.string().describe('Undertaking / transfer currency code, e.g. "EUR", "USD". Empty if none.'),
  amount: z
    .string()
    .describe("The amount / guarantee face value as digits only (no currency symbol or thousands separators). Empty if none."),
  beneficiaryName: z.string().describe("Beneficiary name (the party receiving the guarantee/funds). Empty if none."),
  beneficiaryIban: z.string().describe("Beneficiary account / IBAN. Empty if none."),
  applicant: z.string().describe("Applicant / ordering party name (who instructed the guarantee). Empty if none."),
  reference: z.string().describe("The transaction / guarantee reference (:20: or similar). Empty if none."),
  uetr: z.string().describe("The UETR (unique end-to-end transaction reference), if printed. Empty if none."),
  guaranteeForm: z
    .string()
    .describe('For an MT760: the guarantee form, e.g. "Demand Guarantee", "Standby Letter of Credit", "Bank Guarantee". Empty otherwise.'),
  expiryDate: z.string().describe("Guarantee expiry date as written, if any. Empty if none."),
  summary: z
    .string()
    .describe("A one-sentence plain-English summary of what the document is and its key terms, for the customer to confirm."),
})

export type SwiftExtraction = z.infer<typeof swiftExtractSchema>

/**
 * Run the extraction on an uploaded SWIFT printout. Returns the recovered FIN
 * text + summary fields. Throws on model/decode failure so the route can surface
 * a clear error.
 */
export async function extractSwiftDocument(buffer: Buffer, mediaType: string): Promise<SwiftExtraction> {
  const detected = detectMediaType(buffer, mediaType)
  const { output } = await generateText({
    model: docAnalysisModel(),
    output: Output.object({ schema: swiftExtractSchema }),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "You are a correspondent-banking operations analyst. The attached file is a SWIFT message printout / bank " +
              "advice a customer received from their counterparty's bank — most often an MT760 (bank guarantee / standby " +
              "letter of credit for blocked funds), but it could be an MT103, MT700, or MT799.\n\n" +
              "Recover the SWIFT FIN message text so the platform can process it, and extract the key fields for the " +
              "customer to confirm.\n\n" +
              "Rules: transcribe ONLY what the document actually shows. Do NOT invent BICs, IBANs, amounts, references, or " +
              "parties. Use empty strings for anything absent. For 'amount' return digits only (no currency symbol or " +
              "commas). Identify the message type precisely (e.g. MT760).",
          },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType: detected },
        ],
      },
    ],
  })
  return output
}
