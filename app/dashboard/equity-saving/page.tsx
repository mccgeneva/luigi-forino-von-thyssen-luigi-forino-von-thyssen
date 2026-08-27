"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { PiggyBank, Lock, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, TrendingUp, Loader2, Clock, CheckCircle2, XCircle, Hourglass } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/ui/money-input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useLedger } from "@/lib/ledger-store"
import {
  getMyEquitySavings,
  depositToEquitySavings,
  requestEquityRelease,
  getMyEquityReleaseRequests,
  cancelMyEquityRelease,
  type EquitySavingsSnapshot,
} from "@/app/actions/equity-savings"
import type { EquityReleaseRequest } from "@/lib/equity-release-db"

function fmt(amount: number, currency: string) {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

function fmtWhen(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

const RELEASE_STATUS: Record<
  EquityReleaseRequest["status"],
  { label: string; icon: typeof Clock; className: string }
> = {
  pending: { label: "Awaiting administrator", icon: Hourglass, className: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  scheduled: { label: "Scheduled", icon: Clock, className: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
  released: { label: "Released", icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  rejected: { label: "Declined", icon: XCircle, className: "bg-destructive/15 text-destructive border-destructive/30" },
  cancelled: { label: "Withdrawn", icon: XCircle, className: "bg-muted text-muted-foreground border-border" },
}

export default function EquitySavingPage() {
  const { refresh: refreshLedger } = useLedger()
  const [snapshot, setSnapshot] = useState<EquitySavingsSnapshot>({
    byCurrency: {},
    availableByCurrency: {},
    accountNegative: false,
    negativeEur: 0,
    freeToCommitEur: 0,
    borrowedEur: 0,
  })
  const [loading, setLoading] = useState(true)

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit")
  const [currency, setCurrency] = useState("EUR")
  const [amount, setAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [releases, setReleases] = useState<EquityReleaseRequest[]>([])
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const load = async () => {
    const [snap, reqs] = await Promise.all([getMyEquitySavings(), getMyEquityReleaseRequests()])
    setSnapshot(snap)
    setReleases(reqs)
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  // Currencies offered in the picker: anything the customer can spend (deposit)
  // or has already blocked (withdraw), always including EUR.
  const currencyOptions = useMemo(() => {
    const set = new Set<string>(["EUR"])
    for (const c of Object.keys(snapshot.availableByCurrency)) set.add(c)
    for (const c of Object.keys(snapshot.byCurrency)) set.add(c)
    return Array.from(set).sort()
  }, [snapshot])

  const blockedEntries = useMemo(
    () => Object.entries(snapshot.byCurrency).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]),
    [snapshot],
  )
  const totalBlockedEur = useMemo(() => snapshot.byCurrency.EUR ?? 0, [snapshot])

  const accountNegative = snapshot.accountNegative
  const negativeEur = snapshot.negativeEur
  const spendable = snapshot.availableByCurrency[currency] ?? 0
  const blockedInCcy = snapshot.byCurrency[currency] ?? 0
  // Only FRESH, unborrowed funds may be committed. When the customer holds
  // outstanding borrowed/financed funds (loans, leverage, financing), the
  // blockable amount is capped at net free equity (EUR-aggregate). We can only
  // apply that cap precisely for EUR client-side; other currencies are still
  // enforced server-side, so we show it as guidance there.
  const hasBorrowed = snapshot.borrowedEur > 0.01
  const freeEur = snapshot.freeToCommitEur
  const depositCap = hasBorrowed && currency === "EUR" ? Math.min(spendable, freeEur) : spendable
  const capForMode = mode === "deposit" ? depositCap : blockedInCcy
  const numericAmount = Number.parseFloat(amount || "0") || 0
  const overCap = numericAmount > capForMode + 0.01
  // Top-ups are blocked entirely while the master account is negative.
  const depositBlocked = mode === "deposit" && accountNegative

  const submit = async () => {
    if (numericAmount <= 0) {
      toast.error("Enter an amount greater than zero.")
      return
    }
    if (depositBlocked) {
      toast.error("Master Account is negative", {
        description: "Restore a positive balance before adding to Equity Saving.",
      })
      return
    }
    setSubmitting(true)
    const res =
      mode === "deposit"
        ? await depositToEquitySavings({ amount: numericAmount, currency })
        : await requestEquityRelease({ amount: numericAmount, currency })
    setSubmitting(false)
    if (!res.ok) {
      toast.error(mode === "deposit" ? "Could not block equity" : "Could not request release", {
        description: res.error,
      })
      return
    }
    if (mode === "deposit") {
      toast.success("Equity blocked as collateral", { description: fmt(numericAmount, currency) })
    } else {
      toast.success("Release request submitted", {
        description: `${fmt(numericAmount, currency)} — the administrator will review and agree the terms and timing before it credits.`,
      })
    }
    setAmount("")
    refreshLedger()
    await load()
  }

  const withdrawRequest = async (id: string) => {
    setCancellingId(id)
    const res = await cancelMyEquityRelease(id)
    setCancellingId(null)
    if (!res.ok) {
      toast.error("Could not withdraw request", { description: res.error })
      return
    }
    toast.success("Release request withdrawn")
    await load()
  }

  const activeReleases = useMemo(
    () => releases.filter((r) => r.status === "pending" || r.status === "scheduled"),
    [releases],
  )
  const historyReleases = useMemo(
    () => releases.filter((r) => r.status === "released" || r.status === "rejected" || r.status === "cancelled").slice(0, 8),
    [releases],
  )

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <PiggyBank className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">Equity Saving</h1>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
            Move part of your Master Account balance into a segregated equity pot. The funds stay yours but are
            fully blocked as collateral — they count toward your Guarantees Accumulator trust score and improve
            your standing. To release equity you submit a request; the administrator reviews it and agrees the
            amount, terms and timing before the funds credit back to your spendable balance.
          </p>
        </div>
      </div>

      {/* Summary tiles */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Equity blocked (EUR)</CardTitle>
            <Lock className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              {fmt(totalBlockedEur, "EUR")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Segregated collateral in EUR</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Currencies committed</CardTitle>
            <ShieldCheck className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums text-foreground">{blockedEntries.length}</div>
            <p className="mt-1 text-xs text-muted-foreground">Distinct currencies blocked</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Trust impact</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-foreground">Positive</div>
            <p className="mt-1 text-xs text-muted-foreground">Raises collateral coverage &amp; lowers risk</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Move funds */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Move funds</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={mode === "deposit" ? "default" : "outline"}
                className="justify-center"
                onClick={() => {
                  setMode("deposit")
                  setAmount("")
                }}
              >
                <ArrowDownToLine className="mr-2 h-4 w-4" />
                Block equity
              </Button>
              <Button
                type="button"
                variant={mode === "withdraw" ? "default" : "outline"}
                className="justify-center"
                onClick={() => {
                  setMode("withdraw")
                  setAmount("")
                }}
              >
                <ArrowUpFromLine className="mr-2 h-4 w-4" />
                Request release
              </Button>
            </div>

            {depositBlocked && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <p className="flex items-start gap-2 text-xs text-destructive">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Your Master Account is negative ({fmt(negativeEur, "EUR")} in overdraft). You can&apos;t add to
                    Equity Saving until the balance is positive again. Restore it, then move only clean available
                    funds here. You can still release existing equity.
                  </span>
                </p>
              </div>
            )}

            <div>
              <Label htmlFor="equity-currency" className="text-xs">
                Currency
              </Label>
              <Select value={currency} onValueChange={(v) => { setCurrency(v); setAmount("") }}>
                <SelectTrigger id="equity-currency" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencyOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <Label htmlFor="equity-amount" className="text-xs">
                  Amount
                </Label>
                <span className={`text-xs ${overCap ? "text-destructive" : "text-muted-foreground"}`}>
                  {mode === "deposit"
                    ? `Spendable: ${fmt(spendable, currency)}`
                    : `Blocked: ${fmt(blockedInCcy, currency)}`}
                </span>
              </div>
              <MoneyInput
                id="equity-amount"
                value={amount}
                onValueChange={setAmount}
                placeholder="0.00"
                className="mt-1"
              />
              {mode === "deposit" && hasBorrowed && (
                <p className="mt-1 text-xs text-amber-500">
                  Free to commit (excludes borrowed funds): {fmt(freeEur, "EUR")}. You have{" "}
                  {fmt(snapshot.borrowedEur, "EUR")} of outstanding borrowed/financed funds, which cannot enter Equity
                  Saving.
                </p>
              )}
              {overCap && (
                <p className="mt-1 text-xs text-destructive">
                  {mode === "deposit"
                    ? hasBorrowed && currency === "EUR"
                      ? "Amount exceeds your free (unborrowed) equity. Borrowed/financed funds cannot be committed."
                      : "Amount exceeds your spendable balance in this currency."
                    : "Amount exceeds the equity you have blocked in this currency."}
                </p>
              )}
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                {mode === "deposit"
                  ? "Only fresh, unborrowed funds from a positive Master Account may be committed. Borrowed or financed money — internal loans, leverage, monetization, project-funding or a financed treasury deposit — cannot be moved into Equity Saving, and neither can reserved, blocked, PPI-appeal or overdraft-linked funds. Blocked equity leaves your spendable balance but remains yours, counts as collateral, and boosts your trust score."
                  : "This submits a release request to the administrator. Nothing is unblocked yet — the administrator reviews it and negotiates the amount, modality and timing. The funds credit back to your spendable balance once approved (immediately or at the agreed time)."}
              </p>
            </div>

            <Button type="button" className="w-full" onClick={submit} disabled={submitting || overCap || numericAmount <= 0 || depositBlocked}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing…
                </>
              ) : mode === "deposit" ? (
                `Block ${amount ? fmt(numericAmount, currency) : "equity"}`
              ) : (
                `Request release${amount ? ` of ${fmt(numericAmount, currency)}` : ""}`
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Blocked positions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Blocked equity</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : blockedEntries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <PiggyBank className="mx-auto h-8 w-8 text-muted-foreground/60" />
                <p className="mt-2 text-sm text-muted-foreground">
                  No equity committed yet. Block funds on the left to build segregated collateral.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {blockedEntries.map(([cur, amt]) => (
                  <li key={cur} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-xs font-semibold text-foreground">
                        {cur}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{fmt(amt, cur)}</p>
                        <p className="text-xs text-muted-foreground">Blocked as collateral</p>
                      </div>
                    </div>
                    <Lock className="h-4 w-4 text-primary" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Release requests */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">My release requests</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : releases.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <ArrowUpFromLine className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <p className="mt-2 text-sm text-muted-foreground">
                No release requests yet. Use &ldquo;Request release&rdquo; above — an administrator agrees the amount,
                terms and timing before your equity is unblocked.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {[...activeReleases, ...historyReleases].map((r) => {
                const cfg = RELEASE_STATUS[r.status]
                const StatusIcon = cfg.icon
                const shownAmount = r.approvedAmount ?? r.requestedAmount
                return (
                  <li key={r.id} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {fmt(shownAmount, r.currency)}
                          {r.approvedAmount != null && r.approvedAmount !== r.requestedAmount && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (requested {fmt(r.requestedAmount, r.currency)})
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Requested {fmtWhen(r.createdAt)}</p>
                      </div>
                      <Badge variant="outline" className={`gap-1 ${cfg.className}`}>
                        <StatusIcon className="h-3 w-3" />
                        {cfg.label}
                      </Badge>
                    </div>

                    {r.status === "scheduled" && r.releaseAt && (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-sky-400">
                        <Clock className="h-3.5 w-3.5" />
                        Credits automatically on {fmtWhen(r.releaseAt)}
                      </p>
                    )}
                    {r.status === "released" && (
                      <p className="mt-2 text-xs text-muted-foreground">Credited {fmtWhen(r.releasedAt)}</p>
                    )}
                    {r.modality && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Agreed terms: </span>
                        {r.modality}
                      </p>
                    )}
                    {r.adminNote && (
                      <p className="mt-1 text-xs text-muted-foreground">{r.adminNote}</p>
                    )}

                    {r.status === "pending" && (
                      <div className="mt-3">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => withdrawRequest(r.id)}
                          disabled={cancellingId === r.id}
                        >
                          {cancellingId === r.id ? (
                            <>
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              Withdrawing…
                            </>
                          ) : (
                            "Withdraw request"
                          )}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
