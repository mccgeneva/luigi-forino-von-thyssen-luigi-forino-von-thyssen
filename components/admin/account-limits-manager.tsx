"use client"

import { useEffect, useMemo, useState } from "react"
import { Gauge, Infinity as InfinityIcon, Save, Loader2, RotateCcw, Users, User } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { type AccountLimits } from "@/app/actions/account-limits"
import { type SelectableClient } from "@/app/actions/admin-users"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]
const GLOBAL_TARGET = "global"

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function AccountLimitsManager({ passcode }: { passcode: string }) {
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [target, setTarget] = useState<string>(GLOBAL_TARGET)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [saved, setSaved] = useState<AccountLimits | null>(null)
  const [hasOverride, setHasOverride] = useState(false)

  const [dailyUnlimited, setDailyUnlimited] = useState(false)
  const [dailyAmount, setDailyAmount] = useState("")
  const [monthlyUnlimited, setMonthlyUnlimited] = useState(false)
  const [monthlyAmount, setMonthlyAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")

  const isGlobal = target === GLOBAL_TARGET
  const targetClient = useMemo(() => clients.find((c) => c.id === target), [clients, target])
  const targetName = useMemo(() => {
    if (isGlobal) return "all users"
    if (!targetClient) return "this user"
    return targetClient.company?.trim() || targetClient.fullName?.trim() || targetClient.email
  }, [isGlobal, targetClient])

  const applyLimits = (l: AccountLimits) => {
    setSaved(l)
    setDailyUnlimited(l.dailyLimitUnlimited)
    setDailyAmount(l.dailyLimitUnlimited ? "" : String(l.dailyLimitAmount || ""))
    setMonthlyUnlimited(l.monthlyVolumeUnlimited)
    setMonthlyAmount(l.monthlyVolumeUnlimited ? "" : String(l.monthlyVolumeAmount || ""))
    setCurrency(l.currency || "EUR")
  }

  const [loadError, setLoadError] = useState<string | null>(null)

  // Load the selectable clients + the chosen target's limits in one round-trip,
  // via the /api/admin/account-limits route. We deliberately do NOT call the
  // Server Actions directly: those POST to /dashboard/* and are intercepted by
  // the session proxy, which 401s them whenever it judges the signed session
  // meta cookie stale/idle (very common in the embedded preview) even though
  // the admin identity is still valid — which silently left the client picker
  // empty. The API route is not behind that proxy and returns real JSON.
  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)
    ;(async () => {
      try {
        const resp = await fetch("/api/admin/account-limits", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "load", pin: passcode, targetId: target }),
        })
        const data = await resp.json()
        if (!active) return
        if (data.ok) {
          if (Array.isArray(data.clients) && data.clients.length) setClients(data.clients)
          applyLimits(data.limits)
          setHasOverride(!!data.hasOverride)
        } else if (data.reason === "unauthorized") {
          setLoadError("Administrator session not recognized. Re-open the panel with your passcode.")
          if (Array.isArray(data.clients)) setClients(data.clients)
        } else {
          setLoadError(data.error || "Could not load account limits.")
        }
      } catch {
        if (active) setLoadError("Could not reach the server. Please try again.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [passcode, target])

  const save = async () => {
    setSaving(true)
    let res: { ok: true; limits: AccountLimits } | { ok: false; error?: string }
    try {
      const resp = await fetch("/api/admin/account-limits", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "save",
          pin: passcode,
          targetId: target,
          targetName: isGlobal ? undefined : targetName,
          dailyLimitAmount: Number(dailyAmount) || 0,
          dailyLimitUnlimited: dailyUnlimited,
          monthlyVolumeAmount: Number(monthlyAmount) || 0,
          monthlyVolumeUnlimited: monthlyUnlimited,
          currency,
        }),
      })
      res = await resp.json()
    } catch {
      res = { ok: false, error: "Could not reach the server. Please try again." }
    }
    setSaving(false)
    if (!res.ok) {
      toast.error("Couldn't save limits", { description: res.error })
      return
    }
    applyLimits(res.limits)
    if (!isGlobal) setHasOverride(true)
    toast.success("Account limits updated", {
      description: isGlobal
        ? "The new Daily Limit and Monthly Volume now apply to all users."
        : `The new limits now apply to ${targetName}.`,
    })
  }

  const resetOverride = async () => {
    if (isGlobal) return
    setResetting(true)
    let res: { ok: true; limits: AccountLimits } | { ok: false; error?: string }
    try {
      const resp = await fetch("/api/admin/account-limits", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "clear", pin: passcode, targetId: target, targetName }),
      })
      res = await resp.json()
    } catch {
      res = { ok: false, error: "Could not reach the server. Please try again." }
    }
    setResetting(false)
    if (!res.ok) {
      toast.error("Couldn't reset limits", { description: res.error })
      return
    }
    applyLimits(res.limits)
    setHasOverride(false)
    toast.success("Reset to platform default", {
      description: `${targetName} now inherits the platform-wide limits.`,
    })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-primary" />
            Account Limits
          </CardTitle>
          <CardDescription>
            Choose who these limits apply to, then set the Daily Limit and Monthly Volume shown on the account. Pick{" "}
            <span className="font-medium">All users</span> for the platform-wide default, or a specific user to override
            it just for them. Turn on <span className="font-medium">Unlimited</span> for either figure to remove the cap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Target selector */}
          <div className="space-y-1.5">
            <Label>Apply limits to</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_TARGET}>
                  <span className="flex items-center gap-2">
                    <Users className="h-3.5 w-3.5" />
                    All users (platform default)
                  </span>
                </SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="flex items-center gap-2">
                      <User className="h-3.5 w-3.5" />
                      {c.company?.trim() || c.fullName?.trim() || c.email}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isGlobal && (
              <p className="text-[11px] text-muted-foreground">
                {hasOverride
                  ? `${targetName} has a custom override. Editing here changes only their limits.`
                  : `${targetName} currently inherits the platform default. Saving will create a custom override for them.`}
              </p>
            )}
            {loadError && <p className="text-[11px] text-destructive">{loadError}</p>}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading current limits…
            </div>
          ) : (
            <>
              {/* Currency */}
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Daily limit */}
              <div className="space-y-2 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="daily-amount" className="text-sm font-medium">
                    Daily Limit
                  </Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <InfinityIcon className="h-3.5 w-3.5" />
                    Unlimited
                    <Switch checked={dailyUnlimited} onCheckedChange={setDailyUnlimited} />
                  </label>
                </div>
                <MoneyInput
                  id="daily-amount"
                  placeholder="0.00"
                  value={dailyUnlimited ? "" : dailyAmount}
                  onValueChange={setDailyAmount}
                  disabled={dailyUnlimited}
                />
                <p className="text-[11px] text-muted-foreground">
                  {dailyUnlimited ? "Shown as “Unlimited” on the account." : "Maximum outbound value per day."}
                </p>
              </div>

              {/* Monthly volume */}
              <div className="space-y-2 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="monthly-amount" className="text-sm font-medium">
                    Monthly Volume
                  </Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <InfinityIcon className="h-3.5 w-3.5" />
                    Unlimited
                    <Switch checked={monthlyUnlimited} onCheckedChange={setMonthlyUnlimited} />
                  </label>
                </div>
                <MoneyInput
                  id="monthly-amount"
                  placeholder="0.00"
                  value={monthlyUnlimited ? "" : monthlyAmount}
                  onValueChange={setMonthlyAmount}
                  disabled={monthlyUnlimited}
                />
                <p className="text-[11px] text-muted-foreground">
                  {monthlyUnlimited
                    ? "Shown as “Unlimited” on the account."
                    : "Maximum cumulative value per calendar month."}
                </p>
              </div>

              {saved && (
                <p className="text-[11px] text-muted-foreground">
                  {isGlobal ? "Currently live for all users" : `Currently live for ${targetName}`} — Daily:{" "}
                  <span className="font-medium text-foreground">
                    {saved.dailyLimitUnlimited ? "Unlimited" : fmt(saved.dailyLimitAmount, saved.currency)}
                  </span>{" "}
                  · Monthly:{" "}
                  <span className="font-medium text-foreground">
                    {saved.monthlyVolumeUnlimited ? "Unlimited" : fmt(saved.monthlyVolumeAmount, saved.currency)}
                  </span>
                </p>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={save} disabled={saving || resetting} className="w-full gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {isGlobal ? "Save limits for all users" : `Save limits for ${targetName}`}
                </Button>
                {!isGlobal && hasOverride && (
                  <Button
                    onClick={resetOverride}
                    disabled={saving || resetting}
                    variant="outline"
                    className="w-full gap-2 sm:w-auto"
                  >
                    {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Reset to default
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
