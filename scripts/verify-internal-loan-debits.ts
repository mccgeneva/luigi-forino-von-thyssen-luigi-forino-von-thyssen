/**
 * Standalone verification of internal loans in the Debits & Financing engines.
 * Run: npx tsx scripts/verify-internal-loan-debits.ts   (deleted after use)
 */
import { buildDebitSchedule } from "@/lib/debit-schedule"
import { buildTerminationPlan, quoteFacility } from "@/lib/debit-settlement"
import { monthlyInternalLoanInterest, readInternalLoanTerms, internalLoanApprovalShim } from "@/lib/internal-loan"

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.log("[v0] FAIL:", msg)
    process.exitCode = 1
  } else {
    console.log("[v0] ok:", msg)
  }
}

// A loan funded 90 days ago: EUR 5,000,000 at 3% p.a.
const activatedAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
const loan = {
  id: "ILOAN-LOCAL-1",
  approvalId: "APPR-ILOAN-LOCAL-1",
  amount: 5_000_000,
  currency: "EUR",
  annualRate: 0.03,
  purpose: "Working capital",
  status: "approved",
  submittedAt: activatedAt,
  decidedAt: activatedAt,
  activatedAt,
}

// 1) Schedule aggregation
const sched = buildDebitSchedule({
  funding: [],
  monetization: [],
  leverage: [],
  treasury: null,
  internalLoans: [loan],
  postedIds: new Set<string>(),
  horizonMonths: 12,
})

const fac = sched.facilities.find((f) => f.kind === "internal_loan")
assert(!!fac, "internal loan appears as a facility on the debits schedule")
const expectedMonthly = monthlyInternalLoanInterest(readInternalLoanTerms(internalLoanApprovalShim(loan))!)
assert(
  !!fac && Math.abs(fac.monthlyAmount - expectedMonthly) < 0.01,
  `monthly run-rate = 5,000,000 * 3% / 12 = ${expectedMonthly.toFixed(2)} (got ${fac?.monthlyAmount})`,
)
assert(sched.monthlyRunRate >= expectedMonthly - 0.01, "combined monthly run-rate includes the loan interest")
assert(sched.charges.some((c) => c.kind === "internal_loan"), "interest charges show on the calendar")
assert(!!fac && fac.settleable === true, "facility is marked settleable (has approvalId, not closed)")

// 2) Termination quote + plan
const q = quoteFacility({ kind: "internal_loan", facilityId: loan.approvalId, records: { internalLoans: [loan] } })
assert(!!q, "quoteFacility returns a quote for the internal loan")
assert(!!q && Math.abs(q.principal - 5_000_000) < 0.01, `payoff principal = 5,000,000 (got ${q?.principal})`)
assert(!!q && q.interestTail >= 0, `interest tail is non-negative (got ${q?.interestTail})`)

const plan = buildTerminationPlan({ kind: "internal_loan", facilityId: loan.approvalId, records: { internalLoans: [loan] } })
assert(!!plan, "buildTerminationPlan returns a plan")
if (plan) {
  const hasPrin = plan.settlementPosts.some((p) => p.entry.id === `ILOAN-SETTLE-PRIN-${loan.approvalId}`)
  const hasInt = plan.settlementPosts.some((p) => p.entry.id === `ILOAN-SETTLE-INT-${loan.approvalId}`)
  assert(hasPrin, "settlement posts the principal return leg (ILOAN-SETTLE-PRIN-*)")
  assert(hasInt || q!.interestTail === 0, "settlement posts the interest tail leg when interest is outstanding")
  assert(plan.closePatch.status === "closed" && !!plan.closePatch.settledAt, "close patch marks loan closed + settledAt")
  const totalSettled = plan.settlementPosts.reduce((s, p) => s + p.entry.amount, 0)
  console.log(`[v0] total settled on repayment = EUR ${totalSettled.toFixed(2)} (principal + interest tail)`)
}

console.log(process.exitCode ? "[v0] VERIFICATION FAILED" : "[v0] VERIFICATION PASSED")
