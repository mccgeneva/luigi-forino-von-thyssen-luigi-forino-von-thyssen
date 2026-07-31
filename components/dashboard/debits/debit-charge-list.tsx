"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatMoney } from "@/lib/fund-reservation"
import { KIND_META } from "@/components/dashboard/debits/debit-meta"
import type { DebitCharge } from "@/lib/debit-schedule"

interface MonthGroup {
  key: string
  label: string
  charges: DebitCharge[]
}

/** Chronological list of every charge, grouped by calendar month. */
export function DebitChargeList({ charges }: { charges: DebitCharge[] }) {
  const groups = useMemo<MonthGroup[]>(() => {
    const map = new Map<string, MonthGroup>()
    for (const c of charges) {
      const label = new Date(c.date).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      const g = map.get(c.yearMonth)
      if (g) g.charges.push(c)
      else map.set(c.yearMonth, { key: c.yearMonth, label, charges: [c] })
    }
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key))
  }, [charges])

  if (charges.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Charge schedule</CardTitle>
        <CardDescription>Every past and projected monthly debit, in order.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {groups.map((group) => (
          <div key={group.key}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
              <Separator className="flex-1" />
            </div>
            <ul className="space-y-2">
              {group.charges.map((c) => {
                const meta = KIND_META[c.kind]
                const Icon = meta.icon
                return (
                  <li
                    key={c.id}
                    className="flex items-start gap-3 rounded-lg border border-border bg-secondary/20 p-3"
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        meta.iconWrap,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{c.category}</p>
                        <Badge
                          variant="outline"
                          className={cn(
                            "px-1.5 py-0 text-[10px]",
                            c.upcoming ? "border-primary/40 text-primary" : "text-muted-foreground",
                          )}
                        >
                          {c.upcoming ? "Upcoming" : "Settled"}
                        </Badge>
                        {c.prorated && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                            Pro-rated
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed break-words">{c.note}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatMoney(c.amount, c.currency)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(c.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
