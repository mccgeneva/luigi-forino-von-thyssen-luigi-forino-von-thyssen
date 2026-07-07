"use client"

// ---------------------------------------------------------------------------
// Admin · Security Audit
//
// Pick any client and reconstruct exactly what they did: identity on file, the
// login selfie captured at sign-in, the devices/browsers and geolocated IPs
// they used, and a full, filterable activity timeline. Everything is read from
// the authoritative server-side audit trail (security_audit_events) — the
// account holder can never see or alter it.
//
// Honest limits are surfaced in the UI: the trail starts empty at deploy time
// (activity used to be emailed only), selfies exist only for biometric logins,
// and IP geolocation is approximate.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  ShieldCheck,
  Search,
  User,
  Globe,
  Clock,
  Loader2,
  Info,
  RefreshCw,
  MapPin,
  ExternalLink,
  Monitor,
  Smartphone,
  BadgeCheck,
  Download,
  ChevronLeft,
  Camera,
  AlertTriangle,
  Activity,
} from "lucide-react"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import type { AuditOverview, UserAuditReport } from "@/lib/security-audit-service"

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
  })
}

const CATEGORIES = [
  "All",
  "Authentication",
  "Security",
  "Treasury",
  "Requests",
  "Documents",
  "NQAi",
  "Navigation",
]

function DeviceIcon({ type }: { type: string | null }) {
  if (type === "Mobile" || type === "Tablet") return <Smartphone className="h-4 w-4 text-primary" />
  return <Monitor className="h-4 w-4 text-primary" />
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}

export function SecurityAudit() {
  const [overview, setOverview] = useState<AuditOverview | null>(null)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [overviewError, setOverviewError] = useState("")
  const [search, setSearch] = useState("")

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [report, setReport] = useState<UserAuditReport | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [reportError, setReportError] = useState("")
  const [category, setCategory] = useState("All")

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true)
    setOverviewError("")
    try {
      // Route Handler, not a Server Action — Server Actions are silently
      // rejected on this app's production domains (see the route for details).
      const res = await fetch(`/api/admin/audit/overview?p=${encodeURIComponent(ADMIN_PASSCODE)}`, {
        headers: { "x-admin-passcode": ADMIN_PASSCODE },
        cache: "no-store",
      })
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: AuditOverview; error?: string } | null
      if (res.ok && json?.ok && json.data) setOverview(json.data)
      else setOverviewError(json?.error || "Could not load the audit overview.")
    } catch {
      setOverviewError("Could not load the audit overview.")
    } finally {
      setLoadingOverview(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const loadReport = useCallback(async (userId: string, cat: string) => {
    setLoadingReport(true)
    setReportError("")
    try {
      // Route Handler, not a Server Action (same domain-compatibility reason).
      const params = new URLSearchParams({ p: ADMIN_PASSCODE, userId })
      if (cat && cat !== "All") params.set("category", cat)
      const res = await fetch(`/api/admin/audit/user?${params.toString()}`, {
        headers: { "x-admin-passcode": ADMIN_PASSCODE },
        cache: "no-store",
      })
      const json = (await res.json().catch(() => null)) as { ok: boolean; data?: UserAuditReport; error?: string } | null
      if (res.ok && json?.ok && json.data) setReport(json.data)
      else {
        setReport(null)
        setReportError(json?.error || "Could not load this account's audit.")
      }
    } catch {
      setReport(null)
      setReportError("Could not load this account's audit.")
    } finally {
      setLoadingReport(false)
    }
  }, [])

  const openUser = (userId: string) => {
    setSelectedId(userId)
    setCategory("All")
    void loadReport(userId, "All")
  }

  const closeUser = () => {
    setSelectedId(null)
    setReport(null)
    setReportError("")
  }

  const onCategory = (cat: string) => {
    setCategory(cat)
    if (selectedId) void loadReport(selectedId, cat)
  }

  // Merge active actors with the full account directory so every client is
  // searchable, even ones with no recorded events yet.
  const rows = useMemo(() => {
    if (!overview) return []
    const byId = new Map<
      string,
      { userId: string; label: string; sub: string; lastSeen: string | null; eventCount: number; selfie: string | null }
    >()
    for (const acc of overview.accounts) {
      byId.set(acc.userId, {
        userId: acc.userId,
        label: acc.label,
        sub: acc.company || acc.email,
        lastSeen: null,
        eventCount: 0,
        selfie: null,
      })
    }
    for (const a of overview.actors) {
      const existing = byId.get(a.userId)
      byId.set(a.userId, {
        userId: a.userId,
        label: existing?.label || a.account,
        sub: existing?.sub || a.lastIp || "",
        lastSeen: a.lastSeen,
        eventCount: a.eventCount,
        selfie: a.lastSelfieUrl,
      })
    }
    const list = [...byId.values()]
    const q = search.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (r) => r.label.toLowerCase().includes(q) || r.sub.toLowerCase().includes(q) || r.userId.toLowerCase().includes(q),
        )
      : list
    // Active first (most recent), then never-seen accounts alphabetically.
    return filtered.sort((a, b) => {
      if (a.lastSeen && b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1
      if (a.lastSeen) return -1
      if (b.lastSeen) return 1
      return a.label.localeCompare(b.label)
    })
  }, [overview, search])

  const exportData = (format: "csv" | "json") => {
    if (!report) return
    const base = `security-audit-${report.account.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now()}`
    let blob: Blob
    if (format === "json") {
      blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    } else {
      const header = ["timestamp", "action", "category", "path", "ip", "device", "os", "browser", "details"]
      const escape = (v: unknown) => {
        const s = v == null ? "" : String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const lines = [header.join(",")]
      for (const e of report.events) {
        lines.push(
          [
            e.createdAt,
            e.action,
            e.category,
            e.path ?? "",
            e.ipAddress ?? "",
            e.deviceType ?? "",
            e.os ?? "",
            e.browser ?? "",
            e.details ? JSON.stringify(e.details) : "",
          ]
            .map(escape)
            .join(","),
        )
      }
      blob = new Blob([lines.join("\n")], { type: "text/csv" })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${base}.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Security Audit
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            Pick any client to reconstruct exactly what they did: their identity on file, the login selfie captured at
            sign-in, the devices and geolocated IP addresses they connected from, and a full activity timeline. This is
            read from a tamper-proof server log the account holder cannot see or edit.
          </p>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="text-pretty">
              The trail records everything from the moment this tool went live — earlier activity was only emailed and is
              not stored. Login selfies are captured on biometric sign-ins. IP geolocation is approximate.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ---- Account picker ---- */}
      {!selectedId && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base font-semibold">Clients</CardTitle>
              <Button variant="outline" size="sm" onClick={() => void loadOverview()} disabled={loadingOverview}>
                {loadingOverview ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-2">Refresh</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, company, email or account id"
                className="pl-9"
              />
            </div>

            {overviewError ? (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {overviewError}
              </div>
            ) : null}

            {loadingOverview && !overview ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading clients…
              </div>
            ) : rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No accounts match your search.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map((r) => (
                  <li key={r.userId}>
                    <button
                      type="button"
                      onClick={() => openUser(r.userId)}
                      className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-secondary/50"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary">
                        {r.selfie ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.selfie || "/placeholder.svg"} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <User className="h-5 w-5 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{r.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{r.sub || r.userId}</span>
                      </span>
                      <span className="hidden shrink-0 text-right sm:block">
                        <span className="block text-xs text-muted-foreground">{fmtWhen(r.lastSeen)}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.eventCount > 0 ? `${r.eventCount} events` : "no activity yet"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- Per-user report ---- */}
      {selectedId && (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={closeUser}>
              <ChevronLeft className="h-4 w-4" />
              <span className="ml-1">All clients</span>
            </Button>
            {report ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => exportData("csv")}>
                  <Download className="h-4 w-4" />
                  <span className="ml-2">CSV</span>
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportData("json")}>
                  <Download className="h-4 w-4" />
                  <span className="ml-2">JSON</span>
                </Button>
              </div>
            ) : null}
          </div>

          {loadingReport ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Building audit report…
            </div>
          ) : reportError ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {reportError}
            </div>
          ) : report ? (
            <>
              {/* Identity + selfie */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold text-balance">{report.account}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex flex-col gap-5 sm:flex-row">
                    <div className="flex flex-col items-center gap-2">
                      <span className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-xl border border-border bg-secondary">
                        {report.selfie.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={report.selfie.url || "/placeholder.svg"} alt="Login selfie" className="h-full w-full object-cover" />
                        ) : (
                          <Camera className="h-8 w-8 text-muted-foreground" />
                        )}
                      </span>
                      <span className="text-center text-xs text-muted-foreground">
                        {report.selfie.url ? `Login selfie · ${fmtWhen(report.selfie.at)}` : "No selfie captured yet"}
                      </span>
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center gap-2">
                        {report.identity.verified ? (
                          <Badge className="gap-1 bg-primary text-primary-foreground">
                            <BadgeCheck className="h-3.5 w-3.5" /> Identity verified
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <AlertTriangle className="h-3.5 w-3.5" /> Not verified
                          </Badge>
                        )}
                        {report.identity.verifiedAt ? (
                          <span className="text-xs text-muted-foreground">{fmtWhen(report.identity.verifiedAt)}</span>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <InfoRow label="Full name" value={report.identity.fullName || "—"} />
                        <InfoRow label="Country" value={report.identity.country || "—"} />
                        <InfoRow
                          label="Passport"
                          value={report.identity.passportLast4 ? `•••• ${report.identity.passportLast4}` : "—"}
                        />
                        <InfoRow label="Account id" value={report.userId} mono />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    By design the platform keeps no raw passport scan — only the verification status, country, name and
                    passport last-4 shown here, plus the login selfie above.
                  </p>
                </CardContent>
              </Card>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Events" value={report.stats.eventCount} />
                <Stat label="Logins" value={report.stats.loginCount} />
                <Stat label="Failed" value={report.stats.failedLoginCount} />
                <Stat label="Devices" value={report.stats.distinctDeviceCount} />
                <Stat label="IPs" value={report.stats.distinctIpCount} />
                <Stat label="First seen" value={report.stats.firstSeen ? fmtWhen(report.stats.firstSeen).split(",")[0] : "—"} />
              </div>

              {/* Locations */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <MapPin className="h-4 w-4 text-primary" /> Locations &amp; IPs
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {report.locations.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No IP addresses recorded yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {report.locations.map((loc) => (
                        <li
                          key={loc.ip}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 p-3"
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-sm text-foreground">{loc.ip}</p>
                            <p className="text-xs text-muted-foreground">
                              {loc.isPrivate
                                ? "Private / local network — no public location"
                                : loc.error
                                  ? loc.error
                                  : [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Location unknown"}
                              {loc.isp ? ` · ${loc.isp}` : ""}
                            </p>
                          </div>
                          {loc.latitude != null && loc.longitude != null ? (
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}&zoom=11`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              Map <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* Devices */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Monitor className="h-4 w-4 text-primary" /> Recent devices
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {report.devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No devices recorded yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {report.devices.map((d, i) => (
                        <li key={i} className="flex items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3">
                          <DeviceIcon type={d.deviceType} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-foreground">
                              {[d.browser, d.os].filter(Boolean).join(" · ") || "Unknown device"}
                            </p>
                            <p className="truncate font-mono text-xs text-muted-foreground">{d.ipAddress || "—"}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-xs text-muted-foreground">{fmtWhen(d.lastSeen)}</p>
                            <p className="text-xs text-muted-foreground">{d.eventCount} events</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* Timeline */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Activity className="h-4 w-4 text-primary" /> Activity timeline
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    {CATEGORIES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => onCategory(c)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          category === c
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary"
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>

                  {report.events.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No events recorded for this filter.
                    </p>
                  ) : (
                    <ol className="relative space-y-4 border-l border-border pl-5">
                      {report.events.map((e) => (
                        <li key={e.id} className="relative">
                          <span className="absolute -left-[23px] top-1 h-3 w-3 rounded-full border-2 border-background bg-primary" />
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{e.action}</span>
                            <Badge variant="secondary" className="text-[10px]">
                              {e.category || "General"}
                            </Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {fmtWhen(e.createdAt)}
                            {e.ipAddress ? ` · ${e.ipAddress}` : ""}
                            {e.browser || e.os ? ` · ${[e.browser, e.os].filter(Boolean).join(" ")}` : ""}
                            {e.path ? ` · ${e.path}` : ""}
                          </p>
                          {e.details && Object.keys(e.details).length > 0 ? (
                            <p className="mt-1 break-words text-xs text-muted-foreground/80">
                              {Object.entries(e.details)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(" · ")}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 truncate text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  )
}
