"use client"

import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { upload } from "@vercel/blob/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FileText,
  Ship,
  Loader2,
  Trash2,
  Check,
  X,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ExternalLink,
  Paperclip,
  FolderOpen,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { blobFileUrl } from "@/lib/kyc-types"
import { DEAL_DOC_TYPES } from "@/lib/commodity-deals-store"
import {
  adminAddDealDocument,
  adminSetDealDocumentStatus,
  adminRemoveDealDocument,
  adminAttachDealVessel,
  adminDetachDealVessel,
} from "@/app/actions/approvals"
import type { ApprovalRequest } from "@/lib/approvals-db"
import type { Vessel } from "@/lib/spot-deals-shared"

interface StoredDocVersion {
  version: number
  fileName: string
  reference: string
  issuedBy: string
  issueDate: string
  notes: string
  uploadedAt: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}
interface StoredDoc {
  id: string
  module: "POP" | "POF" | "DEAL"
  docType: string
  status: "submitted" | "verified" | "rejected"
  currentVersion: number
  versions: StoredDocVersion[]
  swiftRef?: string
  decidedAt?: string
  decisionNote?: string
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ComplianceBadge({ vessel }: { vessel: Vessel }) {
  const status = vessel.compliance?.status
  if (status === "flagged") {
    return (
      <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">
        <ShieldAlert className="h-3 w-3" /> Sanctions flag
      </Badge>
    )
  }
  if (status === "unverified") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
        <ShieldQuestion className="h-3 w-3" /> Unverified
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600">
      <ShieldCheck className="h-3 w-3" /> Cleared
    </Badge>
  )
}

function DocStatusBadge({ status }: { status: StoredDoc["status"] }) {
  if (status === "verified") {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Verified</Badge>
  }
  if (status === "rejected") {
    return <Badge variant="destructive">Rejected</Badge>
  }
  return <Badge variant="secondary">Submitted</Badge>
}

/**
 * Administrator dialog to manage a commodity deal's DEAL documents (real PDFs in
 * private Blob) and its assigned vessel (reusing the existing IMO validation +
 * OFAC screening). Everything here edits the owner's source deal record via the
 * admin server actions, so changes surface live and read-only to the deal owner
 * and any shared-deal recipients. No balance/ledger effect.
 */
export function DealDocsVesselDialog({
  req,
  onChanged,
}: {
  req: ApprovalRequest
  onChanged: () => void | Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Vessel form
  const [imo, setImo] = useState("")

  // Add-document form
  const [docType, setDocType] = useState<string>(DEAL_DOC_TYPES[0])
  const [reference, setReference] = useState("")
  const [issuedBy, setIssuedBy] = useState("")
  const [issueDate, setIssueDate] = useState("")
  const [swiftRef, setSwiftRef] = useState("")
  const [notes, setNotes] = useState("")
  const [file, setFile] = useState<File | null>(null)

  const record = (req.payload?.record ?? {}) as Record<string, unknown>
  const vessel = record.vessel as Vessel | undefined
  const dealDocs = useMemo(
    () => (Array.isArray(record.documents) ? (record.documents as StoredDoc[]) : []).filter((d) => d.module === "DEAL"),
    [record.documents],
  )

  const resetDocForm = () => {
    setDocType(DEAL_DOC_TYPES[0])
    setReference("")
    setIssuedBy("")
    setIssueDate("")
    setSwiftRef("")
    setNotes("")
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const attachVessel = async () => {
    const clean = imo.trim()
    if (!/^\d{7}$/.test(clean)) {
      toast.error("Enter a valid 7-digit IMO number.")
      return
    }
    setBusy("vessel")
    const res = await adminAttachDealVessel(ADMIN_PASSCODE, req.id, clean)
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Vessel verified and assigned to the deal.")
    setImo("")
    await onChanged()
  }

  const detachVessel = async () => {
    setBusy("vessel")
    const res = await adminDetachDealVessel(ADMIN_PASSCODE, req.id)
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Vessel removed from the deal.")
    await onChanged()
  }

  const addDocument = async () => {
    if (!docType) {
      toast.error("Choose a document type.")
      return
    }
    if (!file) {
      toast.error("Choose a PDF file to upload.")
      return
    }
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are accepted.")
      return
    }
    setBusy("add-doc")
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
      const result = await upload(`commodity-docs/${req.id}/${Date.now()}-${safe}`, file, {
        access: "public",
        handleUploadUrl: "/api/commodity/blob-upload",
        clientPayload: JSON.stringify({ passcode: ADMIN_PASSCODE }),
      })
      const res = await adminAddDealDocument(ADMIN_PASSCODE, req.id, {
        docType,
        reference,
        issuedBy,
        issueDate,
        notes,
        swiftRef,
        fileName: file.name,
        blobPathname: result.pathname,
        fileSize: file.size,
        contentType: file.type || "application/pdf",
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success("Document uploaded and attached to the deal.")
      resetDocForm()
      await onChanged()
    } catch (err) {
      toast.error((err as Error).message || "The document could not be uploaded.")
    } finally {
      setBusy(null)
    }
  }

  const setDocStatus = async (documentId: string, status: "verified" | "rejected") => {
    setBusy(documentId)
    const res = await adminSetDealDocumentStatus(ADMIN_PASSCODE, req.id, documentId, status)
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(`Document ${status}.`)
    await onChanged()
  }

  const removeDoc = async (documentId: string) => {
    setBusy(documentId)
    const res = await adminRemoveDealDocument(ADMIN_PASSCODE, req.id, documentId)
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Document removed.")
    await onChanged()
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 text-primary"
        onClick={() => setOpen(true)}
        title="Manage the deal's documents (PDFs) and assigned vessel."
      >
        <FolderOpen className="h-3.5 w-3.5" /> Documents &amp; vessel
        {(dealDocs.length > 0 || vessel) && (
          <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
            {dealDocs.length + (vessel ? 1 : 0)}
          </Badge>
        )}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              Documents &amp; vessel
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Attach real PDF documents and assign a verified vessel to{" "}
              <span className="font-medium text-foreground">{req.title}</span>. These appear live and read-only to the
              deal owner and any clients the deal is shared with.
            </DialogDescription>
          </DialogHeader>

          {/* Vessel section */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Ship className="h-4 w-4 text-muted-foreground" /> Vessel
            </h3>
            {vessel ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{vessel.name}</p>
                      <ComplianceBadge vessel={vessel} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      IMO {vessel.imo}
                      {vessel.flag ? ` · ${vessel.flag}` : ""}
                      {vessel.vesselClass ? ` · ${vessel.vesselClass}` : ""}
                    </p>
                    {vessel.compliance?.note ? (
                      <p className="mt-1 text-xs text-muted-foreground">{vessel.compliance.note}</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1 text-destructive"
                    disabled={busy === "vessel"}
                    onClick={detachVessel}
                  >
                    {busy === "vessel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No vessel assigned yet.</p>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[160px]">
                <Label htmlFor="deal-imo" className="text-xs">
                  {vessel ? "Reassign by IMO" : "Assign by IMO"}
                </Label>
                <Input
                  id="deal-imo"
                  value={imo}
                  onChange={(e) => setImo(e.target.value.replace(/\D/g, "").slice(0, 7))}
                  inputMode="numeric"
                  placeholder="7-digit IMO, e.g. 9782522"
                  className="mt-1 text-base md:text-sm"
                />
              </div>
              <Button onClick={attachVessel} disabled={busy === "vessel"} className="h-10 gap-1">
                {busy === "vessel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Verify &amp; assign
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The IMO is validated with the official check-digit algorithm and screened against OFAC sanctions lists
              before it is attached.
            </p>
          </section>

          <div className="h-px w-full bg-border" />

          {/* Documents section */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <FileText className="h-4 w-4 text-muted-foreground" /> Deal documents
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {dealDocs.length}
              </Badge>
            </h3>

            {dealDocs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No documents uploaded yet.</p>
            ) : (
              <ul className="space-y-2">
                {dealDocs.map((doc) => {
                  const v = doc.versions[doc.versions.length - 1]
                  return (
                    <li key={doc.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{doc.docType}</p>
                            <DocStatusBadge status={doc.status} />
                          </div>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {v?.fileName}
                            {v?.fileSize ? ` · ${formatBytes(v.fileSize)}` : ""}
                            {doc.swiftRef ? ` · SWIFT ${doc.swiftRef}` : ""}
                          </p>
                          {v?.reference || v?.issuedBy ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {v?.reference ? `Ref ${v.reference}` : ""}
                              {v?.reference && v?.issuedBy ? " · " : ""}
                              {v?.issuedBy ? `Issued by ${v.issuedBy}` : ""}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {v?.blobPathname ? (
                          <a
                            href={blobFileUrl(v.blobPathname, ADMIN_PASSCODE)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-muted"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> View PDF
                          </a>
                        ) : null}
                        {doc.status !== "verified" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 text-emerald-600"
                            disabled={busy === doc.id}
                            onClick={() => setDocStatus(doc.id, "verified")}
                          >
                            {busy === doc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                            Verify
                          </Button>
                        )}
                        {doc.status !== "rejected" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 text-amber-600"
                            disabled={busy === doc.id}
                            onClick={() => setDocStatus(doc.id, "rejected")}
                          >
                            <X className="h-3.5 w-3.5" /> Reject
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1 text-destructive"
                          disabled={busy === doc.id}
                          onClick={() => removeDoc(doc.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {/* Add document */}
            <div className="rounded-lg border border-dashed border-border p-3">
              <p className="mb-2 text-sm font-medium text-foreground">Add a document</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label className="text-xs">Document type</Label>
                  <Select value={docType} onValueChange={setDocType}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select a document type" />
                    </SelectTrigger>
                    <SelectContent>
                      {DEAL_DOC_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="doc-ref" className="text-xs">
                    Reference / number
                  </Label>
                  <Input
                    id="doc-ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. POP-2026-0042"
                    className="mt-1 text-base md:text-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="doc-issuer" className="text-xs">
                    Issued by
                  </Label>
                  <Input
                    id="doc-issuer"
                    value={issuedBy}
                    onChange={(e) => setIssuedBy(e.target.value)}
                    placeholder="Bank / inspector / authority"
                    className="mt-1 text-base md:text-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="doc-date" className="text-xs">
                    Issue date
                  </Label>
                  <Input
                    id="doc-date"
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className="mt-1 text-base md:text-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="doc-swift" className="text-xs">
                    SWIFT reference (optional)
                  </Label>
                  <Input
                    id="doc-swift"
                    value={swiftRef}
                    onChange={(e) => setSwiftRef(e.target.value)}
                    placeholder="e.g. MT103 / MT799 ref"
                    className="mt-1 text-base md:text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="doc-notes" className="text-xs">
                    Notes (optional)
                  </Label>
                  <Textarea
                    id="doc-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="mt-1 text-base md:text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="doc-file" className="text-xs">
                    PDF file
                  </Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      id="doc-file"
                      ref={fileInputRef}
                      type="file"
                      accept="application/pdf"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="text-base md:text-sm"
                    />
                  </div>
                  {file ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="h-3 w-3" /> {file.name} · {formatBytes(file.size)}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button onClick={addDocument} disabled={busy === "add-doc"} className="gap-1">
                  {busy === "add-doc" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  Upload &amp; attach
                </Button>
              </div>
            </div>
          </section>
        </DialogContent>
      </Dialog>
    </>
  )
}
