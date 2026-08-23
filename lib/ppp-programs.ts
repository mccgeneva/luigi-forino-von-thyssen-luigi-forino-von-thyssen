// Shared definitions for the built-in PPP / Yield programs shown to customers.
//
// These four programs used to be hardcoded inside the customer page and were
// therefore NOT controllable by the administrator. They now live here so BOTH
// the customer page and the admin "Program Controls" manager import the same
// source of truth, and the admin can override any displayed field (including
// the risk level) or hide a program entirely via `yield_program_overrides`.

export type ProgramStatus = "open" | "limited" | "invite" | "closed"

export interface BuiltInProgram {
  id: string
  name: string
  type: string
  minInvestment: number
  maxInvestment: number
  currency: string
  expectedReturn: string
  returnFrequency: string
  duration: string
  status: ProgramStatus
  spotsAvailable: number
  totalSpots: number
  riskLevel: string
  description: string
  requirements: string[]
}

/**
 * Administrator overrides for a built-in program. Every field is optional /
 * nullable: a `null` (or absent) value means "use the built-in default", so the
 * admin only stores the parameters they actually changed. `hidden` removes the
 * program from the customer's view without deleting the definition.
 */
export interface YieldProgramOverride {
  programId: string
  hidden: boolean
  name: string | null
  expectedReturn: string | null
  returnFrequency: string | null
  minInvestment: number | null
  maxInvestment: number | null
  duration: string | null
  status: ProgramStatus | null
  riskLevel: string | null
  description: string | null
  spotsAvailable: number | null
  totalSpots: number | null
}

export const PPP_PROGRAMS: BuiltInProgram[] = [
  {
    id: "PPP-MICRO-001",
    name: "Micro Cap Program",
    type: "micro",
    minInvestment: 50000000,
    maxInvestment: 100000000,
    currency: "USD",
    expectedReturn: "20-40%",
    returnFrequency: "Monthly",
    duration: "12 months",
    status: "open",
    spotsAvailable: 3,
    totalSpots: 10,
    riskLevel: "Medium",
    description:
      "Entry-level PPP designed for investors starting with $50M. Monthly returns with quarterly compounding options.",
    requirements: ["PRO or Avant-Garde account", "Cash funds or AAA+ rated instruments", "12-month commitment"],
  },
  {
    id: "PPP-SMALL-002",
    name: "Small Cap Program",
    type: "small",
    minInvestment: 100000000,
    maxInvestment: 500000000,
    currency: "USD",
    expectedReturn: "40-60%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "open",
    spotsAvailable: 5,
    totalSpots: 8,
    riskLevel: "Medium",
    description:
      "Standard PPP for qualified investors. Monthly distributions with reinvestment options available.",
    requirements: ["PRO or Avant-Garde account", "Cash funds or Securities (BG/SBLC/MTN)", "40-week commitment"],
  },
  {
    id: "PPP-MID-003",
    name: "Mid Cap Program",
    type: "mid",
    minInvestment: 500000000,
    maxInvestment: 1000000000,
    currency: "USD",
    expectedReturn: "60-80%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "limited",
    spotsAvailable: 2,
    totalSpots: 5,
    riskLevel: "Medium-Low",
    description:
      "Premium program for substantial investments. Enhanced returns with priority execution.",
    requirements: ["Avant-Garde account required", "Verified source of funds", "Joint venture agreement"],
  },
  {
    id: "PPP-LARGE-004",
    name: "Large Cap Program",
    type: "large",
    minInvestment: 1000000000,
    maxInvestment: 5000000000,
    currency: "USD",
    expectedReturn: "80-100%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "invite",
    spotsAvailable: 1,
    totalSpots: 3,
    riskLevel: "High",
    description:
      "Exclusive program for institutional investors and major funds. Maximum returns with dedicated trading desk.",
    requirements: ["Avant-Garde account", "Direct relationship with trading desk"],
  },
]

/** Risk levels the admin can assign to a built-in program. */
export const PROGRAM_RISK_LEVELS = ["Low", "Medium-Low", "Medium", "Medium-High", "High", "Speculative"] as const

/** Availability statuses the admin can assign to a built-in program. */
export const PROGRAM_STATUSES: ProgramStatus[] = ["open", "limited", "invite", "closed"]

/**
 * Merge a built-in program with its administrator override. A field is only
 * replaced when the override provides a non-null value; otherwise the built-in
 * default is kept. The returned object also carries the `hidden` flag so the
 * customer page can filter hidden programs out.
 */
export function applyProgramOverride(
  base: BuiltInProgram,
  ov: YieldProgramOverride | undefined | null,
): BuiltInProgram & { hidden: boolean } {
  if (!ov) return { ...base, hidden: false }
  return {
    ...base,
    name: ov.name ?? base.name,
    expectedReturn: ov.expectedReturn ?? base.expectedReturn,
    returnFrequency: ov.returnFrequency ?? base.returnFrequency,
    minInvestment: ov.minInvestment ?? base.minInvestment,
    maxInvestment: ov.maxInvestment ?? base.maxInvestment,
    duration: ov.duration ?? base.duration,
    status: ov.status ?? base.status,
    riskLevel: ov.riskLevel ?? base.riskLevel,
    description: ov.description ?? base.description,
    spotsAvailable: ov.spotsAvailable ?? base.spotsAvailable,
    totalSpots: ov.totalSpots ?? base.totalSpots,
    hidden: ov.hidden,
  }
}
