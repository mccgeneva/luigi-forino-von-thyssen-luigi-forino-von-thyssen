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
import { DEMO_USER_ID } from "@/lib/users"
import { PdfPreviewModal } from "@/components/pdf-preview-modal"

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

  const preview = useCallback(
    (doc: jsPDF, filename: string, title?: string) => {
      if (isDemo) stampDemoNotice(doc)
      setState({ doc, filename, title })
    },
    [isDemo],
  )

  const show = useCallback(
    (generated: GeneratedPdf) => {
      if (isDemo) stampDemoNotice(generated.doc)
      setState({ doc: generated.doc, filename: generated.filename, title: generated.title })
    },
    [isDemo],
  )

  return (
    <PdfViewerContext.Provider value={{ preview, show }}>
      {children}
      {state && (
        <PdfPreviewModal
          doc={state.doc}
          filename={state.filename}
          title={state.title}
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
