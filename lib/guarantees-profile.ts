import "server-only"
import { query } from "@/lib/db"
import { readLedgerEntries, availableByCurrency } from "@/lib/ledger-db"
import { listApprovalsForUser } from "@/lib/approvals-db"
import { resolveDataOwnerIdFor } from "@/lib/session-user"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { convertCurrency } from "@/lib/fx"
import {
  computeGuaranteeScore,
  type GuaranteeConfig,
  type GuaranteeInputs,
  type GuaranteeScore,
} from "@/lib/guarantees-accumulator"
import { computeOverdraftStatus, type OverdraftStatus } from "@/lib/overdraft"

/**
 * Server-side gathering of the real inputs behind a user's Guarantees
 * Accumulator score. All money is normalised to EUR (the app base) before
 * scoring so a single common-currency figure feeds the engine.
 *
 * Sources (single source of truth per figure):
 *   • availableBalance — the MASTER ledger net available (a sub shares its
 *     master's funds), summed across currencies into EUR.
 *   • totalExposure / leverageLoad — OUTSTANDING principal on approved, not-yet
 *     settled financing approvals (leverage, monetization, project_funding,
 *     treasury_lending).
 *   • guarantees — security-deposit ledger credits + face value of active bank
 *     instruments held (posted collateral).
 *   • overdueCharges — auto-derived arrears: whole months of current financing
 *     cost the available balance cannot cover.
 *   • accountAgeDays — from the member's created_at.
 */

const BASE = "EUR"

/** Documented product annual financing rates, used only to size arrears. */
const LEVERAGE_TREASURY_RATE = 0.03
const MONETIZATION_FUNDING_RATE = 0.018

function toEur(amount: number, currency?: string): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n === 0) return 0
  const ccy = (currency || BASE).toUpperCase()
  if (ccy === BASE) return n
  try {
    return convertCurrency(n, ccy, BASE)
  } catch {
    return n
  }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** A record is still "live" (contributing exposure) unless a close marker is set. */
function isLiveRecord(rec: Record<string, unknown> | undefined): boolean {
  if (!rec) return false
  return !rec.settledAt && !rec.closedAt && !rec.reversedAt && !rec.terminatedAt && !rec.repaidAt
}

/** Try the various principal field names used across financing products. */
function principalOf(rec: Record<string, unknown> | undefined): number {
  if (!rec) return 0
  return num(
    rec.borrowedAmount ??
      rec.grossProceeds ??
      rec.financedAmount ??
      rec.principal ??
      rec.fundingAmount ??
      rec.amount ??
      0,
  )
}

function currencyOf(rec: Record<string, unknown> | undefined): string {
  if (!rec) return BASE
  return String(rec.proceedsCurrency || rec.currency || BASE)
}

export interface GuaranteeProfileResult {
  score: GuaranteeScore
  /** Convenience mirror of the key input figures for admin display. */
  currency: string
  /** Controlled-overdraft status for the master account (EUR figures). */
  overdraft: OverdraftStatus
}

/**
 * Gather inputs for `userId` and compute the score with the given config.
 * Fully defensive — any sub-read that fails degrades that figure to 0.
 */
export async function gatherGuaranteeProfile(userId: string, config: GuaranteeConfig): Promise<GuaranteeProfileResult> {
  const ownerId = await resolveDataOwnerIdFor(userId)

  // --- Available balance (master ledger) --------------------------------
  let availableBalance = 0
  let ledgerEntries: Awaited<ReturnType<typeof readLedgerEntries>> = []
  try {
    ledgerEntries = await readLedgerEntries(ownerId)
    const byCcy = availableByCurrency(ledgerEntries)
    for (const [ccy, amt] of Object.entries(byCcy)) availableBalance += toEur(amt, ccy)
  } catch {
    availableBalance = 0
  }

  // --- Outstanding financing exposure -----------------------------------
  let totalExposure = 0
  let leverageLoad = 0
  const financingKinds = ["leverage", "monetization", "project_funding", "treasury_lending", "internal_loan"] as const
  for (const kind of financingKinds) {
    try {
      const rows = await listApprovalsForUser(userId, kind)
      for (const row of rows) {
        if (row.status !== "approved") continue
        const payload = (row.payload ?? {}) as Record<string, unknown>
        const rec = (payload.record ?? payload) as Record<string, unknown>
        if (!isLiveRecord(rec)) continue
        const principalEur = toEur(principalOf(rec), currencyOf(rec))
        if (principalEur <= 0) continue
        totalExposure += principalEur
        if (kind === "leverage") leverageLoad += principalEur
      }
    } catch {
      // ignore this kind
    }
  }

  // --- Treasury security-deposit financing (a LEVERAGED deposit) ---------
  // The security deposit itself lives in `treasury_accounts` (keyed by the
  // user), NOT as an approval. When the deposit is financed (e.g. 100k paid-in
  // + 400k borrowed at 1:5) the borrowed `financed_amount` is real leverage on
  // the account, and the `customer_contribution` is the user's own paid-in
  // guarantee. Neither channel stacks with a `treasury_lending` approval (the
  // system refuses financing an already-financed deposit), so this is additive.
  let treasuryFinanced = 0
  let treasuryContribution = 0
  // Paid-in security deposit (contribution + SKR collateral) — the base the
  // controlled overdraft ceiling is a percentage of.
  let treasuryDepositBaseEur = 0
  try {
    const { rows } = await query<{
      status: string
      financed_amount: string | number | null
      customer_contribution: string | number | null
      skr_collateral: string | number | null
      currency: string | null
    }>(
      `SELECT status, financed_amount, customer_contribution, skr_collateral, currency FROM treasury_accounts WHERE user_id = $1`,
      [userId],
    )
    const t = rows[0]
    if (t && t.status !== "none" && t.status !== "closed") {
      const ccy = String(t.currency || BASE)
      treasuryFinanced = toEur(num(t.financed_amount), ccy)
      treasuryContribution = toEur(num(t.customer_contribution), ccy)
      treasuryDepositBaseEur = treasuryContribution + toEur(num(t.skr_collateral), ccy)
      if (treasuryFinanced > 0) {
        totalExposure += treasuryFinanced
        leverageLoad += treasuryFinanced
      }
    }
  } catch {
    treasuryFinanced = 0
    treasuryContribution = 0
    treasuryDepositBaseEur = 0
  }

  // --- Guarantees / collateral held -------------------------------------
  // (a0) The user's own paid-in treasury security-deposit contribution.
  let guarantees = treasuryContribution
  try {
    for (const e of ledgerEntries) {
      const cat = String(e.category ?? "").toLowerCase()
      if (e.direction === "credit" && e.status === "completed" && (cat.includes("deposit") || cat.includes("security"))) {
        guarantees += toEur(num(e.amount), e.currency)
      }
    }
  } catch {
    /* noop */
  }
  // (b) Face value of active bank instruments held.
  try {
    const instruments = await listApprovalsForUser(userId, "instrument")
    for (const row of instruments) {
      if (row.status !== "approved") continue
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const rec = (payload.issuedByAdmin ? payload.instrument : (payload.record ?? payload.instrument)) as
        | Record<string, unknown>
        | undefined
      if (!rec || rec.blocked) continue
      const face = num(rec.faceValue ?? rec.amount)
      if (face > 0) guarantees += toEur(face, String(rec.currency || BASE))
    }
  } catch {
    /* noop */
  }

  // --- Overdue charges (auto-derived arrears) ---------------------------
  // Current monthly financing cost across live facilities; if the available
  // balance cannot cover it, count the whole months of shortfall (capped).
  let monthlyFinancingCost = 0
  try {
    for (const kind of financingKinds) {
      const rows = await listApprovalsForUser(userId, kind)
      const rate =
        kind === "leverage" || kind === "treasury_lending" || kind === "internal_loan"
          ? LEVERAGE_TREASURY_RATE
          : MONETIZATION_FUNDING_RATE
      for (const row of rows) {
        if (row.status !== "approved") continue
        const payload = (row.payload ?? {}) as Record<string, unknown>
        const rec = (payload.record ?? payload) as Record<string, unknown>
        if (!isLiveRecord(rec)) continue
        const principalEur = toEur(principalOf(rec), currencyOf(rec))
        if (principalEur > 0) monthlyFinancingCost += (principalEur * rate) / 12
      }
    }
    // Financed treasury deposit carries the same treasury debit-interest rate.
    if (treasuryFinanced > 0) monthlyFinancingCost += (treasuryFinanced * LEVERAGE_TREASURY_RATE) / 12
  } catch {
    /* noop */
  }
  let overdueCharges = 0
  if (monthlyFinancingCost > 0) {
    const shortfall = monthlyFinancingCost - availableBalance
    overdueCharges = shortfall > 0 ? Math.min(12, Math.ceil(shortfall / monthlyFinancingCost)) : 0
  }

  // --- Account age ------------------------------------------------------
  let accountAgeDays = 0
  try {
    const user = await getDynamicUserById(userId)
    if (user?.createdAt) {
      const created = new Date(user.createdAt).getTime()
      if (Number.isFinite(created)) accountAgeDays = Math.max(0, (Date.now() - created) / 86_400_000)
    }
  } catch {
    accountAgeDays = 0
  }

  // --- Controlled overdraft status --------------------------------------
  // Aggregate SETTLED (completed-only) balance across currencies, EUR-equiv —
  // a real settled deficit, excluding pending holds + sub-account compartments.
  let settledBalanceEur = 0
  try {
    const perCur: Record<string, number> = {}
    for (const e of ledgerEntries) {
      if (e.status !== "completed") continue
      if (e.subAccountId) continue
      const c = (e.currency || "USD").toUpperCase()
      perCur[c] = (perCur[c] ?? 0) + (e.direction === "credit" ? e.amount : -e.amount)
    }
    for (const [c, v] of Object.entries(perCur)) settledBalanceEur += toEur(v, c)
  } catch {
    settledBalanceEur = 0
  }
  const overdraft = computeOverdraftStatus(treasuryDepositBaseEur, settledBalanceEur)

  const inputs: GuaranteeInputs = {
    guarantees,
    leverageLoad,
    totalExposure,
    availableBalance,
    overdueCharges,
    accountAgeDays,
    overdraftUsageRatio: overdraft.usageRatio,
    currency: BASE,
  }

  return { score: computeGuaranteeScore(inputs, config), currency: BASE, overdraft }
}
