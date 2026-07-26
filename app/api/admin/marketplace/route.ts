import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  getAdminMarketplaceInstruments,
  publishInstrument,
  updateInstrument,
  enrichInstrumentFromIsin,
  setInstrumentAvailability,
  removeInstrument,
  type PublishInstrumentInput,
  type UpdateInstrumentInput,
} from "@/app/actions/marketplace-instruments"

// ---------------------------------------------------------------------------
// Admin marketplace operations via a Route Handler (NOT Server Actions).
//
// Next.js validates Server Action POSTs against the forwarded Origin/Host. On
// this app's production domains (apex -> www redirect, custom domains) and
// inside mobile in-app webviews, that check can SILENTLY reject the action —
// which made "Publish instrument" fail with a generic error and left the admin
// unable to publish. Route Handlers are exempt from that check, so they work
// identically on every domain. This mirrors the same fix already applied to
// /api/admin/users and activity logging. The business logic still lives in the
// passcode-gated Server Action functions; we just invoke them from here.
// ---------------------------------------------------------------------------
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  try {
    return NextResponse.json(await getAdminMarketplaceInstruments(passcode))
  } catch (err) {
    console.log("[v0] /api/admin/marketplace GET failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not load the instrument catalogue." }, { status: 500 })
  }
}

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
      case "publish":
        return NextResponse.json(await publishInstrument(passcode, body.input as PublishInstrumentInput))
      case "update":
        return NextResponse.json(await updateInstrument(passcode, body.input as UpdateInstrumentInput))
      case "enrich":
        return NextResponse.json(await enrichInstrumentFromIsin(passcode, String(body.isin || "")))
      case "availability":
        return NextResponse.json(
          await setInstrumentAvailability(passcode, String(body.id), Boolean(body.available)),
        )
      case "remove":
        return NextResponse.json(await removeInstrument(passcode, String(body.id)))
      default:
        return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    console.log("[v0] /api/admin/marketplace POST failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "The request could not be completed. Please try again." },
      { status: 500 },
    )
  }
}
