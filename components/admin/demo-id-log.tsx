"use client"

import { useCallback, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { IdCard, Loader2, MapPin, Globe2, RefreshCw, X, Clock, Fingerprint, Monitor, UserSearch } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { DemoIdSubmission } from "@/lib/demo-id-types"

/** Admin-gated image URL for a retained demo ID document (passport-image proxy). */
function imageUrl(pathname: string, passcode: string): string {
  return `/api/passport-image?pathname=${encodeURIComponent(pathname)}&p=${encodeURIComponent(passcode)}`
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Administrator inspection of demo-account ID submissions.
 *
 * Every visitor who logs into the shared demo account uploads a valid ID
 * document (no facial recognition). This panel shows the OCR-identified holder,
 * the retained document image, and the visitor's IP + GPS captured at login —
 * the security/audit trail for who has been testing the platform.
 */
export function DemoIdLog({ passcode }: { passcode: string }) {
  const [items, setItems] = useState<DemoIdSubmission[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [viewer, setViewer] = useState<DemoIdSubmission | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/demo-id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: passcode }),
        cache: "no-store",
      })
      const data = (await res.json()) as {
        ok: boolean
        reason?: string
        error?: string
        submissions?: DemoIdSubmission[]
      }
      if (!data.ok) {
        setError(
          data.reason === "unauthorized"
            ? "Administrator authorization failed."
            : data.error || "Could not load submissions.",
        )
        setItems([])
      } else {
        setItems(data.submissions || [])
      }
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [passcode])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <UserSearch className="h-5 w-5 text-primary" />
              Demo ID Log
            </CardTitle>
            <CardDescription className="max-w-2xl">
              Every login to the shared demo account (demo@mccgva.ch) requires an ID document instead of a face scan.
              Each visitor&apos;s document is OCR-identified and stored here with their IP address and GPS position for
              security review.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading submissions…
          </div>
        ) : items.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <IdCard className="h-8 w-8 text-muted-foreground/60" />
            No demo ID submissions yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3 sm:flex-row"
              >
                {/* Thumbnail */}
                <button
                  type="button"
                  onClick={() => setViewer(s)}
                  className="group relative h-28 w-full shrink-0 overflow-hidden rounded-lg border border-border bg-background sm:h-24 sm:w-36"
                  aria-label="View ID document"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imageUrl(s.docPathname, passcode) || "/placeholder.svg"}
                    alt={`ID document for ${s.fullName || "demo visitor"}`}
                    className="h-full w-full object-cover transition group-hover:opacity-90"
                    loading="lazy"
                  />
                </button>

                {/* Details */}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold text-foreground">{s.fullName || "Unidentified visitor"}</span>
                    {s.docType && (
                      <Badge variant="outline" className="text-[10px]">
                        {s.docType}
                      </Badge>
                    )}
                    {s.country && (
                      <Badge variant="secondary" className="text-[10px]">
                        {s.country}
                      </Badge>
                    )}
                  </div>

                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {s.docNumber && (
                      <span className="flex items-center gap-1.5">
                        <Fingerprint className="h-3.5 w-3.5 shrink-0" />
                        Doc no. {s.docNumber}
                      </span>
                    )}
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      {fmtDate(s.createdAt)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Globe2 className="h-3.5 w-3.5 shrink-0" />
                      IP {s.ip || "unknown"}
                    </span>
                    {s.gpsLat != null && s.gpsLng != null ? (
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${s.gpsLat}&mlon=${s.gpsLng}#map=15/${s.gpsLat}/${s.gpsLng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-primary underline-offset-2 hover:underline"
                      >
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        {s.gpsLat.toFixed(5)}, {s.gpsLng.toFixed(5)}
                        {s.gpsAccuracy != null ? ` (±${Math.round(s.gpsAccuracy)}m)` : ""}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        Location not shared
                      </span>
                    )}
                  </div>

                  {s.userAgent && (
                    <p className="flex items-start gap-1.5 truncate text-[11px] text-muted-foreground/80">
                      <Monitor className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="truncate">{s.userAgent}</span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Full-image viewer overlay (in-app; no raw file navigation). */}
      {viewer &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 p-4" role="dialog" aria-modal="true">
            <div className="flex items-center justify-between gap-2 pb-3">
              <div className="min-w-0 text-sm text-white">
                <p className="truncate font-medium">{viewer.fullName || "Demo visitor"}</p>
                <p className="truncate text-xs text-white/60">
                  {viewer.docType}
                  {viewer.docNumber ? ` · ${viewer.docNumber}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setViewer(null)}
                className="shrink-0 gap-2"
              >
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(viewer.docPathname, passcode) || "/placeholder.svg"}
                alt={`ID document for ${viewer.fullName || "demo visitor"}`}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            </div>
          </div>,
          document.body,
        )}
    </Card>
  )
}
