// Plain (non-"use server") shared constants and types for institutional yields.
// A "use server" action module may ONLY export async functions, so these
// constants/types live here and are imported by both the server action and the
// client components.

export type YieldStatus = "pending" | "active" | "closed"

/** Risk classification bands shown to professional investors. */
export const YIELD_RISK_CLASSES = [
  "Conservative",
  "Moderate",
  "Balanced",
  "Growth",
  "Speculative",
] as const
export type YieldRiskClass = (typeof YIELD_RISK_CLASSES)[number]

/** Program families the administrator can classify a yield under. */
export const YIELD_TYPES = [
  "Fixed Deposit Note",
  "Structured Note",
  "Medium Term Note (MTN)",
  "Private Placement Program",
  "Money Market Facility",
  "Fixed Income Bond",
  "Managed Yield Portfolio",
] as const
export type YieldType = (typeof YIELD_TYPES)[number]

export const YIELD_FREQUENCIES = ["Monthly", "Quarterly", "Semi-Annual", "Annual", "At Maturity"] as const

export interface InstitutionalYield {
  id: string
  bankKey: string
  bankName: string
  bankBic: string
  bankCountry: string
  programName: string
  yieldType: string
  expectedReturn: string
  returnFrequency: string
  termLabel: string
  termMonths: number | null
  currency: string
  minInvestment: number
  riskClass: string
  rating: string
  status: YieldStatus
  description: string
  terms: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface PublishYieldInput {
  bankKey: string
  programName: string
  yieldType: string
  expectedReturn: string
  returnFrequency: string
  termLabel: string
  termMonths?: number | null
  currency: string
  minInvestment: number
  riskClass: string
  rating?: string
  status?: YieldStatus
  description: string
  terms?: string
}

export interface UpdateYieldInput extends PublishYieldInput {
  id: string
}

export type YieldResult =
  | { ok: true; yields: InstitutionalYield[] }
  | { ok: false; error: string }

export type PublishYieldResult =
  | { ok: true; yield: InstitutionalYield; yields: InstitutionalYield[] }
  | { ok: false; error: string }
