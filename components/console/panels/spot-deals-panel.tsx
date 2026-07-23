"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { Ship, Clock, Anchor, PackageOpen } from "lucide-react"
import { ConsolePanel } from "@/components/console/console-panel"
import { listLiveSpotDeals } from "@/app/actions/spot-deals"
import { dealCountdown, type SpotDeal } from "@/lib/spot-deals-shared"
import { AisFeedStatus } from "@/components/dashboard/vessel-live-position"
import { cn } from "@/lib/utils"

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const c = dealCountdown(expiresAt, now)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[10px] tabular-nums",
        c.expired ? "text-muted-foreground" : c.urgent ? "text-destructive" : "text-warning",
      )}
    >
      <Clock className="h-3 w-3" />
      {c.label}
    </span>
  )
}

export function SpotDealsPanel({ initialDeals }: { initialDeals: SpotDeal[] }) {
  const { data: deals = initialDeals } = useSWR<SpotDeal[]>("console:live-spot-deals", () => listLiveSpotDeals(), {
    fallbackData: initialDeals,
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  })

  return (
    <ConsolePanel icon={Ship} title="Live Spot Deals" badge={`${deals.length}`} live>
      {deals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <PackageOpen className="h-7 w-7 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">No live spot offers on the board right now.</p>
          <Link href="/dashboard/commodity" className="text-[11px] font-medium text-primary hover:underline">
            Open commodity desk
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {deals.map((deal) => (
            <li key={deal.id} className="px-3 py-2.5 transition-colors hover:bg-secondary/30">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-foreground">{deal.product}</p>
                  <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                    <Anchor className="h-3 w-3 shrink-0" />
                    {deal.vesselName} · IMO {deal.vesselImo}
                  </p>
                </div>
                <Countdown expiresAt={deal.expiresAt} />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
                <span className="text-muted-foreground">
                  {deal.quantity.toLocaleString("en-US")} {deal.unit} · {deal.incoterm} {deal.loadPort}
                </span>
                <span className="font-mono font-semibold tabular-nums text-primary">
                  {deal.currency} {deal.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}/{deal.unit}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{deal.id}</span>
                <span className="font-mono text-[10px] font-semibold tabular-nums text-foreground">
                  {deal.currency} {deal.totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <Link href="/dashboard/commodity" className="text-[11px] font-medium text-primary hover:underline">
          View full commodity desk →
        </Link>
        <AisFeedStatus />
      </div>
    </ConsolePanel>
  )
}
