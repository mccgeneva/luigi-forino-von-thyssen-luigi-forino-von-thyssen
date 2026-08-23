import "server-only"
import { query } from "@/lib/db"
import { DEFAULT_GUARANTEE_CONFIG, type GuaranteeConfig } from "@/lib/guarantees-accumulator"

/**
 * Persistence for the ONE global Guarantees Accumulator configuration row.
 * Mirrors the account-limits single-row pattern: a `guarantee_config` table
 * with a fixed primary key `'global'`. Reads never throw — they degrade to
 * DEFAULT_GUARANTEE_CONFIG so scoring always works.
 */

const GLOBAL_ID = "global"
let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(`
    CREATE TABLE IF NOT EXISTS guarantee_config (
      id                      text PRIMARY KEY,
      weight_security_deposit double precision NOT NULL DEFAULT 1,
      weight_leverage_load    double precision NOT NULL DEFAULT 1,
      weight_exposure         double precision NOT NULL DEFAULT 1,
      weight_payment_penalty  double precision NOT NULL DEFAULT 1,
      high_risk_threshold     double precision NOT NULL DEFAULT 10,
      age_credit_per_year     double precision NOT NULL DEFAULT 1.5,
      age_credit_max          double precision NOT NULL DEFAULT 6,
      penalty_per_overdue     double precision NOT NULL DEFAULT 25,
      target_coverage         double precision NOT NULL DEFAULT 1,
      enforce                 boolean NOT NULL DEFAULT true,
      updated_at              timestamptz NOT NULL DEFAULT now()
    )
  `)
  ensured = true
}

function rowToConfig(row: Record<string, unknown>): GuaranteeConfig {
  return {
    weightSecurityDeposit: Number(row.weight_security_deposit),
    weightLeverageLoad: Number(row.weight_leverage_load),
    weightExposure: Number(row.weight_exposure),
    weightPaymentPenalty: Number(row.weight_payment_penalty),
    highRiskThreshold: Number(row.high_risk_threshold),
    ageCreditPerYear: Number(row.age_credit_per_year),
    ageCreditMax: Number(row.age_credit_max),
    penaltyPerOverdue: Number(row.penalty_per_overdue),
    targetCoverage: Number(row.target_coverage),
    enforce: Boolean(row.enforce),
  }
}

/** Read the global config, falling back to defaults when unset or on error. */
export async function getGuaranteeConfig(): Promise<GuaranteeConfig> {
  try {
    await ensureTable()
    const { rows } = await query(`SELECT * FROM guarantee_config WHERE id = $1`, [GLOBAL_ID])
    if (!rows.length) return { ...DEFAULT_GUARANTEE_CONFIG }
    return rowToConfig(rows[0] as Record<string, unknown>)
  } catch {
    return { ...DEFAULT_GUARANTEE_CONFIG }
  }
}

/** Upsert the global config. */
export async function saveGuaranteeConfig(input: GuaranteeConfig): Promise<void> {
  await ensureTable()
  await query(
    `INSERT INTO guarantee_config (
       id, weight_security_deposit, weight_leverage_load, weight_exposure,
       weight_payment_penalty, high_risk_threshold, age_credit_per_year,
       age_credit_max, penalty_per_overdue, target_coverage, enforce, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (id) DO UPDATE SET
       weight_security_deposit = EXCLUDED.weight_security_deposit,
       weight_leverage_load    = EXCLUDED.weight_leverage_load,
       weight_exposure         = EXCLUDED.weight_exposure,
       weight_payment_penalty  = EXCLUDED.weight_payment_penalty,
       high_risk_threshold     = EXCLUDED.high_risk_threshold,
       age_credit_per_year     = EXCLUDED.age_credit_per_year,
       age_credit_max          = EXCLUDED.age_credit_max,
       penalty_per_overdue     = EXCLUDED.penalty_per_overdue,
       target_coverage         = EXCLUDED.target_coverage,
       enforce                 = EXCLUDED.enforce,
       updated_at              = now()`,
    [
      GLOBAL_ID,
      input.weightSecurityDeposit,
      input.weightLeverageLoad,
      input.weightExposure,
      input.weightPaymentPenalty,
      input.highRiskThreshold,
      input.ageCreditPerYear,
      input.ageCreditMax,
      input.penaltyPerOverdue,
      input.targetCoverage,
      input.enforce,
    ],
  )
}
