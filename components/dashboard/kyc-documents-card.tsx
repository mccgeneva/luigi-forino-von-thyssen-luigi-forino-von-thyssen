"use client"

import { useState } from "react"
import { createPortal } from "react-dom"
import { FileText, ExternalLink, ArrowLeft, Download, X } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { KYC_DOCUMENT_LABELS, blobFileUrl, type KycDocument } from "@/lib/kyc-types"
import { downloadFile } from "@/lib/download-file"

/**
 * KYC documents list with an IN-APP viewer.
 *
 * Previously each document was a plain `<a target="_blank">` to the raw Blob
 * URL. Inside the installed PWA / in-app webview there is no browser chrome, so
 * tapping a document navigated the single webview to the file and the user had
 * no way back to the platform. We now open documents in a full-screen overlay
 * with an explicit "Back" control (and an "Open in browser" fallback for the
 * rare case the inline preview can't render), so the user is never trapped.
 */
export function KycDocumentsCard({ documents }: { documents: KycDocument[] }) {
  const [active, setActive] = useState<KycDocument | null>(null)

  if (!documents || documents.length === 0) return null

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">KYC Documents</CardTitle>
          <CardDescription>Identity and compliance documents on file</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {documents.map((doc) => (
              <button
                key={`${doc.type}-${doc.pageNumber}`}
                type="button"
                onClick={() => setActive(doc)}
                className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 p-3 text-left transition-colors hover:border-primary"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {KYC_DOCUMENT_LABELS[doc.type]}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {doc.label} · Page {doc.pageNumber}
                    </p>
                  </div>
                </div>
                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {active && <DocumentViewer doc={active} onClose={() => setActive(null)} />}
    </>
  )
}

function DocumentViewer({ doc, onClose }: { doc: KycDocument; onClose: () => void }) {
  const url = `${blobFileUrl(doc.pathname)}#page=${doc.pageNumber}`

  if (typeof document === "undefined") return null

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true">
      {/* Toolbar with an unmissable way back to the platform */}
      <div
        className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <Button variant="ghost" size="sm" onClick={onClose} className="gap-1.5 min-h-11">
          <ArrowLeft className="h-5 w-5" />
          Back
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium text-foreground">{KYC_DOCUMENT_LABELS[doc.type]}</p>
          <p className="truncate text-xs text-muted-foreground">
            {doc.label} · Page {doc.pageNumber}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            title="Download"
            onClick={() => void downloadFile(blobFileUrl(doc.pathname), doc.label || KYC_DOCUMENT_LABELS[doc.type])}
          >
            <Download className="h-5 w-5" />
            <span className="sr-only">Download</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} className="min-h-11 min-w-11" title="Close">
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </div>

      {/* Document preview */}
      <div className="min-h-0 flex-1 bg-secondary/30">
        <iframe src={url} title={`${KYC_DOCUMENT_LABELS[doc.type]} — ${doc.label}`} className="h-full w-full" />
      </div>
    </div>,
    document.body,
  )
}
