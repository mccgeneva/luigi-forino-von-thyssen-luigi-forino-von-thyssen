"use client"

import { useMemo } from "react"
import Link from "next/link"
import { ChevronRight, CalendarClock, TrendingDown, Wallet } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useProjectFunding } from "@/lib/project-funding-store"
import { useMonetizationRequests } from "@/lib/monetization-requests-store"
import { useLeverageRequests } from "@/lib/leverage-requests-store"
import { useTreasury } from "@/lib/treasury-store"
import { useLedger } from "@/lib/ledger-store"
import { buildDebitSchedule } from "@/lib/debit-schedule"
import { formatMoney } from "@/lib/fund-reservation"

/**
 * Profile "Debits & Credits" field — a live summary of the account's financing
 * that links through to the dedicated Debits & Financing page.
 */
export function DebitProfileCard() {
  const { requests: funding, hydrated: fHydrated } = useProjectFunding()
  const { requests: monetization, hydrated: mHydrated } = useMonetizationRequests()
  const { requests: leverage, hydrated: lHydrated } = useLeverageRequests()
  const { account: treasury, hydrated: tHydrated } = useTreasury()
  const { entries, hydrated: ledgerHydrated } = useLedger()

  const hydrated = fHydrated && mHydrated && lHydrated && tHydrated && ledgerHydrated

  const schedule = useMemo(() => {
    const postedIds = new Set(entries.map((e) => e.id))
    return buildDebitSchedule({ funding, monetization, leverage, treasury, postedIds, horizonMonths: 12 })
  }, [funding, monetization, leverage, treasury, entries])

  const nextCharge = schedule.charges.find((c) => c.upcoming) ?? null
  const activeCount = schedule.facilities.filter((f) => !f.closed).length
  const primaryCurrency = schedule.facilities[0]?.currency ?? "EUR"

  return (
    <Card className="transition-colors hover:border-primary">
      <Link href="/dashboard/debits" className="block">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wallet className="h-4 w-4" /> Debits &amp; Credits
              </CardTitle>
              <CardDescription>Loans, leverage &amp; scheduled debit interest</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {hydrated && activeCount > 0 && (
                <Badge className="bg-primary text-primary-foreground">{activeCount} active</Badge>
              )}
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!hydrated ? (
            <p className="text-sm text-muted-foreground">Loading financing summary…</p>
          ) : !schedule.hasAny ? (
            <p className="text-sm text-muted-foreground">
              No active loans, leverage lines or treasury debits. Open to learn how each debit works.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-start gap-2">
                <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Monthly run-rate</p>
                  <p className="text-sm font-semibold text-foreground tabular-nums break-all">
                    {formatMoney(schedule.totals.monthlyRunRate, primaryCurrency)}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Next charge</p>
                  <p className="text-sm font-semibold text-foreground tabular-nums break-all">
                    {nextCharge
                      ? `${formatMoney(nextCharge.amount, nextCharge.currency)} · ${new Date(
                          nextCharge.date,
                        ).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`
                      : "—"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Link>
    </Card>
  )
}
