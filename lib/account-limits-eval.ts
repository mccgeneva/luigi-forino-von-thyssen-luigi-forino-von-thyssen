/**
 * Pure, client-safe evaluation of account spending limits.
 *
 * No "server-only" / DB imports live here so the SAME logic is used by:
 *  - the authoritative server gate in submitApproval (app/actions/approvals.ts), and
 *  - the friendly client pre-check on the Payments page.
 *
 * The Daily Limit and Monthly Volume are configured per user (or platform-wide)
 * by an administrator. Enforcement rules:
 *  - "Unlimited" (the flag) means no cap on that figure.
 *  - An amount of 0 (or less) with Unlimited OFF means "not configured" → NO cap.
 *    Only a POSITIVE amount is an enforced cap. This makes the default state
 *    (0 / not unlimited) safe: it never silently blocks payments until an
 *    administrator sets a real number.
 *  - All amounts are compared in the limit's own currency; callers convert first.
 */

export interface LimitFigures {
  dailyLimitAmount: number
  dailyLimitUnlimited: boolean
  monthlyVolumeAmount: number
  monthlyVolumeUnlimited: boolean
  currency: string
}

export interface LimitAssessment {
  ok: boolean
  /** Which window blocked the payment, when !ok. */
  window?: "daily" | "monthly"
  /** The enforced cap for that window (in the limit currency). */
  cap: number
  /** Total already committed in that window BEFORE this payment. */
  used: number
  /** This payment's value (in the limit currency). */
  attempted: number
  /** Remaining allowance in that window (never negative). */
  remaining: number
  currency: string
}

/**
 * The enforced cap for a figure, or null when there is NO cap (unlimited, or a
 * non-positive "unset" amount).
 */
export function limitCap(amount: number, unlimited: boolean): number | null {
  if (unlimited) return null
  if (!(amount > 0)) return null
  return amount
}

/** One-cent tolerance so rounding never falsely trips the cap. */
const EPSILON = 0.01

/**
 * Assess an outgoing payment against the daily and monthly caps. `amount`,
 * `priorDailyTotal`, and `priorMonthlyTotal` must already be expressed in the
 * limit's currency. The daily window is checked first, then the monthly window.
 */
export function assessPaymentAgainstLimits(args: {
  limits: LimitFigures
  priorDailyTotal: number
  priorMonthlyTotal: number
  amount: number
}): LimitAssessment {
  const { limits, priorDailyTotal, priorMonthlyTotal, amount } = args
  const daily = limitCap(limits.dailyLimitAmount, limits.dailyLimitUnlimited)
  const monthly = limitCap(limits.monthlyVolumeAmount, limits.monthlyVolumeUnlimited)

  if (daily != null && priorDailyTotal + amount > daily + EPSILON) {
    return {
      ok: false,
      window: "daily",
      cap: daily,
      used: priorDailyTotal,
      attempted: amount,
      remaining: Math.max(0, daily - priorDailyTotal),
      currency: limits.currency,
    }
  }

  if (monthly != null && priorMonthlyTotal + amount > monthly + EPSILON) {
    return {
      ok: false,
      window: "monthly",
      cap: monthly,
      used: priorMonthlyTotal,
      attempted: amount,
      remaining: Math.max(0, monthly - priorMonthlyTotal),
      currency: limits.currency,
    }
  }

  return {
    ok: true,
    cap: daily ?? monthly ?? 0,
    used: 0,
    attempted: amount,
    remaining: 0,
    currency: limits.currency,
  }
}

/** Format a money figure in the limit currency for user-facing messages. */
export function formatLimitMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Build the standard hard-block message shown when a payment exceeds a limit. */
export function limitBlockMessage(a: LimitAssessment): string {
  const windowLabel = a.window === "daily" ? "daily limit" : "monthly volume limit"
  const sent = a.window === "daily" ? "already sent today" : "already used this month"
  return (
    `This payment exceeds your ${windowLabel}. ` +
    `Your ${a.window === "daily" ? "daily" : "monthly"} cap is ${formatLimitMoney(a.cap, a.currency)}, ` +
    `you have ${sent} ${formatLimitMoney(a.used, a.currency)}, ` +
    `so only ${formatLimitMoney(a.remaining, a.currency)} remains — ` +
    `but this payment is ${formatLimitMoney(a.attempted, a.currency)}.`
  )
}
