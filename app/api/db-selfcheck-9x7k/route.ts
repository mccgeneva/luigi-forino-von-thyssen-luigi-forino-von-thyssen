import { NextResponse } from "next/server"
import { query, getConnectionString, isDatabaseConfigured } from "@/lib/db"

// TEMPORARY diagnostic. Returns only safe metadata (no secrets, no PII) so we can
// see what the PRODUCTION runtime actually sees when it queries admin_users.
// Delete after use.
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function maskHost(): string {
  const cs = getConnectionString() || ""
  const m = cs.match(/@([^/:?]+)/)
  const db = cs.match(/\/([^/?]+)(\?|$)/)
  return `${m ? m[1] : "?"} db=${db ? db[1] : "?"}`
}

export async function GET() {
  const out: Record<string, unknown> = {
    configured: isDatabaseConfigured,
    target: maskHost(),
    nodeEnv: process.env.NODE_ENV,
  }
  try {
    const conn = await query(
      "SELECT current_database() db, current_user usr, current_schema() schema",
    )
    out.connection = conn.rows[0]
    const sp = await query("SHOW search_path")
    out.searchPath = sp.rows[0]
    const tabs = await query(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 'admin_users' ORDER BY table_schema",
    )
    out.adminUsersTables = tabs.rows.map((r) => (r as { table_schema: string }).table_schema)
    const cnt = await query("SELECT count(*)::int n FROM admin_users")
    out.adminUsersCount = (cnt.rows[0] as { n: number }).n
    const pub = await query("SELECT count(*)::int n FROM public.admin_users")
    out.publicAdminUsersCount = (pub.rows[0] as { n: number }).n
    out.ok = true
  } catch (err) {
    out.ok = false
    out.error = (err as Error)?.message
  }
  return NextResponse.json(out)
}
