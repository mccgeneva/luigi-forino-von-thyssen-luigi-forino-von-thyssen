import "server-only"
import { query } from "@/lib/db"
import { readLedgerEntries, availableByCurrency } from "@/lib/ledger-db"
import { listApprovalsForUsers } from "@/lib/approvals-db"
import { resolveDataOwnerIdFor, resolveFinancialMemberIds } from "@/lib/session-user"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { convertCurrency } from "@/lib/fx"
import { readEquitySavingsEur } from "@/lib/equity-savings"
import { outstandingInternalLoan } from "@/lib/internal-loan"
import type { ApprovalRequest } from "@/lib/approvals-db"
import {
  computeGuaranteeScore,
  applyGuaranteeOverride,
  type GuaranteeConfig,
  type GuaranteeInputs,
  type GuaranteeScore,
} from "@/lib/guarantees-accumulator"
import { getGuaranteeOverride } from "@/lib/guarantee-overrides-db"
import {
  computeOverdraftStatus,
  applyOverdraftFloor,
  cleanOverdraftGrantForTier,
  type OverdraftStatus,
} from "@/lib/overdraft"
import { getGuaranteeConfig } from "@/lib/guarantees-config-db"

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
export async function gatherGuaranteeProfile(
  userId: string,
  config: GuaranteeConfig,
  opts?: { applyOverride?: boolean },
): Promise<GuaranteeProfileResult> {
  // The MASTER (shared-ledger owner) — availableBalance / equity / overdraft
  // read here, and the account age / treasury base prefer this identity.
  const ownerId = await resolveDataOwnerIdFor(userId)
  // The WHOLE financial pool — master + every sub + every joint. Pooled risk
  // factors (exposure, guarantees, instruments, treasury, arrears) aggregate
  // across ALL of these so every member of one account gets the SAME score,
  // instead of only the member who happens to hold a facility showing exposure.
  const poolIds = await resolveFinancialMemberIds(userId)

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
      const rows = await listApprovalsForUsers(poolIds, kind)
      for (const row of rows) {
        if (row.status !== "approved") continue
        const payload = (row.payload ?? {}) as Record<string, unknown>
        const rec = (payload.record ?? payload) as Record<string, unknown>
        if (!isLiveRecord(rec)) continue
        // Internal loans are amortising: derive the REAL outstanding from the
        // ledger (drawdown + accrued interest − every repayment leg) rather than
        // the flat original principal. This makes a fully-repaid loan contribute
        // ZERO exposure even if its approval record was never stamped
        // settled/closed (a stale marker from an older repay build), so a client
        // who has repaid is not left stuck at high risk. Other financing kinds
        // use their recorded principal.
        let exposureEur: number
        if (kind === "internal_loan") {
          const outstanding = outstandingInternalLoan(row as ApprovalRequest, ledgerEntries)
          exposureEur = toEur(outstanding, currencyOf(rec))
        } else {
          exposureEur = toEur(principalOf(rec), currencyOf(rec))
        }
        if (exposureEur <= 0) continue
        totalExposure += exposureEur
        if (kind === "leverage") leverageLoad += exposureEur
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
  // SECURED security deposit (paid-in contribution + SKR collateral + the
  // financed/leveraged portion) — the base the controlled overdraft ceiling is
  // a percentage of. A financed deposit still secures the account, so the
  // overdraft is authorized on the whole leveraged amount (e.g. 100k paid-in
  // at 1:5 → a 500k secured deposit → 8% = 40k ceiling), per policy.
  let treasuryDepositBaseEur = 0
  try {
    // The security deposit is one attribute of the shared account, but it is
    // stored per-member in `treasury_accounts` (a joint member may have set it
    // up under their own id). Read every pool member's row and pick the SINGLE
    // largest secured deposit as the pool's deposit — do NOT sum, or two members
    // recording the same shared deposit would double-count it.
    const { rows } = await query<{
      status: string
      financed_amount: string | number | null
      customer_contribution: string | number | null
      skr_collateral: string | number | null
      currency: string | null
    }>(
      `SELECT status, financed_amount, customer_contribution, skr_collateral, currency FROM treasury_accounts WHERE user_id = ANY($1)`,
      [poolIds],
    )
    let bestBase = -1
    for (const t of rows) {
      if (!t || t.status === "none" || t.status === "closed") continue
      const ccy = String(t.currency || BASE)
      const financed = toEur(num(t.financed_amount), ccy)
      const contribution = toEur(num(t.customer_contribution), ccy)
      const base = contribution + toEur(num(t.skr_collateral), ccy) + financed
      if (base > bestBase) {
        bestBase = base
        treasuryFinanced = financed
        treasuryContribution = contribution
        // Secured deposit base = paid-in (contribution + SKR) + financed portion.
        treasuryDepositBaseEur = base
      }
    }
    if (treasuryFinanced > 0) {
      totalExposure += treasuryFinanced
      leverageLoad += treasuryFinanced
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
    const instruments = await listApprovalsForUsers(poolIds, "instrument")
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

  // (c) Segregated EQUITY SAVING the customer has blocked as collateral. This
  // is fully-blocked, unencumbered capital committed from the Master Account —
  // it counts as posted collateral here (raising coverage) and separately earns
  // a direct risk-score credit in the engine. The equity is already excluded
  // from `availableBalance` (a held debit), so net equity is unchanged by the
  // mere relocation and only the coverage + explicit credit improve the score.
  let equitySavings = 0
  try {
    equitySavings = await readEquitySavingsEur(ownerId)
    if (equitySavings > 0) guarantees += equitySavings
  } catch {
    equitySavings = 0
  }

  // --- Overdue charges (auto-derived arrears) ---------------------------
  // Current monthly financing cost across live facilities; if the available
  // balance cannot cover it, count the whole months of shortfall (capped).
  let monthlyFinancingCost = 0
  try {
    for (const kind of financingKinds) {
      const rows = await listApprovalsForUsers(poolIds, kind)
      const rate =
        kind === "leverage" || kind === "treasury_lending" || kind === "internal_loan"
          ? LEVERAGE_TREASURY_RATE
          : MONETIZATION_FUNDING_RATE
      for (const row of rows) {
        if (row.status !== "approved") continue
        const payload = (row.payload ?? {}) as Record<string, unknown>
        const rec = (payload.record ?? payload) as Record<string, unknown>
        if (!isLiveRecord(rec)) continue
        // Same as the exposure loop: internal loans use their REAL ledger
        // outstanding, so a repaid loan contributes no financing cost.
        const principalEur =
          kind === "internal_loan"
            ? toEur(outstandingInternalLoan(row as ApprovalRequest, ledgerEntries), currencyOf(rec))
            : toEur(principalOf(rec), currencyOf(rec))
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
  // Use the MASTER's age (the account's true age) so the track-record /
  // seasoning factor is identical for every member of the pool — otherwise a
  // newer joint member would score as a riskier "new account" than the master.
  let accountAgeDays = 0
  // The account's membership badge ("PRO Account" / "Avant-Garde" / ...) drives
  // the clean-profile overdraft grant below. Read from the same master fetch.
  let accountBadge = ""
  try {
    const user = await getDynamicUserById(ownerId)
    accountBadge = String(user?.profile?.accountBadge ?? "")
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
  let overdraft = computeOverdraftStatus(treasuryDepositBaseEur, settledBalanceEur)

  const inputs: GuaranteeInputs = {
    guarantees,
    equitySavings,
    leverageLoad,
    totalExposure,
    availableBalance,
    overdueCharges,
    accountAgeDays,
    // Feed the UNCLAMPED breach ratio so a deep overdraft (far beyond the 8%
    // ceiling) escalates the risk score rather than saturating at the ceiling.
    overdraftUsageRatio: overdraft.breachRatio,
    currency: BASE,
  }

  let score = computeGuaranteeScore(inputs, config)

  // --- Clean-profile overdraft grant ------------------------------------
  // A spotless risk profile — zero on every factor EXCEPT the overdraft itself
  // (no under-collateralisation, no leverage load, no exposure, no payment
  // penalty, a seasoned track record) — earns a FLAT tier-based authorized
  // overdraft (PRO 250k / Avant-Garde 500k) instead of the deposit-based 8%
  // ceiling. Excluding the overdraft factor from the clean test keeps the grant
  // STABLE: merely USING the granted headroom (going negative within it) does
  // not revoke it — only real risk (exposure / arrears / penalties) does, which
  // is exactly "back to normal overdraft as this risk-score condition is lost".
  const f = score.factors
  const cleanExcludingOverdraft =
    f.securityDeposit + f.leverageLoad + f.exposure + f.paymentPenalty + f.trackRecord <= 0.01
  const badge = accountBadge.toLowerCase()
  const tierId =
    badge.includes("avant") || badge.includes("institutional")
      ? "avantgarde"
      : badge.includes("pro")
        ? "pro"
        : "other"
  const cleanGrant = cleanExcludingOverdraft ? cleanOverdraftGrantForTier(tierId) : 0
  if (cleanGrant > 0) {
    overdraft = applyOverdraftFloor(overdraft, cleanGrant)
    // Re-measure the overdraft risk factor against the GRANTED ceiling so the
    // displayed score stays consistent (and low) when the granted headroom is used.
    score = computeGuaranteeScore({ ...inputs, overdraftUsageRatio: overdraft.breachRatio }, config)
  }

  // --- Administrator manual override (silent, per-customer) -------------
  // If an admin has forced this account green/red, apply it on top of the
  // computed score so the customer card + all financing gates reflect the
  // forced verdict. Money `inputs` are untouched (ring-fence stays accurate).
  // The admin manager passes { applyOverride: false } to read the TRUE score.
  if (opts?.applyOverride !== false) {
    try {
      const mode = await getGuaranteeOverride(userId)
      if (mode) score = applyGuaranteeOverride(score, mode, config.highRiskThreshold)
    } catch {
      /* no override on error */
    }
  }

  return { score, currency: BASE, overdraft }
}

export interface FinancingRingfence {
  /** Aggregate spendable balance across currencies, EUR-normalised. */
  availableEur: number
  /** Outstanding borrowed/financed principal (leverage, loans, monetization,
   *  funding, financed treasury deposit), EUR-normalised. */
  exposureEur: number
  /** The client's OWN transferable funds = max(0, available − exposure). */
  freeEur: number
  /** True when the account carries any outstanding borrowing. */
  hasBorrowed: boolean
}

/**
 * How much of the spendable balance is the client's OWN (unborrowed) money.
 *
 * Leverage lines and loans CREDIT the master balance with borrowed proceeds that
 * are scoped strictly for trading (buying power) and repayment — they must never
 * leave the account as an outbound payment/transfer to a third party. This
 * returns the free-own-funds figure so outbound flows can be ring-fenced to it.
 * All figures are EUR-normalised aggregates. Reuses the fully-defensive
 * `gatherGuaranteeProfile` (each sub-read degrades to 0 rather than throwing).
 */
export async function getFinancingRingfence(userId: string): Promise<FinancingRingfence> {
  const config = await getGuaranteeConfig()
  const { score } = await gatherGuaranteeProfile(userId, config)
  const availableEur = Math.max(0, score.inputs.availableBalance || 0)
  const exposureEur = Math.max(0, score.inputs.totalExposure || 0)
  const freeEur = Math.max(0, availableEur - exposureEur)
  return { availableEur, exposureEur, freeEur, hasBorrowed: exposureEur > 0.01 }
}
