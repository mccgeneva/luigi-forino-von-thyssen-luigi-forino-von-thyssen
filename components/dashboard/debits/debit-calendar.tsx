"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatMoney } from "@/lib/fund-reservation"
import type { DebitCharge } from "@/lib/debit-schedule"

interface MonthCell {
  key: string // YYYY-MM
  label: string // "Jul 2026"
  total: number
  currency: string
  count: number
  posted: boolean
  hasUpcoming: boolean
  isCurrent: boolean
}

/**
 * Year-at-a-glance month grid. Every month between the first charge and the
 * projection horizon is a cell showing the total debited/projected that month
 * and whether it is already posted or upcoming.
 */
export function DebitCalendar({ charges, now = new Date() }: { charges: DebitCharge[]; now?: Date }) {
  const months = useMemo<MonthCell[]>(() => {
    if (charges.length === 0) return []
    const map = new Map<string, MonthCell>()
    // Primary currency = the most common across charges (grid totals are shown
    // in that currency; mixed-currency months are still summed for a headline).
    const currency = charges[0]?.currency ?? "EUR"
    const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

    for (const c of charges) {
      const existing = map.get(c.yearMonth)
      const d = new Date(c.date)
      const label = d.toLocaleDateString("en-GB", { month: "short", year: "numeric" })
      if (existing) {
        existing.total += c.amount
        existing.count += 1
        existing.posted = existing.posted && c.posted
        existing.hasUpcoming = existing.hasUpcoming || c.upcoming
      } else {
        map.set(c.yearMonth, {
          key: c.yearMonth,
          label,
          total: c.amount,
          currency,
          count: 1,
          posted: c.posted,
          hasUpcoming: c.upcoming,
          isCurrent: c.yearMonth === nowKey,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key))
  }, [charges, now])

  if (months.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Charge calendar</CardTitle>
        <CardDescription>
          When each monthly debit falls and how much. Past charges are settled; upcoming ones are projected at today&apos;s
          principal and rate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {months.map((m) => (
            <div
              key={m.key}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 transition-colors",
                m.hasUpcoming
                  ? "border-primary/40 bg-primary/5"
                  : "border-border bg-secondary/30",
                m.isCurrent && "ring-2 ring-primary/50",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium text-muted-foreground">{m.label}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "px-1.5 py-0 text-[10px]",
                    m.hasUpcoming ? "border-primary/40 text-primary" : "text-muted-foreground",
                  )}
                >
                  {m.hasUpcoming ? "Due" : "Paid"}
                </Badge>
              </div>
              <span className="text-sm font-semibold text-foreground tabular-nums break-all">
                {formatMoney(m.total, m.currency)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {m.count} {m.count === 1 ? "charge" : "charges"}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm border border-border bg-secondary/60" /> Settled
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm border border-primary/40 bg-primary/10" /> Upcoming
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm ring-2 ring-primary/50" /> Current month
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
