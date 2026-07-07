import pg from "pg"
const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } })

const db = await pool.query("SELECT current_database() db, current_schema() schema, current_user usr")
console.log("[v0] connection:", db.rows[0])

const tabs = await pool.query(
  `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'admin_users' ORDER BY table_schema`,
)
console.log("[v0] tables named admin_users:", tabs.rows)

const sp = await pool.query("SHOW search_path")
console.log("[v0] search_path:", sp.rows[0])

const cnt = await pool.query("SELECT count(*)::int n FROM admin_users")
console.log("[v0] count(*) FROM admin_users:", cnt.rows[0].n)

const emails = await pool.query("SELECT email, status, created_at FROM admin_users ORDER BY created_at DESC")
console.log("[v0] rows:")
for (const r of emails.rows) console.log("   ", r.email, "|", r.status, "|", r.created_at?.toISOString?.() ?? r.created_at)

await pool.end()
