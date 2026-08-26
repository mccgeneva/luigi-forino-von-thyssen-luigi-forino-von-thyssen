import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { resolveCurrentSession } from "@/lib/session-user"

// Token endpoint for browser → Blob direct uploads of a customer's SWIFT
// printout / bank advice (the source document behind an inbound MT760 etc.).
// Uploading straight from the customer's browser keeps large PDF/image payloads
// out of the serverless function body limit, and gives the administrator the
// original document to verify before booking the guarantee.
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Uploaded by the SIGNED-IN customer against their own inbound message.
        // The token request carries the session cookie (same-origin fetch), so
        // require a valid session and confine writes to the "swift/" prefix.
        const session = await resolveCurrentSession()
        if (!session) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("swift/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // The blob coordinates are persisted by the submit action; nothing to do
      // here, but the callback is required.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
