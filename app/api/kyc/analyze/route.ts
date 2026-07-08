import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { analyzeKycDocument, mapAnalysisToResult } from "@/lib/kyc-analyze"

// The AI SDK must run on the Node.js runtime (never edge).
export const runtime = "nodejs"
export const maxDuration = 120

interface AnalyzeRequestBody {
  passcode?: string
  pdfPathname?: string
}

export async function POST(request: NextRequest) {
  let stage = "parse"
  try {
    const body = (await request.json()) as AnalyzeRequestBody

    // Gate behind the admin passcode — same secret used by the admin actions.
    if (!(await adminActionAuthorized(body.passcode))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const pdfPathname = body.pdfPathname
    if (!pdfPathname) return NextResponse.json({ error: "No PDF was uploaded." }, { status: 400 })

    // Read the already-uploaded PDF back from Blob and send it straight to the
    // multimodal model (Gemini reads PDFs natively) via the shared analyzer.
    stage = "ai-analyze"
    const output = await analyzeKycDocument(pdfPathname, "application/pdf")

    stage = "map-documents"
    const result = mapAnalysisToResult(output, pdfPathname)

    return NextResponse.json(result)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[v0] KYC analyze error (stage=${stage}):`, detail)
    return NextResponse.json(
      { error: `Failed to analyze the KYC document (${stage}): ${detail}` },
      { status: 500 },
    )
  }
}
