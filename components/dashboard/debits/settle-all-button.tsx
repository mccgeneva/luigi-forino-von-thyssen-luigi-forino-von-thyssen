"use client"

import { useState } from "react"
import { Loader2, Layers } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { DebitFacility } from "@/lib/debit-schedule"
import { terminateDebitFacility } from "@/app/actions/debit-settlement"

/**
 * One-tap cascade: settle & terminate EVERY open facility back-to-back. Each is
 * settled instantly when it fits within the authorized overdraft; any that would
 * take the account beyond the overdraft ceiling is automatically sent to the
 * administrator for approval. Runs sequentially so the running balance is
 * evaluated correctly after each settlement.
 */
export function SettleAllButton({
  facilities,
  onSettled,
}: {
  facilities: DebitFacility[]
  onSettled: () => void
}) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const targets = facilities
    .filter((f) => !f.closed && f.settleable)
    .map((f) => ({
      kind: f.kind,
      id: f.kind === "treasury" ? f.id : f.approvalId,
      title: f.title,
    }))
    .filter((t): t is { kind: DebitFacility["kind"]; id: string; title: string } => !!t.id)

  if (targets.length < 2) return null

  const runAll = async () => {
    setRunning(true)
    let settled = 0
    let pending = 0
    let failed = 0
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      setProgress({ done: i, total: targets.length })
      try {
        const res = await terminateDebitFacility(t.kind, t.id)
        if (res.ok) settled += 1
        else if ("pendingApproval" in res && res.pendingApproval) pending += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
    setProgress({ done: targets.length, total: targets.length })
    setRunning(false)
    setOpen(false)
    setProgress(null)
    onSettled()

    const parts: string[] = []
    if (settled > 0) parts.push(`${settled} settled`)
    if (pending > 0) parts.push(`${pending} sent for administrator approval`)
    if (failed > 0) parts.push(`${failed} could not be settled`)
    const summary = parts.join(" · ") || "Nothing to settle"
    if (failed > 0) toast.error(`Cascade complete — ${summary}.`)
    else if (pending > 0) toast.info(`Cascade complete — ${summary}.`)
    else toast.success(`All debits settled — ${summary}.`)
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Layers className="h-3.5 w-3.5" />
        Settle all ({targets.length})
      </Button>

      <AlertDialog open={open} onOpenChange={(o) => (!running ? setOpen(o) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Settle &amp; terminate all debits?</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              This settles and closes every open facility ({targets.length}) back-to-back, debiting each payoff from your
              master account. Facilities that fit within your authorized overdraft are settled instantly; any that would
              take you beyond it are sent to the administrator for approval — nothing is charged for those until approved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void runAll()
              }}
              disabled={running}
              className="gap-1.5"
            >
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {running && progress
                ? `Settling ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                : `Settle all ${targets.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
