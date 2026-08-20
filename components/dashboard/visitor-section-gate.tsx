"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Lock, ArrowUpRight } from "lucide-react"
import { useTierCapabilities } from "@/lib/use-tier-capabilities"

/**
 * Sections a Visitor (pre-subscription, read-only) account may fully use.
 *
 * Everything else in the dashboard is blocked for a Visitor with an upgrade
 * prompt. A Visitor can:
 *  - `/dashboard`            — the account overview (read-only balances)
 *  - `/dashboard/nqai`       — the NQAi Co-Pilot console
 *  - `/dashboard/bankeka`    — the Bankeka Messenger
 *  - `/dashboard/payments`   — Payments & Payees (money in / out)
 *  - `/dashboard/send`       — Send Money (outgoing)
 *  - `/dashboard/plans`      — Plans & Pricing, so they can actually upgrade
 *
 * Prefixes also match nested routes (e.g. `/dashboard/payments/anything`), while
 * the overview must match exactly so it doesn't whitelist the whole dashboard.
 */
const VISITOR_ALLOWED_EXACT = new Set<string>(["/dashboard"])
const VISITOR_ALLOWED_PREFIXES = [
  "/dashboard/nqai",
  "/dashboard/bankeka",
  "/dashboard/payments",
  "/dashboard/send",
  "/dashboard/plans",
]

export function isVisitorAllowedPath(pathname: string): boolean {
  if (VISITOR_ALLOWED_EXACT.has(pathname)) return true
  return VISITOR_ALLOWED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Gate that wraps the dashboard page content.
 *
 * For PRO / Avant-Garde (or any non-read-only tier) it is a transparent
 * pass-through. For a Visitor it renders the page only when the current route is
 * in the Visitor-allowed set; otherwise it replaces the entire section with a
 * blocking upgrade card so every button and action in that section is
 * unreachable until the account is upgraded.
 *
 * This is the UI enforcement layer. Money-out / trading / instrument server
 * actions independently enforce the same tier rules, so this can never be the
 * only thing standing between a Visitor and a restricted operation.
 */
export function VisitorSectionGate({ children }: { children: React.ReactNode }) {
  const { isVisitor } = useTierCapabilities()
  const pathname = usePathname()

  if (!isVisitor || isVisitorAllowedPath(pathname)) {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-card p-6 text-center shadow-lg sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15">
          <Lock className="h-7 w-7 text-amber-500" aria-hidden />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-balance text-foreground">
          Upgrade to unlock this section
        </h2>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
          Your account is a <span className="font-medium text-foreground">Visitor</span> plan, which includes
          payments in and out, the NQAi console and Bankeka Messenger. To use this section, upgrade to a{" "}
          <span className="font-medium text-foreground">PRO</span> or{" "}
          <span className="font-medium text-foreground">Avant-Garde</span> account.
        </p>
        <Link
          href="/dashboard/plans"
          className="mt-6 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Upgrade to PRO or Avant-Garde
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
