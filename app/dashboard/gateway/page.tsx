"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Landmark,
  Building2,
  Globe2,
  Layers,
  Clock,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  ArrowDownToLine,
  Wallet,
  Info,
  ShieldCheck,
  Banknote,
  Plus,
  Search,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { useCurrentUser } from "@/lib/use-current-user"
import {
  useGateway,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_KEYS,
  GATEWAY_CURRENCIES,
  PARTNER_BANKS,
  BANK_REGIONS,
  reconciledTotal,
  pendingFundingTotal,
  type GatewayAccount,
  type GatewayAccountType,
  type GatewayStatus,
} from "@/lib/gateway-store"
import { formatIban, countrySupportsIban } from "@/lib/iban"
import type { PartnerBank } from "@/lib/partner-banks"
import { getGatewayConfig, type GatewayConfig } from "@/app/actions/gateway-config"
import { requestGatewayAccountWithFee } from "@/app/actions/gateway"
import { getPartnerBankDirectory } from "@/app/actions/gateway-banks"
import { GATEWAY_ACCOUNT_FEE } from "@/lib/gateway-catalog"

const typeIcons: Record<GatewayAccountType, typeof Building2> = {
  virtual_iban: Landmark,
  collection: Layers,
  multicurrency: Globe2,
}

const statusConfig: Record<
  GatewayStatus,
  { label: string; icon: typeof Clock; color: string }
> = {
  pending: {
    label: "Pending Approval",
    icon: Clock,
    color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  },
  active: {
    label: "Active",
    icon: CheckCircle2,
    color: "bg-green-500/10 text-green-500 border-green-500/20",
  },
  rejected: {
    label: "Declined",
    icon: XCircle,
    color: "bg-red-500/10 text-red-500 border-red-500/20",
  },
  closed: {
    label: "Closed",
    icon: XCircle,
    color: "bg-secondary text-muted-foreground border-border",
  },
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(value?: string) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

// Small copy-to-clipboard field used to surface assigned bank coordinates.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be unavailable; ignore
    }
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm text-foreground">{value}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={copy}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tint,
}: {
  label: string
  value: React.ReactNode
  hint: string
  icon: typeof Banknote
  tint: string
}) {
  return (
    <Card className="border-border bg-card py-0">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className={cn("shrink-0 rounded-lg p-3", tint)}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function GatewayPage() {
  const log = useActivityLog()
  const user = useCurrentUser()
  const { accounts, hydrated, refresh } = useGateway()
  const [activeTab, setActiveTab] = useState("accounts")

  // Request form state
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<GatewayAccountType>("virtual_iban")
  const [currency, setCurrency] = useState("EUR")
  const [bankKey, setBankKey] = useState("")
  const [purpose, setPurpose] = useState("")
  const [bankQuery, setBankQuery] = useState("")
  const [countryFilter, setCountryFilter] = useState("all")
  const [submitting, setSubmitting] = useState(false)

  // The one-time fee charged to the Master Account on each new gateway account.
  const feeLabel = `€${GATEWAY_ACCOUNT_FEE.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Global gateway configuration: which account types and currencies an
  // administrator has left enabled platform-wide. Fails open while loading.
  const [config, setConfig] = useState<GatewayConfig>({
    disabledAccountTypes: [],
    disabledCurrencies: [],
  })
  useEffect(() => {
    let active = true
    getGatewayConfig().then((c) => {
      if (active) setConfig(c)
    })
    return () => {
      active = false
    }
  }, [])

  // Live partner-bank directory, read from the database at runtime. Seeded with
  // the compiled baseline so the picker is populated instantly and never empty,
  // then replaced with the merged directory (baseline + admin-added banks) so
  // banks an administrator adds appear WITHOUT a redeploy.
  const [directory, setDirectory] = useState<PartnerBank[]>(PARTNER_BANKS)
  useEffect(() => {
    let active = true
    getPartnerBankDirectory().then((banks) => {
      if (active && banks.length) setDirectory(banks)
    })
    return () => {
      active = false
    }
  }, [])

  // Directory-local resolver (replaces the compiled-constant helper so custom
  // banks resolve too).
  const resolveBank = (key: string | undefined) => directory.find((b) => b.key === key)

  // Only offer account types and currencies the administrator has enabled.
  const enabledTypes = useMemo(
    () => ACCOUNT_TYPE_KEYS.filter((k) => !config.disabledAccountTypes.includes(k)),
    [config.disabledAccountTypes],
  )
  const enabledCurrencies = useMemo(
    () => GATEWAY_CURRENCIES.filter((c) => !config.disabledCurrencies.includes(c)),
    [config.disabledCurrencies],
  )

  // Keep the selected type/currency valid as the enabled sets change so the
  // form never submits an option the administrator has disabled.
  useEffect(() => {
    if (enabledTypes.length && !enabledTypes.includes(type)) setType(enabledTypes[0])
  }, [enabledTypes, type])
  useEffect(() => {
    if (enabledCurrencies.length && !enabledCurrencies.includes(currency)) {
      onCurrencyChange(enabledCurrencies[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledCurrencies, currency])

  // Partner-bank directory: filter by name/country/BIC/currency, then group by region.
  const banksByRegion = useMemo(() => {
    const q = bankQuery.trim().toLowerCase()
    const matches = directory.filter((b) => {
      if (!q) return true
      return (
        b.name.toLowerCase().includes(q) ||
        b.country.toLowerCase().includes(q) ||
        b.bic.toLowerCase().includes(q) ||
        b.currencies.some((c) => c.toLowerCase().includes(q))
      )
    })
    return BANK_REGIONS.map((region) => ({
      region,
      banks: matches.filter((b) => b.region === region),
    })).filter((g) => g.banks.length > 0)
  }, [bankQuery, directory])

  // Distinct countries in the directory, for the country filter dropdown.
  const bankCountries = useMemo(
    () => Array.from(new Set(directory.map((b) => b.country))).sort((a, b) => a.localeCompare(b)),
    [directory],
  )

  // A bank can issue an account in ANY currency the platform offers — the
  // currency is the customer's independent choice, not a per-bank restriction.
  // So every partner bank is selectable regardless of the chosen currency; the
  // list is only optionally narrowed by the country filter / free-text search.
  const eligibleBanks = useMemo(() => {
    const q = bankQuery.trim().toLowerCase()
    return [...directory]
      .filter((b) => countryFilter === "all" || b.country === countryFilter)
      .filter(
        (b) =>
          !q ||
          b.name.toLowerCase().includes(q) ||
          b.country.toLowerCase().includes(q) ||
          b.bic.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [directory, countryFilter, bankQuery])

  // Currency and bank are independent: changing the currency never clears the
  // selected bank.
  const onCurrencyChange = (next: string) => {
    setCurrency(next)
  }

  const myAccounts = accounts
  const activeAccounts = useMemo(() => myAccounts.filter((a) => a.status === "active"), [myAccounts])
  const pendingAccounts = useMemo(() => myAccounts.filter((a) => a.status === "pending"), [myAccounts])

  const totals = useMemo(() => {
    const byCurrency = new Map<string, { reconciled: number; pending: number }>()
    for (const a of activeAccounts) {
      const cur = byCurrency.get(a.currency) ?? { reconciled: 0, pending: 0 }
      cur.reconciled += reconciledTotal(a)
      cur.pending += pendingFundingTotal(a)
      byCurrency.set(a.currency, cur)
    }
    return [...byCurrency.entries()]
  }, [activeAccounts])

  const submit = async () => {
    if (submitting) return
    if (!bankKey) {
      toast.error("Please select your preferred banking partner.")
      return
    }
    if (!purpose.trim()) {
      toast.error("Please describe the purpose of the account.")
      return
    }

    setSubmitting(true)
    // The server authoritatively re-checks affordability, charges the one-time
    // fee to the Master Account, and only then creates the pending request. An
    // insufficient balance is rejected here in real time — no account, no charge.
    const result = await requestGatewayAccountWithFee({
      type,
      currency,
      preferredBankKey: bankKey,
      purpose: purpose.trim(),
    })
    setSubmitting(false)

    if (!result.ok) {
      toast.error("Request declined", { description: result.error })
      return
    }

    const created = result.account
    await refresh()
    log({
      action: `Requested ${ACCOUNT_TYPES[type].label} (${currency}) via Payment Gateway — ${feeLabel} fee charged`,
      category: "Payment Gateway",
      details: {
        summary: `${user.fullName} (${user.company}) submitted a request for a new ${ACCOUNT_TYPES[type].label} denominated in ${currency} with preferred partner bank ${resolveBank(bankKey)?.name}. Purpose: ${purpose.trim()}. A one-time ${feeLabel} setup fee was debited from the Master Account (ref ${result.feeReference}). The request ${created.id} is pending Administrator approval and partner-bank assignment.`,
        referenceId: created.id,
        accountType: ACCOUNT_TYPES[type].label,
        currency,
        preferredBank: resolveBank(bankKey)?.name,
        fee: feeLabel,
        ledgerReference: result.feeReference,
        status: "Pending Approval",
      },
    })
    toast.success("Account request submitted", {
      description: `${feeLabel} setup fee charged. ${created.id} is pending Administrator approval.`,
    })
    setPurpose("")
    setBankKey("")
    setOpen(false)
    setActiveTab("accounts")
  }

  const totalReconciled = totals.reduce((s, [, t]) => s + t.reconciled, 0)
  const totalPending = totals.reduce((s, [, t]) => s + t.pending, 0)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5">
            <Landmark className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground text-balance">Payment Gateway</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground text-pretty">
              Apply for dedicated collection, multi-currency and virtual IBAN accounts routed through MCC
              Capital&apos;s principal partner banks. Incoming funds are reconciled into your Master Account.
            </p>
          </div>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="shrink-0">
              <Plus className="mr-2 h-4 w-4" />
              Request Account
            </Button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[90dvh] flex-col gap-0 sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Request a Gateway Account</DialogTitle>
              <DialogDescription>
                Choose the account type and currency. The Administrator will assign partner-bank
                coordinates on approval.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 space-y-4 overflow-y-auto py-2 pr-1">
              <div className="space-y-2">
                <Label>Account type</Label>
                <div className="grid gap-2">
                  {enabledTypes.map((key) => {
                    const Icon = typeIcons[key]
                    const selected = type === key
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setType(key)}
                        className={cn(
                          "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                          selected
                            ? "border-primary bg-primary/5"
                            : "border-border bg-card hover:border-primary/40",
                        )}
                      >
                        <div
                          className={cn(
                            "rounded-md p-2",
                            selected ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{ACCOUNT_TYPES[key].label}</p>
                          <p className="text-xs text-muted-foreground">{ACCOUNT_TYPES[key].blurb}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="gw-currency">Currency</Label>
                  <Select value={currency} onValueChange={onCurrencyChange}>
                    <SelectTrigger id="gw-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledCurrencies.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gw-country">Filter by country</Label>
                  <Select
                    value={countryFilter}
                    onValueChange={(v) => {
                      setCountryFilter(v)
                      // Clear the selected bank if it no longer matches the filter.
                      if (v !== "all" && resolveBank(bankKey)?.country !== v) setBankKey("")
                    }}
                  >
                    <SelectTrigger id="gw-country">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All countries</SelectItem>
                      {bankCountries.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="gw-bank">Preferred banking partner</Label>
                  <span className="text-xs font-medium text-muted-foreground">
                    {eligibleBanks.length} of {directory.length} banks
                  </span>
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={bankQuery}
                    onChange={(e) => setBankQuery(e.target.value)}
                    placeholder="Search by bank name, country or BIC"
                    className="pl-9"
                    aria-label="Search partner banks"
                  />
                </div>
                <Select value={bankKey} onValueChange={setBankKey}>
                  <SelectTrigger id="gw-bank">
                    <SelectValue placeholder="Select a partner bank" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleBanks.length === 0 ? (
                      <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                        No banks match your search.
                      </div>
                    ) : (
                      eligibleBanks.map((bank) => (
                        <SelectItem key={bank.key} value={bank.key}>
                          {bank.name} ({bank.country})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {bankKey
                    ? countrySupportsIban(resolveBank(bankKey)?.countryCode)
                      ? `${resolveBank(bankKey)?.name} will issue your account in ${currency} with a dedicated IBAN, subject to Administrator approval.`
                      : `${resolveBank(bankKey)?.name} will issue your account in ${currency}; you'll receive local account coordinates (no IBAN).`
                    : `Pick any of our ${directory.length} partner banks — your account is opened in ${currency}, the currency you selected above.`}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gw-purpose">Purpose / expected activity</Label>
                <Textarea
                  id="gw-purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="e.g. Collecting EUR settlements from European counterparties before sweeping to the Master Account."
                  rows={3}
                />
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-xs text-muted-foreground">
                  A one-time{" "}
                  <span className="font-semibold text-foreground">{feeLabel} setup fee</span> is
                  debited from your Master Account when you submit. If your available balance
                  can&apos;t cover it, the request is declined immediately and nothing is charged.
                </p>
              </div>
            </div>
            <DialogFooter className="mt-2 border-t border-border pt-4">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting}>
                {submitting ? "Processing…" : `Submit & pay ${feeLabel}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Active Accounts"
          value={activeAccounts.length}
          hint={`${pendingAccounts.length} pending approval`}
          icon={Landmark}
          tint="bg-primary/10 text-primary"
        />
        <StatCard
          label="Reconciled to Master"
          value={
            totals.length <= 1 ? (
              formatMoney(totalReconciled, totals[0]?.[0] ?? "EUR")
            ) : (
              <span className="flex flex-col gap-0.5 text-lg">
                {totals.map(([cur, t]) => (
                  <span key={cur}>{formatMoney(t.reconciled, cur)}</span>
                ))}
              </span>
            )
          }
          hint="Funds swept into your Master Account"
          icon={Wallet}
          tint="bg-green-500/10 text-green-500"
        />
        <StatCard
          label="Awaiting Reconciliation"
          value={
            totals.length <= 1 ? (
              formatMoney(totalPending, totals[0]?.[0] ?? "EUR")
            ) : (
              <span className="flex flex-col gap-0.5 text-lg">
                {totals.map(([cur, t]) => (
                  <span key={cur}>{formatMoney(t.pending, cur)}</span>
                ))}
              </span>
            )
          }
          hint="Received at partner bank, pending sweep"
          icon={ArrowDownToLine}
          tint="bg-orange-500/10 text-orange-400"
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="accounts">
            My Accounts
            {myAccounts.length > 0 && (
              <Badge variant="outline" className="ml-2">
                {myAccounts.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="banks">Partner Banks</TabsTrigger>
          <TabsTrigger value="about">How It Works</TabsTrigger>
        </TabsList>

        {/* My accounts */}
        <TabsContent value="accounts" className="mt-6 space-y-4">
          {!hydrated ? (
            <Card className="border-border bg-card">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                Loading your gateway accounts…
              </CardContent>
            </Card>
          ) : myAccounts.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="flex flex-col items-center justify-center gap-3 p-12 text-center">
                <div className="rounded-full bg-secondary p-3">
                  <Landmark className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  No gateway accounts yet. Request your first collection, multi-currency or virtual IBAN
                  account to start receiving funds.
                </p>
                <Button onClick={() => setOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Request Account
                </Button>
              </CardContent>
            </Card>
          ) : (
            myAccounts.map((account) => (
              <AccountCard key={account.id} account={account} directory={directory} />
            ))
          )}
        </TabsContent>

        {/* Partner banks */}
        <TabsContent value="banks" className="mt-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-base">Principal Partner Banks</CardTitle>
              <CardDescription>
                Incoming gateway accounts and outgoing payouts are routed through these correspondent
                institutions. The Administrator assigns the appropriate bank per account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={bankQuery}
                  onChange={(e) => setBankQuery(e.target.value)}
                  placeholder="Search by bank, country, BIC or currency"
                  className="pl-9"
                  aria-label="Search partner banks"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {`${directory.length} correspondent banks across ${BANK_REGIONS.length} regions`}
              </p>
              {banksByRegion.length === 0 ? (
                <p className="rounded-lg border border-border bg-secondary/30 p-6 text-center text-sm text-muted-foreground">
                  No partner banks match your search.
                </p>
              ) : (
                banksByRegion.map((group) => (
                  <div key={group.region} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.region}
                      </h3>
                      <Badge variant="secondary" className="text-[10px]">
                        {group.banks.length}
                      </Badge>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {group.banks.map((bank) => (
                        <div
                          key={bank.key}
                          className="flex items-start justify-between gap-3 rounded-lg border border-border bg-secondary/30 p-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="rounded-md bg-primary/10 p-2">
                              <Building2 className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-foreground">{bank.name}</p>
                              <p className="text-xs text-muted-foreground">{bank.country}</p>
                              <p className="mt-1 font-mono text-[11px] text-muted-foreground">{bank.bic}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-1">
                            {bank.currencies.map((c) => (
                              <Badge key={c} variant="outline" className="text-[10px]">
                                {c}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* How it works */}
        <TabsContent value="about" className="mt-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-base">How the Payment Gateway works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              {[
                {
                  icon: Plus,
                  title: "1. Request an account",
                  body: "Choose a collection, multi-currency or virtual IBAN account and the currency you need to receive in.",
                },
                {
                  icon: ShieldCheck,
                  title: "2. Administrator approval",
                  body: "MCC Capital reviews the request and assigns dedicated coordinates (IBAN, BIC and a unique remittance reference) at the appropriate partner bank.",
                },
                {
                  icon: ArrowDownToLine,
                  title: "3. Receive funds",
                  body: "Share your assigned coordinates with payers. Incoming funds land at the partner bank under your unique reference.",
                },
                {
                  icon: Wallet,
                  title: "4. Reconciliation to Master Account",
                  body: "Once funds are confirmed, MCC Capital reconciles them and credits the amount to your MCC Master Account.",
                },
              ].map((step) => (
                <div key={step.title} className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <step.icon className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{step.title}</p>
                    <p className="text-pretty">{step.body}</p>
                  </div>
                </div>
              ))}
              <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-xs">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  All gateway activity is logged to the MCC Capital trader desk for compliance and audit.
                </span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// A single gateway account: shows status, assigned coordinates (when active),
// and the funding/reconciliation history feeding the Master Account.
function AccountCard({ account, directory }: { account: GatewayAccount; directory: PartnerBank[] }) {
  const Icon = typeIcons[account.type]
  const status = statusConfig[account.status]
  const StatusIcon = status.icon
  const bank = directory.find((b) => b.key === account.coordinates?.partnerBankKey)
  const reconciled = reconciledTotal(account)
  const pending = pendingFundingTotal(account)

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">
                {ACCOUNT_TYPES[account.type].label} · {account.currency}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Ref {account.id} · Requested {formatDate(account.submittedAt)}
              </p>
            </div>
          </div>
          <Badge variant="outline" className={cn("gap-1", status.color)}>
            <StatusIcon className="h-3 w-3" />
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground text-pretty">{account.purpose}</p>

        {account.status === "rejected" && account.rejectionReason && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
            Declined: {account.rejectionReason}
          </div>
        )}

        {account.status === "pending" && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-500">
            Awaiting Administrator approval and partner-bank assignment.
          </div>
        )}

        {account.status === "active" && account.coordinates && (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Building2 className="h-4 w-4 text-primary" />
                Assigned coordinates {bank ? `· ${bank.name}` : ""}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {account.coordinates.scheme === "iban" && account.coordinates.iban ? (
                  <CopyField label="IBAN" value={formatIban(account.coordinates.iban)} />
                ) : (
                  account.coordinates.routingNumber && (
                    <CopyField
                      label={bank?.countryCode === "US" ? "ABA routing number" : "Bank code"}
                      value={account.coordinates.routingNumber}
                    />
                  )
                )}
                <CopyField label="BIC / SWIFT" value={account.coordinates.bic} />
                {account.coordinates.accountNumber && (
                  <CopyField label="Account number" value={account.coordinates.accountNumber} />
                )}
                <CopyField label="Remittance reference" value={account.coordinates.reference} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-secondary/40 p-3">
                <p className="text-[11px] text-muted-foreground">Reconciled to Master</p>
                <p className="mt-1 text-sm font-semibold text-green-500">
                  {formatMoney(reconciled, account.currency)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/40 p-3">
                <p className="text-[11px] text-muted-foreground">Awaiting reconciliation</p>
                <p className="mt-1 text-sm font-semibold text-orange-400">
                  {formatMoney(pending, account.currency)}
                </p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-foreground">Funding history</p>
              {account.funding.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                  No funds received yet. Share your coordinates above with payers to start receiving.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border bg-secondary/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                    <span>Payer / reference</span>
                    <span className="text-right">Amount</span>
                    <span className="text-right">Status</span>
                  </div>
                  <div className="divide-y divide-border">
                    {account.funding.map((f) => (
                      <div
                        key={f.id}
                        className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{f.payer}</p>
                          <p className="truncate text-muted-foreground">{f.reference}</p>
                          {f.originalCurrency && f.originalAmount != null && (
                            <p className="truncate text-[11px] text-muted-foreground">
                              {`FX: ${formatMoney(f.originalAmount, f.originalCurrency)} @ ${(f.fxRate ?? 0).toFixed(4)}`}
                              {f.fxFee ? ` · fee ${formatMoney(f.fxFee, f.currency)}` : ""}
                            </p>
                          )}
                        </div>
                        <span className="text-right font-medium text-foreground">
                          {formatMoney(f.amount, f.currency)}
                        </span>
                        <span className="text-right">
                          {f.reconciled ? (
                            <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500">
                              Reconciled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-orange-500/20 bg-orange-500/10 text-orange-400">
                              Pending
                            </Badge>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
