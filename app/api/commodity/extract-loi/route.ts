import { type NextRequest, NextResponse } from "next/server"
import { resolveCurrentSession } from "@/lib/session-user"
import { extractLoiDocument } from "@/lib/loi-extract"

// Client-facing endpoint: a signed-in trader uploads a buyer's LOI/ICPO (PDF or
// image) and gets back the structured commercial fields to pre-fill their deal
// form and draft an FCO. Session-gated (NOT admin-PIN) because the client is
// acting on their own counterparty's document. The file is read in-memory and
// analysed; it is NOT persisted here.
export const runtime = "nodejs"
export const maxDuration = 60

const MAX_BYTES = 15 * 1024 * 1024
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"])

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await resolveCurrentSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 401 })
  }

  let file: File | null = null
  try {
    const form = await request.formData()
    const f = form.get("file")
    if (f instanceof File) file = f
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read the uploaded file." }, { status: 400 })
  }

  if (!file) {
    return NextResponse.json({ ok: false, error: "No document was provided." }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "The document is too large (max 15 MB)." }, { status: 400 })
  }

  const declared = file.type || "application/pdf"
  if (!ALLOWED.has(declared)) {
    return NextResponse.json(
      { ok: false, error: "Upload a PDF or an image (PNG, JPG, WebP) of the LOI/ICPO." },
      { status: 400 },
    )
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const data = await extractLoiDocument(buffer, declared)
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    console.log("[v0] LOI extraction failed:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { ok: false, error: "The document could not be read automatically. Enter the deal details manually." },
      { status: 500 },
    )
  }
}
