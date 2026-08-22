"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveCurrentSession } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { partnerBankByKey } from "@/lib/partner-banks"
import type {
  YieldStatus,
  InstitutionalYield,
  PublishYieldInput,
  UpdateYieldInput,
  YieldResult,
  PublishYieldResult,
} from "@/lib/institutional-yields-shared"

// Re-export the shared types so existing `@/app/actions/institutional-yields`
// type imports keep working (type-only re-exports are erased at compile and are
// allowed from a "use server" module).
export type {
  YieldStatus,
  InstitutionalYield,
  PublishYieldInput,
  UpdateYieldInput,
  YieldResult,
  PublishYieldResult,
} from "@/lib/institutional-yields-shared"

// ---------------------------------------------------------------------------
// Institutional yields (Yield / PPP section) — administrator-published,
// bank-partner-sourced yield products.
//
// Mirrors the marketplace-instruments pattern: the catalogue is populated
// EXCLUSIVELY by the Administrator, linked to a bank from the 130+ partner-bank
// master list (`PARTNER_BANKS`). Each product carries a lifecycle status
// (pending → active → closed). Only ACTIVE products are visible to clients in
// the user-facing Yield / PPP section; pending/closed are admin-only.
//
// Reads fail CLOSED: if the table is unavailable the section shows nothing,
// never fabricated data.
// ---------------------------------------------------------------------------

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
    `CREATE TABLE IF NOT EXISTS institutional_yields (
       id                text        PRIMARY KEY,
       bank_key          text        NOT NULL DEFAULT '',
       bank_name         text        NOT NULL,
       bank_bic          text        NOT NULL DEFAULT '',
       bank_country      text        NOT NULL DEFAULT '',
       program_name      text        NOT NULL,
       yield_type        text        NOT NULL DEFAULT '',
       expected_return   text        NOT NULL DEFAULT '',
       return_frequency  text        NOT NULL DEFAULT '',
       term_label        text        NOT NULL DEFAULT '',
       term_months       integer,
       currency          text        NOT NULL DEFAULT 'USD',
       min_investment    numeric     NOT NULL DEFAULT 0,
       risk_class        text        NOT NULL DEFAULT '',
       rating            text        NOT NULL DEFAULT '',
       status            text        NOT NULL DEFAULT 'pending',
       description       text        NOT NULL DEFAULT '',
       terms             text        NOT NULL DEFAULT '',
       created_by        text,
       created_at        timestamptz NOT NULL DEFAULT now(),
       updated_at        timestamptz NOT NULL DEFAULT now()
     )`,
  )
  ensured = true
}

function toIso(v: unknown): string {
  if (!v) return ""
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function rowToYield(row: Record<string, unknown>): InstitutionalYield {
  return {
    id: row.id as string,
    bankKey: (row.bank_key as string) ?? "",
    bankName: row.bank_name as string,
    bankBic: (row.bank_bic as string) ?? "",
    bankCountry: (row.bank_country as string) ?? "",
    programName: row.program_name as string,
    yieldType: (row.yield_type as string) ?? "",
    expectedReturn: (row.expected_return as string) ?? "",
    returnFrequency: (row.return_frequency as string) ?? "",
    termLabel: (row.term_label as string) ?? "",
    termMonths: row.term_months == null ? null : Number(row.term_months),
    currency: (row.currency as string) ?? "USD",
    minInvestment: Number(row.min_investment ?? 0),
    riskClass: (row.risk_class as string) ?? "",
    rating: (row.rating as string) ?? "",
    status: (row.status as YieldStatus) ?? "pending",
    description: (row.description as string) ?? "",
    terms: (row.terms as string) ?? "",
    createdBy: (row.created_by as string) ?? "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function normalizeStatus(raw: unknown): YieldStatus {
  return raw === "active" || raw === "closed" ? raw : "pending"
}

/**
 * Resolve the issuing bank's real coordinates from the partner-bank master
 * list. Every published yield MUST link to a real bank from the catalogue, so a
 * key that isn't in `PARTNER_BANKS` is rejected — never fabricated.
 */
function resolveBank(bankKey: string): { name: string; bic: string; country: string } | null {
  const bank = partnerBankByKey(bankKey)
  if (!bank) return null
  return { name: bank.name, bic: bank.bic, country: bank.country }
}

function validateInput(input: PublishYieldInput): { ok: true } | { ok: false; error: string } {
  if (!input.programName?.trim()) return { ok: false, error: "Enter a program / product name." }
  if (!input.yieldType?.trim()) return { ok: false, error: "Select a yield type." }
  if (!input.expectedReturn?.trim()) return { ok: false, error: "Enter the expected return / rate." }
  if (!input.termLabel?.trim()) return { ok: false, error: "Enter the term / duration." }
  if (!input.currency?.trim()) return { ok: false, error: "Select a currency." }
  if (!Number.isFinite(input.minInvestment) || input.minInvestment <= 0) {
    return { ok: false, error: "Enter a minimum investment greater than 0." }
  }
  if (!input.riskClass?.trim()) return { ok: false, error: "Select a risk classification." }
  if (!input.description?.trim()) return { ok: false, error: "Enter an institutional description." }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Client-callable read (no passcode). Only ACTIVE, published yields.
// Fails CLOSED — returns [] on any error, never fabricated data.
// ---------------------------------------------------------------------------
export async function getActiveInstitutionalYields(): Promise<InstitutionalYield[]> {
  try {
    await ensureTable()
    const { rows } = await query(
      `SELECT * FROM institutional_yields WHERE status = 'active' ORDER BY min_investment ASC, created_at DESC`,
    )
    return rows.map(rowToYield)
  } catch (err) {
    console.log("[v0] getActiveInstitutionalYields failed:", (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Admin: full catalogue (pending + active + closed), passcode verified.
// ---------------------------------------------------------------------------
export async function getAdminInstitutionalYields(passcode: string): Promise<YieldResult> {
  try {
    await requireAdmin(passcode)
    await ensureTable()
    const { rows } = await query(`SELECT * FROM institutional_yields ORDER BY created_at DESC`)
    return { ok: true, yields: rows.map(rowToYield) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Admin: publish a new institutional yield linked to a partner bank.
// ---------------------------------------------------------------------------
export async function publishInstitutionalYield(
  passcode: string,
  input: PublishYieldInput,
): Promise<PublishYieldResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const bank = resolveBank(input.bankKey)
  if (!bank) {
    return { ok: false, error: "Select an issuing partner bank from the list." }
  }
  const valid = validateInput(input)
  if (!valid.ok) return valid

  const id = `YLD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const status = normalizeStatus(input.status)

  try {
    await ensureTable()
    await query(
      `INSERT INTO institutional_yields (
         id, bank_key, bank_name, bank_bic, bank_country, program_name, yield_type,
         expected_return, return_frequency, term_label, term_months, currency,
         min_investment, risk_class, rating, status, description, terms,
         created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18,
         $19, now(), now()
       )`,
      [
        id,
        input.bankKey,
        bank.name,
        bank.bic,
        bank.country,
        input.programName.trim(),
        input.yieldType.trim(),
        input.expectedReturn.trim(),
        input.returnFrequency.trim(),
        input.termLabel.trim(),
        input.termMonths && Number.isFinite(input.termMonths) ? Math.round(input.termMonths) : null,
        input.currency.trim().toUpperCase(),
        Math.round(input.minInvestment),
        input.riskClass.trim(),
        (input.rating ?? "").trim(),
        status,
        input.description.trim(),
        (input.terms ?? "").trim(),
        `${admin.fullName} (${admin.company})`,
      ],
    )

    await logActivity({
      action: `Administrator published an institutional yield to the Yield/PPP section`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator published "${input.programName.trim()}" (${input.yieldType.trim()}) sourced from ${bank.name} — expected return ${input.expectedReturn.trim()} ${input.returnFrequency.trim()}, term ${input.termLabel.trim()}, min ${input.currency.trim().toUpperCase()} ${Math.round(input.minInvestment).toLocaleString("en-US")}. Status: ${status}.`,
        referenceId: id,
        issuingBank: bank.name,
        yieldType: input.yieldType.trim(),
        expectedReturn: input.expectedReturn.trim(),
        term: input.termLabel.trim(),
        riskClass: input.riskClass.trim(),
        status,
      },
    })

    const { rows } = await query(`SELECT * FROM institutional_yields ORDER BY created_at DESC`)
    const all = rows.map(rowToYield)
    const created = all.find((y) => y.id === id)!
    return { ok: true, yield: created, yields: all }
  } catch (err) {
    console.log("[v0] publishInstitutionalYield failed:", (err as Error).message)
    return { ok: false, error: "The yield could not be published. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Admin: edit an existing yield (all commercial/descriptive fields + bank).
// ---------------------------------------------------------------------------
export async function updateInstitutionalYield(
  passcode: string,
  input: UpdateYieldInput,
): Promise<PublishYieldResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const bank = resolveBank(input.bankKey)
  if (!bank) return { ok: false, error: "Select an issuing partner bank from the list." }
  const valid = validateInput(input)
  if (!valid.ok) return valid

  try {
    await ensureTable()
    const status = normalizeStatus(input.status)
    const { rowCount } = await query(
      `UPDATE institutional_yields SET
         bank_key = $2, bank_name = $3, bank_bic = $4, bank_country = $5,
         program_name = $6, yield_type = $7, expected_return = $8, return_frequency = $9,
         term_label = $10, term_months = $11, currency = $12, min_investment = $13,
         risk_class = $14, rating = $15, status = $16, description = $17, terms = $18,
         updated_at = now()
       WHERE id = $1`,
      [
        input.id,
        input.bankKey,
        bank.name,
        bank.bic,
        bank.country,
        input.programName.trim(),
        input.yieldType.trim(),
        input.expectedReturn.trim(),
        input.returnFrequency.trim(),
        input.termLabel.trim(),
        input.termMonths && Number.isFinite(input.termMonths) ? Math.round(input.termMonths) : null,
        input.currency.trim().toUpperCase(),
        Math.round(input.minInvestment),
        input.riskClass.trim(),
        (input.rating ?? "").trim(),
        status,
        input.description.trim(),
        (input.terms ?? "").trim(),
      ],
    )
    if (!rowCount) return { ok: false, error: "That yield no longer exists." }

    await logActivity({
      action: `Administrator updated an institutional yield`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator updated "${input.programName.trim()}" (${input.id}) from ${bank.name}. Status: ${status}.`,
        referenceId: input.id,
      },
    })

    const { rows } = await query(`SELECT * FROM institutional_yields ORDER BY created_at DESC`)
    const all = rows.map(rowToYield)
    const updated = all.find((y) => y.id === input.id)!
    return { ok: true, yield: updated, yields: all }
  } catch (err) {
    console.log("[v0] updateInstitutionalYield failed:", (err as Error).message)
    return { ok: false, error: "The yield could not be updated. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Admin: approve/publish, close, or re-open (pending) a yield. This IS the
// approval workflow — only 'active' yields are visible to clients.
// ---------------------------------------------------------------------------
export async function setInstitutionalYieldStatus(
  passcode: string,
  id: string,
  status: YieldStatus,
): Promise<YieldResult> {
  try {
    const admin = await requireAdmin(passcode)
    await ensureTable()
    const next = normalizeStatus(status)
    await query(`UPDATE institutional_yields SET status = $2, updated_at = now() WHERE id = $1`, [id, next])
    const verb = next === "active" ? "approved & published" : next === "closed" ? "closed" : "set to pending"
    await logActivity({
      action: `Administrator ${verb} an institutional yield`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: { summary: `Administrator ${verb} institutional yield ${id}.`, referenceId: id, status: next },
    })
    const { rows } = await query(`SELECT * FROM institutional_yields ORDER BY created_at DESC`)
    return { ok: true, yields: rows.map(rowToYield) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Admin: permanently remove a yield.
// ---------------------------------------------------------------------------
export async function removeInstitutionalYield(passcode: string, id: string): Promise<YieldResult> {
  try {
    const admin = await requireAdmin(passcode)
    await ensureTable()
    await query(`DELETE FROM institutional_yields WHERE id = $1`, [id])
    await logActivity({
      action: `Administrator removed an institutional yield`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: { summary: `Administrator permanently removed institutional yield ${id}.`, referenceId: id },
    })
    const { rows } = await query(`SELECT * FROM institutional_yields ORDER BY created_at DESC`)
    return { ok: true, yields: rows.map(rowToYield) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
