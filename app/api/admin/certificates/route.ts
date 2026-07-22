import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  adminListPendingCertificates,
  adminListCertificateRequests,
  adminDecideCertificate,
  adminReissueCertificate,
} from "@/app/actions/certificates"

// ---------------------------------------------------------------------------
// Admin certificate operations via a Route Handler (NOT direct Server Actions).
//
// The client's request DID persist to Neon, but the administrator panel called
// the admin server actions directly from the browser and swallowed any failure
// (`.catch(() => {})`), so a rejected/again Server Action POST left the approval
// queue silently empty — the admin saw "nothing to approve" while a pending
// request existed. Next.js validates Server Action POSTs against the forwarded
// Origin/Host, which can silently reject on this app's production domains and
// mobile in-app webviews. Route Handlers are exempt, so they behave identically
// everywhere. This mirrors the same fix already applied to /api/admin/users and
// /api/admin/marketplace. Business logic still lives in the passcode-gated
// Server Action functions; we only invoke them from here.
// ---------------------------------------------------------------------------
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// GET /api/admin/certificates            -> all pending requests (cross-client)
// GET /api/admin/certificates?userId=... -> a single client's full request set
export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  try {
    const userId = req.nextUrl.searchParams.get("userId")
    if (userId) {
      return NextResponse.json(await adminListCertificateRequests(passcode, userId))
    }
    return NextResponse.json(await adminListPendingCertificates(passcode))
  } catch (err) {
    console.log("[v0] /api/admin/certificates GET failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not load certificate requests." }, { status: 500 })
  }
}

// POST /api/admin/certificates  -> { action: "decide" | "reissue", ... }
export async function POST(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }

  const action = String(body.action || "")

  try {
    switch (action) {
      case "decide":
        return NextResponse.json(
          await adminDecideCertificate(
            passcode,
            String(body.id),
            body.mode === "approve" ? "approve" : "reject",
            body.note ? String(body.note) : undefined,
            body.adminName ? String(body.adminName) : undefined,
          ),
        )
      case "reissue":
        return NextResponse.json(
          await adminReissueCertificate(
            passcode,
            String(body.id),
            body.note ? String(body.note) : undefined,
            body.adminName ? String(body.adminName) : undefined,
          ),
        )
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    console.log("[v0] /api/admin/certificates POST failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "The request could not be completed. Please try again." },
      { status: 500 },
    )
  }
}
