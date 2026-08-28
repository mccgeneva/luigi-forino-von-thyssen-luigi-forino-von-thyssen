"use client"

import { useMemo, useState } from "react"
import {
  HandCoins,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Info,
  Percent,
  Wallet,
  MessagesSquare,
  HelpCircle,
  ShieldCheck,
  TrendingUp,
} from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
 import { Input } from "@/components/ui/input"
 import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useInternalLoans, type InternalLoanView } from "@/lib/internal-loan-store"
import { useInstrumentRequests } from "@/lib/instrument-requests-store"
import { useLeverageRequests } from "@/lib/leverage-requests-store"
import { usePPPRequests } from "@/lib/ppp-requests-store"
import { isLiveRequest } from "@/lib/live-request"
import { repayInternalLoan } from "@/app/actions/internal-loan"
import { INTERNAL_LOAN_DEFAULT_RATE, formatLoanMoney } from "@/lib/internal-loan"
import { Lock } from "lucide-react"
import Link from "next/link"
import { Messenger } from "@/components/bankeka/messenger"
import { listConversations, getThread, sendMessage, deleteMessage } from "@/app/actions/bankeka"
import { BANKEKA_ADMIN_ID, BANKEKA_ADMIN_LABEL, BANKEKA_ADMIN_INITIALS } from "@/lib/bankeka-shared"
import { ChevronDown } from "lucide-react"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

function StatusBadge({ status }: { status: InternalLoanView["status"] }) {
  if (status === "approved")
    return (
      <Badge className="gap-1 bg-green-500/15 text-green-400 hover:bg-green-500/15">
        <CheckCircle2 className="h-3 w-3" /> Funded
      </Badge>
    )
  if (status === "closed")
    return (
      <Badge className="gap-1 bg-muted text-muted-foreground hover:bg-muted">
        <CheckCircle2 className="h-3 w-3" /> Repaid
      </Badge>
    )
  if (status === "rejected" || status === "cancelled")
    return (
      <Badge className="gap-1 bg-red-500/15 text-red-400 hover:bg-red-500/15">
        <XCircle className="h-3 w-3" /> {status === "rejected" ? "Declined" : "Cancelled"}
      </Badge>
    )
  return (
    <Badge className="gap-1 bg-amber-500/15 text-amber-400 hover:bg-amber-500/15">
      <Clock className="h-3 w-3" /> Under review
    </Badge>
  )
}

/**
 * Internal Lending — customer surface.
 *
 * A plain internal loan the customer can request for ANY amount, distinct from
 * the security-deposit "Capital Lending" above and from AES/Treuhand
 * investment. Flow: request → administrator evaluates risk + repayment guarantee
 * → on approval the principal is credited to the master account. Carries 3% p.a.
 * debit interest by default (admin may override) plus an optional one-time
 * arrangement fee. Repay any time from the master balance (self-service).
 */
export function InternalLoanCard() {
  const { loans, hydrated, requestLoan, refresh } = useInternalLoans()
  const { instruments } = useInstrumentRequests()
  const { requests: leverageRequests } = useLeverageRequests()
  const { requests: pppRequests } = usePPPRequests()

  // Request form
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [purpose, setPurpose] = useState("")
  const [repaymentPlan, setRepaymentPlan] = useState("")
  const [collateralNote, setCollateralNote] = useState("")
  const [collateralInstrumentId, setCollateralInstrumentId] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // Instruments already committed to a LIVE facility (another internal loan, a
  // leverage line, or a yield/PPP program) — these are locked and cannot be
  // pledged again until released. Mirrors the instruments page in-use rule.
  const unavailableInstrumentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of leverageRequests) {
      if (r.pledgedInstrumentId && r.status !== "rejected" && r.status !== "closed") ids.add(r.pledgedInstrumentId)
    }
    for (const r of pppRequests) {
      if (r.fundingInstrumentId && r.status !== "rejected" && r.status !== "cancelled") ids.add(r.fundingInstrumentId)
    }
    for (const l of loans) {
      if (l.collateralInstrumentId && isLiveRequest(l)) ids.add(l.collateralInstrumentId)
    }
    return ids
  }, [leverageRequests, pppRequests, loans])

  // Active, non-blocked bank instruments the borrower can pledge as collateral —
  // their OWN instruments (e.g. an inbound MT760 blocked-funds guarantee) and any
  // held instrument that is not already locked to another live facility.
  const pledgeableInstruments = useMemo(
    () =>
      instruments.filter(
        (i) => i.status === "active" && !i.blocked && !unavailableInstrumentIds.has(i.id),
      ),
    [instruments, unavailableInstrumentIds],
  )
  const selectedCollateral = useMemo(
    () => pledgeableInstruments.find((i) => i.id === collateralInstrumentId) ?? null,
    [pledgeableInstruments, collateralInstrumentId],
  )

  // Per-loan repayment
  const [repayFor, setRepayFor] = useState<string | null>(null)
  const [repayAmount, setRepayAmount] = useState("")
  const [repaying, setRepaying] = useState(false)

  // Which pending loan's discussion thread is expanded inline.
  const [discussFor, setDiscussFor] = useState<string | null>(null)

  // Which loan's "understand this decision / usage" detail panel is expanded.
  const [detailFor, setDetailFor] = useState<string | null>(null)

  // Funded loans (live) plus fully-repaid ones (closed), so a repaid loan is
  // shown as "Repaid" rather than either vanishing or lingering as "Funded".
  // Live loans first, most-recent repaid next.
  const activeLoans = useMemo(
    () =>
      loans
        .filter((l) => l.status === "approved" || l.status === "closed")
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "approved" ? -1 : 1)),
    [loans],
  )
  const historyLoans = useMemo(
    () => loans.filter((l) => l.status === "pending" || l.status === "rejected" || l.status === "cancelled"),
    [loans],
  )

  const ratePct = (INTERNAL_LOAN_DEFAULT_RATE * 100).toFixed(0)

  const submit = async () => {
    if (submitting) return
    const value = Number.parseFloat(amount.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a valid loan amount greater than 0.")
      return
    }
    setSubmitting(true)
    const res = await requestLoan({
      amount: value,
      currency,
      purpose: purpose.trim(),
      repaymentPlan: repaymentPlan.trim(),
      collateralNote: collateralNote.trim() || undefined,
      collateralInstrumentId: selectedCollateral?.id,
      collateralInstrumentLabel: selectedCollateral
        ? `${selectedCollateral.type} ${selectedCollateral.id} · ${formatLoanMoney(
            selectedCollateral.faceValue,
            selectedCollateral.currency,
          )}`
        : undefined,
    })
    setSubmitting(false)
    if (!res.ok) {
      toast.error("Request not submitted", { description: res.error })
      return
    }
    toast.success("Loan request submitted", {
      description: selectedCollateral
        ? "Your pledged instrument is locked as collateral while the administrator evaluates the request."
        : "The administrator will evaluate your request and repayment guarantee.",
    })
    setAmount("")
    setPurpose("")
    setRepaymentPlan("")
    setCollateralNote("")
    setCollateralInstrumentId("")
  }

  const doRepay = async (loan: InternalLoanView) => {
    if (repaying) return
    const value = Number.parseFloat(repayAmount.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a valid repayment amount.")
      return
    }
    setRepaying(true)
    // Repay against the DB approval-row id. For loans created through the client
    // store this differs from `loan.id` (the client localId held in
    // payload.record.id), so passing loan.id makes getApprovalById miss and
    // report "Loan not found". `approvalId` is the authoritative key (same one
    // the outstanding-balance map is keyed on).
    const res = await repayInternalLoan({ approvalId: loan.approvalId ?? loan.id, amount: value })
    setRepaying(false)
    if (!res.ok) {
      toast.error("Repayment declined", { description: res.error })
      return
    }
    toast.success("Repayment posted", {
      description: `${formatLoanMoney(res.repaid, loan.currency)} repaid. Outstanding ${formatLoanMoney(
        res.outstanding,
        loan.currency,
      )}.`,
    })
    setRepayFor(null)
    setRepayAmount("")
    await refresh()
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-2">
          <HandCoins className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Internal Lending</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Request an internal loan for any amount. The administrator evaluates the risk and your
          repayment guarantee; once approved, the funds are credited straight to your master
          account. Separate from the security-deposit financing above.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Terms strip */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Loan amount</p>
            <p className="mt-1 text-lg font-semibold text-foreground">Up to unlimited</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Subject to administrator approval</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Debit interest</p>
            <p className="mt-1 flex items-center gap-1 text-lg font-semibold text-orange-400">
              <Percent className="h-4 w-4" /> {ratePct}% p.a.
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Default — administrator may adjust</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Disbursement</p>
            <p className="mt-1 text-lg font-semibold text-foreground">On approval</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Credited to your master account</p>
          </div>
        </div>

        {/* Active loans */}
        {activeLoans.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">Your loans</p>
            {activeLoans.map((loan) => {
              const isRepaid = loan.status === "closed" || (loan.outstanding ?? loan.amount) <= 0.01
              return (
              <div
                key={loan.id}
                className={cn(
                  "rounded-lg border border-border bg-secondary/30 p-4",
                  isRepaid && "opacity-70",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-base font-semibold",
                          isRepaid ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {formatLoanMoney(loan.amount, loan.currency)}
                      </span>
                      <StatusBadge status={loan.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isRepaid ? (
                        <span className="font-medium text-foreground">Repaid in full</span>
                      ) : loan.status === "approved" ? (
                        <>
                          Outstanding{" "}
                          <span className="font-medium text-foreground">
                            {formatLoanMoney(loan.outstanding ?? loan.amount, loan.currency)}
                          </span>{" "}
                          ·{" "}
                        </>
                      ) : null}
                      {!isRepaid && (
                        <>
                          {(loan.interestRate * 100).toFixed(2)}% p.a.
                          {(loan.arrangementFee ?? 0) > 0
                            ? ` · fee ${formatLoanMoney(loan.arrangementFee ?? 0, loan.currency)}`
                            : ""}
                        </>
                      )}
                    </p>
                    {loan.purpose && (
                      <p className="mt-0.5 text-xs text-muted-foreground">Purpose: {loan.purpose}</p>
                    )}
                    {loan.collateralInstrumentLabel && (
                      <p
                        className={cn(
                          "mt-0.5 flex items-center gap-1 text-xs",
                          isRepaid ? "text-muted-foreground" : "text-primary",
                        )}
                      >
                        <Lock className="h-3 w-3 shrink-0" />
                        {isRepaid
                          ? `Collateral released: ${loan.collateralInstrumentLabel}`
                          : `Collateral locked: ${loan.collateralInstrumentLabel}`}
                      </p>
                    )}
                  </div>
                  {loan.status === "approved" && (loan.outstanding ?? loan.amount) > 0.01 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRepayFor(repayFor === loan.id ? null : loan.id)
                        setRepayAmount((loan.outstanding ?? loan.amount).toFixed(2))
                      }}
                    >
                      <Wallet className="mr-1.5 h-3.5 w-3.5" /> Repay
                    </Button>
                  )}
                </div>

                {/* Funding breakdown — makes the one-time arrangement fee that
                    was CHARGED to the master account explicit. On a large loan
                    the fee is invisible in the balance number, so we spell out
                    principal credited − fee charged = net credited. */}
                {(loan.arrangementFee ?? 0) > 0 && (
                  <div className="mt-3 rounded-lg border border-border bg-card p-3">
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Charged to your master account
                    </p>
                    <dl className="space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">Principal credited</dt>
                        <dd className="font-medium text-green-400 tabular-nums">
                          + {formatLoanMoney(loan.amount, loan.currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted-foreground">Arrangement fee (one-time)</dt>
                        <dd className="font-medium text-orange-400 tabular-nums">
                          − {formatLoanMoney(loan.arrangementFee ?? 0, loan.currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-border pt-1.5">
                        <dt className="font-medium text-foreground">Net credited to master account</dt>
                        <dd className="font-semibold text-foreground tabular-nums">
                          {formatLoanMoney(loan.amount - (loan.arrangementFee ?? 0), loan.currency)}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      The fee shows in your transactions as{" "}
                      <span className="text-foreground">&ldquo;Internal Loan Fee&rdquo;</span>.
                    </p>
                  </div>
                )}

                {loan.status === "approved" && repayFor === loan.id && (loan.outstanding ?? loan.amount) > 0.01 && (
                  <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
                    <div className="flex-1 min-w-[160px]">
                      <Label htmlFor={`repay-${loan.id}`} className="text-xs">
                        Repay from master balance
                      </Label>
                      <MoneyInput
                        id={`repay-${loan.id}`}
                        value={repayAmount}
                        onValueChange={setRepayAmount}
                        placeholder="0.00"
                        className="mt-1"
                      />
                    </div>
                    <Button onClick={() => doRepay(loan)} disabled={repaying}>
                      {repaying ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Wallet className="mr-2 h-4 w-4" />
                      )}
                      {repaying ? "Processing…" : `Repay ${formatLoanMoney(Number(repayAmount) || 0, loan.currency)}`}
                    </Button>
                  </div>
                )}

                {/* Understand how the approved amount may be used. */}
                {loan.status === "approved" && !isRepaid && (
                  <div className="mt-3 border-t border-border pt-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-auto px-0 text-xs text-primary hover:bg-transparent hover:text-primary"
                      onClick={() => setDetailFor(detailFor === loan.id ? null : loan.id)}
                    >
                      <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                      {detailFor === loan.id ? "Hide usage & terms" : "How can I use this loan?"}
                      <ChevronDown
                        className={cn(
                          "ml-1 h-3.5 w-3.5 transition-transform",
                          detailFor === loan.id && "rotate-180",
                        )}
                      />
                    </Button>

                    {detailFor === loan.id && (() => {
                      const outstanding = loan.outstanding ?? loan.amount
                      const repaid = Math.max(0, loan.amount - outstanding)
                      const untouched = repaid <= 0.01
                      return (
                        <div className="mt-2 space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                          <div className="flex items-start gap-2">
                            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-foreground">
                                Authorized use of these funds
                              </p>
                              <p className="text-xs text-muted-foreground">
                                This financing was credited to your master account as trading buying power.
                                It is reserved for <span className="text-foreground">trading activity on
                                NAFTAhub</span> (opening positions, leverage margin, funding programs) and for{" "}
                                <span className="text-foreground">repaying this facility</span>. Borrowed
                                proceeds cannot be transferred or paid out to a third party — only your own
                                unborrowed funds can leave the account.
                              </p>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <div className="rounded-md border border-border bg-card p-2.5">
                              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Amount drawn
                              </p>
                              <p className="mt-0.5 text-sm font-semibold text-foreground">
                                {formatLoanMoney(loan.amount, loan.currency)}
                              </p>
                            </div>
                            <div className="rounded-md border border-border bg-card p-2.5">
                              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Repaid so far
                              </p>
                              <p className="mt-0.5 text-sm font-semibold text-foreground">
                                {formatLoanMoney(repaid, loan.currency)}
                              </p>
                            </div>
                            <div className="rounded-md border border-border bg-card p-2.5">
                              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Outstanding
                              </p>
                              <p className="mt-0.5 text-sm font-semibold text-foreground">
                                {formatLoanMoney(outstanding, loan.currency)}
                              </p>
                            </div>
                          </div>

                          <p className="text-xs text-muted-foreground">
                            {untouched ? (
                              <>
                                <span className="font-medium text-foreground">Not deployed yet.</span> The full{" "}
                                {formatLoanMoney(loan.amount, loan.currency)} is sitting in your master account
                                ready to trade. Put it to work in{" "}
                                <Link href="/dashboard/leverage" className="underline hover:text-foreground">
                                  Leverage
                                </Link>
                                ,{" "}
                                <Link href="/dashboard/trading" className="underline hover:text-foreground">
                                  Trading
                                </Link>{" "}
                                or a{" "}
                                <Link href="/dashboard/ppp" className="underline hover:text-foreground">
                                  funding program
                                </Link>
                                . When you want to close it, repay from your master balance above.
                              </>
                            ) : (
                              <>
                                <span className="font-medium text-foreground">In use.</span> You have repaid{" "}
                                {formatLoanMoney(repaid, loan.currency)} of{" "}
                                {formatLoanMoney(loan.amount, loan.currency)}; the remaining{" "}
                                {formatLoanMoney(outstanding, loan.currency)} stays deployed as trading capital
                                and accrues {(loan.interestRate * 100).toFixed(2)}% p.a. until repaid.
                              </>
                            )}
                          </p>
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
              )
            })}
          </div>
        )}

        {/* Request form */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">Request a new internal loan</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="loan-amount" className="text-xs">
                Amount
              </Label>
              <MoneyInput
                id="loan-amount"
                value={amount}
                onValueChange={setAmount}
                placeholder="e.g. 250,000"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="loan-currency" className="text-xs">
                Currency
              </Label>
              <select
                id="loan-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div>
              <Label htmlFor="loan-purpose" className="text-xs">
                Purpose <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="loan-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. Working capital for a trade settlement"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="loan-repay" className="text-xs">
                Proposed repayment plan <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="loan-repay"
                value={repaymentPlan}
                onChange={(e) => setRepaymentPlan(e.target.value)}
                placeholder="e.g. Repay in full within 90 days from incoming receivables"
                className="mt-1"
              />
            </div>
            {pledgeableInstruments.length > 0 && (
              <div>
                <Label htmlFor="loan-collateral-instrument" className="text-xs">
                  Pledge a bank instrument as collateral{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <select
                  id="loan-collateral-instrument"
                  value={collateralInstrumentId}
                  onChange={(e) => setCollateralInstrumentId(e.target.value)}
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None — unsecured request</option>
                  {pledgeableInstruments.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.type} {inst.id} · {formatLoanMoney(inst.faceValue, inst.currency)}
                    </option>
                  ))}
                </select>
                {selectedCollateral ? (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <p className="text-[11px] text-muted-foreground">
                      Your {selectedCollateral.type} {selectedCollateral.id} (
                      {formatLoanMoney(selectedCollateral.faceValue, selectedCollateral.currency)}) will be locked
                      as collateral on your behalf while this loan is live, and released automatically once the
                      loan is fully repaid. It cannot be pledged elsewhere, returned or deleted until then.
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Pledging an owned instrument (e.g. an MT760 blocked-funds guarantee) as security can improve
                    your risk profile. It stays yours — it is only locked as collateral until the loan is repaid.
                  </p>
                )}
              </div>
            )}
            <div>
              <Label htmlFor="loan-collateral" className="text-xs">
                Repayment guarantee / collateral note <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="loan-collateral"
                value={collateralNote}
                onChange={(e) => setCollateralNote(e.target.value)}
                placeholder="Describe any security, receivables, or guarantee supporting repayment — this helps the administrator's risk evaluation."
                rows={2}
                className="mt-1"
              />
            </div>
          </div>

          <div className="mt-3 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs text-muted-foreground">
              Your request is reviewed by the administrator, who evaluates the risk and repayment
              guarantee before approving. On approval the amount is credited to your master account
              and carries {ratePct}% p.a. debit interest (the administrator may set a different rate
              and an optional one-time arrangement fee).
            </p>
          </div>

          <Button onClick={submit} disabled={submitting} className="mt-3 w-full">
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <HandCoins className="mr-2 h-4 w-4" />}
            {submitting ? "Submitting…" : "Apply for internal loan"}
          </Button>
        </div>

        {/* Request history */}
        {historyLoans.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Requests</p>
            {historyLoans.map((loan) => {
              const isPending = loan.status === "pending"
              return (
                <div key={loan.id} className="rounded-lg border border-border bg-card">
                  <div className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-foreground">
                        {formatLoanMoney(loan.amount, loan.currency)}
                      </span>
                      {loan.purpose && (
                        <span className="ml-2 text-xs text-muted-foreground">· {loan.purpose}</span>
                      )}
                    </div>
                    <StatusBadge status={loan.status} />
                  </div>
                  {isPending && !loan.discussionOpenedAt && (
                    <div className="border-t border-border px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">
                        Under review. The administrator will open a discussion here to go over the terms
                        and request any supporting documents before funding.
                      </p>
                    </div>
                  )}

                  {/* Declined — let the client understand why and how to become eligible. */}
                  {loan.status === "rejected" && (
                    <div className="border-t border-border px-3 py-2.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-auto px-0 text-xs text-primary hover:bg-transparent hover:text-primary"
                        onClick={() => setDetailFor(detailFor === loan.id ? null : loan.id)}
                      >
                        <HelpCircle className="mr-1.5 h-3.5 w-3.5" />
                        {detailFor === loan.id ? "Hide explanation" : "Why was this declined?"}
                        <ChevronDown
                          className={cn(
                            "ml-1 h-3.5 w-3.5 transition-transform",
                            detailFor === loan.id && "rotate-180",
                          )}
                        />
                      </Button>

                      {detailFor === loan.id && (
                        <div className="mt-2 space-y-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                          {loan.decisionNote ? (
                            <div>
                              <p className="text-xs font-medium text-foreground">
                                Administrator&apos;s note
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{loan.decisionNote}</p>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              This request could not be approved at this time. Based on the current review, the
                              facility fell outside our treasury&apos;s risk appetite — typically because the
                              requested amount is high relative to your own unencumbered funds, the repayment
                              guarantee or collateral was not sufficient, or there is an item outstanding on the
                              account that needs to be cleared first.
                            </p>
                          )}

                          <div>
                            <p className="text-xs font-medium text-foreground">How to become eligible</p>
                            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                              <li>• Lower the requested amount, or reduce existing outstanding financing.</li>
                              <li>• Pledge a bank instrument or add your own equity as collateral to strengthen the request.</li>
                              <li>• Clear any overdue item on the account.</li>
                              <li>• Add a clear repayment plan tied to incoming receivables.</li>
                            </ul>
                          </div>

                          <p className="text-xs text-muted-foreground">
                            You are welcome to adjust the details and apply again above, or{" "}
                            <Link href="/dashboard/bankeka" className="underline hover:text-foreground">
                              message the administrator
                            </Link>{" "}
                            to discuss what would make this workable.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  {isPending && loan.discussionOpenedAt && (
                    <div className="border-t border-border px-3 py-2.5">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          The administrator opened a discussion. Reply and upload any requested documents
                          below.
                        </p>
                        <Button
                          size="sm"
                          variant={discussFor === loan.id ? "secondary" : "default"}
                          onClick={() => setDiscussFor(discussFor === loan.id ? null : loan.id)}
                        >
                          <MessagesSquare className="mr-1.5 h-3.5 w-3.5" />
                          {discussFor === loan.id ? "Hide discussion" : "Discuss with administrator"}
                          <ChevronDown
                            className={cn(
                              "ml-1 h-3.5 w-3.5 transition-transform",
                              discussFor === loan.id && "rotate-180",
                            )}
                          />
                        </Button>
                      </div>
                      {discussFor === loan.id && (
                        <Messenger
                          key={loan.id}
                          scope={`loan-discuss-${loan.id}`}
                          fetchConversations={listConversations}
                          fetchThread={getThread}
                          send={sendMessage}
                          deleteMessage={deleteMessage}
                          attachmentsEnabled
                          hideConversationList
                          initialThreadId={BANKEKA_ADMIN_ID}
                          initialParticipant={{
                            id: BANKEKA_ADMIN_ID,
                            name: BANKEKA_ADMIN_LABEL,
                            company: "",
                            initials: BANKEKA_ADMIN_INITIALS,
                            isAdmin: true,
                          }}
                        />
                      )}
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        This conversation also lives in your{" "}
                        <Link href="/dashboard/bankeka" className="underline hover:text-foreground">
                          Bankeka chat
                        </Link>
                        .
                      </p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!hydrated && (
          <p className="py-2 text-center text-xs text-muted-foreground">Loading your loans…</p>
        )}
      </CardContent>
    </Card>
  )
}
