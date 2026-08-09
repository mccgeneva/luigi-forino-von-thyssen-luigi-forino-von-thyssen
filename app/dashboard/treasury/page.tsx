"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Landmark,
  ShieldCheck,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Percent,
  Eye,
  Building2,
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Info,
  XCircle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import {
  useTreasury,
  getProfile,
  treasurySecured,
  treasuryShortfall,
  financedAmountFor,
  effectiveTreasuryStatus,
  annualCycleFee,
  accruedCycleFee,
  type TreasuryAccount,
  type TreasuryStatus,
  type TreasuryTransaction,
} from "@/lib/treasury-store"
import {
  treasuryFinancingTxns,
  treasuryFinancingPrincipal,
  accruedTreasuryInterest,
  monthlyTreasuryInterest,
  TREASURY_FINANCING_ANNUAL_RATE,
} from "@/lib/treasury-financing"

const fmt = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmt0 = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`

const fmtDate = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

const statusConfig: Record<
  TreasuryStatus,
  { label: string; icon: typeof Clock; color: string }
> = {
  none: { label: "Not Established", icon: Info, color: "bg-secondary text-muted-foreground border-border" },
  pending: { label: "Awaiting Funding", icon: Clock, color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  secured: { label: "Security Deposit Secured", icon: CheckCircle2, color: "bg-green-500/10 text-green-500 border-green-500/20" },
  shortfall: { label: "Deposit Shortfall", icon: AlertTriangle, color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  closed: { label: "Facility Closed", icon: XCircle, color: "bg-secondary text-muted-foreground border-border" },
}

const txnConfig: Record<TreasuryTransaction["type"], { label: string; sign: "in" | "out" | "neutral" }> = {
  deposit: { label: "Security Deposit", sign: "in" },
  leverage: { label: "Leverage Drawdown", sign: "in" },
  collateral: { label: "SKR Collateral", sign: "in" },
  fee: { label: "Debit Cycle Fee", sign: "out" },
  adjustment: { label: "Adjustment", sign: "neutral" },
  settlement: { label: "Settlement", sign: "out" },
}

function Metric({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string
  value: string
  sub?: string
  tone?: "default" | "positive" | "negative"
}) {
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

export default function TreasuryPage() {
  const { account, hydrated } = useTreasury()

  // Live clock so the accruing debit cycle fee ticks while the page is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const profile = getProfile(account.profile)
  const secured = treasurySecured(account)
  const shortfall = treasuryShortfall(account)
  // Financed amount is derived from the current contribution (a 1:10 facility
  // can only amplify the funds the client actually provided), so it always
  // reflects reality even if a stale value was stored.
  const financed = financedAmountFor(account)
  // Value of Safe Keeping Receipts pledged as collateral and credited to the
  // trading balance. Shown as its own line so the client sees where the balance
  // comes from.
  const skrCollateral = Math.max(0, account.skrCollateral || 0)
  const accrued = accruedCycleFee(account, now)
  const annualFee = annualCycleFee(account)
  const coverage = account.requiredDeposit > 0 ? Math.min(100, (secured / account.requiredDeposit) * 100) : 0

  // Special Treasury Financing (€500k / €1m) carries a 3% p.a. debit interest,
  // accruing from the financing date. Surfaced as accrued-to-date + the next
  // monthly charge so the client sees both incurred and upcoming interest.
  const financingTxns = treasuryFinancingTxns(account)
  const financingPrincipal = treasuryFinancingPrincipal(account)
  const financingAccrued = accruedTreasuryInterest(account, new Date(now))
  const financingMonthly = monthlyTreasuryInterest(financingPrincipal)
  const financingSince = financingTxns.length
    ? financingTxns.reduce(
        (earliest, t) => (new Date(t.date).getTime() < new Date(earliest).getTime() ? t.date : earliest),
        financingTxns[0].date,
      )
    : undefined

  // Show the status the actual coverage implies, never a stale "secured".
  const effectiveStatus = effectiveTreasuryStatus(account)
  const status = statusConfig[effectiveStatus] ?? statusConfig.none
  const StatusIcon = status.icon

  const sortedTxns = useMemo(
    () =>
      [...account.transactions].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      ),
    [account.transactions],
  )

  if (!hydrated) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    )
  }

  const established = account.status !== "none"

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Landmark className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-balance text-2xl font-semibold text-foreground">Treasury Services</h1>
            <p className="text-sm text-muted-foreground">
              Security deposit status, leverage facility and debit exposure
            </p>
          </div>
        </div>
        <Badge variant="outline" className={cn("w-fit gap-1.5", status.color)}>
          <StatusIcon className="h-3.5 w-3.5" />
          {status.label}
        </Badge>
      </div>

      {/* Read-only notice */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span className="text-pretty">
          This is a read-only view of your treasury record. Security deposits, leverage facilities and
          debit exposures are created and managed by MCC CAPITAL. Contact your Relationship Manager for any
          changes.
        </span>
      </div>

      {!established ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <Landmark className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-base font-medium text-foreground">No treasury account established</p>
            <p className="max-w-md text-pretty text-sm text-muted-foreground">
              A Treasury Services account with a security deposit profile has not yet been set up for your
              relationship. Your Relationship Manager will provision it once your account tier is confirmed.
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
              <Badge variant="outline" className="gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> PRO — {fmt0(500_000)} deposit
              </Badge>
              <Badge variant="outline" className="gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Avant-Garde — {fmt0(1_000_000)} deposit
              </Badge>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Security deposit status */}
          <Card className="bg-card border-border">
            <CardHeader>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Security Deposit</CardTitle>
                <Badge variant="secondary" className="ml-auto bg-primary/20 text-primary">
                  {profile.label}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label="Required Deposit" value={fmt0(account.requiredDeposit, account.currency)} sub={profile.label} />
                <Metric label="Your Contribution" value={fmt0(account.customerContribution, account.currency)} tone="positive" sub="Funds you provided" />
                <Metric
                  label="Treasury Received"
                  value={fmt0(secured, account.currency)}
                  tone="positive"
                  sub={
                    skrCollateral > 0
                      ? account.leverageEnabled
                        ? "Contribution + leverage + SKR"
                        : "Contribution + SKR collateral"
                      : account.leverageEnabled
                        ? "Contribution + leverage"
                        : "Direct contribution"
                  }
                />
                {skrCollateral > 0 ? (
                  <Metric
                    label="SKR Collateral"
                    value={fmt0(skrCollateral, account.currency)}
                    tone="positive"
                    sub="Pledged for trading"
                  />
                ) : (
                  <Metric
                    label={shortfall > 0 ? "Outstanding Shortfall" : "Deposit Status"}
                    value={shortfall > 0 ? fmt0(shortfall, account.currency) : "Fully Secured"}
                    tone={shortfall > 0 ? "negative" : "positive"}
                  />
                )}
              </div>

              {skrCollateral > 0 && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <span className="font-medium text-foreground">SKR collateral credited</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground text-pretty">
                    {fmt0(skrCollateral, account.currency)} from your Safe Keeping Receipt(s) has been
                    pledged as collateral and added to your treasury balance for trading uses.
                  </p>
                </div>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Deposit coverage</span>
                  <span className="font-semibold text-foreground">{coverage.toFixed(0)}%</span>
                </div>
                <Progress value={coverage} className="h-2" />
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {fmt0(secured, account.currency)} of {fmt0(account.requiredDeposit, account.currency)} required
                  security deposit{account.securedAt ? ` · secured ${fmtDate(account.securedAt)}` : ""}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Leverage facility */}
          <Card className="bg-card border-border">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Leverage Facility</CardTitle>
                {account.leverageEnabled ? (
                  <Badge variant="outline" className="ml-auto gap-1.5 border-green-500/20 bg-green-500/10 text-green-500">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Granted
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-auto text-muted-foreground">
                    Not applied
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {account.leverageEnabled ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Metric label="Applied Leverage" value={`1:${account.leverageRatio}`} sub="Approved by MCC CAPITAL" />
                    <Metric label="Your Contribution" value={fmt0(account.customerContribution, account.currency)} tone="positive" />
                    <Metric label="Financed by MCC HOLDING SA" value={fmt0(financed, account.currency)} tone="negative" sub="Debit exposure" />
                    <Metric label="Treasury Received" value={fmt0(secured, account.currency)} tone="positive" sub="Full security deposit" />
                  </div>
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
                    <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-pretty">
                      Under the approved 1:{account.leverageRatio} leveraged security deposit mechanism, your contribution of{" "}
                      {fmt0(account.customerContribution, account.currency)} is amplified at 1:{account.leverageRatio}.
                      The remaining {fmt0(financed, account.currency)} is financed by{" "}
                      <span className="font-medium text-foreground">MCC HOLDING SA, Switzerland</span> and recorded
                      as a debit exposure on your treasury record.
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-pretty">
                  No leverage facility is currently applied to your security deposit. The deposit is held in
                  full from your own contribution. Should MCC CAPITAL approve a leverage facility (up to 1:10),
                  your contribution would cover 10% of the deposit — the financed portion and its debit cycle
                  fee will appear here.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Debit exposure */}
          {account.leverageEnabled && (
            <Card className="bg-card border-border">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Percent className="h-5 w-5 text-orange-400" />
                  <CardTitle className="text-lg">Debit Exposure &amp; Cycle Fee</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Leveraged Amount" value={fmt0(financed, account.currency)} tone="negative" />
                  <Metric label="Transaction Exposure" value={fmt0(account.transactionExposure, account.currency)} tone="negative" sub="Tied to the facility" />
                  <Metric label="Annual Cycle Fee" value={`${(account.feeRate * 100).toFixed(1)}%`} sub={`${fmt0(annualFee, account.currency)} / year`} />
                  <Metric label="Accrued To Date" value={fmt(accrued, account.currency)} tone="negative" />
                </div>
                <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4 text-sm text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                    <AlertTriangle className="h-4 w-4 text-orange-400" />
                    How the debit cycle fee is calculated
                  </div>
                  <p className="text-pretty">
                    A debit cycle fee of {(account.feeRate * 100).toFixed(1)}% per year is applied to the
                    leveraged amount used for the security deposit ({fmt0(financed, account.currency)})
                    plus any financial transaction exposure associated with the leverage facility (
                    {fmt0(account.transactionExposure, account.currency)}). It accrues continuously
                    {account.securedAt ? ` from ${fmtDate(account.securedAt)}` : ""}.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Special treasury financing interest (3% p.a.) */}
          {financingPrincipal > 0 && (
            <Card className="bg-card border-border">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Percent className="h-5 w-5 text-orange-400" />
                  <CardTitle className="text-lg">Treasury Financing Interest</CardTitle>
                  <Badge variant="outline" className="ml-auto gap-1.5 border-orange-500/20 bg-orange-500/10 text-orange-400">
                    {(TREASURY_FINANCING_ANNUAL_RATE * 100).toFixed(0)}% p.a.
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Financed Principal" value={fmt0(financingPrincipal, account.currency)} tone="negative" />
                  <Metric
                    label="Annual Interest"
                    value={`${(TREASURY_FINANCING_ANNUAL_RATE * 100).toFixed(0)}%`}
                    sub={`${fmt0(financingPrincipal * TREASURY_FINANCING_ANNUAL_RATE, account.currency)} / year`}
                  />
                  <Metric label="Next Monthly Charge" value={fmt(financingMonthly, account.currency)} tone="negative" sub="3% ÷ 12" />
                  <Metric label="Interest Accrued To Date" value={fmt(financingAccrued, account.currency)} tone="negative" />
                </div>
                <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4 text-sm text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                    <AlertTriangle className="h-4 w-4 text-orange-400" />
                    How the treasury financing interest is calculated
                  </div>
                  <p className="text-pretty">
                    A debit interest of {(TREASURY_FINANCING_ANNUAL_RATE * 100).toFixed(0)}% per year is
                    applied to the financed treasury principal of {fmt0(financingPrincipal, account.currency)}.
                    It is charged monthly (÷12) as a debit on your master account at each calendar month-end,
                    accruing from the financing date{financingSince ? ` (${fmtDate(financingSince)})` : ""}, with
                    the first month pro-rated to the financing day. Each charge is logged in your transaction
                    history.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Transaction history */}
          <Card className="bg-card border-border">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Banknote className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Treasury Transaction History</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {sortedTxns.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No treasury transactions recorded yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {sortedTxns.map((t) => {
                    const cfg = txnConfig[t.type]
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                      >
                        <div className="flex items-center gap-3 overflow-hidden">
                          <div
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                              cfg.sign === "in" && "bg-green-500/10 text-green-400",
                              cfg.sign === "out" && "bg-red-500/10 text-red-400",
                              cfg.sign === "neutral" && "bg-secondary text-muted-foreground",
                            )}
                          >
                            {cfg.sign === "out" ? (
                              <ArrowUpRight className="h-4 w-4" />
                            ) : (
                              <ArrowDownLeft className="h-4 w-4" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {t.label || cfg.label}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {t.id} · {fmtDate(t.date)}
                              {t.note ? ` · ${t.note}` : ""}
                            </p>
                          </div>
                        </div>
                        <span
                          className={cn(
                            "whitespace-nowrap text-sm font-semibold",
                            cfg.sign === "in" && "text-green-400",
                            cfg.sign === "out" && "text-red-400",
                            cfg.sign === "neutral" && "text-foreground",
                          )}
                        >
                          {cfg.sign === "out" ? "−" : cfg.sign === "in" ? "+" : ""}
                          {fmt(t.amount, t.currency)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
