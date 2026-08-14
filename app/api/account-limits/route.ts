import { NextResponse } from "next/server"
import { resolveCurrentSession } from "@/lib/session-user"
import { getAccountLimits, DEFAULT_ACCOUNT_LIMITS } from "@/lib/account-limits-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Customer-facing read of the EFFECTIVE account limits for the signed-in user:
 * their per-user override if an administrator set one, otherwise the
 * platform-wide default.
 *
 * This is a plain API route ON PURPOSE. The previous implementation read the
 * limits through the `fetchAccountLimits` Server Action, which POSTs to a
 * `/dashboard/*` path and is therefore intercepted by the session proxy — that
 * proxy 401s the request whenever it judges the signed session-meta cookie
 * stale/idle (common in the embedded preview and on a resumed PWA), the client
 * `.catch` swallowed it, and the account card silently fell back to a bare 0
 * with no "Unlimited" flag. `/api/*` is NOT behind that proxy, so this resolves
 * the session directly and always returns real JSON.
 *
 * Account limits are display-only and non-sensitive, so if the session cannot
 * be resolved we still return the GLOBAL default rather than failing — the card
 * must never show a misleading 0.
 */
export async function GET() {
  try {
    const session = await resolveCurrentSession()
    const limits = await getAccountLimits(session?.id ?? undefined)
    return NextResponse.json({ ok: true, limits }, { status: 200 })
  } catch {
    // Never break the account card — fall back to the built-in default.
    return NextResponse.json({ ok: true, limits: { ...DEFAULT_ACCOUNT_LIMITS } }, { status: 200 })
  }
}
