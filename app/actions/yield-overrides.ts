"use server"

import { query } from "@/lib/db"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { type UserProfile } from "@/lib/users"
import { resolveCurrentSession } from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import type { ProgramStatus, YieldProgramOverride } from "@/lib/ppp-programs"

// ---------------------------------------------------------------------------
// Administrator overrides for the built-in PPP / Yield programs.
//
// The four built-in programs (Micro / Small / Mid / Large Cap) are defined in
// `lib/ppp-programs.ts`. This table lets the administrator HIDE any of them from
// customers and OVERRIDE any displayed parameter — including the risk level —
// without a code change. A row stores only the fields the admin changed (null =
// keep the built-in default). Deleting the row reverts the program to default.
//
// Client reads fail CLOSED: if the table is unavailable the customer simply sees
// the built-in defaults, never an error.
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
    `CREATE TABLE IF NOT EXISTS yield_program_overrides (
       program_id        text        PRIMARY KEY,
       hidden            boolean     NOT NULL DEFAULT false,
       name              text,
       expected_return   text,
       return_frequency  text,
       min_investment    numeric,
       max_investment    numeric,
       duration          text,
       status            text,
       risk_level        text,
       description       text,
       spots_available   integer,
       total_spots       integer,
       updated_by        text,
       updated_at        timestamptz NOT NULL DEFAULT now()
     )`,
  )
  ensured = true
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === "" ? null : s
}

function normalizeStatus(v: unknown): ProgramStatus | null {
  return v === "open" || v === "limited" || v === "invite" || v === "closed" ? v : null
}

function rowToOverride(row: Record<string, unknown>): YieldProgramOverride {
  return {
    programId: row.program_id as string,
    hidden: Boolean(row.hidden),
    name: strOrNull(row.name),
    expectedReturn: strOrNull(row.expected_return),
    returnFrequency: strOrNull(row.return_frequency),
    minInvestment: numOrNull(row.min_investment),
    maxInvestment: numOrNull(row.max_investment),
    duration: strOrNull(row.duration),
    status: normalizeStatus(row.status),
    riskLevel: strOrNull(row.risk_level),
    description: strOrNull(row.description),
    spotsAvailable: numOrNull(row.spots_available),
    totalSpots: numOrNull(row.total_spots),
  }
}

// ---------------------------------------------------------------------------
// Client-callable read (no passcode). Returns every override keyed by program
// id so the customer page can merge them onto the built-in defaults. Fails
// CLOSED — returns {} on any error.
// ---------------------------------------------------------------------------
export async function getYieldProgramOverrides(): Promise<Record<string, YieldProgramOverride>> {
  try {
    await ensureTable()
    const { rows } = await query(`SELECT * FROM yield_program_overrides`)
    const map: Record<string, YieldProgramOverride> = {}
    for (const row of rows) {
      const ov = rowToOverride(row)
      map[ov.programId] = ov
    }
    return map
  } catch (err) {
    console.log("[v0] getYieldProgramOverrides failed:", (err as Error).message)
    return {}
  }
}

// ---------------------------------------------------------------------------
// Admin: full override map, passcode verified.
// ---------------------------------------------------------------------------
export async function getAdminYieldProgramOverrides(
  passcode: string,
): Promise<{ ok: true; overrides: Record<string, YieldProgramOverride> } | { ok: false; error: string }> {
  try {
    await requireAdmin(passcode)
    await ensureTable()
    const { rows } = await query(`SELECT * FROM yield_program_overrides`)
    const overrides: Record<string, YieldProgramOverride> = {}
    for (const row of rows) {
      const ov = rowToOverride(row)
      overrides[ov.programId] = ov
    }
    return { ok: true, overrides }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export type YieldProgramOverridePatch = Partial<Omit<YieldProgramOverride, "programId">>

// ---------------------------------------------------------------------------
// Admin: create/update an override for a built-in program. Read-modify-write so
// a partial patch (e.g. just `hidden`, or just `riskLevel`) leaves the other
// stored fields intact.
// ---------------------------------------------------------------------------
export async function setYieldProgramOverride(
  passcode: string,
  programId: string,
  patch: YieldProgramOverridePatch,
): Promise<{ ok: true; overrides: Record<string, YieldProgramOverride> } | { ok: false; error: string }> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (!programId?.trim()) return { ok: false, error: "Missing program id." }

  try {
    await ensureTable()
    const { rows: existingRows } = await query(
      `SELECT * FROM yield_program_overrides WHERE program_id = $1`,
      [programId],
    )
    const current: YieldProgramOverride =
      existingRows.length > 0
        ? rowToOverride(existingRows[0])
        : {
            programId,
            hidden: false,
            name: null,
            expectedReturn: null,
            returnFrequency: null,
            minInvestment: null,
            maxInvestment: null,
            duration: null,
            status: null,
            riskLevel: null,
            description: null,
            spotsAvailable: null,
            totalSpots: null,
          }

    const merged: YieldProgramOverride = {
      ...current,
      ...patch,
      // Normalize the value types coming from the patch.
      hidden: patch.hidden ?? current.hidden,
      minInvestment: patch.minInvestment === undefined ? current.minInvestment : numOrNull(patch.minInvestment),
      maxInvestment: patch.maxInvestment === undefined ? current.maxInvestment : numOrNull(patch.maxInvestment),
      spotsAvailable:
        patch.spotsAvailable === undefined ? current.spotsAvailable : numOrNull(patch.spotsAvailable),
      totalSpots: patch.totalSpots === undefined ? current.totalSpots : numOrNull(patch.totalSpots),
      status: patch.status === undefined ? current.status : normalizeStatus(patch.status),
      programId,
    }

    await query(
      `INSERT INTO yield_program_overrides (
         program_id, hidden, name, expected_return, return_frequency,
         min_investment, max_investment, duration, status, risk_level,
         description, spots_available, total_spots, updated_by, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (program_id) DO UPDATE SET
         hidden = EXCLUDED.hidden,
         name = EXCLUDED.name,
         expected_return = EXCLUDED.expected_return,
         return_frequency = EXCLUDED.return_frequency,
         min_investment = EXCLUDED.min_investment,
         max_investment = EXCLUDED.max_investment,
         duration = EXCLUDED.duration,
         status = EXCLUDED.status,
         risk_level = EXCLUDED.risk_level,
         description = EXCLUDED.description,
         spots_available = EXCLUDED.spots_available,
         total_spots = EXCLUDED.total_spots,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        programId,
        merged.hidden,
        merged.name,
        merged.expectedReturn,
        merged.returnFrequency,
        merged.minInvestment,
        merged.maxInvestment,
        merged.duration,
        merged.status,
        merged.riskLevel,
        merged.description,
        merged.spotsAvailable,
        merged.totalSpots,
        `${admin.fullName} (${admin.company})`,
      ],
    )

    await logActivity({
      action: `Administrator updated a customer yield program`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        summary: `Administrator ${merged.hidden ? "hid" : "updated"} the built-in program ${programId}${
          merged.riskLevel ? ` (risk level now ${merged.riskLevel})` : ""
        }.`,
        referenceId: programId,
        hidden: merged.hidden,
        riskLevel: merged.riskLevel ?? undefined,
      },
    })

    const { rows } = await query(`SELECT * FROM yield_program_overrides`)
    const overrides: Record<string, YieldProgramOverride> = {}
    for (const row of rows) {
      const ov = rowToOverride(row)
      overrides[ov.programId] = ov
    }
    return { ok: true, overrides }
  } catch (err) {
    console.log("[v0] setYieldProgramOverride failed:", (err as Error).message)
    return { ok: false, error: "The program could not be updated. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Admin: remove the override, reverting the program to its built-in defaults.
// ---------------------------------------------------------------------------
export async function resetYieldProgramOverride(
  passcode: string,
  programId: string,
): Promise<{ ok: true; overrides: Record<string, YieldProgramOverride> } | { ok: false; error: string }> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  try {
    await ensureTable()
    await query(`DELETE FROM yield_program_overrides WHERE program_id = $1`, [programId])
    await logActivity({
      action: `Administrator reset a customer yield program to defaults`,
      category: "PPP / Yield Programs",
      user: `${admin.fullName} (${admin.company})`,
      details: { summary: `Administrator reset the built-in program ${programId} to its default parameters.`, referenceId: programId },
    })
    const { rows } = await query(`SELECT * FROM yield_program_overrides`)
    const overrides: Record<string, YieldProgramOverride> = {}
    for (const row of rows) {
      const ov = rowToOverride(row)
      overrides[ov.programId] = ov
    }
    return { ok: true, overrides }
  } catch (err) {
    console.log("[v0] resetYieldProgramOverride failed:", (err as Error).message)
    return { ok: false, error: "The program could not be reset. Please try again." }
  }
}
