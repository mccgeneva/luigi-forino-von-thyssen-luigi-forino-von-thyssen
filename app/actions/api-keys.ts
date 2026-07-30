"use server"

// ---------------------------------------------------------------------------
// Admin Server Actions for managing external API keys.
//
// Every action is gated by `adminActionAuthorized(passcode)` — the caller must
// be an authorized admin account AND present the correct PIN — exactly like the
// rest of the admin surface. The plaintext secret is returned by
// `adminCreateApiKey` ONCE so the admin can copy it; it is never retrievable
// afterwards.
// ---------------------------------------------------------------------------

import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  ALL_SCOPES,
  type ApiKeyRecord,
  type ApiKeyScope,
} from "@/lib/api-keys-db"

const FORBIDDEN = "Not authorized. Sign in as an administrator and enter the correct PIN."

export type ListApiKeysResult = { ok: true; keys: ApiKeyRecord[] } | { ok: false; error: string }
export type CreateApiKeyResult =
  | { ok: true; key: ApiKeyRecord; plaintext: string }
  | { ok: false; error: string }
export type MutateApiKeyResult = { ok: true } | { ok: false; error: string }

export async function adminListApiKeys(passcode: string): Promise<ListApiKeysResult> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: FORBIDDEN }
  try {
    return { ok: true, keys: await listApiKeys() }
  } catch (err) {
    console.log("[v0] adminListApiKeys failed:", (err as Error).message)
    return { ok: false, error: "Could not load API keys." }
  }
}

export async function adminCreateApiKey(
  passcode: string,
  input: { name: string; scopes: ApiKeyScope[] },
): Promise<CreateApiKeyResult> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: FORBIDDEN }

  const name = (input.name ?? "").trim()
  if (!name) return { ok: false, error: "Enter a name so the key is recognizable." }

  const scopes = ALL_SCOPES.filter((s) => input.scopes?.includes(s))
  if (scopes.length === 0) return { ok: false, error: "Select at least one scope." }

  try {
    const { record, plaintext } = await createApiKey({ name, scopes, createdBy: "Administrator" })
    return { ok: true, key: record, plaintext }
  } catch (err) {
    console.log("[v0] adminCreateApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be created." }
  }
}

export async function adminRevokeApiKey(passcode: string, id: string): Promise<MutateApiKeyResult> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: FORBIDDEN }
  try {
    const rec = await revokeApiKey(id)
    return rec ? { ok: true } : { ok: false, error: "Key not found." }
  } catch (err) {
    console.log("[v0] adminRevokeApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be revoked." }
  }
}

export async function adminDeleteApiKey(passcode: string, id: string): Promise<MutateApiKeyResult> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: FORBIDDEN }
  try {
    const ok = await deleteApiKey(id)
    return ok ? { ok: true } : { ok: false, error: "Key not found." }
  } catch (err) {
    console.log("[v0] adminDeleteApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be deleted." }
  }
}
