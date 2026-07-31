"use client"

// ---------------------------------------------------------------------------
// Admin · Logs & Debug
//
// Two cross-user views that complement the per-client Security Audit:
//   • GlobalLogStream — every recorded action across ALL accounts, one live
//     stream, with a derived severity so anomalies stand out.
//   • ErrorDebugLog   — automatically-captured bugs/exceptions (client + server)
//     with full stack traces.
//
// Both share a detail drawer that shows the complete structured record and lets
// the admin copy or download the raw event.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Copy,
  Download,
  Check,
  Activity,
  Bug,
  Server,
  Monitor,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import type {
  GlobalStreamResult,
  GlobalStreamEvent,
  ErrorLogResult,
  ErrorLogEvent,
} from "@/lib/security-audit-service"
import type { DebugSeverity } from "@/lib/debug-log-db"

type Severity = "critical" | "error" | "warning" | "info"

function fmtWhen(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

// Severity → theme token. Uses the app's semantic tokens (Bloomberg amber
// theme): destructive for the two worst, warning amber for warnings, muted for
// info. Never hard-coded hex.
const SEV_META: Record<Severity, { label: string; dot: string; badge: string }> = {
  critical: {
    label: "Critical",
    dot: "bg-destructive",
    badge: "border-destructive/40 bg-destructive/15 text-destructive",
  },
  error: {
    label: "Error",
    dot: "bg-destructive/80",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  warning: {
    label: "Warning",
    dot: "bg-warning",
    badge: "border-warning/40 bg-warning/15 text-warning",
  },
  info: {
    label: "Info",
    dot: "bg-primary",
    badge: "border-border bg-secondary/40 text-muted-foreground",
  },
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const m = SEV_META[severity] ?? SEV_META.info
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${m.badge}`}>
      {m.label}
    </span>
  )
}

const SEVERITY_FILTERS: { value: "All" | Severity; label: string }[] = [
  { value: "All", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
]

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  )
}

// A single labelled field inside the detail drawer.
function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="rounded-md border border-border bg-secondary/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 break-words text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  )
}

/** Shared detail drawer for a single log/error record. */
function LogDetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  severity,
  fields,
  message,
  stack,
  raw,
  downloadBase,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string | null
  severity: Severity
  fields: { label: string; value: string | null | undefined; mono?: boolean }[]
  message?: string | null
  stack?: string | null
  raw: unknown
  downloadBase: string
}) {
  const [copied, setCopied] = useState(false)
  const json = useMemo(() => JSON.stringify(raw, null, 2), [raw])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore clipboard failures (e.g. insecure context)
    }
  }

  const download = () => {
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${downloadBase}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Sheet open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-center gap-2">
            <SeverityBadge severity={severity} />
            <SheetTitle className="text-balance text-base font-semibold">{title}</SheetTitle>
          </div>
          {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-4 p-4">
            {message ? (
              <div className="rounded-md border border-border bg-secondary/20 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Message</p>
                <p className="mt-0.5 break-words text-sm text-foreground">{message}</p>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {fields.map((f) => (
                <Field key={f.label} label={f.label} value={f.value} mono={f.mono} />
              ))}
            </div>

            {stack ? (
              <div className="rounded-md border border-border bg-background px-3 py-2">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Stack trace</p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {stack}
                </pre>
              </div>
            ) : null}

            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Raw record</p>
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {json}
              </pre>
            </div>
          </div>
        </ScrollArea>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="ml-2">{copied ? "Copied" : "Copy JSON"}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download className="h-4 w-4" />
            <span className="ml-2">Download</span>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CountStat({ label, value, tone }: { label: string; value: number; tone?: Severity }) {
  const color = tone ? SEV_META[tone].badge.split(" ").find((c) => c.startsWith("text-")) : "text-foreground"
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  )
}

// ===========================================================================
// Global log stream (cross-user)
// ===========================================================================

const STREAM_CATEGORIES = [
  "All",
  "Authentication",
  "Security",
  "Treasury",
  "Requests",
  "Documents",
  "NQAi",
  "Navigation",
]

export function GlobalLogStream() {
  const [data, setData] = useState<GlobalStreamResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [category, setCategory] = useState("All")
  const [severity, setSeverity] = useState<"All" | Severity>("All")
  const [selected, setSelected] = useState<GlobalStreamEvent | null>(null)

  const load = useCallback(async (cat: string, sev: "All" | Severity) => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({ p: ADMIN_PASSCODE })
      if (cat && cat !== "All") params.set("category", cat)
      if (sev && sev !== "All") params.set("severity", sev)
      const res = await fetch(`/api/admin/audit/stream?${params.toString()}`, {
        headers: { "x-admin-passcode": ADMIN_PASSCODE },
        cache: "no-store",
      })
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: GlobalStreamResult; error?: string } | null
      if (res.ok && json?.ok && json.data) setData(json.data)
      else setError(json?.error || "Could not load the global log stream.")
    } catch {
      setError("Could not load the global log stream.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(category, severity)
  }, [load, category, severity])

  const counts = data?.counts

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Activity className="h-4 w-4 text-primary" /> Global activity log
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load(category, severity)} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
          Every recorded action across all accounts, newest first. Each entry is tagged with a severity derived from the
          action so failures, blocks and anomalies stand out. Select any entry for the full record.
        </p>

        {counts ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CountStat label="Events" value={counts.total} />
            <CountStat label="Critical" value={counts.critical} tone="critical" />
            <CountStat label="Errors" value={counts.error} tone="error" />
            <CountStat label="Warnings" value={counts.warning} tone="warning" />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {SEVERITY_FILTERS.map((s) => (
            <Chip key={s.value} active={severity === s.value} onClick={() => setSeverity(s.value)}>
              {s.label}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {STREAM_CATEGORIES.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : null}

        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading log…
          </div>
        ) : data && data.events.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {data.empty ? "No activity has been recorded yet." : "No entries match these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data?.events.map((e) => {
              const m = SEV_META[e.severity] ?? SEV_META.info
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-secondary/50"
                  >
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${m.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{e.action}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {e.category || "General"}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {e.accountLabel}
                        {e.ipAddress ? ` · ${e.ipAddress}` : ""}
                        {e.path ? ` · ${e.path}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <SeverityBadge severity={e.severity} />
                      <span className="mt-1 block text-[11px] text-muted-foreground">{fmtWhen(e.createdAt)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      <LogDetailDrawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.action || "Event"}
        subtitle={selected ? `${selected.accountLabel} · ${fmtWhen(selected.createdAt)}` : null}
        severity={selected?.severity ?? "info"}
        message={
          selected?.details && Object.keys(selected.details).length
            ? Object.entries(selected.details)
                .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                .join("\n")
            : null
        }
        fields={
          selected
            ? [
                { label: "Account", value: selected.accountLabel },
                { label: "User id", value: selected.userId, mono: true },
                { label: "Category", value: selected.category },
                { label: "Path", value: selected.path, mono: true },
                { label: "IP address", value: selected.ipAddress, mono: true },
                { label: "Device", value: [selected.deviceType, selected.os, selected.browser].filter(Boolean).join(" · ") },
                { label: "When", value: fmtWhen(selected.createdAt) },
              ]
            : []
        }
        raw={selected}
        downloadBase="log-event"
      />
    </Card>
  )
}

// ===========================================================================
// Errors & Debug (automatically captured)
// ===========================================================================

const SOURCE_FILTERS: { value: "All" | "client" | "server"; label: string }[] = [
  { value: "All", label: "All sources" },
  { value: "client", label: "Client" },
  { value: "server", label: "Server" },
]

export function ErrorDebugLog() {
  const [data, setData] = useState<ErrorLogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [severity, setSeverity] = useState<"All" | Severity>("All")
  const [source, setSource] = useState<"All" | "client" | "server">("All")
  const [selected, setSelected] = useState<ErrorLogEvent | null>(null)

  const load = useCallback(async (sev: "All" | Severity, src: "All" | "client" | "server") => {
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({ p: ADMIN_PASSCODE })
      if (sev && sev !== "All") params.set("severity", sev as DebugSeverity)
      if (src && src !== "All") params.set("source", src)
      const res = await fetch(`/api/admin/audit/errors?${params.toString()}`, {
        headers: { "x-admin-passcode": ADMIN_PASSCODE },
        cache: "no-store",
      })
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: ErrorLogResult; error?: string } | null
      if (res.ok && json?.ok && json.data) setData(json.data)
      else setError(json?.error || "Could not load the error log.")
    } catch {
      setError("Could not load the error log.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(severity, source)
  }, [load, severity, source])

  const stats = data?.stats

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Bug className="h-4 w-4 text-primary" /> Errors &amp; Debug
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => void load(severity, source)} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
          Bugs and exceptions captured automatically as they happen — uncaught browser errors, unhandled promise
          rejections, React crashes, and server-side failures — so you see problems without a client having to report
          them. Select any entry for the full stack trace.
        </p>

        {stats ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CountStat label="Total" value={stats.total} />
            <CountStat label="Critical" value={stats.critical} tone="critical" />
            <CountStat label="Client" value={stats.clientCount} />
            <CountStat label="Server" value={stats.serverCount} />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {SEVERITY_FILTERS.map((s) => (
            <Chip key={s.value} active={severity === s.value} onClick={() => setSeverity(s.value)}>
              {s.label}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((s) => (
            <Chip key={s.value} active={source === s.value} onClick={() => setSource(s.value)}>
              {s.label}
            </Chip>
          ))}
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : null}

        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading errors…
          </div>
        ) : data && data.events.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {data.empty ? "No errors captured — nothing has gone wrong yet." : "No entries match these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data?.events.map((e) => {
              const m = SEV_META[e.severity] ?? SEV_META.info
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-secondary/50"
                  >
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${m.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{e.kind || "error"}</span>
                        <Badge variant="secondary" className="flex items-center gap-1 text-[10px]">
                          {e.source === "server" ? <Server className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                          {e.source}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{e.message}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
                        {e.accountLabel || "Anonymous"}
                        {e.path ? ` · ${e.path}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <SeverityBadge severity={e.severity} />
                      <span className="mt-1 block text-[11px] text-muted-foreground">{fmtWhen(e.createdAt)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      <LogDetailDrawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.kind || "Error"}
        subtitle={selected ? `${selected.source} · ${fmtWhen(selected.createdAt)}` : null}
        severity={selected?.severity ?? "error"}
        message={selected?.message}
        stack={selected?.stack}
        fields={
          selected
            ? [
                { label: "Severity", value: SEV_META[selected.severity]?.label },
                { label: "Source", value: selected.source },
                { label: "Account", value: selected.accountLabel || "Anonymous" },
                { label: "User id", value: selected.userId, mono: true },
                { label: "Path", value: selected.path, mono: true },
                { label: "IP address", value: selected.ipAddress, mono: true },
                { label: "Device", value: [selected.deviceType, selected.os, selected.browser].filter(Boolean).join(" · ") },
                { label: "Meta", value: selected.meta ? JSON.stringify(selected.meta) : null, mono: true },
              ]
            : []
        }
        raw={selected}
        downloadBase="error-event"
      />
    </Card>
  )
}
