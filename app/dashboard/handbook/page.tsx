"use client"

import Image from "next/image"
import { BookOpen, Download, FileText, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useActivityLog } from "@/components/activity-tracker"
import { generateHandbookPdf, type HandbookImageMap } from "@/lib/handbook-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { HANDBOOK_META, HANDBOOK_SECTIONS, collectHandbookImagePaths } from "@/lib/handbook-content"
import { useState } from "react"

// Load a /public image into a PNG data URL + intrinsic size for jsPDF, which
// needs pixel data synchronously at render time. Failures are tolerated so the
// PDF still generates (just without that one screenshot).
async function loadImage(path: string): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const res = await fetch(path)
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new window.Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = reject
      img.src = dataUrl
    })
    return { dataUrl, ...dims }
  } catch {
    return null
  }
}

export default function HandbookPage() {
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const [preparing, setPreparing] = useState(false)

  const handleDownload = async () => {
    if (preparing) return
    setPreparing(true)
    // Preload every worked-example screenshot before generating (jsPDF is sync).
    const paths = collectHandbookImagePaths()
    const entries = await Promise.all(
      paths.map(async (p) => {
        const loaded = await loadImage(p)
        return loaded ? ([p, loaded] as const) : null
      }),
    )
    const images: HandbookImageMap = {}
    for (const entry of entries) {
      if (entry) images[entry[0]] = entry[1]
    }
    show(generateHandbookPdf(images))
    setPreparing(false)
    logActivity({
      action: "Downloaded the MCC Capital Client Handbook (PDF)",
      category: "Platform",
      details: {
        summary: "Client downloaded the full MCC Capital Client Handbook as a PDF.",
        document: HANDBOOK_META.title,
        version: HANDBOOK_META.version,
        format: "PDF",
      },
    })
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-6 w-6 text-primary" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">{HANDBOOK_META.title}</h1>
              <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                {HANDBOOK_META.version}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              {HANDBOOK_META.subtitle}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{HANDBOOK_META.lastUpdated}</p>
          </div>
        </div>
      </div>

      {/* Download banner */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Download the full handbook</p>
              <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
                A professionally formatted PDF covering every feature of your platform — ideal for
                offline reference and onboarding your team.
              </p>
            </div>
          </div>
          <Button size="lg" className="shrink-0" onClick={handleDownload} disabled={preparing}>
            <Download className="mr-2 h-4 w-4" />
            {preparing ? "Preparing…" : "Download PDF"}
          </Button>
        </CardContent>
      </Card>

      {/* Table of contents */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold">Contents</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {HANDBOOK_SECTIONS.map((section) => (
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
        {HANDBOOK_SECTIONS.map((section) => (
          <Card key={section.id} id={section.id} className="bg-card border-border scroll-mt-20">
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-primary">
                  Section {section.number}
                </span>
              </div>
              <CardTitle className="text-xl font-bold text-foreground text-balance">
                {section.title}
              </CardTitle>
              {section.intro && (
                <p className="text-sm text-muted-foreground text-pretty">{section.intro}</p>
              )}
            </CardHeader>
            <CardContent className="space-y-5">
              {section.subsections.map((sub) => (
                <div key={sub.heading}>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                    <span className="h-3 w-0.5 rounded-full bg-primary" aria-hidden />
                    {sub.heading}
                  </h3>
                  {sub.paragraphs?.map((p, i) => (
                    <p key={i} className="mb-2 text-sm leading-relaxed text-muted-foreground text-pretty">
                      {p}
                    </p>
                  ))}
                  {sub.bullets && (
                    <ul className="mt-2 space-y-1.5">
                      {sub.bullets.map((b, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                          <span className="text-pretty">{b}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {sub.examples?.map((ex, ei) => (
                    <div
                      key={ei}
                      className="mt-4 overflow-hidden rounded-xl border border-border bg-secondary/30"
                    >
                      <div className="flex items-center gap-2 border-b border-border bg-secondary/50 px-4 py-2.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/15 text-[10px] font-bold text-primary">
                          EX
                        </span>
                        <span className="text-xs font-semibold text-foreground">{ex.title}</span>
                      </div>
                      <figure className="border-b border-border bg-background/50">
                        <Image
                          src={ex.image || "/placeholder.svg"}
                          alt={ex.caption}
                          width={1280}
                          height={900}
                          className="h-auto w-full"
                          sizes="(max-width: 768px) 100vw, 768px"
                        />
                        <figcaption className="px-4 py-2 text-[11px] italic text-muted-foreground text-pretty">
                          {ex.caption}
                        </figcaption>
                      </figure>
                      <ol className="space-y-2 p-4">
                        {ex.steps.map((step, si) => (
                          <li key={si} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                              {si + 1}
                            </span>
                            <span className="text-pretty leading-relaxed">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Footer download */}
      <Card className="bg-card border-border">
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground text-pretty">
            Keep a copy of this handbook for your records.
          </p>
          <Button onClick={handleDownload} disabled={preparing}>
            <Download className="mr-2 h-4 w-4" />
            {preparing ? "Preparing…" : "Download PDF"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
