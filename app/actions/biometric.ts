"use server"

import { clearEnrollment } from "@/lib/biometric-db"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { logActivity } from "@/app/actions/log-activity"

// NOTE: Self-service enroll / status / disable used to live here as Server
// Actions (`getMyFaceState`, `enrollMyFace`, `disableMyFace`). They were moved
// to the Route Handler `app/api/biometric/route.ts` because Server Action POSTs
// are silently rejected on this app's production domains + mobile in-app
// webviews, which left the profile "Set up Face ID" flow hanging forever on
// "Securing your biometric profile…". Do NOT reintroduce them as Server Actions.

/**
 * Administrator resets a user's biometric enrollment — the recovery path when a
 * client is locked out of face login. Clears the descriptor and lock state so
 * the user can sign in with their password and re-enroll. Admin-only.
 */
export async function adminResetUserFace(
  passcode: string,
  userId: string,
  adminName?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (String(passcode) !== ADMIN_PASSCODE) {
    return { ok: false, error: "Administrator authorization failed." }
  }
  const target = await getDynamicUserById(userId)
  if (!target) return { ok: false, error: "User not found." }

  await clearEnrollment(userId)
  await logActivity({
    action: "Administrator reset client Face ID",
    category: "Authentication / Security",
    user: adminName || "Administrator",
    details: {
      account: target.profile.fullName || target.email,
      email: target.email,
      result: "biometric enrollment cleared — user may re-enroll",
    },
  })
  return { ok: true }
}
