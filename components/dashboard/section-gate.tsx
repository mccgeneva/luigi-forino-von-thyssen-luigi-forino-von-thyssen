"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Lock, ShieldAlert, ArrowUpRight } from "lucide-react"
import { useTierCapabilities } from "@/lib/use-tier-capabilities"
import { useSectionAccess } from "@/lib/use-current-user"
import { evaluateSectionAccess } from "@/lib/dashboard-sections"

/**
 * Gate that wraps the dashboard page content and enforces, per section:
 *
 *  - the TIER default — a Visitor may only use payments in/out, the NQAi
 *    console, Bankeka Messenger, the overview and Plans; everything else is
 *    locked behind an upgrade prompt, while PRO / Avant-Garde may use anything;
 *  - the per-user ADMINISTRATOR override — the admin can force any section
 *    "locked" (blocked for that user regardless of tier) or "unlocked" (allowed
 *    regardless of tier, e.g. letting a Visitor fully operate in one section).
 *
 * The override always wins over the tier default (see
 * `evaluateSectionAccess`). When a section is not allowed the entire section is
 * replaced with a blocking card so every button/action inside is unreachable:
 *  - admin-locked → "You are not allowed to access this section" (contact admin)
 *  - tier-locked  → upgrade-to-PRO/Avant-Garde prompt
 *
 * This is the UI enforcement layer. Money-out / trading / instrument server
 * actions independently enforce the tier rules, so this is never the only thing
 * standing between a Visitor and a restricted operation.
 */
export function SectionGate({ children }: { children: React.ReactNode }) {
  const { isVisitor } = useTierCapabilities()
  const overrides = useSectionAccess()
  const pathname = usePathname()

  const access = evaluateSectionAccess(pathname, isVisitor, overrides)

  if (access === "allowed") {
    return <>{children}</>
  }

  // A Visitor NEVER sees the "restricted by an administrator" card — for them
  // any blocked section (tier-locked OR admin-locked) resolves to the upgrade
  // prompt, so the ask is always "upgrade to PRO / Avant-Garde". Only PRO /
  // Avant-Garde accounts see the administrator-restriction message.
  if (access === "admin-locked" && !isVisitor) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 text-center shadow-lg sm:p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-destructive/15">
            <ShieldAlert className="h-7 w-7 text-destructive" aria-hidden />
          </div>
          <h2 className="mt-5 text-lg font-semibold text-balance text-foreground">
            You are not allowed to access this section
          </h2>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
            Access to this section has been restricted for your account by an administrator. If you
            believe this is a mistake, please contact your relationship manager or the administrator
            to have it unlocked.
          </p>
          <Link
            href="/dashboard/support"
            className="mt-6 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Contact support
          </Link>
        </div>
      </div>
    )
  }

  // Reached when the section is tier-locked, OR when it is admin-locked for a
  // Visitor (handled above) — in both cases a Visitor is prompted to upgrade.
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
