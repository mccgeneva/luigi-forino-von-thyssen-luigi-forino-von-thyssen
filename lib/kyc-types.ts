// ---------------------------------------------------------------------------
// Shared, client-safe types for the KYC PDF auto-fill feature.
//
// An administrator uploads a KYC PDF in the "Create client account" dialog. The
// PDF is rendered to per-page images in the browser, uploaded to Vercel Blob,
// and analysed by a multimodal model which (1) extracts the customer's identity
// details to pre-fill the form and (2) classifies each page as a recognisable
// document (passport, ID card, proof of address, …) so it can be stored and
// displayed on the client's profile.
//
// This module holds only plain serialisable types so both client components and
// server code can import it without pulling in any server-only dependency.
// ---------------------------------------------------------------------------

/** Recognised document categories detected inside an uploaded KYC PDF. */
export type KycDocumentType =
  | "passport"
  | "id_card"
  | "drivers_license"
  | "proof_of_address"
  | "bank_statement"
  | "company_registration"
  | "selfie"
  | "other"

/** Human-friendly label for each document type (used in the UI). */
export const KYC_DOCUMENT_LABELS: Record<KycDocumentType, string> = {
  passport: "Passport",
  id_card: "National ID card",
  drivers_license: "Driver's licence",
  proof_of_address: "Proof of address",
  bank_statement: "Bank statement",
  company_registration: "Company registration",
  selfie: "Identity selfie",
  other: "Document",
}

/** A single document image extracted from the KYC PDF and stored in Blob. */
export interface KycDocument {
  /** Blob pathname — served to authenticated users via /api/file. */
  pathname: string
  /** Detected document category. */
  type: KycDocumentType
  /** Specific label the model assigned (e.g. "Passport — bio page"). */
  label: string
  /** 1-based page number in the original PDF. */
  pageNumber: number
}

/** Passport / identity-document fields shown on the profile page. */
export interface KycPassportMeta {
  type: string
  passportNo: string
  surname: string
  givenNames: string
  validUntil: string
  country: string
}

/** Identity fields the model extracts from the KYC pack to pre-fill the form. */
export interface KycExtractedFields {
  fullName: string
  company: string
  role: string
  email: string
  phone: string
  nationality: string
  address: string
  website: string
}

/** The full response returned by POST /api/kyc/analyze. */
export interface KycAnalysisResult {
  fields: KycExtractedFields
  passportMeta: KycPassportMeta | null
  /** Blob pathname of the passport image, if a passport page was detected. */
  passportImagePathname: string | null
  documents: KycDocument[]
  /** Blob pathname of the original uploaded PDF. */
  pdfPathname: string
}

/**
 * Build the authenticated delivery URL for a private Blob pathname.
 *
 * Pass `adminPasscode` when the link is rendered inside the admin panel: the
 * admin is authenticated by the shared passcode (not a user session), and when
 * a file link opens in a new tab / mobile in-app webview the user-session cookie
 * is often not carried, so `/api/file` would otherwise answer `Unauthorized`.
 * The `/api/file` route accepts either a valid session OR a matching `?p=`.
 */
export function blobFileUrl(pathname: string, adminPasscode?: string): string {
  const base = `/api/file?pathname=${encodeURIComponent(pathname)}`
  return adminPasscode ? `${base}&p=${encodeURIComponent(adminPasscode)}` : base
}

// ---------------------------------------------------------------------------
// Admin-uploaded KYC documents (Security Audit).
//
// Separate from the auto-classified `KycDocument` above: these are files an
// administrator uploads directly against a client account (for new or existing
// clients), each stored in Blob with a full audit trail row in Neon. Types kept
// here so both the manager UI and the dossier PDF share one source of truth.
// ---------------------------------------------------------------------------

/** Document categories offered by the admin uploader. */
export type UploadedKycDocType =
  | "passport_id"
  | "face"
  | "company_registration"
  | "utility_bill"
  | "bank_statement"
  | "other"

/** Human-friendly label for each uploader category. */
export const UPLOADED_KYC_DOC_LABELS: Record<UploadedKycDocType, string> = {
  passport_id: "Passport / ID",
  face: "Face / selfie",
  company_registration: "Company registration",
  utility_bill: "Utility bill",
  bank_statement: "Bank statement",
  other: "Other document",
}

/** Display order for the uploader's category selector. */
export const UPLOADED_KYC_DOC_ORDER: UploadedKycDocType[] = [
  "passport_id",
  "face",
  "company_registration",
  "utility_bill",
  "bank_statement",
  "other",
]

/** Normalise an arbitrary string into a known uploader category. */
export function normalizeUploadedKycType(value: string | null | undefined): UploadedKycDocType {
  const v = (value || "").toLowerCase()
  return (UPLOADED_KYC_DOC_ORDER as string[]).includes(v) ? (v as UploadedKycDocType) : "other"
}

/**
 * A single admin-uploaded KYC document (client-safe / serialisable). `pathname`
 * is the private Blob path; use `blobFileUrl(pathname)` for the session-gated
 * delivery URL. `isImage` lets the UI/dossier decide whether to render a picture.
 */
export interface UploadedKycDocument {
  id: string
  userId: string
  type: UploadedKycDocType
  label: string
  filename: string
  contentType: string
  sizeBytes: number
  pathname: string
  isImage: boolean
  uploadedBy: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// AI-enriched KYC analysis (Security Audit "Generate report").
//
// These types are client-safe (imported by the PDF builder and the admin UI).
// The server-only implementation lives in `lib/kyc-analyze.ts`, and the
// passcode-gated Route Handler is `app/api/admin/audit/analyze-documents`.
// ---------------------------------------------------------------------------

export type KycRiskLevel = "low" | "medium" | "high"

/** Compliance analysis of a single uploaded document (one AI pass per file). */
export interface DocComplianceAnalysis {
  /** Matches UploadedKycDocument.id, or "passport-image" for the retained scan. */
  docId: string
  label: string
  filename: string
  /** What the model concluded the document actually is. */
  detectedType: string
  documentNumber: string
  issuingAuthority: string
  issueDate: string
  expiryDate: string
  personName: string
  /** Key extracted values worth showing (name/value pairs). */
  extractedFields: { label: string; value: string }[]
  /** How well the doc matches the identity on file. */
  consistencyNotes: string
  redFlags: string[]
  riskLevel: KycRiskLevel
  summary: string
  /** Set when the document could not be analyzed (unreadable, fetch error…). */
  error?: string
}

/** Overall KYC verdict synthesised across all analysed documents. */
export interface KycVerdict {
  completeness: "complete" | "partial" | "insufficient"
  overallRisk: KycRiskLevel
  presentDocumentTypes: string[]
  missingRecommended: string[]
  keyFindings: string[]
  redFlags: string[]
  narrative: string
}

/** Full analysis payload attached to the dossier PDF. */
export interface DossierAnalysis {
  analyzedAt: string
  documents: DocComplianceAnalysis[]
  verdict: KycVerdict | null
  /** Number of documents that were considered but skipped (over the cap). */
  skippedCount?: number
}
