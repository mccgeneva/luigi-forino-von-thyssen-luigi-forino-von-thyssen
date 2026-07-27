// Throwaway debug helper: mint valid session cookie values for the demo user
// so the headless browser can reach auth-gated dashboard pages for CSS
// diagnosis. Prints JSON: { userId, sessionToken, meta }.
import pg from "pg"

const conn =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING
const pool = new pg.Pool({ connectionString: conn, max: 1 })
const { rows } = await pool.query("SELECT id, session_token FROM admin_users WHERE id = 'u3' LIMIT 1")
if (!rows.length) {
  console.error("demo user u3 not found")
  process.exit(1)
}
const { id, session_token } = rows[0]

// Recreate signSessionMeta from lib/session-token.ts (HMAC-SHA256, base64url).
const SECRET = process.env.SESSION_SECRET || "mcc-naftahub-session-signing-key-v1-please-set-SESSION_SECRET"
const enc = new TextEncoder()
const b64url = (bytes) => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const now = Date.now()
const meta = { iat: now, exp: now + 60 * 60 * 8 * 1000, seen: now }
const payload = enc.encode(JSON.stringify(meta))
const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload))
const metaToken = `${b64url(payload)}.${b64url(sig)}`

console.log(JSON.stringify({ userId: id, sessionToken: session_token, meta: metaToken }))
await pool.end()
