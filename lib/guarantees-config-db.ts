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
  // Track Record factor columns — added after the initial schema, so upsert
  // them idempotently for existing deployments.
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS weight_track_record double precision NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS new_account_risk double precision NOT NULL DEFAULT 144`)
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS seasoning_days double precision NOT NULL DEFAULT 365`)
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS proven_capital double precision NOT NULL DEFAULT 250000`)
  // Overdraft factor columns — added with the controlled-overdraft feature.
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS weight_overdraft double precision NOT NULL DEFAULT 1`)
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS overdraft_risk_full double precision NOT NULL DEFAULT 144`)
  // Equity-saving credit columns — added with the Equity Saving feature.
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS equity_credit_full double precision NOT NULL DEFAULT 250000`)
  await query(`ALTER TABLE guarantee_config ADD COLUMN IF NOT EXISTS equity_credit_max double precision NOT NULL DEFAULT 8`)
  ensured = true
}

function rowToConfig(row: Record<string, unknown>): GuaranteeConfig {
  return {
    weightSecurityDeposit: Number(row.weight_security_deposit),
    weightLeverageLoad: Number(row.weight_leverage_load),
    weightExposure: Number(row.weight_exposure),
    weightPaymentPenalty: Number(row.weight_payment_penalty),
    weightTrackRecord: row.weight_track_record == null ? DEFAULT_GUARANTEE_CONFIG.weightTrackRecord : Number(row.weight_track_record),
    newAccountRisk: row.new_account_risk == null ? DEFAULT_GUARANTEE_CONFIG.newAccountRisk : Number(row.new_account_risk),
    seasoningDays: row.seasoning_days == null ? DEFAULT_GUARANTEE_CONFIG.seasoningDays : Number(row.seasoning_days),
    provenCapital: row.proven_capital == null ? DEFAULT_GUARANTEE_CONFIG.provenCapital : Number(row.proven_capital),
    weightOverdraft: row.weight_overdraft == null ? DEFAULT_GUARANTEE_CONFIG.weightOverdraft : Number(row.weight_overdraft),
    overdraftRiskFull:
      row.overdraft_risk_full == null ? DEFAULT_GUARANTEE_CONFIG.overdraftRiskFull : Number(row.overdraft_risk_full),
    highRiskThreshold: Number(row.high_risk_threshold),
    ageCreditPerYear: Number(row.age_credit_per_year),
    ageCreditMax: Number(row.age_credit_max),
    equityCreditFull: row.equity_credit_full == null ? DEFAULT_GUARANTEE_CONFIG.equityCreditFull : Number(row.equity_credit_full),
    equityCreditMax: row.equity_credit_max == null ? DEFAULT_GUARANTEE_CONFIG.equityCreditMax : Number(row.equity_credit_max),
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
       age_credit_max, penalty_per_overdue, target_coverage, enforce,
       weight_track_record, new_account_risk, seasoning_days, proven_capital,
       weight_overdraft, overdraft_risk_full, equity_credit_full, equity_credit_max, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
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
       weight_track_record     = EXCLUDED.weight_track_record,
       new_account_risk        = EXCLUDED.new_account_risk,
       seasoning_days          = EXCLUDED.seasoning_days,
       proven_capital          = EXCLUDED.proven_capital,
       weight_overdraft        = EXCLUDED.weight_overdraft,
       overdraft_risk_full     = EXCLUDED.overdraft_risk_full,
       equity_credit_full      = EXCLUDED.equity_credit_full,
       equity_credit_max       = EXCLUDED.equity_credit_max,
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
      input.weightTrackRecord,
      input.newAccountRisk,
      input.seasoningDays,
      input.provenCapital,
      input.weightOverdraft,
      input.overdraftRiskFull,
      input.equityCreditFull,
      input.equityCreditMax,
    ],
  )
}
