"use client"

// ---------------------------------------------------------------------------
// Admin · KYC document manager
//
// Reusable panel to view / upload / delete KYC documents for a single client
// account (used both inside the Security Audit report and from the admin user
// list). Files upload straight from the browser to Blob via the passcode-gated
// token route /api/kyc/blob-upload (keeps large images off the serverless
// function's ~4.5MB body limit); a Neon audit row is then recorded through
// /api/admin/audit/documents (Route Handler — Server Actions are rejected on
// this app's production domains).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { upload } from "@vercel/blob/client"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, Upload, Trash2, FileText, ImageIcon, ExternalLink, RefreshCw } from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  type UploadedKycDocument,
  type UploadedKycDocType,
  UPLOADED_KYC_DOC_LABELS,
  UPLOADED_KYC_DOC_ORDER,
  blobFileUrl,
} from "@/lib/kyc-types"

function fmtSize(bytes: number): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9.\-_]+/gi, "-").replace(/-+/g, "-").slice(-80) || "document"
}

export function KycDocumentManager({ userId, account }: { userId: string; account: string }) {
  const [documents, setDocuments] = useState<UploadedKycDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [docType, setDocType] = useState<UploadedKycDocType>("passport_id")
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState("")
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch(
        `/api/admin/audit/documents?p=${encodeURIComponent(ADMIN_PASSCODE)}&userId=${encodeURIComponent(userId)}`,
        { cache: "no-store", headers: { "x-admin-passcode": ADMIN_PASSCODE } },
      )
      const json = (await res.json().catch(() => null)) as { ok: boolean; documents?: UploadedKycDocument[]; error?: string } | null
      if (res.ok && json?.ok) setDocuments(json.documents || [])
      else setError(json?.error || "Could not load documents.")
    } catch {
      setError("Could not load documents.")
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return
    setUploading(true)
    setError("")
    const list = Array.from(files)
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i]
        setProgress(`Uploading ${i + 1} of ${list.length}: ${file.name}`)
        const pathname = `kyc/${userId}/${Date.now()}-${sanitize(file.name)}`
        const blob = await upload(pathname, file, {
          access: "public",
          handleUploadUrl: "/api/kyc/blob-upload",
          clientPayload: JSON.stringify({ passcode: ADMIN_PASSCODE }),
        })
        const res = await fetch(`/api/admin/audit/documents?p=${encodeURIComponent(ADMIN_PASSCODE)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
          body: JSON.stringify({
            userId,
            type: docType,
            filename: file.name,
            contentType: file.type || blob.contentType || "",
            sizeBytes: file.size,
            pathname: blob.pathname,
          }),
        })
        const json = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null
        if (!res.ok || !json?.ok) throw new Error(json?.error || "Could not save the document.")
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.")
    } finally {
      setUploading(false)
      setProgress("")
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const onDelete = async (doc: UploadedKycDocument) => {
    if (deletingId) return
    if (!window.confirm(`Delete "${doc.label} — ${doc.filename}" for ${account}? This removes the file permanently.`)) return
    setDeletingId(doc.id)
    try {
      const res = await fetch(
        `/api/admin/audit/documents?p=${encodeURIComponent(ADMIN_PASSCODE)}&id=${encodeURIComponent(doc.id)}`,
        { method: "DELETE", headers: { "x-admin-passcode": ADMIN_PASSCODE } },
      )
      const json = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null
      if (res.ok && json?.ok) setDocuments((prev) => prev.filter((d) => d.id !== doc.id))
      else window.alert(json?.error || "Could not delete the document.")
    } catch {
      window.alert("Could not delete the document.")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Uploader */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/40 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Document type</label>
            <Select value={docType} onValueChange={(v) => setDocType(v as UploadedKycDocType)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPLOADED_KYC_DOC_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {UPLOADED_KYC_DOC_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="h-11" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            <span className="ml-2">Upload files</span>
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>
        <p className="text-xs text-muted-foreground text-pretty">
          Pick a category, then choose one or more files (JPG, PNG or PDF, up to 25&nbsp;MB each). Images appear in the
          downloadable dossier; every upload is recorded with who uploaded it and when.
        </p>
        {progress ? <p className="text-xs text-foreground">{progress}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {/* Document list */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {documents.length} document{documents.length === 1 ? "" : "s"} on file
        </span>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          <span className="ml-1.5 text-xs">Refresh</span>
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : documents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          No KYC documents uploaded yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((doc) => {
            const url = blobFileUrl(doc.pathname, ADMIN_PASSCODE)
            return (
              <li
                key={doc.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-2.5"
              >
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-secondary"
                  title="Open document"
                >
                  {doc.isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url || "/placeholder.svg"} alt={doc.label} className="h-full w-full object-cover" />
                  ) : (
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {doc.isImage ? (
                      <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate text-sm font-medium text-foreground">{doc.label}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{doc.filename}</p>
                  <p className="text-[11px] text-muted-foreground/80">
                    {fmtSize(doc.sizeBytes)} · {doc.uploadedBy} · {fmtWhen(doc.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                    title="Open document"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => void onDelete(doc)}
                    disabled={deletingId === doc.id}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    title="Delete document"
                  >
                    {deletingId === doc.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
