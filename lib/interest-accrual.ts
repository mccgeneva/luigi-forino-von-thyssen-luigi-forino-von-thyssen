// ---------------------------------------------------------------------------
// Shared debit-interest accrual engine.
//
// Both Project Funding (1.8% p.a. cost of capital) and Special Treasury
// Financing (3% p.a.) charge a monthly debit interest that:
//   • begins accruing on the EXACT day the funds are credited,
//   • is charged as (annual rate / 12) per full calendar month, and
//   • is PRO-RATED for partial months at the start (funding date) and end
//     (repayment/settlement date) of the financing.
//
// This module holds the pure, framework-free date math so the two financing
// products share one audited implementation. Charges are posted lazily at each
// elapsed calendar month-end (there is no server scheduler), and every charge
// carries a deterministic id so reconciliation never double-posts.
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (currency minor units). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Format a Date as `YYYY-MM` (calendar month key). */
export function yearMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

/** Last instant of the calendar month that `year`/`monthIndex` (0-based) falls in. */
export function endOfMonth(year: number, monthIndex: number): Date {
  // Day 0 of the next month = last day of this month.
  return new Date(year, monthIndex + 1, 0, 23, 59, 59, 999)
}

/**
 * Every calendar month-end strictly after `start` and on/before `now`.
 * These are the month-ends at which a debit interest charge becomes due.
 */
export function dueMonthEnds(start: Date, now: Date): Date[] {
  const ends: Date[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return ends
  let year = start.getFullYear()
  let month = start.getMonth()
  // Walk month-ends forward until we pass `now`. Cap iterations defensively.
  for (let i = 0; i < 1200; i++) {
    const monthEnd = endOfMonth(year, month)
    if (monthEnd > now) break
    if (monthEnd > start) ends.push(monthEnd)
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }
  return ends
}

/**
 * Fraction (0–1) of the calendar month `year`/`monthIndex` during which the
 * financing was active, given it started at `start` and (optionally) ended at
 * `end`. A full month returns 1; the funding month and a settlement month
 * return their pro-rata share computed to the millisecond.
 */
export function monthActiveFraction(year: number, monthIndex: number, start: Date, end?: Date): number {
  const monthStart = new Date(year, monthIndex, 1, 0, 0, 0, 0).getTime()
  const nextMonthStart = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0).getTime()
  const totalMs = nextMonthStart - monthStart
  if (totalMs <= 0) return 0

  const activeStart = Math.max(monthStart, start.getTime())
  const activeEnd = end ? Math.min(nextMonthStart, end.getTime()) : nextMonthStart
  const activeMs = activeEnd - activeStart
  if (activeMs <= 0) return 0
  return Math.min(1, Math.max(0, activeMs / totalMs))
}

/** A single due monthly interest charge produced by the accrual walk. */
export interface MonthlyInterestCharge {
  /** Calendar month key, e.g. "2026-03". */
  yearMonth: string
  /** Month-end instant the charge is dated/posted at. */
  date: Date
  /** Pro-rata fraction of the month that was active (1 for a full month). */
  fraction: number
  /** Charge amount for this month (monthly amount × fraction), rounded. */
  amount: number
  /** True when this month was charged at less than a full month (pro-rata). */
  prorated: boolean
}

/**
 * Walk every elapsed calendar month from `start` to `now` and return the due
 * monthly interest charge for each. `monthlyAmount` is the full-month figure
 * (principal × annualRate / 12); partial months are scaled by their active
 * fraction. An optional `end` date pro-rates the final settlement month.
 */
export function monthlyInterestCharges(
  principal: number,
  annualRate: number,
  start: Date,
  now: Date = new Date(),
  end?: Date,
): MonthlyInterestCharge[] {
  const charges: MonthlyInterestCharge[] = []
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return charges
  if (!(principal > 0) || !(annualRate > 0)) return charges
  const monthlyAmount = (principal * annualRate) / 12

  for (const monthEnd of dueMonthEnds(start, now)) {
    const fraction = monthActiveFraction(monthEnd.getFullYear(), monthEnd.getMonth(), start, end)
    if (fraction <= 0) continue
    const amount = round2(monthlyAmount * fraction)
    if (amount <= 0) continue
    charges.push({
      yearMonth: yearMonthKey(monthEnd),
      date: monthEnd,
      fraction,
      amount,
      prorated: fraction < 0.999,
    })
  }
  return charges
}

/**
 * Interest accrued from `start` up to `asOf` (default now), INCLUDING the
 * in-progress current month pro-rated to `asOf`. Use this for "accrued to date"
 * displays — it counts continuously, not only at month-ends.
 */
export function accruedInterestToDate(
  principal: number,
  annualRate: number,
  start: Date,
  asOf: Date = new Date(),
): number {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return 0
  if (!(principal > 0) || !(annualRate > 0)) return 0
  const elapsedMs = Math.max(0, asOf.getTime() - start.getTime())
  const msPerYear = 365 * 24 * 60 * 60 * 1000
  return round2(principal * annualRate * (elapsedMs / msPerYear))
}

/**
 * The full monthly interest amount for the next charge (principal × rate / 12),
 * i.e. the upcoming charge a client should expect at the next month-end.
 */
export function monthlyInterestAmount(principal: number, annualRate: number): number {
  if (!(principal > 0) || !(annualRate > 0)) return 0
  return round2((principal * annualRate) / 12)
}

/**
 * The next calendar month-end strictly after `from` — i.e. the date the client
 * should expect their next monthly interest deduction. If `from` is itself a
 * month-end, this returns the FOLLOWING month-end.
 */
export function nextMonthEndAfter(from: Date = new Date()): Date {
  const thisMonthEnd = endOfMonth(from.getFullYear(), from.getMonth())
  if (thisMonthEnd > from) return thisMonthEnd
  return endOfMonth(from.getFullYear(), from.getMonth() + 1)
}
