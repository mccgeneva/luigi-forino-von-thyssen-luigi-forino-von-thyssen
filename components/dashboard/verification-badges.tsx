"use client"

import { CheckCircle2, MinusCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Verifications, VerificationRegistry } from "@/app/actions/marketplace-instruments"

const REGISTRY_LABELS: Record<VerificationRegistry, string> = {
  bloomberg: "Bloomberg",
  euroclear: "Euroclear",
  clearstream: "Clearstream",
  swift: "SWIFT",
}

const REGISTRY_ORDER: VerificationRegistry[] = ["bloomberg", "euroclear", "clearstream", "swift"]

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

/** Count of registries this instrument is verified against. */
export function verifiedCount(v: Verifications): number {
  return REGISTRY_ORDER.reduce((n, r) => (v[r] ? n + 1 : n), 0)
}

/**
 * Renders the four trusted-source verification chips (Bloomberg, Euroclear,
 * Clearstream, SWIFT). Verified sources show a check and the attestation date;
 * unverified sources are shown muted so nothing is over-claimed.
 */
export function VerificationBadges({
  verifications,
  size = "sm",
  className,
}: {
  verifications: Verifications
  size?: "sm" | "xs"
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {REGISTRY_ORDER.map((r) => {
        const at = verifications[r]
        const verified = Boolean(at)
        return (
          <span
            key={r}
            title={verified ? `Verified via ${REGISTRY_LABELS[r]}${at ? ` on ${fmtDate(at)}` : ""}` : `Not verified against ${REGISTRY_LABELS[r]}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono",
              size === "xs" ? "text-[9px]" : "text-[10px]",
              verified
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-muted/30 text-muted-foreground/60",
            )}
          >
            {verified ? <CheckCircle2 className="h-3 w-3" /> : <MinusCircle className="h-3 w-3" />}
            {REGISTRY_LABELS[r]}
          </span>
        )
      })}
    </div>
  )
}
