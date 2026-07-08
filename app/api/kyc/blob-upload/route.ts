import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { verifyAdminPin } from "@/lib/admin-auth"

// Token endpoint for browser → Blob direct uploads. Uploading the page images
// straight from the admin's browser to Blob keeps the (large) image payload out
// of our serverless function, which has a strict ~4.5 MB request-body limit that
// a multi-page KYC pack would otherwise blow past.
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Gate uploads behind the admin passcode, passed via clientPayload.
        let passcode: string | undefined
        try {
          passcode = clientPayload ? (JSON.parse(clientPayload) as { passcode?: string }).passcode : undefined
        } catch {
          passcode = undefined
        }
        // The upload token request does not carry the admin session cookie, so
        // authorize on the admin PIN (passed in clientPayload). The uploaded
        // path is constrained to "kyc/" below.
        if (!verifyAdminPin(passcode)) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("kyc/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "application/pdf"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: false,
        }
      },
      // Required by the API; the analyze step is what actually consumes the blobs.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
