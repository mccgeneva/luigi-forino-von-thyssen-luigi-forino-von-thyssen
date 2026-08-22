import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { resolveCurrentSession } from "@/lib/session-user"

// Token endpoint for browser → Blob direct uploads of a sub-account UBO's
// identity documents (passport + KYC). Uploading straight from the client's
// browser keeps large PDF/image payloads out of the serverless function
// (which has a ~4.5 MB request-body limit). Mirrors the funding blob route.
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Documents are uploaded by the SIGNED-IN account holder against their
        // own sub-account request. Require a valid session and confine writes to
        // the "sub-accounts/" prefix.
        const session = await resolveCurrentSession()
        if (!session) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("sub-accounts/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // The document coordinates are persisted by requestSubAccount; nothing to
      // do here, but the callback is required.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
