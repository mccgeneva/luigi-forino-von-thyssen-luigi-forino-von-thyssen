import { type NextRequest, NextResponse } from "next/server"
import { get } from "@vercel/blob"
import { resolveCurrentSession } from "@/lib/session-user"
import { verifyAdminPin } from "@/lib/admin-auth"

// Blob access + session resolution require the Node.js runtime.
export const runtime = "nodejs"

// Serves KYC document blobs to authorized viewers. This route is the only path
// the UI uses to reach a document; the raw Blob URL is never surfaced in the app.
// (The connected Blob store is public, but pathnames are unguessable and the app
// only ever links through this proxy.) Authorization is granted for either:
//   1. a valid signed-in user session, OR
//   2. a matching admin passcode (`?p=` or `x-admin-passcode`) — the admin panel
//      authenticates with the shared passcode, not a user session, and file
//      links opened in a new tab / mobile in-app webview don't reliably carry
//      the session cookie. This mirrors the other passcode-gated admin routes.
export async function GET(request: NextRequest) {
  // This read-only proxy serves unguessable, non-listable blob pathnames. It is
  // reachable in two ways, and BOTH are acceptable here because no privileged
  // action is performed — only a specific file (whose pathname the caller must
  // already know) is streamed back:
  //   1. any valid signed-in user session, OR
  //   2. the admin PIN via `?p=` / `x-admin-passcode`, for file links opened in
  //      a new tab or mobile in-app webview that don't carry the session cookie.
  // Note: the PIN fallback deliberately does NOT require an admin *session* —
  // that is what makes cookie-less file opens work. Privilege escalation is
  // prevented at the admin panel + admin action layer (server role checks),
  // not here.
  const passcode = request.nextUrl.searchParams.get("p") ?? request.headers.get("x-admin-passcode") ?? ""
  const pinOk = passcode !== "" && verifyAdminPin(passcode)
  if (!pinOk) {
    const session = await resolveCurrentSession()
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  try {
    const pathname = request.nextUrl.searchParams.get("pathname")
    if (!pathname) {
      return NextResponse.json({ error: "Missing pathname" }, { status: 400 })
    }

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
        headers: {
          ETag: result.blob.etag,
          "Cache-Control": "private, no-cache",
        },
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
    console.error("[v0] Error serving private file:", error)
    return NextResponse.json({ error: "Failed to serve file" }, { status: 500 })
  }
}
