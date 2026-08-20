import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  getUserSectionAccess,
  setUserSectionAccess,
  clearUserSectionAccess,
} from "@/lib/section-access-db"
import type { SectionOverride } from "@/lib/dashboard-sections"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admin per-user section-access API.
 *
 * Like the account-limits route, this deliberately lives under /api (NOT behind
 * the /dashboard proxy) and talks to the `lib/*` data modules directly, so a
 * plain fetch returns real JSON and a stale/idle session meta-cookie can never
 * silently 401 the admin panel's data loads. Authorization is enforced here via
 * `adminActionAuthorized` (admin PIN + server-side admin-session check).
 *
 * Operations:
 *  - load  → { clients, access } for the picker + the target's current overrides
 *  - set   → upsert or clear one section override for a user
 *  - clear → remove every override for a user (revert to tier defaults)
 */

type LoadPayload = { op: "load"; pin: string; targetId?: string }
type SetPayload = {
  op: "set"
  pin: string
  targetId: string
  sectionKey: string
  access: SectionOverride | "default"
}
type ClearPayload = { op: "clear"; pin: string; targetId: string }

type SelectableClient = {
  id: string
  fullName: string
  company: string
  email: string
  accountBadge: string
}

/** Active dynamic users, with the tier badge so the panel can show who is a
 *  Visitor (and thus for whom an "unlock" grant is most meaningful). */
async function buildClientList(): Promise<SelectableClient[]> {
  const users = await listDynamicUsers()
  return users
    .filter((u) => u.status === "active")
    .map((u) => ({
      id: u.id,
      fullName: u.profile.fullName,
      company: u.profile.company,
      email: u.email,
      accountBadge: u.profile.accountBadge || "",
    }))
}

export async function POST(req: Request) {
  let body: LoadPayload | SetPayload | ClearPayload
  try {
    body = (await req.json()) as LoadPayload | SetPayload | ClearPayload
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", clients: [] }, { status: 200 })
    }

    if (body.op === "load") {
      const clients = await buildClientList()
      const access = body.targetId ? await getUserSectionAccess(body.targetId) : {}
      return NextResponse.json({ ok: true, clients, access })
    }

    if (body.op === "set") {
      if (!body.targetId) {
        return NextResponse.json({ ok: false, error: "Select a user first." }, { status: 200 })
      }
      if (!body.sectionKey) {
        return NextResponse.json({ ok: false, error: "Missing section." }, { status: 200 })
      }
      const access =
        body.access === "locked" || body.access === "unlocked" || body.access === "default"
          ? body.access
          : "default"
      await setUserSectionAccess(body.targetId, body.sectionKey, access)
      const updated = await getUserSectionAccess(body.targetId)
      return NextResponse.json({ ok: true, access: updated })
    }

    if (body.op === "clear") {
      if (!body.targetId) {
        return NextResponse.json({ ok: false, error: "Select a user first." }, { status: 200 })
      }
      await clearUserSectionAccess(body.targetId)
      return NextResponse.json({ ok: true, access: {} })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? "Request failed." },
      { status: 200 },
    )
  }
}
