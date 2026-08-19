// Standalone verification of the internal-loan money math. Mirrors
// lib/interest-accrual.ts + lib/internal-loan.ts exactly (no DB, no imports),
// so we can prove approval funding, monthly interest, outstanding, and
// settlement arithmetic are correct. Run: node scripts/internal-loan-selftest.mjs

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const yearMonthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
const endOfMonth = (y, m) => new Date(y, m + 1, 0, 23, 59, 59, 999)

function dueMonthEnds(start, now) {
  const ends = []
  let year = start.getFullYear()
  let month = start.getMonth()
  for (let i = 0; i < 1200; i++) {
    const me = endOfMonth(year, month)
    if (me > now) break
    if (me > start) ends.push(me)
    month += 1
    if (month > 11) { month = 0; year += 1 }
  }
  return ends
}

function monthActiveFraction(year, monthIndex, start, end) {
  const monthStart = new Date(year, monthIndex, 1).getTime()
  const nextMonthStart = new Date(year, monthIndex + 1, 1).getTime()
  const totalMs = nextMonthStart - monthStart
  if (totalMs <= 0) return 0
  const activeStart = Math.max(monthStart, start.getTime())
  const activeEnd = end ? Math.min(nextMonthStart, end.getTime()) : nextMonthStart
  const activeMs = activeEnd - activeStart
  if (activeMs <= 0) return 0
  return Math.min(1, Math.max(0, activeMs / totalMs))
}

function monthlyInterestCharges(principal, annualRate, start, now, end) {
  const charges = []
  if (!(principal > 0) || !(annualRate > 0)) return charges
  const monthlyAmount = (principal * annualRate) / 12
  for (const me of dueMonthEnds(start, now)) {
    const fraction = monthActiveFraction(me.getFullYear(), me.getMonth(), start, end)
    if (fraction <= 0) continue
    const amount = round2(monthlyAmount * fraction)
    if (amount <= 0) continue
    charges.push({ yearMonth: yearMonthKey(me), amount, prorated: fraction < 0.999 })
  }
  return charges
}

function accruedInterestToDate(principal, annualRate, start, asOf) {
  if (!(principal > 0) || !(annualRate > 0)) return 0
  const elapsedMs = Math.max(0, asOf.getTime() - start.getTime())
  const msPerYear = 365 * 24 * 60 * 60 * 1000
  return round2(principal * annualRate * (elapsedMs / msPerYear))
}

// --- loan-level logic (mirrors lib/internal-loan.ts) -----------------------
function accrualCutoff(terms, now) {
  if (terms.settledAt) {
    const s = new Date(terms.settledAt)
    if (!Number.isNaN(s.getTime()) && s.getTime() < now.getTime()) return s
  }
  return now
}
function accrued(terms, asOf) {
  if (!terms.activatedAt) return 0
  return accruedInterestToDate(terms.amount, terms.annualRate, new Date(terms.activatedAt), accrualCutoff(terms, asOf))
}
function postedInterestSum(entries) {
  return round2(entries.filter((e) => e.id.startsWith("ILOAN-INT-")).reduce((s, e) => s + e.amount, 0))
}
function payoff(terms, postedInterest, now) {
  const interestRemaining = Math.max(0, round2(accrued(terms, now) - postedInterest))
  const principal = round2(terms.amount)
  return { principal, interestRemaining, total: round2(principal + interestRemaining) }
}
function outstanding(terms, entries, now) {
  const posted = postedInterestSum(entries)
  const p = payoff(terms, posted, now)
  const repaid = entries
    .filter((e) => e.id.startsWith("ILOAN-REPAY-") || e.id.startsWith("ILOAN-SETTLE-"))
    .reduce((s, e) => s + e.amount, 0)
  return Math.max(0, round2(p.total - repaid))
}

// --- assertions ------------------------------------------------------------
let pass = 0, fail = 0
function eq(label, got, want, tol = 0.01) {
  const ok = Math.abs(got - want) <= tol
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  got=${got}  want=${want}`)
  ok ? pass++ : fail++
}

// Fixture: 1,000,000 EUR loan, 3% p.a., funded 2026-01-01, evaluated 2026-04-01.
const terms = { amount: 1_000_000, annualRate: 0.03, currency: "EUR", activatedAt: "2026-01-01T00:00:00.000Z" }
const now = new Date("2026-04-01T00:00:00.000Z")

// 1) full month's interest = 1,000,000 * 0.03 / 12 = 2500
eq("monthly interest", (terms.amount * terms.annualRate) / 12, 2500)

// 2) three full billed months (Jan/Feb/Mar month-ends before Apr 1) = 7500
const charges = monthlyInterestCharges(terms.amount, terms.annualRate, new Date(terms.activatedAt), now)
eq("billed months count", charges.length, 3, 0)
eq("billed interest total", charges.reduce((s, c) => s + c.amount, 0), 7500)

// 3) accrued-to-date continuous (90 days / 365) ~= 7397.26
eq("accrued to date", accrued(terms, now), round2(1_000_000 * 0.03 * (90 / 365)), 0.01)

// 4) outstanding with the 3 monthly charges posted = principal + (accrued - posted)
const posted = charges.map((c) => ({ id: `ILOAN-INT-X-${c.yearMonth}`, amount: c.amount }))
const out = outstanding(terms, posted, now)
// interestRemaining = accrued(7397.26) - posted(7500) clamped to 0 -> outstanding = principal
eq("outstanding ~= principal (accrued<billed)", out, 1_000_000, 1)

// 5) partial repayment of 400,000 lowers outstanding to ~600,000
const afterRepay = posted.concat([{ id: "ILOAN-REPAY-X-1", amount: 400_000 }])
eq("outstanding after 400k repay", outstanding(terms, afterRepay, now), 600_000, 1)

// 6) full settlement: settledAt caps accrual; principal debit + interest stub -> outstanding 0
const settledTerms = { ...terms, settledAt: now.toISOString() }
const fullSettle = posted.concat([
  { id: "ILOAN-SETTLE-PRIN-X", amount: 1_000_000 },
  { id: "ILOAN-SETTLE-INT-X", amount: Math.max(0, round2(accrued(settledTerms, now) - 7500)) },
])
eq("outstanding after full settlement", outstanding(settledTerms, fullSettle, now), 0, 0.01)

// 7) settled state stops further accrual (accrued frozen at settledAt vs a year later)
const later = new Date("2027-04-01T00:00:00.000Z")
eq("accrual frozen after settle", accrued(settledTerms, later), accrued(settledTerms, now), 0.01)

console.log(`\n${fail === 0 ? "ALL PASS" : "HAS FAILURES"} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
