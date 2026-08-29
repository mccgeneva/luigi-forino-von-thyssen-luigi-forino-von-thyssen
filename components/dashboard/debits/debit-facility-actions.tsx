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
  settleableNow: boolean
  needsApproval: boolean
  overdraftLimitEur: number
  approvalGranted: boolean
  approvalPending: boolean
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
  /** Set when a deep-negative termination was routed to the administrator. */
  const [pendingApproval, setPendingApproval] = useState<string | null>(null)
  /** True when the action is HARD-BLOCKED (leverage funds deployed in an active
   *  investment): show the reason with no Retry / "settle anyway" escape. */
  const [blocked, setBlocked] = useState(false)

  // Treasury facilities are keyed by their drawdown txn id; the other three by
  // their backing approval id.
  const settleId = facility.kind === "treasury" ? facility.id : facility.approvalId

  const openDialog = useCallback(
    async (next: Mode) => {
      if (!settleId) return
      setMode(next)
      setState(null)
      setError(null)
      setPendingApproval(null)
      setBlocked(false)
      setLoading(true)
      const res = await quoteDebitSettlement(facility.kind, settleId)
      setLoading(false)
      if (!res.ok) {
        setError(res.error)
        setBlocked("blocked" in res && res.blocked === true)
        return
      }
      setState({
        quote: res.quote,
        available: res.available,
        covered: res.covered,
        shortfall: res.shortfall,
        settleableNow: res.settleableNow,
        needsApproval: res.needsApproval,
        overdraftLimitEur: res.overdraftLimitEur,
        approvalGranted: res.approvalGranted,
        approvalPending: res.approvalPending,
      })
    },
    [facility.kind, settleId],
  )

  const close = useCallback(() => {
    if (working) return
    setMode(null)
    setState(null)
    setError(null)
    setPendingApproval(null)
    setBlocked(false)
  }, [working])

  const runTerminate = useCallback(async () => {
    if (!settleId) return
    setWorking(true)
    const res = await terminateDebitFacility(facility.kind, settleId)
    setWorking(false)
    if (!res.ok) {
      // Hard block: leveraged funds are deployed in an active investment — no
      // admin escape, the client must exit the investment first.
      if ("blocked" in res && res.blocked) {
        setBlocked(true)
        setState(null)
        setError(res.error)
        setPendingApproval(null)
        toast.error("Exit your investment first to settle this line.")
        return
      }
      // Routed to the administrator (deep negative beyond authorized overdraft):
      // show an informational pending state, not a red error.
      if ("pendingApproval" in res && res.pendingApproval) {
        setPendingApproval(res.error)
        setError(null)
        toast.info("Sent to the administrator for approval.")
        onSettled()
        return
      }
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
  // Terminate is confirmable either as an instant settlement (balance covers it
  // OR within the authorized overdraft / already granted) OR as a request to the
  // administrator (deep negative). Reconcile is unchanged.
  const canConfirm =
    !!state &&
    !working &&
    !pendingApproval &&
    (isTerminate ? state.quote.payoff > 0 && !state.approvalPending : state.quote.reconcileDue > 0)
  const isApprovalRequest = isTerminate && !!state && state.needsApproval && !state.approvalGranted

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
          ) : pendingApproval && !state ? (
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-pretty">{pendingApproval}</p>
            </div>
          ) : blocked && error ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-pretty">{error}</p>
            </div>
          ) : error && !state ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-pretty">{error}</p>
              </div>
              {mode && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5"
                  onClick={() => void openDialog(mode)}
                  disabled={working}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              )}
              {/* The payoff PREVIEW failed, but termination re-resolves and
                  recomputes authoritatively on the server (with its own solvency
                  + overdraft + admin-approval routing, posting nothing on error).
                  So let the client proceed directly instead of dead-ending. */}
              {isTerminate && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full gap-1.5"
                  onClick={() => void runTerminate()}
                  disabled={working}
                >
                  {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
                  Terminate &amp; settle anyway
                </Button>
              )}
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

              {isTerminate && !state.covered && state.settleableNow && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-pretty">
                    {state.approvalGranted
                      ? "An administrator has approved this settlement. It will be charged now and your account may go negative as authorized."
                      : (
                        <>
                          Your balance is short by{" "}
                          <span className="font-semibold">{formatMoney(state.shortfall, q.currency)}</span>, but this stays
                          within your authorized overdraft. You can settle now — your account will go temporarily negative.
                        </>
                      )}
                  </p>
                </div>
              )}

              {isApprovalRequest && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-pretty">
                    This payoff would take your account{" "}
                    <span className="font-semibold">beyond your authorized overdraft</span>
                    {state.overdraftLimitEur > 0 && <> (approx. {formatMoney(state.overdraftLimitEur, "EUR")})</>}. It needs
                    administrator approval.{" "}
                    {state.approvalPending
                      ? "A request is already awaiting the administrator."
                      : "Send it for approval — nothing is charged until it's approved."}
                  </p>
                </div>
              )}

              {pendingApproval && (
                <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs text-foreground">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-pretty">{pendingApproval}</p>
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
              {pendingApproval || blocked ? "Close" : "Cancel"}
            </Button>
            {!pendingApproval && !blocked && (
              <Button
                size="sm"
                variant={isApprovalRequest ? "default" : isTerminate ? "destructive" : "default"}
                disabled={!canConfirm}
                onClick={() => void (isTerminate ? runTerminate() : runReconcile())}
                className="gap-1.5"
              >
                {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {isTerminate
                  ? isApprovalRequest
                    ? state?.approvalPending
                      ? "Awaiting administrator"
                      : "Request administrator approval"
                    : q
                      ? `Terminate & settle ${formatMoney(q.payoff, q.currency)}`
                      : "Terminate & settle"
                  : q && q.reconcileDue > 0
                    ? `Post ${formatMoney(q.reconcileDue, q.currency)}`
                    : "Nothing due"}
              </Button>
            )}
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
