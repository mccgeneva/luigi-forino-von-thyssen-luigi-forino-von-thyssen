"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
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
  Trash2,
  PauseCircle,
  PlayCircle,
  Lock,
  LockOpen,
  MessagesSquare,
  FileText,
  Download,
  ArrowLeft,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { blobFileUrl } from "@/lib/kyc-types"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  adminListApprovals,
  adminDecideApproval,
  adminBulkDecide,
  adminMarkCommodityDelivered,
  adminMarkPaymentDelivered,
  adminRevokeCommodityDeal,
  adminShareCommodityDeal,
  adminSetCommodityDealHold,
  adminDeleteCommodityDeal,
  adminAdjustLeveragePpi,
  adminAdjustMonetizationReserve,
  adminConfirmYieldTermination,
  type DealHoldState,
} from "@/app/actions/approvals"
import { leverageApplicationCharges } from "@/lib/leverage-audit-fee"
import { computeMonetizationEquity } from "@/lib/monetization-equity"
import { yieldCancellationPenalty, YIELD_EARLY_CANCELLATION_PENALTY_RATE } from "@/lib/ppp-yield"
import {
  getClientFinancialSnapshotAdmin,
  type ClientFinancialSnapshot,
} from "@/app/actions/ledger"
import { APPROVAL_KINDS, KIND_LABELS, type ApprovalKind } from "@/lib/approval-kinds"
import {
  PAYMENT_STAGE_SHORT,
  PAYMENT_STAGE_BADGE_CLASS,
  type PaymentStage,
} from "@/lib/payment-status"
import type { ApprovalRequest, ApprovalStatus } from "@/lib/approvals-db"
import { DealDocsVesselDialog } from "@/components/admin/deal-docs-vessel-dialog"
import { openProjectFinanceDiscussionAdmin } from "@/app/actions/funding"
import {
  adminListConversations,
  adminGetThread,
  adminReply,
  adminDeleteMessage,
} from "@/app/actions/bankeka"
import { Messenger } from "@/components/bankeka/messenger"
import type { ProjectFundingRequest, UploadedFundingDoc } from "@/lib/project-funding-store"

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

/** Pull the AES project-funding record out of an approval payload (null for
 *  any other approval kind). */
function fundingRecord(req: ApprovalRequest): ProjectFundingRequest | null {
  if (req.kind !== "project_funding") return null
  const rec = (req.payload as { record?: ProjectFundingRequest } | undefined)?.record
  return rec && typeof rec === "object" && rec.id ? rec : null
}

/** PPI picture for a leverage application: the original premium charged at
 *  application, any admin-negotiated premium, and the resulting refund. Returns
 *  null for non-leverage requests or when there is no PPI to negotiate. */
function leveragePpiInfo(req: ApprovalRequest): {
  currency: string
  original: number
  negotiated: number | null
  refund: number
} | null {
  if (req.kind !== "leverage") return null
  const rec = ((req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}) as Record<
    string,
    unknown
  >
  const equity = Number(rec.equity)
  const ratio = Number(rec.leverageRatio)
  const original = leverageApplicationCharges(equity, ratio).ppi
  if (!(original > 0)) return null
  const currency = String(rec.currency || req.currency || "EUR")
  const neg = Number(rec.negotiatedPpi)
  const negotiated = Number.isFinite(neg) && neg >= 0 ? neg : null
  const refund = negotiated == null ? 0 : Math.round((original - negotiated + Number.EPSILON) * 100) / 100
  return { currency, original, negotiated, refund }
}

function formatMoney2(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Reserve picture for a monetization request: the original blocked reserve
 *  (equity deposit + PPI), any admin-negotiated reserve, and the released
 *  excess. Returns null for non-monetization requests or when there is no
 *  reserve to negotiate. */
function monetizationReserveInfo(req: ApprovalRequest): {
  currency: string
  original: number
  negotiated: number | null
  released: number
} | null {
  if (req.kind !== "monetization") return null
  const rec = ((req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}) as Record<
    string,
    unknown
  >
  const advance = Number(rec.grossProceeds)
  const ltv = Number(rec.advanceRatePercent)
  const original = computeMonetizationEquity(advance, ltv).totalUpfront
  if (!(original > 0)) return null
  const currency = String(rec.currency || req.currency || "EUR")
  const neg = Number(rec.negotiatedReserve)
  const negotiated = Number.isFinite(neg) && neg >= 0 ? neg : null
  const released = negotiated == null ? 0 : Math.round((original - negotiated + Number.EPSILON) * 100) / 100
  return { currency, original, negotiated, released }
}

/** Early-termination picture for an APPROVED Yield / PPP program: whether the
 *  client has requested to resign, the reason, the exit cost they proposed, and
 *  the standard 2%-of-principal figure the admin can offer as a baseline. Returns
 *  null unless there is an active termination request the admin must action. */
function pppTerminationInfo(req: ApprovalRequest): {
  currency: string
  principal: number
  proposed: number
  suggested: number
  reason: string | null
  requestedAt: string
} | null {
  if (req.kind !== "ppp") return null
  const rec = ((req.payload as { record?: Record<string, unknown> } | undefined)?.record ?? {}) as Record<
    string,
    unknown
  >
  const requestedAt = typeof rec.terminationRequestedAt === "string" ? rec.terminationRequestedAt : null
  if (!requestedAt || rec.cancelledAt) return null
  const principal = Number(rec.amount ?? req.amount) || 0
  const currency = String(rec.currency || req.currency || "USD")
  const suggested = yieldCancellationPenalty(principal)
  const prop = Number(rec.proposedExitCost)
  const proposed = Number.isFinite(prop) && prop >= 0 ? Math.round((prop + Number.EPSILON) * 100) / 100 : suggested
  const reason = typeof rec.terminationReason === "string" && rec.terminationReason.trim() ? rec.terminationReason.trim() : null
  return { currency, principal, proposed, suggested, reason, requestedAt }
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The documentation package the applicant submitted with an AES funding
 *  application. Each stored document opens in an IN-APP viewer overlay (with an
 *  explicit Back / Open-in-browser / Download / Close toolbar) rather than a
 *  bare `target="_blank"` link — inside the installed PWA / in-app webview a
 *  raw file link has no browser chrome, so the administrator would otherwise be
 *  trapped on the file with no way to download or return. Legacy documents
 *  captured before file storage existed show as "not stored" (metadata only). */
function FundingDocuments({ docs }: { docs?: UploadedFundingDoc[] }) {
  const list = docs ?? []
  const [active, setActive] = useState<UploadedFundingDoc | null>(null)
  return (
    <div className="mt-1.5 rounded-md border border-border bg-muted/30 p-2.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <FileText className="h-3.5 w-3.5 text-primary" />
        Client documents ({list.length})
      </div>
      {list.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No documents were uploaded with this application.
        </p>
      ) : (
        <>
          <p className="mb-1.5 text-[10px] text-muted-foreground">Tap a document to view or download.</p>
          <ul className="space-y-1.5">
            {list.map((d) => {
              const meta = [d.fileName, formatFileSize(d.size), formatDate(d.uploadedAt)]
                .filter(Boolean)
                .join(" · ")
              return (
                <li key={d.docId}>
                  {d.pathname ? (
                    <button
                      type="button"
                      onClick={() => setActive(d)}
                      className="group flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left transition-colors hover:border-primary/60 hover:bg-muted active:bg-muted"
                      title={`Open ${d.fileName} to view, then download or go back`}
                    >
                      <FileText className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-foreground">{d.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{meta}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                        <Eye className="h-3.5 w-3.5" /> View
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-background/50 px-2.5 py-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-foreground">{d.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {meta} · not stored (metadata only)
                        </span>
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {active && <FundingDocViewer doc={active} onClose={() => setActive(null)} />}
    </div>
  )
}

/** Full-screen in-app viewer for a single uploaded funding document. Mirrors the
 *  KYC document viewer: a toolbar that is always visible with Back, Open-in-
 *  browser, Download and Close, plus an inline iframe preview (works for PDFs
 *  and images alike). Guarantees the administrator can always get out and can
 *  save the file to their computer. */
function FundingDocViewer({ doc, onClose }: { doc: UploadedFundingDoc; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false)
  const url = doc.pathname ? blobFileUrl(doc.pathname, ADMIN_PASSCODE) : ""

  // A plain `<a download>` does NOT trigger a save inside the installed PWA /
  // in-app webview — it just navigates the single webview and traps the admin.
  // Instead fetch the file and hand it to the OS: the native share sheet on
  // mobile (Save to Files) or an object-URL download on desktop, mirroring the
  // app's proven `deliverPdf` pattern. Falls back to opening the file if all
  // else fails.
  async function handleDownload() {
    if (downloading || !url) return
    setDownloading(true)
    try {
      const res = await fetch(url, { cache: "no-store", credentials: "include" })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const blob = await res.blob()
      const type = blob.type || doc.contentType || "application/octet-stream"
      const file = new File([blob], doc.fileName || "document", { type })
      const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
      if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: doc.title })
          return
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return
          // otherwise fall through to the object-URL download
        }
      }
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = objectUrl
      a.download = doc.fileName || "document"
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000)
    } catch {
      window.open(url, "_blank", "noopener,noreferrer")
    } finally {
      setDownloading(false)
    }
  }

  if (typeof document === "undefined" || !doc.pathname) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true">
      <div
        className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <Button variant="ghost" size="sm" onClick={onClose} className="min-h-11 gap-1.5">
          <ArrowLeft className="h-5 w-5" />
          Back
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium text-foreground">{doc.title}</p>
          <p className="truncate text-xs text-muted-foreground">{doc.fileName}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            title="Download"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
            <span className="sr-only">Download</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} className="min-h-11 min-w-11" title="Close">
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-secondary/30">
        <iframe src={url} title={`${doc.title} — ${doc.fileName}`} className="h-full w-full" />
      </div>
    </div>,
    document.body,
  )
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
  // For commodity and payments, default to showing every status so the
  // administrator can act on already-approved items (revoke / mark delivered),
  // not just pending ones. Otherwise an approved payment would drop out of view
  // and its stage-3 "Mark funds delivered" action would be unreachable.
  const [statusFilter, setStatusFilter] = useState<ApprovalStatus | "all">(
    initialKind === "commodity" || initialKind === "payment" || initialKind === "ppp" ? "all" : "pending",
  )
  const [kindFilter, setKindFilter] = useState<ApprovalKind | "all">(initialKind ?? "all")

  // When the admin deep-links from a command-center tile, focus that type.
  useEffect(() => {
    if (initialKind) setKindFilter(initialKind)
  }, [initialKind])
  const [clientFilter, setClientFilter] = useState<string>("all")
  // Free-text customer search — matches a request's client by name, company or
  // email so the admin can filter the related payments/transactions by customer
  // without scrolling the (potentially long) client dropdown.
  const [clientSearch, setClientSearch] = useState("")
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

  // Delete-deal dialog state (commodity). Permanently removes the deal and
  // releases any reserved funds back to the owner's available balance.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

  // AES funding negotiation: opens the applicant's Bankeka thread inline so the
  // administrator can review documents and negotiate terms BEFORE activating the
  // facility — mirroring the internal-loan discussion gate.
  const [discussFunding, setDiscussFunding] = useState<{
    req: ApprovalRequest
    record: ProjectFundingRequest
  } | null>(null)

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

  // Lowercased searchable text per client (name + company + email + id) so the
  // free-text customer search can match on any of them.
  const clientSearchText = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of clients) {
      map.set(c.id, `${c.fullName} ${c.company ?? ""} ${c.email ?? ""} ${c.id}`.toLowerCase())
    }
    return map
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

  // Client-side date + customer-search filtering keeps the query path simple
  // while still meeting the "filter by date" and "search by customer" requirements.
  const filtered = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
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
      if (q) {
        // Match against the client's indexed text, falling back to the resolved
        // label and raw userId so a search still works before the client list loads.
        const hay = clientSearchText.get(r.userId) ?? `${clientLabel(r.userId)} ${r.userId}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [requests, fromDate, toDate, clientSearch, clientSearchText, clientLabel])

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

  // PPI negotiation dialog (leverage). The admin agrees a lower PPI premium; the
  // exceeded amount is refunded to the client's Master Account immediately.
  const [ppiTarget, setPpiTarget] = useState<{
    id: string
    label: string
    currency: string
    original: number
    negotiated: number | null
  } | null>(null)
  const [ppiValue, setPpiValue] = useState("")
  const [ppiNote, setPpiNote] = useState("")

  const openPpiNegotiate = (req: ApprovalRequest, info: NonNullable<ReturnType<typeof leveragePpiInfo>>) => {
    setPpiValue((info.negotiated ?? info.original).toFixed(2))
    setPpiNote("")
    setPpiTarget({
      id: req.id,
      label: req.title,
      currency: info.currency,
      original: info.original,
      negotiated: info.negotiated,
    })
  }

  const confirmPpiNegotiate = async () => {
    if (!ppiTarget) return
    const newPpi = Number(ppiValue)
    if (!Number.isFinite(newPpi) || newPpi < 0) {
      toast.error("Enter a valid negotiated PPI amount.")
      return
    }
    if (newPpi > ppiTarget.original + 0.01) {
      toast.error(`The negotiated PPI cannot exceed the ${formatMoney2(ppiTarget.original, ppiTarget.currency)} originally charged.`)
      return
    }
    setActing(true)
    const res = await adminAdjustLeveragePpi(ADMIN_PASSCODE, ppiTarget.id, newPpi, ppiNote.trim() || undefined)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const refund = Math.round((ppiTarget.original - newPpi + Number.EPSILON) * 100) / 100
    toast.success(
      `PPI set to ${formatMoney2(newPpi, ppiTarget.currency)}. ${formatMoney2(refund, ppiTarget.currency)} refunded to the client's Master Account.`,
    )
    setPpiTarget(null)
    mutate()
  }

  // Reserve negotiation dialog (monetization). The admin agrees a lower blocked
  // reserve; the exceeded amount is released back to the client's available
  // balance immediately, and only the agreed reserve stays blocked.
  const [resTarget, setResTarget] = useState<{
    id: string
    label: string
    currency: string
    original: number
    negotiated: number | null
  } | null>(null)
  const [resValue, setResValue] = useState("")
  const [resNote, setResNote] = useState("")

  const openResNegotiate = (req: ApprovalRequest, info: NonNullable<ReturnType<typeof monetizationReserveInfo>>) => {
    setResValue((info.negotiated ?? info.original).toFixed(2))
    setResNote("")
    setResTarget({
      id: req.id,
      label: req.title,
      currency: info.currency,
      original: info.original,
      negotiated: info.negotiated,
    })
  }

  const confirmResNegotiate = async () => {
    if (!resTarget) return
    const newRes = Number(resValue)
    if (!Number.isFinite(newRes) || newRes < 0) {
      toast.error("Enter a valid negotiated reserve amount.")
      return
    }
    if (newRes > resTarget.original + 0.01) {
      toast.error(`The negotiated reserve cannot exceed the ${formatMoney2(resTarget.original, resTarget.currency)} originally blocked.`)
      return
    }
    setActing(true)
    const res = await adminAdjustMonetizationReserve(ADMIN_PASSCODE, resTarget.id, newRes, resNote.trim() || undefined)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const released = Math.round((resTarget.original - newRes + Number.EPSILON) * 100) / 100
    toast.success(
      `Reserve set to ${formatMoney2(newRes, resTarget.currency)}. ${formatMoney2(released, resTarget.currency)} released to the client's available balance.`,
    )
    setResTarget(null)
    mutate()
  }

  // Yield / PPP early-termination dialog. The client requested to resign and
  // proposed an exit cost; the admin agrees the FINAL exit cost (defaults to the
  // client's proposal) then confirms, which settles and terminates the program.
  const [termTarget, setTermTarget] = useState<{
    id: string
    label: string
    currency: string
    principal: number
    proposed: number
    suggested: number
    reason: string | null
  } | null>(null)
  const [termValue, setTermValue] = useState("")
  const [termNote, setTermNote] = useState("")

  const openTermConfirm = (req: ApprovalRequest, info: NonNullable<ReturnType<typeof pppTerminationInfo>>) => {
    setTermValue(info.proposed.toFixed(2))
    setTermNote("")
    setTermTarget({
      id: req.id,
      label: req.title,
      currency: info.currency,
      principal: info.principal,
      proposed: info.proposed,
      suggested: info.suggested,
      reason: info.reason,
    })
  }

  const confirmTermination = async () => {
    if (!termTarget) return
    const finalCost = Number(termValue)
    if (!Number.isFinite(finalCost) || finalCost < 0) {
      toast.error("Enter a valid agreed exit cost.")
      return
    }
    setActing(true)
    const res = await adminConfirmYieldTermination(ADMIN_PASSCODE, termTarget.id, {
      finalCost,
      note: termNote.trim() || undefined,
    })
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(
      `Program terminated. Agreed exit cost ${formatMoney2(res.exitCost ?? finalCost, res.currency ?? termTarget.currency)} charged; the client keeps earned ROI.`,
    )
    setTermTarget(null)
    mutate()
  }

  // Open (or continue) the negotiation with the AES applicant. For a pending
  // application not yet discussed, this stamps discussionOpenedAt server-side and
  // notifies the applicant, then opens the inline Bankeka thread.
  const openFundingDiscuss = async (req: ApprovalRequest, record: ProjectFundingRequest) => {
    setDiscussFunding({ req, record })
    if (req.status === "pending" && !record.discussionOpenedAt) {
      const res = await openProjectFinanceDiscussionAdmin({ passcode: ADMIN_PASSCODE, approvalId: req.id })
      if (res.ok) {
        setDiscussFunding((prev) =>
          prev && prev.req.id === req.id
            ? { ...prev, record: { ...prev.record, discussionOpenedAt: new Date().toISOString() } }
            : prev,
        )
        mutate()
      } else {
        toast.error("Could not open the discussion", { description: res.error })
      }
    }
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

  // Stage 3 for outgoing payments: confirm the wire reached the beneficiary. No
  // funds move (the debit posted at approval) — this only advances the payment
  // from "Approved & Initiated" to "Completed — Funds Delivered".
  const markPaymentDelivered = async (id: string) => {
    setActing(true)
    const res = await adminMarkPaymentDelivered(ADMIN_PASSCODE, id)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Payment confirmed delivered. The client sees it as completed.")
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

  // Suspend / freeze / resume any client's commodity deal. `hold=null` resumes.
  const setHold = async (id: string, hold: DealHoldState | null) => {
    setActing(true)
    const res = await adminSetCommodityDealHold(ADMIN_PASSCODE, id, hold)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(
      hold === "frozen"
        ? "Deal frozen. It is locked from all changes until unfrozen."
        : hold === "suspended"
          ? "Deal suspended. Its workflow is paused until resumed."
          : "Hold lifted. The deal is active again.",
    )
    mutate()
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setActing(true)
    const res = await adminDeleteCommodityDeal(ADMIN_PASSCODE, deleteTarget.id)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Deal deleted. Any reserved funds have been released back to the client's balance.")
    setDeleteTarget(null)
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
    setClientSearch("")
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
        {/* Customer search — filter the related payments & transactions by customer */}
        <div className="space-y-1.5">
          <Label className="text-xs">Search customer</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              placeholder="Filter by customer name, company or email…"
              className="h-10 pl-9"
              aria-label="Search related payments and transactions by customer"
            />
            {clientSearch && (
              <button
                type="button"
                onClick={() => setClientSearch("")}
                aria-label="Clear customer search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

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
              // AES project funding: negotiate + review documents before
              // activation. Approve is gated until a discussion is opened.
              const funding = fundingRecord(req)
              const fundingNeedsDiscussion = !!funding && !funding.discussionOpenedAt
              // Leverage PPI negotiation is available while the line is pending
              // or already approved (a special arrangement can be granted at any
              // point before/at approval).
              const ppi = leveragePpiInfo(req)
              const canNegotiatePpi = !!ppi && (req.status === "pending" || req.status === "approved")
              // Monetization reserve negotiation — release the excess of the
              // blocked equity+PPI reserve; available while pending or approved.
              const mon = monetizationReserveInfo(req)
              const canNegotiateReserve = !!mon && (req.status === "pending" || req.status === "approved")
              // Yield / PPP early-termination request — present only on an approved
              // program whose client asked to resign. The admin negotiates the exit
              // cost and confirms, which terminates the program.
              const term = pppTerminationInfo(req)
              // A shared read-only copy is a recipient-owned mirror of another
              // client's deal. It must never expose admin management actions —
              // documents, vessel, sharing and delivery are managed on the
              // original deal only.
              const isSharedCopy = (req.payload as { sharedReadOnly?: boolean } | undefined)?.sharedReadOnly === true
              const canMarkDelivered =
                req.kind === "commodity" && req.status === "approved" && !isDelivered && !isSharedCopy
              // Stage 3 for outgoing payments: an approved, not-yet-delivered wire.
              // Only payments that entered the delivery lifecycle (stamped
              // `deliveryInitiatedAt` at approval) offer the confirm action, so
              // the historical backlog of older approved payments — which predate
              // the delivery feature and will never be delivered — is excluded and
              // stays consistent with the command-center awaiting-delivery count.
              const isPayment = req.kind === "payment"
              const paymentInitiated =
                (req.payload as { deliveryInitiatedAt?: string } | undefined)?.deliveryInitiatedAt != null
              const canMarkPaymentDelivered =
                isPayment && req.status === "approved" && paymentInitiated && !isDelivered
              // Three-stage lifecycle label for outgoing payments.
              const paymentStage: PaymentStage | null = isPayment
                ? req.status === "rejected"
                  ? "rejected"
                  : req.status === "approved"
                    ? isDelivered
                      ? "delivered"
                      : "initiated"
                    : "review"
                : null
              // Active suspend/freeze hold on this deal, if any.
              const held = (req.payload?.record as { hold?: { state?: DealHoldState } } | undefined)?.hold?.state
              // The admin deal-tools row applies to any real (non-shared, non-delivered)
              // commodity deal, regardless of approval status.
              const canManageDeal = req.kind === "commodity" && !isSharedCopy && !isDelivered
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
                        {paymentStage ? (
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${PAYMENT_STAGE_BADGE_CLASS[paymentStage]}`}
                          >
                            {PAYMENT_STAGE_SHORT[paymentStage]}
                          </Badge>
                        ) : (
                          <Badge variant={statusVariant[req.status]} className="text-[10px] capitalize">
                            {req.status}
                          </Badge>
                        )}
                        {isDelivered && !isPayment && (
                          <Badge
                            variant="outline"
                            className="border-green-500/30 bg-green-500/10 text-green-600 text-[10px]"
                          >
                            <PackageCheck className="mr-1 h-3 w-3" />
                            Delivered
                          </Badge>
                        )}
                        {held && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-600 text-[10px] capitalize"
                          >
                            {held === "frozen" ? <Lock className="mr-1 h-3 w-3" /> : <PauseCircle className="mr-1 h-3 w-3" />}
                            {held}
                          </Badge>
                        )}
                        <span className="text-sm font-semibold text-foreground">{formatAmount(req)}</span>
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">{req.title}</p>
                      {req.summary && <p className="text-xs text-muted-foreground text-pretty">{req.summary}</p>}
                      {req.kind === "commodity_amendment" && <AmendmentDiff payload={req.payload} />}
                      {funding && <FundingDocuments docs={funding.uploadedDocuments} />}
                      {ppi && (
                        <div className="mt-1.5 rounded-md border border-orange-500/30 bg-orange-500/5 p-2.5">
                          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
                            <Handshake className="h-3.5 w-3.5" />
                            PPI insurance premium
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="text-muted-foreground">Charged:</span>
                            <span className={ppi.negotiated != null ? "text-muted-foreground line-through" : "font-medium text-foreground"}>
                              {formatMoney2(ppi.original, ppi.currency)}
                            </span>
                            {ppi.negotiated != null && (
                              <>
                                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="font-medium text-foreground">{formatMoney2(ppi.negotiated, ppi.currency)}</span>
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  ({formatMoney2(ppi.refund, ppi.currency)} refunded)
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                      {mon && (
                        <div className="mt-1.5 rounded-md border border-orange-500/30 bg-orange-500/5 p-2.5">
                          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
                            <Handshake className="h-3.5 w-3.5" />
                            Blocked reserve (equity + PPI)
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="text-muted-foreground">Blocked:</span>
                            <span className={mon.negotiated != null ? "text-muted-foreground line-through" : "font-medium text-foreground"}>
                              {formatMoney2(mon.original, mon.currency)}
                            </span>
                            {mon.negotiated != null && (
                              <>
                                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="font-medium text-foreground">{formatMoney2(mon.negotiated, mon.currency)}</span>
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  ({formatMoney2(mon.released, mon.currency)} released)
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      )}
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
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {funding && (
                        <Button
                          size="sm"
                          variant={fundingNeedsDiscussion ? "default" : "outline"}
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => openFundingDiscuss(req, funding)}
                          title="Review the client's documents and negotiate the terms on Bankeka before activating."
                        >
                          <MessagesSquare className="h-3.5 w-3.5" />
                          {funding.discussionOpenedAt ? "Continue discussion" : "Discuss"}
                        </Button>
                      )}
                      {canNegotiatePpi && ppi && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 text-orange-600"
                          disabled={acting}
                          onClick={() => openPpiNegotiate(req, ppi)}
                          title="Negotiate a lower PPI insurance premium — the exceeded amount is refunded to the client's Master Account."
                        >
                          <Handshake className="h-3.5 w-3.5" /> Negotiate PPI
                        </Button>
                      )}
                      {canNegotiateReserve && mon && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 text-orange-600"
                          disabled={acting}
                          onClick={() => openResNegotiate(req, mon)}
                          title="Negotiate a lower blocked reserve — the exceeded amount is released back to the client's available balance."
                        >
                          <Handshake className="h-3.5 w-3.5" /> Negotiate reserve
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-emerald-600"
                        disabled={acting || fundingNeedsDiscussion}
                        onClick={() => approveOne(req.id)}
                        title={
                          fundingNeedsDiscussion
                            ? "Open the discussion with the applicant before activating this facility."
                            : undefined
                        }
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
                  {canNegotiatePpi && ppi && req.status === "approved" && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-orange-600"
                        disabled={acting}
                        onClick={() => openPpiNegotiate(req, ppi)}
                        title="Negotiate a lower PPI insurance premium — the exceeded amount is refunded to the client's Master Account."
                      >
                        <Handshake className="h-3.5 w-3.5" /> Negotiate PPI
                      </Button>
                    </div>
                  )}
                  {canNegotiateReserve && mon && req.status === "approved" && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-orange-600"
                        disabled={acting}
                        onClick={() => openResNegotiate(req, mon)}
                        title="Negotiate a lower blocked reserve — the exceeded amount is released back to the client's available balance."
                      >
                        <Handshake className="h-3.5 w-3.5" /> Negotiate reserve
                      </Button>
                    </div>
                  )}
                  {term && (
                    <div className="w-full space-y-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-orange-600 dark:text-orange-400">
                        <Handshake className="h-4 w-4" /> Early resignation requested
                      </div>
                      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                        <div className="flex items-center justify-between gap-2">
                          <span>Invested principal</span>
                          <span className="font-mono tabular-nums text-foreground">
                            {formatMoney2(term.principal, term.currency)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span>Standard ({(YIELD_EARLY_CANCELLATION_PENALTY_RATE * 100).toFixed(0)}%)</span>
                          <span className="font-mono tabular-nums text-foreground">
                            {formatMoney2(term.suggested, term.currency)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 sm:col-span-2">
                          <span>Client-proposed exit cost</span>
                          <span className="font-mono font-semibold tabular-nums text-orange-600 dark:text-orange-400">
                            {formatMoney2(term.proposed, term.currency)}
                          </span>
                        </div>
                      </div>
                      {term.reason && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Reason: </span>
                          {term.reason}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => openTermConfirm(req, term)}
                          title="Agree the final exit cost with the client and confirm — this settles the exit and terminates the yield."
                        >
                          <Handshake className="h-3.5 w-3.5" /> Negotiate &amp; confirm
                        </Button>
                      </div>
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

                  {/* Stage 3 for outgoing payments: confirm the wire reached the
                      beneficiary, moving it from "Approved & Initiated" to
                      "Completed — Funds Delivered". No funds move here. */}
                  {isPayment && req.status === "approved" && (
                    <div className="flex shrink-0 items-center justify-end">
                      {canMarkPaymentDelivered ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 text-emerald-600"
                          disabled={acting}
                          onClick={() => markPaymentDelivered(req.id)}
                          title="Confirm the funds have reached the beneficiary account. Marks this payment complete for the client."
                        >
                          <PackageCheck className="h-3.5 w-3.5" /> Mark funds delivered
                        </Button>
                      ) : (
                        <Badge
                          variant="outline"
                          className="gap-1 border-green-500/30 bg-green-500/10 text-green-600"
                        >
                          <PackageCheck className="h-3.5 w-3.5" /> Funds delivered
                        </Badge>
                      )}
                    </div>
                  )}

                  {/* Admin deal tools: suspend / freeze / resume / delete — any deal state. */}
                  {canManageDeal && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border pt-2 sm:border-t-0 sm:pt-0">
                      {held === "suspended" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => setHold(req.id, null)}
                          title="Resume this suspended deal."
                        >
                          <PlayCircle className="h-3.5 w-3.5" /> Resume
                        </Button>
                      ) : held !== "frozen" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => setHold(req.id, "suspended")}
                          title="Suspend this deal — pauses its workflow until resumed."
                        >
                          <PauseCircle className="h-3.5 w-3.5" /> Suspend
                        </Button>
                      ) : null}
                      {held === "frozen" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => setHold(req.id, null)}
                          title="Unfreeze this deal."
                        >
                          <LockOpen className="h-3.5 w-3.5" /> Unfreeze
                        </Button>
                      ) : held !== "suspended" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1"
                          disabled={acting}
                          onClick={() => setHold(req.id, "frozen")}
                          title="Freeze this deal — locks all changes and keeps reserved funds blocked."
                        >
                          <Lock className="h-3.5 w-3.5" /> Freeze
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-destructive"
                        disabled={acting || held === "frozen"}
                        onClick={() => setDeleteTarget({ id: req.id, label: req.title })}
                        title={
                          held === "frozen"
                            ? "Unfreeze the deal before deleting."
                            : "Permanently delete this deal and release any reserved funds."
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* AES funding discussion — review documents + negotiate on Bankeka */}
      <Dialog open={!!discussFunding} onOpenChange={(o) => !o && setDiscussFunding(null)}>
        <DialogContent className="flex h-[92dvh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border p-4 pr-12">
            <DialogTitle className="flex items-center gap-2">
              <MessagesSquare className="h-5 w-5 text-primary" /> Funding discussion
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {discussFunding
                ? `Review the documents ${clientLabel(discussFunding.req.userId)} submitted and negotiate the terms of the ${formatAmount(
                    discussFunding.req,
                  )} facility for "${discussFunding.record.projectName}" on Bankeka. They reply from their own Bankeka Messenger.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {discussFunding && (
            <>
              {/* Decision actions live at the TOP so they never collide with the
                  Messenger composer / on-screen keyboard at the bottom. */}
              {discussFunding.req.status === "pending" && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
                  <Button
                    variant="outline"
                    className="flex-1 text-destructive"
                    onClick={() => {
                      const id = discussFunding.req.id
                      setDiscussFunding(null)
                      openReject(id)
                    }}
                  >
                    <X className="mr-2 h-4 w-4" /> Reject
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => {
                      const id = discussFunding.req.id
                      setDiscussFunding(null)
                      approveOne(id)
                    }}
                  >
                    <Check className="mr-2 h-4 w-4" /> Approve &amp; activate
                  </Button>
                </div>
              )}
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <FundingDocuments docs={discussFunding.record.uploadedDocuments} />
                {discussFunding.req.userId ? (
                  <Messenger
                    key={discussFunding.req.id}
                    scope={`admin-funding-${discussFunding.req.id}`}
                    fetchConversations={() => adminListConversations(ADMIN_PASSCODE)}
                    fetchThread={(id) => adminGetThread(ADMIN_PASSCODE, id)}
                    send={(id, body, atts) => adminReply(ADMIN_PASSCODE, id, body, atts)}
                    deleteMessage={(m) => adminDeleteMessage(ADMIN_PASSCODE, m)}
                    attachmentsEnabled
                    uploadPayload={JSON.stringify({ passcode: ADMIN_PASSCODE })}
                    hideConversationList
                    initialThreadId={discussFunding.req.userId}
                    initialParticipant={{
                      id: discussFunding.req.userId,
                      name: discussFunding.record.ownerName ?? clientLabel(discussFunding.req.userId),
                      company: discussFunding.record.ownerCompany ?? "",
                      initials: (discussFunding.record.ownerName ?? clientLabel(discussFunding.req.userId))
                        .split(/\s+/)
                        .map((w) => w[0])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join("")
                        .toUpperCase(),
                      isAdmin: false,
                    }}
                    initialDraft={`Regarding your AES project funding application ${discussFunding.req.id} — "${discussFunding.record.projectName}", ${formatAmount(
                      discussFunding.req,
                    )}: `}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This application has no linked applicant account, so a discussion cannot be opened.
                  </p>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete commodity deal dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && !acting && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete deal
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {deleteTarget ? (
                <>
                  This permanently deletes{" "}
                  <span className="font-medium text-foreground">{deleteTarget.label}</span> and releases any
                  reserved funds back to the client&apos;s available balance. The client will be notified. This
                  cannot be undone.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={acting}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              Delete &amp; release funds
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Negotiate leverage PPI premium dialog */}
      <Dialog open={ppiTarget !== null} onOpenChange={(o) => !o && !acting && setPpiTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Handshake className="h-4 w-4 text-orange-500" />
              Negotiate PPI premium
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Agree a special, lower PPI insurance premium for this leverage line. The exceeded amount is refunded to
              the client&apos;s Master Account immediately, and only the agreed premium remains charged. The client is
              notified of the special treatment.
            </DialogDescription>
          </DialogHeader>
          {ppiTarget && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Original premium charged</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatMoney2(ppiTarget.original, ppiTarget.currency)}
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ppi-new">New agreed premium ({ppiTarget.currency})</Label>
                <Input
                  id="ppi-new"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={ppiTarget.original}
                  step="0.01"
                  value={ppiValue}
                  onChange={(e) => setPpiValue(e.target.value)}
                  className="text-base md:text-sm"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Refunded to Master Account</span>
                <span className="font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatMoney2(
                    Math.max(0, Math.round((ppiTarget.original - (Number(ppiValue) || 0) + Number.EPSILON) * 100) / 100),
                    ppiTarget.currency,
                  )}
                </span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ppi-note">Note (optional)</Label>
                <Textarea
                  id="ppi-note"
                  value={ppiNote}
                  onChange={(e) => setPpiNote(e.target.value)}
                  placeholder="Reason for the special arrangement…"
                  className="min-h-16 text-base md:text-sm"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPpiTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button onClick={confirmPpiNegotiate} disabled={acting} className="gap-1">
              {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Handshake className="h-4 w-4" />}
              Apply &amp; refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Negotiate monetization reserve dialog */}
      <Dialog open={resTarget !== null} onOpenChange={(o) => !o && !acting && setResTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Handshake className="h-4 w-4 text-orange-500" />
              Negotiate blocked reserve
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Agree a special, lower blocked reserve (equity deposit + PPI) for this monetization. The exceeded amount
              is released back to the client&apos;s available balance immediately, and only the agreed reserve stays
              blocked as collateral. The client is notified of the special treatment.
            </DialogDescription>
          </DialogHeader>
          {resTarget && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Originally blocked</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatMoney2(resTarget.original, resTarget.currency)}
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-new">New agreed reserve ({resTarget.currency})</Label>
                <Input
                  id="res-new"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={resTarget.original}
                  step="0.01"
                  value={resValue}
                  onChange={(e) => setResValue(e.target.value)}
                  className="text-base md:text-sm"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Released to available balance</span>
                <span className="font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatMoney2(
                    Math.max(0, Math.round((resTarget.original - (Number(resValue) || 0) + Number.EPSILON) * 100) / 100),
                    resTarget.currency,
                  )}
                </span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-note">Note (optional)</Label>
                <Textarea
                  id="res-note"
                  value={resNote}
                  onChange={(e) => setResNote(e.target.value)}
                  placeholder="Reason for the special arrangement…"
                  className="min-h-16 text-base md:text-sm"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button onClick={confirmResNegotiate} disabled={acting} className="gap-1">
              {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Handshake className="h-4 w-4" />}
              Apply &amp; release
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
