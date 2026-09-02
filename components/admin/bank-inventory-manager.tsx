"use client"

import { useEffect, useMemo, useState } from "react"
import { Layers, Search, Loader2, Check, Plus, Trash2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { PARTNER_BANKS, type BankRegion, BANK_REGIONS } from "@/lib/partner-banks"
import {
  getBankInventoryAdmin,
  setBankAvailabilityAdmin,
  type BankAvailability,
} from "@/app/actions/bank-inventory"
import {
  listPartnerBanksAdmin,
  addPartnerBankAdmin,
  removePartnerBankAdmin,
  type AdminBankRow,
} from "@/app/actions/gateway-banks"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

type InventoryMap = Map<string, BankAvailability>
const keyOf = (bankKey: string, currency: string) => `${bankKey}::${currency}`

export function BankInventoryManager() {
  const [inventory, setInventory] = useState<InventoryMap>(new Map())
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [region, setRegion] = useState<BankRegion | "all">("all")
  // Currently selected bank key — settings only render for this one bank.
  const [selectedKey, setSelectedKey] = useState<string>("")
  // Draft capacity inputs keyed by bank::currency so typing doesn't fight state.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Live directory (built-in baseline + database-added banks). Seeded with the
  // compiled baseline so the picker is populated instantly, then replaced with
  // the merged directory so admin-added banks are configurable here too.
  const [allBanks, setAllBanks] = useState<AdminBankRow[]>(
    PARTNER_BANKS.map((b) => ({ ...b, source: "built-in" as const })),
  )
  const [addOpen, setAddOpen] = useState(false)

  const applyInventory = (rows: BankAvailability[]) => {
    const map: InventoryMap = new Map()
    for (const row of rows) map.set(keyOf(row.bankKey, row.currency), row)
    setInventory(map)
  }

  const loadDirectory = () => {
    listPartnerBanksAdmin(ADMIN_PASSCODE).then((res) => {
      if (res.ok) setAllBanks(res.banks)
    })
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      getBankInventoryAdmin(ADMIN_PASSCODE).then((res) => {
        if (!active) return
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        applyInventory(res.inventory)
      }),
      listPartnerBanksAdmin(ADMIN_PASSCODE).then((res) => {
        if (active && res.ok) setAllBanks(res.banks)
      }),
    ]).finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  const banks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allBanks.filter((b) => {
      if (region !== "all" && b.region !== region) return false
      if (!q) return true
      return (
        b.name.toLowerCase().includes(q) ||
        b.country.toLowerCase().includes(q) ||
        b.currencies.some((c) => c.toLowerCase().includes(q))
      )
    })
  }, [search, region, allBanks])

  // The bank whose settings panel is open. Cleared automatically when it falls
  // outside the current search/region filters so the panel never shows a bank
  // the admin can no longer see in the dropdown.
  const selectedBank = useMemo(
    () => banks.find((b) => b.key === selectedKey) ?? null,
    [banks, selectedKey],
  )

  useEffect(() => {
    if (selectedKey && !banks.some((b) => b.key === selectedKey)) {
      setSelectedKey("")
    }
  }, [banks, selectedKey])

  const save = async (
    bankKey: string,
    currency: string,
    patch: { enabled?: boolean; capacity?: number },
  ) => {
    const k = keyOf(bankKey, currency)
    setSavingKey(k)
    const res = await setBankAvailabilityAdmin(ADMIN_PASSCODE, bankKey, currency, patch)
    setSavingKey(null)
    if (!res.ok) {
      toast.error(res.error)
      // Revert any draft to the authoritative value.
      setDrafts((d) => {
        const next = { ...d }
        delete next[k]
        return next
      })
      return
    }
    applyInventory(res.inventory)
    setDrafts((d) => {
      const next = { ...d }
      delete next[k]
      return next
    })
    const bankName = allBanks.find((b) => b.key === bankKey)?.name ?? bankKey
    toast.success("Account pool updated", {
      description: `${bankName} · ${currency}`,
    })
  }

  const removeBank = async (bankKey: string, bankName: string) => {
    if (!confirm(`Remove ${bankName} from the partner-bank directory? Clients will no longer be able to request an account there.`)) {
      return
    }
    const res = await removePartnerBankAdmin(ADMIN_PASSCODE, bankKey)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setSelectedKey("")
    loadDirectory()
    toast.success("Bank removed", { description: bankName })
  }

  const totals = useMemo(() => {
    let pools = 0
    let enabled = 0
    let capacity = 0
    let allocated = 0
    for (const row of inventory.values()) {
      pools += 1
      if (row.enabled) enabled += 1
      capacity += row.capacity
      allocated += row.allocated
    }
    return { pools, enabled, capacity, allocated, remaining: Math.max(0, capacity - allocated) }
  }, [inventory])

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          <Layers className="h-5 w-5 text-primary" />
          Partner Bank Availability &amp; Capacity
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
            <Badge variant="secondary" className="bg-secondary text-foreground">
              {totals.enabled}/{totals.pools} pools enabled
            </Badge>
            <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {totals.remaining.toLocaleString("en-US")} accounts available
            </Badge>
          </span>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Control which partner banks can issue accounts and how many remain in each currency pool.
          Clients only see, and the approval flow only allocates from, enabled pools with spare
          capacity.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bank, country, or currency"
              className="pl-9"
            />
          </div>
          <Select value={region} onValueChange={(v) => setRegion(v as BankRegion | "all")}>
            <SelectTrigger className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {BANK_REGIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setAddOpen(true)} className="sm:w-auto">
            <Plus className="mr-1.5 h-4 w-4" /> Add bank
          </Button>
        </div>

        {/* Bank picker — settings only open for the chosen bank */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">Select a bank to configure</label>
          <Select value={selectedKey} onValueChange={setSelectedKey} disabled={loading}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={loading ? "Loading banks…" : "Choose a partner bank…"} />
            </SelectTrigger>
            <SelectContent>
              {banks.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No banks match your filters.
                </div>
              ) : (
                banks.map((bank) => (
                  <SelectItem key={bank.key} value={bank.key}>
                    {bank.name} · {bank.country}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading account pools…
          </div>
        ) : !selectedBank ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
            <Layers className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No bank selected</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Pick a partner bank from the dropdown above to view and edit its currency pools,
              availability, and capacity.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {[selectedBank].map((bank) => (
              <div key={bank.key} className="rounded-lg border border-border bg-secondary/20 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-semibold text-foreground">{bank.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {bank.country} · {bank.bic}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="bg-secondary text-muted-foreground">
                      {bank.region}
                    </Badge>
                    {bank.source === "custom" ? (
                      <>
                        <Badge
                          variant="secondary"
                          className="bg-primary/15 text-primary"
                        >
                          Added by you
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={() => void removeBank(bank.key, bank.name)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                        </Button>
                      </>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Built-in
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid gap-2">
                  {bank.currencies.map((currency) => {
                    const k = keyOf(bank.key, currency)
                    const row = inventory.get(k)
                    const enabled = row?.enabled ?? true
                    const capacity = row?.capacity ?? 0
                    const allocated = row?.allocated ?? 0
                    const remaining = row?.remaining ?? Math.max(0, capacity - allocated)
                    const isSaving = savingKey === k
                    const draft = drafts[k]
                    const exhausted = enabled && remaining <= 0

                    return (
                      <div
                        key={currency}
                        className={cn(
                          "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/60 bg-card px-3 py-2",
                          !enabled && "opacity-70",
                        )}
                      >
                        <span className="w-12 font-mono text-sm font-semibold text-foreground">
                          {currency}
                        </span>

                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Switch
                            checked={enabled}
                            disabled={isSaving}
                            onCheckedChange={(checked) =>
                              save(bank.key, currency, { enabled: checked })
                            }
                            aria-label={`${enabled ? "Disable" : "Enable"} ${bank.name} ${currency} issuance`}
                          />
                          <span className={enabled ? "text-foreground" : ""}>
                            {enabled ? "Enabled" : "Disabled"}
                          </span>
                        </label>

                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">Capacity</span>
                          <Input
                            type="number"
                            min={allocated}
                            inputMode="numeric"
                            disabled={isSaving}
                            value={draft ?? String(capacity)}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [k]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                            }}
                            onBlur={() => {
                              if (draft === undefined) return
                              const value = Number.parseInt(draft, 10)
                              if (!Number.isFinite(value) || String(value) === String(capacity)) {
                                setDrafts((d) => {
                                  const next = { ...d }
                                  delete next[k]
                                  return next
                                })
                                return
                              }
                              save(bank.key, currency, { capacity: value })
                            }}
                            className="h-9 w-24"
                          />
                        </div>

                        <span className="text-sm text-muted-foreground">
                          {allocated.toLocaleString("en-US")} issued ·{" "}
                          <span
                            className={cn(
                              "font-semibold",
                              exhausted
                                ? "text-rose-600 dark:text-rose-400"
                                : "text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {remaining.toLocaleString("en-US")} available
                          </span>
                        </span>

                        <span className="ml-auto flex items-center text-xs text-muted-foreground">
                          {isSaving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : exhausted ? (
                            <Badge
                              variant="secondary"
                              className="bg-rose-500/15 text-rose-600 dark:text-rose-400"
                            >
                              Pool exhausted
                            </Badge>
                          ) : !enabled ? (
                            <Badge variant="secondary" className="bg-secondary text-muted-foreground">
                              Closed to new issuance
                            </Badge>
                          ) : (
                            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <Check className="h-3.5 w-3.5" /> Accepting
                            </span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AddBankDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={(key) => {
          loadDirectory()
          setSelectedKey(key)
        }}
      />
    </Card>
  )
}

function AddBankDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdded: (key: string) => void
}) {
  const [name, setName] = useState("")
  const [country, setCountry] = useState("")
  const [countryCode, setCountryCode] = useState("")
  const [bic, setBic] = useState("")
  const [region, setRegion] = useState<BankRegion>("Europe")
  const [currencies, setCurrencies] = useState("EUR, USD")
  const [nationalBankCode, setNationalBankCode] = useState("")
  const [saving, setSaving] = useState(false)

  const reset = () => {
    setName("")
    setCountry("")
    setCountryCode("")
    setBic("")
    setRegion("Europe")
    setCurrencies("EUR, USD")
    setNationalBankCode("")
  }

  const submit = async () => {
    setSaving(true)
    const res = await addPartnerBankAdmin(ADMIN_PASSCODE, {
      name,
      country,
      countryCode,
      bic,
      region,
      currencies: currencies
        .split(/[,\s]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
      nationalBankCode: nationalBankCode.replace(/[^0-9A-Za-z]/g, "").trim() || undefined,
    })
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Bank added", { description: `${name} · ${country}` })
    reset()
    onOpenChange(false)
    onAdded(res.bank.key)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a partner bank</DialogTitle>
          <DialogDescription>
            Stored in the database and available immediately — no redeploy needed. The BIC country
            (characters 5–6) must match the country code so generated IBANs stay routable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ab-name">Bank name</Label>
            <Input id="ab-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Banco Example" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ab-country">Country</Label>
              <Input id="ab-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Spain" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ab-cc">Country code</Label>
              <Input
                id="ab-cc"
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="ES"
                maxLength={2}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ab-bic">BIC / SWIFT</Label>
            <Input
              id="ab-bic"
              value={bic}
              onChange={(e) => setBic(e.target.value.toUpperCase())}
              placeholder="EXAMESMMXXX"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ab-region">Region</Label>
            <Select value={region} onValueChange={(v) => setRegion(v as BankRegion)}>
              <SelectTrigger id="ab-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BANK_REGIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ab-ccy">Currencies</Label>
            <Input
              id="ab-ccy"
              value={currencies}
              onChange={(e) => setCurrencies(e.target.value)}
              placeholder="EUR, USD, GBP"
            />
            <p className="text-xs text-muted-foreground">Comma- or space-separated ISO codes.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ab-nbc">National bank code (optional)</Label>
            <Input
              id="ab-nbc"
              value={nationalBankCode}
              onChange={(e) => setNationalBankCode(e.target.value)}
              placeholder="e.g. UK sort code 040004"
            />
            <p className="text-xs text-muted-foreground">
              The bank&apos;s real domestic clearing code (UK sort code, DE Bankleitzahl, etc.). It is
              embedded into generated IBANs so the bank code is a real, existing one. Leave blank to
              use a random code (the IBAN stays checksum-valid but its bank code may not exist).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Add bank
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
