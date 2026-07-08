import { NextResponse } from "next/server"
import { del } from "@vercel/blob"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { addKycDocument, listKycDocuments, deleteKycDocument } from "@/lib/kyc-documents-db"
import { normalizeUploadedKycType } from "@/lib/kyc-types"
import { logActivity } from "@/app/actions/log-activity"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ADMIN-ONLY KYC document management for the Security Audit tool.
//
// Implemented as Route Handlers (not Server Actions) because Server Actions are
// silently rejected on this app's production domains (apex -> www redirect,
// custom domains, in-app webviews). Passcode via `x-admin-passcode` header or
// `?p=` query; every method returns 401 on mismatch.
//
// The file bytes are uploaded straight from the admin's browser to Blob through
// the existing token route /api/kyc/blob-upload (also passcode-gated). These
// handlers only manage the authoritative audit-trail rows in Neon.

async function authed(req: Request): Promise<boolean> {
  const url = new URL(req.url)
  const passcode = req.headers.get("x-admin-passcode") || url.searchParams.get("p") || ""
  return adminActionAuthorized(passcode)
}

/** GET ?userId= → list a client's uploaded KYC documents. */
export async function GET(req: Request) {
  if (!(await authed(req))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  const userId = new URL(req.url).searchParams.get("userId") || ""
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Missing userId." }, { status: 400 })
  }
  try {
    const documents = await listKycDocuments(userId)
    return NextResponse.json({ ok: true, documents })
  } catch (err) {
    console.log("[v0] list KYC documents failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not load documents." }, { status: 500 })
  }
}

/** POST → record a freshly-uploaded document (after the browser→Blob upload). */
export async function POST(req: Request) {
  if (!(await authed(req))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  const body = (await req.json().catch(() => null)) as {
    userId?: string
    type?: string
    filename?: string
    contentType?: string
    sizeBytes?: number
    pathname?: string
  } | null

  const userId = body?.userId || ""
  const pathname = body?.pathname || ""
  if (!userId || !pathname) {
    return NextResponse.json({ ok: false, error: "Missing userId or file." }, { status: 400 })
  }
  // The blob-upload token route already restricts uploads to the `kyc/` prefix;
  // enforce it here too so a stray record can't point elsewhere.
  if (!pathname.startsWith("kyc/")) {
    return NextResponse.json({ ok: false, error: "Invalid document path." }, { status: 400 })
  }

  const target = await getDynamicUserById(userId)
  if (!target) {
    return NextResponse.json({ ok: false, error: "User not found." }, { status: 404 })
  }

  try {
    const doc = await addKycDocument({
      userId,
      type: normalizeUploadedKycType(body?.type),
      filename: body?.filename || "",
      contentType: body?.contentType || "",
      sizeBytes: body?.sizeBytes || 0,
      pathname,
    })
    await logActivity({
      action: "Administrator uploaded a KYC document",
      category: "Documents / Compliance",
      user: "Administrator",
      details: {
        account: target.profile.fullName || target.email,
        email: target.email,
        document: `${doc.label} — ${doc.filename}`,
      },
    })
    return NextResponse.json({ ok: true, document: doc })
  } catch (err) {
    console.log("[v0] record KYC document failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not save the document." }, { status: 500 })
  }
}

/** DELETE ?id= → remove a document row and its Blob file. */
export async function DELETE(req: Request) {
  if (!(await authed(req))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }
  const id = new URL(req.url).searchParams.get("id") || ""
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing document id." }, { status: 400 })
  }
  try {
    const removed = await deleteKycDocument(id)
    if (removed?.pathname) {
      try {
        await del(removed.pathname)
      } catch {
        // Best-effort: a leftover blob is harmless; the audit row is already gone.
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.log("[v0] delete KYC document failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "Could not delete the document." }, { status: 500 })
  }
}
