"use server"

import { adminActionAuthorized, adminEmails } from "@/lib/admin-auth"
import {
  resolveCurrentSession,
  resolveAccountProfileById,
  resolveDataOwnerIdFor,
  resolveEnvironmentMemberIds,
} from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import {
  upsertLedgerEntry,
  readLedgerEntries,
  availableByCurrency,
  deleteLedgerEntry,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import { convertCurrency } from "@/lib/fx"
import { getAccountLimits } from "@/lib/account-limits-db"
import {
  limitCap,
  assessPaymentAgainstLimits,
  limitBlockMessage,
} from "@/lib/account-limits-eval"
import { getGuaranteeConfig } from "@/lib/guarantees-config-db"
import { getOverdraftStatusForOwner, computeOverdraftStatus, getSettledBalanceEur } from "@/lib/overdraft"
import { buildOverdraftInterestPosts } from "@/lib/overdraft-interest"
import { gatherGuaranteeProfile, getFinancingRingfence } from "@/lib/guarantees-profile"
import { guaranteeBlockMessage } from "@/lib/guarantees-accumulator"
import { planReservation, formatMoney, type ReservationPlan } from "@/lib/fund-reservation"
import { cardFeeFor, formatCardFee, CARD_FEE_CURRENCY } from "@/lib/card-fees"
import { instrumentManagementFee, INSTRUMENT_MANAGEMENT_FEE_LABEL } from "@/lib/instrument-fees"
import { applyCashbackForOwner } from "@/lib/fee-cashback-db"
import { cashbackNote, applyCashback, formatCashbackPct } from "@/lib/fee-cashback"
import { leverageApplicationCharges } from "@/lib/leverage-audit-fee"
import { computeMonetizationEquity } from "@/lib/monetization-equity"
import { readStampedTrustScore } from "@/lib/ppi-trust"
import { buildTradingFundPosts, TRADING_FUND_MONTHLY_ROI, type TradingFundPauseWindow } from "@/lib/trading-fund"
import {
  buildPppRoiPosts,
  buildPppCapitalPosts,
  pppCapitalId,
  pppCapitalReturnId,
  pppIsCashFunded,
  yieldCancellationPenalty,
} from "@/lib/ppp-yield"
import {
  INSTRUMENT_UPGRADE_FEE_LABEL,
  INSTRUMENT_UPGRADE_FEE_RATE,
  instrumentUpgradeFee,
  type InstrumentUpgrade,
} from "@/lib/instrument-upgrade"
import { findInstrumentType } from "@/lib/instrument-marketplace"
import { buildInstrumentIdentifiers, generateCusip } from "@/lib/instrument-identifiers"
import { buildInternalLoanPosts } from "@/lib/internal-loan"
import { isLiveRequest } from "@/lib/live-request"
import type { LedgerEntry } from "@/lib/ledger-store"
import { insertNotification } from "@/lib/notifications-db"
import {
  insertApproval,
  listApprovalsForUser,
  listApprovalsForUsers,
  listAllApprovals,
  listApprovalsForMaster,
  countPendingByKind,
  countPaymentsAwaitingDelivery,
  countYieldTerminationRequests,
  countTradingFundTerminationRequests,
  countInstrumentUpgradeRequests,
  countInstrumentExitRequests,
  listInstrumentExitRequests,
  decideApproval,
  recordAdminDecision,
  recordMasterDecision,
  cancelApproval,
  revokeApprovedApproval,
  adminRevokeApprovedApproval,
  markApprovalTransferred,
  markApprovalDelivered,
  getApprovalById,
  updateApprovalPayload,
  updateApprovalTerms,
  deleteApproval,
  deleteApprovalForUser,
  type ApprovalRequest,
  type ApprovalStatus,
  type LedgerEffect,
} from "@/lib/approvals-db"
import { KIND_LABELS, KIND_HREF, type ApprovalKind } from "@/lib/approval-kinds"
import { parseQuantityString } from "@/lib/petroleum-products"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { notifyAllAdminsOfSubmission } from "@/lib/notify-admins"
import { getVessel as dbGetVessel } from "@/lib/spot-deals-db"
import { fetchVesselByImo, screenVesselImo } from "@/lib/vessel-providers"
import { isValidImo, VESSEL_TYPE_LABELS, type Vessel } from "@/lib/spot-deals-shared"
import {
  recordGatewayDepositForApproval,
  backfillGatewayDepositsForUser,
  reverseGatewayDepositForApproval,
  recordRegisteredAccountDepositForApproval,
  backfillRegisteredAccountDepositsForUser,
  reverseRegisteredAccountDepositForApproval,
  recordMasterBankingDepositForApproval,
  reverseMasterBankingDepositForApproval,
} from "@/app/actions/reconciliation"
import { MASTER_CONSENT_KINDS, requiresMasterConsent } from "@/lib/account-hierarchy"

// The platform's base / master-account settlement currency. Every master
// balance check in the app (admin, payments, accounts) is denominated in EUR
// (`MASTER_ACCOUNT_CURRENCY = "EUR"`), so a ledger posting whose currency is
// missing MUST fall back to EUR — not USD. Defaulting to USD routed currency-
// less credits (e.g. leverage borrowed funds) into a phantom USD bucket that
// the EUR-based master account never reflects, which is why a leverage line
// appeared to credit USD instead of the master EUR balance.
const BASE_CURRENCY = "EUR"

// --- Auth helpers -----------------------------------------------------------

// Server-side admin gate: the caller must be an authorized admin ACCOUNT and
// present the correct PIN. Async because it resolves the session on the server.
async function adminOk(passcode: string): Promise<boolean> {
  return adminActionAuthorized(passcode)
}

// --- Client-facing ----------------------------------------------------------

export interface SubmitApprovalInput {
  kind: ApprovalKind
  title: string
  summary: string
  amount?: number | null
  currency?: string | null
  payload?: Record<string, unknown>
  /** Optional ledger effect applied to the owner's balance on approval. */
  ledgerEffect?: LedgerEffect | null
}

export type SubmitApprovalResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

/** Submit a new request for administrator decision (status = pending). */
export async function submitApproval(input: SubmitApprovalInput): Promise<SubmitApprovalResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  if (!input.kind || !KIND_LABELS[input.kind]) {
    return { ok: false, error: "Unknown request type." }
  }

  // Server-authoritative duplicate guard for monetizations. An instrument that
  // already has a LIVE (pending OR approved) monetization is pledged and cannot
  // be monetized again — otherwise the same bond can be advanced against twice
  // (the "two Authorized monetizations on one bond" bug). The client UI also
  // gates this, but a client-only check is bypassable by stale dialog state, a
  // second tab, or another device, so the authoritative check lives here where
  // every submission (mirrored via /api/approvals) must pass. A rejected or
  // reversed/cancelled monetization frees the instrument to be monetized again.
  if (input.kind === "monetization") {
    const instrumentId = (input.payload?.record as { instrumentId?: string } | undefined)?.instrumentId
    if (instrumentId) {
      try {
        const memberIds = await resolveEnvironmentMemberIds(session.id)
        const existingMonetizations = await listApprovalsForUsers(memberIds, "monetization")
        const clash = existingMonetizations.find((r) => {
          const rid = (r.payload?.record as { instrumentId?: string } | undefined)?.instrumentId
          return rid === instrumentId && (r.status === "pending" || r.status === "approved")
        })
        if (clash) {
          return {
            ok: false,
            error: `${instrumentId} already has ${
              clash.status === "approved" ? "an active" : "a pending"
            } monetization request. Reverse or reject it before monetizing this instrument again.`,
          }
        }
      } catch (err) {
        console.log("[v0] monetization duplicate guard check failed:", (err as Error).message)
      }
    }
  }

  // Trading-fund subscriptions RESERVE (block) their capital on the master
  // account the moment they are submitted (a pending `hold`). You cannot reserve
  // funds you do not have, so this gate refuses an application whose capital
  // exceeds the available balance — otherwise the reservation would drive the
  // balance negative (the "allocated tokens with no funds" bug). This is the
  // authoritative check: the client UI also blocks it, but a UI-only guard is
  // bypassable by stale state or another device, so it must live here where
  // every mirrored submission passes.
  // Guarantees Accumulator — HIGH-RISK gate. Opening NEW financing/exposure
  // (leverage, monetization, project funding, treasury lending) is refused in
  // real time while the account is classified High Risk. Risk-reducing actions
  // (e.g. leverage_switchoff) are never blocked. Fails OPEN on any error — this
  // is a policy control, not the solvency guard, so a transient failure must
  // not block all financing.
  const GUARANTEE_GATED_KINDS = new Set(["leverage", "monetization", "project_funding", "treasury_lending"])
  // Collects human-readable reasons a LEVERAGE application tripped a protective
  // FINANCIAL gate (controlled overdraft, high guarantee risk, thin margin, or
  // unaffordable upfront charges). Policy: leverage is NEVER silently dropped for
  // these — the request is still created as PENDING, EVERY administrator is
  // notified, and these flags travel on the payload so the admin sees exactly why
  // it needs a decision and can approve or reject. (Genuine INTEGRITY failures —
  // malformed equity, double-pledged collateral — still hard-fail below.) Other
  // credit-sensitive kinds keep their automatic hard block.
  const leverageReviewFlags: string[] = []

  if (GUARANTEE_GATED_KINDS.has(input.kind)) {
    try {
      const config = await getGuaranteeConfig()
      if (config.enforce) {
        const { score, overdraft } = await gatherGuaranteeProfile(session.id, config)
        const productLabel =
          input.kind === "leverage"
            ? "leverage"
            : input.kind === "monetization"
              ? "instrument monetization"
              : input.kind === "project_funding"
                ? "project funding"
                : "treasury financing"
        // Controlled-overdraft HARD BLOCK: an overdrawn (negative) Master
        // Account cannot open ANY new credit-sensitive facility until it
        // returns to positive — regardless of the numeric risk score.
        const eur = (n: number) =>
          `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        if (overdraft.inOverdraft) {
          if (input.kind === "leverage") {
            // Do NOT drop it — route to the administrators with a clear flag.
            leverageReviewFlags.push(
              `Master Account was in a controlled overdraft (${eur(overdraft.negativeEur)} negative) at submission.`,
            )
          } else {
            return {
              ok: false,
              error:
                `This ${productLabel} request cannot be opened while your Master Account is in a controlled ` +
                `overdraft (currently ${eur(overdraft.negativeEur)} negative). New credit-sensitive facilities ` +
                `are unavailable until your account returns to a positive balance. Fund your account to clear the ` +
                `overdraft, then try again.`,
            }
          }
        }
        if (score.highRisk) {
          if (input.kind === "leverage") {
            leverageReviewFlags.push(
              `Guarantee risk score was HIGH (above the ${config.highRiskThreshold} threshold) at submission.`,
            )
          } else {
            return { ok: false, error: guaranteeBlockMessage(score, config.highRiskThreshold, productLabel) }
          }
        }
      }
    } catch (err) {
      console.log("[v0] guarantees high-risk gate failed (failing open):", (err as Error).message)
    }
  }

  // Leverage — MARGIN SOLVENCY gate. A cash-funded leveraged line (Treasury,
  // Master Banking, NAFTAhub) requires the client to commit their OWN FREE cash
  // as margin. Capacity is FREE EQUITY = spendable balance − outstanding
  // borrowed/financed principal (`totalExposure`), so borrowed money can never
  // back a new line: a client living on a loan (e.g. a 25M internal loan whose
  // proceeds inflate the available balance) has ~0 free equity and is refused in
  // real time. We deliberately DO NOT add posted `guarantees` here — a pledged
  // instrument or the equity-saving pot (often itself funded by the loan) is
  // collateral, not spendable margin; a client who wants to back a line with an
  // instrument uses the "Bank Instruments" funding source, which is validated
  // against the instrument's face value and skips this cash test. This mirrors
  // the Equity-Saving "own funds only" rule (freeEur = available − exposure).
  // Runs regardless of the guarantee enforce toggle — solvency is not a policy
  // option. Fails CLOSED (a balance that can't be verified blocks).
  if (input.kind === "leverage") {
    const rec = ((input.payload as Record<string, unknown> | undefined)?.record ?? {}) as Record<string, unknown>
    const account = String(rec.account ?? "")
    const equity = Number(rec.equity)
    const reqCurrency = String(rec.currency || input.currency || BASE_CURRENCY)
    const CASH_FUNDED = new Set(["treasury", "master", "naftahub"])
    if (CASH_FUNDED.has(account)) {
      if (!Number.isFinite(equity) || equity <= 0) {
        return { ok: false, error: "The margin (equity) amount for this leveraged line is invalid." }
      }
      try {
        const config = await getGuaranteeConfig()
        const { score } = await gatherGuaranteeProfile(session.id, config)
        // score.inputs figures are all normalised to EUR (BASE). Free equity is
        // the client's OWN unborrowed money: available balance less outstanding
        // borrowed/financed principal. Borrowed proceeds and pledged collateral
        // are excluded.
        const netFreeEur = Math.max(
          0,
          (score.inputs.availableBalance || 0) - (score.inputs.totalExposure || 0),
        )
        const equityEur = convertCurrency(equity, reqCurrency, BASE_CURRENCY)
        if (equityEur > netFreeEur + 0.01) {
          const fmtEur = (n: number) =>
            `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          // Route to the administrators rather than dropping the request.
          leverageReviewFlags.push(
            `Free equity (${fmtEur(netFreeEur)}) did not cover the ${fmtEur(
              equityEur,
            )} own-cash margin pledged for this cash-funded line at submission.`,
          )
        }
      } catch (err) {
        console.log("[v0] leverage margin solvency gate could not verify (flagging for admin):", (err as Error).message)
        leverageReviewFlags.push("Available margin could not be automatically verified at submission.")
      }
    }
  }

  // Leverage — UPFRONT CHARGES solvency gate. EVERY leverage application (cash-
  // OR instrument-funded) triggers an audit/compliance review and a verification
  // handshake with the Treasury bank partner, who bills the platform whether the
  // line is ACCEPTED or REJECTED, plus a PPI insurance premium. Both charges
  // (audit fee = 0.001% × multiplier × buying power; PPI = 1% × buying power) are
  // debited to the Master Account the moment the client confirms. If the Master
  // Account cannot cover the COMBINED total, the whole operation is denied here
  // so no request is ever created without its charges. Charged in the line's own
  // currency. Fails CLOSED.
  // PPI TRUST-SCORE PRICING — fetch the customer's Guarantees Accumulator trust
  // score ONCE here so the leverage charge gate + the posted PPI hold both price
  // off the same value, and stamp it on the record (below) so the admin
  // approve-settlement, PPI negotiation and refund all recompute the identical
  // premium. Applies to leverage & monetization. Fails soft → base premium.
  let ppiTrustScore: number | undefined
  if (input.kind === "leverage" || input.kind === "monetization") {
    try {
      const cfg = await getGuaranteeConfig()
      const prof = await gatherGuaranteeProfile(session.id, cfg)
      ppiTrustScore = prof.score.finalScore
    } catch (err) {
      console.log("[v0] PPI trust-score fetch failed (using base premium):", (err as Error).message)
    }
  }

  if (input.kind === "leverage") {
    const rec = ((input.payload as Record<string, unknown> | undefined)?.record ?? {}) as Record<string, unknown>
    const equity = Number(rec.equity)
    const ratio = Number(rec.leverageRatio)
    const feeCurrency = String(rec.currency || input.currency || BASE_CURRENCY)

    // DOUBLE-PLEDGE BAN — a bank instrument already securing a live facility
    // (leverage / loan / monetization / PPP) cannot back another leverage line
    // ("debit on debit"). Authoritative backstop for the client picker guard.
    const pledgedId = typeof rec.pledgedInstrumentId === "string" ? rec.pledgedInstrumentId : ""
    if (pledgedId) {
      const engagedBy = await instrumentPledgedElsewhere(pledgedId, session.id)
      if (engagedBy) {
        return {
          ok: false,
          error: `This bank instrument is already pledged to ${engagedBy}, so it cannot back another leverage line. Each instrument can secure only one facility at a time — close or settle the existing one first, or pledge a different instrument.`,
        }
      }
    }
    // PPI APPEAL EXCEPTION: when the client cannot afford the upfront charges and
    // submits an appeal, the charges are reserved as temporary HOLDS (see the
    // charge block below) that may push available balance negative pending admin
    // review — the audit fee is charged if affordable, otherwise held, and the
    // PPI is always held. So an appeal has NO upfront affordability requirement
    // at all (never a dead end). Only the NORMAL submit must cover the full
    // combined total. Fails CLOSED (a balance that can't be verified blocks).
    const isPpiAppeal = rec.ppiAppeal === true
    const charges = leverageApplicationCharges(equity, ratio, ppiTrustScore)
    const requiredNow = isPpiAppeal ? 0 : charges.total
    if (requiredNow > 0) {
      try {
        const ownerId = await resolveDataOwnerIdFor(session.id)
        const available = availableByCurrency(await readLedgerEntries(ownerId))
        const availableInFeeCcy = Object.entries(available).reduce(
          (sum, [cur, amt]) => sum + convertCurrency(amt, cur, feeCurrency),
          0,
        )
        if (requiredNow > availableInFeeCcy + 0.01) {
          const fmt = (n: number) =>
            `${feeCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          // The upfront charges are reserved as reversible HOLDS below, so the
          // line can still go to the administrators even when the balance can't
          // cover them right now. Flag it so the admin knows the charges are held
          // against an insufficient balance pending their decision.
          leverageReviewFlags.push(
            `Master Account (${fmt(
              Math.max(0, availableInFeeCcy),
            )} available) could not cover the ${fmt(charges.total)} non-refundable upfront charges (${fmt(
              charges.auditFee,
            )} audit & compliance + ${fmt(charges.ppi)} PPI) at submission — reserved as holds pending review.`,
          )
        }
      } catch (err) {
        console.log("[v0] leverage upfront charges could not verify (flagging for admin):", (err as Error).message)
        leverageReviewFlags.push("Upfront-charge affordability could not be automatically verified at submission.")
      }
    }
  }

  if (input.kind === "trading_fund") {
    const capital = Number(input.amount)
    if (!Number.isFinite(capital) || capital <= 0) {
      return { ok: false, error: "The subscription amount is invalid." }
    }
    try {
      const ownerId = await resolveDataOwnerIdFor(session.id)
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const reqCurrency = input.currency || BASE_CURRENCY
      // Total spendable balance, every currency converted into the subscription
      // currency (mirrors the approval gate's capped cross-currency FX funding).
      const totalAvailable = Object.entries(available).reduce(
        (sum, [cur, amt]) => sum + convertCurrency(amt, cur, reqCurrency),
        0,
      )
      if (capital > totalAvailable + 0.01) {
        const fmt = (n: number) =>
          `${reqCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        return {
          ok: false,
          error: `Insufficient funds to allocate these tokens. This subscription reserves ${fmt(
            capital,
          )} but only ${fmt(
            Math.max(0, totalAvailable),
          )} is available on your master account. Fund the account before applying.`,
        }
      }
    } catch (err) {
      console.log("[v0] trading_fund solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your available balance could not be verified. Please try again." }
    }
  }

  // A CASH-funded Yield / PPP program deploys the invested principal from the
  // master account, so the client cannot invest more than they hold — refuse the
  // submission before it ever reaches the administrator. An INSTRUMENT-funded
  // program is collateralized by the pledged bank instrument (no cash moves), so
  // it is NOT balance-gated here. Authoritative (a client-only check is bypassable).
  if (input.kind === "ppp") {
    const record = (input.payload?.record ?? {}) as { amount?: number; currency?: string; fundingInstrumentId?: string }
    if (pppIsCashFunded(record)) {
      const capital = Number(record.amount ?? input.amount)
      if (!Number.isFinite(capital) || capital <= 0) {
        return { ok: false, error: "The investment amount is invalid." }
      }
      try {
        const ownerId = await resolveDataOwnerIdFor(session.id)
        const available = availableByCurrency(await readLedgerEntries(ownerId))
        const reqCurrency = record.currency || input.currency || BASE_CURRENCY
        const totalAvailable = Object.entries(available).reduce(
          (sum, [cur, amt]) => sum + convertCurrency(amt, cur, reqCurrency),
          0,
        )
        if (capital > totalAvailable + 0.01) {
          const fmt = (n: number) =>
            `${reqCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          return {
            ok: false,
            error: `Insufficient funds for this investment. It deploys ${fmt(capital)} from your master account but only ${fmt(
              Math.max(0, totalAvailable),
            )} is available. Fund the account, invest less, or back the program with a bank instrument.`,
          }
        }
      } catch (err) {
        console.log("[v0] ppp solvency guard failed:", (err as Error).message)
        return { ok: false, error: "Your available balance could not be verified. Please try again." }
      }
    }
  }

  // Requesting a new card carries a one-time issuance fee charged to the Master
  // Account (virtual €300 / physical €1,000). This gate REJECTS the request in
  // real time if the balance can't cover the fee, so no card and no charge are
  // created. Authoritative (a client-only check is bypassable). The actual debit
  // is posted after the approval row is inserted (see below).
  if (input.kind === "card") {
    const format = (input.payload?.card as { format?: string } | undefined)?.format
    const standardFee = cardFeeFor(format)
    try {
      const ownerId = await resolveDataOwnerIdFor(session.id)
      // Admin-set cashback reduces the issuance fee — the customer only needs to
      // afford (and is only charged) the net amount.
      const fee = (await applyCashbackForOwner(ownerId, "platform", standardFee)).netFee
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const availableEur = Object.entries(available).reduce(
        (sum, [cur, amt]) => sum + convertCurrency(amt, cur, CARD_FEE_CURRENCY),
        0,
      )
      if (fee > availableEur + 0.01) {
        return {
          ok: false,
          error: `Requesting a ${
            format === "virtual" ? "virtual" : "physical"
          } card carries a one-time ${formatCardFee(
            fee,
          )} issuance fee, but your Master Account has only ${formatCardFee(
            Math.max(0, availableEur),
          )} available. Please fund your account and try again.`,
        }
      }
    } catch (err) {
      console.log("[v0] card fee solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your available balance could not be verified. Please try again." }
    }
  }

  // Outgoing payments must respect the administrator-configured account limits
  // (Daily Limit + Monthly Volume). This is the AUTHORITATIVE hard block — the
  // Payments page also pre-checks for a friendly message, but a client-only
  // guard is bypassable (stale state, another device, a direct mirror call), so
  // enforcement must live here where every submission passes. The value counted
  // is the payment PRINCIPAL (what is sent to the beneficiary), converted into
  // the limit's currency; the 2% platform fee is not counted toward the cap.
  // Unlimited (or an unset 0) figure = no cap, so this never blocks by default.
  if (input.kind === "payment") {
    try {
      const limits = await getAccountLimits(session.id)
      const dailyCap = limitCap(limits.dailyLimitAmount, limits.dailyLimitUnlimited)
      const monthlyCap = limitCap(limits.monthlyVolumeAmount, limits.monthlyVolumeUnlimited)
      // Only do the (slightly costlier) window summation when a cap is actually set.
      if (dailyCap != null || monthlyCap != null) {
        const principalOf = (amount: number | null, payload?: Record<string, unknown>): number => {
          const rec = payload?.record as { amount?: number } | undefined
          if (typeof rec?.amount === "number" && Number.isFinite(rec.amount)) return rec.amount
          return Number(amount) || 0
        }
        const attempted = convertCurrency(
          principalOf(input.amount ?? null, input.payload),
          input.currency || BASE_CURRENCY,
          limits.currency,
        )
        const now = new Date()
        const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
        const prior = await listApprovalsForUser(session.id, "payment")
        let priorDaily = 0
        let priorMonthly = 0
        for (const r of prior) {
          // Rejected / cancelled payments never left the account, so they don't count.
          if (r.status === "rejected" || r.status === "cancelled") continue
          const t = Date.parse(r.createdAt)
          if (Number.isNaN(t)) continue
          const value = convertCurrency(
            principalOf(r.amount, r.payload),
            r.currency || BASE_CURRENCY,
            limits.currency,
          )
          if (t >= monthStart) priorMonthly += value
          if (t >= dayStart) priorDaily += value
        }
        const assessment = assessPaymentAgainstLimits({
          limits,
          priorDailyTotal: priorDaily,
          priorMonthlyTotal: priorMonthly,
          amount: attempted,
        })
        if (!assessment.ok) {
          return { ok: false, error: limitBlockMessage(assessment) }
        }
      }
    } catch (err) {
      // Fail OPEN on an unexpected error: the account limit is a policy control,
      // not the solvency guard (balance is separately enforced by
      // assertOwnerSolvent at approval), so a transient DB blip must not block
      // all payments. The failure is logged for investigation.
      console.log("[v0] payment limit guard failed:", (err as Error).message)
    }
  }

  // RING-FENCE borrowed funds on outbound payments. Leverage lines and loans
  // credit the balance with proceeds scoped strictly for trading (buying power)
  // and repayment — they must never leave the account as a payment/transfer to a
  // third party. When the payer carries outstanding borrowing, the payment
  // principal must come from their OWN free funds (aggregate available −
  // outstanding financing, EUR). Accounts with no borrowing are unaffected. This
  // mirrors the instant-transfer ring-fence and the leverage margin rule.
  if (input.kind === "payment") {
    try {
      const { freeEur, exposureEur } = await getFinancingRingfence(session.id)
      if (exposureEur > 0.01) {
        const rec = (input.payload?.record ?? {}) as { amount?: number }
        const principal =
          typeof rec.amount === "number" && Number.isFinite(rec.amount)
            ? rec.amount
            : Number(input.amount) || 0
        const principalEur = convertCurrency(principal, input.currency || BASE_CURRENCY, BASE_CURRENCY)
        if (principalEur > freeEur + 0.01) {
          const fmt = (n: number) =>
            `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          return {
            ok: false,
            error: `This payment would draw on borrowed funds. Leveraged and loan proceeds are reserved for trading on NAFTAhub and cannot be paid out to a third party. Your own transferable funds are ${fmt(freeEur)} — you currently have ${fmt(exposureEur)} of outstanding financing. Repay the financing or use your own funds to make this payment.`,
          }
        }
      }
    } catch (err) {
      // Defensive: the profile degrades rather than throws, so this rarely fires.
      // Do not block on an unexpected read failure — solvency is separately
      // enforced by assertOwnerSolvent at approval.
      console.log("[v0] payment ring-fence guard failed (allowing):", (err as Error).message)
    }
  }

  // When an outgoing payment is remitted FROM a specific sub-account
  // compartment, the funds must come out of THAT compartment's isolated
  // balance — so it must hold enough to cover the full debit (principal + fee)
  // in the payment currency. `assertOwnerSolvent` only guards the aggregate
  // (main + all compartments), so a compartment-scoped check is required here
  // to stop one compartment overdrawing while another has funds. Absent a
  // sub-account tag this is skipped and the main-account behaviour is unchanged.
  if (input.kind === "payment" && input.ledgerEffect?.subAccountId && input.ledgerEffect.direction === "debit") {
    try {
      const subId = input.ledgerEffect.subAccountId
      const cur = input.ledgerEffect.currency || input.currency || BASE_CURRENCY
      const need = Number(input.ledgerEffect.amount) || 0
      const ownerId = await resolveDataOwnerIdFor(session.id)
      const rows = await readLedgerEntries(ownerId)
      // Net balance of just this compartment in the payment currency: settled
      // credits − settled debits − held debits tagged with this sub-account id.
      const available = rows.reduce((sum, e) => {
        if (e.currency !== cur || (e.subAccountId || undefined) !== subId) return sum
        if (e.status === "hold") return e.direction === "debit" ? sum - e.amount : sum
        return sum + (e.direction === "credit" ? e.amount : -e.amount)
      }, 0)
      if (need > available + 0.01) {
        return {
          ok: false,
          error: `Insufficient funds in the selected sub-account. This transfer needs ${cur} ${need.toLocaleString(
            "en-US",
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          )} but only ${cur} ${Math.max(0, available).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} is available in that compartment.`,
        }
      }
    } catch (err) {
      console.log("[v0] sub-account payment solvency guard failed:", (err as Error).message)
      return { ok: false, error: "Your sub-account balance could not be verified. Please try again." }
    }
  }

  // A Sub-account's outgoing payments must clear a second gate: their Master's
  // consent (in addition to administrator approval). Detected here from the
  // authoritative session, so no client can opt out of the Master gate. Joint
  // (J) accounts are deliberately NOT gated — they act with the Master's full
  // authority — which `requiresMasterConsent` encodes (sub only).
  const requiresMasterApproval =
    requiresMasterConsent(session.relationship) && !!session.masterId && MASTER_CONSENT_KINDS.has(input.kind)

  // Persist any leverage review flags onto the record so the administrators see
  // WHY the pending line needs attention (overdraft, thin margin, unaffordable
  // charges) — a durable trace, not just a transient notification.
  if (leverageReviewFlags.length > 0) {
    const payloadObj = (input.payload ?? {}) as Record<string, unknown>
    const rec = (payloadObj.record ?? {}) as Record<string, unknown>
    rec.adminReviewFlags = leverageReviewFlags
    rec.needsAdminReview = true
    payloadObj.record = rec
    input.payload = payloadObj
  }

  // ROI WITHDRAWAL LOCK — funding-source detection. An investment (Yield/PPP or
  // Treuhand fund) counts as LEVERAGE/DEBIT-funded when the customer carries any
  // outstanding borrowed/financed exposure at the moment they invest (their
  // master balance is partly borrowed money). Its ROI is then credited but LOCKED
  // (PPP: until maturity; Treuhand: 3 months rolling per credit). A customer with
  // ZERO borrowed exposure invests pure real money → ROI is freely withdrawable.
  // Stamp the flag ONCE here so the ROI engines decide deterministically; legacy
  // programs with no flag default to free (never retroactively locked).
  // Stamp the PPI trust score used at submission onto the record so every later
  // recompute (approve-settlement, PPI negotiation, reserve negotiation, refund)
  // prices off the identical score. For monetization the client posts the reserve
  // hold, so it may have already stamped the score it used — never overwrite that.
  if (input.kind === "leverage" || input.kind === "monetization") {
    const payloadObj = (input.payload ?? {}) as Record<string, unknown>
    const rec = (payloadObj.record ?? {}) as Record<string, unknown>
    if (rec.ppiTrustScore === undefined || rec.ppiTrustScore === null) {
      if (ppiTrustScore !== undefined) rec.ppiTrustScore = ppiTrustScore
    }
    payloadObj.record = rec
    input.payload = payloadObj
  }

  if (input.kind === "ppp" || input.kind === "trading_fund") {
    try {
      const config = await getGuaranteeConfig()
      const { score } = await gatherGuaranteeProfile(session.id, config)
      const leverageFunded = (score.inputs.totalExposure ?? 0) > 0.01
      const payloadObj = (input.payload ?? {}) as Record<string, unknown>
      if (input.kind === "ppp") {
        // PPP stores the investment under payload.record.
        const rec = (payloadObj.record ?? {}) as Record<string, unknown>
        rec.leverageFunded = leverageFunded
        payloadObj.record = rec
      } else {
        // Treuhand stores its fields at the payload root.
        payloadObj.leverageFunded = leverageFunded
      }
      input.payload = payloadObj
    } catch (err) {
      console.log("[v0] ROI funding-source detection failed (defaulting to freely withdrawable):", (err as Error).message)
    }
  }

  try {
    const request = await insertApproval({
      userId: session.id,
      kind: input.kind,
      title: input.title?.trim() || KIND_LABELS[input.kind],
      summary: input.summary?.trim() || "",
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      payload: input.payload ?? {},
      ledgerEffect: input.ledgerEffect ?? null,
      requiresMasterApproval,
      masterId: requiresMasterApproval ? session.masterId : null,
      initiatedById: requiresMasterApproval ? session.id : null,
      initiatedByName: requiresMasterApproval ? session.profile.fullName : null,
    })

    // Charge the one-time card issuance fee to the Master Account. The solvency
    // gate above already verified affordability; here we post the debit with a
    // DETERMINISTIC id (`CARD-FEE-<approvalId>`) so a retry can never double-
    // charge. If the debit fails we roll back the just-created request so the
    // client is never left with a card they weren't charged for.
    if (input.kind === "card") {
      const format = (input.payload?.card as { format?: string } | undefined)?.format ?? "physical"
      const standardFee = cardFeeFor(format)
      try {
        const ownerId = await resolveDataOwnerIdFor(session.id)
        const cb = await applyCashbackForOwner(ownerId, "platform", standardFee)
        const fee = cb.netFee
        await upsertLedgerEntry(ownerId, {
          id: `CARD-FEE-${request.id}`,
          direction: "debit",
          amount: fee,
          currency: CARD_FEE_CURRENCY,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: "MCC Capital — Card Issuance",
          bank: "MCC Capital",
          reference: request.id,
          comment: `One-time issuance fee for the requested ${format} card (${request.id}).${cashbackNote(cb, CARD_FEE_CURRENCY)}`,
          category: "Card Issuance Fee",
        })
        try {
          await insertNotification({
            userId: ownerId,
            tone: "info",
            title: "Card issuance fee charged",
            body: `A one-time ${formatCardFee(fee)} fee was charged for your new ${format} card request (${request.id}), now pending approval.`,
            href: "/dashboard/cards",
          })
        } catch {
          // notification is non-critical
        }
      } catch (feeErr) {
        await deleteApprovalForUser(request.id, session.id).catch(() => {})
        console.log("[v0] card issuance fee charge failed:", (feeErr as Error).message)
        return { ok: false, error: "The card issuance fee could not be processed. Please try again." }
      }
    }

    // Charge the leverage audit & compliance fee to the Master Account. The
    // solvency gate above already verified affordability; here we post the debit
    // with a DETERMINISTIC id (`LEV-AUDIT-<approvalId>`) so a retry can never
    // double-charge. This cost is incurred by the platform from the Treasury
    // partner regardless of the eventual accept/reject decision, so it is taken
    // now. If the debit fails we roll back the just-created request.
    if (input.kind === "leverage") {
      const rec = ((input.payload as Record<string, unknown> | undefined)?.record ?? {}) as Record<string, unknown>
      const equity = Number(rec.equity)
      const ratio = Number(rec.leverageRatio)
      const feeCurrency = String(rec.currency || input.currency || BASE_CURRENCY)
      const isPpiAppeal = rec.ppiAppeal === true
      const charges = leverageApplicationCharges(equity, ratio, ppiTrustScore)
      if (charges.total > 0) {
        const fmtCcy = (n: number) =>
          `${feeCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        try {
          const ownerId = await resolveDataOwnerIdFor(session.id)
          // CHARGE TIMING POLICY: nothing is a REAL (completed) charge at submit.
          // Both the audit & compliance fee and the PPI premium are reserved as
          // reversible HOLDS while the application is pending. They only become
          // completed charges when an administrator actually REVIEWS/decides the
          // line (approve → both settle; reject → audit settles, PPI released),
          // and they are RELEASED entirely if the client withdraws/abandons the
          // pending line — so applying and walking away costs nothing. Holds use
          // DETERMINISTIC ids so a retry never double-reserves.
          if (charges.auditFee > 0) {
            await upsertLedgerEntry(ownerId, {
              id: `LEV-AUDIT-${request.id}`,
              direction: "debit",
              amount: charges.auditFee,
              currency: feeCurrency,
              status: "hold",
              date: new Date().toISOString(),
              counterparty: "MCC Capital — Leverage Audit & Compliance",
              bank: "MCC Capital",
              reference: request.id,
              comment: `Reserved (hold) – Pending Admin Review. ${fmtCcy(charges.auditFee)} audit, compliance & Treasury-partner verification fee for leverage application ${request.id}. Charged only when an administrator reviews the line; released in full if you withdraw before review.`,
              category: "Leverage Audit Fee",
            })
          }
          if (charges.ppi > 0) {
            await upsertLedgerEntry(ownerId, {
              id: `LEV-PPI-${request.id}`,
              direction: "debit",
              amount: charges.ppi,
              currency: feeCurrency,
              status: "hold",
              date: new Date().toISOString(),
              counterparty: "MCC Capital — Payment Protection Insurance",
              bank: "MCC Capital",
              reference: request.id,
              comment: `Reserved (hold) – Pending Admin Review. ${fmtCcy(charges.ppi)} PPI insurance premium for leverage application ${request.id}. Charged only on approval; released in full if the line is rejected or you withdraw before review.`,
              category: "Leverage PPI Insurance",
            })
          }
          try {
            await insertNotification({
              userId: ownerId,
              tone: "info",
              title: "Leverage application submitted for review",
              body: `Your 1:${ratio} leverage application (${request.id}) is pending administrator review. ${fmtCcy(
                charges.total,
              )} (${fmtCcy(charges.auditFee)} audit & compliance + ${fmtCcy(
                charges.ppi,
              )} PPI) is temporarily RESERVED (held) — not yet charged. Nothing is debited unless an administrator reviews the line, and it is released in full if you withdraw beforehand.`,
              href: "/dashboard/leverage",
            })
          } catch {
            // notification is non-critical
          }
        } catch (feeErr) {
          await deleteApprovalForUser(request.id, session.id).catch(() => {})
          console.log("[v0] leverage upfront charges failed:", (feeErr as Error).message)
          return { ok: false, error: "The leverage application charges could not be reserved. Please try again." }
        }
      }
    }

    // Let the Master know one of their Sub-accounts needs their consent.
    if (requiresMasterApproval && session.masterId) {
      try {
        await insertNotification({
          userId: session.masterId,
          tone: "warning",
          title: "Sub-account payment needs your approval",
          body: `${session.profile.fullName} requested an outgoing payment ("${
            input.title?.trim() || KIND_LABELS[input.kind]
          }") that requires your consent.`,
          href: "/dashboard/network",
        })
      } catch (err) {
        console.log("[v0] master consent notification failed:", (err as Error).message)
      }
    }

    // NOTE: We intentionally do NOT emit an activity-log email here. The
    // client flow that mirrors the submission (e.g. the Payments page) already
    // logs the activity with the correct signed-in user. Logging again here
    // produced a duplicate email — and, because this server context passes no
    // `user`, it fell back to a hardcoded demo name, misattributing the action
    // to the wrong client. The approvals backbone's role is DB persistence for
    // administrator review, not activity notification.

    // Alert EVERY administrator (not just the proprietor) so any of them can
    // review and act. Skip when the request still needs the Master's consent
    // first (`awaiting_master`) — it isn't pending admin review yet; the Master
    // was already notified above, and the admins will be alerted when the
    // Master approves and the request advances to pending. Best-effort.
    if (!requiresMasterApproval) {
      const ownerId = await resolveDataOwnerIdFor(session.id).catch(() => session.id)
      await notifyAllAdminsOfSubmission({
        customerName: session.profile.fullName,
        kind: input.kind,
        title: input.title?.trim() || KIND_LABELS[input.kind],
        amount: input.amount,
        currency: input.currency,
        excludeIds: [session.id, ownerId],
      })
    }

    return { ok: true, request }
  } catch (err) {
    console.log("[v0] submitApproval failed:", (err as Error).message)
    return { ok: false, error: "Your request could not be submitted. Please try again." }
  }
}

/** The signed-in user's own requests (optionally filtered by kind). */
export async function listMyApprovals(kind?: ApprovalKind): Promise<ApprovalRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    // A Joint account shares its Master's ENTIRE environment, so it sees the
    // whole environment's requests. For every other account this resolves to
    // just its own id, so the behaviour is unchanged.
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    return await listApprovalsForUsers(memberIds, kind)
  } catch (err) {
    console.log("[v0] listMyApprovals failed:", (err as Error).message)
    return []
  }
}

/** Cancel one of the user's own still-pending requests. */
export async function cancelMyApproval(id: string): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const cancelled = await cancelApproval(id, session.id)
    if (!cancelled) return { ok: false, error: "This request can no longer be cancelled." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] cancelMyApproval failed:", (err as Error).message)
    return { ok: false, error: "The request could not be cancelled. Please try again." }
  }
}

/**
 * Client WITHDRAWS a still-pending leverage application (before any admin
 * review). Because the audit & PPI charges are only RESERVED as reversible
 * holds at submit — never charged until an administrator reviews — withdrawing
 * releases those holds in full and cancels the request, so the client's balance
 * is fully restored. This is the fix for "applied, realised I lacked funds,
 * walked away, but was still debited": abandoning an unreviewed line now costs
 * nothing.
 */
export async function withdrawMyLeverageApplication(id: string): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Leverage application not found." }
    if (existing.kind !== "leverage") return { ok: false, error: "Only a leverage application can be withdrawn here." }
    // Ownership: the applicant or anyone in their account environment (a Master
    // acting for a Sub, etc.).
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (existing.userId !== session.id && !memberIds.includes(existing.userId)) {
      return { ok: false, error: "You are not authorized to withdraw this application." }
    }
    // Only a line that has NOT been decided can be withdrawn — once an admin has
    // approved/rejected it the charges have settled and the normal
    // switch-off/unwind flow applies instead.
    if (existing.status !== "pending" && existing.status !== "awaiting_master") {
      return { ok: false, error: "This application can no longer be withdrawn — it has already been reviewed." }
    }
    // Release the reserved holds (nothing was ever charged).
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    await deleteLedgerEntry(ownerId, `LEV-AUDIT-${id}`).catch(() => {})
    await deleteLedgerEntry(ownerId, `LEV-PPI-${id}`).catch(() => {})
    await deleteLedgerEntry(ownerId, `LEV-AUDIT-APPEAL-${id}`).catch(() => {})
    await deleteLedgerEntry(ownerId, `LEV-PPI-APPEAL-${id}`).catch(() => {})
    // Cancel the request itself.
    const cancelled = await cancelApproval(id, existing.userId)
    if (!cancelled) {
      // Fallback for records not owned exactly by session.id.
      await deleteApprovalForUser(id, existing.userId).catch(() => {})
    }
    try {
      await insertNotification({
        userId: ownerId,
        tone: "info",
        title: "Leverage application withdrawn",
        body: `Your pending leverage application (${id}) was withdrawn before review. All reserved charges have been released and your balance restored in full — nothing was charged.`,
        href: "/dashboard/leverage",
      })
    } catch {
      // notification is non-critical
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] withdrawMyLeverageApplication failed:", (err as Error).message)
    return { ok: false, error: "The application could not be withdrawn. Please try again." }
  }
}

/**
 * Persist a client-owned change to the view-model stored under `payload.record`
 * of one of the signed-in user's OWN approvals. Used for post-approval state
 * that the client manages locally but that must follow them across devices —
 * e.g. a card's spending limit, block/unblock, or usage controls. Ownership is
 * enforced against the session, and only `payload.record` is merged so the
 * lifecycle / decision fields and admin-set values are never overwritten here.
 */
export async function updateMyApprovalRecord(
  approvalId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This record could not be found." }
    }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be edited." }
    }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    // A suspended (paused) or frozen (locked) commodity deal cannot take
    // workflow changes — stage advances, document uploads/versions — until it is
    // resumed/unfrozen via setMyCommodityDealHold. Enforced server-side so the
    // pause is authoritative, not just a disabled button.
    if (existing.kind === "commodity") {
      const holdState = (prevRecord.hold as { state?: string } | undefined)?.state
      if (holdState === "suspended") {
        return { ok: false, error: "This deal is suspended. Resume it before making changes." }
      }
      if (holdState === "frozen") {
        return { ok: false, error: "This deal is frozen. Unfreeze it before making changes." }
      }
    }
    const nextPayload = { ...prevPayload, record: { ...prevRecord, ...patch } }
    const updated = await updateApprovalPayload(approvalId, nextPayload)
    if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] updateMyApprovalRecord failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Administrator-scoped merge into the view-model stored under `payload.record`
 * of ANY user's approval. Used for admin-driven changes to a client's record
 * that must follow the client across devices — e.g. commodity document
 * verification/rejection and stage advances, or leverage ratio modifications and
 * switch-off settlement. Passcode-guarded; only `payload.record` is merged so
 * the DB lifecycle and decision fields are never overwritten here.
 */
export async function adminUpdateApprovalRecord(
  passcode: string,
  approvalId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This record could not be found." }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    const nextPayload = { ...prevPayload, record: { ...prevRecord, ...patch } }
    const updated = await updateApprovalPayload(approvalId, nextPayload)
    if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminUpdateApprovalRecord failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Revoke one of the signed-in client's APPROVED commodity deals before it has
 * been delivered, and REFUND the reserved funds. The DB guard refuses to revoke
 * a delivered deal, so once the administrator flags delivery the deal is locked.
 *
 * Refund semantics: only the reservation hold (`APPR-<id>`) is released, which
 * unfreezes the blocked money back into the client's available balance. Any FX
 * conversion executed to fund the deal (the settled `-fx-sell` / `-fx-buy`
 * legs) is intentionally LEFT IN PLACE — per policy the bought currency stays
 * available in that currency's account rather than being converted back.
 */
export async function revokeMyCommodityDeal(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be revoked here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be revoked." }
    }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be revoked." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be revoked." }
    }
    if (
      ((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen"
    ) {
      return { ok: false, error: "This deal is frozen. Unfreeze it before revoking to release the funds." }
    }

    const revoked = await revokeApprovedApproval(approvalId, session.id)
    if (!revoked) {
      return { ok: false, error: "This deal can no longer be revoked." }
    }

    // Release the reservation hold → unfreeze the blocked funds. The hold posts
    // to the shared-data owner (Master for a sub-account), mirroring how the
    // hold was created in applyLedgerEffect.
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${approvalId}`)
    } catch (err) {
      console.log("[v0] hold release failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal revoked",
        body: `Your commodity deal "${existing.title}" was revoked. The reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] revoke notification failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Client revoked commodity deal "${existing.title}" and released reserved funds`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Revoked",
        },
      })
    } catch (err) {
      console.log("[v0] revoke activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] revokeMyCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be revoked. Please try again." }
  }
}

/**
 * CLIENT requests early resignation from an ONGOING (approved) Yield / PPP
 * program. This moves NO money and terminates nothing on its own — it stamps a
 * termination request (with the client's PROPOSED exit cost + reason) onto the
 * program and routes it to the administrator, who negotiates the final exit cost
 * and confirms via `adminConfirmYieldTermination`. A customer can therefore never
 * settle a large exit on themselves; the program keeps running (ROI keeps
 * accruing) until the administrator confirms.
 */
export async function requestYieldTermination(
  approvalId: string,
  input: { proposedCost?: number; reason?: string },
): Promise<{ ok: boolean; error?: string; proposedCost?: number; currency?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This program could not be found." }
    }
    if (existing.kind !== "ppp") return { ok: false, error: "Only a yield / PPP program can be resigned here." }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an ongoing (approved) program can be resigned." }
    }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    if (prevRecord.terminationRequestedAt && !prevRecord.cancelledAt) {
      return { ok: false, error: "An early-termination request is already pending administrator review." }
    }
    const amount = Number(prevRecord.amount ?? existing.amount) || 0
    const currency = String(prevRecord.currency || existing.currency || "USD")
    // Default proposed exit cost = the standard early-cancellation cost (2% of
    // principal); the client may propose a different figure to negotiate.
    const suggested = yieldCancellationPenalty(amount)
    let proposed = Number(input.proposedCost)
    if (!Number.isFinite(proposed) || proposed < 0) proposed = suggested
    proposed = Math.round((proposed + Number.EPSILON) * 100) / 100

    await updateApprovalPayload(approvalId, {
      ...prevPayload,
      record: {
        ...prevRecord,
        terminationRequestedAt: new Date().toISOString(),
        terminationReason: input.reason?.trim() || undefined,
        proposedExitCost: proposed,
      },
    })

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Client requested early termination of yield / PPP program "${existing.title}"`,
        category: "Yield / PPP",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: `Proposed exit cost ${currency} ${proposed.toLocaleString("en-US")}. ${input.reason?.trim() ? `Reason: ${input.reason.trim()}` : "No reason given."}`,
          amount: `${currency} ${amount.toLocaleString("en-US")}`,
          decision: "Termination requested",
        },
      })
    } catch (err) {
      console.log("[v0] yield termination request log failed:", (err as Error).message)
    }

    return { ok: true, proposedCost: proposed, currency }
  } catch (err) {
    console.log("[v0] requestYieldTermination failed:", (err as Error).message)
    return { ok: false, error: "The termination request could not be submitted. Please try again." }
  }
}

/** CLIENT withdraws a still-pending early-termination request (clears markers). */
export async function withdrawYieldTermination(approvalId: string): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This program could not be found." }
    if (existing.kind !== "ppp") return { ok: false, error: "Only a yield / PPP program applies here." }
    const prevPayload = existing.payload ?? {}
    const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
    if (!prevRecord.terminationRequestedAt || prevRecord.cancelledAt) {
      return { ok: false, error: "There is no pending termination request to withdraw." }
    }
    const { terminationRequestedAt: _t, terminationReason: _r, proposedExitCost: _p, ...restRecord } = prevRecord
    void _t
    void _r
    void _p
    await updateApprovalPayload(approvalId, { ...prevPayload, record: restRecord })
    return { ok: true }
  } catch (err) {
    console.log("[v0] withdrawYieldTermination failed:", (err as Error).message)
    return { ok: false, error: "The request could not be withdrawn. Please try again." }
  }
}

/**
 * ADMINISTRATOR confirms an early-termination request at the FINAL agreed exit
 * cost (damages). This performs the actual settlement, replacing the old instant
 * self-service cancel:
 *  1. Credits all ROI matured up to now (client keeps everything earned) and
 *     ensures the invested-principal debit is present (cash-funded programs).
 *  2. Flips the program to `cancelled` (stops future ROI, frees the instrument).
 *  3. For a CASH-funded program, RETURNS the invested principal to the Master
 *     Account; an instrument-funded program simply releases the pledged instrument.
 *  4. Charges the agreed EXIT COST, gated by a same-currency solvency check (a
 *     cash-funded return always covers it).
 *
 * `finalCost` is the negotiated figure the admin agrees with the client (defaults
 * to the client's proposal but the admin can set any amount >= 0).
 */
export async function adminConfirmYieldTermination(
  passcode: string,
  approvalId: string,
  input: { finalCost: number; note?: string },
): Promise<{ ok: boolean; error?: string; exitCost?: number; currency?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This program could not be found." }
    if (existing.kind !== "ppp") return { ok: false, error: "Only a yield / PPP program can be terminated here." }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an ongoing (approved) program can be terminated." }
    }

    const record =
      (existing.payload as { record?: { amount?: number; currency?: string; fundingInstrumentId?: string } } | undefined)
        ?.record ?? {}
    const amount = Number(record.amount ?? existing.amount) || 0
    const currency = record.currency || existing.currency || "USD"
    // Only a CASH-funded program moved money in, so only it returns principal.
    const cashFunded = pppIsCashFunded(record)
    let exitCost = Number(input.finalCost)
    if (!Number.isFinite(exitCost) || exitCost < 0) return { ok: false, error: "Enter a valid exit cost." }
    exitCost = Math.round((exitCost + Number.EPSILON) * 100) / 100

    const ownerId = await resolveDataOwnerIdFor(existing.userId)

    // 1) Credit ROI matured up to now (nothing earned is lost) and ensure the
    //    invested-principal debit is present so the return nets cleanly.
    try {
      const roiPosts = buildPppRoiPosts(existing)
      const capitalDebit = buildPppCapitalPosts(existing).find((p) => p.id === pppCapitalId(approvalId))
      const existingRows = await readLedgerEntries(ownerId)
      const have = new Set(existingRows.map((e) => e.id))
      for (const post of roiPosts) {
        if (!have.has(post.id)) await upsertLedgerEntry(ownerId, post)
      }
      if (capitalDebit && !have.has(capitalDebit.id)) await upsertLedgerEntry(ownerId, capitalDebit)
    } catch (err) {
      console.log("[v0] yield termination ROI/capital catch-up failed:", (err as Error).message)
    }

    // 2) Solvency gate for the exit cost. A CASH-funded return covers it; an
    //    instrument-funded termination returns no cash, so it is assessed against
    //    the actual balance only.
    if (exitCost > 0) {
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const availableInCcy =
        Object.entries(available).reduce((sum, [cur, amt]) => sum + convertCurrency(amt, cur, currency), 0) +
        (cashFunded ? amount : 0)
      if (exitCost > availableInCcy + 0.01) {
        return {
          ok: false,
          error: `The agreed exit cost of ${currency} ${exitCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} exceeds the client's available balance. Agree a lower figure or ask the client to fund the account.`,
        }
      }
    }

    // 3) Flip to cancelled (race-safe, ownership-scoped). Stops future ROI and
    //    frees the funding instrument.
    const cancelled = await revokeApprovedApproval(
      approvalId,
      existing.userId,
      "Yield / PPP program terminated early — confirmed by the administrator.",
    )
    if (!cancelled) return { ok: false, error: "This program can no longer be terminated." }

    // 3a) For a CASH-funded program, return the invested PRINCIPAL to the Master
    //     Account (deterministic id → idempotent; reuses `pppCapitalReturnId`).
    if (cashFunded) {
      try {
        await upsertLedgerEntry(ownerId, {
          id: pppCapitalReturnId(approvalId),
          direction: "credit",
          amount,
          currency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: existing.title || "Yield / PPP program",
          reference: approvalId,
          category: "NAFTAhub Yield — Capital Returned",
          comment: `Principal returned on early termination of "${existing.title}".`,
        })
      } catch (err) {
        console.log("[v0] yield termination principal return failed:", (err as Error).message)
      }
    }

    // 4) Charge the agreed exit cost (deterministic id → idempotent).
    if (exitCost > 0) {
      try {
        await upsertLedgerEntry(ownerId, {
          id: `PPP-CANCEL-PENALTY-${approvalId}`,
          direction: "debit",
          amount: exitCost,
          currency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: existing.title || "Yield / PPP program",
          reference: approvalId,
          category: "NAFTAhub Yield — Early Termination Cost",
          comment: `Agreed early-termination cost on "${existing.title}".`,
        })
      } catch (err) {
        console.log("[v0] yield termination cost debit failed:", (err as Error).message)
      }
    }

    // Stamp the settlement + clear the termination-request markers (best-effort).
    try {
      const prevPayload = cancelled.payload ?? {}
      const prevRecord = (prevPayload.record as Record<string, unknown> | undefined) ?? {}
      const { terminationRequestedAt: _t, ...restRecord } = prevRecord
      void _t
      await updateApprovalPayload(approvalId, {
        ...prevPayload,
        record: {
          ...restRecord,
          cancelledAt: new Date().toISOString(),
          penaltyAmount: exitCost,
          exitCostFinal: exitCost,
        },
      })
    } catch (err) {
      console.log("[v0] yield termination record stamp failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Yield program terminated",
        body: `Your early resignation from "${existing.title}" was confirmed by the administrator. ${cashFunded ? `The invested principal of ${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was returned to your Master Account. ` : "The pledged funding instrument has been released. "}${exitCost > 0 ? `An agreed early-termination cost of ${currency} ${exitCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was charged. ` : ""}ROI already earned was kept; future ROI has stopped.`,
        href: KIND_HREF.ppp ?? "/dashboard/ppp",
      })
    } catch (err) {
      console.log("[v0] yield termination notification failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator confirmed early termination of yield / PPP program "${existing.title}"`,
        category: "Yield / PPP",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: `Terminated early. Exit cost ${currency} ${exitCost.toLocaleString("en-US")} charged; earned ROI kept; funding released.${input.note?.trim() ? ` Note: ${input.note.trim()}` : ""}`,
          amount: `${currency} ${amount.toLocaleString("en-US")}`,
          decision: "Terminated",
        },
      })
    } catch (err) {
      console.log("[v0] yield termination activity log failed:", (err as Error).message)
    }

    return { ok: true, exitCost, currency }
  } catch (err) {
    console.log("[v0] adminConfirmYieldTermination failed:", (err as Error).message)
    return { ok: false, error: "The program could not be terminated. Please try again." }
  }
}

/**
 * Request a RECALL of one of the signed-in client's already-approved (sent)
 * payments. A recall is a SWIFT-style return request: it must clear the same
 * administrator gate as a payment before any money moves. On approval the
 * reversal (a) refunds the sender the full debited amount and (b) reverses any
 * gateway/recipient credit the payment produced — see `adminDecideApproval`.
 *
 * Security: takes ONLY the original approval id, re-loads it server-side, and
 * verifies the caller owns it. Every monetary value is derived from the stored,
 * already-approved record — never from client input.
 */
export async function requestPaymentRecall(
  originalApprovalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const original = await getApprovalById(originalApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This payment could not be found." }
    }
    if (original.kind !== "payment") {
      return { ok: false, error: "Only outgoing payments can be recalled." }
    }
    if (original.status !== "approved") {
      return { ok: false, error: "Only an approved (sent) payment can be recalled." }
    }

    const payload = (original.payload ?? {}) as {
      iban?: string
      recalled?: boolean
      recallStatus?: string
      record?: Record<string, unknown>
    }
    if (payload.recalled === true || payload.recallStatus === "pending" || payload.recallStatus === "recalled") {
      return { ok: false, error: "A recall for this payment has already been requested." }
    }

    const record = (payload.record ?? {}) as {
      beneficiary?: string
      iban?: string
      reference?: string
      total?: number
      uetr?: string
    }
    // The sender was debited the TOTAL (amount + 2% platform fee); a full recall
    // makes them whole by refunding exactly that.
    const refundAmount = Number(original.amount ?? record.total ?? 0)
    const refundCurrency = original.currency ?? "EUR"
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return { ok: false, error: "This payment's amount could not be determined." }
    }

    const beneficiary = record.beneficiary ?? original.title
    const reference = record.reference || record.uetr || originalApprovalId

    const recall = await insertApproval({
      userId: session.id,
      kind: "payment_recall",
      title: `Recall — Payment to ${beneficiary}`,
      summary: `Request to recall ${refundCurrency} ${refundAmount.toLocaleString("en-US")} sent to ${beneficiary}${reference ? ` · ${reference}` : ""}`,
      amount: refundAmount,
      currency: refundCurrency,
      payload: {
        originalApprovalId,
        originalLocalId: (record as { id?: string }).id ?? null,
        beneficiary,
        iban: payload.iban ?? record.iban ?? null,
        reference,
      },
      // On approval this credit refunds the sender's data-owner ledger.
      ledgerEffect: {
        direction: "credit",
        amount: refundAmount,
        currency: refundCurrency,
        status: "completed",
        counterparty: beneficiary,
        reference,
        category: "Payment Recall — Refund",
      },
    })

    // Stamp the original so the matcher stops re-funding it and the client list
    // can surface a "recall requested" state (recordFromApproval spreads
    // payload.record into the view model).
    try {
      const newPayload = {
        ...payload,
        recallStatus: "pending",
        recallApprovalId: recall.id,
        record: { ...(payload.record ?? {}), recallStatus: "pending" },
      }
      await updateApprovalPayload(originalApprovalId, newPayload)
    } catch (err) {
      console.log("[v0] recall stamp failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Requested recall of payment ${originalApprovalId} (${refundCurrency} ${refundAmount.toLocaleString("en-US")} to ${beneficiary})`,
        category: "Payments",
        user: profile.fullName,
        details: {
          summary: `Client requested a recall of approved payment ${originalApprovalId} to ${beneficiary} for ${refundCurrency} ${refundAmount.toLocaleString("en-US")}. The recall is pending Administrator approval; on approval the funds are refunded to the sender and any recipient credit is reversed. Reference: ${reference}.`,
          referenceId: recall.id,
          originalPaymentId: originalApprovalId,
          amount: `${refundCurrency} ${refundAmount.toLocaleString("en-US")}`,
          decision: "Recall requested",
        },
      })
    } catch (err) {
      console.log("[v0] recall activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] requestPaymentRecall failed:", (err as Error).message)
    return { ok: false, error: "The recall could not be submitted. Please try again." }
  }
}

// --- Commodity deal negotiation / amendment --------------------------------

/** The negotiable subset of a deal's terms, proposed by the client. */
export interface ProposedDealTerms {
  /**
   * The total deal value the client computed (unit price × quantity). This is
   * advisory only — when `unitPrice` is supplied the server recomputes the
   * authoritative total itself so a stale/buggy client can never persist a raw
   * per-unit price as the deal's total value.
   */
  approxValue: number
  quantity: string
  tradeStructure: string
  /** The renegotiated PER-UNIT price (per MT/BBL) — the figure traders edit. */
  unitPrice?: number
}

/**
 * Request an AMENDMENT to one of the signed-in client's approved commodity
 * deals. Renegotiating price/quantity/incoterms changes the reserved hold, so
 * the change must clear the same administrator gate as the original deal: this
 * files a `commodity_amendment` approval and stamps the original deal with a
 * `pendingAmendment` (the diff). The deal's terms are NOT changed until the
 * admin approves the amendment (see adminDecideApproval).
 *
 * Security: takes only the deal's approval id, reloads it server-side, and
 * verifies ownership; the "previous" terms are read from the stored record, not
 * from the client.
 */
export async function requestDealAmendment(
  dealApprovalId: string,
  proposed: ProposedDealTerms,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const original = await getApprovalById(dealApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (original.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be amended." }
    }
    if ((original.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be amended." }
    }
    if (original.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be amended." }
    }

    const payload = (original.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
    if (payload.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be amended." }
    }
    const record = (payload.record ?? {}) as Record<string, unknown>
    if ((record.pendingAmendment as { status?: string } | undefined)?.status === "pending") {
      return { ok: false, error: "An amendment is already pending approval for this deal." }
    }
    const holdState = (record.hold as { state?: string } | undefined)?.state
    if (holdState === "suspended") {
      return { ok: false, error: "This deal is suspended. Resume it before proposing an amendment." }
    }
    if (holdState === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before proposing an amendment." }
    }

    // The total deal value is ALWAYS unit price × quantity. When the client
    // supplies the renegotiated per-unit price (the figure traders actually
    // edit), the server recomputes the authoritative total from it and the
    // proposed quantity — never trusting the client's `approxValue`, which a
    // stale/buggy bundle could send as the raw per-unit price (the historical
    // "USD 138M → USD 685" corruption). When no unit price is given (legacy
    // clients) we fall back to the client total.
    const proposedUnitPrice = Number(proposed.unitPrice)
    const proposedQty = parseQuantityString(proposed.quantity)
    let newValue: number
    let unitPrice: number | null = null
    if (Number.isFinite(proposedUnitPrice) && proposedUnitPrice > 0 && proposedQty) {
      unitPrice = Math.round(proposedUnitPrice * 100) / 100
      newValue = Math.round(proposedUnitPrice * proposedQty.amount * 100) / 100
    } else {
      newValue = Math.round(Number(proposed.approxValue) * 100) / 100
    }
    if (!Number.isFinite(newValue) || newValue <= 0) {
      return { ok: false, error: "Enter a valid amended value." }
    }
    if (!reason?.trim()) {
      return { ok: false, error: "A reason for the amendment is required." }
    }

    const currency = original.currency ?? (record.currency as string) ?? "USD"
    const prevValue = Number(original.amount ?? (record.approxValue as number) ?? 0)
    const prevQty = parseQuantityString((record.quantity as string) ?? "")
    const previous = {
      approxValue: prevValue,
      quantity: (record.quantity as string) ?? "",
      tradeStructure: (record.tradeStructure as string) ?? "FOB",
      unitPrice:
        prevQty && prevValue > 0 ? Math.round((prevValue / prevQty.amount) * 100) / 100 : undefined,
    }
    const amendmentId = `AMD-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
    const commodity = (record.commodity as string) ?? original.title

    // File the amendment approval. It carries NO ledger effect of its own — the
    // reserved hold is adjusted in place on the ORIGINAL deal at approval time.
    const amendment = await insertApproval({
      userId: session.id,
      kind: "commodity_amendment",
      title: `Amendment — ${commodity}`,
      summary: `Amend ${commodity}: ${previous.quantity} → ${proposed.quantity}, ${currency} ${previous.approxValue.toLocaleString("en-US")} → ${currency} ${newValue.toLocaleString("en-US")} (${previous.tradeStructure} → ${proposed.tradeStructure})`,
      amount: newValue,
      currency,
      payload: {
        dealApprovalId,
        dealLocalId: (record.id as string) ?? null,
        commodity,
        reason: reason.trim(),
        previous,
        proposed: {
          approxValue: newValue,
          quantity: proposed.quantity,
          tradeStructure: proposed.tradeStructure,
          unitPrice: unitPrice ?? undefined,
        },
      },
      ledgerEffect: null,
    })

    // Stamp the deal record with the pending amendment so the client/admin see
    // the diff immediately (the deal view-model lives under payload.record).
    const pendingAmendment = {
      id: amendmentId,
      approvalId: amendment.id,
      status: "pending" as const,
      reason: reason.trim(),
      previous,
      proposed: {
        approxValue: newValue,
        quantity: proposed.quantity,
        tradeStructure: proposed.tradeStructure,
        unitPrice: unitPrice ?? undefined,
      },
      requestedAt: new Date().toISOString(),
    }
    try {
      await updateApprovalPayload(dealApprovalId, {
        ...payload,
        record: { ...record, pendingAmendment },
      })
    } catch (err) {
      console.log("[v0] amendment stamp failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Requested amendment of deal ${dealApprovalId} (${commodity})`,
        category: "Commodity Desk",
        user: profile.fullName,
        details: {
          referenceId: amendment.id,
          dealId: dealApprovalId,
          summary: `Client requested to renegotiate deal ${commodity}: value ${currency} ${previous.approxValue.toLocaleString("en-US")} → ${currency} ${newValue.toLocaleString("en-US")}, quantity ${previous.quantity} → ${proposed.quantity}, terms ${previous.tradeStructure} → ${proposed.tradeStructure}. Pending Administrator approval before the reserved funds adjust. Reason: ${reason.trim()}.`,
          decision: "Amendment requested",
        },
      })
    } catch (err) {
      console.log("[v0] amendment activity log failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] requestDealAmendment failed:", (err as Error).message)
    return { ok: false, error: "The amendment could not be submitted. Please try again." }
  }
}

/**
 * Append a note to a deal's negotiation log (and optionally update the recorded
 * counterparty position). Authored server-side from the authoritative session,
 * so attribution cannot be spoofed by the client.
 */
export async function addDealNegotiationNote(
  dealApprovalId: string,
  message: string,
  counterpartyPosition?: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (!message?.trim() && !counterpartyPosition?.trim()) {
    return { ok: false, error: "Enter a note or a counterparty position." }
  }
  try {
    const original = await getApprovalById(dealApprovalId)
    if (!original || original.userId !== session.id) {
      return { ok: false, error: "This deal could not be found." }
    }
    if (original.kind !== "commodity") {
      return { ok: false, error: "Notes can only be added to commodity deals." }
    }
    if ((original.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be annotated." }
    }

    const payload = (original.payload ?? {}) as { record?: Record<string, unknown> }
    const record = (payload.record ?? {}) as Record<string, unknown>
    const profile = await resolveAccountProfileById(session.id)
    const existingNotes = Array.isArray(record.negotiationNotes)
      ? (record.negotiationNotes as Record<string, unknown>[])
      : []

    const nextNotes = message?.trim()
      ? [
          ...existingNotes,
          {
            id: `NOTE-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
            author: profile.fullName,
            authorRole: "client" as const,
            message: message.trim(),
            createdAt: new Date().toISOString(),
          },
        ]
      : existingNotes

    await updateApprovalPayload(dealApprovalId, {
      ...payload,
      record: {
        ...record,
        negotiationNotes: nextNotes,
        ...(counterpartyPosition?.trim() ? { counterpartyPosition: counterpartyPosition.trim() } : {}),
      },
    })

    return { ok: true }
  } catch (err) {
    console.log("[v0] addDealNegotiationNote failed:", (err as Error).message)
    return { ok: false, error: "The note could not be saved. Please try again." }
  }
}

// --- Deal management tools (delete / hold / edit) ---------------------------

/** A reversible pause/lock placed on a commodity deal by the client or admin. */
export type DealHoldState = "suspended" | "frozen"

/** The subset of a commodity deal's terms editable via the direct edit tool. */
export interface EditableDealTerms {
  title?: string
  commodity?: string
  quantity?: string
  unitPrice?: number
  approxValue?: number
  tradeStructure?: string
  originCountry?: string
  destinationCountry?: string
  buyerName?: string
  sellerName?: string
  sendingBank?: string
  sendingBankBic?: string
  receivingBank?: string
  receivingBankBic?: string
  instrumentType?: string
  notes?: string
}

/**
 * Recompute the authoritative total deal value from a terms patch. The total is
 * ALWAYS unit price × quantity when a unit price is supplied (the figure traders
 * edit), so a stale client can never persist a raw per-unit price as the total.
 * Falls back to the supplied `approxValue`, then the existing value.
 */
function resolveEditedValue(
  patch: EditableDealTerms,
  existingValue: number,
): { value: number; unitPrice: number | null } {
  const unitPrice = Number(patch.unitPrice)
  const qty = parseQuantityString(patch.quantity ?? "")
  if (Number.isFinite(unitPrice) && unitPrice > 0 && qty) {
    return {
      value: Math.round(unitPrice * qty.amount * 100) / 100,
      unitPrice: Math.round(unitPrice * 100) / 100,
    }
  }
  const approx = Number(patch.approxValue)
  if (Number.isFinite(approx) && approx > 0) return { value: Math.round(approx * 100) / 100, unitPrice: null }
  return { value: existingValue, unitPrice: null }
}

/** Build the sanitized record patch (only defined string/number fields). */
function buildTermsRecordPatch(patch: EditableDealTerms, value: number): Record<string, unknown> {
  const out: Record<string, unknown> = { approxValue: value }
  const strFields: (keyof EditableDealTerms)[] = [
    "title",
    "commodity",
    "quantity",
    "tradeStructure",
    "originCountry",
    "destinationCountry",
    "buyerName",
    "sellerName",
    "sendingBank",
    "sendingBankBic",
    "receivingBank",
    "receivingBankBic",
    "instrumentType",
    "notes",
  ]
  for (const f of strFields) {
    const v = patch[f]
    if (typeof v === "string") out[f] = v.trim()
  }
  return out
}

/**
 * Core applier for a direct terms edit. Recomputes the authoritative value,
 * updates the stored record + the approval's amount/currency, and keeps the
 * on-approval reservation effect in sync so a pending deal reserves the amended
 * value when it is later approved. Only ever applied to non-approved,
 * non-delivered, non-frozen deals (approved deals must go through amendment).
 */
async function applyDealTermsEdit(
  existing: ApprovalRequest,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  const payload = (existing.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
  if (payload.delivered === true) {
    return { ok: false, error: "This deal has been delivered and can no longer be edited." }
  }
  const record = (payload.record ?? {}) as Record<string, unknown>
  if ((record.hold as { state?: string } | undefined)?.state === "frozen") {
    return { ok: false, error: "This deal is frozen. Unfreeze it before editing its terms." }
  }
  if (existing.status === "approved") {
    return {
      ok: false,
      error: "Approved deals hold reserved funds — change them via an amendment for administrator sign-off.",
    }
  }
  if (existing.status !== "pending" && existing.status !== "rejected" && existing.status !== "cancelled") {
    return { ok: false, error: "This deal can no longer be edited." }
  }

  const existingValue = Number(existing.amount ?? (record.approxValue as number) ?? 0)
  const { value } = resolveEditedValue(patch, existingValue)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Enter a valid deal value." }
  }
  const currency = existing.currency ?? (record.currency as string) ?? "USD"
  const recordPatch = buildTermsRecordPatch(patch, value)
  const nextRecord = { ...record, ...recordPatch }

  // Keep the on-approval reservation hold in step with the amended value so the
  // correct amount is blocked when a pending deal is approved.
  const prevEffect = existing.ledgerEffect
  const nextEffect: LedgerEffect | null =
    prevEffect != null
      ? {
          ...prevEffect,
          amount: value,
          currency,
          counterparty: (recordPatch.sellerName as string) || prevEffect.counterparty,
        }
      : value > 0
        ? {
            direction: "debit",
            amount: value,
            currency,
            status: "hold",
            counterparty: (nextRecord.sellerName as string) || "Commodity supplier",
            reference: (nextRecord.uetr as string) || (nextRecord.id as string) || existing.id,
            category: "Commodity Trade — Reserved Funds",
          }
        : null

  const updated = await updateApprovalTerms(existing.id, {
    amount: value,
    currency,
    ledgerEffect: nextEffect,
    payload: { ...payload, record: nextRecord },
  })
  if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
  return { ok: true }
}

/**
 * Apply / lift a suspend or freeze hold on a commodity deal, stamped onto the
 * stored record so it is authoritative and visible cross-client. `hold=null`
 * clears the hold. `by` records who placed it for the audit trail.
 */
async function applyDealHold(
  existing: ApprovalRequest,
  hold: DealHoldState | null,
  by: "client" | "admin",
  byName: string,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const payload = (existing.payload ?? {}) as { delivered?: boolean; record?: Record<string, unknown> }
  if (payload.delivered === true) {
    return { ok: false, error: "This deal has been delivered and is finalized — it cannot be held." }
  }
  const record = (payload.record ?? {}) as Record<string, unknown>
  const nextRecord = {
    ...record,
    hold: hold
      ? { state: hold, by, byName, note: note?.trim() || undefined, at: new Date().toISOString() }
      : null,
  }
  const updated = await updateApprovalPayload(existing.id, { ...payload, record: nextRecord })
  if (!updated) return { ok: false, error: "The change could not be saved. Please try again." }
  return { ok: true }
}

/**
 * Release any reserved-funds hold for a deal, back to the owner's available
 * balance. Safe no-op when there is no hold (e.g. a pending / rejected deal).
 */
async function releaseDealHoldFunds(existing: ApprovalRequest): Promise<void> {
  try {
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    await deleteLedgerEntry(ownerId, `APPR-${existing.id}`)
  } catch (err) {
    console.log("[v0] deal fund release failed:", (err as Error).message)
  }
}

/** Client: suspend / freeze / resume one of their OWN commodity deals. */
export async function setMyCommodityDealHold(
  approvalId: string,
  hold: DealHoldState | null,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals support this action." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only." }
    }
    const profile = await resolveAccountProfileById(session.id)
    const res = await applyDealHold(existing, hold, "client", profile.fullName, note)
    if (res.ok) {
      void logActivity({
        action: hold
          ? `Client ${hold === "frozen" ? "froze" : "suspended"} commodity deal ${approvalId}`
          : `Client resumed commodity deal ${approvalId}`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.title, decision: hold ?? "Resumed" },
      }).catch(() => {})
    }
    return res
  } catch (err) {
    console.log("[v0] setMyCommodityDealHold failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Admin: suspend / freeze / resume ANY client's commodity deal (passcode-gated). */
export async function adminSetCommodityDealHold(
  passcode: string,
  approvalId: string,
  hold: DealHoldState | null,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals support this action." }
    return await applyDealHold(existing, hold, "admin", "Administrator", note)
  } catch (err) {
    console.log("[v0] adminSetCommodityDealHold failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Client: edit the terms of one of their OWN non-approved commodity deals. */
export async function editMyCommodityDealTerms(
  approvalId: string,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be edited here." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be edited." }
    }
    const res = await applyDealTermsEdit(existing, patch)
    if (res.ok) {
      const profile = await resolveAccountProfileById(session.id)
      void logActivity({
        action: `Client edited commodity deal ${approvalId} terms`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.title, decision: "Edited" },
      }).catch(() => {})
    }
    return res
  } catch (err) {
    console.log("[v0] editMyCommodityDealTerms failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/** Admin: edit the terms of ANY client's non-approved commodity deal (passcode-gated). */
export async function adminEditCommodityDealTerms(
  passcode: string,
  approvalId: string,
  patch: EditableDealTerms,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be edited here." }
    return await applyDealTermsEdit(existing, patch)
  } catch (err) {
    console.log("[v0] adminEditCommodityDealTerms failed:", (err as Error).message)
    return { ok: false, error: "The change could not be saved. Please try again." }
  }
}

/**
 * Client: permanently DELETE one of their OWN commodity deals, releasing any
 * reserved funds back to the available balance first. A frozen deal must be
 * unfrozen before it can be deleted.
 */
export async function deleteMyCommodityDeal(
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be deleted here." }
    if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
      return { ok: false, error: "This deal was shared with you for reference only and cannot be deleted." }
    }
    if (((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before deleting." }
    }
    await releaseDealHoldFunds(existing)
    const deleted = await deleteApprovalForUser(approvalId, session.id)
    if (!deleted) return { ok: false, error: "This deal could not be deleted." }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Client deleted commodity deal "${existing.title}" and released any reserved funds`,
        category: "Commodity Trading",
        user: profile.fullName,
        details: { referenceId: existing.id, summary: existing.summary || existing.title, decision: "Deleted" },
      })
    } catch (err) {
      console.log("[v0] delete activity log failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] deleteMyCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be deleted. Please try again." }
  }
}

/**
 * Returns a human-readable reason if the given instrument approval is still
 * ENGAGED as collateral/funding by any LIVE facility owned by the user (or their
 * environment members), else null. This is the authoritative server-side mirror
 * of the client `usageReasons`/`inUseInstrumentIds` gate in the instruments page.
 *
 * The instrument's identity used for pledging is `base.id`, where
 * base = payload.instrument (admin-issued) ?? payload.record (client-acquired) —
 * the exact id the leverage/monetization/PPP/internal-loan records store.
 */
async function instrumentEngagementReason(
  instrumentApproval: Awaited<ReturnType<typeof getApprovalById>>,
  userId: string,
): Promise<string | null> {
  if (!instrumentApproval) return null
  const p = (instrumentApproval.payload ?? {}) as {
    instrument?: { id?: string }
    record?: { id?: string }
    issuedByAdmin?: boolean
  }
  const instrumentId = (p.issuedByAdmin ? p.instrument?.id : p.record?.id ?? p.instrument?.id) ?? p.instrument?.id
  if (!instrumentId) return null

  // Scope the search to the account and any environment members (sub/joint), so
  // a pledge created under a linked member id is still seen.
  let ids = [userId]
  try {
    ids = Array.from(new Set([userId, ...(await resolveEnvironmentMemberIds(userId))]))
  } catch {
    ids = [userId]
  }

  // (approval kind, field on payload.record holding the pledged instrument id, reason)
  const checks: Array<{ kind: ApprovalKind; field: string; reason: string }> = [
    { kind: "internal_loan", field: "collateralInstrumentId", reason: "an internal loan — repay it to release the collateral before deleting this instrument." },
    { kind: "leverage", field: "pledgedInstrumentId", reason: "a leverage line — close it before deleting this instrument." },
    { kind: "monetization", field: "instrumentId", reason: "a monetization — reverse it before deleting this instrument." },
    { kind: "ppp", field: "fundingInstrumentId", reason: "a yield / PPP application — cancel it before deleting this instrument." },
  ]

  for (const { kind, field, reason } of checks) {
    let rows: Awaited<ReturnType<typeof listApprovalsForUsers>> = []
    try {
      rows = await listApprovalsForUsers(ids, kind)
    } catch {
      // Fail CLOSED on a specific-kind read error: better to block a delete than
      // to release a live guarantee we couldn't verify.
      return "This instrument's status could not be verified right now. Please try again shortly."
    }
    for (const row of rows) {
      if (row.status === "rejected") continue
      const rec = ((row.payload ?? {}) as { record?: Record<string, unknown> }).record
      if (!rec) continue
      if (rec[field] !== instrumentId) continue
      if (isLiveRequest(rec)) {
        return `This instrument is pledged to ${reason}`
      }
    }
  }
  return null
}

/**
 * Given a bank-instrument id, is it ALREADY pledged/committed as collateral or
 * funding to a LIVE facility (leverage line, internal loan, monetization, or
 * PPP)? Used to BAN re-pledging the same instrument for a second facility — a
 * "debit on debit" — regardless of product. Scans the account + linked members.
 * Fails CLOSED (returns a blocking reason) on a read error, so an unverifiable
 * pledge can never slip through. Returns a human label of the engaging facility,
 * or null when the instrument is free.
 */
async function instrumentPledgedElsewhere(instrumentId: string, userId: string): Promise<string | null> {
  if (!instrumentId) return null
  let ids = [userId]
  try {
    ids = Array.from(new Set([userId, ...(await resolveEnvironmentMemberIds(userId))]))
  } catch {
    ids = [userId]
  }
  const checks: Array<{ kind: ApprovalKind; field: string; label: string }> = [
    { kind: "leverage", field: "pledgedInstrumentId", label: "another leverage line" },
    { kind: "internal_loan", field: "collateralInstrumentId", label: "an internal loan" },
    { kind: "monetization", field: "instrumentId", label: "a monetization facility" },
    { kind: "ppp", field: "fundingInstrumentId", label: "a yield / PPP program" },
  ]
  for (const { kind, field, label } of checks) {
    let rows: Awaited<ReturnType<typeof listApprovalsForUsers>> = []
    try {
      rows = await listApprovalsForUsers(ids, kind)
    } catch {
      return "its current pledges could not be verified — please try again shortly"
    }
    for (const row of rows) {
      if (row.status === "rejected") continue
      const rec = ((row.payload ?? {}) as { record?: Record<string, unknown> }).record
      if (!rec) continue
      if (rec[field] !== instrumentId) continue
      if (isLiveRequest(rec)) return label
    }
  }
  return null
}

/**
 * Client: permanently DELETE one of their OWN bank instruments from their
 * portfolio. Ownership and kind are enforced here, AND the instrument must not
 * be pledged as collateral/funding to any live facility (internal loan,
 * leverage, monetization, PPP) — enforced authoritatively via
 * `instrumentEngagementReason`, not just the client UI. The acquisition fee is a
 * settled, non-refundable debit and is intentionally NOT refunded on deletion.
 */
export async function deleteMyInstrument(
  approvalId: string,
  options?: { chargeManagementFee?: boolean },
): Promise<{ ok: boolean; error?: string; feeCharged?: number; feeCurrency?: string }> {
  // The 0.035% management / settlement fee is charged when a client "settles out"
  // (DELETES) an instrument. It is NOT charged when the instrument is returned to
  // the marketplace (that path passes chargeManagementFee: false), nor for a
  // still-pending request (which the store cancels via cancelMyApproval instead).
  const chargeManagementFee = options?.chargeManagementFee !== false
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This instrument could not be found." }
    }
    if (existing.kind !== "instrument") {
      return { ok: false, error: "Only bank instruments can be deleted here." }
    }

    // Snapshot the face value + currency BEFORE deletion so the management fee
    // can be computed after the row is gone. Base shape mirrors the rest of the
    // instrument handling: admin-issued → payload.instrument, else payload.record.
    const p = (existing.payload ?? {}) as {
      instrument?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      record?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      issuedByAdmin?: boolean
    }
    const base = (p.issuedByAdmin ? p.instrument : p.record ?? p.instrument) ?? {}
    const faceValue = Number(base.faceValue ?? existing.amount ?? 0)
    const feeCurrency = String(base.currency ?? "EUR")
    const instrLabel = `${String(base.typeFull ?? "Instrument")} ${String(base.id ?? "")}`.trim()

    // AUTHORITATIVE "in use" guard. An instrument pledged as collateral / funding
    // for a LIVE facility (internal loan, leverage line, monetization, PPP) must
    // NOT be deletable — otherwise a client can raise funds against it (e.g. a
    // 25M MT760-backed loan) and then delete the guarantee while the debt stays
    // outstanding. The client UI hides the delete/return control, but that guard
    // is bypassable (impersonation, stale state, a direct action call), so we
    // re-check here on the server. Deleting is only allowed once every facility
    // backed by this instrument is repaid/closed/reversed (i.e. no longer live).
    const engagement = await instrumentEngagementReason(existing, session.id)
    if (engagement) {
      return { ok: false, error: engagement }
    }

    const deleted = await deleteApprovalForUser(approvalId, session.id)
    if (!deleted) return { ok: false, error: "This instrument could not be deleted." }

    // Charge the one-time management / settlement fee (0.035% of face value) to
    // the client's Master Account, in the instrument's own currency. Best-effort
    // and NON-blocking: the deletion already succeeded, so a fee-posting hiccup
    // must never fail the whole operation. The debit posts like other platform
    // charges (the ledger reconciler covers any resulting currency shortfall).
    let feeCharged = 0
    if (chargeManagementFee) {
      const standardFee = instrumentManagementFee(faceValue)
      if (standardFee > 0) {
        try {
          const ownerId = await resolveDataOwnerIdFor(session.id)
          // Admin-set cashback reduces the management/settlement fee.
          const cb = await applyCashbackForOwner(ownerId, "instrument", standardFee)
          const fee = cb.netFee
          await upsertLedgerEntry(ownerId, {
            id: `INSTR-MGMT-FEE-${approvalId}`,
            direction: "debit",
            amount: fee,
            currency: feeCurrency,
            status: "completed",
            date: new Date().toISOString(),
            counterparty: instrLabel || "Bank Instrument",
            reference: approvalId,
            category: `Bank Instrument — Management & Settlement Fee (${INSTRUMENT_MANAGEMENT_FEE_LABEL})`,
            comment: `${INSTRUMENT_MANAGEMENT_FEE_LABEL} management fee on settling out ${feeCurrency} ${faceValue.toLocaleString("en-US")} instrument.${cashbackNote(cb, feeCurrency)}`,
          })
          feeCharged = fee
          try {
            await insertNotification({
              userId: session.id,
              tone: "info",
              title: "Instrument settled out",
              body: `A ${INSTRUMENT_MANAGEMENT_FEE_LABEL} management fee of ${feeCurrency} ${fee.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was charged to your Master Account for removing ${instrLabel || "the instrument"}.`,
              href: "/dashboard/instruments",
            })
          } catch {
            /* notification is best-effort */
          }
        } catch (err) {
          console.log("[v0] instrument management fee charge failed:", (err as Error).message)
        }
      }
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Client removed bank instrument "${existing.title}" from their portfolio`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: existing.summary || existing.title,
          decision: "Deleted",
          ...(feeCharged > 0
            ? { fee: `${feeCurrency} ${feeCharged.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
            : {}),
        },
      })
    } catch (err) {
      console.log("[v0] instrument delete activity log failed:", (err as Error).message)
    }
    return { ok: true, feeCharged, feeCurrency }
  } catch (err) {
    console.log("[v0] deleteMyInstrument failed:", (err as Error).message)
    return { ok: false, error: "The instrument could not be deleted. Please try again." }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Instrument EXIT ("settle out") — admin-negotiated with a cashback %.
//
// Unlike `deleteMyInstrument` (instant, applies only the customer's PRESET
// cashback), a settle-out now REQUESTS an exit: the instrument is NOT removed
// and nothing is charged until the administrator reviews it, applies a cashback
// %, and confirms — then the instrument is removed and the NET fee is charged.
// The request stamps a top-level `payload.exitRequest` marker on the approved
// instrument row (mirrors the yield / Treuhand early-exit pattern).
// ─────────────────────────────────────────────────────────────────────────

interface InstrumentExitMarker {
  requestedAt: string
  reason: string
  standardFee: number
  faceValue: number
  currency: string
  instrLabel: string
}

/** CLIENT: request to settle out (exit) a held bank instrument. */
export async function requestInstrumentExit(
  approvalId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string; standardFee?: number; currency?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id) {
      return { ok: false, error: "This instrument could not be found." }
    }
    if (existing.kind !== "instrument") {
      return { ok: false, error: "Only bank instruments can be exited here." }
    }
    // Cannot exit an instrument pledged to a live facility (loan/leverage/etc.).
    const engagement = await instrumentEngagementReason(existing, session.id)
    if (engagement) return { ok: false, error: engagement }

    const p = (existing.payload ?? {}) as {
      instrument?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      record?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      issuedByAdmin?: boolean
      exitRequest?: unknown
    }
    if (p.exitRequest) {
      return { ok: false, error: "An exit request is already awaiting the administrator." }
    }
    const base = (p.issuedByAdmin ? p.instrument : p.record ?? p.instrument) ?? {}
    const faceValue = Number(base.faceValue ?? existing.amount ?? 0)
    const currency = String(base.currency ?? "EUR")
    const instrLabel = `${String(base.typeFull ?? "Instrument")} ${String(base.id ?? "")}`.trim()
    const standardFee = instrumentManagementFee(faceValue)

    const marker: InstrumentExitMarker = {
      requestedAt: new Date().toISOString(),
      reason: reason?.trim() || "",
      standardFee,
      faceValue,
      currency,
      instrLabel,
    }
    await updateApprovalPayload(approvalId, { ...p, exitRequest: marker })

    // Fan out to administrators so the request is discoverable (best-effort).
    try {
      const holder = await resolveAccountProfileById(session.id)
      const admins = await Promise.all(adminEmails().map((e) => getDynamicUserByEmail(e).catch(() => undefined)))
      const seen = new Set<string>()
      for (const a of admins) {
        if (!a || seen.has(a.id) || a.id === session.id) continue
        seen.add(a.id)
        await insertNotification({
          userId: a.id,
          tone: "warning",
          title: "Instrument exit requested",
          body: `${holder.fullName} requested to settle out ${instrLabel || "an instrument"} (${currency} ${faceValue.toLocaleString("en-US")}). Negotiate the exit cost & confirm.`,
          href: "/dashboard/admin",
        }).catch(() => {})
      }
    } catch {
      /* admin fan-out is best-effort */
    }

    try {
      const profile = await resolveAccountProfileById(session.id)
      await logActivity({
        action: `Client requested to settle out bank instrument ${instrLabel}`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: `Exit requested${reason?.trim() ? ` — ${reason.trim()}` : ""}. Awaiting administrator confirmation of the settlement cost.`,
          decision: "Exit requested",
        },
      })
    } catch {
      /* activity log is best-effort */
    }

    return { ok: true, standardFee, currency }
  } catch (err) {
    console.log("[v0] requestInstrumentExit failed:", (err as Error).message)
    return { ok: false, error: "The exit request could not be submitted. Please try again." }
  }
}

/** CLIENT: withdraw a pending instrument exit request (keeps the instrument). */
export async function withdrawInstrumentExit(approvalId: string): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.userId !== session.id || existing.kind !== "instrument") {
      return { ok: false, error: "This instrument could not be found." }
    }
    const p = (existing.payload ?? {}) as Record<string, unknown>
    if (!p.exitRequest) return { ok: true }
    const { exitRequest: _e, ...rest } = p
    void _e
    await updateApprovalPayload(approvalId, rest)
    return { ok: true }
  } catch (err) {
    console.log("[v0] withdrawInstrumentExit failed:", (err as Error).message)
    return { ok: false, error: "The request could not be withdrawn." }
  }
}

export interface AdminInstrumentExitRow {
  approvalId: string
  userId: string
  holderLabel: string
  holderEmail: string
  instrLabel: string
  faceValue: number
  currency: string
  standardFee: number
  reason: string
  requestedAt: string
}

/** ADMIN: list all pending instrument exit requests awaiting confirmation. */
export async function adminListInstrumentExitRequests(passcode: string): Promise<AdminInstrumentExitRow[]> {
  if (!(await adminOk(passcode))) return []
  try {
    const rows = await listInstrumentExitRequests()
    const out: AdminInstrumentExitRow[] = []
    for (const r of rows) {
      const ex = (r.payload as { exitRequest?: InstrumentExitMarker } | undefined)?.exitRequest
      if (!ex) continue
      let holderLabel = r.userId
      let holderEmail = ""
      try {
        const profile = await resolveAccountProfileById(r.userId)
        holderLabel = profile.fullName || (profile.company ?? r.userId)
        holderEmail = profile.email ?? ""
      } catch {
        /* fall back to the id */
      }
      out.push({
        approvalId: r.id,
        userId: r.userId,
        holderLabel,
        holderEmail,
        instrLabel: ex.instrLabel || String(r.title ?? "Instrument"),
        faceValue: Number(ex.faceValue ?? 0),
        currency: ex.currency || "EUR",
        standardFee: Number(ex.standardFee ?? 0),
        reason: ex.reason || "",
        requestedAt: ex.requestedAt,
      })
    }
    return out
  } catch (err) {
    console.log("[v0] adminListInstrumentExitRequests failed:", (err as Error).message)
    return []
  }
}

/** ADMIN: count of pending instrument exit requests (for the command center). */
export async function adminCountInstrumentExitRequests(passcode: string): Promise<number> {
  try {
    if (!(await adminOk(passcode))) return 0
    return await countInstrumentExitRequests()
  } catch (err) {
    console.log("[v0] adminCountInstrumentExitRequests failed:", (err as Error).message)
    return 0
  }
}

/**
 * ADMIN: confirm an instrument exit, applying an optional cashback % that
 * reduces the standard settlement fee. When `cashbackRate` is omitted/0 the
 * customer's PRESET instrument cashback applies instead. Removes the instrument
 * and charges the NET fee to the Master Account.
 */
export async function adminConfirmInstrumentExit(
  passcode: string,
  approvalId: string,
  input: { cashbackRate?: number; note?: string },
): Promise<{ ok: boolean; error?: string; feeCharged?: number; currency?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This instrument could not be found." }
    if (existing.kind !== "instrument") return { ok: false, error: "Only bank instruments can be exited here." }

    // Re-check engagement (never settle out an instrument still pledged live).
    const engagement = await instrumentEngagementReason(existing, existing.userId)
    if (engagement) return { ok: false, error: engagement }

    const p = (existing.payload ?? {}) as {
      instrument?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      record?: { faceValue?: number; currency?: string; typeFull?: string; id?: string }
      issuedByAdmin?: boolean
    }
    const base = (p.issuedByAdmin ? p.instrument : p.record ?? p.instrument) ?? {}
    const faceValue = Number(base.faceValue ?? existing.amount ?? 0)
    const feeCurrency = String(base.currency ?? "EUR")
    const instrLabel = `${String(base.typeFull ?? "Instrument")} ${String(base.id ?? "")}`.trim()
    const standardFee = instrumentManagementFee(faceValue)

    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    const rate = Number(input.cashbackRate)
    // Admin override wins; otherwise fall back to the customer's preset cashback.
    const cb =
      Number.isFinite(rate) && rate > 0
        ? applyCashback(standardFee, rate)
        : await applyCashbackForOwner(ownerId, "instrument", standardFee)

    const deleted = await deleteApprovalForUser(approvalId, existing.userId)
    if (!deleted) return { ok: false, error: "This instrument could no longer be settled out." }

    let feeCharged = 0
    if (cb.originalFee > 0) {
      try {
        await upsertLedgerEntry(ownerId, {
          id: `INSTR-MGMT-FEE-${approvalId}`,
          direction: "debit",
          amount: cb.netFee,
          currency: feeCurrency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: instrLabel || "Bank Instrument",
          reference: approvalId,
          category: `Bank Instrument — Management & Settlement Fee (${INSTRUMENT_MANAGEMENT_FEE_LABEL})`,
          comment: `${INSTRUMENT_MANAGEMENT_FEE_LABEL} management fee on settling out ${feeCurrency} ${faceValue.toLocaleString("en-US")} instrument.${cashbackNote(cb, feeCurrency)}${input.note?.trim() ? ` Note: ${input.note.trim()}` : ""}`,
        })
        feeCharged = cb.netFee
      } catch (err) {
        console.log("[v0] instrument exit fee charge failed:", (err as Error).message)
      }
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Instrument exit confirmed",
        body: `Your request to settle out ${instrLabel || "the instrument"} was confirmed. A settlement fee of ${feeCurrency} ${cb.netFee.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was charged${cb.cashbackAmount > 0 ? ` (cashback ${formatCashbackPct(cb.cashbackRate)} applied)` : ""}.`,
        href: "/dashboard/instruments",
      })
    } catch {
      /* notification is best-effort */
    }

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator confirmed exit of bank instrument ${instrLabel}`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: existing.id,
          summary: `Settled out. Standard fee ${feeCurrency} ${cb.originalFee.toLocaleString("en-US")}${cb.cashbackAmount > 0 ? `, cashback ${formatCashbackPct(cb.cashbackRate)} (−${feeCurrency} ${cb.cashbackAmount.toLocaleString("en-US")})` : ""} → net ${feeCurrency} ${cb.netFee.toLocaleString("en-US")}.${input.note?.trim() ? ` Note: ${input.note.trim()}` : ""}`,
          decision: "Exit confirmed",
        },
      })
    } catch {
      /* activity log is best-effort */
    }

    return { ok: true, feeCharged, currency: feeCurrency }
  } catch (err) {
    console.log("[v0] adminConfirmInstrumentExit failed:", (err as Error).message)
    return { ok: false, error: "The instrument exit could not be confirmed. Please try again." }
  }
}

/** ADMIN: decline a pending instrument exit request (keeps the instrument). */
export async function adminRejectInstrumentExit(
  passcode: string,
  approvalId: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument") return { ok: false, error: "This instrument could not be found." }
    const p = (existing.payload ?? {}) as Record<string, unknown>
    const { exitRequest: _e, ...rest } = p
    void _e
    await updateApprovalPayload(approvalId, rest)
    try {
      await insertNotification({
        userId: existing.userId,
        tone: "warning",
        title: "Instrument exit declined",
        body: `Your request to settle out an instrument was declined by the administrator.${reason?.trim() ? ` Reason: ${reason.trim()}` : ""}`,
        href: "/dashboard/instruments",
      })
    } catch {
      /* notification is best-effort */
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminRejectInstrumentExit failed:", (err as Error).message)
    return { ok: false, error: "The request could not be declined." }
  }
}

/**
 * Admin: permanently DELETE ANY client's commodity deal (passcode-gated),
 * releasing any reserved funds back to the owner's available balance first. A
 * frozen deal must be unfrozen before deletion.
 */
export async function adminDeleteCommodityDeal(
  passcode: string,
  approvalId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing) return { ok: false, error: "This deal could not be found." }
    if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals can be deleted here." }
    if (((existing.payload?.record as { hold?: { state?: string } } | undefined)?.hold?.state) === "frozen") {
      return { ok: false, error: "This deal is frozen. Unfreeze it before deleting." }
    }
    await releaseDealHoldFunds(existing)
    const deleted = await deleteApproval(approvalId)
    if (!deleted) return { ok: false, error: "This deal could not be deleted." }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal removed",
        body: `Your commodity deal "${existing.title}" was removed by the administrator. Any reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] admin delete notification failed:", (err as Error).message)
    }
    return { ok: true }
  } catch (err) {
    console.log("[v0] adminDeleteCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be deleted. Please try again." }
  }
}

// --- Admin (cross-client) ---------------------------------------------------

export type AdminApprovalsResult =
  | { ok: true; requests: ApprovalRequest[] }
  | { ok: false; error: string }

export async function adminListApprovals(
  passcode: string,
  filters?: { status?: ApprovalStatus; kind?: ApprovalKind; userId?: string },
): Promise<AdminApprovalsResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const requests = await listAllApprovals(filters)
    return { ok: true, requests }
  } catch (err) {
    console.log("[v0] adminListApprovals failed:", (err as Error).message)
    return { ok: false, error: "Could not load requests. Please try again." }
  }
}

export async function adminCountPending(passcode: string): Promise<Record<string, number>> {
  if (!(await adminOk(passcode))) return {}
  try {
    return await countPendingByKind()
  } catch (err) {
    console.log("[v0] adminCountPending failed:", (err as Error).message)
    return {}
  }
}

/**
 * Count of approved-&-initiated payments still awaiting the administrator's
 * stage-3 delivery confirmation. Surfaced on the "Outgoing Payments" command
 * tile so a payment that already left `pending` still signals a pending action.
 */
export async function adminCountPaymentsAwaitingDelivery(passcode: string): Promise<number> {
  if (!(await adminOk(passcode))) return 0
  try {
    return await countPaymentsAwaitingDelivery()
  } catch (err) {
    console.log("[v0] adminCountPaymentsAwaitingDelivery failed:", (err as Error).message)
    return 0
  }
}

/** Count of approved Yield / PPP programs with a pending early-termination request. */
export async function adminCountYieldTerminationRequests(passcode: string): Promise<number> {
  if (!(await adminOk(passcode))) return 0
  try {
    return await countYieldTerminationRequests()
  } catch (err) {
    console.log("[v0] adminCountYieldTerminationRequests failed:", (err as Error).message)
    return 0
  }
}

/** Count of approved Treuhand fund positions with a pending early-termination request. */
export async function adminCountTradingFundTerminationRequests(passcode: string): Promise<number> {
  if (!(await adminOk(passcode))) return 0
  try {
    return await countTradingFundTerminationRequests()
  } catch (err) {
    console.log("[v0] adminCountTradingFundTerminationRequests failed:", (err as Error).message)
    return 0
  }
}

export async function adminCountInstrumentUpgradeRequests(passcode: string): Promise<number> {
  if (!(await adminOk(passcode))) return 0
  try {
    return await countInstrumentUpgradeRequests()
  } catch (err) {
    console.log("[v0] adminCountInstrumentUpgradeRequests failed:", (err as Error).message)
    return 0
  }
}

// Approval kinds that, when approved, CREDIT the owner's balance. These are
// surfaced as available funds (e.g. monetization proceeds, downloaded funds,
// project funding draws). Used as a fallback when an approval was created
// before an explicit `ledgerEffect` was attached, so the amount/currency stored
// on the approval itself still posts to the client's ledger on approval.
// NOTE: `project_funding` is intentionally NOT here. An approved AES facility's
// capital credit — and its ongoing 1.8% monthly cost-of-capital debits — are
// posted onto the client's ledger by the client-side FundingCapitalReconciler
// using deterministic `FND-CAP-*` / `FND-ROI-*` ids. Crediting it here too
// (as `APPR-<id>`) would DOUBLE the facility on the client's balance.
const CREDIT_KINDS = new Set<ApprovalKind>(["monetization", "dof"])

// Approval kinds that, when approved, RESERVE (place a hold/block on) the
// owner's balance — funds earmarked to settle the underlying transaction (e.g.
// a commodity purchase reserving the contract value to pay the supplier). Used
// as a fallback so the amount/currency stored on the approval still places a
// hold on approval even when no explicit `ledgerEffect` was attached (e.g. a
// deal registered before ledger effects were wired in).
const HOLD_KINDS = new Set<ApprovalKind>(["commodity"])

/**
 * Resolve the ledger entry an approved request should post (or null if none).
 * Prefers an explicit `ledgerEffect`; otherwise falls back to the approval's
 * own amount/currency for known crediting kinds. Idempotent id (`APPR-<id>`)
 * means re-applying never double-posts.
 */
function ledgerEntryForApproval(req: ApprovalRequest): LedgerEntry | null {
  // A read-only SHARED copy (an admin showed this deal to another client for
  // visibility only) must NEVER touch the recipient's balance — no hold, no
  // credit, no settlement — on approval, reconcile or backfill. Returning null
  // here is the single chokepoint that guarantees zero financial effect.
  if ((req.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
    return null
  }
  // A delivered commodity deal has been PAID OUT to the supplier: its reservation
  // must settle (a permanent `completed` debit), never remain a `hold`. Because
  // this builder also runs on every reconcile/backfill, leaving it as a hold here
  // would re-block delivered funds after delivery already settled them — exactly
  // the bug where "reserved" reappears for a delivered deal.
  const isDelivered = (req.payload as { delivered?: boolean } | undefined)?.delivered === true

  const fx = req.ledgerEffect
  if (fx) {
    const amount = Number(fx.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    const baseStatus = fx.status ?? "completed"
    // A held (reserved) effect that has been delivered is now settled.
    const settledByDelivery = baseStatus === "hold" && isDelivered
    return {
      id: `APPR-${req.id}`,
      direction: fx.direction,
      amount,
      currency: fx.currency || req.currency || BASE_CURRENCY,
      status: settledByDelivery ? "completed" : baseStatus,
      date: new Date().toISOString(),
      counterparty: fx.counterparty ?? req.title,
      account: fx.account,
      bank: fx.bank,
      reference: fx.reference ?? req.id,
      comment: settledByDelivery
        ? `Delivered & settled — funds paid out for ${KIND_LABELS[req.kind]} "${req.title}"`
        : `Approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: settledByDelivery
        ? "Commodity Trade — Settled (Delivered)"
        : (fx.category ?? KIND_LABELS[req.kind]),
      // Tag the debit/credit to a sub-account compartment when the client
      // remitted the payment FROM one, so it moves only that isolated balance.
      subAccountId: fx.subAccountId || undefined,
    }
  }
  // Fallback: credit the stored amount for known crediting kinds (e.g. a
  // monetization approved before ledger effects were attached).
  if (CREDIT_KINDS.has(req.kind)) {
    const amount = Number(req.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "credit",
      amount,
      currency: req.currency || BASE_CURRENCY,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: req.title,
      reference: req.id,
      comment: `Approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: KIND_LABELS[req.kind],
    }
  }
  // Leverage: on approval the BORROWED funds (equity × (ratio − 1)) are credited
  // to the client's balance, multiplying their buying power. The amount stored
  // on the approval itself is the *equity*, not the borrowed sum, so we read the
  // borrowed amount (and currency) from the full record in `payload.record`.
  //
  // We credit the INITIAL borrowed amount — i.e. the value at activation. If an
  // admin later modifies the ratio, that delta is settled by its own balancing
  // ledger entry (`adjustmentEntryId`), so this base credit must NOT track the
  // current borrowed amount or the idempotent reconcile would double-count the
  // modification. The initial value is recoverable from the first modification's
  // `fromBorrowed`, mirroring the interest-accrual logic.
  if (req.kind === "leverage") {
    const record = (req.payload?.record ?? {}) as {
      borrowedAmount?: number
      currency?: string
      modifications?: { fromBorrowed?: number }[]
      accountLabel?: string
      status?: string
    }
    // A switched-off / closed line has had its borrowed principal repaid, so it
    // must no longer credit the balance (and reconcile must not re-credit it).
    if (record.status === "closed") return null
    const mods = record.modifications
    const initialBorrowed =
      Array.isArray(mods) && mods.length > 0 && Number.isFinite(Number(mods[0]?.fromBorrowed))
        ? Number(mods[0].fromBorrowed)
        : Number(record.borrowedAmount)
    if (!Number.isFinite(initialBorrowed) || initialBorrowed <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "credit",
      amount: initialBorrowed,
      currency: record.currency || req.currency || BASE_CURRENCY,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: record.accountLabel || req.title,
      reference: req.id,
      comment: `Borrowed funds credited — approved ${KIND_LABELS[req.kind]} (${req.title})`,
      category: "Leverage — Borrowed Funds",
    }
  }
  // Fallback: reserve (hold) the stored amount for known reserving kinds (e.g. a
  // commodity deal approved before ledger effects were attached) so the funds
  // are blocked on the client's balance to settle the supplier.
  if (HOLD_KINDS.has(req.kind)) {
    const amount = Number(req.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      id: `APPR-${req.id}`,
      direction: "debit",
      amount,
      currency: req.currency || BASE_CURRENCY,
      // Delivered → settled (paid out, leaves the balance); otherwise → hold
      // (reserved/blocked). This keeps the backfill consistent with delivery.
      status: isDelivered ? "completed" : "hold",
      date: new Date().toISOString(),
      counterparty: req.title,
      reference: req.id,
      comment: isDelivered
        ? `Delivered & settled — funds paid out for ${KIND_LABELS[req.kind]} "${req.title}"`
        : `Reserved for approved ${KIND_LABELS[req.kind]} — ${req.title}`,
      category: isDelivered
        ? "Commodity Trade — Settled (Delivered)"
        : "Commodity Trade — Reserved Funds",
    }
  }
  return null
}

/** Thrown when an approval's reservation cannot be covered by available funds. */
class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InsufficientFundsError"
  }
}

/**
 * Available balance per currency, EXCLUDING this approval's own prior ledger
 * postings (`APPR-<id>*`). This gives reservation planning a stable baseline so
 * re-runs (idempotent backfill / reconcile / amendment) never see the hold they
 * themselves placed as a reason to re-fund or to fail a feasibility check.
 */
function availableExcludingApproval(entries: LedgerEntry[], reqId: string): Record<string, number> {
  const prefix = `APPR-${reqId}`
  return availableByCurrency(entries.filter((e) => !e.id.startsWith(prefix)))
}

export interface ReservationAssessment {
  /** True when this approval reserves funds (posts a debit hold). */
  required: boolean
  /** True when the full reservation can be covered with no negative balance. */
  feasible: boolean
  plan: ReservationPlan | null
  ownerId: string
  /** Client/admin-facing explanation when not feasible. */
  message: string
}

/**
 * Real-time fund-availability check for a (possibly) reserving approval, run
 * BEFORE the decision is committed. Resolves the balance owner (the Master for a
 * Sub-account), computes the prospective hold, and asks the planner whether it
 * can be funded — directly or via capped cross-currency FX. Non-reserving
 * approvals (credits, no ledger effect) are always "feasible".
 */
async function assessReservation(req: ApprovalRequest): Promise<ReservationAssessment> {
  const entry = ledgerEntryForApproval(req)
  const ownerId = await resolveDataOwnerIdFor(req.userId)
  // A "hold" debit always reserves; a `gate:true` effect is a SETTLED debit
  // (e.g. an instrument acquisition fee) that must still be pre-checked for
  // affordability and funded via FX before it posts, so it is assessed too.
  const gated = entry?.direction === "debit" && (entry.status === "hold" || req.ledgerEffect?.gate === true)
  if (!entry || !gated) {
    return { required: false, feasible: true, plan: null, ownerId, message: "" }
  }
  const existing = await readLedgerEntries(ownerId)
  const available = availableExcludingApproval(existing, req.id)
  const plan = planReservation(available, entry.currency, entry.amount)
  const message = plan.feasible
    ? ""
    : `Insufficient available funds to reserve ${formatMoney(entry.amount, entry.currency)} for this ` +
      `${KIND_LABELS[req.kind].toLowerCase()}. Total spendable balance is ` +
      `${formatMoney(plan.totalAvailableInNeedCurrency, entry.currency)} (short by ` +
      `${formatMoney(entry.amount - plan.totalAvailableInNeedCurrency, entry.currency)}).`
  return { required: true, feasible: plan.feasible, plan, ownerId, message }
}

/**
 * Apply the financial effect (if any) of an approved request to the SHARED-data
 * owner's ledger. For a Sub-account the balance lives under its Master, so the
 * debit/credit must post to the Master's id — not the sub's own (empty) ledger.
 * Idempotent on the entry id so re-running never double-posts.
 */
async function applyLedgerEffect(req: ApprovalRequest): Promise<void> {
  const entry = ledgerEntryForApproval(req)
  if (!entry) return
  const ownerId = await resolveDataOwnerIdFor(req.userId)

  // Reservation (debit hold) with cross-currency funding: a deal is priced in
  // the deal currency (e.g. USD) but the client may fund it from balances in
  // other currencies (e.g. EUR). Funds are taken first from the deal currency;
  // any shortfall is covered by REAL FX conversions, each leg CAPPED at the
  // source currency's available balance so NO balance can be driven negative.
  // The FX legs are SETTLED (permanent): if the deal is later cancelled, only
  // the hold (`APPR-<id>`) is released, so converted funds remain available. If
  // the full amount cannot be covered, we throw instead of posting a partial or
  // overdrawn reservation — callers pre-check and auto-reject, this is the last
  // line of defense.
  const postedIds: string[] = []
  // Fund both reservations ("hold" debits) and gated SETTLED debits (e.g. an
  // instrument acquisition fee) the same way: take from the deal/fee currency
  // first, cover any shortfall with capped cross-currency FX, and never overdraw.
  const gatedDebit = entry.direction === "debit" && (entry.status === "hold" || req.ledgerEffect?.gate === true)
  if (gatedDebit) {
    const existing = await readLedgerEntries(ownerId)
    const available = availableExcludingApproval(existing, req.id)
    const plan = planReservation(available, entry.currency, entry.amount)

    if (!plan.feasible) {
      throw new InsufficientFundsError(
        `Cannot reserve ${formatMoney(entry.amount, entry.currency)} — only ` +
          `${formatMoney(plan.totalAvailableInNeedCurrency, entry.currency)} available across all currencies.`,
      )
    }

    const ref = entry.reference || req.id
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i]
      // Leg A — sell the source currency (settled, permanent debit), capped at
      // its balance by the planner.
      const sellId = `APPR-${req.id}-fx${i}-sell`
      await upsertLedgerEntry(ownerId, {
        id: sellId,
        direction: "debit",
        amount: leg.sellAmount,
        currency: leg.fromCurrency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "FX Treasury",
        reference: ref,
        category: "FX Conversion — Commodity Funding",
        comment: `Sold ${formatMoney(leg.sellAmount, leg.fromCurrency)} to buy ${formatMoney(leg.buyAmount, entry.currency)} for settlement (${leg.rateLabel})`,
      })
      postedIds.push(sellId)

      // Leg B — buy the deal currency (settled, permanent credit).
      const buyId = `APPR-${req.id}-fx${i}-buy`
      await upsertLedgerEntry(ownerId, {
        id: buyId,
        direction: "credit",
        amount: leg.buyAmount,
        currency: entry.currency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "FX Treasury",
        reference: ref,
        category: "FX Conversion — Commodity Funding",
        comment: `Bought ${formatMoney(leg.buyAmount, entry.currency)} from ${formatMoney(leg.sellAmount, leg.fromCurrency)} for settlement (${leg.rateLabel})`,
      })
      postedIds.push(buyId)
    }

    if (plan.legs.length > 0) {
      entry.comment =
        `${entry.comment ? entry.comment + " · " : ""}Reserved ${formatMoney(entry.amount, entry.currency)} ` +
        `(funded via FX from ${plan.legs.map((l) => l.fromCurrency).join(", ")})`
    }
  }

  await upsertLedgerEntry(ownerId, entry)
  postedIds.push(entry.id)

  // DB-level non-negativity enforcement (defense in depth). If this posting
  // overdrew ANY currency, roll back every entry we just wrote and surface the
  // failure rather than leaving a negative balance committed.
  if (entry.direction === "debit") {
    try {
      await assertOwnerSolvent(ownerId)
    } catch (err) {
      for (const id of postedIds) {
        await deleteLedgerEntry(ownerId, id).catch(() => {})
      }
      throw new InsufficientFundsError((err as Error).message)
    }
  }
}

/**
 * Back-fill ledger credits for the signed-in client's already-approved
 * requests. Safe to call on every dashboard load: posting is idempotent on
 * `APPR-<id>`, so an entry that already exists is simply overwritten with the
 * same values. This guarantees that any approved monetization (including ones
 * approved before ledger effects existed) reflects in the master account
 * balance the next time the ledger hydrates. Returns the number of credit
 * entries reconciled.
 */
export async function reconcileMyApprovedCredits(): Promise<{ ok: boolean; applied: number }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, applied: 0 }
  try {
  // Collect-funds deposits RECEIVED from other parties: sweep any approved
  // payment addressed to one of this user's gateway IBANs into a credit on
  // their ledger, so collected funds reflect on the Master Account balance and
  // the matching currency card from any screen — not only the gateway page.
  // Idempotent (keyed on GWD-<approvalId>), so it never double-credits.
  await backfillGatewayDepositsForUser(session.id).catch(() => {})

  // Same sweep for registered external bank accounts: any approved payment
  // addressed to one of this user's registered account IBANs is credited to
  // their Master Account (and per-bank sub-balance). Idempotent (RAD-<id>).
  await backfillRegisteredAccountDepositsForUser(session.id).catch(() => {})

  const mine = await listApprovalsForUser(session.id)
  const approved = mine.filter((r) => r.status === "approved")
    let applied = 0
    for (const req of approved) {
      const entry = ledgerEntryForApproval(req)
      if (!entry) continue
      // A DELIVERED commodity deal must settle: its reservation becomes a
      // permanent `completed` debit (funds paid out to the supplier). Without
      // this, a stale `hold` left behind by delivery (e.g. when a post-delivery
      // amendment re-created the hold, or the one-time delivery settlement was
      // bypassed) would stay frozen forever, because the credit/hold-only
      // filter below would never overwrite it. `ledgerEntryForApproval` already
      // returns this as a `completed` debit for delivered deals, so re-posting
      // it (idempotent on `APPR-<id>`) unblocks the reserved funds on the next
      // ledger hydration, cross-device.
      const isDeliveredSettlement =
        entry.direction === "debit" &&
        entry.status === "completed" &&
        HOLD_KINDS.has(req.kind) &&
        (req.payload as { delivered?: boolean } | undefined)?.delivered === true
      // Back-fill credits (incoming proceeds), holds (reserved funds for approved
      // commodity deals) and delivered-settlement debits so the balance reflects
      // them on the same ledger it is read from, even for requests approved
      // before the effect was wired in. Idempotent on `APPR-<id>`, so re-posting
      // never doubles up.
      if (entry.direction === "credit" || entry.status === "hold" || isDeliveredSettlement) {
        // Post to the shared-data owner (Master for a sub) so the entry lands
        // on the same ledger the balance is read from.
        const ownerId = await resolveDataOwnerIdFor(req.userId)
        await upsertLedgerEntry(ownerId, entry)
        applied += 1
      }
    }

    // Treuhand trading fund lifecycle on the ledger, driven off the approval
    // status (no scheduler — runs on every ledger read, self-healing/cross-
    // device). Deterministic ids keep every post idempotent:
    //   • PENDING   → RESERVE the capital as a `hold` debit `APPR-<id>` so the
    //                 funds are BLOCKED on the master account while the
    //                 administrator reviews the application.
    //   • APPROVED  → SETTLE that same `APPR-<id>` into a `completed` debit
    //                 (capital deducted, reflecting on the master account) plus
    //                 matured 25% monthly ROI credits and any capital-return.
    //   • REJECTED/CANCELLED → RELEASE the reservation hold (unfreeze funds).
    const tradingFundReqs = mine.filter((r) => r.kind === "trading_fund")
    const ownerLedgerRows = new Map<string, Map<string, LedgerEntry>>()
    const loadOwnerRows = async (ownerId: string) => {
      let rows = ownerLedgerRows.get(ownerId)
      if (!rows) {
        const list = await readLedgerEntries(ownerId)
        rows = new Map(list.map((r) => [r.id, r]))
        ownerLedgerRows.set(ownerId, rows)
      }
      return rows
    }
    for (const req of tradingFundReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)

      // A decided-against application must not keep funds frozen: drop the
      // reservation hold if one is still present.
      if (req.status === "rejected" || req.status === "cancelled") {
        const capId = `APPR-${req.id}`
        const cur = rows.get(capId)
        if (cur && cur.status === "hold") {
          await deleteLedgerEntry(ownerId, capId)
          rows.delete(capId)
          applied += 1
        }
        continue
      }

      const posts = buildTradingFundPosts(req)
      for (const post of posts) {
        const cur = rows.get(post.id)
        // Post when missing OR when the entry must change (the pending `hold`
        // becoming the approved `completed` settlement). Re-running with an
        // identical entry is a no-op, so this never double-posts.
        if (cur && cur.status === post.status && cur.direction === post.direction && cur.amount === post.amount) {
          continue
        }
        await upsertLedgerEntry(ownerId, post)
        rows.set(post.id, post)
        applied += 1
      }
    }

    // Leverage charges on the ledger, driven off the approval status (no
    // scheduler — runs on every ledger read, self-healing/cross-device). A
    // leverage application only ever COSTS the client when it is APPROVED; while
    // PENDING the audit fee + PPI are reversible HOLDS, and a REJECTED/CANCELLED
    // line must cost NOTHING. So for any rejected/cancelled leverage line, delete
    // every associated charge id (hold OR completed) — this releases pending
    // holds and REFUNDS any audit/PPI that a past build wrongly settled as a
    // completed debit on rejection. Deterministic ids keep it idempotent, and it
    // never touches an approved line's real charges.
    const leverageReqs = mine.filter(
      (r) => r.kind === "leverage" && (r.status === "rejected" || r.status === "cancelled"),
    )
    for (const req of leverageReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)
      const chargeIds = [
        `LEV-AUDIT-${req.id}`,
        `LEV-PPI-${req.id}`,
        `LEV-AUDIT-APPEAL-${req.id}`,
        `LEV-PPI-APPEAL-${req.id}`,
        `LEV-PPI-REFUND-${req.id}`,
        `LEV-PPI-ADJUST-${req.id}`,
      ]
      for (const cid of chargeIds) {
        if (rows.has(cid)) {
          await deleteLedgerEntry(ownerId, cid)
          rows.delete(cid)
          applied += 1
        }
      }
    }

    // Yield / PPP automatic ROI on the ledger. Once an application is APPROVED,
    // the program pays ROI in arrears on its cycle (weekly / monthly / …): each
    // matured period is CREDITED to the master account. When the investment is
    // funded by an MCC HOLDING SA-owned instrument, only the client's 25% share
    // is credited (the 75% is alienated to MCC HOLDING SA). No scheduler — this
    // runs on every ledger read, self-healing/cross-device, and deterministic
    // ids (`PPP-ROI-<id>-P<n>`) keep every credit idempotent.
    // The invested PRINCIPAL is debited on approval (capital deployed into the
    // program) and returned to the master account once the program term elapses
    // — `buildPppCapitalPosts` — alongside the periodic ROI credits, but ONLY for
    // CASH-funded programs. An INSTRUMENT-funded program pledges a bank instrument
    // as collateral, so no cash ever leaves the master account. Posting the capital
    // leg here means an ALREADY-approved cash program self-heals: its principal
    // debit appears on the next ledger read even though approval predated the fix.
    // Deterministic ids keep it idempotent.
    const pppReqs = mine.filter((r) => r.kind === "ppp" && r.status === "approved")
    for (const req of pppReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)

      // Self-heal: a prior build wrongly debited master CASH for instrument-funded
      // programs too, which drove accounts deeply negative. For any approved PPP
      // that is instrument-funded, delete the stale capital debit/return rows so
      // the balance recovers on the next ledger read (collateral, not cash).
      const record = (req.payload as { record?: { fundingInstrumentId?: string } } | undefined)?.record
      if (!pppIsCashFunded(record)) {
        for (const staleId of [pppCapitalId(req.id), pppCapitalReturnId(req.id)]) {
          if (rows.has(staleId)) {
            await deleteLedgerEntry(ownerId, staleId)
            rows.delete(staleId)
            applied += 1
          }
        }
      }

      const posts = [...buildPppCapitalPosts(req), ...buildPppRoiPosts(req)]
      for (const post of posts) {
        const cur = rows.get(post.id)
        // Post when missing OR when the entry must change — notably a locked
        // (leverage-funded) ROI `hold` becoming a withdrawable `completed` credit
        // once the program matures. Re-running with an identical entry is a no-op,
        // so this never double-posts.
        if (cur && cur.status === post.status && cur.direction === post.direction && cur.amount === post.amount) {
          continue
        }
        await upsertLedgerEntry(ownerId, post)
        rows.set(post.id, post)
        applied += 1
      }
    }

    // Internal-loan lifecycle on the ledger, driven off the approval status
    // (self-contained like trading_fund; no scheduler — runs on every ledger
    // read, self-healing/cross-device). Deterministic ids keep every post
    // idempotent:
    //   • APPROVED → CREDIT the principal to the master (`ILOAN-<id>`), DEBIT any
    //                one-time arrangement fee (`ILOAN-FEE-<id>`), and DEBIT each
    //                matured monthly interest charge (`ILOAN-INT-<id>-<YYYY-MM>`,
    //                default 3% p.a., admin-overridable; first month pro-rated).
    //   • SETTLED  → `settledAt` stops further monthly interest (the repayment
    //                action posts the final interest stub exactly once).
    // Nothing posts while PENDING/REJECTED — an internal loan never moves money
    // until the administrator approves it.
    const internalLoanReqs = mine.filter((r) => r.kind === "internal_loan" && r.status === "approved")
    for (const req of internalLoanReqs) {
      const ownerId = await resolveDataOwnerIdFor(req.userId)
      const rows = await loadOwnerRows(ownerId)
      const posts = buildInternalLoanPosts(req, new Set(rows.keys()))
      for (const post of posts) {
        const entry: LedgerEntry = { ...post.entry, direction: post.direction }
        if (rows.has(entry.id)) continue
        await upsertLedgerEntry(ownerId, entry)
        rows.set(entry.id, entry)
        applied += 1
      }
    }

    // OVERDRAFT DEBIT INTEREST. A Master Account in overdraft (aggregate settled
    // EUR balance negative) accrues 22% p.a. debit interest, charged DAILY on the
    // used (negative) balance. Posted lazily here (no scheduler) with a
    // deterministic per-day id `OD-INT-<YYYY-MM-DD>`, so it never double-charges
    // and self-heals across devices. Runs BEFORE auto-cover so the fresh charge
    // is rebalanced across currencies in the same pass. Best-effort: an accrual
    // failure must never break the rest of the reconcile.
    try {
      const odOwnerId = await resolveDataOwnerIdFor(session.id)
      const odRows = await readLedgerEntries(odOwnerId)
      const settledEur = await getSettledBalanceEur(odOwnerId)
      const odPosts = buildOverdraftInterestPosts({
        entries: odRows,
        negativeEur: settledEur < 0 ? -settledEur : 0,
      })
      for (const post of odPosts) {
        await upsertLedgerEntry(odOwnerId, post)
        applied += 1
      }
    } catch (err) {
      console.log("[v0] overdraft interest accrual failed:", (err as Error).message)
    }

    // AUTO-COVER negative currencies. Leverage fees (audit, PPI) and debit
    // interest are charged in the leverage line's OWN currency, with no check
    // that that currency holds funds — so a single currency (e.g. USD) can be
    // driven negative even though the master account holds plenty elsewhere
    // (e.g. GBP). Per the account owner's directive, fees are "drawn across all
    // currencies": here we rebalance any genuinely overdrawn currency from the
    // strongest funded currency via an internal FX conversion, so no single
    // currency stays negative. Idempotent + self-resizing (deterministic ids),
    // so it also clears a pre-existing deficit on the next ledger read.
    try {
      const coverOwnerId = await resolveDataOwnerIdFor(session.id)
      applied += await autoCoverNegativeBalances(coverOwnerId)
    } catch (err) {
      console.log("[v0] auto-cover negative balances failed:", (err as Error).message)
    }

    return { ok: true, applied }
  } catch (err) {
    console.log("[v0] reconcileMyApprovedCredits failed:", (err as Error).message)
    return { ok: false, applied: 0 }
  }
}

/**
 * Internal FX auto-cover. Any currency whose SETTLED (completed) balance is
 * genuinely overdrawn is topped up from the strongest funded currency the
 * account holds, via a matched internal FX conversion (a credit into the
 * overdrawn currency + a debit of the converted value from the source), so no
 * single currency is left negative while funds exist elsewhere. Uses only value
 * the account already owns — no money is created; the total EUR-equivalent is
 * preserved. Deterministic ids (`FX-COVER-<CUR>` / `FX-COVER-<CUR>-SRC`) make it
 * idempotent and self-resizing across reads, and cover rows are removed once a
 * currency is no longer overdrawn (e.g. after the client funds/repays it).
 * Holds are ignored (a reversible reservation is not a real overdraft) and
 * sub-account-tagged rows are excluded (isolated compartments, not the pool).
 */
async function autoCoverNegativeBalances(ownerId: string): Promise<number> {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const FX_COVER_PREFIX = "FX-COVER-"
  const rows = await readLedgerEntries(ownerId)

  // Natural settled balance per currency, EXCLUDING existing cover rows (so the
  // cover never feeds on itself) and sub-account compartments.
  const natural: Record<string, number> = {}
  for (const e of rows) {
    if (e.id.startsWith(FX_COVER_PREFIX)) continue
    if (e.status !== "completed") continue
    if (e.subAccountId) continue
    const c = e.currency || "USD"
    natural[c] = (natural[c] ?? 0) + (e.direction === "credit" ? e.amount : -e.amount)
  }

  const have = new Set(rows.map((r) => r.id))
  // Spendable per source currency (natural positives), decremented as allocated
  // so one source is never pushed negative across multiple overdrawn targets.
  const spare: Record<string, number> = {}
  for (const [c, v] of Object.entries(natural)) if (v > 0.01) spare[c] = v

  let applied = 0
  for (const [target, bal] of Object.entries(natural)) {
    const creditId = `${FX_COVER_PREFIX}${target}`
    const debitId = `${FX_COVER_PREFIX}${target}-SRC`
    if (bal >= -0.01) {
      // Not overdrawn (any more) — drop stale cover rows for this currency.
      if (have.has(creditId)) await deleteLedgerEntry(ownerId, creditId).catch(() => {})
      if (have.has(debitId)) await deleteLedgerEntry(ownerId, debitId).catch(() => {})
      continue
    }
    const deficit = round2(-bal)
    // Strongest source by value in the target currency.
    const src = Object.keys(spare)
      .filter((s) => s !== target && spare[s] > 0.01)
      .sort((a, b) => convertCurrency(spare[b], b, target) - convertCurrency(spare[a], a, target))[0]
    if (!src) {
      // Genuinely insolvent (no other funded currency) — leave the real negative
      // visible and clear any stale cover rows.
      if (have.has(creditId)) await deleteLedgerEntry(ownerId, creditId).catch(() => {})
      if (have.has(debitId)) await deleteLedgerEntry(ownerId, debitId).catch(() => {})
      continue
    }
    const srcCapacityInTarget = convertCurrency(spare[src], src, target)
    const cover = round2(Math.min(deficit, srcCapacityInTarget))
    if (cover <= 0.01) continue
    const srcAmount = round2(convertCurrency(cover, target, src))
    const now = new Date().toISOString()
    await upsertLedgerEntry(ownerId, {
      id: creditId,
      direction: "credit",
      amount: cover,
      currency: target,
      status: "completed",
      date: now,
      counterparty: "Internal FX rebalance",
      bank: "NAFTAhub Treasury",
      reference: "fx-auto-cover",
      comment: `Automatic FX cover — ${src} converted to ${cover.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${target} to clear an overdrawn ${target} balance (fees/interest charged in ${target} exceeded the ${target} held). Funded from your ${src} balance; no funds were created.`,
      category: "FX Auto-Cover",
    })
    await upsertLedgerEntry(ownerId, {
      id: debitId,
      direction: "debit",
      amount: srcAmount,
      currency: src,
      status: "completed",
      date: now,
      counterparty: "Internal FX rebalance",
      bank: "NAFTAhub Treasury",
      reference: "fx-auto-cover",
      comment: `Automatic FX cover — ${srcAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${src} converted to ${cover.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${target} to clear an overdrawn ${target} balance.`,
      category: "FX Auto-Cover",
    })
    spare[src] = round2((spare[src] ?? 0) - srcAmount)
    applied += 1
  }
  return applied
}

export type DecideResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

/**
 * Post any missing trading-fund ledger entries (capital debit, matured ROI, and
 * the capital-return credit once closed) for ONE approved subscription to its
 * balance owner (Master for a sub). Idempotent — skips ids already present.
 * Used by the admin position-control actions so the effect reflects for the
 * client immediately, without waiting for their next ledger read.
 */
async function syncTradingFundLedger(req: ApprovalRequest): Promise<void> {
  const posts = buildTradingFundPosts(req)
  if (posts.length === 0) return
  const ownerId = await resolveDataOwnerIdFor(req.userId)
  const rows = await readLedgerEntries(ownerId)
  const existing = new Set(rows.map((r) => r.id))
  for (const post of posts) {
    if (existing.has(post.id)) continue
    await upsertLedgerEntry(ownerId, post)
  }
}

/** Current lifecycle state of a Treuhand position, derived from its payload. */
export type TradingFundPositionStatus = "active" | "paused" | "closed"

function tradingFundStatus(payload: Record<string, unknown> | null | undefined): TradingFundPositionStatus {
  const p = (payload ?? {}) as { closedAt?: string; exitedAt?: string; pauseWindows?: TradingFundPauseWindow[] }
  if (p.closedAt || p.exitedAt) return "closed"
  if (Array.isArray(p.pauseWindows) && p.pauseWindows.some((w) => w && w.from && !w.to)) return "paused"
  return "active"
}

/** Load an approved trading_fund position and guard it, for an admin action. */
async function loadOpenPosition(
  id: string,
): Promise<{ ok: true; req: ApprovalRequest; payload: Record<string, unknown> } | { ok: false; error: string }> {
  const existing = await getApprovalById(id)
  if (!existing) return { ok: false, error: "Position not found." }
  if (existing.kind !== "trading_fund") return { ok: false, error: "This is not a Treuhand fund position." }
  if (existing.status !== "approved") return { ok: false, error: "Only an authorized position can be managed." }
  return { ok: true, req: existing, payload: (existing.payload ?? {}) as Record<string, unknown> }
}

async function notifyPositionChange(req: ApprovalRequest, title: string, body: string): Promise<void> {
  try {
    await insertNotification({
      userId: req.userId,
      tone: "info",
      title,
      body,
      href: KIND_HREF.trading_fund ?? "/dashboard/trading",
    })
  } catch (err) {
    console.log("[v0] trading-fund notification failed:", (err as Error).message)
  }
}

async function logPositionChange(req: ApprovalRequest, action: string, decision: string, note?: string): Promise<void> {
  try {
    const target = await resolveAccountProfileById(req.userId)
    await logActivity({
      action,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: req.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: req.summary || req.title,
        decision,
        reason: note?.trim() || "(none)",
      },
    })
  } catch (err) {
    console.log("[v0] trading-fund activity log failed:", (err as Error).message)
  }
}

/**
 * Administrator PAUSES a live Treuhand position. Opens a pause window so ROI
 * stops maturing and every future anniversary is deferred by the paused time.
 * The capital stays deployed (debit untouched). Client cannot do this.
 */
export async function pauseTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { req, payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is closed." }
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    if (windows.some((w) => w && w.from && !w.to)) return { ok: false, error: "This position is already paused." }
    windows.push({ from: new Date().toISOString() })
    const updated = await updateApprovalPayload(id, { ...payload, pauseWindows: windows, positionStatus: "paused" })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    await notifyPositionChange(
      updated,
      "Treuhand position paused",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was paused by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. Monthly ROI is on hold until it is reactivated.`,
    )
    await logPositionChange(updated, `Administrator paused Treuhand position "${updated.title}"`, "Paused", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] pauseTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be paused. Please try again." }
  }
}

/**
 * Administrator RESUMES a paused Treuhand position. Closes the open pause window
 * so ROI accrual continues from where it left off.
 */
export async function resumeTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is closed." }
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (!open) return { ok: false, error: "This position is not paused." }
    open.to = new Date().toISOString()
    const updated = await updateApprovalPayload(id, { ...payload, pauseWindows: windows, positionStatus: "active" })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    await notifyPositionChange(
      updated,
      "Treuhand position reactivated",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was reactivated by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. Monthly ROI accrual has resumed.`,
    )
    await logPositionChange(updated, `Administrator reactivated Treuhand position "${updated.title}"`, "Reactivated", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] resumeTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be reactivated. Please try again." }
  }
}

/**
 * Administrator CLOSES / EXITS a Treuhand position. ROI stops maturing and the
 * deployed capital (the tokens) is CREDITED BACK to the master account, netting
 * the original debit to zero. Matured ROI already earned stays paid. The
 * capital return + any final matured ROI are posted immediately.
 */
export async function closeTradingFundPosition(passcode: string, id: string, note?: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is already closed." }
    const nowIso = new Date().toISOString()
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (open) open.to = nowIso
    const updated = await updateApprovalPayload(id, {
      ...payload,
      pauseWindows: windows,
      closedAt: nowIso,
      positionStatus: "closed",
    })
    if (!updated) return { ok: false, error: "The position could not be updated." }
    // Post the capital-return credit (and any final matured ROI) right away.
    await syncTradingFundLedger(updated)
    const capital = Number(updated.amount ?? (updated.payload as { capital?: number })?.capital)
    const capitalLabel = Number.isFinite(capital) ? formatMoney(capital, updated.currency ?? "EUR") : "the deployed capital"
    await notifyPositionChange(
      updated,
      "Treuhand position closed",
      `Your Treuhand AG Hedge Fund position "${updated.title}" was closed by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. ${capitalLabel} (your tokens) has been credited back to your Master Account and monthly ROI has stopped.`,
    )
    await logPositionChange(updated, `Administrator closed Treuhand position "${updated.title}" and returned capital`, "Closed", note)
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] closeTradingFundPosition failed:", (err as Error).message)
    return { ok: false, error: "The position could not be closed. Please try again." }
  }
}

/**
 * CLIENT requests an anticipated termination (early resignation) of one of their
 * OWN Treuhand positions. This only records the request on the payload and
 * notifies the administrator — it moves NO money and does NOT close the position.
 * The administrator evaluates it and, if agreed, runs the reconciliation
 * (`reconcileTradingFundTermination`) which is where the fees are applied and the
 * capital is returned. Ownership is enforced against the caller's environment.
 */
export async function requestTradingFundTermination(
  id: string,
  reason?: string,
): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(id)
    if (!existing || existing.kind !== "trading_fund") return { ok: false, error: "Position not found." }
    if (existing.status !== "approved") return { ok: false, error: "Only an active position can be terminated." }
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (!memberIds.includes(existing.userId)) return { ok: false, error: "You cannot manage this position." }
    const payload = (existing.payload ?? {}) as Record<string, unknown>
    if (payload.closedAt || payload.exitedAt) return { ok: false, error: "This position is already closed." }
    if (payload.terminationRequestedAt) return { ok: false, error: "A termination request is already under review." }

    const updated = await updateApprovalPayload(id, {
      ...payload,
      terminationRequestedAt: new Date().toISOString(),
      terminationReason: reason?.trim() || null,
    })
    if (!updated) return { ok: false, error: "The request could not be recorded. Please try again." }

    // Surface to the administrator via the activity log (the admin panel reads
    // the flag directly from the position, so this is the audit trail).
    await logPositionChange(
      updated,
      `Client requested early termination of Treuhand position "${updated.title}"`,
      "Termination requested",
      reason,
    )
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] requestTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The request could not be submitted. Please try again." }
  }
}

/** CLIENT withdraws a pending early-termination request on their own position. */
export async function withdrawTradingFundTermination(id: string): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(id)
    if (!existing || existing.kind !== "trading_fund") return { ok: false, error: "Position not found." }
    const memberIds = await resolveEnvironmentMemberIds(session.id)
    if (!memberIds.includes(existing.userId)) return { ok: false, error: "You cannot manage this position." }
    const payload = (existing.payload ?? {}) as Record<string, unknown>
    if (!payload.terminationRequestedAt) return { ok: false, error: "There is no pending request to withdraw." }
    if (payload.closedAt || payload.exitedAt) return { ok: false, error: "This position is already closed." }

    const { terminationRequestedAt: _r, terminationReason: _n, ...rest } = payload
    const updated = await updateApprovalPayload(id, rest)
    if (!updated) return { ok: false, error: "The request could not be withdrawn. Please try again." }
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] withdrawTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The request could not be withdrawn. Please try again." }
  }
}

/**
 * ADMINISTRATOR reconciles and closes a Treuhand position in ONE step — used to
 * grant an anticipated (early) termination the client requested, or to settle a
 * normal exit. Records the agreed early-resignation `penalty` and any additional
 * `charges` on the payload, sets `closedAt`, then posts the whole settlement to
 * the ledger: capital returned, the 2% platform commission, and the penalty /
 * charges. The client then sees the capital credited MINUS all fees.
 */
export async function reconcileTradingFundTermination(
  passcode: string,
  id: string,
  input: { penaltyAmount?: number; chargesAmount?: number; chargesNote?: string; note?: string },
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadOpenPosition(id)
    if (!loaded.ok) return loaded
    const { payload } = loaded
    if (tradingFundStatus(payload) === "closed") return { ok: false, error: "This position is already closed." }

    const penalty = Math.max(0, Number(input.penaltyAmount) || 0)
    const charges = Math.max(0, Number(input.chargesAmount) || 0)
    if (!Number.isFinite(penalty) || !Number.isFinite(charges)) {
      return { ok: false, error: "Penalty and charges must be valid amounts." }
    }

    // DEEP-DEBIT GUARD. The settlement returns the capital (+capital) but charges
    // the 2% commission + penalty + charges. When the returned capital has already
    // been consumed elsewhere (e.g. it repaid a leverage line funded against it),
    // those exit costs have no cash behind them and would drive the Master Account
    // millions negative — far beyond the authorized overdraft. Refuse in that case
    // and ask the administrator to reduce the penalty/charges (or fund the account)
    // instead of silently creating a deep illogical debit.
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    try {
      const posCurrency = loaded.req.currency ?? "EUR"
      const capitalNow = Number(loaded.req.amount ?? (payload as { capital?: number }).capital) || 0
      // The settlement's net cash effect on the account (returned capital minus the
      // exit costs). A negative net is money that must come out of existing balance.
      const netSettlementEur = round2(convertCurrency(capitalNow - penalty - charges - capitalNow * 0.02, posCurrency, "EUR"))
      const ownerId = await resolveDataOwnerIdFor(loaded.req.userId)
      const od = await getOverdraftStatusForOwner(ownerId)
      // Projected settled balance after this reconcile, in EUR.
      const projectedEur = round2(od.balanceEur + netSettlementEur)
      const projected = computeOverdraftStatus(od.depositBaseEur, projectedEur)
      if (projected.breachRatio > 1.0001) {
        const overBy = `EUR ${round2(projected.negativeEur - projected.limitEur).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        return {
          ok: false,
          error:
            `This reconciliation would take the client's Master Account to about EUR ${projectedEur.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, ` +
            `which is ${overBy} beyond their authorized overdraft (EUR ${od.limitEur.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). ` +
            `The returned capital was already used elsewhere, so the exit costs have no funds behind them. ` +
            `Reduce the penalty/charges, or have the client fund the account, before closing this position.`,
        }
      }
    } catch (guardErr) {
      console.log("[v0] reconcile deep-debit guard could not evaluate (proceeding):", (guardErr as Error).message)
    }

    const nowIso = new Date().toISOString()
    const windows: TradingFundPauseWindow[] = Array.isArray(payload.pauseWindows)
      ? [...(payload.pauseWindows as TradingFundPauseWindow[])]
      : []
    const open = windows.find((w) => w && w.from && !w.to)
    if (open) open.to = nowIso

    const updated = await updateApprovalPayload(id, {
      ...payload,
      pauseWindows: windows,
      closedAt: nowIso,
      positionStatus: "closed",
      earlyPenaltyAmount: penalty,
      exitChargesAmount: charges,
      exitChargesNote: input.chargesNote?.trim() || null,
      terminationHandledAt: nowIso,
      terminationRequestedAt: null,
    })
    if (!updated) return { ok: false, error: "The position could not be updated." }

    // Post the full settlement (capital return + commission + penalty + charges).
    await syncTradingFundLedger(updated)

    const currency = updated.currency ?? "EUR"
    const capital = Number(updated.amount ?? (updated.payload as { capital?: number })?.capital) || 0
    const commission = Math.round(capital * 0.02 * 100) / 100
    const net = Math.max(0, capital - commission - penalty - charges)
    const feeLine = [
      `${formatMoney(commission, currency)} commission`,
      penalty > 0 ? `${formatMoney(penalty, currency)} penalty` : null,
      charges > 0 ? `${formatMoney(charges, currency)} charges` : null,
    ]
      .filter(Boolean)
      .join(", ")

    await notifyPositionChange(
      updated,
      "Treuhand termination reconciled",
      `Your Treuhand AG Hedge Fund position "${updated.title}" has been terminated and reconciled by MCC Capital${input.note?.trim() ? ` — ${input.note.trim()}` : ""}. ${formatMoney(capital, currency)} capital was returned, less ${feeLine}. Net credited to your Master Account: ${formatMoney(net, currency)}.`,
    )
    await logPositionChange(
      updated,
      `Administrator reconciled and closed Treuhand position "${updated.title}"`,
      "Reconciled & closed",
      `Capital ${formatMoney(capital, currency)}, commission ${formatMoney(commission, currency)}, penalty ${formatMoney(penalty, currency)}, charges ${formatMoney(charges, currency)}, net ${formatMoney(net, currency)}. ${input.note?.trim() ?? ""}`,
    )
    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] reconcileTradingFundTermination failed:", (err as Error).message)
    return { ok: false, error: "The termination could not be reconciled. Please try again." }
  }
}

/** A Treuhand position summarized for the administrator control panel. */
export interface AdminTradingFundPosition {
  id: string
  userId: string
  accountName: string
  accountEmail: string
  title: string
  tokens: number | null
  capital: number
  currency: string
  monthlyRoi: number
  activatedAt: string
  status: TradingFundPositionStatus
  pausedAt: string | null
  closedAt: string | null
  pauseWindows: TradingFundPauseWindow[]
  terminationRequestedAt: string | null
  terminationReason: string | null
}

/** Every authorized Treuhand position across all accounts, for the admin panel. */
export async function adminListTradingFundPositions(
  passcode: string,
): Promise<{ ok: true; positions: AdminTradingFundPosition[] } | { ok: false; error: string }> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const reqs = await listAllApprovals({ kind: "trading_fund", status: "approved" })
    const positions: AdminTradingFundPosition[] = []
    for (const req of reqs) {
      const payload = (req.payload ?? {}) as {
        capital?: number
        tokens?: number
        pauseWindows?: TradingFundPauseWindow[]
        closedAt?: string
        exitedAt?: string
        terminationRequestedAt?: string
        terminationReason?: string
      }
      const capital = Number(req.amount ?? payload.capital)
      if (!Number.isFinite(capital) || capital <= 0) continue
      const profile = await resolveAccountProfileById(req.userId)
      const status = tradingFundStatus(payload)
      const windows = Array.isArray(payload.pauseWindows) ? payload.pauseWindows : []
      const openPause = windows.find((w) => w && w.from && !w.to)
      positions.push({
        id: req.id,
        userId: req.userId,
        accountName: profile.fullName,
        accountEmail: profile.email,
        title: req.title,
        tokens: Number.isFinite(Number(payload.tokens)) ? Number(payload.tokens) : null,
        capital,
        currency: req.currency || "EUR",
        monthlyRoi: Math.round(capital * TRADING_FUND_MONTHLY_ROI * 100) / 100,
        activatedAt: req.decidedAt || req.createdAt,
        status,
        pausedAt: openPause?.from ?? null,
        closedAt: payload.closedAt ?? payload.exitedAt ?? null,
        pauseWindows: windows,
        terminationRequestedAt: payload.terminationRequestedAt ?? null,
        terminationReason: payload.terminationReason ?? null,
      })
    }
    return { ok: true, positions }
  } catch (err) {
    console.log("[v0] adminListTradingFundPositions failed:", (err as Error).message)
    return { ok: false, error: "Positions could not be loaded. Please try again." }
  }
}

export async function adminDecideApproval(
  passcode: string,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, error: "A reason is required to reject a request." }
  }

  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Request not found." }
    if (existing.status !== "pending" && existing.status !== "awaiting_master") {
      return { ok: false, error: "This request has already been decided." }
    }

    // HARD fund-availability gate. Before committing an APPROVAL that reserves
    // funds, verify the balance owner can actually cover it in the deal currency
    // (including capped cross-currency FX). If it cannot, AUTO-REJECT the
    // request, notify the client, log the reason, and tell the admin — money is
    // never moved and no negative balance can be created.
    if (decision === "approved") {
      const assessment = await assessReservation(existing)
      if (assessment.required && !assessment.feasible) {
        const reason = assessment.message
        const rejected = await recordAdminDecision(id, "rejected", "Administrator (auto)", reason)
        const finalReq = rejected ?? existing
        try {
          await insertNotification({
            userId: finalReq.userId,
            tone: "warning",
            title: `${KIND_LABELS[finalReq.kind]} declined — insufficient funds`,
            body: `Your ${KIND_LABELS[finalReq.kind].toLowerCase()} "${finalReq.title}" was automatically declined: the account lacks sufficient available balance to reserve the required funds. ${reason}`,
            href: KIND_HREF[finalReq.kind] ?? null,
          })
        } catch (err) {
          console.log("[v0] insufficient-funds notification failed:", (err as Error).message)
        }
        try {
          const target = await resolveAccountProfileById(finalReq.userId)
          await logActivity({
            action: `Auto-declined a ${KIND_LABELS[finalReq.kind]} request for ${target.fullName} — insufficient funds`,
            category: "Administration / Approvals",
            user: "Administrator",
            details: {
              referenceId: finalReq.id,
              targetAccount: `${target.fullName} — ${target.email}`,
              summary: finalReq.summary || finalReq.title,
              amount: finalReq.amount != null ? formatMoney(finalReq.amount, finalReq.currency ?? "") : "(n/a)",
              decision: "rejected (insufficient funds)",
              reason,
            },
          })
        } catch (err) {
          console.log("[v0] insufficient-funds audit log failed:", (err as Error).message)
        }
        return { ok: false, error: reason }
      }
    }

    // Record the administrator's verdict (first gate). For a Sub-account
    // payment this lands the request on "awaiting_master" rather than
    // "approved" until the Master also consents.
    let updated = await recordAdminDecision(id, decision, "Administrator", note)
    if (!updated) return { ok: false, error: "This request has already been decided." }

    // Money only moves once ALL required gates clear (final status approved).
    if (updated.status === "approved") {
      // A PAYMENT that reaches approved is "approved & initiated" — funds have
      // left the account. Stamp `deliveryInitiatedAt` so it enters the stage-3
      // delivery lifecycle. Only payments carrying this marker are counted as
      // "awaiting delivery" on the command center, so the historical backlog of
      // older approved payments (which predate the delivery feature and will
      // never be marked delivered) is excluded from the admin's action count.
      if (updated.kind === "payment") {
        try {
          const p = (updated.payload ?? {}) as Record<string, unknown>
          if (!p.deliveryInitiatedAt) {
            const persisted = await updateApprovalPayload(updated.id, {
              ...p,
              deliveryInitiatedAt: updated.decidedAt ?? new Date().toISOString(),
            })
            if (persisted) updated = persisted
          }
        } catch (err) {
          console.log("[v0] payment delivery-initiated stamp failed:", (err as Error).message)
        }
      }

      // A leverage line must be marked ACTIVE on approval: stamp activatedAt
      // (interest accrual start) and the borrowed-funds credit entry id into the
      // record, so the line shows live and accrues interest regardless of which
      // admin surface approved it. Done before applyLedgerEffect so the stored
      // creditEntryId matches the entry that is about to be posted.
      if (updated.kind === "leverage") {
        try {
          const rec = (updated.payload?.record ?? {}) as Record<string, unknown>
          if (!rec.activatedAt) {
            const activatedAt = updated.decidedAt ?? new Date().toISOString()
            const newPayload = {
              ...(updated.payload ?? {}),
              record: {
                ...rec,
                status: "approved",
                decidedAt: activatedAt,
                activatedAt,
                creditEntryId: `APPR-${updated.id}`,
              },
            }
            const persisted = await updateApprovalPayload(updated.id, newPayload)
            if (persisted) updated = persisted
          }
        } catch (err) {
          console.log("[v0] leverage activation stamp failed:", (err as Error).message)
        }

        // CHARGE SETTLEMENT — approve: at submit the audit fee and PPI were
        // reserved as HOLDS (`LEV-AUDIT-<id>` / `LEV-PPI-<id>`). Now that an
        // administrator has reviewed and APPROVED the line, settle BOTH to real
        // completed charges (the PPI at the admin-negotiated amount if one was
        // set, else the original). Upserting the same ids flips them hold→
        // completed in place. Idempotent on retry.
        try {
          const lrec = (updated.payload?.record ?? {}) as Record<string, unknown>
          const equity = Number(lrec.equity)
          const ratio = Number(lrec.leverageRatio)
          const feeCurrency = String(lrec.currency || updated.currency || BASE_CURRENCY)
          const charges = leverageApplicationCharges(equity, ratio, readStampedTrustScore(lrec))
          const negotiated = Number(lrec.negotiatedPpi)
          const finalPpi = Number.isFinite(negotiated) && negotiated >= 0 ? negotiated : charges.ppi
          const ownerId = await resolveDataOwnerIdFor(updated.userId)
          const fmtPpi = (n: number) =>
            `${feeCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          if (charges.auditFee > 0) {
            await upsertLedgerEntry(ownerId, {
              id: `LEV-AUDIT-${updated.id}`,
              direction: "debit",
              amount: charges.auditFee,
              currency: feeCurrency,
              status: "completed",
              date: new Date().toISOString(),
              counterparty: "MCC Capital — Leverage Audit & Compliance",
              bank: "MCC Capital",
              reference: updated.id,
              comment: `Non-refundable audit, compliance & Treasury-partner verification fee (${fmtPpi(charges.auditFee)}) for leverage application ${updated.id}. Charged on administrator approval.`,
              category: "Leverage Audit Fee",
            })
          }
          if (finalPpi > 0) {
            await upsertLedgerEntry(ownerId, {
              id: `LEV-PPI-${updated.id}`,
              direction: "debit",
              amount: finalPpi,
              currency: feeCurrency,
              status: "completed",
              date: new Date().toISOString(),
              counterparty: "MCC Capital — Payment Protection Insurance",
              bank: "MCC Capital",
              reference: updated.id,
              comment: `PPI insurance premium (${fmtPpi(finalPpi)}) charged on approval of leverage line ${updated.id}${
                Number.isFinite(negotiated) ? " (administrator-reduced cost)" : ""
              }.`,
              category: "Leverage PPI Insurance",
            })
          } else {
            // A negotiated-to-zero PPI: release any residual hold.
            await deleteLedgerEntry(ownerId, `LEV-PPI-${updated.id}`).catch(() => {})
          }
          // Release any legacy appeal-specific holds from earlier builds.
          await deleteLedgerEntry(ownerId, `LEV-PPI-APPEAL-${updated.id}`).catch(() => {})
          await deleteLedgerEntry(ownerId, `LEV-AUDIT-APPEAL-${updated.id}`).catch(() => {})
          if (lrec.ppiAppeal === true && !lrec.appealResolvedAt) {
            const resolved = await updateApprovalPayload(updated.id, {
              ...(updated.payload ?? {}),
              record: { ...lrec, appealResolvedAt: new Date().toISOString(), appealDecision: "approved", appealPpiFinal: finalPpi },
            })
            if (resolved) updated = resolved
          }
          try {
            await insertNotification({
              userId: ownerId,
              tone: "success",
              title: "Leverage line approved",
              body: `Your leverage application (${updated.id}) was approved. The reserved charges are now settled — ${fmtPpi(
                charges.auditFee,
              )} audit & compliance + ${fmtPpi(finalPpi)} PPI${
                Number.isFinite(negotiated) ? " (administrator-reduced)" : ""
              } debited to your Master Account.`,
              href: "/dashboard/leverage",
            })
          } catch {
            // notification is non-critical
          }
        } catch (err) {
          console.log("[v0] leverage charge settlement on approve failed:", (err as Error).message)
        }
      }
      try {
        await applyLedgerEffect(updated)
      } catch (err) {
        console.log("[v0] applyLedgerEffect failed:", (err as Error).message)
      }

      // If this approved outgoing payment is addressed to a Collect-funds
      // gateway IBAN, record it as a received deposit on that account and credit
      // the gateway owner's Master Account. Idempotent and self-validating.
      if (updated.kind === "payment") {
        let matchedGateway = false
        try {
          const res = await recordGatewayDepositForApproval(updated.id)
          matchedGateway = res.matched
        } catch (err) {
          console.log("[v0] gateway IBAN auto-match failed:", (err as Error).message)
        }
        // Otherwise, if the beneficiary IBAN matches a client's registered
        // external bank account, auto-credit that owner's Master Account (and
        // the per-bank sub-balance). Only when no gateway matched, so a given
        // IBAN can never be credited twice. Idempotent on `RAD-<id>`.
        let matchedRegistered = false
        if (!matchedGateway) {
          try {
            const res = await recordRegisteredAccountDepositForApproval(updated.id)
            matchedRegistered = res.matched
          } catch (err) {
            console.log("[v0] registered-account IBAN auto-match failed:", (err as Error).message)
          }
        }
        // Finally, if the beneficiary IBAN is a platform customer's OWN master-
        // account banking (primary or any per-currency IBAN), credit that
        // customer's Master Account in the payment currency. Runs only when no
        // gateway or registered-account match, so an IBAN is never credited
        // twice. Idempotent on `MBD-<id>`.
        if (!matchedGateway && !matchedRegistered) {
          try {
            await recordMasterBankingDepositForApproval(updated.id)
          } catch (err) {
            console.log("[v0] master-banking IBAN auto-match failed:", (err as Error).message)
          }
        }
      }

      // An approved RECALL fully unwinds the original payment. applyLedgerEffect
      // above already credited the sender's refund (the recall's ledgerEffect);
      // here we (a) reverse any recipient gateway credit and (b) stamp the
      // original payment as recalled so the idempotent backfill never re-funds
      // it. All monetary effects are keyed deterministically, so this is safe to
      // re-run.
      if (updated.kind === "payment_recall") {
        const originalApprovalId = (updated.payload as { originalApprovalId?: string })?.originalApprovalId
        if (originalApprovalId) {
          try {
            await reverseGatewayDepositForApproval(originalApprovalId)
          } catch (err) {
            console.log("[v0] recall recipient reversal failed:", (err as Error).message)
          }
          try {
            await reverseRegisteredAccountDepositForApproval(originalApprovalId)
          } catch (err) {
            console.log("[v0] recall registered-account reversal failed:", (err as Error).message)
          }
          try {
            await reverseMasterBankingDepositForApproval(originalApprovalId)
          } catch (err) {
            console.log("[v0] recall master-banking reversal failed:", (err as Error).message)
          }
          try {
            const original = await getApprovalById(originalApprovalId)
            if (original) {
              const op = (original.payload ?? {}) as Record<string, unknown>
              const orec = (op.record ?? {}) as Record<string, unknown>
              await updateApprovalPayload(originalApprovalId, {
                ...op,
                recalled: true,
                recallStatus: "recalled",
                record: { ...orec, recallStatus: "recalled" },
              })
            }
          } catch (err) {
            console.log("[v0] original recall stamp failed:", (err as Error).message)
          }
        }
      }

      // An approved AMENDMENT renegotiates the original deal. Update the deal's
      // value, currency and reservation effect, then re-run its ledger effect so
      // the reserved hold (`APPR-<dealId>`) auto-adjusts to the new amount
      // (auto-FX funds any increase). The amendment is moved into the deal's
      // history and the pending flag cleared. The amendment approval itself
      // carries no ledger effect, so applyLedgerEffect(updated) above was a no-op.
      if (updated.kind === "commodity_amendment") {
        try {
          await applyApprovedAmendment(updated)
        } catch (err) {
          console.log("[v0] apply amendment failed:", (err as Error).message)
        }
      }
    }

    // A REJECTED amendment leaves the deal untouched: just clear the pending flag
    // and file the rejected amendment in the deal's history for the audit trail.
    if (updated.kind === "commodity_amendment" && decision === "rejected") {
      try {
        await clearRejectedAmendment(updated, note?.trim())
      } catch (err) {
        console.log("[v0] clear rejected amendment failed:", (err as Error).message)
      }
    }

    // A REJECTED leverage line COSTS THE CLIENT NOTHING. At submit the audit &
    // compliance fee and the PPI premium were only RESERVED as reversible holds
    // (never charged); on rejection BOTH are RELEASED IN FULL. If a past build
    // had already settled the audit fee into a completed debit, deleting the same
    // deterministic id (`LEV-AUDIT-<id>`) here REFUNDS it. Any legacy offsetting
    // PPI refund credit (`LEV-PPI-REFUND-<id>`) is also removed so releasing the
    // PPI debit can't net to a double refund. The reconciler mirrors this so an
    // already-rejected line self-heals on the next ledger read, cross-device.
    if (updated.kind === "leverage" && decision === "rejected") {
      try {
        const lp = (updated.payload ?? {}) as Record<string, unknown>
        const lrec = (lp.record ?? {}) as Record<string, unknown>
        const ownerId = await resolveDataOwnerIdFor(updated.userId)
        // Release / refund every leverage charge tied to this application.
        await deleteLedgerEntry(ownerId, `LEV-AUDIT-${updated.id}`).catch(() => {})
        await deleteLedgerEntry(ownerId, `LEV-PPI-${updated.id}`).catch(() => {})
        await deleteLedgerEntry(ownerId, `LEV-AUDIT-APPEAL-${updated.id}`).catch(() => {})
        await deleteLedgerEntry(ownerId, `LEV-PPI-APPEAL-${updated.id}`).catch(() => {})
        await deleteLedgerEntry(ownerId, `LEV-PPI-REFUND-${updated.id}`).catch(() => {})
        await deleteLedgerEntry(ownerId, `LEV-PPI-ADJUST-${updated.id}`).catch(() => {})
        if (lrec.ppiAppeal === true && !lrec.appealResolvedAt) {
          const resolved = await updateApprovalPayload(updated.id, {
            ...lp,
            record: { ...lrec, appealResolvedAt: new Date().toISOString(), appealDecision: "rejected", appealPpiFinal: 0 },
          })
          if (resolved) updated = resolved
        }
        try {
          await insertNotification({
            userId: ownerId,
            tone: "warning",
            title: "Leverage application declined",
            body: `Your leverage application (${updated.id}) was declined. No charge applies — all reserved audit, compliance and PPI amounts have been released in full and your balance restored.`,
            href: "/dashboard/leverage",
          })
        } catch {
          // notification is non-critical
        }
      } catch (err) {
        console.log("[v0] leverage charge release on reject failed:", (err as Error).message)
      }
    }

    // Notify the owning client.
    const label = KIND_LABELS[updated.kind]
    const awaitingMaster = updated.status === "awaiting_master"
    try {
      await insertNotification({
        userId: updated.userId,
        tone: decision === "approved" ? (awaitingMaster ? "info" : "success") : "warning",
        title:
          decision === "approved"
            ? awaitingMaster
              ? `${label} awaiting Master approval`
              : updated.kind === "payment"
                ? "Payment approved & initiated"
                : `${label} approved`
            : `${label} declined`,
        body:
          decision === "approved"
            ? awaitingMaster
              ? `Your ${label.toLowerCase()} request "${updated.title}" was approved by the administrator and now awaits your Master account's consent.`
              : updated.kind === "payment"
                ? `Your payment "${updated.title}" has been approved and initiated — the funds have left your account and are on their way to the beneficiary. You'll be notified once delivery is confirmed.`
                : `Your ${label.toLowerCase()} request "${updated.title}" was approved.`
            : `Your ${label.toLowerCase()} request "${updated.title}" was declined. Reason: ${note?.trim()}`,
        href: KIND_HREF[updated.kind] ?? null,
      })
    } catch (err) {
      console.log("[v0] approval notification failed:", (err as Error).message)
    }

    // When the admin gate clears but a Master gate remains, nudge the Master.
    if (awaitingMaster && updated.masterId) {
      try {
        await insertNotification({
          userId: updated.masterId,
          tone: "warning",
          title: "Sub-account payment awaiting your approval",
          body: `${updated.initiatedByName ?? "A sub-account"}'s ${label.toLowerCase()} "${updated.title}" was approved by the administrator and needs your consent to execute.`,
          href: "/dashboard/network",
        })
      } catch (err) {
        console.log("[v0] master nudge notification failed:", (err as Error).message)
      }
    }

    // Audit trail.
    const target = await resolveAccountProfileById(updated.userId)
    await logActivity({
      action: `Administrator ${decision} a ${label} request for ${target.fullName}`,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: updated.id,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: updated.summary || updated.title,
        amount: updated.amount != null ? `${updated.currency ?? ""} ${updated.amount.toLocaleString("en-US")}` : "(n/a)",
        decision,
        reason: note?.trim() || "(none)",
      },
    })

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminDecideApproval failed:", (err as Error).message)
    return { ok: false, error: "The decision could not be recorded. Please try again." }
  }
}

interface AmendmentTerms {
  approxValue: number
  quantity: string
  tradeStructure: string
  unitPrice?: number
}

/**
 * Apply an APPROVED amendment to its parent deal: update the deal's stored value,
 * quantity and incoterms, rebuild its reservation effect at the new value, and
 * re-run the ledger effect so the reserved hold (`APPR-<dealId>`) auto-adjusts
 * (auto-FX funds any increase). The amendment is moved into the deal's
 * `amendmentHistory` and the `pendingAmendment` flag is cleared.
 */
async function applyApprovedAmendment(amendment: ApprovalRequest): Promise<void> {
  const ap = (amendment.payload ?? {}) as {
    dealApprovalId?: string
    proposed?: AmendmentTerms
    previous?: AmendmentTerms
    reason?: string
  }
  const dealApprovalId = ap.dealApprovalId
  const proposed = ap.proposed
  if (!dealApprovalId || !proposed) return

  const deal = await getApprovalById(dealApprovalId)
  if (!deal) return
  const payload = (deal.payload ?? {}) as { record?: Record<string, unknown>; [k: string]: unknown }
  const record = (payload.record ?? {}) as Record<string, unknown>

  // Defense-in-depth: the authoritative total is unit price × quantity. If a
  // unit price travelled with the amendment, recompute from it so the deal can
  // never inherit a stale client's raw per-unit price as its total value.
  const applyQty = parseQuantityString(proposed.quantity)
  const applyUnit = Number(proposed.unitPrice)
  const newValue =
    Number.isFinite(applyUnit) && applyUnit > 0 && applyQty
      ? Math.round(applyUnit * applyQty.amount * 100) / 100
      : Math.round(Number(proposed.approxValue) * 100) / 100
  const currency = deal.currency ?? (record.currency as string) ?? "USD"
  const sellerName = (record.sellerName as string) || "Commodity supplier"
  const uetr = (record.uetr as string) || (record.id as string) || deal.id

  // Move the (now decided) amendment from pending → history on the deal record.
  const pending = (record.pendingAmendment ?? {}) as Record<string, unknown>
  const decidedAmendment = {
    ...pending,
    status: "approved" as const,
    decidedAt: amendment.decidedAt ?? new Date().toISOString(),
  }
  const history = Array.isArray(record.amendmentHistory)
    ? (record.amendmentHistory as Record<string, unknown>[])
    : []

  const newUnitPrice =
    Number.isFinite(applyUnit) && applyUnit > 0
      ? Math.round(applyUnit * 100) / 100
      : applyQty && newValue > 0
        ? Math.round((newValue / applyQty.amount) * 100) / 100
        : (record.unitPrice as number | undefined)

  const newRecord = {
    ...record,
    approxValue: newValue,
    unitPrice: newUnitPrice,
    quantity: proposed.quantity,
    tradeStructure: proposed.tradeStructure,
    pendingAmendment: undefined,
    amendmentHistory: [decidedAmendment, ...history],
  }

  // Rebuild the deal's reservation effect at the amended value, then re-run it so
  // the hold tracks the new amount. Idempotent on `APPR-<dealId>`.
  const ledgerEffect: LedgerEffect = {
    direction: "debit",
    amount: newValue,
    currency,
    status: "hold",
    counterparty: sellerName,
    reference: uetr,
    category: "Commodity Trade — Reserved Funds",
  }

  const updatedDeal = await updateApprovalTerms(dealApprovalId, {
    amount: newValue,
    currency,
    ledgerEffect,
    payload: { ...payload, record: newRecord },
  })

  if (updatedDeal) {
    try {
      await applyLedgerEffect(updatedDeal)
    } catch (err) {
      console.log("[v0] amendment hold adjust failed:", (err as Error).message)
    }
  }

  try {
    const target = await resolveAccountProfileById(deal.userId)
    await logActivity({
      action: `Administrator approved an amendment to deal ${dealApprovalId}`,
      category: "Administration / Approvals",
      user: "Administrator",
      details: {
        referenceId: amendment.id,
        dealId: dealApprovalId,
        targetAccount: `${target.fullName} — ${target.email}`,
        summary: `Deal amended: value → ${currency} ${newValue.toLocaleString("en-US")}, quantity → ${proposed.quantity}, terms → ${proposed.tradeStructure}. Reserved funds adjusted to match. Reason: ${ap.reason ?? "(none)"}.`,
        decision: "approved",
      },
    })
  } catch (err) {
    console.log("[v0] amendment approval log failed:", (err as Error).message)
  }
}

/**
 * Clear a REJECTED amendment: the deal's terms are untouched, the
 * `pendingAmendment` flag is removed, and the rejected amendment is recorded in
 * the deal's `amendmentHistory` for the audit trail.
 */
async function clearRejectedAmendment(amendment: ApprovalRequest, note?: string): Promise<void> {
  const ap = (amendment.payload ?? {}) as { dealApprovalId?: string }
  const dealApprovalId = ap.dealApprovalId
  if (!dealApprovalId) return

  const deal = await getApprovalById(dealApprovalId)
  if (!deal) return
  const payload = (deal.payload ?? {}) as { record?: Record<string, unknown>; [k: string]: unknown }
  const record = (payload.record ?? {}) as Record<string, unknown>

  const pending = (record.pendingAmendment ?? {}) as Record<string, unknown>
  const decidedAmendment = {
    ...pending,
    status: "rejected" as const,
    decidedAt: amendment.decidedAt ?? new Date().toISOString(),
    decisionNote: note,
  }
  const history = Array.isArray(record.amendmentHistory)
    ? (record.amendmentHistory as Record<string, unknown>[])
    : []

  await updateApprovalPayload(dealApprovalId, {
    ...payload,
    record: { ...record, pendingAmendment: undefined, amendmentHistory: [decidedAmendment, ...history] },
  })
}

/**
 * Administrator flags an approved commodity deal as DELIVERED. This locks the
 * deal: the client can no longer revoke it (the revoke DB guard refuses any deal
 * whose payload is flagged delivered). The delivered state is stored on the
 * approval's payload so it is visible to the client cross-device.
 */
export async function adminMarkCommodityDelivered(
  passcode: string,
  id: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Deal not found." }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be marked delivered." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be marked delivered." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: true, request: existing }
    }

    const updated = await markApprovalDelivered(id)
    if (!updated) return { ok: false, error: "This deal can no longer be marked delivered." }

    // SETTLE the reserved funds: on delivery the blocked amount is paid out to
    // the supplier, so it must permanently LEAVE the client's balance — not stay
    // held nor return to available. The reservation lives as a `hold` debit under
    // entry id `APPR-<id>`; converting it to a `completed` debit (same id, upsert)
    // makes it reduce the settled balance too, so the amount disappears from the
    // client's balances entirely.
    try {
      const ownerId = await resolveDataOwnerIdFor(updated.userId)
      const entries = await readLedgerEntries(ownerId)
      const hold = entries.find((e) => e.id === `APPR-${id}` && e.status === "hold")
      if (hold) {
        await upsertLedgerEntry(ownerId, {
          ...hold,
          status: "completed",
          date: new Date().toISOString(),
          category: "Commodity Trade — Settled (Delivered)",
          comment: `Delivered & settled — funds paid out for ${KIND_LABELS[updated.kind]} "${updated.title}"`,
        })
      }
    } catch (err) {
      console.log("[v0] delivered settlement failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Commodity deal delivered",
        body: `Your commodity deal "${updated.title}" has been confirmed delivered by MCC Capital. The reserved funds have been paid out for settlement. The deal is now finalized and can no longer be revoked.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] delivered notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(updated.userId)
      await logActivity({
        action: `Administrator flagged commodity deal "${updated.title}" as delivered for ${target.fullName}`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: updated.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: updated.summary || updated.title,
          decision: "Delivered",
        },
      })
    } catch (err) {
      console.log("[v0] delivered activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminMarkCommodityDelivered failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be marked delivered. Please try again." }
  }
}

/**
 * Administrator confirms an approved outgoing PAYMENT (bank wire) has reached the
 * beneficiary account — the third and final stage of the payment lifecycle
 * ("Payment Completed — Funds Delivered"). The funds already left the sender's
 * balance when the payment was approved and initiated (stage 2), so this is a
 * DELIVERY CONFIRMATION only and performs NO further ledger movement.
 *
 * It stamps the delivery flag both at the payload top level (`delivered` /
 * `deliveredAt`, via `markApprovalDelivered`) and inside `payload.record` so the
 * client's payment store view-model — rebuilt from `payload.record` — reflects
 * the delivered state on its next poll. The transition is notified to the client
 * and written to the audit log with a timestamp and the responsible party.
 */
export async function adminMarkPaymentDelivered(
  passcode: string,
  id: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Payment not found." }
    if (existing.kind !== "payment") {
      return { ok: false, error: "Only outgoing payments can be marked delivered." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved & initiated payment can be marked delivered." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: true, request: existing }
    }

    // Stage the delivery flag at the payload top level (delivered / deliveredAt).
    const updated = await markApprovalDelivered(id)
    if (!updated) return { ok: false, error: "This payment can no longer be marked delivered." }

    // Mirror the confirmation into `payload.record` so the client payment store
    // (which rebuilds its view-model from payload.record) shows stage 3, and
    // record the responsible party for the audit trail. No funds move here — the
    // debit posted at approval — so there is no ledger effect.
    const deliveredAt = (updated.payload?.deliveredAt as string) ?? new Date().toISOString()
    try {
      const payload = (updated.payload ?? {}) as Record<string, unknown>
      const record = (payload.record ?? {}) as Record<string, unknown>
      const persisted = await updateApprovalPayload(updated.id, {
        ...payload,
        deliveredBy: "Administrator",
        record: {
          ...record,
          deliveryStatus: "delivered",
          deliveredAt,
          deliveredBy: "Administrator",
        },
      })
      if (persisted) Object.assign(updated, persisted)
    } catch (err) {
      console.log("[v0] payment delivery record stamp failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Payment delivered to beneficiary",
        body: `Your payment "${updated.title}" has been confirmed delivered — the funds have reached the beneficiary account. This payment is now complete.`,
        href: KIND_HREF.payment ?? "/dashboard/payments",
      })
    } catch (err) {
      console.log("[v0] payment delivered notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(updated.userId)
      await logActivity({
        action: `Administrator confirmed payment "${updated.title}" delivered to beneficiary for ${target.fullName}`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: updated.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: updated.summary || updated.title,
          amount: updated.amount != null ? formatMoney(updated.amount, updated.currency ?? "") : "(n/a)",
          decision: "Completed — Funds Delivered",
          deliveredAt,
        },
      })
    } catch (err) {
      console.log("[v0] payment delivered activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminMarkPaymentDelivered failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be marked delivered. Please try again." }
  }
}

/**
 * Administrator UNDOES a delivery confirmation — "the funds were NOT received".
 * Reverts an outgoing payment from stage 3 ("Completed — Funds Delivered") back
 * to stage 2 ("Approved & Initiated") so the admin can intervene: chase the
 * wire, re-confirm once it truly lands, or process a recall. No funds move — the
 * debit posted at approval and the delivery flag is only a status marker. The
 * `deliveryInitiatedAt` stamp is preserved so the payment re-enters the
 * awaiting-delivery queue and the "Mark funds delivered" action is available
 * again.
 */
export async function adminMarkPaymentNotDelivered(
  passcode: string,
  id: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Payment not found." }
    if (existing.kind !== "payment") {
      return { ok: false, error: "Only outgoing payments can be updated." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved payment can be reverted." }
    }
    if (existing.payload?.delivered !== true) {
      // Already not delivered — nothing to undo.
      return { ok: true, request: existing }
    }

    const payload = (existing.payload ?? {}) as Record<string, unknown>
    // Drop the top-level delivery flags. `updateApprovalPayload` replaces the
    // whole payload, so omitting these keys clears them.
    const { delivered: _d, deliveredAt: _da, deliveredBy: _db, ...rest } = payload
    const record = { ...((payload.record ?? {}) as Record<string, unknown>) }
    record.deliveryStatus = "initiated"
    delete record.deliveredAt
    delete record.deliveredBy

    const updated = await updateApprovalPayload(id, { ...rest, record })
    if (!updated) return { ok: false, error: "This payment could not be reverted." }

    try {
      await insertNotification({
        userId: updated.userId,
        tone: "warning",
        title: "Payment delivery reverted",
        body: `Your payment "${updated.title}" was marked as NOT yet received by the beneficiary. It is back to "Approved & Initiated" while the administrator resolves the delivery.`,
        href: KIND_HREF.payment ?? "/dashboard/payments",
      })
    } catch (err) {
      console.log("[v0] payment not-delivered notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(updated.userId)
      await logActivity({
        action: `Administrator reverted delivery on payment "${updated.title}" (funds NOT received) for ${target.fullName}`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: updated.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: updated.summary || updated.title,
          amount: updated.amount != null ? formatMoney(updated.amount, updated.currency ?? "") : "(n/a)",
          decision: "Reverted to Approved & Initiated — funds not received",
        },
      })
    } catch (err) {
      console.log("[v0] payment not-delivered activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminMarkPaymentNotDelivered failed:", (err as Error).message)
    return { ok: false, error: "The payment could not be reverted. Please try again." }
  }
}

/**
 * Administrator REVOKES an approved commodity deal (before delivery) and REFUNDS
 * the reserved funds. Refuses a delivered deal (it is finalized). Releases only
 * the reservation hold (`APPR-<id>`), unfreezing the blocked money back to the
 * owner's available balance; any FX conversion legs executed to fund the deal
 * are intentionally left in place, mirroring the client-revoke policy.
 */
export async function adminRevokeCommodityDeal(
  passcode: string,
  id: string,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Deal not found." }
    if (existing.kind !== "commodity") {
      return { ok: false, error: "Only commodity deals can be revoked here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an approved deal can be revoked." }
    }
    if (existing.payload?.delivered === true) {
      return { ok: false, error: "This deal has been delivered and can no longer be revoked." }
    }

    const revoked = await adminRevokeApprovedApproval(id, note)
    if (!revoked) return { ok: false, error: "This deal can no longer be revoked." }

    // Release the reservation hold → unfreeze the blocked funds for the owner.
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${id}`)
    } catch (err) {
      console.log("[v0] admin hold release failed:", (err as Error).message)
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Commodity deal revoked",
        body: `Your commodity deal "${existing.title}" was revoked by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. The reserved funds have been released back to your available balance.`,
        href: KIND_HREF.commodity ?? "/dashboard/commodity",
      })
    } catch (err) {
      console.log("[v0] admin revoke notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator revoked commodity deal "${existing.title}" for ${target.fullName} and released reserved funds`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: existing.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Revoked",
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] admin revoke activity log failed:", (err as Error).message)
    }

    return { ok: true, request: revoked }
  } catch (err) {
    console.log("[v0] adminRevokeCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be revoked. Please try again." }
  }
}

/**
 * Administrator NEGOTIATES the PPI insurance premium on a leverage application.
 *
 * At application the client was charged PPI = 0.75% of buying power. The admin
 * can agree a LOWER premium as a special arrangement: the EXCEEDED amount
 * (original − negotiated) is immediately refunded to the client's Master
 * Account, so only the agreed premium stays charged and matures. The refund is
 * a single upsert row (`LEV-PPI-ADJUST-<id>`), so re-negotiating simply updates
 * the refund to the new difference (never stacks). The client is notified of
 * the special treatment. The negotiated value is persisted on the record so the
 * reject-refund path knows the effective (net) premium to return.
 */
export async function adminAdjustLeveragePpi(
  passcode: string,
  id: string,
  newPpi: number,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Leverage application not found." }
    if (existing.kind !== "leverage") {
      return { ok: false, error: "PPI can only be negotiated on a leverage application." }
    }

    const payload = (existing.payload ?? {}) as Record<string, unknown>
    const record = (payload.record ?? {}) as Record<string, unknown>
    const equity = Number(record.equity)
    const ratio = Number(record.leverageRatio)
    const feeCurrency = String(record.currency || existing.currency || BASE_CURRENCY)
    const originalPpi = leverageApplicationCharges(equity, ratio, readStampedTrustScore(record)).ppi
    if (!(originalPpi > 0)) {
      return { ok: false, error: "This application has no PPI premium to negotiate." }
    }

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const negotiated = round2(Number(newPpi))
    if (!Number.isFinite(negotiated) || negotiated < 0) {
      return { ok: false, error: "Enter a valid negotiated PPI amount." }
    }
    const fmt = (n: number) =>
      `${feeCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (negotiated > originalPpi + 0.01) {
      return { ok: false, error: `The negotiated PPI cannot exceed the ${fmt(originalPpi)} originally charged.` }
    }

    const refund = round2(originalPpi - negotiated)
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    // While the line is still PENDING the PPI is a reversible HOLD
    // (`LEV-PPI-<id>`), so we RESIZE the hold to the negotiated amount (releasing
    // the excess back to available immediately) — the final charge is posted when
    // the admin approves. Once the line is APPROVED the PPI is a completed charge,
    // so we post a refund credit instead. Idempotent: upsert overwrites in place.
    const stillHeld = existing.status !== "approved"

    if (stillHeld) {
      await upsertLedgerEntry(ownerId, {
        id: `LEV-PPI-${id}`,
        direction: "debit",
        amount: negotiated,
        currency: feeCurrency,
        status: "hold",
        date: new Date().toISOString(),
        counterparty: "MCC Capital — Payment Protection Insurance",
        bank: "MCC Capital",
        reference: id,
        comment: `Reserved (hold) – Pending Admin Review. PPI premium reduced from ${fmt(originalPpi)} to ${fmt(negotiated)} on leverage application ${id}; ${fmt(refund)} released back to available. Charged at the reduced amount on approval.${note?.trim() ? ` (${note.trim()})` : ""}`,
        category: "Leverage PPI Insurance",
      })
    } else {
      // Standard negotiation of an already-charged (approved) PPI: single refund
      // row — upsert overwrites on re-negotiation, so the net PPI charged always
      // equals the latest negotiated figure.
      await upsertLedgerEntry(ownerId, {
        id: `LEV-PPI-ADJUST-${id}`,
        direction: "credit",
        amount: refund,
        currency: feeCurrency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "MCC Capital — Payment Protection Insurance",
        bank: "MCC Capital",
        reference: id,
        comment: `Negotiated PPI adjustment for leverage application ${id}: premium reduced from ${fmt(originalPpi)} to ${fmt(negotiated)} — ${fmt(refund)} refunded to the Master Account.${note?.trim() ? ` (${note.trim()})` : ""}`,
        category: "Leverage PPI Adjustment",
      })
    }

    const updated = await updateApprovalPayload(id, {
      ...payload,
      record: {
        ...record,
        ppiOriginal: originalPpi,
        negotiatedPpi: negotiated,
        ppiRefund: refund,
        ppiNegotiatedAt: new Date().toISOString(),
      },
    })
    if (!updated) return { ok: false, error: "The leverage application could not be updated." }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "success",
        title: "Special treatment — PPI premium reduced",
        body: stillHeld
          ? `As a special arrangement, MCC Capital has reduced the PPI insurance premium on your leverage application (${id}) from ${fmt(originalPpi)} to ${fmt(negotiated)}. The reserved hold has been lowered accordingly (${fmt(refund)} released), and the agreed ${fmt(negotiated)} premium will be charged when the line is approved.`
          : `As a special arrangement, MCC Capital has renegotiated the PPI insurance premium on your leverage application (${id}) from ${fmt(originalPpi)} to ${fmt(negotiated)}. The ${fmt(refund)} difference has been refunded to your Master Account; only the agreed ${fmt(negotiated)} premium remains charged and matures.`,
        href: "/dashboard/leverage",
      })
    } catch (err) {
      console.log("[v0] leverage PPI adjust notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator negotiated the PPI premium on leverage application ${id} for ${target.fullName} (${fmt(originalPpi)} → ${fmt(negotiated)}, ${fmt(refund)} refunded)`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          originalPpi: fmt(originalPpi),
          negotiatedPpi: fmt(negotiated),
          refunded: fmt(refund),
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] leverage PPI adjust activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminAdjustLeveragePpi failed:", (err as Error).message)
    return { ok: false, error: "The PPI could not be adjusted. Please try again." }
  }
}

/**
 * Administrator NEGOTIATES the monetization reserve (blocked equity deposit +
 * PPI) on a monetization request.
 *
 * At submission the client BLOCKED a reserve = equity deposit + PPI, held on
 * their Master Account as `MON-RSV-<localId>` (a debit-hold, not a spend). The
 * admin can agree a LOWER reserve as a special arrangement: the EXCEEDED amount
 * (original − negotiated) is released back to available immediately, and only
 * the agreed reserve stays blocked as collateral. Because `upsertLedgerEntry`
 * overwrites the amount on conflict, we simply re-post the SAME hold id at the
 * negotiated amount — idempotent and cross-device. The negotiated value is
 * persisted on the record and the client is notified of the special treatment.
 */
export async function adminAdjustMonetizationReserve(
  passcode: string,
  id: string,
  newReserve: number,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Monetization request not found." }
    if (existing.kind !== "monetization") {
      return { ok: false, error: "The reserve can only be negotiated on a monetization request." }
    }

    const payload = (existing.payload ?? {}) as Record<string, unknown>
    const record = (payload.record ?? {}) as Record<string, unknown>
    const localId = String(record.id || "")
    if (!localId) return { ok: false, error: "This monetization request is missing its reserve reference." }

    // Reproduce the ORIGINAL reserve from the record: advance = grossProceeds,
    // LTV = advanceRatePercent (the exact inputs the client used to quote it).
    const advance = Number(record.grossProceeds)
    const ltv = Number(record.advanceRatePercent)
    const reserveCurrency = String(record.currency || existing.currency || BASE_CURRENCY)
    const originalReserve = computeMonetizationEquity(advance, ltv, readStampedTrustScore(record)).totalUpfront
    if (!(originalReserve > 0)) {
      return { ok: false, error: "This monetization request has no reserve to negotiate." }
    }

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const negotiated = round2(Number(newReserve))
    if (!Number.isFinite(negotiated) || negotiated < 0) {
      return { ok: false, error: "Enter a valid negotiated reserve amount." }
    }
    const fmt = (n: number) =>
      `${reserveCurrency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (negotiated > originalReserve + 0.01) {
      return { ok: false, error: `The negotiated reserve cannot exceed the ${fmt(originalReserve)} originally blocked.` }
    }

    const released = round2(originalReserve - negotiated)
    const ownerId = await resolveDataOwnerIdFor(existing.userId)

    // Preserve the original hold's display fields (title/reference/date) so the
    // client's Reserved-funds view keeps its identity; only the amount changes.
    let holdDate = new Date().toISOString()
    let holdCounterparty = `Monetization equity + PPI — ${localId}`
    let holdReference = localId
    try {
      const rows = await readLedgerEntries(ownerId)
      const current = rows.find((e) => e.id === `MON-RSV-${localId}`)
      if (current?.date) holdDate = current.date
      if (current?.counterparty) holdCounterparty = current.counterparty
      if (current?.reference) holdReference = current.reference
    } catch {
      // non-critical — keep the fallback display fields
    }

    // Shrink the hold in place — frees the excess back to available instantly.
    await upsertLedgerEntry(ownerId, {
      id: `MON-RSV-${localId}`,
      direction: "debit",
      amount: negotiated,
      currency: reserveCurrency,
      status: "hold",
      date: holdDate,
      counterparty: holdCounterparty,
      bank: "MCC Capital",
      reference: holdReference,
      comment: `Negotiated reserve for monetization ${localId}: blocked collateral reduced from ${fmt(originalReserve)} to ${fmt(negotiated)} — ${fmt(released)} released back to your available balance.${note?.trim() ? ` (${note.trim()})` : ""}`,
      category: "Monetization Reserve",
    })

    const updated = await updateApprovalPayload(id, {
      ...payload,
      record: {
        ...record,
        reserveOriginal: originalReserve,
        negotiatedReserve: negotiated,
        reserveReleased: released,
        reserveNegotiatedAt: new Date().toISOString(),
      },
    })
    if (!updated) return { ok: false, error: "The monetization request could not be updated." }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "success",
        title: "Special treatment — monetization reserve reduced",
        body: `As a special arrangement, MCC Capital has renegotiated the blocked reserve on your monetization (${localId}) from ${fmt(originalReserve)} to ${fmt(negotiated)}. The ${fmt(released)} difference has been released back to your available balance; only the agreed ${fmt(negotiated)} remains blocked as collateral.`,
        href: "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] monetization reserve adjust notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator negotiated the monetization reserve on ${localId} for ${target.fullName} (${fmt(originalReserve)} → ${fmt(negotiated)}, ${fmt(released)} released)`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          originalReserve: fmt(originalReserve),
          negotiatedReserve: fmt(negotiated),
          released: fmt(released),
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] monetization reserve adjust activity log failed:", (err as Error).message)
    }

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] adminAdjustMonetizationReserve failed:", (err as Error).message)
    return { ok: false, error: "The reserve could not be adjusted. Please try again." }
  }
}

/**
 * Administrator REVERSES an authorized (approved) monetization. This fully
 * unwinds the facility:
 *   1. Flips the DB approval to `cancelled` (via adminRevokeApprovedApproval), so
 *      the reconcile/backfill sweep — which only re-posts `approved` records —
 *      will never re-credit the proceeds again.
 *   2. Deletes the `APPR-<id>` proceeds credit from the balance owner's ledger,
 *      debiting the advanced funds back out. Per policy this is allowed to push
 *      the currency balance negative (the proceeds may already be spent).
 *   3. Stops all FUTURE monthly debit interest — the monetization interest
 *      reconciler only charges facilities whose status is `approved`, so a
 *      `cancelled` one is skipped. Interest ALREADY charged for elapsed months is
 *      intentionally left in place, mirroring the commodity-revoke policy.
 *   4. Releases the instrument pledge — the client's `isMonetized` gate frees a
 *      `reversed` request, so the underlying bank instrument becomes
 *      transferable / re-monetizable again.
 */
export async function adminReverseMonetization(
  passcode: string,
  id: string,
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Monetization not found." }
    if (existing.kind !== "monetization") {
      return { ok: false, error: "Only monetizations can be reversed here." }
    }
    if (existing.status !== "approved") {
      return { ok: false, error: "Only an authorized monetization can be reversed." }
    }

    const reversed = await adminRevokeApprovedApproval(id, note)
    if (!reversed) return { ok: false, error: "This monetization can no longer be reversed." }

    // Debit the advanced proceeds back out by removing the approval credit from
    // the shared-data owner's ledger (Master for a sub-account).
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    try {
      await deleteLedgerEntry(ownerId, `APPR-${id}`)
    } catch (err) {
      console.log("[v0] monetization proceeds reversal failed:", (err as Error).message)
    }

    const amountLabel =
      existing.amount != null ? formatMoney(existing.amount, existing.currency ?? "") : "the advanced proceeds"

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "warning",
        title: "Monetization reversed",
        body: `Your monetization "${existing.title}" was reversed by MCC Capital${note?.trim() ? ` — ${note.trim()}` : ""}. ${amountLabel} has been debited back from your Master Account and the underlying instrument has been released. Monthly debit interest has stopped; interest already charged remains.`,
        href: KIND_HREF.monetization ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] monetization reversal notification failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Administrator reversed monetization "${existing.title}" for ${target.fullName} and debited back the advanced proceeds`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: existing.id,
          targetAccount: `${target.fullName} — ${target.email}`,
          summary: existing.summary || existing.title,
          amount:
            existing.amount != null
              ? `${existing.currency ?? ""} ${existing.amount.toLocaleString("en-US")}`
              : "(n/a)",
          decision: "Reversed",
          reason: note?.trim() || "(none)",
        },
      })
    } catch (err) {
      console.log("[v0] monetization reversal activity log failed:", (err as Error).message)
    }

    return { ok: true, request: reversed }
  } catch (err) {
    console.log("[v0] adminReverseMonetization failed:", (err as Error).message)
    return { ok: false, error: "The monetization could not be reversed. Please try again." }
  }
}

// --- Admin: share a commodity deal (read-only) with other clients ----------

export interface ShareDealResult {
  ok: boolean
  error?: string
  sharedWith?: { name: string; email: string }[]
}

/**
 * Administrator SHARES an existing commodity deal with one or more other clients
 * for visibility only. Each recipient gets an independent, read-only COPY in
 * their own Commodity Transactions — born approved, marked `sharedReadOnly` so
 * `ledgerEntryForApproval` returns null and it NEVER touches their balance (no
 * hold, credit or settlement, ever, including on reconcile/backfill). The
 * original owner's deal is untouched apart from an append-only `sharedWith`
 * audit entry. Recipients cannot mutate the copy (guards below refuse it).
 */
export async function adminShareCommodityDeal(
  passcode: string,
  sourceId: string,
  recipientIds: string[],
): Promise<ShareDealResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const ids = Array.from(
    new Set((recipientIds ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)),
  )
  if (ids.length === 0) return { ok: false, error: "Select at least one recipient to share with." }

  try {
    const source = await getApprovalById(sourceId)
    if (!source) return { ok: false, error: "Deal not found." }
    if (source.kind !== "commodity") return { ok: false, error: "Only commodity deals can be shared." }

    const record = (source.payload?.record ?? {}) as Record<string, unknown>
    if (!record || typeof record !== "object" || !(record as { id?: unknown }).id) {
      return { ok: false, error: "This deal has no shareable detail record." }
    }

    const sourceOwnerId = await resolveDataOwnerIdFor(source.userId)
    const sharerName = "MCC Capital"
    const shared: { name: string; email: string }[] = []

    for (const rid of ids) {
      let recipientOwnerId: string
      try {
        recipientOwnerId = await resolveDataOwnerIdFor(rid)
      } catch {
        continue
      }
      // Never share a deal back onto its own owner.
      if (recipientOwnerId === sourceOwnerId) continue

      // Idempotency: skip if this recipient already holds a shared copy of this
      // exact source deal, so repeated shares never pile up duplicates.
      try {
        const existingForUser = await listApprovalsForUser(recipientOwnerId)
        const already = existingForUser.some(
          (a) =>
            a.kind === "commodity" &&
            (a.payload as { sourceApprovalId?: string } | undefined)?.sourceApprovalId === source.id,
        )
        if (already) continue
      } catch {
        // If the lookup fails, fall through and create the copy anyway.
      }

      const profile = await resolveAccountProfileById(recipientOwnerId)

      // Read-only snapshot of the deal record; the store detects these markers
      // and renders it non-interactive.
      const sharedRecord = { ...record, readOnly: true, shared: true, sharedFromName: sharerName }

      const created = await insertApproval({
        userId: recipientOwnerId,
        kind: "commodity",
        title: source.title,
        summary: `${source.summary || source.title} — shared with you by ${sharerName} for visibility (read-only).`,
        amount: source.amount,
        currency: source.currency,
        payload: {
          record: sharedRecord,
          sharedReadOnly: true,
          sharedFromUserId: source.userId,
          sharedFromName: sharerName,
          sourceApprovalId: source.id,
        },
      })
      await decideApproval(created.id, "approved", "Shared by administrator (read-only)")

      try {
        await insertNotification({
          userId: recipientOwnerId,
          tone: "info",
          title: "Commodity deal shared with you",
          body: `${sharerName} shared the commodity deal "${source.title}" with you for visibility. It appears in your Commodity Transactions as read-only.`,
          href: KIND_HREF.commodity ?? "/dashboard/commodity",
        })
      } catch (err) {
        console.log("[v0] share notification failed:", (err as Error).message)
      }

      shared.push({ name: profile.fullName || profile.email, email: profile.email })
    }

    if (shared.length === 0) {
      return { ok: false, error: "No new recipients received this deal (already shared or invalid)." }
    }

    // Append-only share audit on the source deal (owner-visible provenance).
    try {
      const prevShared = (source.payload?.sharedWith as unknown[] | undefined) ?? []
      const nowIso = new Date().toISOString()
      const additions = shared.map((s) => ({ name: s.name, email: s.email, at: nowIso }))
      await updateApprovalPayload(source.id, {
        ...(source.payload ?? {}),
        sharedWith: [...prevShared, ...additions],
      })
    } catch (err) {
      console.log("[v0] share source payload update failed:", (err as Error).message)
    }

    try {
      const target = await resolveAccountProfileById(source.userId)
      await logActivity({
        action: `Administrator shared commodity deal "${source.title}" with ${shared.length} recipient(s)`,
        category: "Administration / Approvals",
        user: "Administrator",
        details: {
          referenceId: source.id,
          owner: `${target.fullName} — ${target.email}`,
          recipients: shared.map((s) => `${s.name} — ${s.email}`).join("; "),
          effect: "Read-only visibility copy (no financial effect)",
          action: "Shared",
        },
      })
    } catch (err) {
      console.log("[v0] share activity log failed:", (err as Error).message)
    }

    return { ok: true, sharedWith: shared }
  } catch (err) {
    console.log("[v0] adminShareCommodityDeal failed:", (err as Error).message)
    return { ok: false, error: "The deal could not be shared. Please try again." }
  }
}

export interface SharedDealView {
  ok: boolean
  error?: string
  sharedApprovalId?: string
  sharedFromName?: string
  sharedAt?: string
  /** True when the owner's original deal can no longer be found: we fall back
   *  to the snapshot captured at share time. */
  sourceMissing?: boolean
  live?: {
    /** The deal record — LIVE from the owner's deal when available, so vessel
     *  stage, documents, SWIFT refs and settlement reflect the current state. */
    record: Record<string, unknown>
    status: string
    decidedAt?: string
    decisionNote?: string
    delivered: boolean
    deliveredAt?: string
    submittedAt?: string
  }
}

/**
 * Read a deal that an administrator shared (read-only) with the signed-in
 * client, resolving the LIVE state from the owner's original deal so the
 * recipient always sees the current documents, workflow/vessel stage, SWIFT
 * exchange and payment/settlement status — not a frozen copy.
 *
 * Security: the caller must own the shared copy (`shared.userId` maps to their
 * data owner) and it must actually be a `sharedReadOnly` commodity row. Only
 * then do we dereference `sourceApprovalId` to read the owner's live record.
 * Nothing here mutates state or touches any balance.
 */
export async function getSharedDealView(sharedApprovalId: string): Promise<SharedDealView> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "You must be signed in to view this deal." }

  try {
    const ownerId = await resolveDataOwnerIdFor(session.id)
    const shared = await getApprovalById(sharedApprovalId)
    if (!shared) return { ok: false, error: "This shared deal could not be found." }

    const sharedPayload = (shared.payload ?? {}) as {
      sharedReadOnly?: boolean
      sharedFromName?: string
      sourceApprovalId?: string
      record?: Record<string, unknown>
    }

    // Must be the recipient of this shared copy, and it must be a shared row.
    if (shared.userId !== ownerId || sharedPayload.sharedReadOnly !== true) {
      return { ok: false, error: "You do not have access to this deal." }
    }

    const sharedFromName = sharedPayload.sharedFromName || "MCC Capital"
    const sharedAt = shared.decidedAt ?? shared.createdAt

    // Prefer the owner's LIVE deal; fall back to the shared snapshot if the
    // original has since been removed.
    const source = sharedPayload.sourceApprovalId
      ? await getApprovalById(sharedPayload.sourceApprovalId)
      : null

    if (source) {
      const srcPayload = (source.payload ?? {}) as {
        record?: Record<string, unknown>
        delivered?: boolean
        deliveredAt?: string
      }
      return {
        ok: true,
        sharedApprovalId: shared.id,
        sharedFromName,
        sharedAt,
        live: {
          record: srcPayload.record ?? {},
          status: source.status,
          decidedAt: source.decidedAt ?? undefined,
          decisionNote: source.decisionNote ?? undefined,
          delivered: srcPayload.delivered === true,
          deliveredAt: srcPayload.deliveredAt,
          submittedAt: source.createdAt,
        },
      }
    }

    // Snapshot fallback.
    return {
      ok: true,
      sharedApprovalId: shared.id,
      sharedFromName,
      sharedAt,
      sourceMissing: true,
      live: {
        record: sharedPayload.record ?? {},
        status: shared.status,
        decidedAt: shared.decidedAt ?? undefined,
        decisionNote: shared.decisionNote ?? undefined,
        delivered: (shared.payload as { delivered?: boolean } | undefined)?.delivered === true,
        deliveredAt: (shared.payload as { deliveredAt?: string } | undefined)?.deliveredAt,
        submittedAt: shared.createdAt,
      },
    }
  } catch (err) {
    console.log("[v0] getSharedDealView failed:", (err as Error).message)
    return { ok: false, error: "This deal could not be loaded. Please try again." }
  }
}

// --- Admin: deal documents (real PDFs) + vessel ----------------------------

/** Minimal shape of a stored deal-document version (mirrors the client store). */
interface StoredDocVersion {
  version: number
  fileName: string
  reference: string
  issuedBy: string
  issueDate: string
  notes: string
  uploadedAt: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}
interface StoredDoc {
  id: string
  module: "POP" | "POF" | "DEAL"
  docType: string
  status: "submitted" | "verified" | "rejected"
  currentVersion: number
  versions: StoredDocVersion[]
  swiftRef?: string
  decidedAt?: string
  decisionNote?: string
}

export interface DealDocInput {
  docType: string
  reference?: string
  issuedBy?: string
  issueDate?: string
  notes?: string
  swiftRef?: string
  fileName: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}

/**
 * Load an approved commodity deal for admin document/vessel management, refusing
 * shared read-only copies (those are visibility-only mirrors — never mutate them,
 * always operate on the owner's source deal).
 */
async function loadCommodityForAdmin(
  id: string,
): Promise<{ ok: true; req: ApprovalRequest; record: Record<string, unknown> } | { ok: false; error: string }> {
  const existing = await getApprovalById(id)
  if (!existing) return { ok: false, error: "Deal not found." }
  if (existing.kind !== "commodity") return { ok: false, error: "Only commodity deals are supported here." }
  if ((existing.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true) {
    return { ok: false, error: "This is a shared read-only copy. Manage the original deal instead." }
  }
  const record = ((existing.payload?.record ?? {}) as Record<string, unknown>) || {}
  return { ok: true, req: existing, record }
}

async function persistRecord(req: ApprovalRequest, record: Record<string, unknown>): Promise<void> {
  await updateApprovalPayload(req.id, { ...(req.payload ?? {}), record })
}

async function notifyOwnerDoc(req: ApprovalRequest, title: string, body: string): Promise<void> {
  try {
    await insertNotification({
      userId: req.userId,
      tone: "info",
      title,
      body,
      href: KIND_HREF.commodity ?? "/dashboard/commodity",
    })
  } catch (err) {
    console.log("[v0] deal-doc notification failed:", (err as Error).message)
  }
}

async function logDeal(req: ApprovalRequest, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    const target = await resolveAccountProfileById(req.userId)
    await logActivity({
      action,
      category: "Administration / Approvals",
      user: "Administrator",
      details: { referenceId: req.id, owner: `${target.fullName} — ${target.email}`, ...details },
    })
  } catch (err) {
    console.log("[v0] deal activity log failed:", (err as Error).message)
  }
}

/**
 * Administrator adds (or re-versions) a DEAL document on an approved commodity
 * deal. The PDF binary lives in private Blob; here we persist its metadata +
 * pathname onto the owner's deal record so it surfaces live (read-only) to the
 * deal owner and any shared-deal recipients. No balance/ledger effect.
 */
export async function adminAddDealDocument(
  passcode: string,
  id: string,
  input: DealDocInput,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!input?.docType?.trim()) return { ok: false, error: "A document type is required." }
  if (!input?.fileName?.trim()) return { ok: false, error: "A file is required." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const now = new Date().toISOString()
    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const version: StoredDocVersion = {
      version: 1,
      fileName: input.fileName.trim(),
      reference: (input.reference ?? "").trim(),
      issuedBy: (input.issuedBy ?? "").trim(),
      issueDate: (input.issueDate ?? "").trim(),
      notes: (input.notes ?? "").trim(),
      uploadedAt: now,
      blobPathname: input.blobPathname,
      fileSize: input.fileSize,
      contentType: input.contentType,
    }
    const doc: StoredDoc = {
      id: `DDOC-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      module: "DEAL",
      docType: input.docType.trim(),
      status: "submitted",
      currentVersion: 1,
      versions: [version],
      swiftRef: input.swiftRef?.trim() || undefined,
    }
    record.documents = [...docs, doc]
    await persistRecord(req, record)

    await notifyOwnerDoc(
      req,
      "New deal document available",
      `MCC Capital added "${doc.docType}" to your commodity deal "${req.title}". Open the deal to view the document.`,
    )
    await logDeal(req, `Administrator added deal document "${doc.docType}" to "${req.title}"`, {
      document: doc.docType,
      fileName: version.fileName,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be saved." }
  } catch (err) {
    console.log("[v0] adminAddDealDocument failed:", (err as Error).message)
    return { ok: false, error: "The document could not be added. Please try again." }
  }
}

/** Administrator sets a deal document's verification status. */
export async function adminSetDealDocumentStatus(
  passcode: string,
  id: string,
  documentId: string,
  status: "submitted" | "verified" | "rejected",
  note?: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const idx = docs.findIndex((d) => d.id === documentId)
    if (idx === -1) return { ok: false, error: "Document not found on this deal." }
    docs[idx] = { ...docs[idx], status, decidedAt: new Date().toISOString(), decisionNote: note?.trim() || undefined }
    record.documents = docs
    await persistRecord(req, record)

    await logDeal(req, `Administrator marked deal document "${docs[idx].docType}" as ${status} on "${req.title}"`, {
      document: docs[idx].docType,
      status,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be updated." }
  } catch (err) {
    console.log("[v0] adminSetDealDocumentStatus failed:", (err as Error).message)
    return { ok: false, error: "The document status could not be updated. Please try again." }
  }
}

/** Administrator removes a deal document from an approved commodity deal. */
export async function adminRemoveDealDocument(
  passcode: string,
  id: string,
  documentId: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    const docs = Array.isArray(record.documents) ? ([...record.documents] as StoredDoc[]) : []
    const removed = docs.find((d) => d.id === documentId)
    if (!removed) return { ok: false, error: "Document not found on this deal." }
    record.documents = docs.filter((d) => d.id !== documentId)
    await persistRecord(req, record)

    await logDeal(req, `Administrator removed deal document "${removed.docType}" from "${req.title}"`, {
      document: removed.docType,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The document could not be removed." }
  } catch (err) {
    console.log("[v0] adminRemoveDealDocument failed:", (err as Error).message)
    return { ok: false, error: "The document could not be removed. Please try again." }
  }
}

/**
 * Administrator attaches (and verifies) a vessel to an approved commodity deal.
 * Reuses the existing IMO check-digit validation + free OFAC sanctions screening
 * and the vessel catalogue. A denormalised snapshot (with its compliance verdict)
 * is stored on the deal so it surfaces live/read-only to the owner and shared
 * recipients. No balance effect.
 */
export async function adminAttachDealVessel(
  passcode: string,
  id: string,
  imo: string,
): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const clean = (imo ?? "").trim()
  if (!/^\d{7}$/.test(clean)) return { ok: false, error: "IMO number must be exactly 7 digits." }
  if (!isValidImo(clean)) {
    return { ok: false, error: "That IMO fails the official check-digit validation — it is not a real IMO number." }
  }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded

    // Prefer the catalogue record (richer identity data) and refresh its OFAC
    // screening; otherwise resolve via public registry + screening.
    let snapshot: Vessel
    const existing = await dbGetVessel(clean)
    if (existing) {
      const compliance = await screenVesselImo(clean)
      snapshot = { ...existing, compliance, updatedAt: new Date().toISOString() }
    } else {
      const res = await fetchVesselByImo(clean)
      if ("error" in res) return { ok: false, error: res.error }
      snapshot = res.vessel
    }

    record.vessel = snapshot
    await persistRecord(req, record)

    const verdict =
      snapshot.compliance?.status === "flagged"
        ? "FLAGGED on sanctions screening"
        : snapshot.compliance?.status === "unverified"
          ? "screening unverified"
          : "clear on sanctions screening"

    await notifyOwnerDoc(
      req,
      "Vessel assigned to your deal",
      `MCC Capital assigned the vessel "${snapshot.name}" (IMO ${snapshot.imo}) to your commodity deal "${req.title}".`,
    )
    await logDeal(req, `Administrator assigned vessel ${snapshot.name} (IMO ${snapshot.imo}) to "${req.title}"`, {
      vessel: snapshot.name,
      imo: snapshot.imo,
      vesselType: VESSEL_TYPE_LABELS[snapshot.type],
      compliance: verdict,
    })

    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The vessel could not be assigned." }
  } catch (err) {
    console.log("[v0] adminAttachDealVessel failed:", (err as Error).message)
    return { ok: false, error: "The vessel could not be assigned. Please try again." }
  }
}

/** Administrator detaches the vessel from an approved commodity deal. */
export async function adminDetachDealVessel(passcode: string, id: string): Promise<DecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const loaded = await loadCommodityForAdmin(id)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    const { req, record } = loaded
    const prev = record.vessel as Vessel | undefined
    delete record.vessel
    await persistRecord(req, record)
    if (prev) {
      await logDeal(req, `Administrator removed vessel ${prev.name} (IMO ${prev.imo}) from "${req.title}"`, {
        vessel: prev.name,
        imo: prev.imo,
      })
    }
    const updated = await getApprovalById(id)
    return updated ? { ok: true, request: updated } : { ok: false, error: "The vessel could not be removed." }
  } catch (err) {
    console.log("[v0] adminDetachDealVessel failed:", (err as Error).message)
    return { ok: false, error: "The vessel could not be removed. Please try again." }
  }
}

/**
 * The signed-in Master's consent queue: Sub-account requests routed to them for
 * a second-gate decision. `pendingOnly` returns just those still awaiting the
 * Master's verdict (used for the badge/queue), otherwise the full history.
 */
export async function getMyMasterApprovalQueue(opts?: { pendingOnly?: boolean }): Promise<ApprovalRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    return await listApprovalsForMaster(session.id, opts)
  } catch (err) {
    console.log("[v0] getMyMasterApprovalQueue failed:", (err as Error).message)
    return []
  }
}

/**
 * Record the signed-in MASTER's verdict (second gate) for a Sub-account
 * request. The money movement applies here when the Master's approval is the
 * final gate (the admin already approved). The caller must be the request's
 * designated Master — enforced from the session, not the client.
 */
export async function masterDecideApproval(
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<DecideResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, error: "A reason is required to reject a request." }
  }

  try {
    const existing = await getApprovalById(id)
    if (!existing) return { ok: false, error: "Request not found." }
    if (existing.masterId !== session.id || !existing.requiresMasterApproval) {
      return { ok: false, error: "You are not authorized to decide this request." }
    }
    if (existing.status !== "pending" && existing.status !== "awaiting_master") {
      return { ok: false, error: "This request has already been decided." }
    }

    // HARD fund-availability gate at the Master's (final) approval — balances may
    // have changed since the administrator's gate. If the reservation can no
    // longer be covered, AUTO-REJECT, notify the sub-account, log it, and tell
    // the Master, so money never moves into a negative balance.
    if (decision === "approved") {
      const assessment = await assessReservation(existing)
      if (assessment.required && !assessment.feasible) {
        const reason = assessment.message
        const rejected = await recordMasterDecision(id, session.id, "rejected", reason)
        const finalReq = rejected ?? existing
        try {
          await insertNotification({
            userId: finalReq.userId,
            tone: "warning",
            title: `${KIND_LABELS[finalReq.kind]} declined — insufficient funds`,
            body: `Your ${KIND_LABELS[finalReq.kind].toLowerCase()} "${finalReq.title}" was automatically declined: the account lacks sufficient available balance to reserve the required funds. ${reason}`,
            href: KIND_HREF[finalReq.kind] ?? null,
          })
        } catch (err) {
          console.log("[v0] master insufficient-funds notification failed:", (err as Error).message)
        }
        try {
          const target = await resolveAccountProfileById(finalReq.userId)
          await logActivity({
            action: `Auto-declined a ${KIND_LABELS[finalReq.kind]} request from ${target.fullName} — insufficient funds`,
            category: "Account Hierarchy / Approvals",
            user: session.profile.fullName,
            details: {
              referenceId: finalReq.id,
              subAccount: `${target.fullName} — ${target.email}`,
              summary: finalReq.summary || finalReq.title,
              amount: finalReq.amount != null ? formatMoney(finalReq.amount, finalReq.currency ?? "") : "(n/a)",
              decision: "rejected (insufficient funds)",
              reason,
            },
          })
        } catch (err) {
          console.log("[v0] master insufficient-funds audit log failed:", (err as Error).message)
        }
        return { ok: false, error: reason }
      }
    }

    const updated = await recordMasterDecision(id, session.id, decision, note)
    if (!updated) return { ok: false, error: "This request has already been decided." }

    // Apply money movement only when BOTH gates have now cleared.
    if (updated.status === "approved") {
      try {
        await applyLedgerEffect(updated)
      } catch (err) {
        console.log("[v0] applyLedgerEffect (master gate) failed:", (err as Error).message)
      }
      // Payment fully approved via the Master gate is now "initiated" — enter
      // the stage-3 delivery lifecycle (see the admin-decide path for rationale).
      if (updated.kind === "payment") {
        try {
          const p = (updated.payload ?? {}) as Record<string, unknown>
          if (!p.deliveryInitiatedAt) {
            await updateApprovalPayload(updated.id, {
              ...p,
              deliveryInitiatedAt: new Date().toISOString(),
            })
          }
        } catch (err) {
          console.log("[v0] payment delivery-initiated stamp (master gate) failed:", (err as Error).message)
        }
      }
    }

    // Notify the initiating Sub-account of the Master's verdict.
    const label = KIND_LABELS[updated.kind]
    const fullyApproved = updated.status === "approved"
    try {
      await insertNotification({
        userId: updated.userId,
        tone: decision === "approved" ? (fullyApproved ? "success" : "info") : "warning",
        title:
          decision === "approved"
            ? fullyApproved
              ? `${label} approved`
              : `${label} awaiting administrator`
            : `${label} declined by Master`,
        body:
          decision === "approved"
            ? fullyApproved
              ? `Your ${label.toLowerCase()} "${updated.title}" was approved by your Master account and has been executed.`
              : `Your Master account approved "${updated.title}"; it now awaits administrator approval.`
            : `Your ${label.toLowerCase()} "${updated.title}" was declined by your Master account. Reason: ${note?.trim()}`,
        href: KIND_HREF[updated.kind] ?? null,
      })
    } catch (err) {
      console.log("[v0] master decision notification failed:", (err as Error).message)
    }

    const target = await resolveAccountProfileById(updated.userId)

    // When the Master consented but the request now advances to pending
    // administrator review (not yet fully approved), alert EVERY admin so any
    // of them can act. A fully-approved request needed no admin gate, so no
    // admin alert is due. Best-effort.
    if (decision === "approved" && !fullyApproved) {
      const ownerId = await resolveDataOwnerIdFor(updated.userId).catch(() => updated.userId)
      await notifyAllAdminsOfSubmission({
        customerName: target?.fullName ?? updated.title,
        kind: updated.kind,
        title: updated.title,
        amount: updated.amount,
        currency: updated.currency,
        excludeIds: [updated.userId, ownerId, session.id],
      })
    }

    // Audit trail.
    await logActivity({
      action: `Master ${session.profile.fullName} ${decision} a ${label} request from ${target.fullName}`,
      category: "Account Hierarchy / Approvals",
      user: session.profile.fullName,
      details: {
        referenceId: updated.id,
        subAccount: `${target.fullName} — ${target.email}`,
        summary: updated.summary || updated.title,
        amount: updated.amount != null ? `${updated.currency ?? ""} ${updated.amount.toLocaleString("en-US")}` : "(n/a)",
        decision,
        reason: note?.trim() || "(none)",
      },
    })

    return { ok: true, request: updated }
  } catch (err) {
    console.log("[v0] masterDecideApproval failed:", (err as Error).message)
    return { ok: false, error: "The decision could not be recorded. Please try again." }
  }
}

/**
 * Issue a bank instrument directly into a client's portfolio (administrator
 * only). Clients can no longer self-create instruments; issuance is an
 * administrator-controlled act. This records an `instrument` approval for the
 * target client that is born already-approved and carries the full instrument
 * in its payload, so the client's instrument store can materialise it as an
 * active holding on its next reconcile — durable and visible cross-device.
 */
export type IssueInstrumentResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string }

export async function adminIssueInstrument(
  passcode: string,
  userId: string,
  instrument: Record<string, unknown>,
): Promise<IssueInstrumentResult> {
  if (!(await adminOk(passcode))) return { ok: false, error: "Administrator authorization failed." }
  if (!userId) return { ok: false, error: "Select a client to issue to." }

  const id = String(instrument?.id ?? "").trim()
  const issuer = String(instrument?.issuer ?? "").trim()
  const typeFull = String(instrument?.typeFull ?? instrument?.type ?? "Bank Instrument").trim()
  const currency = String(instrument?.currency ?? "USD").trim()
  const faceValue = Number(instrument?.faceValue ?? 0)
  if (!id) return { ok: false, error: "The instrument is missing an identifier." }
  if (!issuer) return { ok: false, error: "An issuing bank is required." }
  if (!Number.isFinite(faceValue) || faceValue <= 0) {
    return { ok: false, error: "Enter a valid face value greater than 0." }
  }

  try {
    // Born pending, then immediately decided approved by the administrator, so
    // it shares the exact same audit + notification path as any other decision.
    const created = await insertApproval({
      userId,
      kind: "instrument",
      title: `${typeFull} · ${issuer}`,
      summary: `${currency} ${faceValue.toLocaleString("en-US")} ${typeFull} issued by ${issuer} (administrator issuance).`,
      amount: faceValue,
      currency,
      // The full instrument travels in the payload so the client can materialise
      // it. `issuedByAdmin` marks it as a brand-new holding (not a reconcile of
      // a client-originated request).
      payload: { issuedByAdmin: true, instrument },
    })

    const decided = await decideApproval(created.id, "approved", "Administrator")
    const request = decided ?? created

    try {
      await insertNotification({
        userId,
        tone: "success",
        title: "Bank instrument issued",
        body: `MCC Capital issued a ${typeFull} of ${currency} ${faceValue.toLocaleString("en-US")} (${issuer}) to your portfolio.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] issue notification failed:", (err as Error).message)
    }

    const target = await resolveAccountProfileById(userId)
    await logActivity({
      action: `Administrator issued a ${typeFull} (${currency} ${faceValue.toLocaleString("en-US")}) to ${target.fullName}`,
      category: "Administration / Instruments",
      user: "Administrator",
      details: {
        referenceId: id,
        targetAccount: `${target.fullName} — ${target.email}`,
        instrument: `${typeFull} — ${issuer}`,
        faceValue: `${currency} ${faceValue.toLocaleString("en-US")}`,
        action: "Issued",
      },
    })

    return { ok: true, request }
  } catch (err) {
    console.log("[v0] adminIssueInstrument failed:", (err as Error).message)
    return { ok: false, error: "The instrument could not be issued. Please try again." }
  }
}

// --- Client-to-client instrument transfer ----------------------------------

export type TransferInstrumentResult =
  | { ok: true; recipientName: string; recipientEmail: string }
  | { ok: false; error: string }

/**
 * Transfer an ACTIVE bank instrument the signed-in client holds to another
 * platform account, identified by registered email. The instrument moves
 * immediately (no desk approval): it is issued into the recipient's portfolio
 * as an active holding (born pending → instantly approved, exactly like
 * administrator issuance) and removed from the sender's active holdings (marked
 * "Transferred"). This is a cross-user write, so every guard is enforced
 * server-side: the caller must own an active instrument, the recipient must be
 * a distinct active account, and the source record is moved race-safely so the
 * same instrument can never be duplicated across two concurrent transfers.
 */
export async function transferMyInstrument(
  approvalId: string,
  recipientEmail: string,
): Promise<TransferInstrumentResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const email = (recipientEmail ?? "").trim()
  if (!email) return { ok: false, error: "Enter the recipient's account email." }

  // The source must exist, be an instrument, belong to THIS holder's portfolio,
  // and be active (approved). Anything else is rejected.
  const senderOwnerId = session.dataOwnerId
  const record = await getApprovalById(approvalId)
  if (!record || record.kind !== "instrument") {
    return { ok: false, error: "Instrument not found." }
  }
  if (record.userId !== senderOwnerId) {
    return { ok: false, error: "You can only transfer instruments held in your own portfolio." }
  }
  if (record.status !== "approved") {
    return { ok: false, error: "Only active instruments can be transferred." }
  }

  // Resolve the recipient — must be an active account, and not the sender.
  const recipient = await getDynamicUserByEmail(email)
  if (!recipient || recipient.status !== "active") {
    return { ok: false, error: "No active account is registered with that email." }
  }
  const recipientOwnerId = await resolveDataOwnerIdFor(recipient.id)
  if (recipientOwnerId === senderOwnerId) {
    return { ok: false, error: "This instrument is already in that portfolio." }
  }

  // Pull the full instrument view-model out of the existing payload (admin-issued
  // instruments carry it under `instrument`; client-originated under `record`).
  const payload = (record.payload ?? {}) as {
    record?: Record<string, unknown>
    instrument?: Record<string, unknown>
    issuedByAdmin?: boolean
  }
  const base = (payload.issuedByAdmin ? payload.instrument : payload.record ?? payload.instrument) ?? {}
  const instrument = { ...base, status: "active" }
  const instrumentId = String((base as { id?: unknown }).id ?? approvalId)

  const recipientProfile = await resolveAccountProfileById(recipientOwnerId)
  const recipientLabel = recipientProfile.fullName || recipient.email
  const senderName = session.profile.fullName || session.profile.company || session.profile.email

  try {
    // 1) Issue into the recipient's portfolio (born pending → approved).
    const created = await insertApproval({
      userId: recipientOwnerId,
      kind: "instrument",
      title: record.title,
      summary: `${record.summary} — transferred from ${senderName}.`,
      amount: record.amount,
      currency: record.currency,
      payload: { issuedByAdmin: true, instrument, transferredFrom: senderName },
    })
    await decideApproval(created.id, "approved", "Instrument transfer")

    // 2) Remove from the sender's active holdings (marked Transferred). Race-safe
    //    and ownership-scoped — only acts while still approved and owned by sender.
    const moved = await markApprovalTransferred(approvalId, senderOwnerId, recipientLabel)
    if (!moved) {
      // The source changed under us (already transferred). Roll back the
      // recipient issuance so the instrument is never duplicated.
      await adminRevokeApprovedApproval(created.id, "Transfer rolled back — source no longer transferable.")
      return { ok: false, error: "This instrument is no longer available to transfer." }
    }

    // 3) Notify the recipient so it surfaces in their alerts.
    try {
      await insertNotification({
        userId: recipientOwnerId,
        tone: "success",
        title: "Bank instrument received",
        body: `${senderName} transferred a ${record.title} to your portfolio.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] transfer notification failed:", (err as Error).message)
    }

    await logActivity({
      action: `Transferred ${record.title} to ${recipientLabel}`,
      category: "Bank Instruments",
      user: senderName,
      details: {
        summary: `Client transferred the bank instrument ${instrumentId} (${record.currency ?? ""} ${(record.amount ?? 0).toLocaleString("en-US")}) to ${recipientLabel} — ${recipient.email}. The instrument left the sender's portfolio and is now active for the recipient.`,
        referenceId: instrumentId,
        recipient: `${recipientLabel} — ${recipient.email}`,
        faceValue: `${record.currency ?? ""} ${(record.amount ?? 0).toLocaleString("en-US")}`,
        action: "Transferred",
      },
    })

    return { ok: true, recipientName: recipientLabel, recipientEmail: recipient.email }
  } catch (err) {
    console.log("[v0] transferMyInstrument failed:", (err as Error).message)
    return { ok: false, error: "The transfer could not be completed. Please try again." }
  }
}

// --- Client accept / decline of an Administrator-proposed instrument upgrade -

export type InstrumentUpgradeResult =
  | { ok: true; newInstrumentId?: string; refunded?: number; currency?: string }
  | { ok: false; error: string }

/**
 * CUSTOMER-INITIATED upgrade request. The customer asks to have one of their
 * held instruments transformed into a fresh, better one; the Administrator then
 * reviews it and proposes terms (or declines). This moves NO money and blocks
 * nothing — it only stamps `payload.upgrade = { status: "requested", ... }` with
 * placeholder new-instrument fields (a like-for-like copy that the admin's
 * "Propose upgrade" overwrites) and fans a notification out to every admin. The
 * engagement guard is enforced downstream: the admin `start` op hard-blocks a
 * pledged/reserved instrument, so a request on an engaged instrument simply
 * cannot be actioned (the client UI also hides the request action for those).
 */
export async function requestInstrumentUpgrade(
  approvalId: string,
  note?: string,
  desiredType?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument" || existing.status !== "approved") {
      return { ok: false, error: "Active instrument not found." }
    }
    if (existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "You can only request upgrades for instruments in your own portfolio." }
    }
    const payload = (existing.payload ?? {}) as {
      record?: Record<string, unknown>
      instrument?: Record<string, unknown>
      issuedByAdmin?: boolean
      upgrade?: InstrumentUpgrade
    }
    const current = payload.upgrade
    if (current && current.status !== "declined") {
      const label =
        current.status === "requested"
          ? "already requested — an administrator is reviewing it"
          : current.status === "accepted"
            ? "already been upgraded"
            : "already in an active upgrade negotiation"
      return { ok: false, error: `This instrument has ${label}.` }
    }

    const base = (payload.issuedByAdmin ? payload.instrument : payload.record ?? payload.instrument) ?? {}
    const oldFaceValue = Number((base as { faceValue?: number }).faceValue ?? existing.amount) || 0
    const oldCurrency = String((base as { currency?: string }).currency ?? existing.currency ?? "USD")
    const oldType = String((base as { type?: string }).type ?? "SBLC")
    const oldTypeFull = String((base as { typeFull?: string }).typeFull ?? "Bank Instrument")
    const oldIssuer = String((base as { issuer?: string }).issuer ?? "")
    const trimmedNote = (note ?? "").trim() || undefined
    // Customer's requested target instrument type (e.g. BG / SBLC). When it
    // resolves to a real marketplace type we seed the upgrade's new-type fields
    // with it (instead of a like-for-like copy of the old MT760), so the admin's
    // Propose dialog is pre-directed at the real BG/SBLC the customer asked for.
    const desired = desiredType ? findInstrumentType(desiredType) : undefined
    const targetType = desired?.code ?? oldType
    const targetTypeFull = desired?.full ?? oldTypeFull
    const targetLabel = desired ? ` into a ${desired.full} (${desired.code})` : ""

    // Placeholder new-instrument fields (copy of the current instrument) so the
    // record satisfies the InstrumentUpgrade type; the admin's Propose upgrade
    // (start op) overwrites them with the real negotiated terms.
    const upgrade: InstrumentUpgrade = {
      status: "requested",
      proposedAt: new Date().toISOString(),
      feeRate: INSTRUMENT_UPGRADE_FEE_RATE,
      fee: instrumentUpgradeFee(oldFaceValue),
      feeCurrency: oldCurrency,
      oldFaceValue,
      feeCharged: false,
      requestedByCustomer: true,
      requestedAt: new Date().toISOString(),
      customerRequestNote: trimmedNote,
      newType: targetType,
      newTypeFull: targetTypeFull,
      newIssuer: oldIssuer,
      newFaceValue: oldFaceValue,
      newCurrency: oldCurrency,
      note: trimmedNote,
    }
    await updateApprovalPayload(approvalId, { ...(existing.payload ?? {}), upgrade })

    // Alert EVERY administrator so any of them can review the request and
    // propose terms. Best-effort — a notification failure never fails the request.
    let holderName = existing.userId
    try {
      const profile = await resolveAccountProfileById(existing.userId)
      holderName = profile.fullName
    } catch {
      /* best-effort */
    }
    try {
      const admins = await Promise.all(adminEmails().map((e) => getDynamicUserByEmail(e).catch(() => undefined)))
      const seen = new Set<string>()
      await Promise.all(
        admins
          .filter(
            (a): a is NonNullable<typeof a> =>
              !!a && a.id !== existing.userId && !seen.has(a.id) && (seen.add(a.id), true),
          )
          .map((admin) =>
            insertNotification({
              userId: admin.id,
              tone: "warning",
              title: "Customer requested an instrument upgrade",
              body: `${holderName} requested an upgrade of their ${oldTypeFull} (${oldCurrency} ${oldFaceValue.toLocaleString("en-US")})${targetLabel}${trimmedNote ? ` — "${trimmedNote}"` : ""}. Open the Instrument Upgrade panel to review and propose terms.`,
              href: "/dashboard/admin",
            }).catch(() => undefined),
          ),
      )
    } catch (err) {
      console.log("[v0] requestInstrumentUpgrade admin fan-out failed:", (err as Error).message)
    }

    try {
      await logActivity({
        action: `Requested an instrument upgrade`,
        category: "Bank Instruments",
        user: holderName,
        details: {
          referenceId: String((base as { id?: string }).id ?? approvalId),
          summary: `Customer requested an upgrade of ${oldTypeFull} (${oldCurrency} ${oldFaceValue.toLocaleString("en-US")})${targetLabel}${trimmedNote ? ` — "${trimmedNote}"` : ""}.`,
          action: "Upgrade requested",
        },
      })
    } catch (err) {
      console.log("[v0] requestInstrumentUpgrade activity failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] requestInstrumentUpgrade failed:", (err as Error).message)
    return { ok: false, error: "The request could not be completed. Please try again." }
  }
}

/**
 * Confirm an Administrator-proposed transformation/upgrade at the agreed value.
 * This is the moment money moves: the one-time expertise & upgrade fee is
 * charged to the Master Account (balance verified FIRST — nothing is issued if
 * it can't be covered), UNLESS a legacy `proposed` deal already charged it. Then
 * the fresh, negotiated instrument is issued into the customer's portfolio
 * immediately, the old instrument retired, and the deal stamped `accepted`.
 */
export async function acceptInstrumentUpgrade(approvalId: string): Promise<InstrumentUpgradeResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument") return { ok: false, error: "Instrument not found." }
    if (existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "You can only act on instruments in your own portfolio." }
    }
    const payload = (existing.payload ?? {}) as {
      record?: Record<string, unknown>
      instrument?: Record<string, unknown>
      issuedByAdmin?: boolean
      upgrade?: InstrumentUpgrade
    }
    const upgrade = payload.upgrade
    if (!upgrade || (upgrade.status !== "negotiating" && upgrade.status !== "proposed")) {
      return { ok: false, error: "There is no upgrade offer to accept for this instrument." }
    }
    const oldBase = (payload.issuedByAdmin ? payload.instrument : payload.record ?? payload.instrument) ?? {}

    // Charge the one-time expertise & upgrade fee NOW (on confirm) unless a
    // legacy `proposed` deal already charged it. Balance verified first —
    // nothing is issued or charged if the customer cannot cover it.
    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    const feeCurrency = upgrade.feeCurrency
    const standardUpgradeFee = upgrade.fee > 0 ? upgrade.fee : instrumentUpgradeFee(upgrade.newFaceValue || upgrade.oldFaceValue)
    // Admin-set cashback reduces the expertise & upgrade fee.
    const upgradeCashback = await applyCashbackForOwner(ownerId, "instrument", standardUpgradeFee)
    const feeAmount = upgradeCashback.netFee
    const alreadyCharged = upgrade.feeCharged === true || upgrade.status === "proposed"
    if (!alreadyCharged && feeAmount > 0) {
      const available = availableByCurrency(await readLedgerEntries(ownerId))
      const availableInCcy = Object.entries(available).reduce(
        (sum, [cur, amt]) => sum + convertCurrency(amt, cur, feeCurrency),
        0,
      )
      // Include the account's authorized overdraft headroom — a fee within the
      // controlled overdraft must be payable (mirrors the internal-loan / SWIFT
      // fee gates). Without this a €200k fee failed on a €191k balance even with
      // a €250k overdraft facility.
      let overdraftInCcy = 0
      try {
        const od = await getOverdraftStatusForOwner(ownerId)
        overdraftInCcy = od.remainingEur > 0 ? convertCurrency(od.remainingEur, "EUR", feeCurrency) : 0
      } catch {
        /* overdraft unreadable → fall back to cash-only */
      }
      const spendable = availableInCcy + overdraftInCcy
      if (feeAmount > spendable + 0.01) {
        return {
          ok: false,
          error: `You cannot cover the ${INSTRUMENT_UPGRADE_FEE_LABEL} expertise & upgrade fee of ${feeCurrency} ${feeAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Fund your Master Account and try again — nothing was charged.`,
        }
      }
      try {
        await upsertLedgerEntry(ownerId, {
          id: `INSTR-UPGRADE-FEE-${approvalId}`,
          direction: "debit",
          amount: feeAmount,
          currency: feeCurrency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: `${String((oldBase as { typeFull?: unknown }).typeFull ?? "Instrument")} ${String((oldBase as { id?: unknown }).id ?? "")}`.trim(),
          reference: approvalId,
          category: `Bank Instrument — Expertise & Upgrade Fee (${INSTRUMENT_UPGRADE_FEE_LABEL})`,
          comment: `${INSTRUMENT_UPGRADE_FEE_LABEL} one-time upgrade fee on ${feeCurrency} ${upgrade.oldFaceValue.toLocaleString("en-US")} instrument (charged on customer confirm).${cashbackNote(upgradeCashback, feeCurrency)}`,
        })
      } catch (err) {
        console.log("[v0] upgrade accept fee charge failed:", (err as Error).message)
        return { ok: false, error: "The upgrade fee could not be charged. Please try again." }
      }
    }

    // Build the fresh instrument view-model from the negotiated deal, carrying
    // over sensible defaults from the old instrument where not superseded.
    const newId = `${upgrade.newType}-${Math.floor(100000 + Math.random() * 900000)}`
    const now = new Date()
    const expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    // Capabilities follow the NEW instrument type, not the old one. Without this
    // a BG upgraded FROM an MT760 blocked-funds guarantee inherited the MT760's
    // `assignable:false / monetizable:false` (and its "Blocked-funds guarantee"
    // trade label), so the fresh, fully-usable instrument showed NO Transfer /
    // Assign / Monetize actions. A fresh partner-bank instrument must be usable
    // per its own type (BG → both true; DLC → monetizable only; etc.).
    const newTypeMeta = findInstrumentType(upgrade.newType)
    // Mint a FRESH securities-identifier set for the upgraded instrument (keyed
    // off the new issuer + type) and stamp it onto the record now, so it persists
    // in the DB rather than being lazily materialised client-side. A CUSIP is
    // ALWAYS issued for an upgraded instrument (the base builder only mints one
    // for US issuers, so force it here for every upgrade regardless of domicile).
    const newIds = buildInstrumentIdentifiers(upgrade.newIssuer, upgrade.newType, now)
    const newInstrument: Record<string, unknown> = {
      ...oldBase,
      id: newId,
      isin: newIds.isin,
      commonCode: newIds.commonCode,
      cusip: newIds.cusip ?? generateCusip(),
      serialNumber: newIds.serialNumber,
      type: upgrade.newType,
      typeFull: upgrade.newTypeFull,
      issuer: upgrade.newIssuer,
      issuerCountry: upgrade.newIssuerCountry,
      issuerBic: upgrade.newIssuerBic,
      faceValue: upgrade.newFaceValue,
      currency: upgrade.newCurrency,
      status: "active",
      issuedDate: now.toISOString(),
      expiryDate: expiry.toISOString(),
      daysRemaining: 365,
      rating: "AAA",
      assignable: newTypeMeta?.assignable ?? true,
      monetizable: newTypeMeta?.monetizable ?? true,
      tradeType: `Transformation upgrade from ${String((oldBase as { typeFull?: unknown }).typeFull ?? "prior instrument")}`,
      blocked: undefined,
      upgrade: undefined,
    }

    // 1) Issue the fresh instrument into the customer's portfolio.
    const created = await insertApproval({
      userId: existing.userId,
      kind: "instrument",
      title: `${upgrade.newTypeFull} �� ${upgrade.newIssuer}`,
      summary: `${upgrade.newCurrency} ${upgrade.newFaceValue.toLocaleString("en-US")} ${upgrade.newTypeFull} issued by ${upgrade.newIssuer} (transformation upgrade).`,
      amount: upgrade.newFaceValue,
      currency: upgrade.newCurrency,
      payload: { issuedByAdmin: true, instrument: newInstrument, upgradedFrom: String((oldBase as { id?: unknown }).id ?? approvalId) },
    })
    await decideApproval(created.id, "approved", "Instrument upgrade")

    // 2) Retire the OLD instrument by DELETING it outright — an upgraded
    // instrument is transformed into the fresh one, so the old row must be
    // removed entirely (not merely soft-cancelled, which left a lingering card
    // the customer had to delete manually). Hard delete scoped to the holder,
    // exactly like the manual "settle out" path; the new instrument already
    // carries `upgradedFrom` for provenance. Falls back to a soft-cancel only if
    // the delete cannot run, so the old instrument can NEVER remain active.
    const removed = await deleteApprovalForUser(approvalId, existing.userId)
    if (!removed) {
      await revokeApprovedApproval(approvalId, existing.userId, "Retired — transformed into an upgraded instrument.").catch(
        () => null,
      )
    }

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "success",
        title: "Upgraded instrument issued",
        body: `Your new ${upgrade.newCurrency} ${upgrade.newFaceValue.toLocaleString("en-US")} ${upgrade.newTypeFull} from ${upgrade.newIssuer} is now active in your portfolio.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch (err) {
      console.log("[v0] upgrade accept notification failed:", (err as Error).message)
    }

    try {
      const profile = await resolveAccountProfileById(existing.userId)
      await logActivity({
        action: `Accepted instrument upgrade — new ${upgrade.newTypeFull} issued`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: newId,
          summary: `Client accepted the transformation. Old instrument retired; fresh ${upgrade.newCurrency} ${upgrade.newFaceValue.toLocaleString("en-US")} ${upgrade.newTypeFull} from ${upgrade.newIssuer} issued and active.`,
          action: "Upgrade accepted",
        },
      })
    } catch (err) {
      console.log("[v0] upgrade accept activity failed:", (err as Error).message)
    }

    return { ok: true, newInstrumentId: newId }
  } catch (err) {
    console.log("[v0] acceptInstrumentUpgrade failed:", (err as Error).message)
    return { ok: false, error: "The upgrade could not be completed. Please try again." }
  }
}

/**
 * Decline an Administrator-proposed upgrade. The old instrument stays active and
 * usable. If a legacy `proposed` deal had already charged the upfront fee, it is
 * REFUNDED (idempotent via a deterministic ledger id); a `negotiating` deal had
 * no fee so nothing is refunded.
 */
export async function declineInstrumentUpgrade(approvalId: string): Promise<InstrumentUpgradeResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument") return { ok: false, error: "Instrument not found." }
    if (existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "You can only act on instruments in your own portfolio." }
    }
    const payload = (existing.payload ?? {}) as { upgrade?: InstrumentUpgrade }
    const upgrade = payload.upgrade
    if (!upgrade || (upgrade.status !== "negotiating" && upgrade.status !== "proposed")) {
      return { ok: false, error: "There is no upgrade offer to decline for this instrument." }
    }

    const ownerId = await resolveDataOwnerIdFor(existing.userId)
    // Refund the upfront fee ONLY if it was actually charged (legacy flow).
    const wasCharged = upgrade.feeCharged === true || upgrade.status === "proposed"
    let refunded = 0
    if (wasCharged && upgrade.fee > 0) {
      try {
        await upsertLedgerEntry(ownerId, {
          id: `INSTR-UPGRADE-REFUND-${approvalId}`,
          direction: "credit",
          amount: upgrade.fee,
          currency: upgrade.feeCurrency,
          status: "completed",
          date: new Date().toISOString(),
          counterparty: "MCC Capital",
          reference: approvalId,
          category: "Bank Instrument — Upgrade Fee Refund",
          comment: `Refund of the ${INSTRUMENT_UPGRADE_FEE_LABEL} upgrade fee after the customer declined the transformation.`,
        })
        refunded = upgrade.fee
      } catch (err) {
        console.log("[v0] upgrade decline refund failed:", (err as Error).message)
      }
    }

    // Mark the deal declined (materializer only blocks on status === "proposed").
    await updateApprovalPayload(approvalId, {
      ...(existing.payload ?? {}),
      upgrade: { ...upgrade, status: "declined", decidedAt: new Date().toISOString() },
    })

    try {
      await insertNotification({
        userId: existing.userId,
        tone: "info",
        title: "Instrument upgrade declined",
        body: `You declined the transformation of your instrument. It remains active and available${refunded > 0 ? `, and the ${upgrade.feeCurrency} ${refunded.toLocaleString("en-US")} fee was refunded` : ""}.`,
        href: KIND_HREF.instrument ?? "/dashboard/instruments",
      })
    } catch {
      /* best-effort */
    }

    return { ok: true, refunded, currency: upgrade.feeCurrency }
  } catch (err) {
    console.log("[v0] declineInstrumentUpgrade failed:", (err as Error).message)
    return { ok: false, error: "The upgrade could not be declined. Please try again." }
  }
}

/**
 * Customer submits a counter-offer for the new instrument's face value during
 * negotiation. Records it on the deal (`customerCounter*`) so the administrator
 * sees it in the upgrade manager and can revise or accept. No money moves.
 */
export async function counterInstrumentUpgrade(
  approvalId: string,
  counterFaceValue: number,
  note?: string,
): Promise<InstrumentUpgradeResult> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }
  try {
    if (!Number.isFinite(counterFaceValue) || counterFaceValue <= 0) {
      return { ok: false, error: "Enter a valid counter-offer amount." }
    }
    const existing = await getApprovalById(approvalId)
    if (!existing || existing.kind !== "instrument") return { ok: false, error: "Instrument not found." }
    if (existing.userId !== session.dataOwnerId) {
      return { ok: false, error: "You can only act on instruments in your own portfolio." }
    }
    const payload = (existing.payload ?? {}) as { upgrade?: InstrumentUpgrade }
    const upgrade = payload.upgrade
    if (!upgrade || upgrade.status !== "negotiating") {
      return { ok: false, error: "This offer is no longer open for counter-offers." }
    }

    await updateApprovalPayload(approvalId, {
      ...(existing.payload ?? {}),
      upgrade: {
        ...upgrade,
        customerCounterFaceValue: Math.round(counterFaceValue * 100) / 100,
        customerCounterAt: new Date().toISOString(),
        customerCounterNote: note?.trim() || undefined,
      },
    })

    let holderName = existing.userId
    try {
      const profile = await resolveAccountProfileById(existing.userId)
      holderName = profile.fullName
      await logActivity({
        action: `Counter-offer on instrument upgrade`,
        category: "Bank Instruments",
        user: profile.fullName,
        details: {
          referenceId: approvalId,
          summary: `Client proposed a new face value of ${upgrade.newCurrency} ${counterFaceValue.toLocaleString("en-US")} for the upgrade${note?.trim() ? ` — "${note.trim()}"` : ""}.`,
          action: "Upgrade counter-offer",
        },
      })
    } catch (err) {
      console.log("[v0] counterInstrumentUpgrade activity failed:", (err as Error).message)
    }

    // Alert EVERY administrator that the customer countered — this negotiation
    // event does NOT go through submitApproval's fan-out, so without this the
    // counter-offer only showed passively in the upgrade panel and no admin was
    // notified. Best-effort: a notification failure never fails the counter-offer.
    try {
      const admins = await Promise.all(adminEmails().map((e) => getDynamicUserByEmail(e).catch(() => undefined)))
      const seen = new Set<string>()
      await Promise.all(
        admins
          .filter(
            (a): a is NonNullable<typeof a> =>
              !!a && a.id !== existing.userId && !seen.has(a.id) && (seen.add(a.id), true),
          )
          .map((admin) =>
            insertNotification({
              userId: admin.id,
              tone: "warning",
              title: "Instrument upgrade — customer counter-offer",
              body: `${holderName} countered with a new face value of ${upgrade.newCurrency} ${counterFaceValue.toLocaleString("en-US")}${note?.trim() ? ` — "${note.trim()}"` : ""}. Open the Instrument Upgrade panel to revise or accept.`,
              href: "/dashboard/admin",
            }).catch(() => undefined),
          ),
      )
    } catch (err) {
      console.log("[v0] counterInstrumentUpgrade admin fan-out failed:", (err as Error).message)
    }

    return { ok: true }
  } catch (err) {
    console.log("[v0] counterInstrumentUpgrade failed:", (err as Error).message)
    return { ok: false, error: "The counter-offer could not be sent. Please try again." }
  }
}

export interface BulkDecideResult {
  ok: boolean
  decided: number
  failed: number
}

/** Approve or reject many requests at once (e.g. from multi-select). */
export async function adminBulkDecide(
  passcode: string,
  ids: string[],
  decision: "approved" | "rejected",
  note?: string,
): Promise<BulkDecideResult> {
  if (!(await adminOk(passcode))) return { ok: false, decided: 0, failed: ids.length }
  if (decision === "rejected" && !note?.trim()) {
    return { ok: false, decided: 0, failed: ids.length }
  }
  let decided = 0
  let failed = 0
  for (const id of ids) {
    const res = await adminDecideApproval(passcode, id, decision, note)
    if (res.ok) decided++
    else failed++
  }
  return { ok: failed === 0, decided, failed }
}
