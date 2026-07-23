"use client"

// ---------------------------------------------------------------------------
// Client-side LIVE AIS indicators.
//
// Two small, self-contained pieces reused across the Commodity desk and the
// NQAi Console:
//   - <AisFeedStatus>        — a single chip showing whether a live AIS
//                              provider (e.g. MarineTraffic) is connected.
//   - <VesselLivePositionLine> — per-vessel real-time position that polls the
//                              connected provider on an interval and renders an
//                              honest "live", "unavailable" or "no fix" state.
//
// Neither component ever shows fabricated coordinates: when no provider token
// is configured the server returns `connected: false` and we say so plainly.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Loader2, Radio, SatelliteDish, MapPin, Navigation, Gauge } from "lucide-react"
import { cn } from "@/lib/utils"
import { getVesselProviderStatus, refreshVesselPosition, type LivePositionResult } from "@/app/actions/spot-deals"
import { VESSEL_STATUS_LABELS } from "@/lib/spot-deals-shared"

/** Chip: is a live AIS provider connected? Refreshes every 60s. */
export function AisFeedStatus({ className }: { className?: string }) {
  const { data, isLoading } = useSWR("vessel:provider-status", () => getVesselProviderStatus(), {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  })
  const connected = Boolean(data?.connected)
  const label = data?.active?.label

  if (isLoading && !data) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking AIS feed…
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        connected
          ? "border-green-500/30 bg-green-500/10 text-green-500"
          : "border-amber-500/30 bg-amber-500/10 text-amber-500",
        className,
      )}
      title={
        connected
          ? `Live AIS positions via ${label}.`
          : "No live AIS provider connected. Add a provider API key (e.g. MARINETRAFFIC_API_KEY) to stream real-time vessel positions."
      }
    >
      {connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          Live AIS · {label}
        </>
      ) : (
        <>
          <SatelliteDish className="h-3 w-3" />
          AIS feed not connected
        </>
      )}
    </span>
  )
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return "just now"
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function formatCoord(lat: number, lng: number): string {
  const ns = lat >= 0 ? "N" : "S"
  const ew = lng >= 0 ? "E" : "W"
  return `${Math.abs(lat).toFixed(3)}°${ns}, ${Math.abs(lng).toFixed(3)}°${ew}`
}

/**
 * Per-vessel real-time position. Polls `refreshVesselPosition(imo)` every
 * `intervalMs` (default 45s). Renders coordinates + navigational status + a
 * "fix age" when a live provider returns a position, or an explicit
 * unavailable/no-fix line otherwise. `enabled=false` pauses polling (e.g. for
 * off-screen cards).
 */
export function VesselLivePositionLine({
  imo,
  intervalMs = 45_000,
  enabled = true,
  className,
}: {
  imo: string
  intervalMs?: number
  enabled?: boolean
  className?: string
}) {
  const [tick, setTick] = useState(0)
  const { data, isLoading } = useSWR<LivePositionResult>(
    enabled ? ["vessel:position", imo] : null,
    () => refreshVesselPosition(imo),
    { refreshInterval: intervalMs, revalidateOnFocus: true, dedupingInterval: intervalMs / 2 },
  )

  // Re-render every 20s so the "fix age" stays current between polls.
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setTick((n) => n + 1), 20_000)
    return () => clearInterval(t)
  }, [enabled])
  // Reference tick so the linter keeps the interval-driven re-render.
  void tick

  const base = "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"

  if (isLoading && !data) {
    return (
      <div className={cn(base, "text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        Locating vessel…
      </div>
    )
  }

  // No provider connected — be explicit, never show stale coordinates.
  if (!data?.connected) {
    return (
      <div className={cn(base, "text-amber-500", className)}>
        <SatelliteDish className="h-3.5 w-3.5 shrink-0" />
        Live position unavailable — AIS feed not connected
      </div>
    )
  }

  // Provider connected but no fix (out of coverage / no recent transmission).
  if (!data.position) {
    return (
      <div className={cn(base, "text-muted-foreground", className)}>
        <Radio className="h-3.5 w-3.5 shrink-0" />
        Awaiting live AIS fix{data.providerLabel ? ` · ${data.providerLabel}` : ""}
      </div>
    )
  }

  const p = data.position
  return (
    <div className={cn(base, "text-foreground", className)}>
      <span className="inline-flex items-center gap-1 font-medium text-green-500">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500/70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
        </span>
        Live
      </span>
      <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        {formatCoord(p.lat, p.lng)}
      </span>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Navigation className="h-3.5 w-3.5 shrink-0" />
        {VESSEL_STATUS_LABELS[p.status]}
      </span>
      {typeof p.speedKnots === "number" ? (
        <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
          <Gauge className="h-3.5 w-3.5 shrink-0" />
          {p.speedKnots.toFixed(1)} kn
        </span>
      ) : null}
      <span className="text-muted-foreground/70">{relativeTime(p.timestamp)}</span>
    </div>
  )
}
