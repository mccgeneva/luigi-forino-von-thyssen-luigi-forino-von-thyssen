import { type NextRequest, NextResponse } from "next/server"
import { get } from "@vercel/blob"
import { resolveCurrentSession } from "@/lib/session-user"
import { ADMIN_PASSCODE } from "@/lib/admin-config"

// Blob access + session resolution require the Node.js runtime.
export const runtime = "nodejs"

// Serves retained passport images for the admin security-audit KYC dossier. A
// passport scan is highly sensitive, so this route:
//   1. requires either a valid signed-in session OR a matching admin passcode
//      (`?p=` / `x-admin-passcode` — the admin panel authenticates with the
//      shared passcode, not a user session, and links opened in a new tab /
//      mobile in-app webview don't reliably carry the session cookie), and
//   2. only serves pathnames under the "identity/" prefix (where passport
//      uploads live).
// The pathnames themselves are unguessable and are surfaced to the UI only
// through the admin-passcode-gated security-audit route, so the raw Blob URL is
// never exposed in the app.
export async function GET(request: NextRequest) {
  const passcode = request.nextUrl.searchParams.get("p") ?? request.headers.get("x-admin-passcode") ?? ""
  const isAdmin = passcode !== "" && passcode === ADMIN_PASSCODE
  if (!isAdmin) {
    const session = await resolveCurrentSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const pathname = request.nextUrl.searchParams.get("pathname")
  if (!pathname || !pathname.startsWith("identity/")) {
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
    console.error("[v0] Error serving passport image:", error)
    return NextResponse.json({ error: "Failed to serve passport image" }, { status: 500 })
  }
}
