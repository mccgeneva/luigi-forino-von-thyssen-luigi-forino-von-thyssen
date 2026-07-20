"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import {
  Check,
  X,
  Loader2,
  ClipboardList,
  Filter,
  RefreshCw,
  User,
  Wallet,
  PackageCheck,
  Ban,
  ArrowRight,
  Handshake,
  Share2,
  Search,
  Eye,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  adminListApprovals,
  adminDecideApproval,
  adminBulkDecide,
  adminMarkCommodityDelivered,
  adminRevokeCommodityDeal,
  adminShareCommodityDeal,
} from "@/app/actions/approvals"
import {
  getClientFinancialSnapshotAdmin,
  type ClientFinancialSnapshot,
} from "@/app/actions/ledger"
import { APPROVAL_KINDS, KIND_LABELS, type ApprovalKind } from "@/lib/approval-kinds"
import type { ApprovalRequest, ApprovalStatus } from "@/lib/approvals-db"
import { DealDocsVesselDialog } from "@/components/admin/deal-docs-vessel-dialog"

const STATUS_OPTIONS: { value: ApprovalStatus | "all"; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All statuses" },
]

function formatAmount(req: ApprovalRequest): string {
  if (req.amount == null) return "—"
  return `${req.currency ? `${req.currency} ` : ""}${req.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return iso
  }
}

interface AmendmentTerms {
  approxValue?: number
  quantity?: string
  tradeStructure?: string
  unitPrice?: number
}

// Renders the old → new diff and reason for a commodity_amendment request so the
// administrator sees exactly what the client wants to renegotiate before
// approving (which auto-adjusts the reserved funds) or rejecting.
function AmendmentDiff({ payload }: { payload?: ApprovalRequest["payload"] }) {
  const p = (payload ?? {}) as {
    previous?: AmendmentTerms
    proposed?: AmendmentTerms
    reason?: string
    commodity?: string
  }
  const previous = p.previous
  const proposed = p.proposed
  if (!previous || !proposed) return null

  const money = (v?: number) =>
    typeof v === "number" ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"

  const rows = [
    {
      label: "Unit price",
      from: money(previous.unitPrice),
      to: money(proposed.unitPrice),
      changed:
        typeof proposed.unitPrice === "number" &&
        Math.round((previous.unitPrice ?? 0) * 100) !== Math.round((proposed.unitPrice ?? 0) * 100),
    },
    {
      label: "Value",
      from: money(previous.approxValue),
      to: money(proposed.approxValue),
      changed: Math.round((previous.approxValue ?? 0) * 100) !== Math.round((proposed.approxValue ?? 0) * 100),
    },
    {
      label: "Quantity",
      from: previous.quantity || "—",
      to: proposed.quantity || "—",
      changed: (previous.quantity || "") !== (proposed.quantity || ""),
    },
    {
      label: "Terms",
      from: previous.tradeStructure || "—",
      to: proposed.tradeStructure || "—",
      changed: (previous.tradeStructure || "") !== (proposed.tradeStructure || ""),
    },
  ]

  return (
    <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        <Handshake className="h-3.5 w-3.5" />
        Renegotiated terms — approving will adjust the reserved funds
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="w-14 shrink-0 text-muted-foreground">{r.label}:</span>
            <span className={r.changed ? "text-muted-foreground line-through" : "text-foreground"}>{r.from}</span>
            {r.changed && (
              <>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="font-medium text-foreground">{r.to}</span>
              </>
            )}
          </div>
        ))}
      </div>
      {p.reason && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Reason:</span> {p.reason}
        </p>
      )}
    </div>
  )
}

const statusVariant: Record<ApprovalStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  awaiting_master: "outline",
  approved: "secondary",
  rejected: "destructive",
  cancelled: "outline",
}

export function PendingApprovals({ initialKind }: { initialKind?: ApprovalKind }) {
  // For commodity, default to showing every status so the administrator can act
  // on already-approved deals (revoke / mark delivered), not just pending ones.
  const [statusFilter, setStatusFilter] = useState<ApprovalStatus | "all">(
    initialKind === "commodity" ? "all" : "pending",
  )
  const [kindFilter, setKindFilter] = useState<ApprovalKind | "all">(initialKind ?? "all")

  // When the admin deep-links from a command-center tile, focus that type.
  useEffect(() => {
    if (initialKind) setKindFilter(initialKind)
  }, [initialKind])
  const [clientFilter, setClientFilter] = useState<string>("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [acting, setActing] = useState(false)

  // Reject-with-reason dialog state. `bulk` true → applies to selection.
  const [rejectTarget, setRejectTarget] = useState<{ id?: string; bulk: boolean } | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  // Revoke-approved-deal dialog state (commodity). Releases the reserved funds.
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; label: string } | null>(null)
  const [revokeReason, setRevokeReason] = useState("")

  // Share-deal dialog state (commodity). Sends a read-only visibility copy to
  // one or more other clients — no funds move.
  const [shareTarget, setShareTarget] = useState<{ id: string; label: string; ownerId: string } | null>(null)
  const [shareSelected, setShareSelected] = useState<Set<string>>(new Set())
  const [shareSearch, setShareSearch] = useState("")

  // Client financial-snapshot dialog (due-diligence before approving).
  const [clientView, setClientView] = useState<{
    open: boolean
    loading: boolean
    label: string
    snapshot: ClientFinancialSnapshot | null
    error: string | null
  }>({ open: false, loading: false, label: "", snapshot: null, error: null })

  const openClientSnapshot = async (userId: string, label: string) => {
    setClientView({ open: true, loading: true, label, snapshot: null, error: null })
    const res = await getClientFinancialSnapshotAdmin(ADMIN_PASSCODE, userId)
    if (res.ok) {
      setClientView({ open: true, loading: false, label, snapshot: res.snapshot, error: null })
    } else {
      setClientView({ open: true, loading: false, label, snapshot: null, error: res.error })
    }
  }

  const [clients, setClients] = useState<SelectableClient[]>([])
  useEffect(() => {
    listSelectableClients(ADMIN_PASSCODE)
      .then(setClients)
      .catch(() => setClients([]))
  }, [])

  const clientLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of clients) {
      map.set(c.id, `${c.fullName}${c.company ? ` · ${c.company}` : ""}`)
    }
    return (userId: string) => map.get(userId) ?? userId
  }, [clients])

  const {
    data: requests = [],
    isLoading,
    mutate,
  } = useSWR(
    ["admin-approvals", statusFilter, kindFilter, clientFilter],
    async () => {
      const res = await adminListApprovals(ADMIN_PASSCODE, {
        status: statusFilter === "all" ? undefined : statusFilter,
        kind: kindFilter === "all" ? undefined : kindFilter,
        userId: clientFilter === "all" ? undefined : clientFilter,
      })
      return res.ok ? res.requests : []
    },
    { refreshInterval: 20000 },
  )

  // Client-side date filtering keeps the query path simple while still meeting
  // the "filter by date" requirement.
  const filtered = useMemo(() => {
    return requests.filter((r) => {
      const t = new Date(r.createdAt).getTime()
      if (fromDate) {
        const from = new Date(fromDate).getTime()
        if (t < from) return false
      }
      if (toDate) {
        // include the whole "to" day
        const to = new Date(toDate).getTime() + 24 * 60 * 60 * 1000
        if (t >= to) return false
      }
      return true
    })
  }, [requests, fromDate, toDate])

  const pendingInView = filtered.filter((r) => r.status === "pending")
  const allPendingSelected = pendingInView.length > 0 && pendingInView.every((r) => selected.has(r.id))

  const toggleAll = () => {
    setSelected((prev) => {
      if (allPendingSelected) return new Set()
      return new Set(pendingInView.map((r) => r.id))
    })
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const approveOne = async (id: string) => {
    setActing(true)
    const res = await adminDecideApproval(ADMIN_PASSCODE, id, "approved")
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Request approved.")
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    mutate()
  }

  const openReject = (id: string) => {
    setRejectReason("")
    setRejectTarget({ id, bulk: false })
  }

  const markDelivered = async (id: string) => {
    setActing(true)
    const res = await adminMarkCommodityDelivered(ADMIN_PASSCODE, id)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Deal flagged delivered. It is now locked from client revocation.")
    mutate()
  }

  const confirmRevoke = async () => {
    if (!revokeTarget) return
    setActing(true)
    const res = await adminRevokeCommodityDeal(ADMIN_PASSCODE, revokeTarget.id, revokeReason)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Deal revoked. The reserved funds have been released back to the client's balance.")
    setRevokeTarget(null)
    setRevokeReason("")
    mutate()
  }

  const openShare = (id: string, label: string, ownerId: string) => {
    setShareTarget({ id, label, ownerId })
    setShareSelected(new Set())
    setShareSearch("")
  }

  const toggleShareRecipient = (id: string) => {
    setShareSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmShare = async () => {
    if (!shareTarget || shareSelected.size === 0) return
    setActing(true)
    const res = await adminShareCommodityDeal(ADMIN_PASSCODE, shareTarget.id, Array.from(shareSelected))
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const names = (res.sharedWith ?? []).map((r) => r.name).join(", ")
    toast.success(
      `Deal shared (read-only) with ${res.sharedWith?.length ?? 0} client${(res.sharedWith?.length ?? 0) === 1 ? "" : "s"}${names ? `: ${names}` : ""}.`,
    )
    setShareTarget(null)
    setShareSelected(new Set())
    setShareSearch("")
    mutate()
  }

  const bulkApprove = async () => {
    if (selected.size === 0) return
    setActing(true)
    const res = await adminBulkDecide(ADMIN_PASSCODE, Array.from(selected), "approved")
    setActing(false)
    if (res.decided > 0) toast.success(`Approved ${res.decided} request${res.decided === 1 ? "" : "s"}.`)
    if (res.failed > 0) toast.error(`${res.failed} could not be approved.`)
    setSelected(new Set())
    mutate()
  }

  const openBulkReject = () => {
    if (selected.size === 0) return
    setRejectReason("")
    setRejectTarget({ bulk: true })
  }

  const confirmReject = async () => {
    if (!rejectReason.trim()) {
      toast.error("A reason is required to reject.")
      return
    }
    setActing(true)
    if (rejectTarget?.bulk) {
      const res = await adminBulkDecide(ADMIN_PASSCODE, Array.from(selected), "rejected", rejectReason)
      setActing(false)
      if (res.decided > 0) toast.success(`Rejected ${res.decided} request${res.decided === 1 ? "" : "s"}.`)
      if (res.failed > 0) toast.error(`${res.failed} could not be rejected.`)
      setSelected(new Set())
    } else if (rejectTarget?.id) {
      const res = await adminDecideApproval(ADMIN_PASSCODE, rejectTarget.id, "rejected", rejectReason)
      setActing(false)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success("Request rejected.")
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(rejectTarget.id!)
        return next
      })
    } else {
      setActing(false)
    }
    setRejectTarget(null)
    setRejectReason("")
    mutate()
  }

  const resetFilters = () => {
    setStatusFilter("pending")
    setKindFilter("all")
    setClientFilter("all")
    setFromDate("")
    setToDate("")
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/15 p-2">
            <ClipboardList className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>Pending Approvals</CardTitle>
            <CardDescription className="text-pretty">
              Every client request awaiting a decision, across all accounts. Approve or reject here — the
              client is notified and any balance effect is applied automatically.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ApprovalStatus | "all")}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Type</Label>
            <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as ApprovalKind | "all")}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {APPROVAL_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Client</Label>
            <Select value={clientFilter} onValueChange={setClientFilter}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.fullName}
                    {c.company ? ` · ${c.company}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">From</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">To</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10" />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter className="h-4 w-4" />
            {filtered.length} {filtered.length === 1 ? "request" : "requests"}
            <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={resetFilters}>
              Reset
            </Button>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => mutate()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Bulk action bar */}
        {pendingInView.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 p-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allPendingSelected} onCheckedChange={toggleAll} aria-label="Select all pending" />
              Select all pending
            </label>
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-emerald-600"
                disabled={selected.size === 0 || acting}
                onClick={bulkApprove}
              >
                <Check className="h-3.5 w-3.5" /> Approve selected
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-destructive"
                disabled={selected.size === 0 || acting}
                onClick={openBulkReject}
              >
                <X className="h-3.5 w-3.5" /> Reject selected
              </Button>
            </div>
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No requests match the current filters. You are all caught up.
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((req) => {
              const isPending = req.status === "pending"
              const isDelivered = req.payload?.delivered === true
              // A shared read-only copy is a recipient-owned mirror of another
              // client's deal. It must never expose admin management actions —
              // documents, vessel, sharing and delivery are managed on the
              // original deal only.
              const isSharedCopy = (req.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true
              const canMarkDelivered =
                req.kind === "commodity" && req.status === "approved" && !isDelivered && !isSharedCopy
              return (
                <li
                  key={req.id}
                  className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 gap-3">
                    {isPending && (
                      <Checkbox
                        checked={selected.has(req.id)}
                        onCheckedChange={() => toggleOne(req.id)}
                        aria-label={`Select ${req.title}`}
                        className="mt-1"
                      />
                    )}
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {KIND_LABELS[req.kind]}
                        </Badge>
                        <Badge variant={statusVariant[req.status]} className="text-[10px] capitalize">
                          {req.status}
                        </Badge>
                        {isDelivered && (
                          <Badge
                            variant="outline"
                            className="border-green-500/30 bg-green-500/10 text-green-600 text-[10px]"
                          >
                            <PackageCheck className="mr-1 h-3 w-3" />
                            Delivered
                          </Badge>
                        )}
                        <span className="text-sm font-semibold text-foreground">{formatAmount(req)}</span>
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">{req.title}</p>
                      {req.summary && <p className="text-xs text-muted-foreground text-pretty">{req.summary}</p>}
                      {req.kind === "commodity_amendment" && <AmendmentDiff payload={req.payload} />}
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
                        <span>
                          {clientLabel(req.userId)} · submitted {formatDate(req.createdAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-1.5 text-[11px] text-primary hover:text-primary"
                          onClick={() => openClientSnapshot(req.userId, clientLabel(req.userId))}
                        >
                          <User className="h-3 w-3" />
                          View client &amp; funds
                        </Button>
                      </div>
                      {req.decisionNote && (
                        <p className="text-[11px] text-muted-foreground">
                          Reason: <span className="text-foreground">{req.decisionNote}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  {isPending && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-emerald-600"
                        disabled={acting}
                        onClick={() => approveOne(req.id)}
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-destructive"
                        disabled={acting}
                        onClick={() => openReject(req.id)}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </Button>
                    </div>
                  )}
                  {req.kind === "commodity" && req.status === "approved" && !isSharedCopy && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {canMarkDelivered && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 text-emerald-600"
                            disabled={acting}
                            onClick={() => markDelivered(req.id)}
                            title="Confirm the commodity has been delivered. Locks the deal so the client can no longer revoke it."
                          >
                            <PackageCheck className="h-3.5 w-3.5" /> Mark delivered
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 text-destructive"
                            disabled={acting}
                            onClick={() => setRevokeTarget({ id: req.id, label: `${req.title}` })}
                            title="Revoke this approved deal and release the reserved funds back to the client."
                          >
                            <Ban className="h-3.5 w-3.5" /> Revoke
                          </Button>
                        </>
                      )}
                      <DealDocsVesselDialog req={req} onChanged={() => mutate()} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-primary"
                        disabled={acting}
                        onClick={() => openShare(req.id, req.title, req.userId)}
                        title="Share a read-only copy of this deal with other clients for visibility. No funds move."
                      >
                        <Share2 className="h-3.5 w-3.5" /> Share
                      </Button>
                    </div>
                  )}
                  {req.kind === "commodity" && req.status === "approved" && isSharedCopy && (
                    <div className="flex shrink-0 items-center justify-end">
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        <Eye className="h-3.5 w-3.5" /> Shared read-only copy
                      </Badge>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* Reject reason dialog */}
      <Dialog open={rejectTarget !== null} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {rejectTarget?.bulk ? `Reject ${selected.size} request${selected.size === 1 ? "" : "s"}` : "Reject request"}
            </DialogTitle>
            <DialogDescription>
              A reason is required and will be recorded in the audit trail and shown to the client.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Explain why this request is being declined…"
            className="min-h-24 text-base md:text-sm"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReject} disabled={acting || !rejectReason.trim()}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}
              Confirm rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke approved commodity deal dialog */}
      <Dialog open={revokeTarget !== null} onOpenChange={(o) => !o && !acting && setRevokeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive" />
              Revoke approved deal
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {revokeTarget ? (
                <>
                  This cancels the approved deal{" "}
                  <span className="font-medium text-foreground">{revokeTarget.label}</span> and releases the
                  reserved funds back to the client&apos;s available balance. The client will be notified. This
                  cannot be undone.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="Optional note for the client and audit trail…"
            className="min-h-24 text-base md:text-sm"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)} disabled={acting}>
              Keep deal
            </Button>
            <Button variant="destructive" onClick={confirmRevoke} disabled={acting}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Ban className="mr-1 h-4 w-4" />}
              Revoke &amp; release funds
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share commodity deal (read-only) with other clients */}
      <Dialog open={shareTarget !== null} onOpenChange={(o) => !o && !acting && setShareTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" />
              Share deal with clients
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {shareTarget ? (
                <>
                  Send a <span className="font-medium text-foreground">read-only</span> copy of{" "}
                  <span className="font-medium text-foreground">{shareTarget.label}</span> to the selected
                  clients. It appears in their Commodity Transactions for visibility only — no funds are
                  reserved or moved, and they cannot edit, revoke or act on it.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={shareSearch}
                onChange={(e) => setShareSearch(e.target.value)}
                placeholder="Search clients by name, company or email…"
                className="pl-8 text-base md:text-sm"
              />
            </div>

            {(() => {
              const q = shareSearch.trim().toLowerCase()
              const recipients = clients.filter((c) => {
                if (shareTarget && c.id === shareTarget.ownerId) return false
                if (!q) return true
                return (
                  c.fullName.toLowerCase().includes(q) ||
                  c.company.toLowerCase().includes(q) ||
                  c.email.toLowerCase().includes(q)
                )
              })
              if (recipients.length === 0) {
                return (
                  <p className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                    No matching clients.
                  </p>
                )
              }
              return (
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-1">
                  {recipients.map((c) => {
                    const checked = shareSelected.has(c.id)
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => toggleShareRecipient(c.id)}
                          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted"
                        >
                          <Checkbox checked={checked} className="pointer-events-none" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {c.fullName}
                              {c.company ? <span className="text-muted-foreground"> · {c.company}</span> : null}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{c.email}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )
            })()}

            <p className="text-xs text-muted-foreground">
              {shareSelected.size} client{shareSelected.size === 1 ? "" : "s"} selected
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShareTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button onClick={confirmShare} disabled={acting || shareSelected.size === 0}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Share2 className="mr-1 h-4 w-4" />}
              Share read-only
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Client financial-capability snapshot */}
      <Dialog open={clientView.open} onOpenChange={(o) => !o && setClientView((s) => ({ ...s, open: false }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              Client due diligence
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Account holder and available funds, so you can confirm the client can fund this deal
              before approving.
            </DialogDescription>
          </DialogHeader>

          {clientView.loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : clientView.error ? (
            <p className="py-6 text-center text-sm text-destructive">{clientView.error}</p>
          ) : clientView.snapshot ? (
            <div className="space-y-4">
              {/* Identity */}
              <div className="rounded-lg border border-border p-3">
                <p className="text-sm font-semibold text-foreground">{clientView.snapshot.fullName}</p>
                {clientView.snapshot.company && clientView.snapshot.company !== "—" && (
                  <p className="text-xs text-muted-foreground">{clientView.snapshot.company}</p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {clientView.snapshot.accountBadge && (
                    <Badge variant="outline" className="text-[10px]">
                      {clientView.snapshot.accountBadge}
                    </Badge>
                  )}
                  {clientView.snapshot.relationship && (
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {clientView.snapshot.relationship}
                    </Badge>
                  )}
                  {clientView.snapshot.country && (
                    <Badge variant="outline" className="text-[10px]">
                      {clientView.snapshot.country}
                    </Badge>
                  )}
                </div>
                {clientView.snapshot.email && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{clientView.snapshot.email}</p>
                )}
              </div>

              {/* Available funds */}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Wallet className="h-3.5 w-3.5" />
                  Available funds
                </p>
                {clientView.snapshot.balances.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    No ledger balances on record for this account.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {clientView.snapshot.balances.map((b) => (
                      <li key={b.currency} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="text-xs font-medium text-muted-foreground">{b.currency}</span>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-nums text-foreground">
                            {b.currency}{" "}
                            {b.available.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </p>
                          {b.onHold > 0 && (
                            <p className="text-[10px] text-amber-600">
                              {b.currency} {b.onHold.toLocaleString("en-US", { maximumFractionDigits: 2 })} on
                              hold
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="text-[11px] text-muted-foreground">
                {clientView.snapshot.totalEntries} ledger{" "}
                {clientView.snapshot.totalEntries === 1 ? "entry" : "entries"}
                {clientView.snapshot.lastActivity
                  ? ` · last activity ${formatDate(clientView.snapshot.lastActivity)}`
                  : ""}
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setClientView((s) => ({ ...s, open: false }))}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
