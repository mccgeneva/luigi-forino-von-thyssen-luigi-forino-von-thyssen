"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Scale,
  Check,
  CircleSlash,
  RefreshCw,
  AlertTriangle,
  Search,
  ArrowRight,
  Banknote,
  Loader2,
  Network,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { GATEWAY_CURRENCIES } from "@/lib/gateway-store"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  listReconciliationsAdmin,
  submitIncomingPaymentAdmin,
  rerunReconciliationAdmin,
  resolveReconciliationAdmin,
  ignoreReconciliationAdmin,
  type ReconciliationRecord,
} from "@/app/actions/reconciliation"
import type { ReconciliationStatus } from "@/lib/reconciliation"
import { toast } from "sonner"

const formatCurrency = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const formatTimestamp = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

const STATUS_META: Record<
  ReconciliationStatus,
  { label: string; className: string }
> = {
  reconciled: {
    label: "Reconciled",
    className: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  needs_review: {
    label: "Needs review",
    className: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  unmatched: {
    label: "Unmatched",
    className: "border-transparent bg-destructive/15 text-destructive",
  },
  ignored: {
    label: "Ignored",
    className: "border-transparent bg-muted text-muted-foreground",
  },
}

function StatusBadge({ status }: { status: ReconciliationStatus }) {
  const meta = STATUS_META[status]
  return <Badge className={meta.className}>{meta.label}</Badge>
}

const emptyForm = {
  amount: "",
  currency: "EUR",
  payer: "",
  reference: "",
  senderIban: "",
  senderBic: "",
}

export function AdminReconciliationSection() {
  const [records, setRecords] = useState<ReconciliationRecord[]>([])
  const [loading, setLoading] = useState(true)

  // Entry form
  const [form, setForm] = useState({ ...emptyForm })
  const [submitting, setSubmitting] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  // Resolve dialog
  const [resolveTarget, setResolveTarget] = useState<ReconciliationRecord | null>(null)
  const [resolveChoice, setResolveChoice] = useState<string>("")
  const [resolveNote, setResolveNote] = useState("")
  const [resolving, setResolving] = useState(false)

  // Ignore dialog
  const [ignoreTarget, setIgnoreTarget] = useState<ReconciliationRecord | null>(null)
  const [ignoreNote, setIgnoreNote] = useState("")
  const [ignoring, setIgnoring] = useState(false)

  const refresh = useCallback(async () => {
    const res = await listReconciliationsAdmin(ADMIN_PASSCODE)
    if (res.ok) setRecords(res.records)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const queue = useMemo(
    () => records.filter((r) => r.status === "needs_review" || r.status === "unmatched"),
    [records],
  )
  const history = useMemo(
    () => records.filter((r) => r.status === "reconciled" || r.status === "ignored"),
    [records],
  )

  const reconciledCount = records.filter((r) => r.status === "reconciled").length

  const submit = async () => {
    if (!form.amount.trim() || Number(form.amount) <= 0) {
      toast.error("Enter a valid amount.")
      return
    }
    if (!form.payer.trim()) {
      toast.error("Enter the ordering customer / payer.")
      return
    }
    if (!form.reference.trim()) {
      toast.error("Enter the remittance reference.")
      return
    }
    setSubmitting(true)
    const res = await submitIncomingPaymentAdmin(ADMIN_PASSCODE, {
      amount: Number(form.amount),
      currency: form.currency,
      payer: form.payer,
      reference: form.reference,
      senderIban: form.senderIban,
      senderBic: form.senderBic,
    })
    setSubmitting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRecords(res.records)
    const result = res.records.find((r) => r.id === res.lastId)
    if (result?.status === "reconciled") {
      toast.success(`Auto-reconciled to ${result.matchedAccountHolder}.`)
    } else if (result?.status === "unmatched") {
      toast.warning("No match found — sent to review queue.")
    } else {
      toast.warning("Needs review — candidates ready for selection.")
    }
    setForm({ ...emptyForm, currency: form.currency })
  }

  const rerun = async () => {
    setRerunning(true)
    const res = await rerunReconciliationAdmin(ADMIN_PASSCODE)
    setRerunning(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRecords(res.records)
    toast.success("Reconciliation re-run complete.")
  }

  const openResolve = (record: ReconciliationRecord) => {
    setResolveTarget(record)
    const best = record.candidates[0]
    setResolveChoice(best ? `${best.userId}::${best.requestId}` : "")
    setResolveNote("")
  }

  const confirmResolve = async () => {
    if (!resolveTarget || !resolveChoice) return
    const [userId, requestId] = resolveChoice.split("::")
    setResolving(true)
    const res = await resolveReconciliationAdmin(
      ADMIN_PASSCODE,
      resolveTarget.id,
      userId,
      requestId,
      resolveNote,
    )
    setResolving(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRecords(res.records)
    setResolveTarget(null)
    toast.success("Payment reconciled to the selected account.")
  }

  const confirmIgnore = async () => {
    if (!ignoreTarget) return
    setIgnoring(true)
    const res = await ignoreReconciliationAdmin(ADMIN_PASSCODE, ignoreTarget.id, ignoreNote)
    setIgnoring(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRecords(res.records)
    setIgnoreTarget(null)
    toast.success("Payment marked as ignored.")
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Scale className="h-5 w-5 text-primary" />
              Payment Reconciliation
            </CardTitle>
            <p className="text-sm text-muted-foreground text-pretty">
              Key in inbound payments to automatically match them against active gateway accounts by
              remittance reference. Confident matches are credited to the client&apos;s Master Account
              immediately; anything ambiguous is held here for manual review.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-2">
            <Link href="/dashboard/admin/swift">
              <Network className="h-4 w-4" />
              SWIFT Inspector
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-8">
        {/* Summary chips */}
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <Check className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-medium text-foreground">{reconciledCount}</span>
            <span className="text-sm text-muted-foreground">reconciled</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-medium text-foreground">{queue.length}</span>
            <span className="text-sm text-muted-foreground">awaiting review</span>
          </div>
        </div>

        {/* Manual entry form */}
        <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Banknote className="h-4 w-4 text-primary" />
            Record an incoming payment
          </h3>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rcn-amount">Amount</Label>
              <MoneyInput
                id="rcn-amount"
                placeholder="0.00"
                value={form.amount}
                onValueChange={(v) => setForm((f) => ({ ...f, amount: v }))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rcn-currency">Currency</Label>
              <Select
                value={form.currency}
                onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
              >
                <SelectTrigger id="rcn-currency">
                  <SelectValue placeholder="Currency" />
                </SelectTrigger>
                <SelectContent>
                  {GATEWAY_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rcn-payer">Ordering customer / payer</Label>
              <Input
                id="rcn-payer"
                placeholder="e.g. Helios Trading Ltd"
                value={form.payer}
                onChange={(e) => setForm((f) => ({ ...f, payer: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rcn-reference">Remittance reference</Label>
              <Input
                id="rcn-reference"
                placeholder="Reference quoted by the sender"
                value={form.reference}
                onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              />
            </div>
            <VerifiedBankField
              id="rcn-iban"
              label="Sender IBAN (optional)"
              kind="iban"
              lenient
              value={form.senderIban}
              onChange={(v) => setForm((f) => ({ ...f, senderIban: v }))}
              placeholder="Sender account IBAN"
            />
            <VerifiedBankField
              id="rcn-bic"
              label="Sender BIC (optional)"
              kind="bic"
              value={form.senderBic}
              onChange={(v) => setForm((f) => ({ ...f, senderBic: v }))}
              placeholder="Sender bank BIC"
            />
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground text-pretty">
              The engine runs automatically on submit. Use re-run after approving new gateway
              accounts to re-match parked payments.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={rerun}
                disabled={rerunning}
                className="gap-2 bg-transparent"
              >
                {rerunning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Run reconciliation
              </Button>
              <Button type="button" onClick={submit} disabled={submitting} className="gap-2">
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Match payment
              </Button>
            </div>
          </div>
        </section>

        {/* Review queue */}
        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Search className="h-4 w-4 text-amber-500" />
            Manual review queue
            {queue.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {queue.length}
              </Badge>
            )}
          </h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading reconciliations…</p>
          ) : queue.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing awaiting review. Confident matches are credited automatically.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {queue.map((record) => (
                <li
                  key={record.id}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {formatCurrency(record.payment.amount, record.payment.currency)}
                        </span>
                        <StatusBadge status={record.status} />
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        From <span className="text-foreground">{record.payment.payer}</span> · ref{" "}
                        <span className="font-mono text-foreground">{record.payment.reference}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground text-pretty">
                        {record.summary}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 bg-transparent"
                        onClick={() => {
                          setIgnoreTarget(record)
                          setIgnoreNote("")
                        }}
                      >
                        <CircleSlash className="h-4 w-4" />
                        Ignore
                      </Button>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => openResolve(record)}
                        disabled={record.candidates.length === 0}
                      >
                        <Check className="h-4 w-4" />
                        Resolve
                      </Button>
                    </div>
                  </div>

                  {record.candidates.length > 0 && (
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Candidate accounts
                      </p>
                      <ul className="mt-2 flex flex-col gap-2">
                        {record.candidates.slice(0, 3).map((c) => (
                          <li
                            key={`${c.userId}-${c.requestId}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-foreground">
                                {c.accountHolder}
                              </span>
                              {c.company && (
                                <span className="text-sm text-muted-foreground"> · {c.company}</span>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {c.partnerBankName ?? "—"} · ref{" "}
                                <span className="font-mono">{c.reference}</span> · {c.currency}
                              </p>
                            </div>
                            <Badge variant="outline" className="shrink-0">
                              {c.score}% match
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* History */}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Reconciliation history</h3>
          {history.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No reconciled or ignored payments yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Payment</th>
                    <th className="px-4 py-3 font-medium">Reference</th>
                    <th className="px-4 py-3 font-medium">Destination</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => (
                    <tr key={record.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {formatCurrency(record.payment.amount, record.payment.currency)}
                        </div>
                        <div className="text-xs text-muted-foreground">{record.payment.payer}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {record.payment.reference}
                      </td>
                      <td className="px-4 py-3">
                        {record.matchedAccountHolder ? (
                          <div>
                            <div className="text-foreground">{record.matchedAccountHolder}</div>
                            {record.ledgerEntryId && (
                              <div className="font-mono text-xs text-muted-foreground">
                                {record.ledgerEntryId}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={record.status} />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatTimestamp(record.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>

      {/* Resolve dialog */}
      <Dialog open={!!resolveTarget} onOpenChange={(open) => !open && setResolveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve payment</DialogTitle>
            <DialogDescription>
              {resolveTarget && (
                <>
                  Credit{" "}
                  {formatCurrency(resolveTarget.payment.amount, resolveTarget.payment.currency)} from{" "}
                  {resolveTarget.payment.payer} to the selected client&apos;s Master Account.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="resolve-account">Destination account</Label>
              <Select value={resolveChoice} onValueChange={setResolveChoice}>
                <SelectTrigger id="resolve-account">
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {resolveTarget?.candidates.map((c) => (
                    <SelectItem
                      key={`${c.userId}-${c.requestId}`}
                      value={`${c.userId}::${c.requestId}`}
                    >
                      {c.accountHolder} · {c.reference} · {c.currency} ({c.score}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="resolve-note">Note (optional)</Label>
              <Textarea
                id="resolve-note"
                placeholder="Reason for manual reconciliation"
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveTarget(null)} className="bg-transparent">
              Cancel
            </Button>
            <Button onClick={confirmResolve} disabled={!resolveChoice || resolving} className="gap-2">
              {resolving && <Loader2 className="h-4 w-4 animate-spin" />}
              Credit Master Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ignore dialog */}
      <Dialog open={!!ignoreTarget} onOpenChange={(open) => !open && setIgnoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ignore payment</DialogTitle>
            <DialogDescription>
              {ignoreTarget && (
                <>
                  Mark{" "}
                  {formatCurrency(ignoreTarget.payment.amount, ignoreTarget.payment.currency)} from{" "}
                  {ignoreTarget.payment.payer} as ignored. No funds will be credited.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ignore-note">Reason (optional)</Label>
            <Textarea
              id="ignore-note"
              placeholder="e.g. Duplicate of an earlier wire"
              value={ignoreNote}
              onChange={(e) => setIgnoreNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIgnoreTarget(null)} className="bg-transparent">
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmIgnore} disabled={ignoring} className="gap-2">
              {ignoring && <Loader2 className="h-4 w-4 animate-spin" />}
              Mark ignored
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
