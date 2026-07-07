"use client"

import { useState } from "react"
import { ShieldAlert, LogOut, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Sticky banner shown while an administrator is "signed in as" a client for
 * maintenance. Makes the impersonation impossible to miss (so the admin never
 * mistakes the client session for their own) and offers one-click return to the
 * admin session — no password needed, since the original admin session is
 * restored server-side from the signed impersonation cookie.
 */
export function ImpersonationBanner({
  adminName,
  targetName,
}: {
  adminName: string
  targetName: string
}) {
  const [returning, setReturning] = useState(false)

  // Return-to-admin goes through the impersonation Route Handler (NOT a Server
  // Action, which is silently rejected on production/in-app webviews). On
  // success we hard-navigate so the restored admin session cookie takes effect.
  const handleReturn = async () => {
    setReturning(true)
    try {
      const res = await fetch("/api/admin/impersonate", { method: "DELETE", cache: "no-store" })
      const data = (await res.json().catch(() => null)) as { ok?: boolean; redirect?: string } | null
      window.location.href = data?.redirect || "/dashboard/admin"
    } catch {
      // Even on transport failure, send the admin somewhere sane rather than hang.
      window.location.href = "/dashboard/admin"
    }
  }

  const busy = returning

  return (
    <div className="sticky top-0 z-50 border-b border-amber-500/40 bg-amber-500/15 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-amber-200">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-pretty">
            <span className="font-semibold">Maintenance mode</span> — signed in as{" "}
            <span className="font-semibold">{targetName}</span>. You are viewing and acting on this
            client&apos;s account as {adminName}.
          </p>
        </div>
        <Button
          size="sm"
          onClick={handleReturn}
          disabled={busy}
          className="w-full shrink-0 bg-amber-500 text-amber-950 hover:bg-amber-400 sm:w-auto"
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="mr-2 h-4 w-4" />
          )}
          {busy ? "Returning…" : "Return to admin"}
        </Button>
      </div>
    </div>
  )
}
