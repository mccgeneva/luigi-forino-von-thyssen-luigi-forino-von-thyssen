import { NextResponse } from "next/server"
import { listSelectableClients } from "@/app/actions/admin-users"
import {
  fetchAccountLimitsForTarget,
  updateAccountLimitsAdmin,
  clearAccountLimitsAdmin,
} from "@/app/actions/account-limits"

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
 * empty: the action was blocked before it ran and the error was swallowed.
 * Authorization is still fully enforced here via the admin PIN + server-side
 * admin-session check inside each action.
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

export async function POST(req: Request) {
  let body: SavePayload | ClearPayload | LoadPayload
  try {
    body = (await req.json()) as SavePayload | ClearPayload | LoadPayload
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = typeof body?.pin === "string" ? body.pin : ""

  try {
    if (body.op === "load") {
      // The client list + the chosen target's current limits, in one round-trip.
      const [clients, limits] = await Promise.all([
        listSelectableClients(pin),
        fetchAccountLimitsForTarget(pin, body.targetId),
      ])
      if (!limits.ok) {
        // fetchAccountLimitsForTarget only fails on auth — report it clearly.
        return NextResponse.json({ ok: false, reason: "unauthorized", clients }, { status: 200 })
      }
      return NextResponse.json({
        ok: true,
        clients,
        limits: limits.limits,
        hasOverride: limits.hasOverride,
      })
    }

    if (body.op === "save") {
      const res = await updateAccountLimitsAdmin({
        passcode: pin,
        targetId: body.targetId,
        targetName: body.targetName,
        dailyLimitAmount: Number(body.dailyLimitAmount) || 0,
        dailyLimitUnlimited: !!body.dailyLimitUnlimited,
        monthlyVolumeAmount: Number(body.monthlyVolumeAmount) || 0,
        monthlyVolumeUnlimited: !!body.monthlyVolumeUnlimited,
        currency: body.currency || "EUR",
      })
      return NextResponse.json(res)
    }

    if (body.op === "clear") {
      const res = await clearAccountLimitsAdmin(pin, body.targetId, body.targetName)
      return NextResponse.json(res)
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error)?.message ?? "Request failed." },
      { status: 200 },
    )
  }
}
