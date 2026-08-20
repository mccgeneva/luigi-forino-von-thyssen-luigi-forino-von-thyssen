import { type NextRequest, NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { verifyAdminPin } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"
import { LOAN_UPLOAD_CONTENT_TYPES, LOAN_UPLOAD_MAX_BYTES } from "@/lib/internal-loan"

// Browser → Blob direct-upload token endpoint for internal-loan negotiation
// attachments. Uploading straight from the browser keeps large document
// payloads out of our serverless functions (which have a ~4.5 MB body limit).
//
// Two authorised callers share this route:
//   • the ADMINISTRATOR — authorised by the admin PIN passed in clientPayload
//     (the token request does not carry the admin session), and
//   • the BORROWER — authorised by a valid signed-in session (cookie), so a
//     customer can upload their own supporting documents.
// The written path is constrained to "internal-loan/" for both.
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

        const isAdmin = verifyAdminPin(passcode)
        // Client path: a valid session cookie authorises the borrower.
        let isClient = false
        if (!isAdmin) {
          const session = await resolveCurrentSession().catch(() => null)
          isClient = Boolean(session?.id)
        }
        if (!isAdmin && !isClient) {
          throw new Error("Unauthorized")
        }
        if (!pathname.startsWith("internal-loan/")) {
          throw new Error("Invalid upload path")
        }
        return {
          allowedContentTypes: LOAN_UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: LOAN_UPLOAD_MAX_BYTES,
          addRandomSuffix: true,
        }
      },
      onUploadCompleted: async () => {},
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload authorization failed."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
