"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { toast } from "sonner"
import { DoorOpen, Loader2, XCircle, RefreshCw } from "lucide-react"
import {
  adminListInstrumentExitRequests,
  adminConfirmInstrumentExit,
  adminRejectInstrumentExit,
  type AdminInstrumentExitRow,
} from "@/app/actions/approvals"
import { applyCashback, formatCashbackPct } from "@/lib/fee-cashback"

function fmt(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function InstrumentExitManager() {
  const [rows, setRows] = useState<AdminInstrumentExitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [cashback, setCashback] = useState<Record<string, string>>({})
  const [note, setNote] = useState<Record<string, string>>({})
  const [rejectOpen, setRejectOpen] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminListInstrumentExitRequests(ADMIN_PASSCODE)
      setRows(res)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const confirm = async (row: AdminInstrumentExitRow) => {
    const pct = Number(cashback[row.approvalId] ?? "")
    const rateFraction = Number.isFinite(pct) && pct > 0 ? Math.min(1, pct / 100) : 0
    setBusy(row.approvalId)
    try {
      const res = await adminConfirmInstrumentExit(ADMIN_PASSCODE, row.approvalId, {
        cashbackRate: rateFraction > 0 ? rateFraction : undefined,
        note: note[row.approvalId] ?? "",
      })
      if (res.ok) {
        toast.success("Instrument exit confirmed", {
          description: `${row.instrLabel} settled out. Fee charged: ${fmt(res.feeCharged ?? 0, res.currency ?? row.currency)}.`,
        })
        setRows((prev) => prev.filter((r) => r.approvalId !== row.approvalId))
      } else {
        toast.error("Could not confirm the exit", { description: res.error })
      }
    } finally {
      setBusy(null)
    }
  }

  const reject = async (row: AdminInstrumentExitRow) => {
    setBusy(row.approvalId)
    try {
      const res = await adminRejectInstrumentExit(ADMIN_PASSCODE, row.approvalId, rejectReason[row.approvalId] ?? "")
      if (res.ok) {
        toast.success("Exit request declined", { description: `${row.instrLabel} stays in the client's portfolio.` })
        setRows((prev) => prev.filter((r) => r.approvalId !== row.approvalId))
      } else {
        toast.error("Could not decline the request", { description: res.error })
      }
    } finally {
      setBusy(null)
      setRejectOpen(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <DoorOpen className="h-5 w-5 text-primary" />
              Instrument Exit Requests
            </CardTitle>
            <CardDescription>
              Clients requesting to settle out (exit) a bank instrument. Apply a cashback % to reduce the settlement
              cost, then confirm — the instrument is removed and the net fee is charged. Nothing is charged until you
              confirm.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading exit requests…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No instrument exit requests awaiting review.</p>
        ) : (
          rows.map((row) => {
            const pct = Number(cashback[row.approvalId] ?? "")
            const rateFraction = Number.isFinite(pct) && pct > 0 ? Math.min(1, pct / 100) : 0
            const cb = applyCashback(row.standardFee, rateFraction)
            return (
              <div key={row.approvalId} className="rounded-lg border border-border bg-background/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{row.instrLabel}</p>
                    <p className="text-sm text-muted-foreground break-all">
                      {row.holderLabel}
                      {row.holderEmail ? ` · ${row.holderEmail}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Face value {fmt(row.faceValue, row.currency)} · requested{" "}
                      {new Date(row.requestedAt).toLocaleString("en-GB")}
                    </p>
                    {row.reason ? (
                      <p className="mt-1 text-xs text-foreground">
                        <span className="text-muted-foreground">Client note:</span> {row.reason}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                  <p className="text-xs font-medium text-foreground">Apply a cashback before confirming (optional)</p>
                  <div className="mt-2 flex flex-col gap-1">
                    <label htmlFor={`cb-${row.approvalId}`} className="text-xs text-muted-foreground">
                      Cashback %
                    </label>
                    <div className="relative w-32">
                      <Input
                        id={`cb-${row.approvalId}`}
                        inputMode="decimal"
                        value={cashback[row.approvalId] ?? ""}
                        onChange={(e) =>
                          setCashback((prev) => ({ ...prev, [row.approvalId]: e.target.value.replace(/[^0-9.]/g, "") }))
                        }
                        placeholder="0"
                        className="h-10 pr-7 text-base"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        %
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 rounded-md bg-background/60 p-2.5 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Standard settlement fee (0.035%)</span>
                      <span className={rateFraction > 0 ? "text-muted-foreground line-through" : "text-foreground"}>
                        {fmt(cb.originalFee, row.currency)}
                      </span>
                    </div>
                    {rateFraction > 0 && (
                      <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                        <span>Cashback ({formatCashbackPct(cb.cashbackRate)})</span>
                        <span>−{fmt(cb.cashbackAmount, row.currency)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between font-semibold text-foreground">
                      <span>Charged to customer</span>
                      <span>{fmt(cb.netFee, row.currency)}</span>
                    </div>
                  </div>
                  <Textarea
                    value={note[row.approvalId] ?? ""}
                    onChange={(e) => setNote((prev) => ({ ...prev, [row.approvalId]: e.target.value }))}
                    placeholder="Note (optional) — recorded on the settlement."
                    rows={2}
                    className="mt-2 text-base"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void confirm(row)} disabled={busy === row.approvalId} className="gap-1.5">
                      {busy === row.approvalId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <DoorOpen className="h-4 w-4" />
                      )}
                      Confirm exit — charge {fmt(cb.netFee, row.currency)}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRejectOpen(rejectOpen === row.approvalId ? null : row.approvalId)}
                      disabled={busy === row.approvalId}
                      className="gap-1.5 text-destructive"
                    >
                      <XCircle className="h-4 w-4" />
                      Decline
                    </Button>
                  </div>
                  {rejectOpen === row.approvalId && (
                    <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
                      <Textarea
                        value={rejectReason[row.approvalId] ?? ""}
                        onChange={(e) => setRejectReason((prev) => ({ ...prev, [row.approvalId]: e.target.value }))}
                        placeholder="Reason (optional) shown to the client."
                        rows={2}
                        className="text-base"
                      />
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="destructive" onClick={() => void reject(row)} disabled={busy === row.approvalId}>
                          Confirm decline
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRejectOpen(null)} disabled={busy === row.approvalId}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
