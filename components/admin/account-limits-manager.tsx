"use client"

import { useEffect, useMemo, useState } from "react"
import { Gauge, Infinity as InfinityIcon, Save, Loader2, RotateCcw, Users, User } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  fetchAccountLimitsForTarget,
  updateAccountLimitsAdmin,
  clearAccountLimitsAdmin,
  type AccountLimits,
} from "@/app/actions/account-limits"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"

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

  // Load the selectable clients once.
  useEffect(() => {
    let active = true
    listSelectableClients(passcode)
      .then((list) => active && setClients(list))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [passcode])

  // Load the chosen target's limits whenever the target changes.
  useEffect(() => {
    let active = true
    setLoading(true)
    fetchAccountLimitsForTarget(passcode, target)
      .then((res) => {
        if (!active) return
        if (res.ok) {
          applyLimits(res.limits)
          setHasOverride(res.hasOverride)
        }
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [passcode, target])

  const save = async () => {
    setSaving(true)
    const res = await updateAccountLimitsAdmin({
      passcode,
      targetId: target,
      targetName: isGlobal ? undefined : targetName,
      dailyLimitAmount: Number(dailyAmount) || 0,
      dailyLimitUnlimited: dailyUnlimited,
      monthlyVolumeAmount: Number(monthlyAmount) || 0,
      monthlyVolumeUnlimited: monthlyUnlimited,
      currency,
    })
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
    const res = await clearAccountLimitsAdmin(passcode, target, targetName)
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
                <Input
                  id="daily-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={dailyUnlimited ? "" : dailyAmount}
                  onChange={(e) => setDailyAmount(e.target.value.replace(/[^\d.]/g, ""))}
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
                <Input
                  id="monthly-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={monthlyUnlimited ? "" : monthlyAmount}
                  onChange={(e) => setMonthlyAmount(e.target.value.replace(/[^\d.]/g, ""))}
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
