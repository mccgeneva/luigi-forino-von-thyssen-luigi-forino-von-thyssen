"use client"

// In-app PDF preview. Renders a jsPDF document into a blob and shows it in an
// embedded viewer with Download, Print, and Open-in-new-tab actions. Used by
// every export across the dashboard so previews look and behave identically.

import { useEffect, useMemo, useState } from "react"
import type { jsPDF } from "jspdf"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Download, Printer, ExternalLink, FileText, Loader2, X, Lock, Pencil } from "lucide-react"

// Turn a user-typed name into a safe download filename ending in `.pdf`.
// Falls back to a sensible default so a file is never saved as "Unknown".
function toPdfFilename(name: string): string {
  const base = name
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80)
  return `${base || "document"}.pdf`
}

export interface PdfPreviewProps {
  doc: jsPDF
  filename: string
  title?: string
  /** When true (demo account), all export paths are blocked to prevent the
   *  document from being lifted for fraudulent use. */
  exportDisabled?: boolean
  onClose: () => void
}

export function PdfPreviewModal({ doc, filename, title, exportDisabled = false, onClose }: PdfPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  // Editable name (without the .pdf extension) so the user can set what the file
  // is called BEFORE downloading — otherwise some browsers save it as "Unknown".
  const [nameInput, setNameInput] = useState(() => filename.replace(/\.pdf$/i, ""))
  const [editingName, setEditingName] = useState(false)

  // Reset the editable name whenever a different document is opened.
  useEffect(() => {
    setNameInput(filename.replace(/\.pdf$/i, ""))
    setEditingName(false)
  }, [filename])

  const downloadName = toPdfFilename(nameInput)

  // Build the blob once per document. Revoke it on unmount so we never leak
  // object URLs as the user previews many documents in a session.
  // SECURITY: when exports are disabled (demo account) we NEVER create an object
  // URL — the raw PDF must never reach the DOM (iframe src) or a user-reachable
  // action, otherwise the browser's own PDF viewer toolbar / "open in tab" would
  // let a scammer extract a usable file despite the disabled buttons.
  useEffect(() => {
    if (exportDisabled) {
      setBlobUrl(null)
      return
    }
    let url: string | null = null
    try {
      const blob = doc.output("blob")
      url = URL.createObjectURL(blob)
      setBlobUrl(url)
    } catch {
      setBlobUrl(null)
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [doc, exportDisabled])

  const isMobile = useMemo(
    () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
    [],
  )

  const handleDownload = () => {
    if (exportDisabled) return
    // IMPORTANT: do NOT use jsPDF's doc.save() here. On browsers where the
    // anchor `download` attribute is unsupported (notably iOS Safari), jsPDF
    // falls back to navigating the CURRENT window to the blob URL. That unloads
    // the SPA and dumps the user back on the dashboard overview when they
    // return — they lose the NQAi console. Instead we drive the download from
    // our own blob URL and never touch the top-level location.
    if (!blobUrl) return
    if (isMobile) {
      // Mobile browsers can't force a file download reliably; open the PDF in a
      // NEW tab so the console tab (and its state) stays exactly as it was.
      window.open(blobUrl, "_blank", "noopener,noreferrer")
      return
    }
    const link = document.createElement("a")
    link.href = blobUrl
    link.download = downloadName
    link.rel = "noopener"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handlePrint = () => {
    if (exportDisabled || !blobUrl) return
    // Print via a hidden iframe so the dialog stays intact.
    const frame = document.createElement("iframe")
    frame.style.position = "fixed"
    frame.style.right = "0"
    frame.style.bottom = "0"
    frame.style.width = "0"
    frame.style.height = "0"
    frame.style.border = "0"
    frame.src = blobUrl
    frame.onload = () => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        window.open(blobUrl, "_blank")
      }
      setTimeout(() => document.body.removeChild(frame), 60_000)
    }
    document.body.appendChild(frame)
  }

  const handleOpenTab = () => {
    if (exportDisabled) return
    if (blobUrl) window.open(blobUrl, "_blank")
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        showCloseButton
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <FileText className="h-4.5 w-4.5 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-semibold sm:text-base">
                {title || "Document preview"}
              </DialogTitle>
              {exportDisabled ? (
                <p className="truncate text-xs text-muted-foreground">{downloadName}</p>
              ) : editingName ? (
                <div className="mt-0.5 flex items-center gap-1">
                  <Input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return
                      if (e.key === "Enter") setEditingName(false)
                      if (e.key === "Escape") {
                        setNameInput(filename.replace(/\.pdf$/i, ""))
                        setEditingName(false)
                      }
                    }}
                    onBlur={() => setEditingName(false)}
                    aria-label="File name"
                    placeholder="File name"
                    className="h-7 text-xs"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">.pdf</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  className="group mt-0.5 flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Rename file before downloading"
                >
                  <span className="truncate">{downloadName}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" aria-hidden />
                  <span className="sr-only">Rename file before downloading</span>
                </button>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Viewer */}
        <div className="relative flex-1 overflow-hidden bg-muted/40">
          {exportDisabled ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
                <Lock className="h-7 w-7 text-destructive" aria-hidden />
              </div>
              <div className="max-w-md space-y-2">
                <p className="text-balance text-sm font-semibold sm:text-base">
                  Document export is disabled on the demo account
                </p>
                <p className="text-pretty text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  For security, documents generated on the public demo (demo@mccgva.ch) cannot be previewed,
                  downloaded, printed, or opened. This prevents the demo from being used to produce documents for
                  fraudulent purposes. Sign in with a full client account to export documents.
                </p>
              </div>
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              title={title || "PDF preview"}
              className="h-full w-full"
              // On iOS/Android the inline PDF viewer is unreliable; we surface a
              // friendly fallback below, but still attempt to embed first.
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
              <span className="sr-only">Preparing preview…</span>
            </div>
          )}
          {isMobile && blobUrl && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
              <button
                type="button"
                onClick={handleOpenTab}
                className="pointer-events-auto rounded-full bg-foreground/90 px-4 py-2 text-xs font-medium text-background shadow-lg"
              >
                Preview not showing? Tap to open
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={onClose} className="min-h-11 shrink-0">
            <X className="mr-1.5 h-4 w-4" aria-hidden />
            Close
          </Button>
          {exportDisabled ? (
            <p className="flex items-center gap-1.5 text-right text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="text-pretty">Exports disabled on the demo account</span>
            </p>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenTab}
                disabled={!blobUrl}
                className="min-h-11"
              >
                <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Open in tab</span>
                <span className="sm:hidden">Open</span>
              </Button>
              <Button variant="outline" size="sm" onClick={handlePrint} disabled={!blobUrl} className="min-h-11">
                <Printer className="mr-1.5 h-4 w-4" aria-hidden />
                Print
              </Button>
              <Button size="sm" onClick={handleDownload} disabled={!blobUrl} className="min-h-11">
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                Download
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
