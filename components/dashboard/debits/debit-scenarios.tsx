"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CalendarClock, Percent, Play } from "lucide-react"
import { KIND_META } from "@/components/dashboard/debits/debit-meta"
import { DEBIT_SCENARIOS, type DebitKind } from "@/lib/debit-schedule"

/**
 * Explains the conditions of every debit scenario so a client understands why,
 * when and how much each product charges. `activeKinds` (the kinds this account
 * actually holds) are highlighted; all scenarios remain documented.
 */
export function DebitScenarios({ activeKinds }: { activeKinds: DebitKind[] }) {
  const kinds = Object.keys(DEBIT_SCENARIOS) as DebitKind[]
  const active = new Set(activeKinds)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How each debit works</CardTitle>
        <CardDescription>
          The conditions behind every debit scenario — the rate applied, when it is charged and when accrual starts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" defaultValue={activeKinds} className="w-full">
          {kinds.map((kind) => {
            const s = DEBIT_SCENARIOS[kind]
            const meta = KIND_META[kind]
            const Icon = meta.icon
            const isActive = active.has(kind)
            return (
              <AccordionItem key={kind} value={kind}>
                <AccordionTrigger className="text-left hover:no-underline">
                  <span className="flex items-center gap-3">
                    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", meta.iconWrap)}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">{s.title}</span>
                      <span className="text-xs text-muted-foreground">{s.rate}</span>
                    </span>
                    {isActive && (
                      <Badge className="ml-1 bg-primary px-1.5 py-0 text-[10px] text-primary-foreground">Active</Badge>
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Detail icon={Percent} label="Rate" value={s.rate} />
                    <Detail icon={CalendarClock} label="When charged" value={s.whenCharged} />
                    <Detail icon={Play} label="Accrual starts" value={s.accrualStart} />
                  </div>
                  <ul className="space-y-2">
                    {s.conditions.map((cond, i) => (
                      <li key={i} className="flex gap-2 text-xs text-muted-foreground leading-relaxed">
                        <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-primary" />
                        <span>{cond}</span>
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      </CardContent>
    </Card>
  )
}

function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xs text-foreground leading-relaxed">{value}</p>
    </div>
  )
}
