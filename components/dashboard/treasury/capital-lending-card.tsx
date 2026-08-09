"use client"

import { useCallback, useEffect, useState } from "react"
import { HandCoins, Clock, CheckCircle2, AlertTriangle, Loader2, Info, Percent } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { TreasuryProfileKey } from "@/lib/treasury-store"
import {
  TREASURY_LENDING_ANNUAL_RATE,
  TREASURY_LENDING_COST_RATE,
  treasuryLendingAmount,
  treasuryLendingCost,
} from "@/lib/treasury-lending"
import {
  applyForTreasuryLending,
  payTreasuryLendingCost,
  getMyTreasuryLending,
  type TreasuryLendingView,
} from "@/app/actions/treasury-lending"

const fmt0 = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
const fmt2 = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Stat({ label, value, tone = "default", sub }: { label: string; value: string; tone?: "default" | "positive" | "negative"; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold",
          tone === "positive" && "text-green-500",
          tone === "negative" && "text-orange-400",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

/**
 * Internal Treasury Capital Lending — customer application surface.
 *
 * Lets a client borrow their full security-deposit capital: apply → (admin
 * approves) → pay the one-time 1.88% lending cost, which draws down the capital
 * to the master account and starts the 3% p.a. debit interest. The borrowed
 * amount is fixed by the treasury profile; the server is authoritative for the
 * cost and the balance gate.
 */
export function CapitalLendingCard({
  profile,
  currency = "EUR",
  onFunded,
}: {
  profile: TreasuryProfileKey
  currency?: string
  onFunded?: () => void
}) {
  const [requests, setRequests] = useState<TreasuryLendingView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const amount = treasuryLendingAmount(profile)
  const cost = treasuryLendingCost(amount)

  const load = useCallback(async () => {
    try {
      const rows = await getMyTreasuryLending()
      setRequests(rows)
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // The most relevant facility: a live one (pending / approved-unfunded /
  // funded) takes priority over historical rejected/closed rows.
  const active =
    requests.find((r) => r.status === "pending") ||
    requests.find((r) => r.status === "approved") ||
    requests[0] ||
    null
  const funded = Boolean(active?.fundedAt)

  const apply = async () => {
    setBusy(true)
    try {
      const res = await applyForTreasuryLending()
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success("Lending application submitted for administrator approval.")
      await load()
    } catch {
      toast.error("Your application could not be submitted. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const pay = async (id: string) => {
    setBusy(true)
    try {
      const res = await payTreasuryLendingCost(id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(
        `Lending cost paid. ${fmt0(res.amount, currency)} was credited to your master account at ${(
          TREASURY_LENDING_ANNUAL_RATE * 100
        ).toFixed(0)}% p.a.`,
      )
      await load()
      onFunded?.()
    } catch {
      toast.error("The lending cost could not be charged. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const badge = (() => {
    if (funded)
      return { label: "Active", className: "border-green-500/20 bg-green-500/10 text-green-500", Icon: CheckCircle2 }
    if (active?.status === "approved")
      return { label: "Approved — awaiting payment", className: "border-primary/20 bg-primary/10 text-primary", Icon: CheckCircle2 }
    if (active?.status === "pending")
      return { label: "Under review", className: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500", Icon: Clock }
    return { label: "Not applied", className: "text-muted-foreground", Icon: Info }
  })()

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-2">
          <HandCoins className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Internal Capital Lending</CardTitle>
          <Badge variant="outline" className={cn("ml-auto gap-1.5", badge.className)}>
            <badge.Icon className="h-3.5 w-3.5" />
            {badge.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Borrowable Capital" value={fmt0(active?.amount ?? amount, currency)} sub="Full security deposit" />
          <Stat
            label="Lending Cost"
            value={`${(TREASURY_LENDING_COST_RATE * 100).toFixed(2)}%`}
            tone="negative"
            sub={`${fmt2(active?.lendingCost ?? cost, currency)} one-time`}
          />
          <Stat
            label="Debit Interest"
            value={`${(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a.`}
            tone="negative"
            sub="Once funded"
          />
          <Stat
            label="Status"
            value={funded ? "Funded" : active?.status === "approved" ? "Approved" : active?.status === "pending" ? "Pending" : "Available"}
            tone={funded ? "positive" : "default"}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
          <Percent className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span className="text-pretty">
            Borrow the full {fmt0(amount, currency)} security-deposit capital internally. On administrator
            approval you pay a one-time lending cost of {(TREASURY_LENDING_COST_RATE * 100).toFixed(2)}% (
            {fmt2(cost, currency)}); once paid, the capital is drawn down to your master account and carries a{" "}
            {(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest, charged monthly.
          </span>
        </div>

        {/* Action row driven by lifecycle state */}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading lending status…
          </div>
        ) : funded ? (
          <div className="flex items-start gap-2 rounded-lg border border-green-500/20 bg-green-500/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <span className="text-pretty text-muted-foreground">
              <span className="font-medium text-foreground">Capital lending active.</span>{" "}
              {fmt0(active?.amount ?? amount, currency)} was drawn down to your master account. The{" "}
              {(TREASURY_LENDING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest is shown in the Treasury
              Financing Interest panel above.
            </span>
          </div>
        ) : active?.status === "approved" ? (
          <div className="flex flex-col gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground text-pretty">
              <span className="font-medium text-foreground">Approved.</span> Pay the one-time lending cost of{" "}
              {fmt2(active.lendingCost, currency)} to draw down {fmt0(active.amount, currency)} to your master
              account.
            </div>
            <Button onClick={() => pay(active.id)} disabled={busy} className="shrink-0 gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
              Pay {fmt2(active.lendingCost, currency)} &amp; activate
            </Button>
          </div>
        ) : active?.status === "pending" ? (
          <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
            <span className="text-pretty text-muted-foreground">
              Your application to borrow {fmt0(active.amount, currency)} is awaiting administrator approval.
              You will be able to pay the lending cost here once it is approved.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {active?.status === "rejected" && (
              <div className="flex items-start gap-2 text-sm text-orange-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="text-pretty">
                  A previous application was declined{active.decisionNote ? `: ${active.decisionNote}` : "."} You
                  may apply again.
                </span>
              </div>
            )}
            <Button onClick={apply} disabled={busy} className="shrink-0 gap-2 sm:ml-auto">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
              Apply for full lending — {fmt0(amount, currency)}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
