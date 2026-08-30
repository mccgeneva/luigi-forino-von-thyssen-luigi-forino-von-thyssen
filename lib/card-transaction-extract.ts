// ---------------------------------------------------------------------------
// Card-transaction receipt extraction — server-only.
//
// An administrator uploads a PDF/image receipt of a card transaction (a POS
// slip, an online-purchase confirmation, a card statement line, etc.) and the
// model reads it natively (Claude Opus, with a Sonnet + plain-text fallback)
// and recovers the transaction fields — merchant, amount, currency, date, the
// card's last 4 digits and a reference — so the admin can confirm/correct them
// and record the transaction against the client's Master Account.
//
// It ONLY transcribes what the receipt shows; it never invents an amount,
// merchant, or date. Anything absent comes back as an empty string.
// ---------------------------------------------------------------------------

import "server-only"
import { generateText, Output } from "ai"
import * as z from "zod"
import { docAnalysisModel, nqaiChatModel } from "@/lib/ai-models"
import { detectMediaType } from "@/lib/kyc-analyze"

export const cardTransactionExtractSchema = z.object({
  merchant: z
    .string()
    .describe("The merchant / payee name exactly as printed on the receipt. Empty string if not shown."),
  amount: z
    .string()
    .describe(
      "The transaction amount as DIGITS ONLY (no currency symbol, no thousands separators; use a dot for decimals, " +
        "e.g. '1250.00'). Use the TOTAL charged to the card. Empty string if not determinable.",
    ),
  currency: z
    .string()
    .describe('The 3-letter currency code of the amount, e.g. "EUR", "USD", "GBP". Empty string if not shown.'),
  date: z
    .string()
    .describe("The transaction date as printed (any format). Empty string if not shown."),
  last4: z
    .string()
    .describe("The last 4 digits of the card number if the receipt shows a masked PAN (e.g. **** 9268). Empty otherwise."),
  cardNetwork: z
    .string()
    .describe('The card network if shown, e.g. "Visa", "Mastercard", "Amex". Empty string if not shown.'),
  reference: z
    .string()
    .describe("The transaction / authorization / reference number if printed. Empty string if none."),
  summary: z
    .string()
    .describe("A one-sentence plain-English summary of the transaction for the admin to confirm."),
})

export type CardTransactionExtraction = z.infer<typeof cardTransactionExtractSchema>

const EXTRACT_PROMPT =
  "You are a payments operations analyst. The attached file is a receipt or statement line for a CARD transaction " +
  "(a point-of-sale slip, an online purchase confirmation, or a card statement entry). Extract the key fields so an " +
  "administrator can record the transaction against the cardholder's account.\n\n" +
  "Rules: transcribe ONLY what the document actually shows. Do NOT invent a merchant, amount, date, or card number. " +
  "Use empty strings for anything absent. For 'amount' return digits only using a dot decimal separator and NO " +
  "thousands separators (e.g. '1250.00'), and use the TOTAL amount charged to the card. Identify the 3-letter " +
  "currency code precisely."

/** One structured-extraction attempt on a given model. Throws on failure. */
async function structuredAttempt(
  model: ReturnType<typeof docAnalysisModel>,
  buffer: Buffer,
  detected: string,
): Promise<CardTransactionExtraction> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: cardTransactionExtractSchema }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACT_PROMPT },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType: detected },
        ],
      },
    ],
  })
  if (!output?.amount?.trim()) throw new Error("No amount recovered from structured extraction.")
  return output
}

/**
 * Plain-TEXT fallback: no structured-output schema (the fragile part when
 * reading a real receipt). We ask the model to transcribe the receipt as text
 * and then pull the fields with light, non-inventive regex. More robust than
 * object generation; the admin confirms/edits before recording.
 */
async function plainTextAttempt(
  model: ReturnType<typeof docAnalysisModel>,
  buffer: Buffer,
  detected: string,
): Promise<CardTransactionExtraction | null> {
  const { text } = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              EXTRACT_PROMPT +
              "\n\nOutput ONLY the receipt text transcribed verbatim, preserving line breaks. No commentary, no " +
              "markdown fences.",
          },
          { type: "file" as const, data: new Uint8Array(buffer), mediaType: detected },
        ],
      },
    ],
  })
  const raw = (text || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()
  if (!raw) return null

  // Amount: prefer a line labelled total/amount, else the largest money figure.
  const curMatch = raw.match(/\b(EUR|USD|GBP|CHF|JPY|AUD|CAD)\b/i)
  const totalLine = raw.match(/(?:total|amount|montant|importo|betrag)[^\d]{0,20}([\d.,]+)/i)?.[1]
  let amount = ""
  if (totalLine) {
    amount = normalizeAmount(totalLine)
  } else {
    const nums = [...raw.matchAll(/(\d[\d.,]*\d|\d)/g)]
      .map((m) => normalizeAmount(m[1]))
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
    if (nums.length) amount = String(Math.max(...nums))
  }
  const last4 = raw.match(/(?:\*|x|•){2,}\s*(\d{4})\b/i)?.[1] ?? raw.match(/\b\d{4}\b(?!.*\b\d{4}\b)/)?.[0] ?? ""
  const ref = raw.match(/(?:auth(?:orization)?|ref(?:erence)?|txn|transaction)[^\dA-Z]{0,8}([A-Z0-9-]{4,})/i)?.[1] ?? ""

  return {
    merchant: "",
    amount,
    currency: (curMatch?.[1] ?? "").toUpperCase(),
    date: "",
    last4,
    cardNetwork: "",
    reference: ref,
    summary: "Transaction details recovered from the receipt. Please check them against the document before recording.",
  }
}

/** Normalize a printed money token to a dot-decimal digits string. */
function normalizeAmount(token: string): string {
  const t = token.replace(/[^\d.,]/g, "")
  if (!t) return ""
  const hasComma = t.includes(",")
  const hasDot = t.includes(".")
  if (hasComma && hasDot) {
    // The LAST separator is the decimal; the other groups thousands.
    return t.lastIndexOf(",") > t.lastIndexOf(".")
      ? t.replace(/\./g, "").replace(",", ".")
      : t.replace(/,/g, "")
  }
  if (hasComma) {
    // Comma-only: decimal if it looks like a 2-decimal tail, else thousands.
    return /,\d{1,2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "")
  }
  return t
}

/**
 * Run the extraction on an uploaded card receipt. Returns the recovered fields.
 * Layered for resilience: structured on the doc model (Opus) → structured on
 * the chat model (Sonnet) → plain-text transcription fallback on both. Throws
 * only if every attempt fails, so the route can tell the admin to enter the
 * details manually.
 */
export async function extractCardTransaction(buffer: Buffer, mediaType: string): Promise<CardTransactionExtraction> {
  const detected = detectMediaType(buffer, mediaType)
  const errors: string[] = []

  try {
    return await structuredAttempt(docAnalysisModel(), buffer, detected)
  } catch (err) {
    errors.push(`doc/structured: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return await structuredAttempt(nqaiChatModel(), buffer, detected)
  } catch (err) {
    errors.push(`chat/structured: ${err instanceof Error ? err.message : String(err)}`)
  }
  for (const model of [docAnalysisModel(), nqaiChatModel()]) {
    try {
      const result = await plainTextAttempt(model, buffer, detected)
      if (result) return result
    } catch (err) {
      errors.push(`plaintext: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log("[v0] card-transaction extraction exhausted all attempts:", errors.join(" | "))
  throw new Error("Could not read the receipt after multiple attempts.")
}
