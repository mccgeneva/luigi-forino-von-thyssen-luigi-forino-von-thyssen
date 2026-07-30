// ---------------------------------------------------------------------------
// One-time SSO hand-off tokens (server-only) — Neon Postgres.
//
// Powers the identity hand-off that lets a trusted external app (NQAi.cloud),
// which has already authenticated its own user, sign that user straight into
// their EXISTING mcc-btp.app account — no second email or password is ever
// created. The login identity is inherited from the bank platform account.
//
// Flow:
//   1. NQAi calls POST /api/v1/sso with an API key (scope "sso") + the user's
//      email. We verify the email maps to an existing, active mcc-btp account
//      and mint a short-lived, single-use token here.
//   2. NQAi redirects the user's browser to /sso?token=<token>. That route
//      consumes the token (atomically, once) and establishes the normal
//      mcc-btp session cookies for that account.
//
// Security model:
//   - Only a SHA-256 HASH of the token is stored, so a database leak cannot
//     yield a usable sign-in token (mirrors the API-key store).
//   - Tokens are single-use: consumption flips `consumed_at` atomically in the
//     same UPDATE that checks validity, so a token cannot be replayed even
//     under a race.
//   - Tokens are short-lived (default 3 minutes) — long enough for a redirect,
//     too short to be useful if intercepted from a log.
// ---------------------------------------------------------------------------

import "server-only"
import { randomBytes, createHash } from "node:crypto"
import { query } from "@/lib/db"

const TOKEN_PREFIX = "nqai_sso_"
/** Default lifetime of a hand-off token. */
const DEFAULT_TTL_MS = 3 * 60 * 1000

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS sso_tokens (
       token_hash   text PRIMARY KEY,
       user_id      text NOT NULL,
       email        text NOT NULL,
       created_by   text,
       created_at   timestamptz NOT NULL DEFAULT now(),
       expires_at   timestamptz NOT NULL,
       consumed_at  timestamptz
     )`,
  )
  ensured = true
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

export interface MintedSsoToken {
  /** The full token — returned ONCE, embedded in the redirect URL, never stored. */
  token: string
  /** ISO timestamp at which the token stops working. */
  expiresAt: string
}

/**
 * Mint a single-use hand-off token for an existing account. Best-effort prunes
 * expired/consumed rows so the table stays small.
 */
export async function createSsoToken(
  userId: string,
  email: string,
  opts?: { createdBy?: string; ttlMs?: number },
): Promise<MintedSsoToken> {
  await ensureTable()
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`
  const tokenHash = sha256(token)
  const ttl = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS
  const expiresAt = new Date(Date.now() + ttl)

  await query(
    `INSERT INTO sso_tokens (token_hash, user_id, email, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [tokenHash, userId, email, opts?.createdBy ?? "", expiresAt.toISOString()],
  )
  // Opportunistic cleanup of tokens that can no longer be used.
  try {
    await query(`DELETE FROM sso_tokens WHERE expires_at < now() - interval '1 hour' OR consumed_at IS NOT NULL`)
  } catch {
    // Cleanup is non-critical; never fail minting over it.
  }
  return { token, expiresAt: expiresAt.toISOString() }
}

export interface ConsumedSsoToken {
  userId: string
  email: string
}

/**
 * Atomically consume a hand-off token. Returns the target account when the
 * token is valid (exists, not expired, not previously consumed) and null
 * otherwise. The single UPDATE both checks validity and marks the token
 * consumed, so it is safe against replay/races.
 */
export async function consumeSsoToken(token: string | null | undefined): Promise<ConsumedSsoToken | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null
  await ensureTable()
  const tokenHash = sha256(token)
  const { rows } = await query(
    `UPDATE sso_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id, email`,
    [tokenHash],
  )
  if (!rows[0]) return null
  return { userId: rows[0].user_id as string, email: rows[0].email as string }
}
