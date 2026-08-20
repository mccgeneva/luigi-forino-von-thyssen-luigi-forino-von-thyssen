"use client"

import { useCallback, useMemo } from "react"
import { CalendarClock, TrendingDown, Receipt, Wallet } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjectFunding } from "@/lib/project-funding-store"
import { useMonetizationRequests } from "@/lib/monetization-requests-store"
import { useLeverageRequests } from "@/lib/leverage-requests-store"
import { useTreasury } from "@/lib/treasury-store"
import { useInternalLoans } from "@/lib/internal-loan-store"
import { useLedger } from "@/lib/ledger-store"
import { buildDebitSchedule, type DebitKind } from "@/lib/debit-schedule"
import { formatMoney } from "@/lib/fund-reservation"
import { DebitFacilities } from "@/components/dashboard/debits/debit-facilities"
import { DebitCalendar } from "@/components/dashboard/debits/debit-calendar"
import { DebitChargeList } from "@/components/dashboard/debits/debit-charge-list"
import { DebitScenarios } from "@/components/dashboard/debits/debit-scenarios"

export default function DebitsPage() {
  const { requests: funding, hydrated: fHydrated, refresh: refreshFunding } = useProjectFunding()
  const { requests: monetization, hydrated: mHydrated, refresh: refreshMonetization } = useMonetizationRequests()
  const { requests: leverage, hydrated: lHydrated, refresh: refreshLeverage } = useLeverageRequests()
  const { account: treasury, hydrated: tHydrated, refresh: refreshTreasury } = useTreasury()
  const { loans: internalLoans, hydrated: ilHydrated, refresh: refreshInternalLoans } = useInternalLoans()
  const { entries, hydrated: ledgerHydrated, refresh: refreshLedger } = useLedger()

  const hydrated = fHydrated && mHydrated && lHydrated && tHydrated && ilHydrated && ledgerHydrated

  // After a client termination / reconciliation, re-hydrate every source so the
  // ledger balance, posted charges, facility state and calendar all update at
  // once (the stores also poll on a 30s interval as a backstop).
  const onSettled = useCallback(() => {
    void refreshLedger()
    void refreshFunding()
    void refreshMonetization()
    void refreshLeverage()
    void refreshTreasury()
    void refreshInternalLoans()
  }, [refreshLedger, refreshFunding, refreshMonetization, refreshLeverage, refreshTreasury, refreshInternalLoans])

  const schedule = useMemo(() => {
    const postedIds = new Set(entries.map((e) => e.id))
    return buildDebitSchedule({
      funding,
      monetization,
      leverage,
      treasury,
      internalLoans,
      postedIds,
      horizonMonths: 12,
    })
  }, [funding, monetization, leverage, treasury, internalLoans, entries])

  const nextCharge = useMemo(
    () => schedule.charges.find((c) => c.upcoming) ?? null,
    [schedule.charges],
  )

  const activeKinds = useMemo<DebitKind[]>(
    () => Array.from(new Set(schedule.facilities.filter((f) => !f.closed).map((f) => f.kind))),
    [schedule.facilities],
  )

  const primaryCurrency = schedule.facilities[0]?.currency ?? "EUR"

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground text-balance">Debits &amp; Financing</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Every loan, leverage line and debit on this account — with the calendar of when each interest charge falls
          and how much, plus the conditions behind each debit.
        </p>
      </div>

      {!hydrated ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : !schedule.hasAny ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <Wallet className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No active financing</p>
            <p className="max-w-md text-xs text-muted-foreground text-pretty">
              This account currently carries no loans, leverage lines or treasury debits. When an AES facility, credit
              facility, leverage line or treasury financing is approved, its charges and calendar appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              icon={TrendingDown}
              label="Monthly run-rate"
              value={formatMoney(schedule.totals.monthlyRunRate, primaryCurrency)}
              hint="Combined full-month debit interest"
            />
            <SummaryCard
              icon={CalendarClock}
              label="Next charge"
              value={nextCharge ? formatMoney(nextCharge.amount, nextCharge.currency) : "—"}
              hint={
                nextCharge
                  ? new Date(nextCharge.date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })
                  : "No upcoming charges"
              }
            />
            <SummaryCard
              icon={Receipt}
              label="Settled to date"
              value={formatMoney(schedule.totals.postedTotal, primaryCurrency)}
              hint="Interest already charged"
            />
            <SummaryCard
              icon={Wallet}
              label="Upcoming (12 mo)"
              value={formatMoney(schedule.totals.upcomingTotal, primaryCurrency)}
              hint="Projected over the next year"
            />
          </div>

          {schedule.totals.currencies.length > 1 && (
            <p className="text-xs text-muted-foreground">
              Totals are shown in {primaryCurrency}. This account also carries facilities in{" "}
              {schedule.totals.currencies.filter((c) => c !== primaryCurrency).join(", ")}; see each facility for its own
              currency.
            </p>
          )}

          <DebitFacilities facilities={schedule.facilities} onSettled={onSettled} />
          <DebitCalendar charges={schedule.charges} />
          <DebitChargeList charges={schedule.charges} />
          <DebitScenarios activeKinds={activeKinds} />
        </>
      )}
    </div>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType
  label: string
  value: string
  hint: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <p className="text-lg font-bold text-foreground tabular-nums break-all">{value}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}
