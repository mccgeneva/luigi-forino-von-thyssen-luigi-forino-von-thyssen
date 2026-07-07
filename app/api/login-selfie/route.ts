import { type NextRequest, NextResponse } from "next/server"
import { get } from "@vercel/blob"
import { resolveCurrentSession } from "@/lib/session-user"

// Blob access + session resolution require the Node.js runtime.
export const runtime = "nodejs"

// Serves login-selfie snapshots for the admin security-audit panel. A selfie is
// sensitive biometric data, so this route:
//   1. requires a valid signed-in session, and
//   2. only serves pathnames under the "login-selfies/" prefix.
// The pathnames themselves are unguessable and are surfaced to the UI only
// through the passcode-gated security-audit server actions, so the raw Blob URL
// is never exposed in the app.
export async function GET(request: NextRequest) {
  const session = await resolveCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const pathname = request.nextUrl.searchParams.get("pathname")
  if (!pathname || !pathname.startsWith("login-selfies/")) {
    return NextResponse.json({ error: "Invalid pathname" }, { status: 400 })
  }

  try {
    const result = await get(pathname, {
      access: "public",
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    })

    if (!result) {
      return new NextResponse("Not found", { status: 404 })
    }

    if (result.statusCode === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: result.blob.etag, "Cache-Control": "private, no-cache" },
      })
    }

    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.blob.contentType,
        ETag: result.blob.etag,
        "Cache-Control": "private, no-cache",
      },
    })
  } catch (error) {
    console.error("[v0] Error serving login selfie:", error)
    return NextResponse.json({ error: "Failed to serve selfie" }, { status: 500 })
  }
}
