"use client"

import { useState } from "react"
import { Receipt, Download, FileText, ChevronRight, ShieldCheck, History } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useActivityLog } from "@/components/activity-tracker"
import { generateCostCataloguePdf } from "@/lib/cost-catalogue-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { COST_CATALOGUE_META, COST_CATALOGUE_REVISIONS, COST_SECTIONS } from "@/lib/cost-catalogue"

export default function TermsCostsPage() {
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const [preparing, setPreparing] = useState(false)

  const handleDownload = () => {
    if (preparing) return
    setPreparing(true)
    show(generateCostCataloguePdf())
    setPreparing(false)
    logActivity({
      action: "Downloaded the platform Terms & Costs catalogue (PDF)",
      category: "Platform",
      details: {
        summary: "Client downloaded the complete platform fee catalogue as a PDF.",
        document: COST_CATALOGUE_META.title,
        version: COST_CATALOGUE_META.version,
        format: "PDF",
      },
    })
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Receipt className="h-6 w-6 text-primary" />
        </div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">{COST_CATALOGUE_META.title}</h1>
            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[10px]">
              {COST_CATALOGUE_META.version}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">{COST_CATALOGUE_META.subtitle}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Effective {COST_CATALOGUE_META.effectiveDate}</p>
        </div>
      </div>

      {/* Honesty banner */}
      <Card className="border-primary/20 bg-secondary/40">
        <CardContent className="flex items-start gap-3 p-4 sm:p-5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            This schedule reflects the platform&apos;s live fee logic. Every rate shown is the same one applied by the
            system when the corresponding action is taken. Security deposits are refundable guarantees, not fees, and no
            upfront payment is ever a condition for releasing money claimed to be owed to you.
          </p>
        </CardContent>
      </Card>

      {/* Download banner */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Download the Terms &amp; Costs PDF</p>
              <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
                A professionally formatted, certifiable PDF of the full fee catalogue — keep a copy for your records.
              </p>
            </div>
          </div>
          <Button size="lg" className="shrink-0" onClick={handleDownload} disabled={preparing}>
            <Download className="mr-2 h-4 w-4" />
            {preparing ? "Preparing…" : "Download PDF"}
          </Button>
        </CardContent>
      </Card>

      {/* Contents */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold">Contents</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {COST_SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="group flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3 transition-colors hover:bg-secondary/60"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-xs font-bold text-primary">
                {section.number}
              </span>
              <span className="flex-1 text-sm font-medium text-foreground">{section.title}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </a>
          ))}
        </CardContent>
      </Card>

      {/* Sections */}
      <div className="space-y-6">
        {COST_SECTIONS.map((section) => (
          <Card key={section.id} id={section.id} className="scroll-mt-20 border-border bg-card">
            <CardHeader>
              <span className="text-xs font-bold uppercase tracking-wider text-primary">Section {section.number}</span>
              <CardTitle className="text-xl font-bold text-foreground text-balance">{section.title}</CardTitle>
              {section.intro && <p className="text-sm text-muted-foreground text-pretty">{section.intro}</p>}
            </CardHeader>
            <CardContent className="space-y-0">
              {/* Table header (hidden on mobile; cards stack instead) */}
              <div className="hidden grid-cols-[1.3fr_1fr_1.7fr] gap-3 border-b border-border pb-2 sm:grid">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Fee / Charge
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rate / Amount
                </span>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  When it applies
                </span>
              </div>
              {section.rows.map((row) => (
                <div
                  key={row.item}
                  className="grid grid-cols-1 gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[1.3fr_1fr_1.7fr] sm:gap-3"
                >
                  <span className="text-sm font-semibold text-foreground">{row.item}</span>
                  <span className="text-sm font-semibold text-primary">{row.fee}</span>
                  <span className="text-sm text-muted-foreground text-pretty">{row.when}</span>
                </div>
              ))}
              {section.note && (
                <p className="pt-3 text-xs italic text-muted-foreground text-pretty">{section.note}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Revision history */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <History className="h-4 w-4 text-primary" /> Revision History
          </CardTitle>
          <p className="text-sm text-muted-foreground text-pretty">
            Each published version of this catalogue is recorded so historical fee schedules remain available.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {COST_CATALOGUE_REVISIONS.map((rev) => (
            <div key={rev.version} className="rounded-lg border border-border bg-secondary/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{rev.version}</span>
                <span className="text-xs text-muted-foreground">{rev.date}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground text-pretty">{rev.summary}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Footer download */}
      <Card className="border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground text-pretty">Keep a copy of this fee catalogue for your records.</p>
          <Button onClick={handleDownload} disabled={preparing}>
            <Download className="mr-2 h-4 w-4" />
            {preparing ? "Preparing…" : "Download PDF"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
