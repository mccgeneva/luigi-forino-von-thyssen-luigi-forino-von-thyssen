"use server"

// ---------------------------------------------------------------------------
// User-facing Server Actions for self-service API keys.
//
// Unlike the admin actions (app/actions/api-keys.ts), these are gated by the
// caller's OWN session and every key is bound to that account via
// `ownerUserId`. A user can therefore only ever create, list, revoke or delete
// keys for themselves — never global keys or another customer's keys.
//
// These keys let an external app (NQAi.cloud) act on the user's own mcc-btp.app
// account: read data ("read"), update contact details ("write") and charge
// subscriptions ("charge"). The key inherits the user's identity, so no second
// login is needed.
// ---------------------------------------------------------------------------

import { resolveCurrentSession } from "@/lib/session-user"
import {
  createApiKey,
  listApiKeysForOwner,
  revokeApiKeyForOwner,
  deleteApiKeyForOwner,
  type ApiKeyRecord,
  type ApiKeyScope,
} from "@/lib/api-keys-db"

// Scopes a user may grant on their OWN key. "sso" stays admin-only.
const USER_SCOPES: ApiKeyScope[] = ["read", "write", "charge"]

export type ListMyApiKeysResult = { ok: true; keys: ApiKeyRecord[] } | { ok: false; error: string }
export type CreateMyApiKeyResult =
  | { ok: true; key: ApiKeyRecord; plaintext: string }
  | { ok: false; error: string }
export type MutateMyApiKeyResult = { ok: true } | { ok: false; error: string }

const EXPIRED = "Your session has expired. Please sign in again."

export async function listMyApiKeys(): Promise<ListMyApiKeysResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: EXPIRED }
  try {
    return { ok: true, keys: await listApiKeysForOwner(session.id) }
  } catch (err) {
    console.log("[v0] listMyApiKeys failed:", (err as Error).message)
    return { ok: false, error: "Could not load your API keys." }
  }
}

export async function createMyApiKey(input: {
  name: string
  scopes: ApiKeyScope[]
}): Promise<CreateMyApiKeyResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: EXPIRED }

  const name = (input.name ?? "").trim()
  if (!name) return { ok: false, error: "Enter a name so you can recognize the key later." }

  const scopes = USER_SCOPES.filter((s) => input.scopes?.includes(s))
  if (scopes.length === 0) return { ok: false, error: "Select at least one permission." }

  try {
    const { record, plaintext } = await createApiKey({
      name,
      scopes,
      createdBy: session.profile?.fullName || session.profile?.email || session.id,
      ownerUserId: session.id,
    })
    return { ok: true, key: record, plaintext }
  } catch (err) {
    console.log("[v0] createMyApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be created." }
  }
}

export async function revokeMyApiKey(id: string): Promise<MutateMyApiKeyResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: EXPIRED }
  try {
    const rec = await revokeApiKeyForOwner(id, session.id)
    return rec ? { ok: true } : { ok: false, error: "Key not found." }
  } catch (err) {
    console.log("[v0] revokeMyApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be revoked." }
  }
}

export async function deleteMyApiKey(id: string): Promise<MutateMyApiKeyResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: EXPIRED }
  try {
    const ok = await deleteApiKeyForOwner(id, session.id)
    return ok ? { ok: true } : { ok: false, error: "Key not found." }
  } catch (err) {
    console.log("[v0] deleteMyApiKey failed:", (err as Error).message)
    return { ok: false, error: "The key could not be deleted." }
  }
}
