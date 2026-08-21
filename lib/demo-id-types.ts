// ---------------------------------------------------------------------------
// Client-safe types for demo-account identity submissions.
//
// The shared demo account (demo@mccgva.ch) logs in WITHOUT facial recognition:
// each visitor must instead upload a photo/screenshot of a valid ID document,
// which is OCR-read to identify who is testing the platform and stored — along
// with the visitor's IP and (if granted) GPS position — for administrator
// inspection. This type is imported by both the server store and the admin UI,
// so it MUST stay free of any `server-only` imports.
// ---------------------------------------------------------------------------

export interface DemoIdSubmission {
  id: string
  createdAt: string
  /** Blob pathname of the retained ID image (served via the passport-image proxy). */
  docPathname: string
  docContentType: string
  /** OCR-detected document kind, e.g. "Passport", "National ID", "Driver's licence". */
  docType: string
  /** OCR-detected holder name. */
  fullName: string
  /** OCR-detected document / passport number. */
  docNumber: string
  /** OCR-detected issuing country. */
  country: string
  /** Client IP captured server-side at submission time. */
  ip: string | null
  userAgent: string | null
  /** Best-effort GPS captured client-side (null when the visitor denied it). */
  gpsLat: number | null
  gpsLng: number | null
  gpsAccuracy: number | null
}
