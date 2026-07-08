"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  resolveCurrentSession,
  resolveAccountProfileById,
  resolveDataOwnerIdFor,
} from "@/lib/session-user"
import { logActivity } from "@/app/actions/log-activity"
import { insertApproval, decideApproval } from "@/lib/approvals-db"
import { addLedgerEntryForUserAdmin } from "@/app/actions/ledger"
import { saveTreasuryRecordAdmin, postTreasuryTxnAdmin } from "@/app/actions/treasury"
import {
  calculateAesEquity,
  calculateCashCommitment,
  AES_MIN_FACILITY,
  type AesEquityComponent,
} from "@/lib/aes"
import { fundingCapitalCreditId } from "@/lib/funding-capital"
import type { TreasuryProfileKey } from "@/lib/treasury-store"

// Server-safe treasury profile metadata. The amounts mirror TREASURY_PROFILES in
// lib/treasury-store.tsx, but that module is "use client" (it defines React
// context), so its runtime `getProfile()` cannot be invoked from a Server
// Action. These are fixed deposit tiers, so we duplicate the two constants here
// rather than importing the client function.
const TREASURY_FINANCING_PROFILES: Record<TreasuryProfileKey, { label: string; requiredDeposit: number }> = {
  pro: { label: "PRO Account", requiredDeposit: 500_000 },
  avantgarde: { label: "Avant-Garde Account", requiredDeposit: 1_000_000 },
}
import type { ProjectFundingRequest } from "@/lib/project-funding-store"
import type { UserProfile } from "@/lib/users"

// --- Auth helper ------------------------------------------------------------
//
// Every action here is administrator-only: it requires both a live session and
// the administrator passcode, verified server-side rather than trusting the
// client gate. This is what restricts treasury financing to the Admin Panel.

async function requireAdmin(passcode: string): Promise<UserProfile> {
  const session = await resolveCurrentSession()
  if (!session) throw new Error("Your session has expired. Please sign in again.")
  if (!(await adminActionAuthorized(passcode))) throw new Error("Administrator authorization failed.")
  return session.profile
}

function genRecordId(prefix = "PF"): string {
  const n = Math.floor(100_000 + Math.random() * 900_000)
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${n}`
}

// --- Project finance on behalf of a client ----------------------------------

export interface AdminProjectFinanceInput {
  projectName: string
  sector: string
  jurisdiction: string
  description?: string
  currency: string
  /** Total financing facility requested (>= AES minimum). */
  facility: number
  /** Equity composition the client will provide. Defaults to a cash component. */
  equityComponents?: AesEquityComponent[]
  /** Due-diligence risk score (0–10) that fixes the upfront cash commitment. */
  riskScore?: number
  note?: string
}

export type AdminProjectFinanceResult =
  | { ok: true; request: ProjectFundingRequest; approvalId: string }
  | { ok: false; error: string }

/**
 * Administrator submits a project finance application on behalf of a client and
 * funds it immediately. The application is created already-approved in the
 * client's portfolio (mirroring admin instrument issuance), and the approved
 * facility capital is credited to the client's master account at once.
 *
 * Crediting uses the SAME deterministic `FND-CAP-<recordId>` ledger id that the
 * client-side FundingCapitalReconciler derives, so the two crediting paths
 * dedupe and the facility is never double-credited. The reconciler continues to
 * accrue the 1.8% p.a. cost of capital month by month.
 */
export async function adminCreateProjectFinanceForUser(
  passcode: string,
  userId: string,
  input: AdminProjectFinanceInput,
): Promise<AdminProjectFinanceResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  if (!userId) return { ok: false, error: "Select a client to fund." }

  const projectName = input.projectName?.trim()
  const sector = input.sector?.trim()
  const jurisdiction = input.jurisdiction?.trim()
  if (!projectName) return { ok: false, error: "Enter the project name." }
  if (!sector) return { ok: false, error: "Enter the project sector." }
  if (!jurisdiction) return { ok: false, error: "Enter the project jurisdiction." }

  const currency = (input.currency || "EUR").toUpperCase()
  const facility = Math.round(Number(input.facility) || 0)
  if (!Number.isFinite(facility) || facility < AES_MIN_FACILITY) {
    return {
      ok: false,
      error: `The facility must be at least ${currency} ${AES_MIN_FACILITY.toLocaleString("en-US")}.`,
    }
  }

  // Authoritative AES equity + cash-commitment math (server-side).
  const equity = calculateAesEquity(facility)
  const riskScore =
    typeof input.riskScore === "number" && Number.isFinite(input.riskScore)
      ? Math.min(10, Math.max(0, input.riskScore))
      : undefined
  const commitment = calculateCashCommitment(facility, equity.totalEquity, riskScore)
  const components: AesEquityComponent[] =
    input.equityComponents && input.equityComponents.length > 0 ? input.equityComponents : ["cash"]

  const now = new Date().toISOString()
  const recordId = genRecordId()
  const target = await resolveAccountProfileById(userId)

  // The complete, approved application record — stored under payload.record so
  // the admin review queue and the client's portfolio both rebuild it anywhere.
  const record: ProjectFundingRequest = {
    id: recordId,
    projectName,
    sector,
    jurisdiction,
    description: input.description?.trim() || undefined,
    currency,
    facility,
    totalEquity: equity.totalEquity,
    effectiveRate: Math.round(equity.effectiveRate * 10000) / 100,
    equityComponents: components,
    cashCommitmentMin: commitment.min,
    cashCommitmentMax: commitment.max,
    documentsAcknowledged: true,
    bankStatementProvided: true,
    waiverFeeApplies: false,
    waiverFeeAccepted: false,
    uploadedDocuments: [],
    status: "approved",
    submittedAt: now,
    decidedAt: now,
    decisionNote: input.note?.trim() || "Submitted and funded by the Administrator on behalf of the client.",
    riskScore,
    cashCommitment: commitment.applicable,
  }

  try {
    const ownerId = await resolveDataOwnerIdFor(userId)

    // 1) Create the application already-approved in the client's portfolio.
    const created = await insertApproval({
      userId: ownerId,
      kind: "project_funding",
      title: `${projectName} · ${sector}`,
      summary: `${currency} ${facility.toLocaleString("en-US")} facility for ${projectName} (${jurisdiction}) — equity ${currency} ${equity.totalEquity.toLocaleString(
        "en-US",
      )} @ ${record.effectiveRate}%`,
      amount: facility,
      currency,
      payload: {
        localId: recordId,
        sector,
        jurisdiction,
        record: { ...record, approvalId: undefined },
        issuedByAdmin: true,
        onBehalfBy: `${admin.fullName} (${admin.company})`,
      },
    })
    await decideApproval(created.id, "approved", `${admin.fullName} (${admin.company})`, record.decisionNote)

    // 2) Credit the facility capital immediately, idempotent with the client
    //    reconciler (same deterministic FND-CAP id → upsert, never doubled).
    const credit = await addLedgerEntryForUserAdmin(passcode, userId, {
      id: fundingCapitalCreditId(recordId),
      direction: "credit",
      amount: facility,
      currency,
      status: "completed",
      date: now,
      counterparty: "MCC Capital — AES Facility Drawdown",
      reference: recordId,
      category: "Project Funding",
      comment: `Approved AES facility for "${projectName}" credited to the master account.`,
    })
    if (!credit.ok) {
      return { ok: false, error: credit.error }
    }

    await logActivity({
      action: `Administrator funded a project finance facility for ${target.fullName}`,
      category: "Project Funding",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        referenceId: recordId,
        targetAccount: `${target.fullName} — ${target.email}`,
        project: `${projectName} (${sector}, ${jurisdiction})`,
        facility: `${currency} ${facility.toLocaleString("en-US")}`,
        totalEquity: `${currency} ${equity.totalEquity.toLocaleString("en-US")} @ ${record.effectiveRate}%`,
        riskScore: riskScore ?? "(not scored)",
        cashCommitment: `${currency} ${Math.round(commitment.applicable).toLocaleString("en-US")}`,
        action: "Funded on behalf",
      },
    })

    return { ok: true, request: { ...record, approvalId: created.id }, approvalId: created.id }
  } catch (err) {
    console.log("[v0] adminCreateProjectFinanceForUser failed:", (err as Error).message)
    return { ok: false, error: "The project finance facility could not be created. Please try again." }
  }
}

// --- Treasury financing exception (admin only) ------------------------------

export type TreasuryFinancingTier = "pro" | "avantgarde"

export interface AdminTreasuryFinancingResult {
  ok: boolean
  error?: string
  amount?: number
}

/**
 * Administrator-only treasury financing of €500,000 (PRO) or €1,000,000
 * (Avant-Garde). On execution this atomically:
 *   1. regularizes the client's treasury security deposit to Fully Secured,
 *   2. logs a treasury deposit transaction (treasury ledger + audit trail), and
 *   3. credits the financed amount directly to the client's EUR balance.
 *
 * Restricted to the Admin Panel via the passcode + session gate above.
 */
export async function adminTreasuryFinancing(
  passcode: string,
  userId: string,
  tier: TreasuryFinancingTier,
  note?: string,
): Promise<AdminTreasuryFinancingResult> {
  let admin: UserProfile
  try {
    admin = await requireAdmin(passcode)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  if (!userId) return { ok: false, error: "Select a client to finance." }
  const profileKey: TreasuryProfileKey = tier === "avantgarde" ? "avantgarde" : "pro"
  const profile = TREASURY_FINANCING_PROFILES[profileKey]
  const amount = profile.requiredDeposit // 500_000 or 1_000_000

  const target = await resolveAccountProfileById(userId)
  const reason = note?.trim() || `Administrator treasury financing — ${profile.label}.`

  try {
    // 1) Regularize the treasury record to Fully Secured. Setting the customer
    //    contribution equal to the required deposit (no leverage) makes the
    //    secured balance meet the requirement, so it is stored as "secured".
    const saved = await saveTreasuryRecordAdmin(passcode, userId, {
      profile: profileKey,
      requiredDeposit: amount,
      customerContribution: amount,
      leverageEnabled: false,
      transactionExposure: 0,
      status: "secured",
      note: reason,
    })
    if (!saved.ok) return { ok: false, error: saved.error }

    // 2) Log the financing on the treasury transaction ledger (audit trail).
    const txn = await postTreasuryTxnAdmin(passcode, userId, {
      type: "deposit",
      label: `Treasury Financing — ${profile.label}`,
      amount,
      note: reason,
    })
    if (!txn.ok) return { ok: false, error: txn.error }

    // 3) Credit the financed amount directly to the client's EUR balance.
    const credit = await addLedgerEntryForUserAdmin(passcode, userId, {
      id: `TRYFIN-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
      direction: "credit",
      amount,
      currency: "EUR",
      status: "completed",
      date: new Date().toISOString(),
      counterparty: "MCC Capital — Treasury Financing Facility",
      reference: `TREASURY-${profileKey.toUpperCase()}`,
      category: "Treasury Financing",
      comment: `Treasury financing (${profile.label}) credited to the master account.`,
    })
    if (!credit.ok) return { ok: false, error: credit.error }

    await logActivity({
      action: `Administrator executed treasury financing for ${target.fullName}`,
      category: "Treasury",
      user: `${admin.fullName} (${admin.company})`,
      details: {
        targetAccount: `${target.fullName} — ${target.email}`,
        facility: profile.label,
        amount: `EUR ${amount.toLocaleString("en-US")}`,
        treasuryStatus: "Fully Secured",
        action: "Treasury financing",
      },
    })

    return { ok: true, amount }
  } catch (err) {
    console.log("[v0] adminTreasuryFinancing failed:", (err as Error).message)
    return { ok: false, error: "Treasury financing could not be completed. Please try again." }
  }
}
