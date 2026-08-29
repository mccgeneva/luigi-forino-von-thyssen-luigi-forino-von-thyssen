"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatMoney } from "@/lib/fund-reservation"
import { KIND_META } from "@/components/dashboard/debits/debit-meta"
import { DebitFacilityActions } from "@/components/dashboard/debits/debit-facility-actions"
import { SettleAllButton } from "@/components/dashboard/debits/settle-all-button"
import type { DebitFacility } from "@/lib/debit-schedule"

/** The loans, leverage lines and debits this account carries. */
export function DebitFacilities({
  facilities,
  onSettled,
  autoTerminateId,
  onAutoTerminateHandled,
  onRequestTerminate,
}: {
  facilities: DebitFacility[]
  onSettled: () => void
  /** settleId of a facility whose Terminate dialog should auto-open. */
  autoTerminateId?: string | null
  onAutoTerminateHandled?: () => void
  /** Tapping an active facility card requests jumping straight to its settlement. */
  onRequestTerminate?: (settleId: string) => void
}) {
  if (facilities.length === 0) return null

  const active = facilities.filter((f) => !f.closed)
  const closed = facilities.filter((f) => f.closed)

  const renderFacility = (f: DebitFacility) => {
    const meta = KIND_META[f.kind]
    const Icon = meta.icon
    const settleId = f.kind === "treasury" ? f.id : f.approvalId
    const canJump = !f.closed && f.settleable && !!settleId
    return (
      <li
        key={`${f.kind}-${f.id}`}
        className={cn(
          "rounded-lg border border-border bg-secondary/20 p-4",
          canJump && "cursor-pointer transition-colors hover:border-destructive/50 hover:bg-secondary/40",
        )}
        role={canJump ? "button" : undefined}
        tabIndex={canJump ? 0 : undefined}
        onClick={canJump ? () => onRequestTerminate?.(settleId as string) : undefined}
        onKeyDown={
          canJump
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onRequestTerminate?.(settleId as string)
                }
              }
            : undefined
        }
      >
                <div className="flex items-start gap-3">
                  <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.iconWrap)}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{f.title}</p>
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                        {meta.short}
                      </Badge>
                      {f.closed && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                          Closed
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{meta.label}</p>
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Financed principal</dt>
                    <dd className="font-medium text-foreground tabular-nums break-all">
                      {formatMoney(f.principal, f.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Debit interest</dt>
                    <dd className="font-medium text-foreground">{f.rateLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Monthly charge</dt>
                    <dd className="font-medium text-foreground tabular-nums break-all">
                      {formatMoney(f.monthlyAmount, f.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Accruing since</dt>
                    <dd className="font-medium text-foreground">
                      {new Date(f.startDate).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </dd>
                  </div>
                </dl>

                {/* Stop card-level clicks from double-triggering when the user
                    taps the explicit Reconcile / Terminate buttons. */}
                <div onClick={(e) => e.stopPropagation()}>
                  <DebitFacilityActions
                    facility={f}
                    onSettled={onSettled}
                    autoOpen={!!settleId && settleId === autoTerminateId}
                    onAutoOpenHandled={onAutoTerminateHandled}
                  />
                </div>
              </li>
    )
  }

  return (
    <Card id="debit-facilities" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="text-base">Your loans, leverage &amp; debits</CardTitle>
        <CardDescription>
          Every loan, leverage line, monetization facility and treasury financing on this account — including
          internal loans raised in the Treasury section.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {active.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Active — currently charging interest
            </p>
            <ul className="grid gap-3 md:grid-cols-2">{active.map(renderFacility)}</ul>
          </div>
        )}
        {closed.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Settled &amp; closed</p>
            <ul className="grid gap-3 md:grid-cols-2">{closed.map(renderFacility)}</ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
