"use client"

// ---------------------------------------------------------------------------
// Admin · Document Traceability
//
// Investigate where a leaked/forwarded MCC document originated. Three ways in:
//   1. Paste the embedded token (MCCX1:…) or a bare document id (MCC-DOC-…).
//   2. Paste raw extracted text from a suspect PDF — the token is recovered from
//      anywhere inside it.
//   3. Browse recent generations and filter by account id.
//
// The authoritative answer is the server audit row (who, which account, the
// server-captured IP, the timestamp, the biometric fingerprint on file, and the
// document type). The in-file token is only the pointer back to that row.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Fingerprint,
  Search,
  ShieldAlert,
  User,
  Globe,
  Clock,
  FileText,
  Loader2,
  Info,
  RefreshCw,
  Upload,
  MapPin,
  ExternalLink,
  Building2,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { adminExtractTrace, adminListTraces, type TraceLookupResult } from "@/app/actions/pdf-trace"
import type { IpGeo } from "@/lib/ip-geo"
import { extractTraceToken } from "@/lib/pdf-trace"
import type { DocumentTrace } from "@/lib/pdf-trace-db"

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Field({ icon: Icon, label, value, mono }: { icon: typeof User; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 rounded-md bg-secondary p-1.5">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-sm text-foreground break-words ${mono ? "font-mono" : "font-medium"}`}>{value}</p>
      </div>
    </div>
  )
}

function GeoPanel({ geo }: { geo: IpGeo }) {
  const place = [geo.city, geo.region, geo.country].filter(Boolean).join(", ")
  const hasCoords = typeof geo.latitude === "number" && typeof geo.longitude === "number"
  return (
    <div className="rounded-lg border border-border bg-secondary/40 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <MapPin className="h-4 w-4 text-primary" />
        Origin location (IP geolocation)
      </p>

      {geo.isPrivate ? (
        <p className="text-sm text-muted-foreground text-pretty">
          The recorded address (<span className="font-mono">{geo.ip}</span>) is a private / local network
          address, so no public geolocation is available. This is expected for documents generated in a
          development or internal environment.
        </p>
      ) : geo.error ? (
        <p className="text-sm text-muted-foreground text-pretty">
          Could not resolve a location for <span className="font-mono">{geo.ip}</span>: {geo.error}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field icon={MapPin} label="Approximate location" value={place || "Unknown"} />
            {geo.postal ? <Field icon={MapPin} label="Postal code" value={geo.postal} /> : null}
            {geo.timezone ? <Field icon={Clock} label="Timezone" value={geo.timezone} /> : null}
            {geo.isp ? <Field icon={Building2} label="Internet provider (ISP)" value={geo.isp} /> : null}
            {geo.org && geo.org !== geo.isp ? (
              <Field icon={Building2} label="Organisation" value={geo.org} />
            ) : null}
            {hasCoords ? (
              <Field
                icon={Globe}
                label="Coordinates"
                value={`${geo.latitude!.toFixed(4)}, ${geo.longitude!.toFixed(4)}`}
                mono
              />
            ) : null}
          </div>
          {hasCoords ? (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${geo.latitude},${geo.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View on map
            </a>
          ) : null}
          <p className="text-xs text-muted-foreground text-pretty">
            IP geolocation is approximate (typically city / region level) and reflects the network the
            document was generated from, not a precise address.
          </p>
        </div>
      )}
    </div>
  )
}

function TraceResultCard({ result }: { result: TraceLookupResult }) {
  const trace = result.trace
  const payload = result.payload
  const geo = result.geo

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
          <ShieldAlert className="h-5 w-5 text-primary" />
          {trace ? "Document traced" : "Token decoded — no server record"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {trace ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field icon={FileText} label="Document ID" value={trace.docId} mono />
            <Field icon={FileText} label="Type" value={trace.kind} />
            <Field icon={User} label="Generated by (account)" value={trace.account} />
            <Field icon={User} label="Account ID" value={trace.userId} mono />
            <Field icon={Globe} label="Origin IP (server-captured)" value={trace.ipAddress || "Unknown"} mono />
            <Field icon={Clock} label="Generated at" value={fmtWhen(trace.createdAt)} />
            <Field
              icon={Fingerprint}
              label="Biometric fingerprint on file"
              value={trace.biometricHash ? `${trace.biometricHash.slice(0, 24)}…` : "None enrolled"}
              mono
            />
            <Field icon={FileText} label="Filename" value={trace.filename || "—"} />
            {trace.title ? <Field icon={FileText} label="Title" value={trace.title} /> : null}
            {trace.userAgent ? <Field icon={Info} label="Device / browser" value={trace.userAgent} /> : null}
            {trace.isDemo ? (
              <div className="sm:col-span-2">
                <Badge variant="secondary">Demo account · exports were blocked</Badge>
              </div>
            ) : null}
            {geo ? (
              <div className="sm:col-span-2">
                <GeoPanel geo={geo} />
              </div>
            ) : null}
          </div>
        ) : payload ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground text-pretty">
              The embedded token is valid, but no matching audit row exists on the server (it may have been
              purged, or predates traceability). The details below come from inside the document itself and
              are therefore less authoritative than a server record.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field icon={FileText} label="Document ID" value={payload.docId} mono />
              <Field icon={FileText} label="Type" value={payload.kind} />
              <Field icon={User} label="Account (embedded)" value={payload.account} />
              <Field icon={User} label="Account ID (embedded)" value={payload.uid} mono />
              <Field icon={Clock} label="Generated at (embedded)" value={fmtWhen(new Date(payload.ts).toISOString())} />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function DocumentTraceability() {
  const [needle, setNeedle] = useState("")
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [result, setResult] = useState<TraceLookupResult | null>(null)

  const [fileBusy, setFileBusy] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [filterUser, setFilterUser] = useState("")
  const [recent, setRecent] = useState<DocumentTrace[]>([])
  const [loadingRecent, setLoadingRecent] = useState(false)

  const loadRecent = useCallback(async () => {
    setLoadingRecent(true)
    try {
      const res = await adminListTraces(ADMIN_PASSCODE, filterUser.trim() || undefined)
      if (res.ok) setRecent(res.traces)
    } finally {
      setLoadingRecent(false)
    }
  }, [filterUser])

  useEffect(() => {
    void loadRecent()
    // Intentionally run once on mount; the filter has its own button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runLookup = useCallback(async (override?: string) => {
    const value = (override ?? needle).trim()
    if (!value) {
      setLookupError("Upload a PDF, or enter a document id / token / pasted text.")
      return
    }
    setLooking(true)
    setLookupError(null)
    setResult(null)
    try {
      const res = await adminExtractTrace(ADMIN_PASSCODE, value)
      if (!res.ok) {
        setLookupError(res.error || "Lookup failed.")
        return
      }
      if (!res.trace && !res.payload) {
        setLookupError(res.error || "No matching document was found.")
        return
      }
      setResult(res)
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
    } catch {
      setLookupError("The lookup failed. Please try again.")
    } finally {
      setLooking(false)
    }
  }, [needle])

  /**
   * Handle a dropped/selected PDF. We read the file in the browser and recover
   * the embedded trace token from its raw bytes (the token lives in the PDF Info
   * dictionary and as page micro-text, both plaintext in jsPDF output). Only the
   * small extracted token is sent to the server — never the whole file.
   */
  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      setResult(null)
      setLookupError(null)
      setFileName(file.name)

      if (file.size > 30 * 1024 * 1024) {
        setLookupError("That file is larger than 30 MB. Please upload the original document.")
        return
      }

      setFileBusy(true)
      try {
        // Read as a binary string so the token regex can scan the raw bytes.
        const buf = await file.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let text = ""
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          text += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }

        const found = extractTraceToken(text)
        if (!found) {
          setLookupError(
            "No MCC trace token was found in that file. It may have been re-exported or stripped — " +
              "use the recent-activity log below (searchable by account id and time) instead.",
          )
          return
        }
        setNeedle(found.token)
        await runLookup(found.token)
      } catch {
        setLookupError("Could not read that file. Make sure it is the original PDF.")
      } finally {
        setFileBusy(false)
      }
    },
    [runLookup],
  )

  return (
    <div className="space-y-6">
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Fingerprint className="h-5 w-5 text-primary" />
            Document Traceability
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-pretty">
            Every document generated on the platform carries a hidden trace token and is recorded in a
            tamper-proof server log. Upload the PDF (or paste its token / id) to identify who generated it,
            for which account, and from where.
          </p>

          {/* Primary path: an obvious button that uploads the PDF and lets the
              browser recover its token. Drag & drop still works on the wrapper. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              void handleFile(e.target.files?.[0])
              e.target.value = ""
            }}
          />
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void handleFile(e.dataTransfer.files?.[0])
            }}
            className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-secondary/30 p-6 text-center"
          >
            <Button
              type="button"
              size="lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={fileBusy || looking}
              className="w-full min-h-12 text-base font-semibold sm:w-auto"
            >
              {fileBusy ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Upload className="mr-2 h-5 w-5" />
              )}
              {fileBusy ? "Reading document…" : "Upload document for verification"}
            </Button>
            <p className="text-xs text-muted-foreground text-pretty">
              {fileName
                ? `Selected: ${fileName} — tap the button to choose another`
                : "Choose a PDF or drag & drop it here · the trace token is read in your browser"}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">or enter it manually</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="space-y-2">
            <label htmlFor="trace-needle" className="text-sm font-medium text-foreground">
              Token, document id, or pasted document text
            </label>
            <Textarea
              id="trace-needle"
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              placeholder="MCCX1:…  or  MCC-DOC-…  or paste the extracted PDF text here"
              rows={3}
              className="font-mono text-sm"
            />
          </div>

          {lookupError ? (
            <p className="text-sm text-destructive">{lookupError}</p>
          ) : null}

          <Button onClick={() => runLookup()} disabled={looking || fileBusy}>
            {looking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Trace document
          </Button>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground text-pretty">
              Documents are produced in the browser, so a determined user can strip the in-file token. When
              that happens the token lookup will fail — use the recent-activity log below (searchable by
              account id and time) as the authoritative fallback, since those rows live on the server and
              cannot be altered by the account holder.
            </p>
          </div>
        </CardContent>
      </Card>

      {result ? <TraceResultCard result={result} /> : null}

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base font-semibold text-foreground">
            <span className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Recent document generations
            </span>
            <Button variant="outline" size="sm" onClick={loadRecent} disabled={loadingRecent}>
              {loadingRecent ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={filterUser}
              onChange={(e) => setFilterUser(e.target.value)}
              placeholder="Filter by account id (optional)"
              className="font-mono text-sm"
            />
            <Button variant="secondary" onClick={loadRecent} disabled={loadingRecent}>
              <Search className="mr-2 h-4 w-4" />
              Apply filter
            </Button>
          </div>

          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loadingRecent ? "Loading…" : "No document generations recorded yet."}
            </p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {recent.map((t) => (
                <button
                  key={t.docId}
                  type="button"
                  onClick={() => {
                    setNeedle(t.docId)
                    setFileName(null)
                    void runLookup(t.docId)
                  }}
                  className="flex w-full flex-col gap-1 p-3 text-left transition-colors hover:bg-secondary sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.account}
                      {t.isDemo ? <span className="ml-2 text-xs text-muted-foreground">(demo)</span> : null}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{t.docId}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary" className="capitalize">
                      {t.kind}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{fmtWhen(t.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
