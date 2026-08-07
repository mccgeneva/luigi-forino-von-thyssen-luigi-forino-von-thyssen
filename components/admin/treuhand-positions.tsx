"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Coins, Pause, Play, Ban, RefreshCw, LogOut, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  adminListTradingFundPositions,
  pauseTradingFundPosition,
  resumeTradingFundPosition,
  closeTradingFundPosition,
  reconcileTradingFundTermination,
  type AdminTradingFundPosition,
} from "@/app/actions/approvals"
import { quoteTradingFundExit, TRADING_FUND_EXIT_COMMISSION } from "@/lib/trading-fund"

type ActionKind = "pause" | "resume" | "close"

const ACTION_META: Record<ActionKind, { title: string; verb: string; run: typeof pauseTradingFundPosition }> = {
  pause: { title: "Pause position", verb: "Pause", run: pauseTradingFundPosition },
  resume: { title: "Reactivate position", verb: "Reactivate", run: resumeTradingFundPosition },
  close: { title: "Close position", verb: "Close & return capital", run: closeTradingFundPosition },
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

const STATUS_STYLES: Record<AdminTradingFundPosition["status"], string> = {
  active: "border-green-500/20 bg-green-500/10 text-green-600",
  paused: "border-amber-500/20 bg-amber-500/10 text-amber-600",
  closed: "border-border bg-muted text-muted-foreground",
}

export function TreuhandPositions({ passcode }: { passcode: string }) {
  const [positions, setPositions] = useState<AdminTradingFundPosition[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<{ position: AdminTradingFundPosition; action: ActionKind } | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  // Reconcile-and-close flow (client early-termination or admin-initiated exit).
  const [reconcileTarget, setReconcileTarget] = useState<AdminTradingFundPosition | null>(null)
  const [penaltyInput, setPenaltyInput] = useState("")
  const [chargesInput, setChargesInput] = useState("")
  const [chargesNote, setChargesNote] = useState("")
  const [reconcileNote, setReconcileNote] = useState("")
  const [reconciling, setReconciling] = useState(false)

  // Live settlement quote as the administrator types penalty / charges.
  const reconcileQuote = useMemo(() => {
    if (!reconcileTarget) return null
    return quoteTradingFundExit({
      capitalStarted: reconcileTarget.capital,
      activation: new Date(reconcileTarget.activatedAt),
      pauseWindows: reconcileTarget.pauseWindows,
      penalty: Number(penaltyInput) || 0,
      charges: Number(chargesInput) || 0,
    })
  }, [reconcileTarget, penaltyInput, chargesInput])

  const openReconcile = (p: AdminTradingFundPosition) => {
    const q = quoteTradingFundExit({
      capitalStarted: p.capital,
      activation: new Date(p.activatedAt),
      pauseWindows: p.pauseWindows,
    })
    // Pre-fill the penalty with the term-scaled suggestion; admin may override.
    setPenaltyInput(q.suggestedPenalty > 0 ? String(q.suggestedPenalty) : "")
    setChargesInput("")
    setChargesNote("")
    setReconcileNote("")
    setReconcileTarget(p)
  }

  const confirmReconcile = async () => {
    if (!reconcileTarget || reconciling) return
    setReconciling(true)
    const res = await reconcileTradingFundTermination(passcode, reconcileTarget.id, {
      penaltyAmount: Number(penaltyInput) || 0,
      chargesAmount: Number(chargesInput) || 0,
      chargesNote,
      note: reconcileNote,
    })
    setReconciling(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Position reconciled & closed", {
      description: `${reconcileTarget.accountName}'s capital was returned, less commission${
        Number(penaltyInput) ? ", penalty" : ""
      }${Number(chargesInput) ? " and charges" : ""}.`,
    })
    setReconcileTarget(null)
    await load()
  }

  const load = useCallback(async () => {
    setLoading(true)
    const res = await adminListTradingFundPositions(passcode)
    if (res.ok) setPositions(res.positions)
    else toast.error(res.error)
    setLoading(false)
  }, [passcode])

  useEffect(() => {
    load()
  }, [load])

  const confirmAction = async () => {
    if (!target) return
    setBusy(true)
    const meta = ACTION_META[target.action]
    const res = await meta.run(passcode, target.position.id, reason)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(`Position ${target.action === "resume" ? "reactivated" : target.action === "pause" ? "paused" : "closed"}`, {
      description:
        target.action === "close"
          ? `${formatMoney(target.position.capital, target.position.currency)} was credited back to ${target.position.accountName}'s master account.`
          : `${target.position.accountName}'s position has been updated.`,
    })
    setTarget(null)
    setReason("")
    await load()
  }

  const totals = useMemo(() => {
    const active = positions.filter((p) => p.status === "active").length
    const paused = positions.filter((p) => p.status === "paused").length
    const closed = positions.filter((p) => p.status === "closed").length
    return { active, paused, closed }
  }, [positions])

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Coins className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Treuhand AG Hedge Fund — Positions</CardTitle>
              <CardDescription className="max-w-2xl">
                Pause, reactivate or reconcile any client&apos;s token position at any time. Pausing halts monthly ROI.
                Reconcile &amp; close returns the deployed capital to the client&apos;s master account, less the{" "}
                {(TRADING_FUND_EXIT_COMMISSION * 100).toFixed(0)}% exit commission and any early-resignation penalty or
                charges you input. Positions flagged &quot;early termination requested&quot; are awaiting your evaluation.
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1 shrink-0">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline" className={STATUS_STYLES.active}>
              {totals.active} active
            </Badge>
            <Badge variant="outline" className={STATUS_STYLES.paused}>
              {totals.paused} paused
            </Badge>
            <Badge variant="outline" className={STATUS_STYLES.closed}>
              {totals.closed} closed
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading positions…</p>
          ) : positions.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No authorized Treuhand positions yet. Approved token subscriptions will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {positions.map((p) => (
                <li key={p.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{p.accountName}</span>
                      <Badge variant="outline" className={cn("text-[10px] capitalize", STATUS_STYLES[p.status])}>
                        {p.status}
                      </Badge>
                      {p.terminationRequestedAt && p.status !== "closed" && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-600"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Early termination requested
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.accountEmail} · {p.id}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.tokens != null ? `${p.tokens} token${p.tokens === 1 ? "" : "s"} · ` : ""}
                      {formatMoney(p.capital, p.currency)} capital · ROI {formatMoney(p.monthlyRoi, p.currency)}/mo ·
                      activated {formatDate(p.activatedAt)}
                      {p.status === "paused" && p.pausedAt ? ` · paused ${formatDate(p.pausedAt)}` : ""}
                      {p.status === "closed" && p.closedAt ? ` · closed ${formatDate(p.closedAt)}` : ""}
                    </p>
                    {p.terminationRequestedAt && p.status !== "closed" && (
                      <p className="mt-1 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 text-pretty">
                        Client requested anticipated termination on {formatDate(p.terminationRequestedAt)}.
                        {p.terminationReason ? ` Reason: ${p.terminationReason}` : ""} Evaluate and reconcile below.
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    {p.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1"
                        onClick={() => {
                          setReason("")
                          setTarget({ position: p, action: "pause" })
                        }}
                      >
                        <Pause className="h-3.5 w-3.5" />
                        Pause
                      </Button>
                    )}
                    {p.status === "paused" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 border-green-500/30 text-green-600 hover:bg-green-500/10 hover:text-green-600"
                        onClick={() => {
                          setReason("")
                          setTarget({ position: p, action: "resume" })
                        }}
                      >
                        <Play className="h-3.5 w-3.5" />
                        Reactivate
                      </Button>
                    )}
                    {p.status !== "closed" && (
                      <Button
                        size="sm"
                        className={cn(
                          "h-8 gap-1",
                          p.terminationRequestedAt
                            ? ""
                            : "border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive",
                        )}
                        variant={p.terminationRequestedAt ? "default" : "outline"}
                        onClick={() => openReconcile(p)}
                      >
                        {p.terminationRequestedAt ? <LogOut className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                        Reconcile &amp; close
                      </Button>
                    )}
                    {p.status === "closed" && <span className="text-xs text-muted-foreground">Capital returned</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!target} onOpenChange={(open) => !open && !busy && setTarget(null)}>
        <DialogContent>
          {target && (
            <>
              <DialogHeader>
                <DialogTitle>{ACTION_META[target.action].title}</DialogTitle>
                <DialogDescription>
                  {target.action === "pause" &&
                    `Pause ${target.position.accountName}'s position (${formatMoney(target.position.capital, target.position.currency)}). Monthly ROI stops accruing until you reactivate it.`}
                  {target.action === "resume" &&
                    `Reactivate ${target.position.accountName}'s position. Monthly ROI accrual resumes from where it left off.`}
                  {target.action === "close" &&
                    `Close ${target.position.accountName}'s position. Monthly ROI stops and ${formatMoney(target.position.capital, target.position.currency)} (the tokens) is credited back to their master account. This cannot be undone.`}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="treuhand-reason">Note (optional)</Label>
                <Textarea
                  id="treuhand-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason shown to the client and recorded in the audit log."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={confirmAction}
                  disabled={busy}
                  variant={target.action === "close" ? "destructive" : "default"}
                >
                  {busy ? "Working…" : ACTION_META[target.action].verb}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reconcile & close — apply commission + penalty + charges, return capital */}
      <Dialog open={!!reconcileTarget} onOpenChange={(open) => !open && !reconciling && setReconcileTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          {reconcileTarget && reconcileQuote && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <LogOut className="h-5 w-5 text-primary" />
                  Reconcile &amp; close position
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  Settle {reconcileTarget.accountName}&apos;s Treuhand position. The {(TRADING_FUND_EXIT_COMMISSION * 100).toFixed(0)}% exit
                  commission is applied automatically; add any early-resignation penalty and charges below.
                  {reconcileQuote.early
                    ? ` This is an EARLY resignation — ${reconcileQuote.monthsRemaining} of ${reconcileQuote.monthsServed + reconcileQuote.monthsRemaining} months remain.`
                    : " The engagement term has been reached (no early penalty required)."}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="penalty" className="text-xs">
                      Early-resignation penalty ({reconcileTarget.currency})
                    </Label>
                    <Input
                      id="penalty"
                      type="number"
                      min={0}
                      step="0.01"
                      value={penaltyInput}
                      onChange={(e) => setPenaltyInput(e.target.value)}
                      placeholder="0.00"
                    />
                    {reconcileQuote.early && reconcileQuote.suggestedPenalty > 0 && (
                      <button
                        type="button"
                        className="text-[11px] text-primary hover:underline"
                        onClick={() => setPenaltyInput(String(reconcileQuote.suggestedPenalty))}
                      >
                        Suggested: {formatMoney(reconcileQuote.suggestedPenalty, reconcileTarget.currency)}
                      </button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="charges" className="text-xs">
                      Additional charges ({reconcileTarget.currency})
                    </Label>
                    <Input
                      id="charges"
                      type="number"
                      min={0}
                      step="0.01"
                      value={chargesInput}
                      onChange={(e) => setChargesInput(e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="charges-note" className="text-xs">
                    Charges description (optional)
                  </Label>
                  <Input
                    id="charges-note"
                    value={chargesNote}
                    onChange={(e) => setChargesNote(e.target.value)}
                    placeholder="e.g. administrative & FX handling"
                  />
                </div>

                {/* Settlement preview */}
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Capital returned</span>
                    <span className="font-medium text-green-600">
                      + {formatMoney(reconcileQuote.capitalReturned, reconcileTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">
                      Exit commission ({(TRADING_FUND_EXIT_COMMISSION * 100).toFixed(0)}%)
                    </span>
                    <span className="font-medium text-red-500">
                      − {formatMoney(reconcileQuote.commission, reconcileTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">Penalty</span>
                    <span className="font-medium text-red-500">
                      − {formatMoney(reconcileQuote.penalty, reconcileTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-muted-foreground">Charges</span>
                    <span className="font-medium text-red-500">
                      − {formatMoney(reconcileQuote.charges, reconcileTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="font-medium text-foreground">Net credited to master account</span>
                    <span className="text-base font-bold text-foreground">
                      {formatMoney(reconcileQuote.netCredited, reconcileTarget.currency)}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    ROI of {formatMoney(reconcileQuote.roiMatured, reconcileTarget.currency)} was already paid over{" "}
                    {reconcileQuote.monthsServed} month{reconcileQuote.monthsServed === 1 ? "" : "s"} and is retained by
                    the client.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="reconcile-note" className="text-xs">
                    Note to client (optional)
                  </Label>
                  <Textarea
                    id="reconcile-note"
                    value={reconcileNote}
                    onChange={(e) => setReconcileNote(e.target.value)}
                    placeholder="Shown to the client and recorded in the audit log."
                    rows={2}
                    className="resize-none"
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setReconcileTarget(null)} disabled={reconciling}>
                  Cancel
                </Button>
                <Button onClick={confirmReconcile} disabled={reconciling}>
                  {reconciling ? "Reconciling…" : "Reconcile & close"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
