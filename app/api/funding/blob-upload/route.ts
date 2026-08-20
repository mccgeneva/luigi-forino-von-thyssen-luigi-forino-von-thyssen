import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { resolveCurrentSession } from "@/lib/session-user"

// Token endpoint for browser → Blob direct uploads of AES project-funding
// application documents (LOI, CIS, registry certificate, passport, business
// plan, bank statement, etc.). Uploading straight from the applicant's browser
// keeps potentially large PDF/image payloads out of our serverless function
// (which has a ~4.5 MB request-body limit that a document pack would blow past).
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Funding documents are uploaded by the SIGNED-IN applicant against their
        // own application. The upload-token request does carry the session
        // cookie for a same-origin fetch, so require a valid session and confine
        // writes to the "funding/" prefix.
        const session = await resolveCurrentSession()
        if (!session) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("funding/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "application/pdf",
          ],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // The document metadata + blob coordinates are persisted by the funding
      // application write; nothing to do here, but the callback is required.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
