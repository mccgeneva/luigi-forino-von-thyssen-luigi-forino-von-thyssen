"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  HandCoins,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Percent,
  ShieldCheck,
  MessagesSquare,
} from "lucide-react"
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
  listInternalLoansAdmin,
  approveInternalLoanAdmin,
  rejectInternalLoanAdmin,
  type AdminInternalLoan,
} from "@/app/actions/internal-loan"
import { INTERNAL_LOAN_DEFAULT_RATE, formatLoanMoney } from "@/lib/internal-loan"
import { LoanNegotiationThread } from "@/components/dashboard/treasury/loan-negotiation-thread"

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function StatusBadge({ status }: { status: string }) {
  if (status === "approved")
    return (
      <Badge variant="outline" className="gap-1 border-green-500/20 bg-green-500/10 text-green-600">
        <CheckCircle2 className="h-3 w-3" /> Funded
      </Badge>
    )
  if (status === "rejected" || status === "cancelled")
    return (
      <Badge variant="outline" className="gap-1 border-red-500/20 bg-red-500/10 text-red-600">
        <XCircle className="h-3 w-3" /> {status === "rejected" ? "Declined" : "Cancelled"}
      </Badge>
    )
  return (
    <Badge variant="outline" className="gap-1 border-amber-500/20 bg-amber-500/10 text-amber-600">
      <Clock className="h-3 w-3" /> Under review
    </Badge>
  )
}

const DEFAULT_RATE_PCT = (INTERNAL_LOAN_DEFAULT_RATE * 100).toString()

/**
 * Administrator surface for internal lending. The admin evaluates each pending
 * request (risk + repayment guarantee), sets the effective annual rate and an
 * optional one-time arrangement fee, then Approves — which funds the principal
 * straight to the borrower's Master Account — or Declines. Approved loans show
 * their live outstanding balance; the client repays from their own balance.
 */
export function InternalLoanManager({ passcode }: { passcode: string }) {
  const [loans, setLoans] = useState<AdminInternalLoan[]>([])
  const [loading, setLoading] = useState(true)

  // Approval dialog state
  const [approveTarget, setApproveTarget] = useState<AdminInternalLoan | null>(null)
  const [ratePct, setRatePct] = useState(DEFAULT_RATE_PCT)
  const [fee, setFee] = useState("")
  const [approveNote, setApproveNote] = useState("")
  const [approving, setApproving] = useState(false)

  // Decline dialog state
  const [rejectTarget, setRejectTarget] = useState<AdminInternalLoan | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [rejecting, setRejecting] = useState(false)

  // Discussion (negotiation thread) dialog state
  const [discussTarget, setDiscussTarget] = useState<AdminInternalLoan | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await listInternalLoansAdmin(passcode)
      setLoans(rows)
    } catch {
      toast.error("Could not load internal loans.")
    } finally {
      setLoading(false)
    }
  }, [passcode])

  useEffect(() => {
    void load()
  }, [load])

  const pending = useMemo(() => loans.filter((l) => l.status === "pending"), [loans])
  const funded = useMemo(() => loans.filter((l) => l.status === "approved"), [loans])
  const history = useMemo(
    () => loans.filter((l) => l.status === "rejected" || l.status === "cancelled"),
    [loans],
  )

  const openApprove = (loan: AdminInternalLoan) => {
    setApproveTarget(loan)
    setRatePct(loan.terms ? (loan.terms.annualRate * 100).toString() : DEFAULT_RATE_PCT)
    setFee(loan.terms?.arrangementFee ? String(loan.terms.arrangementFee) : "")
    setApproveNote("")
  }

  const confirmApprove = async () => {
    if (!approveTarget || approving) return
    const rateNum = Number.parseFloat(ratePct.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(rateNum) || rateNum < 0 || rateNum > 100) {
      toast.error("Enter a valid annual rate between 0 and 100%.")
      return
    }
    const feeNum = fee.trim() ? Number.parseFloat(fee.replace(/[^0-9.]/g, "")) : 0
    if (!Number.isFinite(feeNum) || feeNum < 0) {
      toast.error("Enter a valid arrangement fee (0 or more).")
      return
    }
    setApproving(true)
    const res = await approveInternalLoanAdmin({
      passcode,
      approvalId: approveTarget.approvalId,
      annualRatePct: rateNum,
      arrangementFee: feeNum,
      note: approveNote.trim() || undefined,
    })
    setApproving(false)
    if (!res.ok) {
      toast.error("Approval failed", { description: res.error })
      return
    }
    toast.success("Loan approved & funded", {
      description: `${formatLoanMoney(approveTarget.requestedAmount, approveTarget.currency)} credited to ${
        approveTarget.holder
      }'s Master Account at ${rateNum}% p.a.`,
    })
    setApproveTarget(null)
    await load()
  }

  const confirmReject = async () => {
    if (!rejectTarget || rejecting) return
    setRejecting(true)
    const res = await rejectInternalLoanAdmin({
      passcode,
      approvalId: rejectTarget.approvalId,
      reason: rejectReason.trim() || undefined,
    })
    setRejecting(false)
    if (!res.ok) {
      toast.error("Could not decline the request", { description: res.error })
      return
    }
    toast.success("Loan request declined")
    setRejectTarget(null)
    setRejectReason("")
    await load()
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HandCoins className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-lg">Internal Lending</CardTitle>
              <CardDescription>
                Evaluate loan requests, set the rate and any arrangement fee, then fund or decline.
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Pending review queue */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-foreground">Awaiting evaluation ({pending.length})</h3>
          </div>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending loan requests.</p>
          ) : (
            <div className="space-y-3">
              {pending.map((loan) => (
                <div key={loan.approvalId} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-foreground">
                          {formatLoanMoney(loan.requestedAmount, loan.currency)}
                        </span>
                        <StatusBadge status={loan.status} />
                      </div>
                      <p className="mt-1 text-sm text-foreground">
                        {loan.holder}
                        {loan.company ? <span className="text-muted-foreground"> · {loan.company}</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">{loan.email}</p>
                    </div>
                    <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
                      <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setDiscussTarget(loan)}>
                        <MessagesSquare className="mr-1.5 h-3.5 w-3.5" /> Discuss
                      </Button>
                      <Button size="sm" className="whitespace-nowrap" onClick={() => openApprove(loan)}>
                        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Evaluate & fund
                      </Button>
                      <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => setRejectTarget(loan)}>
                        <XCircle className="mr-1.5 h-3.5 w-3.5" /> Decline
                      </Button>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 border-t border-border pt-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Requested</dt>
                      <dd className="text-foreground">{formatDate(loan.createdAt)}</dd>
                    </div>
                    {loan.purpose && (
                      <div>
                        <dt className="text-muted-foreground">Purpose</dt>
                        <dd className="text-foreground">{loan.purpose}</dd>
                      </div>
                    )}
                    {loan.repaymentPlan && (
                      <div>
                        <dt className="text-muted-foreground">Proposed repayment</dt>
                        <dd className="text-foreground">{loan.repaymentPlan}</dd>
                      </div>
                    )}
                    {loan.collateralNote && (
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Repayment guarantee / collateral</dt>
                        <dd className="text-foreground">{loan.collateralNote}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Funded loans */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <h3 className="text-sm font-semibold text-foreground">Funded loans ({funded.length})</h3>
          </div>
          {funded.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active funded loans.</p>
          ) : (
            <div className="space-y-2">
              {funded.map((loan) => (
                <div
                  key={loan.approvalId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {formatLoanMoney(loan.requestedAmount, loan.currency)}
                      </span>
                      <StatusBadge status={loan.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {loan.holder} · funded {formatDate(loan.decidedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right text-xs">
                      <p className="text-muted-foreground">
                        Outstanding{" "}
                        <span className="font-medium text-foreground">
                          {formatLoanMoney(loan.outstanding, loan.currency)}
                        </span>
                      </p>
                      {loan.terms && (
                        <p className="flex items-center justify-end gap-1 text-orange-500">
                          <Percent className="h-3 w-3" />
                          {(loan.terms.annualRate * 100).toFixed(2)}% p.a.
                          {loan.terms.arrangementFee
                            ? ` · fee ${formatLoanMoney(loan.terms.arrangementFee, loan.currency)}`
                            : ""}
                        </p>
                      )}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0"
                      onClick={() => setDiscussTarget(loan)}
                      aria-label="View loan discussion"
                    >
                      <MessagesSquare className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Decision history */}
        {history.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">History</h3>
            {history.map((loan) => (
              <div
                key={loan.approvalId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {formatLoanMoney(loan.requestedAmount, loan.currency)}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {loan.holder} · {formatDate(loan.decidedAt)}
                  </span>
                </div>
                <StatusBadge status={loan.status} />
              </div>
            ))}
          </section>
        )}

        {loading && loans.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">Loading internal loans…</p>
        )}
      </CardContent>

      {/* Approve / fund dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Evaluate & fund internal loan</DialogTitle>
            <DialogDescription>
              {approveTarget
                ? `Set the terms for ${approveTarget.holder}'s ${formatLoanMoney(
                    approveTarget.requestedAmount,
                    approveTarget.currency,
                  )} loan. On approval the principal is credited immediately to their Master Account.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="loan-rate" className="text-xs">
                  Annual interest rate (%)
                </Label>
                <Input
                  id="loan-rate"
                  value={ratePct}
                  onChange={(e) => setRatePct(e.target.value)}
                  inputMode="decimal"
                  placeholder="3"
                  className="mt-1"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Default {DEFAULT_RATE_PCT}% p.a.</p>
              </div>
              <div>
                <Label htmlFor="loan-fee" className="text-xs">
                  Arrangement fee ({approveTarget?.currency ?? "EUR"}, optional)
                </Label>
                <Input
                  id="loan-fee"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  className="mt-1"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">One-time, debited on funding.</p>
              </div>
            </div>
            <div>
              <Label htmlFor="loan-approve-note" className="text-xs">
                Decision note (optional)
              </Label>
              <Textarea
                id="loan-approve-note"
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                rows={2}
                placeholder="Any note recorded with the approval."
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)} disabled={approving}>
              Cancel
            </Button>
            <Button onClick={confirmApprove} disabled={approving}>
              {approving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              {approving ? "Funding…" : "Approve & fund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline loan request</DialogTitle>
            <DialogDescription>
              {rejectTarget
                ? `Decline ${rejectTarget.holder}'s ${formatLoanMoney(
                    rejectTarget.requestedAmount,
                    rejectTarget.currency,
                  )} request. No funds are moved.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="loan-reject-reason" className="text-xs">
              Reason (optional — shared with the client)
            </Label>
            <Textarea
              id="loan-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={2}
              placeholder="e.g. Insufficient repayment guarantee for the requested amount."
              className="mt-1"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={rejecting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReject} disabled={rejecting}>
              {rejecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              {rejecting ? "Declining…" : "Decline request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discussion / negotiation dialog */}
      <Dialog open={!!discussTarget} onOpenChange={(o) => !o && setDiscussTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessagesSquare className="h-5 w-5 text-primary" /> Loan discussion
            </DialogTitle>
            <DialogDescription>
              {discussTarget
                ? `Message ${discussTarget.holder} directly, share or request supporting documents, and negotiate the terms of the ${formatLoanMoney(
                    discussTarget.requestedAmount,
                    discussTarget.currency,
                  )} request before you finalise the decision.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {discussTarget && (
            <LoanNegotiationThread
              key={discussTarget.approvalId}
              approvalId={discussTarget.approvalId}
              role="admin"
              passcode={passcode}
              readOnly={discussTarget.status !== "pending"}
            />
          )}
          {discussTarget && discussTarget.status === "pending" && (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="destructive"
                onClick={() => {
                  const t = discussTarget
                  setDiscussTarget(null)
                  setRejectTarget(t)
                }}
              >
                <XCircle className="mr-2 h-4 w-4" /> Decline
              </Button>
              <Button
                onClick={() => {
                  const t = discussTarget
                  setDiscussTarget(null)
                  openApprove(t)
                }}
              >
                <ShieldCheck className="mr-2 h-4 w-4" /> Evaluate &amp; fund
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
