import { type NextRequest, NextResponse } from "next/server"
import { resolveCurrentSession } from "@/lib/session-user"
import { encryptDescriptors, isValidDescriptor, DESCRIPTOR_LENGTH } from "@/lib/biometric"
import { getFaceState, saveEncryptedDescriptor, clearEnrollment } from "@/lib/biometric-db"
import type { FaceState } from "@/lib/biometric-types"
import { logActivity } from "@/app/actions/log-activity"

// Session resolution + crypto require the Node.js runtime.
export const runtime = "nodejs"

// ---------------------------------------------------------------------------
// Self-service Face ID enrollment as a ROUTE HANDLER (not a Server Action).
//
// Why: on this app's production domains (apex `mcc-btp.app`, custom domains and
// mobile in-app webviews) Next.js can silently reject Server Action POSTs on the
// Origin/Host check. The previous `enrollMyFace` server action never completed
// there, so the profile "Set up Face ID" flow hung forever on "Securing your
// biometric profile…". Route Handlers under app/api/** are exempt from that
// check, so the enroll/status/disable calls below work on every domain.
//
// A user can only ever act on THEIR OWN account — every handler resolves the
// signed-in session and scopes the DB write to `session.id`.
// ---------------------------------------------------------------------------

/** Current user's own enrollment status (for the profile / security card). */
export async function GET(): Promise<NextResponse> {
  const session = await resolveCurrentSession()
  const empty: FaceState = { enrolled: false, locked: false, failCount: 0, enrolledAt: null }
  if (!session) return NextResponse.json(empty)
  try {
    const state = await getFaceState(session.id)
    return NextResponse.json(state)
  } catch (error) {
    console.error("[v0] Failed to read face state:", error)
    // Fall back to "not enrolled" so the UI can still offer enrollment.
    return NextResponse.json(empty)
  }
}

/** Enroll (or re-enroll) the signed-in user's face from captured descriptors. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await resolveCurrentSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: "You must be signed in to enroll." }, { status: 401 })
  }

  let descriptors: unknown
  try {
    const body = (await request.json()) as { descriptors?: unknown }
    descriptors = body?.descriptors
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }

  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No face samples were captured. Please try again." },
      { status: 400 },
    )
  }
  if (!(descriptors as number[][]).every(isValidDescriptor)) {
    return NextResponse.json(
      { ok: false, error: `Invalid face data (expected ${DESCRIPTOR_LENGTH}-point descriptors).` },
      { status: 400 },
    )
  }

  try {
    const blob = encryptDescriptors(descriptors as number[][])
    await saveEncryptedDescriptor(session.id, blob)
    await logActivity({
      action: "Face ID enrolled",
      category: "Authentication / Security",
      user: session.profile.fullName || session.profile.email,
      details: { samples: (descriptors as number[][]).length, result: "biometric login enabled" },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[v0] Face enrollment failed:", error)
    return NextResponse.json(
      { ok: false, error: "Could not save your biometric profile. Please try again." },
      { status: 500 },
    )
  }
}

/** The signed-in user disables their own Face ID (they remain logged in). */
export async function DELETE(): Promise<NextResponse> {
  const session = await resolveCurrentSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: "You must be signed in." }, { status: 401 })
  }
  try {
    await clearEnrollment(session.id)
    await logActivity({
      action: "Face ID disabled",
      category: "Authentication / Security",
      user: session.profile.fullName || session.profile.email,
      details: { result: "biometric login removed" },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("[v0] Face disable failed:", error)
    return NextResponse.json({ ok: false, error: "Could not disable Face ID. Please try again." }, { status: 500 })
  }
}
