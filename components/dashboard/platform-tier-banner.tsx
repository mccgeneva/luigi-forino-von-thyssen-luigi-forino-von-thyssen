"use client"

import Link from "next/link"
import { ArrowUpRight, ShieldCheck, Clock, Eye } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useCurrentUser } from "@/lib/use-current-user"
import { useMembership } from "@/lib/use-membership"
import { effectivePlatformTier } from "@/lib/membership"

/**
 * The first thing a client sees on the dashboard overview: which platform
 * membership they are on (PRO or Avant-Garde). The EFFECTIVE tier comes from
 * the membership grant first (so a newly activated upgrade reflects
 * immediately) and falls back to the signed-in user's account badge. An
 * in-flight upgrade (pending approval / awaiting deposit validation) is shown
 * as a status chip instead of "Active".
 */
export function PlatformTierBanner() {
  const user = useCurrentUser()
  const { membership } = useMembership()
  const tier = effectivePlatformTier(user.accountBadge, membership)
  const TierIcon = tier.icon
  const isVisitor = tier.id === "visitor"

  const upgradeInFlight =
    membership?.tier === "avantgarde" &&
    (membership.status === "pending" || membership.status === "approved")
  const upgradeLabel =
    membership?.status === "approved" ? "Upgrade approved — securing deposit" : "Upgrade pending"

  return (
    <section
      aria-label="Your platform membership"
      className={cn(
        "relative overflow-hidden rounded-xl border p-5 sm:p-6",
        tier.premium
          ? "border-primary/40 bg-primary/10"
          : "border-border bg-card",
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              "flex h-14 w-14 shrink-0 items-center justify-center rounded-xl",
              tier.premium ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
            )}
          >
            <TierIcon className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Your platform membership
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold leading-tight text-foreground sm:text-3xl">
                {tier.label}
              </h2>
              {upgradeInFlight ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500">
                  <Clock className="h-3 w-3" />
                  {upgradeLabel}
                </span>
              ) : isVisitor ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500">
                  <Eye className="h-3 w-3" />
                  Read-only trial
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-success">
                  <ShieldCheck className="h-3 w-3" />
                  Active
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">{tier.tagline}</p>
          </div>
        </div>

        <div className="shrink-0">
          <Button
            asChild
            variant={tier.premium ? "outline" : "default"}
            className="w-full sm:w-auto"
          >
            <Link href="/dashboard/plans">
              {upgradeInFlight
                ? "View upgrade status"
                : isVisitor
                  ? "Upgrade to PRO or Avant-Garde"
                  : tier.id === "pro"
                    ? "Upgrade to Avant-Garde"
                    : "Manage membership"}
              <ArrowUpRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
