import { NextResponse } from "next/server"
import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  listCashbackRules,
  getResolvedCashbackForUser,
  saveCashbackRule,
  deleteCashbackRule,
} from "@/lib/fee-cashback-db"
import { isCashbackProduct, normalizeCashbackRate, type CashbackProduct } from "@/lib/fee-cashback"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admin-controlled fee CASHBACK API. A plain API route (NOT behind the
 * /dashboard proxy) so client fee previews can always read the LIVE resolved
 * cashback for the signed-in user, and a stale meta cookie can't 401 it.
 *
 *   • GET  — the signed-in user's RESOLVED cashback rate per product (for
 *            client-side fee previews). Never sensitive.
 *   • POST — admin (PIN + admin session): op `list` (rules + client roster),
 *            `save` (upsert a rule), `delete` (remove a rule scope).
 */
export async function GET() {
  try {
    const session = await resolveCurrentSession()
    if (!session?.id) {
      return NextResponse.json(
        { ok: true, cashback: { transaction: 0, instrument: 0, swift: 0, platform: 0 } },
        { status: 200 },
      )
    }
    // Cashback is resolved against the DATA OWNER (master) — the per-account unit.
    const ownerId = await resolveDataOwnerIdFor(session.id)
    const cashback = await getResolvedCashbackForUser(ownerId)
    return NextResponse.json({ ok: true, cashback }, { status: 200 })
  } catch {
    return NextResponse.json(
      { ok: true, cashback: { transaction: 0, instrument: 0, swift: 0, platform: 0 } },
      { status: 200 },
    )
  }
}

export async function POST(req: Request) {
  let body: {
    pin?: string
    op?: string
    userId?: string | null
    product?: string | null
    rate?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""
  const op = String(body?.op ?? "")

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", rules: [], clients: [] }, { status: 200 })
    }

    if (op === "list") {
      const [rules, users] = await Promise.all([listCashbackRules(), listDynamicUsers()])
      const clients = users
        .filter((u) => u.status === "active")
        .map((u) => ({
          id: u.id,
          fullName: u.profile.fullName,
          company: u.profile.company,
          email: u.email,
        }))
      return NextResponse.json({ ok: true, rules, clients }, { status: 200 })
    }

    // Normalize scope: empty string / "all" / "global" → wildcard (null).
    const rawUser = body.userId
    const userId = rawUser && rawUser !== "global" ? String(rawUser) : null
    const rawProduct = body.product
    const product: CashbackProduct | null = isCashbackProduct(rawProduct) ? rawProduct : null

    if (op === "save") {
      const rate = normalizeCashbackRate(body.rate)
      const rule = await saveCashbackRule(userId, product, rate)
      return NextResponse.json({ ok: true, rule }, { status: 200 })
    }

    if (op === "delete") {
      await deleteCashbackRule(userId, product)
      return NextResponse.json({ ok: true }, { status: 200 })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error)?.message ?? "Request failed." }, { status: 200 })
  }
}
