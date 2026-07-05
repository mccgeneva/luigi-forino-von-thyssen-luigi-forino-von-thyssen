"use client"

// App-wide PDF preview context. Mount <PdfViewerProvider> once (in the
// dashboard layout) and any client component can call usePdfViewer().preview()
// to open a generated jsPDF document in the shared in-app viewer, which offers
// Download / Print / Open-in-tab. This gives every export a consistent
// "preview in browser, then download" experience.

import { createContext, useCallback, useContext, useEffect, useState } from "react"
import type { jsPDF } from "jspdf"
import { type GeneratedPdf, stampDemoNotice } from "@/lib/pdf-core"
import { warmPdfLogos } from "@/lib/pdf-logos"
import { useCurrentUser } from "@/lib/use-current-user"
import { DEMO_USER_ID, UNKNOWN_USER_ID } from "@/lib/users"
import { PdfPreviewModal } from "@/components/pdf-preview-modal"
import { newDocumentId, encodeTraceToken, embedTraceToken } from "@/lib/pdf-trace"
import { recordDocumentTrace } from "@/app/actions/pdf-trace"

interface PdfViewerState {
  doc: jsPDF
  filename: string
  title?: string
}

interface PdfViewerContextValue {
  /** Open the in-app preview for a generated PDF document. */
  preview: (doc: jsPDF, filename: string, title?: string) => void
  /** Convenience: preview the result of a PDF generator directly. */
  show: (generated: GeneratedPdf) => void
}

const PdfViewerContext = createContext<PdfViewerContextValue | null>(null)

/**
 * Infer a coarse document "kind" from its filename so the audit row groups
 * documents sensibly (statement / receipt / instrument / …) without every
 * generator having to declare it. Falls back to "document".
 */
function inferKind(filename: string, title?: string): string {
  const hay = `${filename} ${title ?? ""}`.toLowerCase()
  const map: Array<[RegExp, string]> = [
    [/statement/, "statement"],
    [/receipt|confirmation/, "receipt"],
    [/certificate/, "certificate"],
    [/instrument|sblc|bg\b|guarantee|lc\b/, "instrument"],
    [/handbook|guide/, "handbook"],
    [/invoice/, "invoice"],
    [/swift|mt\d{3}|uetr/, "swift"],
    [/report/, "report"],
  ]
  for (const [re, kind] of map) if (re.test(hay)) return kind
  return "document"
}

export function PdfViewerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PdfViewerState | null>(null)
  // The demo/showcase account must have every exported or downloaded document
  // stamped with a demo-only disclaimer. Doing it here — the single chokepoint
  // every generator funnels through — guarantees coverage (preview, print,
  // download, open-in-tab) without touching each individual generator.
  const user = useCurrentUser()
  const isDemo = user.id === DEMO_USER_ID

  // Preload the brand logos once so every generator can stamp the correct mark
  // synchronously. Cache is idempotent; failures fall back to the gold badge.
  useEffect(() => {
    void warmPdfLogos()
  }, [])

  // Stamp every generated document with a traceability token and write the
  // authoritative server audit row. Done HERE — the single chokepoint every
  // generator funnels through — so preview, print, download and open-in-tab are
  // all covered without touching each generator. The token is embedded
  // synchronously (so the file always carries its id, even offline); the server
  // record is fire-and-forget so the preview opens instantly.
  const traceDocument = useCallback(
    (doc: jsPDF, filename: string, title?: string) => {
      // Never attribute a document to the neutral placeholder identity.
      if (user.id === UNKNOWN_USER_ID) return
      try {
        const docId = newDocumentId()
        const kind = inferKind(filename, title)
        const account = user.fullName || user.company || user.email || user.id
        const token = encodeTraceToken({
          v: 1,
          docId,
          uid: user.id,
          account,
          kind,
          ts: Date.now(),
        })
        embedTraceToken(doc, token, docId)
        // Fire-and-forget: the server resolves the true identity + IP from the
        // request itself, so a spoofed client payload can't corrupt the record.
        void recordDocumentTrace({ docId, kind, title, filename, isDemo }).catch(() => {})
      } catch {
        // Tracing must never block a document from being shown.
      }
    },
    [user.id, user.fullName, user.company, user.email, isDemo],
  )

  const preview = useCallback(
    (doc: jsPDF, filename: string, title?: string) => {
      if (isDemo) stampDemoNotice(doc)
      traceDocument(doc, filename, title)
      setState({ doc, filename, title })
    },
    [isDemo, traceDocument],
  )

  const show = useCallback(
    (generated: GeneratedPdf) => {
      if (isDemo) stampDemoNotice(generated.doc)
      traceDocument(generated.doc, generated.filename, generated.title)
      setState({ doc: generated.doc, filename: generated.filename, title: generated.title })
    },
    [isDemo, traceDocument],
  )

  return (
    <PdfViewerContext.Provider value={{ preview, show }}>
      {children}
      {state && (
        <PdfPreviewModal
          doc={state.doc}
          filename={state.filename}
          title={state.title}
          // The public demo account (demo@mccgva.ch) is routinely abused by
          // scammers who try to lift real-looking documents (SWIFT confirmations,
          // instruments, statements) for fraud. In addition to the red DEMO
          // stamp, we DISABLE every export path (download, print, open-in-tab,
          // and the extractable inline PDF viewer) so no usable file can leave
          // the demo. Enforced here at the single chokepoint all exports use.
          exportDisabled={isDemo}
          onClose={() => setState(null)}
        />
      )}
    </PdfViewerContext.Provider>
  )
}

export function usePdfViewer(): PdfViewerContextValue {
  const ctx = useContext(PdfViewerContext)
  if (!ctx) {
    throw new Error("usePdfViewer must be used within a <PdfViewerProvider>")
  }
  return ctx
}
