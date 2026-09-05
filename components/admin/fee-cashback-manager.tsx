"use client"

import { useEffect, useMemo, useState } from "react"
import { Percent, Save, Loader2, Trash2, Users, Globe, Calculator } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CASHBACK_PRODUCTS,
  cashbackProductLabel,
  formatCashbackPct,
  applyCashback,
  normalizeCashbackRate,
  type CashbackProduct,
  type CashbackRule,
} from "@/lib/fee-cashback"

interface Client {
  id: string
  fullName: string
  company?: string
  email: string
}

const GLOBAL = "global"
const ALL_PRODUCTS = "all"

export function FeeCashbackManager({ passcode }: { passcode: string }) {
  const [rules, setRules] = useState<CashbackRule[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // New/edit rule form
  const [scopeUser, setScopeUser] = useState<string>(GLOBAL)
  const [scopeProduct, setScopeProduct] = useState<string>(ALL_PRODUCTS)
  const [ratePct, setRatePct] = useState("")
  const [sample, setSample] = useState("100000")

  const load = async () => {
    setLoading(true)
    try {
      const resp = await fetch("/api/fee-cashback", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: passcode, op: "list" }),
      })
      const data = await resp.json()
      if (data.ok) {
        setRules(Array.isArray(data.rules) ? data.rules : [])
        setClients(Array.isArray(data.clients) ? data.clients : [])
      } else if (data.reason === "unauthorized") {
        toast.error("Administrator authorization failed", { description: "Re-open the panel with your passcode." })
      }
    } catch {
      toast.error("Couldn't load cashback rules", { description: "Please try again." })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passcode])

  const clientLabel = (id: string) => {
    const c = clients.find((x) => x.id === id)
    if (!c) return id
    return c.company ? `${c.fullName} · ${c.company}` : c.fullName
  }

  const rateFraction = useMemo(() => normalizeCashbackRate((Number(ratePct) || 0) / 100), [ratePct])

  const sampleQuote = useMemo(
    () => applyCashback(Number(sample.replace(/[^0-9.]/g, "")) || 0, rateFraction),
    [sample, rateFraction],
  )

  const saveRule = async (
    userId: string | null,
    product: CashbackProduct | null,
    rate: number,
    label: string,
  ) => {
    setSaving(true)
    try {
      const resp = await fetch("/api/fee-cashback", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: passcode, op: "save", userId, product, rate }),
      })
      const data = await resp.json()
      if (data.ok) {
        toast.success("Cashback saved", { description: `${label} → ${formatCashbackPct(rate)} cashback.` })
        await load()
      } else if (data.reason === "unauthorized") {
        toast.error("Authorization failed", { description: "Re-open the panel with your passcode." })
      } else {
        toast.error("Couldn't save", { description: data.error || "Please try again." })
      }
    } catch {
      toast.error("Couldn't reach the server", { description: "Please try again." })
    } finally {
      setSaving(false)
    }
  }

  const removeRule = async (userId: string | null, product: CashbackProduct | null) => {
    setSaving(true)
    try {
      const resp = await fetch("/api/fee-cashback", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: passcode, op: "delete", userId, product }),
      })
      const data = await resp.json()
      if (data.ok) {
        toast.success("Cashback rule removed")
        await load()
      } else {
        toast.error("Couldn't remove", { description: data.error || "Please try again." })
      }
    } catch {
      toast.error("Couldn't reach the server", { description: "Please try again." })
    } finally {
      setSaving(false)
    }
  }

  const submitForm = () => {
    if (!ratePct.trim() || rateFraction <= 0) {
      toast.error("Enter a cashback percentage between 0 and 100.")
      return
    }
    const userId = scopeUser === GLOBAL ? null : scopeUser
    const product = scopeProduct === ALL_PRODUCTS ? null : (scopeProduct as CashbackProduct)
    const scopeLabel = `${userId ? clientLabel(userId) : "All users"} · ${cashbackProductLabel(product)}`
    void saveRule(userId, product, rateFraction, scopeLabel)
  }

  // Split rules into global (no user) vs per-user for display.
  const globalRules = rules.filter((r) => r.userId == null)
  const userRules = rules.filter((r) => r.userId != null)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Percent className="h-5 w-5 text-primary" />
            Fee Cashback
          </CardTitle>
          <CardDescription>
            Authorise a cashback percentage that reduces platform fees. The customer is charged the standard fee minus
            the cashback. Set it globally, per product type, or per user — the most specific rule wins.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Add / update form */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Customer</Label>
              <Select value={scopeUser} onValueChange={setScopeUser}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GLOBAL}>All users (global)</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.company ? `${c.fullName} · ${c.company}` : c.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Fee type</Label>
              <Select value={scopeProduct} onValueChange={setScopeProduct}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PRODUCTS}>All fee types</SelectItem>
                  {CASHBACK_PRODUCTS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {scopeProduct === ALL_PRODUCTS
                  ? "Applies to every fee stream unless a more specific rule overrides it."
                  : CASHBACK_PRODUCTS.find((p) => p.id === scopeProduct)?.description}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Cashback %</Label>
              <Input
                inputMode="decimal"
                placeholder="e.g. 20"
                value={ratePct}
                onChange={(e) => setRatePct(e.target.value.replace(/[^0-9.]/g, ""))}
              />
            </div>
            <Button onClick={submitForm} disabled={saving} className="w-full gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save cashback rule
            </Button>

            {/* Live sample */}
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Calculator className="h-4 w-4 text-primary" />
                Sample on a standard fee
              </Label>
              <MoneyInput placeholder="100,000" value={sample} onValueChange={setSample} />
              <div className="space-y-0.5 text-xs">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Standard fee</span>
                  <span className="text-foreground">{sampleQuote.originalFee.toLocaleString("en-US")}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Cashback ({formatCashbackPct(sampleQuote.cashbackRate)})</span>
                  <span className="text-emerald-600">−{sampleQuote.cashbackAmount.toLocaleString("en-US")}</span>
                </div>
                <div className="flex items-center justify-between border-t border-border pt-1 font-medium">
                  <span className="text-foreground">Net fee charged</span>
                  <span className="text-foreground">{sampleQuote.netFee.toLocaleString("en-US")}</span>
                </div>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading cashback rules…
            </div>
          ) : (
            <div className="space-y-4">
              <RuleGroup
                icon={<Globe className="h-4 w-4 text-primary" />}
                title="Global rules"
                empty="No global cashback set — customers pay standard fees unless a rule applies."
                rules={globalRules}
                labelFor={() => "All users"}
                onDelete={removeRule}
                disabled={saving}
              />
              <RuleGroup
                icon={<Users className="h-4 w-4 text-primary" />}
                title="Per-customer rules"
                empty="No per-customer overrides."
                rules={userRules}
                labelFor={(r) => (r.userId ? clientLabel(r.userId) : "All users")}
                onDelete={removeRule}
                disabled={saving}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RuleGroup({
  icon,
  title,
  empty,
  rules,
  labelFor,
  onDelete,
  disabled,
}: {
  icon: React.ReactNode
  title: string
  empty: string
  rules: CashbackRule[]
  labelFor: (r: CashbackRule) => string
  onDelete: (userId: string | null, product: CashbackProduct | null) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      {rules.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <div
              key={`${r.userId ?? "global"}:${r.product ?? "all"}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{labelFor(r)}</p>
                <p className="text-xs text-muted-foreground">
                  {cashbackProductLabel(r.product)} · {formatCashbackPct(r.rate)} cashback
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(r.userId, r.product)}
                disabled={disabled}
                aria-label="Remove rule"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
