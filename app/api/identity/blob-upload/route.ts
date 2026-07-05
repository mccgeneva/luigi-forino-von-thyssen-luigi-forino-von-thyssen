import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { verifyChallenge } from "@/lib/biometric"

// Token endpoint for browser → Blob direct uploads of the passport image used by
// the login identity-verification gate. Uploading straight from the browser to
// Blob keeps the image payload out of our serverless function (which has a
// ~4.5 MB request-body limit). Access is gated by the short-lived signed login
// challenge issued after the password step — so only a user who just passed the
// password check can upload, without needing the admin passcode.
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // The client passes the login challenge token via clientPayload; it
        // proves the password step passed and expires quickly.
        let challenge: string | undefined
        try {
          challenge = clientPayload ? (JSON.parse(clientPayload) as { challenge?: string }).challenge : undefined
        } catch {
          challenge = undefined
        }
        if (!verifyChallenge(challenge)) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("identity/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png"],
          maximumSizeInBytes: 15 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // Required by the API; the verify action consumes (and then deletes) the blob.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
