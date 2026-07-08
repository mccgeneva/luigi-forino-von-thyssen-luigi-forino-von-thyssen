import { redirect } from "next/navigation"
import { isCurrentSessionAdmin } from "@/lib/admin-auth"

// Server-side authorization gate for the ENTIRE /dashboard/admin subtree
// (the panel itself and every nested route such as /dashboard/admin/swift).
//
// This is the authoritative barrier: the admin area renders only when the real
// actor behind the request is an authorized administrator account. Clients —
// including a client an admin is currently impersonating — are redirected out
// before any admin UI or data is sent. The PIN is a second factor enforced
// inside the panel; this gate enforces the role.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await isCurrentSessionAdmin()
  if (!admin) redirect("/dashboard")
  return <>{children}</>
}
