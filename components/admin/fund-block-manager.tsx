"use client"

import { useEffect, useMemo, useState } from "react"
import { Lock, Loader2, ShieldAlert, Undo2, Ban } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  listBlockedFundsForUserAdmin,
  blockUserFundsAdmin,
  releaseBlockedFundsAdmin,
  withdrawBlockedFundsAdmin,
  type BlockedFund,
} from "@/app/actions/fund-blocks"
import { getActiveUserId } from "@/lib/user-scope"
import { useLedger } from "@/lib/ledger-store"

const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "SGD"]

const fmt = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

export function FundBlockManager() {
  const { refresh: refreshLiveLedger } = useLedger()

  const [targetUserId, setTargetUserId] = useState("")
  const [clients, setClients] = useState<SelectableClient[]>([])

  const [blocks, setBlocks] = useState<BlockedFund[]>([])
  const [available, setAvailable] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)

  // Block form
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [reason, setReason] = useState("")
  const [blocking, setBlocking] = useState(false)

  // Per-block busy + a confirm dialog for the destructive withdrawal.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [withdrawTarget, setWithdrawTarget] = useState<BlockedFund | null>(null)

  useEffect(() => {
    let active = true
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        if (active && list.length) setClients(list)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const selectedClient = clients.find((c) => c.id === targetUserId)
  const hasTarget = !!targetUserId && !!selectedClient
  const targetUser = selectedClient ?? { fullName: "No client selected", company: "—", email: "" }

  // Refresh the signed-in client's live balance if the admin is acting on self.
  const refreshLiveIfSelf = () => {
    if (getActiveUserId() === targetUserId) void refreshLiveLedger()
  }

  const load = (userId: string) => {
    if (!userId) {
      setBlocks([])
      setAvailable({})
      return
    }
    setLoading(true)
    listBlockedFundsForUserAdmin(ADMIN_PASSCODE, userId)
      .then((res) => {
        if (!res.ok) {
          toast.error(res.error)
          setBlocks([])
          setAvailable({})
          return
        }
        setBlocks(res.blocks)
        setAvailable(res.available)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(targetUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId])

  const availableForCurrency = available[currency] ?? 0

  const orderedAvailable = useMemo(
    () =>
      Object.entries(available)
        .filter(([, v]) => Math.abs(v) > 0.005)
        .sort((a, b) => a[0].localeCompare(b[0])),
    [available],
  )

  const totalBlocked = useMemo(() => {
    const map = new Map<string, number>()
    for (const b of blocks) map.set(b.currency, (map.get(b.currency) ?? 0) + b.amount)
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [blocks])

  const applyResult = (res: Awaited<ReturnType<typeof blockUserFundsAdmin>>) => {
    if (!res.ok) {
      toast.error(res.error)
      return false
    }
    setBlocks(res.blocks)
    setAvailable(res.available)
    refreshLiveIfSelf()
    return true
  }

  const handleBlock = async () => {
    if (!hasTarget) {
      toast.error("Select a client account first.")
      return
    }
    const numeric = Number(amount)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error("Enter a valid amount greater than zero.")
      return
    }
    if (!reason.trim()) {
      toast.error("A reason is required to block funds.")
      return
    }
    setBlocking(true)
    const res = await blockUserFundsAdmin(ADMIN_PASSCODE, targetUserId, numeric, currency, reason.trim())
    setBlocking(false)
    if (applyResult(res)) {
      toast.success("Funds blocked", {
        description: `${fmt(numeric, currency)} reserved on ${targetUser.fullName}'s Master Account.`,
      })
      setAmount("")
      setReason("")
    }
  }

  const handleRelease = async (block: BlockedFund) => {
    setBusyId(block.id)
    const res = await releaseBlockedFundsAdmin(ADMIN_PASSCODE, targetUserId, block.id)
    setBusyId(null)
    if (applyResult(res)) {
      toast.success("Funds released", {
        description: `${fmt(block.amount, block.currency)} returned to ${targetUser.fullName}'s available balance.`,
      })
    }
  }

  const handleWithdraw = async () => {
    if (!withdrawTarget) return
    const block = withdrawTarget
    setBusyId(block.id)
    const res = await withdrawBlockedFundsAdmin(ADMIN_PASSCODE, targetUserId, block.id)
    setBusyId(null)
    setWithdrawTarget(null)
    if (applyResult(res)) {
      toast.success("Funds permanently withdrawn", {
        description: `${fmt(block.amount, block.currency)} removed from ${targetUser.fullName}'s Master Account.`,
      })
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
            <Lock className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Fund Blocking Controls</CardTitle>
            <p className="text-sm text-muted-foreground text-pretty">
              Block (reserve) any amount from a client&apos;s Master Account balance for an
              administrative reason. Blocked funds cannot be spent by the client until you release
              them back or permanently withdraw them.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Target account */}
        <div className="space-y-2">
          <Label>Client account</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.fullName} — {u.company} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading account…
            </p>
          )}
        </div>

        {/* Available + blocked snapshot */}
        {hasTarget && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-secondary/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Available balance</p>
              {orderedAvailable.length === 0 ? (
                <p className="text-sm text-muted-foreground">No available balance.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {orderedAvailable.map(([cur, val]) => (
                    <Badge key={cur} variant="outline" className="text-sm font-semibold">
                      {fmt(val, cur)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Currently blocked</p>
              {totalBlocked.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {totalBlocked.map(([cur, val]) => (
                    <Badge key={cur} className="bg-amber-500/15 text-amber-500 text-sm font-semibold">
                      {fmt(val, cur)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Block form */}
        <div className="space-y-4 rounded-lg border border-border p-4">
          <p className="text-sm font-medium text-foreground">Block funds</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="fb-amount">Amount</Label>
              <Input
                id="fb-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!hasTarget}
              />
              {hasTarget && (
                <p className="text-[11px] text-muted-foreground">
                  {fmt(availableForCurrency, currency)} available to block
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="fb-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="fb-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fb-reason">Reason / purpose (required)</Label>
            <Textarea
              id="fb-reason"
              placeholder="e.g. Compliance review pending — funds reserved by order of the compliance desk."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={!hasTarget}
              rows={2}
            />
            <p className="text-[11px] text-muted-foreground">
              The client sees this reason under their balance while the funds are blocked.
            </p>
          </div>
          <Button
            onClick={handleBlock}
            disabled={!hasTarget || blocking}
            className="w-full sm:w-auto"
          >
            {blocking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
            Block funds
          </Button>
        </div>

        {/* Active blocks */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Active blocks</p>
          {!hasTarget ? (
            <p className="text-sm text-muted-foreground">Select a client to view their blocks.</p>
          ) : blocks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              No funds are currently blocked on this account.
            </p>
          ) : (
            <ul className="space-y-2">
              {blocks.map((b) => (
                <li key={b.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-amber-500">{fmt(b.amount, b.currency)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{b.reason}</p>
                      <p className="mt-1 text-[10px] font-mono text-muted-foreground/70">
                        Ref {b.id} · {fmtDate(b.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRelease(b)}
                        disabled={busyId === b.id}
                      >
                        {busyId === b.id ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Release
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setWithdrawTarget(b)}
                        disabled={busyId === b.id}
                      >
                        <Ban className="mr-1.5 h-3.5 w-3.5" />
                        Withdraw
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      {/* Permanent withdrawal confirm */}
      <Dialog open={withdrawTarget !== null} onOpenChange={(open) => !open && setWithdrawTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              Permanently withdraw funds?
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {withdrawTarget
                ? `${fmt(withdrawTarget.amount, withdrawTarget.currency)} will be permanently removed from ${targetUser.fullName}'s Master Account. This cannot be undone — use "Release" instead if you intend to return the funds.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleWithdraw}
              disabled={!!withdrawTarget && busyId === withdrawTarget.id}
            >
              {withdrawTarget && busyId === withdrawTarget.id ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Ban className="mr-2 h-4 w-4" />
              )}
              Withdraw permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
