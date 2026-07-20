// Plain, client-safe shared types for the biometric (Face ID) feature.
// Kept separate from `lib/biometric-db.ts` (which is `server-only`) and from the
// `"use server"` actions file so the type can be imported by client components
// without dragging in server-only code or breaking the server-actions module
// (a `"use server"` file must only export async functions — never types).

/** Lightweight enrollment status for UI and login gating (no descriptor data). */
export interface FaceState {
  enrolled: boolean
  locked: boolean
  failCount: number
  enrolledAt: string | null
  /** When the lock was applied, used to auto-clear it after the cooldown. */
  lockedAt: string | null
}

/**
 * Identity-verification status for a user (passport + selfie gate). Contains
 * only non-sensitive summary fields safe to compute for login gating — never
 * the passport image or any face descriptor.
 */
export interface IdentityStatus {
  verified: boolean
  verifiedAt: string | null
  country: string | null
  fullName: string | null
  /** Last 4 chars of the passport number, for display/audit only. */
  passportLast4: string | null
}
