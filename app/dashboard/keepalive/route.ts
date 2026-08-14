import { NextResponse } from "next/server"

// Session keepalive endpoint.
//
// This route exists so the CLIENT can keep an actively-used session alive on
// the SERVER. The server's idle window (the signed `seen` timestamp in the
// session-meta cookie) is only slid forward by the proxy on GET navigations —
// NOT on Server Action POSTs. Single-page areas like the Administrator panel
// interact almost entirely through Server Actions, so without this a user who
// is actively working (but not navigating between pages) would have their
// server session silently idle-expire after 15 minutes and get locked out
// mid-task ("Your session has expired").
//
// A plain GET here passes through the `/dashboard/:path*` proxy, which — for a
// valid session — re-issues the session cookies with a refreshed idle window.
// If the session is already gone the proxy redirects/again rejects, and the
// client's SessionGuard handles the real expiry. This endpoint itself does no
// work: the cookie sliding is entirely the proxy's job.
export const dynamic = "force-dynamic"

export function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    },
  })
}
