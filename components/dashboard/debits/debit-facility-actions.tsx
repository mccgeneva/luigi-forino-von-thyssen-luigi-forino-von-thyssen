"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RotateCcw, ShieldAlert, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { formatMoney } from "@/lib/fund-reservation"
import type { DebitFacility } from "@/lib/debit-schedule"
import type { SettlementQuote } from "@/lib/debit-settlement"
import {
  quoteDebitSettlement,
  reconcileDebitFacility,
  terminateDebitFacility,
} from "@/app/actions/debit-settlement"

type Mode = "terminate" | "reconcile"

interface QuoteState {
  quote: SettlementQuote
  available: number
  covered: boolean
  shortfall: number
}

/**
 * Per-facility client controls to REVERSE / TERMINATE or RECONCILE a debit,
 * settled from the master balance. Opening either dialog fetches a fresh,
 * server-authoritative payoff quote; termination is blocked (with a shortfall
 * notice) when the master balance can't cover it.
 */
export function DebitFacilityActions({
  facility,
  onSettled,
  autoOpen,
  onAutoOpenHandled,
}: {
  facility: DebitFacility
  onSettled: () => void
  /** When true, programmatically open the Terminate dialog (e.g. the client
   *  tapped the debit summary / facility card to jump straight to settlement). */
  autoOpen?: boolean
  onAutoOpenHandled?: () => void
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [state, setState] = useState<QuoteState | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Treasury facilities are keyed by their drawdown txn id; the other three by
  // their backing approval id.
  const settleId = facility.kind === "treasury" ? facility.id : facility.approvalId

  const openDialog = useCallback(
    async (next: Mode) => {
      if (!settleId) return
      setMode(next)
      setState(null)
      setError(null)
      setLoading(true)
      const res = await quoteDebitSettlement(facility.kind, settleId)
      setLoading(false)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setState({ quote: res.quote, available: res.available, covered: res.covered, shortfall: res.shortfall })
    },
    [facility.kind, settleId],
  )

  const close = useCallback(() => {
    if (working) return
    setMode(null)
    setState(null)
    setError(null)
  }, [working])

  const runTerminate = useCallback(async () => {
    if (!settleId) return
    setWorking(true)
    const res = await terminateDebitFacility(facility.kind, settleId)
    setWorking(false)
    if (!res.ok) {
      toast.error(res.error)
      setError(res.error)
      return
    }
    toast.success(
      `${facility.title} terminated — ${formatMoney(res.quote.payoff, res.quote.currency)} settled from your master account.`,
    )
    setMode(null)
    setState(null)
    onSettled()
  }, [facility.kind, facility.title, settleId, onSettled])

  const runReconcile = useCallback(async () => {
    if (!settleId) return
    setWorking(true)
    const res = await reconcileDebitFacility(facility.kind, settleId)
    setWorking(false)
    if (!res.ok) {
      toast.error(res.error)
      setError(res.error)
      return
    }
    if (res.posted <= 0) {
      toast.success(`${facility.title} is already up to date — nothing due.`)
    } else {
      toast.success(
        `${facility.title} reconciled — ${formatMoney(res.posted, facility.currency)} in due charges posted.`,
      )
    }
    setMode(null)
    setState(null)
    onSettled()
  }, [facility.kind, facility.title, facility.currency, settleId, onSettled])

  // Jump-to-terminate: when the parent flags this facility, open the Terminate
  // dialog straight away (one-shot — the parent clears the flag immediately).
  useEffect(() => {
    if (autoOpen && facility.settleable && settleId && mode === null) {
      void openDialog("terminate")
      onAutoOpenHandled?.()
    }
  }, [autoOpen, facility.settleable, settleId, mode, openDialog, onAutoOpenHandled])

  if (!facility.settleable || !settleId) return null

  const q = state?.quote
  const isTerminate = mode === "terminate"
  const canConfirm =
    !!state && !working && (isTerminate ? state.covered && state.quote.payoff > 0 : state.quote.reconcileDue > 0)

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => void openDialog("reconcile")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reconcile
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void openDialog("terminate")}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          Terminate
        </Button>
      </div>

      <Dialog open={mode !== null} onOpenChange={(o) => (!o ? close() : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-balance">
              {isTerminate ? "Reverse & terminate financing" : "Reconcile financing"}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {isTerminate ? (
                <>
                  Settle <span className="font-medium text-foreground">{facility.title}</span> in full and close it.
                  The payoff is debited from your master account.
                </>
              ) : (
                <>
                  Post every debit-interest charge that has come due on{" "}
                  <span className="font-medium text-foreground">{facility.title}</span> but is not yet on your ledger,
                  bringing it up to date. The facility stays open.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Calculating payoff…
            </div>
          ) : error && !state ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-pretty">{error}</p>
            </div>
          ) : q && state ? (
            <div className="space-y-3">
              {isTerminate ? (
                <dl className="space-y-1.5 rounded-lg border border-border bg-secondary/20 p-3 text-sm">
                  <Row label="Financed principal" value={formatMoney(q.principal, q.currency)} />
                  {q.dueNow > 0 && <Row label="Charges due now" value={formatMoney(q.dueNow, q.currency)} />}
                  <Row label="Outstanding interest" value={formatMoney(q.interestTail, q.currency)} />
                  {q.fee > 0 && <Row label="Early-exit fee" value={formatMoney(q.fee, q.currency)} />}
                  <Separator className="my-1.5" />
                  <Row label="Total payoff" value={formatMoney(q.payoff, q.currency)} strong />
                  <Row label="Available balance" value={formatMoney(state.available, q.currency)} muted />
                </dl>
              ) : (
                <dl className="space-y-1.5 rounded-lg border border-border bg-secondary/20 p-3 text-sm">
                  <Row label="Charges due to post" value={formatMoney(q.reconcileDue, q.currency)} strong />
                  <Row label="Available balance" value={formatMoney(state.available, q.currency)} muted />
                </dl>
              )}

              {isTerminate && !state.covered && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-pretty">
                    Your master account balance can&apos;t cover this termination. You&apos;re short by{" "}
                    <span className="font-semibold">{formatMoney(state.shortfall, q.currency)}</span>. Top up the balance
                    first — nothing will be charged.
                  </p>
                </div>
              )}

              {!isTerminate && q.reconcileDue <= 0 && (
                <p className="text-xs text-muted-foreground text-pretty">
                  This facility is already up to date. There are no due charges to post.
                </p>
              )}

              {error && (
                <p className="text-xs text-destructive text-pretty">{error}</p>
              )}
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={working}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={isTerminate ? "destructive" : "default"}
              disabled={!canConfirm}
              onClick={() => void (isTerminate ? runTerminate() : runReconcile())}
              className="gap-1.5"
            >
              {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isTerminate
                ? q
                  ? `Terminate & settle ${formatMoney(q.payoff, q.currency)}`
                  : "Terminate & settle"
                : q && q.reconcileDue > 0
                  ? `Post ${formatMoney(q.reconcileDue, q.currency)}`
                  : "Nothing due"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string
  value: string
  strong?: boolean
  muted?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={muted ? "text-muted-foreground" : "text-muted-foreground"}>{label}</dt>
      <dd
        className={
          strong
            ? "font-semibold text-foreground tabular-nums"
            : muted
              ? "text-muted-foreground tabular-nums"
              : "font-medium text-foreground tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  )
}
