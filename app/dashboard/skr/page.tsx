"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ShieldCheck,
  FileText,
  Download,
  Eye,
  Clock,
  CheckCircle2,
  XCircle,
  Landmark,
  Calendar,
  Hash,
  User,
  Send,
  Lock,
  Banknote,
  History,
  Paperclip,
  Upload,
  Loader2,
  ClipboardCheck,
  ArrowRight,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { exportToCsv } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generateSkrCertificate } from "@/lib/certificate-pdf"
import { blobFileUrl } from "@/lib/kyc-types"
import { downloadFile } from "@/lib/download-file"
import { Award } from "lucide-react"
import { upload } from "@vercel/blob/client"
import Link from "next/link"
import { addMySkrDocument, requestSkrExpertise, declineSkrExpertise } from "@/app/actions/skr"
import { acceptSkrExpertise } from "@/app/actions/approvals"
import {
  SKR_EXPERTISE_KINDS,
  SKR_EXPERTISE_STATUS_LABELS,
  type SkrExpertiseKind,
  type SkrExpertiseStatus,
} from "@/lib/skr-expertise"
import {
  useSkr,
  formatSkrValue,
  generateSkrRef,
  SKR_STATUS_LABELS,
  type SkrRecord,
  type SkrStatus,
  type SkrRequestType,
} from "@/lib/skr-store"

const statusStyles: Record<SkrStatus, string> = {
  active: "border-green-500/20 bg-green-500/10 text-green-500",
  pending: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  matured: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  transferred: "border-primary/20 bg-primary/10 text-primary",
  suspended: "border-orange-500/20 bg-orange-500/10 text-orange-400",
  cancelled: "border-muted bg-muted text-muted-foreground",
}

const requestStatusStyles = {
  pending: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  approved: "border-green-500/20 bg-green-500/10 text-green-500",
  rejected: "border-red-500/20 bg-red-500/10 text-red-500",
}

const REQUEST_TYPES: SkrRequestType[] = [
  "Statement",
  "Verification",
  "Amendment",
  "Transfer",
  "Other",
]

const expertiseBadgeStyles: Record<SkrExpertiseStatus, string> = {
  requested: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  assessed: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  accepted: "border-green-500/20 bg-green-500/10 text-green-500",
  declined: "border-muted bg-muted text-muted-foreground",
}

const formatDate = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

const formatDateTime = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

export default function SkrPage() {
  const { records, requests, addRequest, refresh } = useSkr()
  const logActivity = useActivityLog()

  // Pull the latest server-side portfolio when the page opens, so receipts the
  // custody desk assigned on another device show up without a full reload.
  useEffect(() => {
    refresh()
  }, [refresh])

  const [viewTarget, setViewTarget] = useState<SkrRecord | null>(null)
  const [requestOpen, setRequestOpen] = useState(false)
  const [reqType, setReqType] = useState<SkrRequestType>("Statement")
  const [reqRecordId, setReqRecordId] = useState<string>("")
  const [reqMessage, setReqMessage] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)

  // Expertise / evaluation / audit application + acceptance
  const [applyTarget, setApplyTarget] = useState<SkrRecord | null>(null)
  const [applyKind, setApplyKind] = useState<SkrExpertiseKind>("Expertise")
  const [applyNote, setApplyNote] = useState("")
  const [applyBusy, setApplyBusy] = useState(false)
  const [expActionId, setExpActionId] = useState<string | null>(null)

  // Keep the open detail modal in sync with the latest server data, so a freshly
  // uploaded document appears immediately after the post-upload refresh.
  useEffect(() => {
    if (!viewTarget) return
    const latest = records.find((r) => r.id === viewTarget.id)
    if (latest && latest !== viewTarget) setViewTarget(latest)
  }, [records, viewTarget])

  const totals = useMemo(() => {
    const byCurrency = new Map<string, number>()
    let active = 0
    for (const r of records) {
      if (r.status === "active") active += 1
      byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.faceValue)
    }
    return {
      count: records.length,
      active,
      byCurrency: Array.from(byCurrency.entries()).sort((a, b) => b[1] - a[1]),
    }
  }, [records])

  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress, holderRepresentative } = useHolderIdentity()

  const uploadDocument = async (record: SkrRecord, file: File) => {
    const MAX = 25 * 1024 * 1024
    if (file.size > MAX) {
      toast.error("File too large", { description: "Documents must be 25 MB or smaller." })
      return
    }
    setUploadingId(record.id)
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
      const result = await upload(`skr/${record.id}/${Date.now()}-${safe}`, file, {
        access: "public",
        handleUploadUrl: "/api/skr/blob-upload",
      })
      const doc = {
        id: generateSkrRef("DOC"),
        name: file.name,
        docType: file.type === "application/pdf" ? "Client Document" : "Asset Photograph",
        uploadedAt: new Date().toISOString(),
        pathname: result.pathname,
        url: result.url,
        size: file.size,
        contentType: file.type || "application/octet-stream",
      }
      const res = await addMySkrDocument(record.id, doc)
      if (!res.ok) {
        toast.error("Could not attach document", { description: res.error })
        return
      }
      await refresh()
      toast.success("Document uploaded", { description: `${file.name} added to ${record.id}.` })
      logActivity({
        action: `Uploaded a document to SKR ${record.id}`,
        category: "SKR Trading",
        details: {
          summary: `Client uploaded supporting document "${file.name}" to safe keeping receipt ${record.id} (${record.custodian}).`,
          referenceId: record.id,
          document: file.name,
        },
      })
    } catch (err) {
      toast.error("Upload failed", { description: (err as Error).message })
    } finally {
      setUploadingId(null)
    }
  }

  const downloadStatement = (record: SkrRecord) => {
    const doc = generateTablePdf({
      title: "Safe Keeping Receipt Statement",
      refPrefix: "SKR",
      holderName,
      holderCompany,
      holderAddress,
      holderRepresentative,
      meta: [
        { label: "SKR Reference", value: record.id },
        { label: "Status", value: SKR_STATUS_LABELS[record.status] },
        { label: "Issuing Bank / Custodian", value: record.custodian },
        { label: "Beneficial Owner", value: record.beneficialOwner },
        { label: "Face Value", value: formatSkrValue(record.faceValue, record.currency) },
        { label: "Date of Issuance", value: formatDate(record.issueDate) },
        { label: "Expiry Date", value: formatDate(record.expiryDate) },
        { label: "Custody Account Ref", value: record.custodyAccountRef },
      ],
      sectionTitle: "Transaction History",
      columns: [
        { key: "date", header: "Date" },
        { key: "type", header: "Type" },
        { key: "reference", header: "Reference" },
        { key: "description", header: "Description" },
      ],
      rows: record.transactions.map((t) => ({
        date: formatDate(t.date),
        type: t.type,
        reference: t.reference,
        description: t.description,
      })),
      emptyMessage: "No transactions on record.",
      footNote: "This statement is issued for information purposes by MCC Capital custody services.",
    })
    show({ doc, filename: tablePdfFilename(`SKR-Statement-${record.id}`), title: "Safe Keeping Receipt Statement" })
    logActivity({
      action: `Downloaded SKR statement for ${record.id}`,
      category: "SKR Trading",
      details: {
        summary: `Client downloaded the safe keeping receipt account statement for ${record.id} (${record.custodian}), face value ${formatSkrValue(record.faceValue, record.currency)}.`,
        referenceId: record.id,
        custodian: record.custodian,
        faceValue: formatSkrValue(record.faceValue, record.currency),
      },
    })
  }

  const downloadCertificate = (record: SkrRecord) => {
    const generated = generateSkrCertificate({
      reference: record.id,
      custodian: record.custodian,
      beneficialOwner: record.beneficialOwner,
      faceValue: formatSkrValue(record.faceValue, record.currency),
      currency: record.currency,
      status: SKR_STATUS_LABELS[record.status],
      issueDate: record.issueDate,
      expiryDate: record.expiryDate,
      custodyAccountRef: record.custodyAccountRef,
      assetDescription: record.assetDescription,
      verificationCode: `VRF-${record.id.replace(/\D/g, "").slice(-6) || "000000"}`,
    })
    show(generated)
    logActivity({
      action: `Downloaded SKR certificate for ${record.id}`,
      category: "SKR Trading",
      details: {
        summary: `Client generated the safe keeping receipt certificate for ${record.id}, declaring custody of an asset worth ${formatSkrValue(record.faceValue, record.currency)} owned by ${record.beneficialOwner}.`,
        referenceId: record.id,
        custodian: record.custodian,
        declaredValue: formatSkrValue(record.faceValue, record.currency),
      },
    })
  }

  const downloadTransactionsCsv = (record: SkrRecord) => {
    if (record.transactions.length === 0) {
      toast.error("No transactions to export", {
        description: `${record.id} has no recorded transactions yet.`,
      })
      return
    }
    exportToCsv(
      `SKR-Transactions-${record.id}`,
      record.transactions.map((t) => ({
        date: formatDate(t.date),
        type: t.type,
        reference: t.reference,
        description: t.description,
      })),
      [
        { key: "date", label: "Date" },
        { key: "type", label: "Type" },
        { key: "reference", label: "Reference" },
        { key: "description", label: "Description" },
      ],
    )
    toast.success("Transaction history exported", {
      description: `${record.transactions.length} transactions exported for ${record.id}.`,
    })
    logActivity({
      action: `Exported SKR transaction history for ${record.id}`,
      category: "SKR Trading",
      details: {
        summary: `Client exported the transaction history (${record.transactions.length} entries) for safe keeping receipt ${record.id}.`,
        referenceId: record.id,
        transactionCount: String(record.transactions.length),
      },
    })
  }

  const openRequest = (recordId: string) => {
    setReqType("Statement")
    setReqRecordId(recordId)
    setReqMessage("")
    setRequestOpen(true)
  }

  // --- Expertise / evaluation / audit ----------------------------------------

  const openApply = (record: SkrRecord) => {
    setApplyTarget(record)
    setApplyKind("Expertise")
    setApplyNote("")
  }

  const submitApply = async () => {
    if (!applyTarget) return
    setApplyBusy(true)
    const res = await requestSkrExpertise(applyTarget.id, applyKind, applyNote.trim() || undefined)
    setApplyBusy(false)
    if (!res.ok) {
      toast.error("Could not submit your application", { description: res.error })
      return
    }
    toast.success("Application submitted", {
      description: `Your ${applyKind.toLowerCase()} request for ${applyTarget.id} has been sent to the custody desk.`,
    })
    logActivity({
      action: `Applied for an SKR ${applyKind.toLowerCase()} on ${applyTarget.id}`,
      category: "SKR Trading",
      details: {
        summary: `Client applied for an official ${applyKind} of the goods held under safe keeping receipt ${applyTarget.id}.`,
        referenceId: applyTarget.id,
        requestType: applyKind,
        status: "Awaiting custody-desk valuation",
      },
    })
    setApplyTarget(null)
    await refresh()
  }

  const acceptExpertise = async (record: SkrRecord) => {
    setExpActionId(record.id)
    try {
      const res = await acceptSkrExpertise(record.id)
      if (!res.ok) {
        toast.error("Could not accept the valuation", { description: res.error })
        return
      }
      toast.success("SKR unlocked as collateral", {
        description: `${formatSkrValue(res.charged, res.currency)} charged. ${record.id} is now blocked collateral, ready for monetization, upgrade, leverage and loans.`,
      })
      logActivity({
        action: `Accepted the SKR expertise valuation for ${record.id}`,
        category: "SKR Trading",
        details: {
          summary: `Client accepted the expertise valuation for safe keeping receipt ${record.id}. Service cost ${formatSkrValue(res.charged, res.currency)} charged to the Master Account; the SKR is now blocked as collateral (instrument ${res.instrumentId}).`,
          referenceId: record.id,
          cost: formatSkrValue(res.charged, res.currency),
          instrument: res.instrumentId,
        },
      })
      await refresh()
    } finally {
      setExpActionId(null)
    }
  }

  const declineExpertise = async (record: SkrRecord) => {
    setExpActionId(record.id)
    try {
      const res = await declineSkrExpertise(record.id)
      if (!res.ok) {
        toast.error("Could not decline the valuation", { description: res.error })
        return
      }
      toast.success("Valuation declined", { description: `You declined the assessment for ${record.id}. You can apply again later.` })
      await refresh()
    } finally {
      setExpActionId(null)
    }
  }

  const submitRequest = () => {
    if (!reqMessage.trim()) {
      toast.error("Please describe your request", {
        description: "Add a short message so the custody desk can action it.",
      })
      return
    }
    const created = addRequest({
      recordId: reqRecordId,
      type: reqType,
      message: reqMessage.trim(),
    })
    toast.success("Request submitted", {
      description: `Your ${reqType.toLowerCase()} request ${created.id} has been sent to the custody desk.`,
    })
    logActivity({
      action: `Submitted SKR ${reqType} request ${created.id}`,
      category: "SKR Trading",
      details: {
        summary: `Client submitted a ${reqType} request${reqRecordId ? ` concerning SKR ${reqRecordId}` : ""}. Message: ${reqMessage.trim()}`,
        referenceId: created.id,
        requestType: reqType,
        relatedInstrument: reqRecordId || "(general)",
        status: "Pending custody desk action",
      },
    })
    setRequestOpen(false)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground text-balance">
              SKR Trading Platform
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              Safe Keeping Receipts held under custody. View your portfolio, statements, and history.
            </p>
          </div>
        </div>
        <Button onClick={() => openRequest("")} className="shrink-0">
          <Send className="mr-2 h-4 w-4" />
          Submit Request
        </Button>
      </div>

      {/* Read-only notice */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 p-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your SKR records are maintained by MCC Capital custody administration and are read-only.
          To create, amend, transfer, or verify an instrument, submit a request and our custody desk
          will action it.
        </p>
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-border bg-card">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total SKRs</p>
              <p className="text-xl font-semibold text-foreground">{totals.count}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Active Instruments</p>
              <p className="text-xl font-semibold text-foreground">{totals.active}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Banknote className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Face Value</p>
              {totals.byCurrency.length === 0 ? (
                <p className="text-xl font-semibold text-foreground">—</p>
              ) : (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {totals.byCurrency.map(([cur, val]) => (
                    <p key={cur} className="text-sm font-semibold text-foreground">
                      {formatSkrValue(val, cur)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="portfolio">
        <TabsList>
          <TabsTrigger value="portfolio">My Portfolio</TabsTrigger>
          <TabsTrigger value="requests">My Requests</TabsTrigger>
        </TabsList>

        {/* Portfolio */}
        <TabsContent value="portfolio" className="mt-6 space-y-4">
          {records.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-14 text-center">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No SKR records yet</p>
                <p className="max-w-md text-sm text-muted-foreground text-pretty">
                  Safe Keeping Receipts assigned to your account by MCC Capital custody
                  administration will appear here. Submit a request to enquire about a new instrument.
                </p>
              </CardContent>
            </Card>
          ) : (
            records.map((record) => (
              <Card key={record.id} className="border-border bg-card">
                <CardContent className="p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-primary/20 bg-primary/10 text-[10px] text-primary">
                          SKR
                        </Badge>
                        <span className="font-medium text-foreground">{record.id}</span>
                        <Badge
                          variant="outline"
                          className={cn("text-[10px]", statusStyles[record.status])}
                        >
                          {SKR_STATUS_LABELS[record.status]}
                        </Badge>
                        {record.expertise && (
                          <Badge
                            variant="outline"
                            className={cn("gap-1 text-[10px]", expertiseBadgeStyles[record.expertise.status])}
                          >
                            <ClipboardCheck className="h-3 w-3" />
                            {record.expertise.kind}: {SKR_EXPERTISE_STATUS_LABELS[record.expertise.status]}
                          </Badge>
                        )}
                        {record.blockedAsCollateral && (
                          <Badge
                            variant="outline"
                            className="gap-1 border-primary/20 bg-primary/10 text-[10px] text-primary"
                          >
                            <Lock className="h-3 w-3" />
                            Collateral
                          </Badge>
                        )}
                      </div>
                      <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <Landmark className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Custodian:</span>
                          <span className="text-foreground">{record.custodian}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Banknote className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Face value:</span>
                          <span className="font-medium text-foreground">
                            {formatSkrValue(record.faceValue, record.currency)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Hash className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Custody a/c:</span>
                          <span className="text-foreground">{record.custodyAccountRef}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Expiry:</span>
                          <span className="text-foreground">{formatDate(record.expiryDate)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch lg:w-44 lg:shrink-0">
                      <Button variant="outline" size="sm" onClick={() => setViewTarget(record)}>
                        <Eye className="mr-1.5 h-4 w-4" />
                        Details
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => downloadStatement(record)}>
                        <Download className="mr-1.5 h-4 w-4" />
                        Statement
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openRequest(record.id)}>
                        <Send className="mr-1.5 h-4 w-4" />
                        Request
                      </Button>
                    </div>
                  </div>

                  {/* Expertise / Evaluation / Audit */}
                  {(() => {
                    const exp = record.expertise
                    const canApply =
                      record.status !== "cancelled" &&
                      !record.blockedAsCollateral &&
                      (!exp || exp.status === "declined")
                    if (canApply) {
                      return (
                        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs text-muted-foreground text-pretty">
                            Apply for an official expertise, evaluation or audit of the goods. Once assessed and
                            accepted, this SKR can be used as collateral for monetization, upgrades, leverage and loans.
                          </p>
                          <Button
                            size="sm"
                            className="shrink-0"
                            onClick={() => openApply(record)}
                          >
                            <ClipboardCheck className="mr-1.5 h-4 w-4" />
                            Apply for expertise
                          </Button>
                        </div>
                      )
                    }
                    if (!exp) return null
                    if (exp.status === "requested") {
                      return (
                        <div className="mt-4 flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                          <p className="text-xs text-muted-foreground text-pretty">
                            Your <span className="font-medium text-foreground">{exp.kind.toLowerCase()}</span> application
                            is with the custody desk. You&apos;ll be notified when the assessed value and cost are ready.
                          </p>
                        </div>
                      )
                    }
                    if (exp.status === "assessed") {
                      const busy = expActionId === record.id
                      return (
                        <div className="mt-4 space-y-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                          <div className="flex items-center gap-2">
                            <ClipboardCheck className="h-4 w-4 text-blue-400" />
                            <p className="text-sm font-medium text-foreground">
                              {exp.kind} completed — review &amp; accept
                            </p>
                          </div>
                          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                            {exp.assessedValue != null && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Assessed value</span>
                                <span className="font-medium text-foreground">
                                  {formatSkrValue(exp.assessedValue, exp.assessedCurrency ?? record.currency)}
                                </span>
                              </div>
                            )}
                            {exp.cost != null && (
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Service cost</span>
                                <span className="font-medium text-foreground">
                                  {formatSkrValue(exp.cost, exp.costCurrency ?? record.currency)}
                                </span>
                              </div>
                            )}
                          </div>
                          {exp.outcomeNote && (
                            <p className="text-xs text-muted-foreground text-pretty">
                              <span className="font-medium text-foreground">Outcome:</span> {exp.outcomeNote}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground text-pretty">
                            Accepting charges the service cost to your Master Account and blocks this SKR as collateral
                            (MT760-equivalent), unlocking monetization, upgrade, leverage and loan uses under Bank
                            Instruments.
                          </p>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button
                              size="sm"
                              className="sm:flex-1"
                              onClick={() => acceptExpertise(record)}
                              disabled={busy}
                            >
                              {busy ? (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                              )}
                              Accept &amp; unlock as collateral
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="sm:flex-1"
                              onClick={() => declineExpertise(record)}
                              disabled={busy}
                            >
                              <XCircle className="mr-1.5 h-4 w-4" />
                              Decline
                            </Button>
                          </div>
                        </div>
                      )
                    }
                    if (exp.status === "accepted") {
                      return (
                        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-green-500/20 bg-green-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-2">
                            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                            <p className="text-xs text-muted-foreground text-pretty">
                              This SKR is blocked as collateral
                              {exp.assessedValue != null
                                ? ` (${formatSkrValue(exp.assessedValue, exp.assessedCurrency ?? record.currency)})`
                                : ""}
                              . Use it for monetization, upgrade, leverage or loans under Bank Instruments.
                            </p>
                          </div>
                          <Button asChild variant="outline" size="sm" className="shrink-0">
                            <Link href="/dashboard/instruments">
                              Bank Instruments
                              <ArrowRight className="ml-1.5 h-4 w-4" />
                            </Link>
                          </Button>
                        </div>
                      )
                    }
                    return null
                  })()}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Requests */}
        <TabsContent value="requests" className="mt-6 space-y-3">
          {requests.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Send className="h-7 w-7 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  You have not submitted any SKR requests yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            requests.map((req) => (
              <Card key={req.id} className="border-border bg-card">
                <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{req.type} request</span>
                      <span className="text-xs text-muted-foreground">{req.id}</span>
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", requestStatusStyles[req.status])}
                      >
                        {req.status === "pending" && <Clock className="mr-1 h-3 w-3" />}
                        {req.status === "approved" && <CheckCircle2 className="mr-1 h-3 w-3" />}
                        {req.status === "rejected" && <XCircle className="mr-1 h-3 w-3" />}
                        {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
                      </Badge>
                    </div>
                    {req.recordId && (
                      <p className="text-xs text-muted-foreground">Concerning: {req.recordId}</p>
                    )}
                    <p className="text-sm text-foreground text-pretty">{req.message}</p>
                    {req.decisionNote && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        Custody desk: {req.decisionNote}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(req.submittedAt)}
                  </span>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* Details dialog */}
      <Dialog open={!!viewTarget} onOpenChange={(open) => !open && setViewTarget(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {viewTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  {viewTarget.id}
                </DialogTitle>
                <DialogDescription>
                  Safe Keeping Receipt details and custody references.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={cn("text-[10px]", statusStyles[viewTarget.status])}>
                    {SKR_STATUS_LABELS[viewTarget.status]}
                  </Badge>
                </div>

                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  <Detail icon={Landmark} label="Issuing bank / custodian" value={viewTarget.custodian} />
                  <Detail icon={User} label="Beneficial owner" value={viewTarget.beneficialOwner} />
                  <Detail
                    icon={Banknote}
                    label="Face value"
                    value={formatSkrValue(viewTarget.faceValue, viewTarget.currency)}
                  />
                  <Detail icon={Hash} label="Custody account ref" value={viewTarget.custodyAccountRef} />
                  <Detail icon={Calendar} label="Date of issuance" value={formatDate(viewTarget.issueDate)} />
                  <Detail icon={Calendar} label="Expiry date" value={formatDate(viewTarget.expiryDate)} />
                </dl>

                {viewTarget.assetDescription && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Asset held under custody</p>
                    <p className="mt-1 text-sm text-foreground text-pretty">{viewTarget.assetDescription}</p>
                  </div>
                )}

                {viewTarget.notes && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">Custody notes</p>
                    <p className="mt-1 text-sm text-foreground text-pretty">{viewTarget.notes}</p>
                  </div>
                )}

                {/* Documents */}
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Paperclip className="h-4 w-4 text-muted-foreground" />
                    Supporting documents
                  </p>
                  {viewTarget.documents.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No documents attached.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {viewTarget.documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
                        >
                          <div className="flex items-center gap-2 overflow-hidden">
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm text-foreground">{doc.name}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">{doc.docType}</span>
                          </div>
                          {doc.pathname ? (
                            <button
                              type="button"
                              onClick={() => void downloadFile(blobFileUrl(doc.pathname!), doc.name)}
                              className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Download className="h-3.5 w-3.5" />
                              Download
                            </button>
                          ) : (
                            <span className="shrink-0 text-[11px] text-muted-foreground">Reference only</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void uploadDocument(viewTarget, file)
                        e.target.value = ""
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={uploadingId === viewTarget.id}
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full sm:w-auto"
                    >
                      {uploadingId === viewTarget.id ? (
                        <>
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                          Uploading…
                        </>
                      ) : (
                        <>
                          <Upload className="mr-1.5 h-4 w-4" />
                          Upload document or picture
                        </>
                      )}
                    </Button>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      Attach photos or PDFs evidencing the asset (max 25 MB). Images and PDFs only.
                    </p>
                  </div>
                </div>

                {/* Transaction history */}
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <History className="h-4 w-4 text-muted-foreground" />
                    Transaction history
                  </p>
                  {viewTarget.transactions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No transactions on record.</p>
                  ) : (
                    <div className="space-y-2">
                      {viewTarget.transactions.map((t) => (
                        <div key={t.id} className="rounded-md border border-border bg-card p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-foreground">{t.type}</span>
                            <span className="text-[11px] text-muted-foreground">{formatDate(t.date)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground text-pretty">{t.description}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">Ref: {t.reference}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  onClick={() => downloadTransactionsCsv(viewTarget)}
                  className="w-full sm:w-auto"
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  Export history (CSV)
                </Button>
                <Button
                  variant="outline"
                  onClick={() => downloadCertificate(viewTarget)}
                  className="w-full sm:w-auto"
                >
                  <Award className="mr-1.5 h-4 w-4" />
                  SKR certificate
                </Button>
                <Button onClick={() => downloadStatement(viewTarget)} className="w-full sm:w-auto">
                  <Download className="mr-1.5 h-4 w-4" />
                  Download statement
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Submit request dialog */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit SKR Request</DialogTitle>
            <DialogDescription>
              Send a request to the MCC Capital custody desk concerning your instruments.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Request type</Label>
              <Select value={reqType} onValueChange={(v) => setReqType(v as SkrRequestType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Related instrument (optional)</Label>
              <Select value={reqRecordId || "none"} onValueChange={(v) => setReqRecordId(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="General enquiry" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">General enquiry</SelectItem>
                  {records.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.id} — {formatSkrValue(r.faceValue, r.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-req-msg">Message</Label>
              <Textarea
                id="skr-req-msg"
                value={reqMessage}
                onChange={(e) => setReqMessage(e.target.value)}
                placeholder="Describe your request (e.g. request a certified statement, verify the instrument, request an amendment or transfer)."
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRequest}>Submit Request</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply for expertise / evaluation / audit */}
      <Dialog open={!!applyTarget} onOpenChange={(open) => !open && !applyBusy && setApplyTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply for expertise — {applyTarget?.id}</DialogTitle>
            <DialogDescription>
              Request an official assessment of the goods held under this SKR. The custody desk will value them
              and return the outcome plus a service cost for your review. Nothing is charged until you accept.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assessment type</Label>
              <Select value={applyKind} onValueChange={(v) => setApplyKind(v as SkrExpertiseKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKR_EXPERTISE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-apply-note">Notes for the custody desk (optional)</Label>
              <Textarea
                id="skr-apply-note"
                value={applyNote}
                onChange={(e) => setApplyNote(e.target.value)}
                placeholder="Add any context about the goods, documents available, or the purpose of the assessment."
                rows={3}
              />
            </div>
            <p className="text-[11px] text-muted-foreground text-pretty">
              Once accepted, the assessed SKR is treated as blocked collateral (equivalent to a SWIFT MT760) and
              becomes available for monetization, instrument upgrade, leverage and loan collateral.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyTarget(null)} disabled={applyBusy}>
              Cancel
            </Button>
            <Button onClick={submitApply} disabled={applyBusy}>
              {applyBusy ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <ClipboardCheck className="mr-1.5 h-4 w-4" />
                  Submit application
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="space-y-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  )
}
