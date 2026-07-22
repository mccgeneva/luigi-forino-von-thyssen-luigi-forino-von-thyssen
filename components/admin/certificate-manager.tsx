"use client"

import { useEffect, useMemo, useState } from "react"
import { Award, Check, X, Clock, History, RefreshCw, BadgeCheck, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"

// Neutral fallback used for labels before the client list has loaded or when an
// id no longer resolves to an account. Never a real account.
const FALLBACK_CLIENT: SelectableClient = { id: "", fullName: "—", company: "—", email: "", kind: "dynamic" }
import { CERTIFICATE_TYPE_LABELS, type CertificateRequest } from "@/lib/certificates-store"
import type {
  CertificateListResult,
  CertificateRecordList,
  CertificateMutation,
} from "@/app/actions/certificates"

// Admin certificate reads/decisions go through a Route Handler, NOT direct
// Server Actions. Server Action POSTs can be silently rejected on this app's
// production domains + mobile in-app webviews, which left the approval queue
// empty ("nothing to approve") even while a client's request was pending in the
// database. Route Handlers are exempt from that Origin/Host check. Mirrors the
// /api/admin/marketplace and /api/admin/users fixes.
async function certAdminGet<T>(params?: Record<string, string>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ""
  const res = await fetch(`/api/admin/certificates${qs}`, {
    method: "GET",
    headers: { "x-admin-passcode": ADMIN_PASSCODE },
    cache: "no-store",
  })
  return (await res.json()) as T
}

async function certAdminPost<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/admin/certificates", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
    body: JSON.stringify(payload),
  })
  return (await res.json()) as T
}

const statusStyles: Record<CertificateRequest["status"], string> = {
  pending: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  approved: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  rejected: "border-red-500/20 bg-red-500/10 text-red-400",
}

const fmt = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

const money = (amount: number, currency: string) =>
  `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function CertificateManager() {
  const logActivity = useActivityLog()

  const [clients, setClients] = useState<SelectableClient[]>([])
  const [targetUserId, setTargetUserId] = useState("")
  const [requests, setRequests] = useState<CertificateRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)

  // Pending requests across ALL clients, so the administrator never has to guess
  // which client account filed a request before it can be reviewed.
  const [pendingAll, setPendingAll] = useState<{ id: string; userId: string; request: CertificateRequest }[]>([])
  const [pendingLoading, setPendingLoading] = useState(false)

  // Decision dialog
  const [decision, setDecision] = useState<{ req: CertificateRequest; mode: "approve" | "reject" } | null>(null)
  const [note, setNote] = useState("")
  const [auditReq, setAuditReq] = useState<CertificateRequest | null>(null)

  const targetUser = clients.find((c) => c.id === targetUserId) ?? FALLBACK_CLIENT

  useEffect(() => {
    let active = true
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        if (!active || !list.length) return
        setClients(list)
        // Default to the first client once the list loads.
        setTargetUserId((cur) => cur || list[0].id)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const reload = (userId: string) => {
    setLoading(true)
    return certAdminGet<CertificateListResult>({ userId })
      .then((res) => {
        // Ignore a stale response if the admin switched clients meanwhile.
        if (userId !== targetUserId) return
        if (res.ok) setRequests(res.requests)
        else toast.error("Could not load certificate requests", { description: res.error })
      })
      .catch(() => toast.error("Could not load certificate requests"))
      .finally(() => {
        if (userId === targetUserId) setLoading(false)
      })
  }

  const reloadPending = () => {
    setPendingLoading(true)
    return certAdminGet<CertificateRecordList>()
      .then((res) => {
        if (res.ok) setPendingAll(res.requests)
        else toast.error("Could not load pending certificates", { description: res.error })
      })
      .catch(() => toast.error("Could not load pending certificates"))
      .finally(() => setPendingLoading(false))
  }

  useEffect(() => {
    reload(targetUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId])

  useEffect(() => {
    reloadPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resolve a friendly client label for a pending row whose owner may be a
  // static or dynamically-created account.
  const clientLabel = (userId: string) => {
    const c = clients.find((x) => x.id === userId)
    if (c) return `${c.fullName} — ${c.company}`
    return userId
  }

  const pending = useMemo(() => requests.filter((r) => r.status === "pending"), [requests])
  const decided = useMemo(() => requests.filter((r) => r.status !== "pending"), [requests])

  const openDecision = (req: CertificateRequest, mode: "approve" | "reject") => {
    setDecision({ req, mode })
    setNote("")
  }

  const confirmDecision = async () => {
    if (!decision) return
    const { req, mode } = decision
    setWorking(true)
    const res = await certAdminPost<CertificateMutation>({
      action: "decide",
      id: req.id,
      mode,
      note,
      adminName: targetUser.fullName,
    })
    setWorking(false)
    if (!res.ok) {
      toast.error("Action failed", { description: res.error })
      return
    }
    await Promise.all([reload(targetUserId), reloadPending()])
    toast.success(mode === "approve" ? "Certificate issued" : "Request declined", {
      description: `${CERTIFICATE_TYPE_LABELS[req.type]} (${req.reference}) for ${targetUser.fullName}.`,
    })
    logActivity({
      action: `${mode === "approve" ? "Approved & issued" : "Declined"} ${CERTIFICATE_TYPE_LABELS[req.type]}`,
      category: "Administration",
      details: {
        summary: `Compliance ${mode === "approve" ? "approved and issued" : "declined"} the ${CERTIFICATE_TYPE_LABELS[req.type]} request ${req.reference} for ${targetUser.fullName} (${targetUser.company}).${note.trim() ? ` Note: ${note.trim()}` : ""}`,
        reference: req.reference,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: mode === "approve" ? "Approved" : "Rejected",
      },
    })
    setDecision(null)
  }

  const reissue = async (req: CertificateRequest) => {
    setWorking(true)
    const res = await certAdminPost<CertificateMutation>({
      action: "reissue",
      id: req.id,
      adminName: targetUser.fullName,
    })
    setWorking(false)
    if (!res.ok) {
      toast.error("Re-issue failed", { description: res.error })
      return
    }
    await Promise.all([reload(targetUserId), reloadPending()])
    const nextVersion = res.request?.version ?? req.version + 1
    toast.success("Certificate re-issued", {
      description: `${req.reference} is now revision ${nextVersion}.`,
    })
    logActivity({
      action: `Re-issued ${CERTIFICATE_TYPE_LABELS[req.type]}`,
      category: "Administration",
      details: {
        summary: `Compliance re-issued the ${CERTIFICATE_TYPE_LABELS[req.type]} ${req.reference} for ${targetUser.fullName}, bumping it to revision ${nextVersion}.`,
        reference: req.reference,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
      },
    })
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Award className="h-5 w-5 text-primary" />
          Bank Certificates — Approval & Issuance
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Review client certificate requests, approve and issue official documents, or decline with a reason. All
          actions are recorded in the audit trail.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Cross-client pending overview — surfaces every request awaiting a
            decision regardless of which client account is currently selected,
            so the administrator never misses a submission. */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock className="h-4 w-4 text-amber-400" />
              Awaiting your approval ({pendingAll.length})
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={reloadPending}
              disabled={pendingLoading}
              className="h-8 gap-1.5 text-xs"
            >
              {pendingLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
          {pendingAll.length === 0 ? (
            <p className="mt-2 text-sm italic text-muted-foreground">
              No certificate requests are awaiting approval across any client account.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {pendingAll.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {CERTIFICATE_TYPE_LABELS[p.request.type]}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{p.request.reference}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {clientLabel(p.userId)} · requested {fmt(p.request.submittedAt)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={p.userId === targetUserId ? "secondary" : "default"}
                    className="shrink-0"
                    onClick={() => setTargetUserId(p.userId)}
                  >
                    {p.userId === targetUserId ? "Selected below" : "Review"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Client selector */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Client account</Label>
          <div className="flex items-center gap-2">
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger className="sm:max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.fullName} — {c.company}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => reload(targetUserId)}
              disabled={loading}
              title="Refresh requests"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="sr-only">Refresh requests</span>
            </Button>
          </div>
        </div>

        {/* Pending */}
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock className="h-4 w-4 text-amber-400" />
            Pending approval ({pending.length})
          </p>
          {pending.length === 0 ? (
            <p className="rounded-md border border-border bg-secondary/30 p-4 text-center text-sm italic text-muted-foreground">
              No certificate requests awaiting approval for this client.
            </p>
          ) : (
            <div className="space-y-3">
              {pending.map((req) => (
                <div key={req.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {CERTIFICATE_TYPE_LABELS[req.type]}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {req.reference} · {req.accountLabel} · requested {fmt(req.submittedAt)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="text-foreground">Purpose:</span> {req.purpose}
                      </p>
                      {req.addressee && (
                        <p className="text-xs text-muted-foreground">
                          <span className="text-foreground">Addressee:</span> {req.addressee}
                        </p>
                      )}
                      {req.type === "proof-of-funds" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          <span className="text-foreground">Snapshot:</span>{" "}
                          {req.balances.map((b) => money(b.amount, b.currency)).join(" · ")} (≈{" "}
                          {money(req.totalEur, "EUR")})
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setAuditReq(req)} title="Audit trail">
                        <History className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                        onClick={() => openDecision(req, "reject")}
                      >
                        <X className="mr-1.5 h-4 w-4" />
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                        onClick={() => openDecision(req, "approve")}
                      >
                        <Check className="mr-1.5 h-4 w-4" />
                        Approve & Issue
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* History */}
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <BadgeCheck className="h-4 w-4 text-primary" />
            Issued & decided ({decided.length})
          </p>
          {decided.length === 0 ? (
            <p className="rounded-md border border-border bg-secondary/30 p-4 text-center text-sm italic text-muted-foreground">
              No issued or declined certificates yet.
            </p>
          ) : (
            <div className="space-y-2">
              {decided.map((req) => (
                <div
                  key={req.id}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary" className={cn("shrink-0", statusStyles[req.status])}>
                      {req.status === "approved" ? (
                        <Check className="mr-1 h-3 w-3" />
                      ) : (
                        <X className="mr-1 h-3 w-3" />
                      )}
                      {req.status === "approved" ? `Issued${req.version > 1 ? ` · rev ${req.version}` : ""}` : "Declined"}
                    </Badge>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {CERTIFICATE_TYPE_LABELS[req.type]}{" "}
                        <span className="text-xs text-muted-foreground">({req.reference})</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fmt(req.decidedAt)}
                        {req.decisionNote ? ` · ${req.decisionNote}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setAuditReq(req)} title="Audit trail">
                      <History className="h-4 w-4" />
                    </Button>
                    {req.status === "approved" && (
                      <Button variant="outline" size="sm" onClick={() => reissue(req)} disabled={working}>
                        <RefreshCw className="mr-1.5 h-4 w-4" />
                        Re-issue
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      {/* Decision dialog */}
      <Dialog open={!!decision} onOpenChange={(o) => !o && setDecision(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decision?.mode === "approve" ? "Approve & issue certificate" : "Decline request"}
            </DialogTitle>
            <DialogDescription>
              {decision ? `${CERTIFICATE_TYPE_LABELS[decision.req.type]} · ${decision.req.reference}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {decision?.mode === "approve" ? "Issuance note (optional)" : "Reason for decline"}
            </Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={
                decision?.mode === "approve"
                  ? "Optional note recorded in the audit trail."
                  : "Explain why the request is being declined."
              }
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmDecision}
              disabled={working}
              className={
                decision?.mode === "approve"
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "bg-red-600 text-white hover:bg-red-700"
              }
            >
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {decision?.mode === "approve" ? "Approve & Issue" : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Audit trail */}
      <Dialog open={!!auditReq} onOpenChange={(o) => !o && setAuditReq(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Audit Trail</DialogTitle>
            <DialogDescription>{auditReq?.reference}</DialogDescription>
          </DialogHeader>
          {auditReq && (
            <ol className="space-y-3">
              {auditReq.events.map((ev, i) => (
                <li key={i} className="flex gap-3">
                  <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {ev.action} <span className="text-xs text-muted-foreground">· {ev.actor}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{fmt(ev.at)}</p>
                    {ev.note && <p className="mt-0.5 text-xs text-muted-foreground">“{ev.note}”</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
