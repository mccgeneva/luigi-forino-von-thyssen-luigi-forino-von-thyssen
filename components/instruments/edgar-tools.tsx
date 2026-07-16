"use client"

import { useCallback, useMemo, useState } from "react"
import {
  Search,
  Loader2,
  FileText,
  ExternalLink,
  Building2,
  Landmark,
  BadgeCheck,
  ScrollText,
  Copy,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { ActivityLog } from "@/lib/activity-email"

/** Normalised filing returned by /api/edgar (company mode). */
interface EdgarFiling {
  form: string
  filingDate: string
  reportDate?: string
  accessionNumber: string
  primaryDocument: string
  primaryDocDescription?: string
  documentUrl: string
  filingIndexUrl: string
  isProspectus: boolean
  size?: number
}

interface EdgarCompany {
  cik: string
  name: string
  tickers: string[]
  exchanges: string[]
  sic?: string
  sicDescription?: string
  entityType?: string
}

/** Full-text search hit returned by /api/edgar (fulltext mode). */
interface EdgarHit {
  form: string
  filingDate: string
  accessionNumber: string
  cik: string
  displayName: string
  documentUrl: string
  filingIndexUrl: string
  isProspectus: boolean
}

interface EdgarResult {
  mode: "company" | "fulltext"
  query: string
  company?: EdgarCompany
  filings?: EdgarFiling[]
  hits?: EdgarHit[]
  note?: string
}

type LogFn = (entry: ActivityLog) => void

interface EdgarToolsProps {
  title?: string
  description?: string
  onLog?: LogFn
  logCategory?: string
  className?: string
}

/** Friendly labels for the common SEC form types clients will recognise. */
const FORM_LABELS: Record<string, string> = {
  "424B1": "Prospectus (424B1)",
  "424B2": "Prospectus (424B2)",
  "424B3": "Prospectus (424B3)",
  "424B4": "Prospectus (424B4)",
  "424B5": "Prospectus (424B5)",
  "S-1": "Registration statement (S-1)",
  "S-3": "Registration statement (S-3)",
  "F-1": "Foreign registration (F-1)",
  "F-3": "Foreign registration (F-3)",
  FWP: "Free writing prospectus",
  "10-K": "Annual report (10-K)",
  "10-Q": "Quarterly report (10-Q)",
  "8-K": "Current report (8-K)",
  "20-F": "Annual report (20-F)",
  "6-K": "Foreign report (6-K)",
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * SEC EDGAR toolkit for the Bank Instruments workflow. A single smart input
 * pulls an issuer's public profile, prospectuses and filing documents straight
 * from the SEC's official systems (data.sec.gov + EDGAR full-text search) via
 * the server-only /api/edgar proxy. Only public reference data is read, so
 * per-user data isolation is unaffected.
 */
export function EdgarTools({
  title = "SEC / EDGAR filings",
  description = "Pull an issuer's public prospectuses, registration statements and filings directly from SEC.gov and EDGAR.",
  onLog,
  logCategory = "Bank Instruments",
  className,
}: EdgarToolsProps) {
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EdgarResult | null>(null)
  const [onlyProspectus, setOnlyProspectus] = useState(false)

  const run = useCallback(
    async (fullText = false) => {
      const q = value.trim()
      if (!q) return
      setLoading(true)
      setError(null)
      setResult(null)
      try {
        const res = await fetch("/api/edgar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, fullText }),
        })
        const data = await res.json()
        if (!data.ok) {
          setError(data.error ?? "Lookup failed.")
          return
        }
        const resolved: EdgarResult = {
          mode: data.mode,
          query: q,
          company: data.company,
          filings: data.filings,
          hits: data.hits,
          note: data.note,
        }
        setResult(resolved)
        const count =
          resolved.mode === "company" ? resolved.filings?.length ?? 0 : resolved.hits?.length ?? 0
        onLog?.({
          action: `Pulled SEC EDGAR filings for "${q}"`,
          category: logCategory,
          details: {
            summary:
              resolved.mode === "company"
                ? `Retrieved the SEC EDGAR profile for ${resolved.company?.name ?? q} (CIK ${resolved.company?.cik ?? "—"}) with ${count} recent filing(s), including prospectuses and registration statements pulled from SEC.gov.`
                : `EDGAR full-text search for "${q}" returned ${count} matching document(s) from SEC.gov.`,
            query: q,
            mode: resolved.mode,
            cik: resolved.company?.cik,
            resultCount: count,
          },
        })
      } catch {
        setError("Network error. Please try again.")
      } finally {
        setLoading(false)
      }
    },
    [value, onLog, logCategory],
  )

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text)
    toast.success(`${label} copied`, { description: text })
  }

  const visibleFilings = useMemo(() => {
    const filings = result?.filings ?? []
    return onlyProspectus ? filings.filter((f) => f.isProspectus) : filings
  }, [result, onlyProspectus])

  const visibleHits = useMemo(() => {
    const hits = result?.hits ?? []
    return onlyProspectus ? hits.filter((h) => h.isProspectus) : hits
  }, [result, onlyProspectus])

  const prospectusCount =
    (result?.filings?.filter((f) => f.isProspectus).length ?? 0) +
    (result?.hits?.filter((h) => h.isProspectus).length ?? 0)

  return (
    <Card className={cn("border-border bg-card", className)}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ScrollText className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground text-pretty">{description}</p>
          </div>
        </div>

        {/* Smart input — issuer name / ticker */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) run(false)
              }}
              placeholder="Issuer name or ticker (e.g. JPMorgan Chase, HSBC, AAPL)"
              className="pl-9"
              aria-label="SEC EDGAR issuer or ticker search"
              spellCheck={false}
            />
          </div>
          <Button onClick={() => run(false)} disabled={loading || !value.trim()} className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Pull filings
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Data sourced live from{" "}
          <span className="font-medium text-foreground">SEC.gov</span> and{" "}
          <span className="font-medium text-foreground">EDGAR</span>. Public reference data only.
        </p>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {result ? (
          <div className="space-y-3">
            {result.note ? (
              <p className="rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground text-pretty">
                {result.note}
              </p>
            ) : null}

            {/* Company profile header (company mode) */}
            {result.mode === "company" && result.company ? (
              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">{result.company.name}</span>
                  {result.company.tickers.filter(Boolean).map((t) => (
                    <Badge key={t} className="border-primary/30 bg-primary/10 font-mono text-primary">
                      {t}
                    </Badge>
                  ))}
                  <button
                    type="button"
                    onClick={() => copy(result.company!.cik, "CIK")}
                    className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Copy CIK"
                  >
                    CIK {result.company.cik}
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  <Detail label="Entity type" value={result.company.entityType} />
                  <Detail label="Industry (SIC)" value={result.company.sicDescription} />
                  <Detail label="Exchanges" value={result.company.exchanges.join(", ") || undefined} />
                  <Detail label="Recent filings" value={String(result.filings?.length ?? 0)} />
                </div>
                <a
                  href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${result.company.cik}&type=&dateb=&owner=include&count=40`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open full EDGAR profile on SEC.gov
                </a>
              </div>
            ) : null}

            {/* Prospectus filter toggle */}
            {prospectusCount > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOnlyProspectus((v) => !v)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    onlyProspectus
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={onlyProspectus}
                >
                  <BadgeCheck className="h-3.5 w-3.5" />
                  Prospectus &amp; offering docs ({prospectusCount})
                </button>
                {onlyProspectus ? (
                  <span className="text-[11px] text-muted-foreground">Showing offering documents only</span>
                ) : null}
              </div>
            ) : null}

            {/* Company filings list */}
            {result.mode === "company" ? (
              visibleFilings.length ? (
                <ul className="space-y-2">
                  {visibleFilings.map((f) => (
                    <FilingRow
                      key={f.accessionNumber + f.primaryDocument}
                      form={f.form}
                      formLabel={FORM_LABELS[f.form.toUpperCase()] ?? f.form}
                      filingDate={f.filingDate}
                      description={f.primaryDocDescription}
                      sizeLabel={formatBytes(f.size)}
                      documentUrl={f.documentUrl}
                      filingIndexUrl={f.filingIndexUrl}
                      isProspectus={f.isProspectus}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {onlyProspectus
                    ? "No prospectus or offering documents in the recent filings."
                    : "No recent filings found for this issuer."}
                </p>
              )
            ) : visibleHits.length ? (
              <ul className="space-y-2">
                {visibleHits.map((h) => (
                  <FilingRow
                    key={h.accessionNumber + h.cik}
                    form={h.form}
                    formLabel={FORM_LABELS[h.form.toUpperCase()] ?? h.form}
                    filingDate={h.filingDate}
                    description={h.displayName}
                    documentUrl={h.documentUrl}
                    filingIndexUrl={h.filingIndexUrl}
                    isProspectus={h.isProspectus}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No matching documents found on EDGAR.</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function FilingRow({
  form,
  formLabel,
  filingDate,
  description,
  sizeLabel,
  documentUrl,
  filingIndexUrl,
  isProspectus,
}: {
  form: string
  formLabel: string
  filingDate: string
  description?: string
  sizeLabel?: string
  documentUrl: string
  filingIndexUrl: string
  isProspectus: boolean
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          isProspectus ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {isProspectus ? <ScrollText className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{formLabel}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {form || "—"}
          </Badge>
          {isProspectus ? (
            <Badge className="border-primary/30 bg-primary/10 text-[10px] text-primary">Prospectus</Badge>
          ) : null}
        </div>
        {description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={description}>
            {description}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {filingDate ? (
            <span className="flex items-center gap-1">
              <Landmark className="h-3 w-3" />
              Filed {filingDate}
            </span>
          ) : null}
          {sizeLabel ? <span>{sizeLabel}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <a
          href={documentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Document
        </a>
        <a
          href={filingIndexUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Filing index
        </a>
      </div>
    </li>
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-foreground">{value || "—"}</p>
    </div>
  )
}
