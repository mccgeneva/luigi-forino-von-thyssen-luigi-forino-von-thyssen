import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { verifyAdminPin } from "@/lib/admin-auth"

// Token endpoint for browser → Blob direct uploads of commodity DEAL documents
// (POI, ICPO, POF, POP, SGS reports, proof of payment, allocation letters, etc.).
// These are issued by the administrator only, so the custody-desk PIN is the
// sole authorization. Files land in PRIVATE Blob storage under `commodity-docs/`
// and are served to authorized clients through the /api/file proxy — the raw
// Blob URL is never exposed. Direct-from-browser upload keeps large PDFs out of
// the serverless function body limit.
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let passcode: string | undefined
        try {
          passcode = clientPayload ? (JSON.parse(clientPayload) as { passcode?: string }).passcode : undefined
        } catch {
          passcode = undefined
        }
        if (!verifyAdminPin(passcode)) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("commodity-docs/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // The document metadata (including the returned blob pathname) is persisted
      // by the deal-document server action; nothing to do here.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
