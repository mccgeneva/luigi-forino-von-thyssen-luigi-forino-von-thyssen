import { type NextRequest, NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listKycDocuments } from "@/lib/kyc-documents-db"
import { getIdentityStatus, getAdminIdentityDetails } from "@/lib/biometric-db"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { profileDocId } from "@/lib/security-audit-service"
import { analyzeDocumentCompliance, synthesizeKycVerdict } from "@/lib/kyc-analyze"
import type { DocComplianceAnalysis, DossierAnalysis, KycDocument, UploadedKycDocument } from "@/lib/kyc-types"

// Admin Security Audit — AI analysis of every KYC document on file, used to
// enrich the "Generate report" dossier. Reads each document (image or PDF)
// through a multimodal model, extracts key fields, checks consistency against
// the identity on record, flags risks, then synthesises an overall KYC verdict.
//
// Route Handler (NOT a Server Action): Server Actions are silently rejected on
// this app's production domains. Node runtime for Blob reads; extended duration
// because a full pack means several sequential model calls.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Hard cap so an unusually large pack can't run indefinitely / blow the budget.
// Covers the retained passport image + admin-uploaded docs + onboarding-PDF
// profile documents (company extract, proof of address, …).
const MAX_DOCS = 24
// Small concurrency: fast enough, but avoids hammering the gateway rate limits.
const CONCURRENCY = 3

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export async function POST(req: NextRequest) {
  const passcode = req.headers.get("x-admin-passcode") ?? req.nextUrl.searchParams.get("p") ?? ""
  if (!(await adminActionAuthorized(passcode))) {
    return NextResponse.json({ ok: false, error: "Administrator authorization failed." }, { status: 401 })
  }

  let body: { userId?: string }
  try {
    body = (await req.json()) as { userId?: string }
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 })
  }
  const userId = body.userId ?? ""
  if (!userId) {
    return NextResponse.json({ ok: false, error: "No account selected." }, { status: 400 })
  }

  try {
    const [docs, identity, adminIdentity, user] = await Promise.all([
      listKycDocuments(userId).catch(() => [] as UploadedKycDocument[]),
      getIdentityStatus(userId),
      getAdminIdentityDetails(userId),
      getDynamicUserById(userId).catch(() => undefined),
    ])
    const profileDocs = (user?.profile?.kycDocuments ?? []) as KycDocument[]

    const identityCtx = {
      fullName: identity.fullName || "",
      country: identity.country || "",
    }

    // Build the analysis targets: the retained passport image (if any) first,
    // then every uploaded KYC document, capped for safety.
    type Target = { id: string; label: string; filename: string; pathname: string; contentType: string; isImage: boolean }
    const targets: Target[] = []
    if (adminIdentity.passportImagePath) {
      targets.push({
        id: "passport-image",
        label: "Retained passport image",
        filename: "passport.jpg",
        pathname: adminIdentity.passportImagePath,
        contentType: "image/jpeg",
        isImage: true,
      })
    }
    for (const d of docs) {
      targets.push({
        id: d.id,
        label: d.label,
        filename: d.filename,
        pathname: d.pathname,
        contentType: d.contentType,
        isImage: d.isImage,
      })
    }
    // Onboarding-PDF documents stored on the client profile (company extract
    // certificate, proof of address, …) — rendered page images in Blob.
    for (const d of profileDocs) {
      if (!d.pathname) continue
      targets.push({
        id: profileDocId(d.pathname),
        label: d.label || d.type,
        filename: `page ${d.pageNumber || "?"}`,
        pathname: d.pathname,
        contentType: "image/jpeg",
        isImage: true,
      })
    }

    const capped = targets.slice(0, MAX_DOCS)
    const skippedCount = targets.length - capped.length

    const analyses: DocComplianceAnalysis[] = await mapWithConcurrency(capped, CONCURRENCY, (t) =>
      analyzeDocumentCompliance(t, identityCtx),
    )

    const verdict = await synthesizeKycVerdict(
      {
        fullName: identity.fullName || "",
        country: identity.country || "",
        verified: identity.verified,
        passportNo: adminIdentity.passportNo,
      },
      analyses,
    )

    const payload: DossierAnalysis = {
      analyzedAt: new Date().toISOString(),
      documents: analyses,
      verdict,
      skippedCount: skippedCount > 0 ? skippedCount : undefined,
    }
    return NextResponse.json({ ok: true, data: payload })
  } catch (err) {
    console.log("[v0] /api/admin/audit/analyze-documents failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: "Could not analyse the documents for this account." },
      { status: 500 },
    )
  }
}
