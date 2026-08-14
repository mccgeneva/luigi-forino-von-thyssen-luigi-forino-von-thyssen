import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  getAccountLimits,
  hasAccountLimitsOverride,
  saveAccountLimits,
  clearAccountLimits,
  GLOBAL_ACCOUNT_LIMITS_ID,
  type AccountLimits,
} from "@/lib/account-limits-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Admin account-limits API.
 *
 * This endpoint deliberately lives under /api (NOT behind the /dashboard proxy)
 * so it is reached with a plain fetch that returns real JSON. The equivalent
 * Server Actions POST to /dashboard/* and are intercepted by the proxy, which
 * 401s them whenever it judges the session's signed meta cookie stale/idle —
 * even though the underlying admin identity (resolved from the session token in
 * the DB) is still valid. That mismatch was why the client picker came back
 * empty: the action was blocked before it ran and its error was swallowed.
 *
 * It talks to the `lib/*` data modules directly (plain `server-only` modules),
 * NOT the `"use server"` action wrappers, so nothing in the action-module graph
 * can break this route's server bundle at load time. Authorization is enforced
 * here via `adminActionAuthorized` (admin PIN + server-side admin-session check).
 */

type SavePayload = {
  op: "save"
  pin: string
  targetId: string
  targetName?: string
  dailyLimitAmount: number
  dailyLimitUnlimited: boolean
  monthlyVolumeAmount: number
  monthlyVolumeUnlimited: boolean
  currency: string
}
type ClearPayload = { op: "clear"; pin: string; targetId: string; targetName?: string }
type LoadPayload = { op: "load"; pin: string; targetId: string }

/** The selectable-client shape the panel expects (mirrors SelectableClient in
 *  app/actions/admin-users.ts). */
type SelectableClient = {
  id: string
  fullName: string
  company: string
  email: string
  kind: "dynamic"
}

/** Build the client picker list from active dynamic users — identical mapping
 *  to listSelectableClients in app/actions/admin-users.ts. */
async function buildClientList(): Promise<SelectableClient[]> {
  const users = await listDynamicUsers()
  return users
    .filter((u) => u.status === "active")
    .map((u) => ({
      id: u.id,
      fullName: u.profile.fullName,
      company: u.profile.company,
      email: u.email,
      kind: "dynamic" as const,
    }))
}

async function limitsForTarget(
  targetId: string,
): Promise<{ limits: AccountLimits; hasOverride: boolean }> {
  const isGlobal = !targetId || targetId === GLOBAL_ACCOUNT_LIMITS_ID
  const limits = await getAccountLimits(isGlobal ? undefined : targetId)
  const hasOverride = isGlobal ? false : await hasAccountLimitsOverride(targetId)
  return { limits, hasOverride }
}

export async function POST(req: Request) {
  let body: SavePayload | ClearPayload | LoadPayload
  try {
    body = (await req.json()) as SavePayload | ClearPayload | LoadPayload
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""

  try {
    // Single server-side authorization gate for every operation.
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", clients: [] }, { status: 200 })
    }

    if (body.op === "load") {
      const [clients, { limits, hasOverride }] = await Promise.all([
        buildClientList(),
        limitsForTarget(body.targetId),
      ])
      return NextResponse.json({ ok: true, clients, limits, hasOverride })
    }

    if (body.op === "save") {
      const targetId = body.targetId || GLOBAL_ACCOUNT_LIMITS_ID
      const limits = await saveAccountLimits(targetId, {
        dailyLimitAmount: Number(body.dailyLimitAmount) || 0,
        dailyLimitUnlimited: !!body.dailyLimitUnlimited,
        monthlyVolumeAmount: Number(body.monthlyVolumeAmount) || 0,
        monthlyVolumeUnlimited: !!body.monthlyVolumeUnlimited,
        currency: (body.currency || "EUR").toUpperCase(),
      })
      return NextResponse.json({ ok: true, limits })
    }

    if (body.op === "clear") {
      if (!body.targetId || body.targetId === GLOBAL_ACCOUNT_LIMITS_ID) {
        return NextResponse.json({ ok: false, error: "Select a specific user to reset." }, { status: 200 })
      }
      await clearAccountLimits(body.targetId)
      const limits = await getAccountLimits(body.targetId) // now resolves to the global default
      return NextResponse.json({ ok: true, limits })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? "Request failed." },
      { status: 200 },
    )
  }
}
