import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"

// Token endpoint for browser → Blob direct uploads of SKR supporting documents
// (asset photographs, custodian confirmations, certificates, etc.). Uploading
// straight from the admin's browser keeps potentially large image/PDF payloads
// out of our serverless function (which has a ~4.5 MB request-body limit).
export const runtime = "nodejs"

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // SKR documents may be uploaded by the custody desk (admin passcode) OR
        // by the signed-in client uploading to their own receipts. Authorize if
        // either holds.
        let passcode: string | undefined
        try {
          passcode = clientPayload ? (JSON.parse(clientPayload) as { passcode?: string }).passcode : undefined
        } catch {
          passcode = undefined
        }
        const isAdmin = (await adminActionAuthorized(passcode))
        const session = isAdmin ? null : await resolveCurrentSession()
        if (!isAdmin && !session) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("skr/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "application/pdf",
          ],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
        }
      },
      // The document metadata is persisted by the SKR record write; nothing to do
      // here, but the callback is required by the API.
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
