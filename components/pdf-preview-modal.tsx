"use client"

// In-app PDF preview. Renders a jsPDF document into a blob and shows it in an
// embedded viewer with Download, Print, and Open-in-new-tab actions. Used by
// every export across the dashboard so previews look and behave identically.

import { useEffect, useMemo, useState } from "react"
import type { jsPDF } from "jspdf"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Download, Printer, ExternalLink, FileText, Loader2, X } from "lucide-react"

export interface PdfPreviewProps {
  doc: jsPDF
  filename: string
  title?: string
  onClose: () => void
}

export function PdfPreviewModal({ doc, filename, title, onClose }: PdfPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  // Build the blob once per document. Revoke it on unmount so we never leak
  // object URLs as the user previews many documents in a session.
  useEffect(() => {
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
  }, [doc])

  const isMobile = useMemo(
    () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
    [],
  )

  const handleDownload = () => {
    doc.save(filename)
  }

  const handlePrint = () => {
    if (!blobUrl) return
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
              <p className="truncate text-xs text-muted-foreground">{filename}</p>
            </div>
          </div>
        </DialogHeader>

        {/* Viewer */}
        <div className="relative flex-1 overflow-hidden bg-muted/40">
          {blobUrl ? (
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
            <Button size="sm" onClick={handleDownload} className="min-h-11">
              <Download className="mr-1.5 h-4 w-4" aria-hidden />
              Download
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
