"use client"

import useSWR from "swr"
import { ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { OverdraftStatus } from "@/lib/overdraft"

type Payload = { ok: boolean; overdraft?: OverdraftStatus }

const fetcher = (url: string) => fetch(url, { credentials: "include", cache: "no-store" }).then((r) => r.json())

const eur = (n: number) =>
  `EUR ${(Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

/**
 * Small, professional badge shown to every customer whose Master Account has a
 * controlled overdraft facility authorized (i.e. a secured treasury deposit
 * exists, so `overdraft.available` is true). It states the maximum authorized
 * amount = the 8%-of-deposit ceiling (`limitEur`). Renders nothing when no
 * facility exists, so it is safe to drop anywhere a customer sees their account.
 *
 * Reads the member's OWN status from the non-proxied `/api/guarantees` GET (the
 * same endpoint the Guarantees Accumulator card uses) — a Server Action would be
 * 401'd by the dashboard proxy on a stale cookie.
 */
export function OverdraftAuthorizedBadge({ className }: { className?: string }) {
  const { data } = useSWR<Payload>("/api/guarantees", fetcher, { refreshInterval: 60_000 })

  const overdraft = data?.overdraft
  if (!data?.ok || !overdraft?.available || !(overdraft.limitEur > 0)) return null

  return (
    <Badge
      variant="outline"
      title={`Your Master Account may be drawn down to ${eur(overdraft.limitEur)} to settle platform charges (8% of your secured treasury security deposit).`}
      className={cn(
        "gap-1.5 border-primary/30 bg-primary/10 text-primary",
        "text-[11px] font-medium",
        className,
      )}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      <span>Overdraft authorized</span>
      <span className="font-semibold tabular-nums">· up to {eur(overdraft.limitEur)}</span>
    </Badge>
  )
}
