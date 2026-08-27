"use client"

import { useCallback, useEffect, useState } from "react"
import { PiggyBank, Loader2, CheckCircle2, XCircle, Clock, Handshake } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  listEquityReleasesAdmin,
  decideEquityReleaseAdmin,
} from "@/app/actions/equity-savings"
import type { EquityReleaseRequest } from "@/lib/equity-release-db"
import { toast } from "sonner"

function fmtMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

/** Value for a datetime-local input, N hours from now. */
function localDateTime(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function EquityReleaseManager() {
  const [requests, setRequests] = useState<EquityReleaseRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Per-request negotiation form state (only for the row being actioned).
  const [openId, setOpenId] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [timing, setTiming] = useState<"now" | "schedule">("now")
  const [releaseAt, setReleaseAt] = useState("")
  const [modality, setModality] = useState("")
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    try {
      const rows = await listEquityReleasesAdmin(ADMIN_PASSCODE)
      setRequests(rows)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openNegotiation = (r: EquityReleaseRequest) => {
    setOpenId(r.id)
    setAmount(String(r.requestedAmount))
    setTiming("now")
    setReleaseAt(localDateTime(24))
    setModality("")
    setNote("")
  }

  const closeNegotiation = () => setOpenId(null)

  const approve = async (r: EquityReleaseRequest) => {
    const amt = Number.parseFloat(amount || "0") || 0
    if (amt <= 0) {
      toast.error("Enter a release amount greater than zero.")
      return
    }
    setBusyId(r.id)
    const res = await decideEquityReleaseAdmin(ADMIN_PASSCODE, r.id, {
      approve: true,
      amount: amt,
      releaseAt: timing === "schedule" ? new Date(releaseAt).toISOString() : null,
      modality: modality.trim() || undefined,
      note: note.trim() || undefined,
    })
    setBusyId(null)
    if (!res.ok) {
      toast.error("Could not approve", { description: res.error })
      return
    }
    toast.success(
      timing === "schedule" ? "Release scheduled" : "Equity released",
      { description: `${fmtMoney(amt, r.currency)} for ${r.holderLabel}` },
    )
    setOpenId(null)
    await load()
  }

  const reject = async (r: EquityReleaseRequest) => {
    setBusyId(r.id)
    const res = await decideEquityReleaseAdmin(ADMIN_PASSCODE, r.id, {
      approve: false,
      note: note.trim() || undefined,
    })
    setBusyId(null)
    if (!res.ok) {
      toast.error("Could not decline", { description: res.error })
      return
    }
    toast.success("Request declined")
    setOpenId(null)
    await load()
  }

  const pending = requests.filter((r) => r.status === "pending")
  const scheduled = requests.filter((r) => r.status === "scheduled")

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5 text-primary" />
          <CardTitle>Equity release requests</CardTitle>
        </div>
        <CardDescription>
          Customers can no longer self-release blocked equity. Review each request and negotiate the amount, the
          modality and the timing. Approving with a future time schedules an automatic credit; approving now unblocks
          the funds immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading requests…
          </div>
        ) : requests.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <PiggyBank className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-2 text-sm text-muted-foreground">No release requests awaiting a decision.</p>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Awaiting decision ({pending.length})
                </p>
                {pending.map((r) => (
                  <div key={r.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{r.holderLabel}</p>
                        <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                          {fmtMoney(r.requestedAmount, r.currency)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Requested {fmtWhen(r.createdAt)}</p>
                        {r.adminNote && <p className="mt-1 text-xs text-muted-foreground">{r.adminNote}</p>}
                      </div>
                      <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/15 text-amber-600">
                        <Clock className="h-3 w-3" />
                        Pending
                      </Badge>
                    </div>

                    {openId === r.id ? (
                      <div className="mt-4 space-y-3 rounded-md border border-border bg-background/60 p-3">
                        <div>
                          <Label htmlFor={`amt-${r.id}`} className="text-xs">
                            Amount to release ({r.currency})
                          </Label>
                          <Input
                            id={`amt-${r.id}`}
                            inputMode="decimal"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            className="mt-1"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            Requested {fmtMoney(r.requestedAmount, r.currency)}. You may release a smaller amount.
                          </p>
                        </div>

                        <div>
                          <Label className="text-xs">Timing</Label>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant={timing === "now" ? "default" : "outline"}
                              onClick={() => setTiming("now")}
                            >
                              Release now
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={timing === "schedule" ? "default" : "outline"}
                              onClick={() => setTiming("schedule")}
                            >
                              Schedule
                            </Button>
                          </div>
                          {timing === "schedule" && (
                            <Input
                              type="datetime-local"
                              value={releaseAt}
                              onChange={(e) => setReleaseAt(e.target.value)}
                              className="mt-2"
                            />
                          )}
                        </div>

                        <div>
                          <Label htmlFor={`mod-${r.id}`} className="text-xs">
                            Agreed modality / terms (shown to the customer)
                          </Label>
                          <Input
                            id={`mod-${r.id}`}
                            value={modality}
                            onChange={(e) => setModality(e.target.value)}
                            placeholder="e.g. Released in two tranches after collateral review"
                            className="mt-1"
                          />
                        </div>

                        <div>
                          <Label htmlFor={`note-${r.id}`} className="text-xs">
                            Internal / decision note (optional)
                          </Label>
                          <Textarea
                            id={`note-${r.id}`}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            rows={2}
                            className="mt-1"
                          />
                        </div>

                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button type="button" size="sm" onClick={() => approve(r)} disabled={busyId === r.id}>
                            {busyId === r.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                            )}
                            {timing === "schedule" ? "Approve & schedule" : "Approve & release now"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="border-destructive/40 text-destructive"
                            onClick={() => reject(r)}
                            disabled={busyId === r.id}
                          >
                            <XCircle className="mr-2 h-4 w-4" />
                            Decline
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={closeNegotiation} disabled={busyId === r.id}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3">
                        <Button type="button" size="sm" onClick={() => openNegotiation(r)}>
                          <Handshake className="mr-2 h-4 w-4" />
                          Negotiate & decide
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {scheduled.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Scheduled ({scheduled.length})
                </p>
                {scheduled.map((r) => (
                  <div key={r.id} className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{r.holderLabel}</p>
                        <p className="mt-0.5 text-base font-semibold tabular-nums text-foreground">
                          {fmtMoney(r.approvedAmount ?? r.requestedAmount, r.currency)}
                        </p>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-sky-500">
                          <Clock className="h-3.5 w-3.5" />
                          Auto-credits {fmtWhen(r.releaseAt)}
                        </p>
                        {r.modality && (
                          <p className="mt-1 text-xs text-muted-foreground">Terms: {r.modality}</p>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-destructive/40 text-destructive"
                        onClick={() => reject(r)}
                        disabled={busyId === r.id}
                      >
                        {busyId === r.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                        Cancel schedule
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
