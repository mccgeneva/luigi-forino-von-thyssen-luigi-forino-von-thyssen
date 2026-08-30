// Client-safe computation of the ROI / payout explanation shown on demand for an
// active Yield / PPP program (the "ROI details" info button + PDF on the card).
//
// It mirrors EXACTLY the logic of the server ROI engine (`lib/ppp-yield.ts`
// `buildPppRoiPosts`) so the numbers the client sees here equal what actually
// posts to their Master Account:
//   • rate     = lower bound parsed from the expected-return string
//   • cycle    = parsed from the return-frequency ("weekly", "monthly", …)
//   • in arrears — first payout ONE full cycle after activation, then each cycle,
//                  bounded by the program term (parsed from the duration)
//   • 75/25 split when funded by an MCC HOLDING SA-owned instrument
//   • leverage-funded ROI is credited but LOCKED until the program matures
//
// Self-contained (no server-only imports) so it is safe in the client bundle.

export type PppRoiPeriodUnit = "day" | "week" | "month" | "quarter" | "year" | "maturity"

export interface PppRoiInfoInput {
  amount: number
  currency: string
  expectedReturn: string
  returnFrequency: string
  duration: string
  /** Activation instant (approval date if present, else submission date). */
  activationIso: string
  fundingInstrumentId?: string
  fundingInstrumentLabel?: string
  mccBenefitRate?: number
  clientBenefitRate?: number
  leverageFunded?: boolean
}

export interface PppRoiInfo {
  currency: string
  amount: number
  ratePct: number
  periodUnit: PppRoiPeriodUnit
  periodLabel: string
  activation: Date
  termEnd: Date
  firstPayout: Date
  /** The next payout still in the future (or the single maturity payout). */
  nextPayout: Date
  /** Number of payout events across the whole term. */
  periodsInTerm: number
  /** How many payouts have already matured by now. */
  periodsElapsed: number
  grossPerPeriod: number
  hasSplit: boolean
  clientRatePct: number
  mccRatePct: number
  clientPerPeriod: number
  mccPerPeriod: number
  /** Total the client will receive across the full term (their share). */
  totalClientProjected: number
  cashFunded: boolean
  leverageFunded: boolean
  /** True when each ROI credit is immediately withdrawable/spendable. */
  withdrawable: boolean
  fundingInstrumentLabel?: string
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function parseRatePct(expectedReturn: string | undefined): number {
  if (!expectedReturn) return 0
  const m = expectedReturn.match(/\d+(\.\d+)?/)
  const pct = m ? Number.parseFloat(m[0]) : 0
  return Number.isFinite(pct) && pct > 0 ? pct : 0
}

export function parsePeriodUnit(returnFrequency: string | undefined): PppRoiPeriodUnit {
  const f = (returnFrequency ?? "").toLowerCase()
  if (f.includes("matur")) return "maturity"
  if (f.includes("day") || f.includes("daily")) return "day"
  if (f.includes("week")) return "week"
  if (f.includes("quarter")) return "quarter"
  if (f.includes("year") || f.includes("annual")) return "year"
  if (f.includes("month")) return "month"
  return "month"
}

export function periodUnitLabel(unit: PppRoiPeriodUnit): string {
  switch (unit) {
    case "day":
      return "daily"
    case "week":
      return "weekly"
    case "quarter":
      return "quarterly"
    case "year":
      return "annual"
    case "maturity":
      return "at maturity"
    case "month":
    default:
      return "monthly"
  }
}

function addMonths(base: Date, n: number): Date {
  const d = new Date(base.getTime())
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, daysInMonth))
  return d
}

function addPeriods(start: Date, n: number, unit: PppRoiPeriodUnit): Date {
  switch (unit) {
    case "day":
      return new Date(start.getTime() + n * 24 * 60 * 60 * 1000)
    case "week":
      return new Date(start.getTime() + n * 7 * 24 * 60 * 60 * 1000)
    case "quarter":
      return addMonths(start, n * 3)
    case "year":
      return addMonths(start, n * 12)
    case "month":
    default:
      return addMonths(start, n)
  }
}

function parseTermEnd(duration: string | undefined, activation: Date): Date {
  const s = (duration ?? "").toLowerCase()
  const m = s.match(/(\d+(\.\d+)?)/)
  const n = m ? Number.parseFloat(m[0]) : NaN
  if (!Number.isFinite(n) || n <= 0) return addMonths(activation, 12)
  if (s.includes("day")) return new Date(activation.getTime() + n * 24 * 60 * 60 * 1000)
  if (s.includes("week")) return new Date(activation.getTime() + n * 7 * 24 * 60 * 60 * 1000)
  if (s.includes("quarter")) return addMonths(activation, Math.round(n) * 3)
  if (s.includes("year") || s.includes("annual")) return addMonths(activation, Math.round(n) * 12)
  if (s.includes("month")) return addMonths(activation, Math.round(n))
  return addMonths(activation, 12)
}

const MAX_PERIODS = 1040

export function computePppRoiInfo(input: PppRoiInfoInput, now: Date = new Date()): PppRoiInfo {
  const currency = input.currency || "USD"
  const amount = Number.isFinite(input.amount) ? input.amount : 0
  const ratePct = parseRatePct(input.expectedReturn)
  const periodUnit = parsePeriodUnit(input.returnFrequency)

  const activation = new Date(input.activationIso)
  const safeActivation = Number.isNaN(activation.getTime()) ? new Date() : activation
  const termEnd = parseTermEnd(input.duration, safeActivation)

  const grossPerPeriod = round2((amount * ratePct) / 100)
  // The 75/25 benefit split applies ONLY when the program is funded by an
  // MCC HOLDING SA-owned instrument (acquired via "assign"). In that case the
  // server stamps mccBenefitRate/clientBenefitRate onto the record. A LEASED or
  // PURCHASED instrument (and cash) leaves those null → the client keeps 100%.
  // Detect the split from the actually-stored rates, NOT merely the presence of
  // a funding instrument (which is also set for leases/purchases).
  const storedClient = typeof input.clientBenefitRate === "number" ? input.clientBenefitRate : null
  const storedMcc = typeof input.mccBenefitRate === "number" ? input.mccBenefitRate : null
  const hasSplit = storedClient != null || storedMcc != null
  const clientRate = hasSplit ? (storedClient ?? (storedMcc != null ? 1 - storedMcc : 0.25)) : 1
  const mccRate = hasSplit ? (storedMcc ?? 1 - clientRate) : 0
  const clientPerPeriod = round2(grossPerPeriod * clientRate)
  const mccPerPeriod = round2(grossPerPeriod * mccRate)

  const nowMs = now.getTime()
  const termEndMs = termEnd.getTime()

  let periodsInTerm = 0
  let periodsElapsed = 0
  let firstPayout: Date
  let nextPayout: Date

  if (periodUnit === "maturity") {
    periodsInTerm = 1
    firstPayout = termEnd
    nextPayout = termEnd
    periodsElapsed = nowMs >= termEndMs ? 1 : 0
  } else {
    firstPayout = addPeriods(safeActivation, 1, periodUnit)
    nextPayout = firstPayout
    let foundNext = false
    for (let n = 1; n <= MAX_PERIODS; n++) {
      const d = addPeriods(safeActivation, n, periodUnit)
      if (d.getTime() > termEndMs) break
      periodsInTerm = n
      if (d.getTime() <= nowMs) {
        periodsElapsed = n
      } else if (!foundNext) {
        nextPayout = d
        foundNext = true
      }
    }
    // All payouts already matured → next meaningful date is the term end.
    if (!foundNext) nextPayout = termEnd
  }

  const totalClientProjected = round2(clientPerPeriod * periodsInTerm)
  const cashFunded = !input.fundingInstrumentId
  const leverageFunded = input.leverageFunded === true

  return {
    currency,
    amount,
    ratePct,
    periodUnit,
    periodLabel: periodUnitLabel(periodUnit),
    activation: safeActivation,
    termEnd,
    firstPayout,
    nextPayout,
    periodsInTerm,
    periodsElapsed,
    grossPerPeriod,
    hasSplit,
    clientRatePct: Math.round(clientRate * 100),
    mccRatePct: Math.round(mccRate * 100),
    clientPerPeriod,
    mccPerPeriod,
    totalClientProjected,
    cashFunded,
    leverageFunded,
    withdrawable: !leverageFunded,
    fundingInstrumentLabel: input.fundingInstrumentLabel,
  }
}
