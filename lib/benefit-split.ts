// ---------------------------------------------------------------------------
// Benefit-split calculator (server-safe, pure)
//
// Implements the 75 / 25 profit split that applies to investment RETURNS
// generated using an instrument that is owned by MCC HOLDING SA (i.e. one the
// client acquired via Reserve / Assign — see `lib/instrument-marketplace.ts`).
//
//   • MCC HOLDING SA keeps 75% of the return.
//   • The assignee client keeps 25% of the return.
//   • The client still pays 100% of the costs — costs are NEVER split here.
//
// No React imports and no "use client", so it is usable from client components
// and server routes alike.
// ---------------------------------------------------------------------------

import { MCC_BENEFIT_SHARE, CLIENT_BENEFIT_SHARE, MCC_HOLDING_OWNER } from "@/lib/instrument-marketplace"

export interface BenefitSplit {
  /** Gross return before the split (>= 0). */
  grossReturn: number
  /** Portion alienated to MCC HOLDING SA (75%). */
  mccShare: number
  /** Portion credited to the assignee client (25%). */
  clientShare: number
  /** Rate applied to MCC (0.75). */
  mccRate: number
  /** Rate applied to the client (0.25). */
  clientRate: number
  /** Owner label, for disclosure copy. */
  owner: string
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Split a gross investment return 75% MCC / 25% client. The client share is the
 * remainder after MCC's rounded share so the two always sum back to the gross
 * (no rounding leakage). Non-finite / negative input yields a zero split.
 */
export function computeBenefitSplit(grossReturn: number): BenefitSplit {
  const gross = Number.isFinite(grossReturn) && grossReturn > 0 ? grossReturn : 0
  const mccShare = round2(gross * MCC_BENEFIT_SHARE)
  const clientShare = round2(gross - mccShare)
  return {
    grossReturn: gross,
    mccShare,
    clientShare,
    mccRate: MCC_BENEFIT_SHARE,
    clientRate: CLIENT_BENEFIT_SHARE,
    owner: MCC_HOLDING_OWNER,
  }
}
