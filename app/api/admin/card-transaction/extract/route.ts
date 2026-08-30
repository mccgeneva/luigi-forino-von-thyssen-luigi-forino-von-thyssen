import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { extractCardTransaction } from "@/lib/card-transaction-extract"

// Admin-only endpoint: an administrator uploads a card-transaction receipt
// (PDF or image) and gets back the OCR-extracted transaction fields to confirm
// before recording the transaction against a client's Master Account.
//
// Gated by the admin passcode (sent as a form field), NOT a session — this is
// an administrative operation. Imports the lib extractor DIRECTLY (not a
// "use server" wrapper) so the route bundle stays clean. The file is read
// in-memory and analysed; it is NOT persisted.
export const runtime = "nodejs"
export const maxDuration = 60

const MAX_BYTES = 15 * 1024 * 1024
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"])

export async function POST(request: NextRequest): Promise<NextResponse> {
  let file: File | null = null
  let passcode = ""
  try {
    const form = await request.formData()
    const f = form.get("file")
    if (f instanceof File) file = f
    passcode = String(form.get("passcode") ?? "")
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read the uploaded file." }, { status: 400 })
  }

  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  if (!file) {
    return NextResponse.json({ ok: false, error: "No receipt was provided." }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "The receipt is too large (max 15 MB)." }, { status: 400 })
  }
  const declared = file.type || "application/pdf"
  if (!ALLOWED.has(declared)) {
    return NextResponse.json(
      { ok: false, error: "Upload a PDF or an image (PNG, JPG, WebP) of the receipt." },
      { status: 400 },
    )
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const data = await extractCardTransaction(buffer, declared)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] card-transaction extraction failed:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { ok: false, error: "The receipt could not be read automatically. Enter the transaction details manually." },
      { status: 500 },
    )
  }
}
