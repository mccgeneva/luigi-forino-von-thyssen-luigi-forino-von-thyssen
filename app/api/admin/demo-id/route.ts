import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDemoIdSubmissions } from "@/lib/demo-id-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admin demo-account ID-log API.
 *
 * Lists the ID documents (OCR-identified) uploaded by visitors when logging into
 * the shared demo account, together with their captured IP and GPS. Lives under
 * /api (NOT behind the /dashboard proxy) and talks to the `lib/*` data module
 * directly, mirroring the account-limits admin route — a Server Action here
 * would be silently 401'd by the proxy on a stale meta cookie in the preview
 * iframe. Authorization is the admin PIN + server-side admin-session check.
 */
export async function POST(req: Request) {
  let body: { pin?: string }
  try {
    body = (await req.json()) as { pin?: string }
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body.", submissions: [] }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", submissions: [] }, { status: 200 })
    }
    const submissions = await listDemoIdSubmissions(200)
    return NextResponse.json({ ok: true, submissions })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? "Request failed.", submissions: [] },
      { status: 200 },
    )
  }
}
