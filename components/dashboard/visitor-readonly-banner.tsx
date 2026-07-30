"use client"

import Link from "next/link"
import { Eye, ArrowUpRight } from "lucide-react"
import { useTierCapabilities } from "@/lib/use-tier-capabilities"

/**
 * Sitewide notice shown to Visitor (pre-subscription, read-only) accounts.
 *
 * Renders nothing for PRO / Avant-Garde. For a Visitor it explains the account
 * is read-only — view everything and receive incoming top-ups, but no outgoing
 * payments, trading or treasury operations — with a direct link to upgrade.
 */
export function VisitorReadOnlyBanner() {
  const { readOnly } = useTierCapabilities()
  if (!readOnly) return null

  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between md:mb-6"
    >
      <div className="flex items-start gap-2.5">
        <Eye className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <p className="text-pretty leading-relaxed text-foreground">
          <span className="font-semibold">Visitor account — read-only.</span>{" "}
          <span className="text-muted-foreground">
            You can explore the platform and receive incoming top-ups, but payments, trading and treasury
            operations are disabled. Your KYC is on file and ready — upgrade anytime.
          </span>
        </p>
      </div>
      <Link
        href="/dashboard/plans"
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Upgrade to PRO or Avant-Garde
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  )
}
