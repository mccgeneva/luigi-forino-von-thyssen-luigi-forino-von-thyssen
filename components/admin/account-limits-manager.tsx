"use client"

import { useEffect, useState } from "react"
import { Gauge, Infinity as InfinityIcon, Save, Loader2 } from "lucide-react"
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
import { fetchAccountLimits, updateAccountLimitsAdmin, type AccountLimits } from "@/app/actions/account-limits"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

function fmt(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function AccountLimitsManager({ passcode }: { passcode: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<AccountLimits | null>(null)

  const [dailyUnlimited, setDailyUnlimited] = useState(false)
  const [dailyAmount, setDailyAmount] = useState("")
  const [monthlyUnlimited, setMonthlyUnlimited] = useState(false)
  const [monthlyAmount, setMonthlyAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")

  const applyLimits = (l: AccountLimits) => {
    setSaved(l)
    setDailyUnlimited(l.dailyLimitUnlimited)
    setDailyAmount(l.dailyLimitUnlimited ? "" : String(l.dailyLimitAmount || ""))
    setMonthlyUnlimited(l.monthlyVolumeUnlimited)
    setMonthlyAmount(l.monthlyVolumeUnlimited ? "" : String(l.monthlyVolumeAmount || ""))
    setCurrency(l.currency || "EUR")
  }

  useEffect(() => {
    let active = true
    fetchAccountLimits()
      .then((l) => active && applyLimits(l))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  const save = async () => {
    setSaving(true)
    const res = await updateAccountLimitsAdmin({
      passcode,
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
    toast.success("Account limits updated", {
      description: "The new Daily Limit and Monthly Volume now apply to all users.",
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
            Set the Daily Limit and Monthly Volume shown on every customer&apos;s account. These are platform-wide —
            one value applies to all users. Turn on <span className="font-medium">Unlimited</span> for either figure to
            remove the cap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
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
                  {dailyUnlimited ? "Shown as “Unlimited” on every account." : "Maximum outbound value per day."}
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
                    ? "Shown as “Unlimited” on every account."
                    : "Maximum cumulative value per calendar month."}
                </p>
              </div>

              {saved && (
                <p className="text-[11px] text-muted-foreground">
                  Currently live for all users — Daily:{" "}
                  <span className="font-medium text-foreground">
                    {saved.dailyLimitUnlimited ? "Unlimited" : fmt(saved.dailyLimitAmount, saved.currency)}
                  </span>{" "}
                  · Monthly:{" "}
                  <span className="font-medium text-foreground">
                    {saved.monthlyVolumeUnlimited ? "Unlimited" : fmt(saved.monthlyVolumeAmount, saved.currency)}
                  </span>
                </p>
              )}

              <Button onClick={save} disabled={saving} className="w-full gap-2">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save limits for all users
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
