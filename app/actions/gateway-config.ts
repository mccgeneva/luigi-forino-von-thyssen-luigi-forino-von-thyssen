"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveCurrentSession } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_KEYS,
  GATEWAY_CURRENCIES,
  isAccountTypeKey,
  isGatewayCurrency,
} from "@/lib/gateway-catalog"

// ---------------------------------------------------------------------------
// Global gateway feature configuration.
//
// Administrators can enable/disable individual account types and currencies
// platform-wide. Rows are sparse: a feature with NO row is treated as ENABLED.
// A row is materialised only when an administrator disables (or re-enables) a
// feature, so the default catalogue requires no seeding. The table is created
// on first use, matching the lazy-migration approach used elsewhere.
// ---------------------------------------------------------------------------

type FeatureKind = "account_type" | "currency"

export interface GatewayConfig {
  /** Account-type keys that are currently disabled platform-wide. */
  disabledAccountTypes: string[]
  /** Currency codes that are currently disabled platform-wide. */
  disabledCurrencies: string[]
}

async function getSessionUser(): Promise<UserProfile | undefined> {
  const session = await resolveCurrentSession()
  return session?.profile
}

async function requireAdmin(passcode: string): Promise<UserProfile> {
  const user = await getSessionUser()
  if (!user) throw new Error("Your session has expired. Please sign in again.")
  if (!(await adminActionAuthorized(passcode))) throw new Error("Administrator authorization failed.")
  return user
}

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS gateway_feature_flags (
       feature_kind text        NOT NULL,
       feature_key  text        NOT NULL,
       enabled      boolean     NOT NULL DEFAULT true,
       updated_at   timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (feature_kind, feature_key)
     )`,
  )
  ensured = true
}

/** Read the set of disabled features. Sparse rows → absence means enabled. */
async function readConfig(): Promise<GatewayConfig> {
  await ensureTable()
  const { rows } = await query(
    `SELECT feature_kind, feature_key FROM gateway_feature_flags WHERE enabled = false`,
  )
  const disabledAccountTypes: string[] = []
  const disabledCurrencies: string[] = []
  for (const r of rows) {
    if (r.feature_kind === "account_type") disabledAccountTypes.push(r.feature_key as string)
    else if (r.feature_kind === "currency") disabledCurrencies.push(r.feature_key as string)
  }
  return { disabledAccountTypes, disabledCurrencies }
}

// ---------------------------------------------------------------------------
// Client-callable read (no passcode — non-sensitive availability only).
// ---------------------------------------------------------------------------

/**
 * The current global gateway configuration. Used by the client request form so
 * customers only see account types and currencies the administrator has left
 * enabled. Fails open (nothing disabled) so the form still works if the table
 * is briefly unavailable.
 */
export async function getGatewayConfig(): Promise<GatewayConfig> {
  try {
    return await readConfig()
  } catch (err) {
    console.log("[v0] getGatewayConfig failed:", (err as Error).message)
    return { disabledAccountTypes: [], disabledCurrencies: [] }
  }
}

// ---------------------------------------------------------------------------
// Admin reads & configuration (passcode verified server-side).
// ---------------------------------------------------------------------------

export type GatewayConfigResult =
  | { ok: true; config: GatewayConfig }
  | { ok: false; error: string }

/** Admin: read the full enable/disable configuration. */
export async function getGatewayConfigAdmin(passcode: string): Promise<GatewayConfigResult> {
  try {
    await requireAdmin(passcode)
    return { ok: true, config: await readConfig() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Admin: enable or disable a single account type or currency platform-wide.
 * Guards against disabling the last remaining option of a kind, so the request
 * form always has at least one account type and one currency to offer.
 */
export async function setGatewayFeatureAdmin(
  passcode: string,
  kind: FeatureKind,
  key: string,
  enabled: boolean,
): Promise<GatewayConfigResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  // Validate the feature exists in the catalogue.
  if (kind === "account_type" && !isAccountTypeKey(key)) {
    return { ok: false, error: "Unknown account type." }
  }
  if (kind === "currency" && !isGatewayCurrency(key)) {
    return { ok: false, error: "Unknown currency." }
  }

  try {
    const current = await readConfig()

    // Prevent disabling the final enabled option of a kind.
    if (!enabled) {
      if (kind === "account_type") {
        const disabled = new Set(current.disabledAccountTypes)
        disabled.add(key)
        const remaining = ACCOUNT_TYPE_KEYS.filter((k) => !disabled.has(k))
        if (remaining.length === 0) {
          return { ok: false, error: "At least one account type must remain enabled." }
        }
      } else {
        const disabled = new Set(current.disabledCurrencies)
        disabled.add(key)
        const remaining = GATEWAY_CURRENCIES.filter((c) => !disabled.has(c))
        if (remaining.length === 0) {
          return { ok: false, error: "At least one currency must remain enabled." }
        }
      }
    }

    await ensureTable()
    await query(
      `INSERT INTO gateway_feature_flags (feature_kind, feature_key, enabled, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (feature_kind, feature_key) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         updated_at = now()`,
      [kind, key, enabled],
    )

    const label =
      kind === "account_type" ? ACCOUNT_TYPES[key as keyof typeof ACCOUNT_TYPES].label : key
    const kindLabel = kind === "account_type" ? "account type" : "currency"
    await logActivity({
      action: `Administrator ${enabled ? "enabled" : "disabled"} gateway ${kindLabel} ${label}`,
      category: "Administration",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator ${enabled ? "enabled" : "disabled"} the gateway ${kindLabel} "${label}" platform-wide. ${enabled ? "Clients can now request it." : "It is hidden from new account requests."}`,
        feature: label,
        kind: kindLabel,
        state: enabled ? "Enabled" : "Disabled",
      },
    })

    return { ok: true, config: await readConfig() }
  } catch (err) {
    console.log("[v0] setGatewayFeatureAdmin failed:", (err as Error).message)
    return { ok: false, error: "The setting could not be updated. Please try again." }
  }
}
