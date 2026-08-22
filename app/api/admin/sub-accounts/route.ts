import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  listAllSubAccounts,
  activateSubAccount,
  rejectSubAccount,
  closeSubAccount,
  getSubAccountById,
} from "@/lib/sub-account-db"
import { insertNotification } from "@/lib/notifications-db"
import type { SubAccount } from "@/lib/sub-account-types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Administrator surface for client sub-accounts. Implemented as an /api route
 * (NOT a Server Action) so it is never silently 401'd by the dashboard proxy on
 * a stale meta cookie inside the preview iframe, and it imports the lib/* data
 * modules DIRECTLY rather than the "use server" wrappers (importing a
 * "use server" module into an API route can 500 at load time). Every op is
 * gated once by the admin passcode.
 */

interface ClientLite {
  id: string
  label: string
  email: string
}

function holderFor(sub: SubAccount, clients: ClientLite[]): { holderName: string; holderEmail: string } {
  const c = clients.find((x) => x.id === sub.userId)
  return { holderName: c ? c.label : sub.userId, holderEmail: c ? c.email : "" }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 })
  }

  const pin = typeof body.pin === "string" ? body.pin : ""
  if (!(await adminActionAuthorized(pin))) {
    return NextResponse.json({ ok: false, reason: "unauthorized", subAccounts: [], clients: [] }, { status: 200 })
  }

  const op = typeof body.op === "string" ? body.op : "list"

  try {
    const users = await listDynamicUsers()
    const clients: ClientLite[] = users.map((u) => ({
      id: u.id,
      label: u.profile.fullName || u.profile.company || u.email,
      email: u.email,
    }))

    if (op === "list") {
      const subAccounts = await listAllSubAccounts()
      const enriched = subAccounts.map((s) => ({ ...s, ...holderFor(s, clients) }))
      return NextResponse.json({ ok: true, subAccounts: enriched, clients })
    }

    if (op === "activate") {
      const id = typeof body.id === "string" ? body.id : ""
      const iban = (typeof body.iban === "string" ? body.iban : "").trim().replace(/\s+/g, "").toUpperCase()
      const bic = (typeof body.bic === "string" ? body.bic : "").trim().toUpperCase()
      const adminNote =
        typeof body.note === "string" ? body.note.trim() : typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      if (iban.length < 8) return NextResponse.json({ ok: false, error: "Enter a valid IBAN." })

      const updated = await activateSubAccount(id, { iban, bic: bic || undefined, adminNote: adminNote || undefined })
      if (!updated) return NextResponse.json({ ok: false, error: "That request could not be activated." })

      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Sub-account activated",
        body: `Your ${updated.currency} sub-account "${updated.label}" is active. IBAN ${iban}. You can now move funds into it.`,
        href: "/dashboard/sub-accounts",
      })
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    if (op === "reject") {
      const id = typeof body.id === "string" ? body.id : ""
      const adminNote =
        typeof body.note === "string" ? body.note.trim() : typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      const existing = await getSubAccountById(id)
      const updated = await rejectSubAccount(id, adminNote || undefined)
      if (!updated) return NextResponse.json({ ok: false, error: "That request could not be declined." })
      if (existing) {
        await insertNotification({
          userId: updated.userId,
          tone: "warning",
          title: "Sub-account request declined",
          body: `Your request for the "${updated.label}" sub-account was declined.${adminNote ? ` Note: ${adminNote}` : ""}`,
          href: "/dashboard/sub-accounts",
        })
      }
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    if (op === "close") {
      const id = typeof body.id === "string" ? body.id : ""
      const adminNote = typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      const updated = await closeSubAccount(id, adminNote || undefined)
      if (!updated) return NextResponse.json({ ok: false, error: "That sub-account could not be closed." })
      await insertNotification({
        userId: updated.userId,
        tone: "info",
        title: "Sub-account closed",
        body: `Your sub-account "${updated.label}" has been closed by an administrator.`,
        href: "/dashboard/sub-accounts",
      })
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 })
  } catch (err) {
    console.log("[v0] /api/admin/sub-accounts failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be processed." }, { status: 200 })
  }
}
