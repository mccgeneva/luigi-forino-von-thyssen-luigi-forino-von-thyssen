// ---------------------------------------------------------------------------
// External API request authentication (server-only).
//
// Shared entry point for the public /api/v1/* routes. Extracts the bearer token
// from the Authorization header, authenticates it against the api_keys store,
// and enforces the required scope. Returns either the authenticated key record
// or a ready-to-return JSON error Response, so each route stays a thin wrapper.
// ---------------------------------------------------------------------------

import "server-only"
import { NextResponse } from "next/server"
import { authenticateApiKey, hasScope, type ApiKeyRecord, type ApiKeyScope } from "@/lib/api-keys-db"
import { getDynamicUserByEmail, getDynamicUserById, type DynamicUserRecord } from "@/lib/admin-users-db"

export type ApiAuthResult =
  | { ok: true; key: ApiKeyRecord }
  | { ok: false; response: NextResponse }

export type ApiTargetResult =
  | { ok: true; user: DynamicUserRecord }
  | { ok: false; response: NextResponse }

function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}

/** Extract a bearer token from an `Authorization: Bearer <token>` header. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") || req.headers.get("Authorization")
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * Authenticate an incoming API request and require a scope. On failure returns
 * a discriminated result carrying the exact JSON error Response to return:
 *   - 401 when the token is missing or invalid/revoked.
 *   - 403 when the key is valid but lacks the required scope.
 */
export async function authenticateApiRequest(req: Request, requiredScope: ApiKeyScope): Promise<ApiAuthResult> {
  const token = bearerToken(req)
  if (!token) {
    return {
      ok: false,
      response: errorResponse(401, "missing_token", "Provide your API key as 'Authorization: Bearer <key>'."),
    }
  }

  const key = await authenticateApiKey(token).catch(() => null)
  if (!key) {
    return { ok: false, response: errorResponse(401, "invalid_token", "The API key is invalid or has been revoked.") }
  }

  if (!hasScope(key, requiredScope)) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "insufficient_scope",
        `This API key does not have the '${requiredScope}' scope required for this operation.`,
      ),
    }
  }

  return { ok: true, key }
}

/**
 * Resolve WHICH customer account a request acts on, honoring the key type:
 *
 *   - User-bound key (key.ownerUserId set): the target is ALWAYS its owner.
 *     `email` is optional; if supplied it must match the owner, otherwise the
 *     request is rejected (403) — a personal key can never touch another
 *     account. This is how an NQAi user inherits their own mcc-btp identity.
 *
 *   - Global/admin key (key.ownerUserId null): `email` is required and the
 *     target is looked up by it (404 when unknown), exactly as before.
 */
export async function resolveApiTargetUser(
  key: ApiKeyRecord,
  email: string | null | undefined,
): Promise<ApiTargetResult> {
  const trimmedEmail = email?.trim() || ""

  if (key.ownerUserId) {
    const owner = await getDynamicUserById(key.ownerUserId).catch(() => undefined)
    if (!owner) {
      return { ok: false, response: errorResponse(404, "owner_not_found", "The account bound to this key no longer exists.") }
    }
    if (trimmedEmail && trimmedEmail.toLowerCase() !== owner.email.toLowerCase()) {
      return {
        ok: false,
        response: errorResponse(403, "email_mismatch", "This key can only act on its own account; the email does not match."),
      }
    }
    return { ok: true, user: owner }
  }

  if (!trimmedEmail) {
    return { ok: false, response: errorResponse(400, "missing_email", "Provide the customer email.") }
  }
  const user = await getDynamicUserByEmail(trimmedEmail).catch(() => undefined)
  if (!user) {
    return { ok: false, response: errorResponse(404, "customer_not_found", `No customer found for ${trimmedEmail}.`) }
  }
  return { ok: true, user }
}
