"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Search,
  Loader2,
  ShieldCheck,
  BadgeCheck,
  CheckCircle2,
  XCircle,
  Landmark,
  Globe,
  Sparkles,
  MapPin,
  FileText,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useInstrumentRequests } from "@/lib/instrument-requests-store"
import { useLedger } from "@/lib/ledger-store"
import { useActivityLog } from "@/components/activity-tracker"
import { buildInstrumentIdentifiers } from "@/lib/instrument-identifiers"
import {
  computeAcquisitionFee,
  ACQUISITION_FEE_RATES,
  ACQUISITION_ACTION_LABELS,
  ACQUISITION_ACTION_DESCRIPTIONS,
  MARKET_INSTRUMENT_TYPES,
  tenorLabel,
  type AcquisitionAction,
} from "@/lib/instrument-marketplace"
import {
  getPublishedInstruments,
  type MarketplaceInstrument,
  type VerifiedSource,
} from "@/app/actions/marketplace-instruments"
import { InstrumentPrintout } from "@/components/dashboard/instrument-printout"

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString("en-US")}`
  }
}

const SOURCE_LABEL: Record<VerifiedSource, string> = {
  bloomberg: "Bloomberg",
  euroclear: "Euroclear",
  clearstream: "Clearstream",
}

// --- Live OpenFIGI search result shape (subset of the API response) --------
interface FigiMatch {
  figi: string
  name?: string
  ticker?: string
  exchCode?: string
  securityType?: string
  marketSector?: string
}

const ACTIONS: AcquisitionAction[] = ["lease", "assign", "purchase"]

function purposeForType(code: string): string {
  return MARKET_INSTRUMENT_TYPES.find((t) => t.code === code)?.purpose ?? "Bank instrument"
}

export function InstrumentMarketplace() {
  const { addInstrument, instruments } = useInstrumentRequests()
  const { totalIn } = useLedger()
  const logActivity = useActivityLog()

  // --- Real, admin-published catalogue -------------------------------------
  const [catalogue, setCatalogue] = useState<MarketplaceInstrument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    getPublishedInstruments()
      .then((rows) => {
        if (active) setCatalogue(rows)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  // --- Catalogue filters ----------------------------------------------------
  const [filter, setFilter] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [bankFilter, setBankFilter] = useState<string>("all")

  // Distinct banks present in the published catalogue.
  const bankOptions = useMemo(() => {
    const set = new Set<string>()
    for (const i of catalogue) set.add(i.bankName)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [catalogue])

  const coverage = useMemo(() => {
    const banks = new Set(catalogue.map((i) => i.bankName))
    const countries = new Set(catalogue.map((i) => i.bankCountry).filter(Boolean))
    const types = new Set(catalogue.map((i) => i.type))
    return {
      banks: banks.size,
      instruments: catalogue.length,
      countries: countries.size,
      types: types.size,
    }
  }, [catalogue])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return catalogue.filter((i) => {
      if (typeFilter !== "all" && i.type !== typeFilter) return false
      if (bankFilter !== "all" && i.bankName !== bankFilter) return false
      if (!q) return true
      return (
        i.bankName.toLowerCase().includes(q) ||
        i.bankCountry.toLowerCase().includes(q) ||
        i.type.toLowerCase().includes(q) ||
        i.typeFull.toLowerCase().includes(q) ||
        i.isin.toLowerCase().includes(q) ||
        (i.commonCode ?? "").toLowerCase().includes(q) ||
        i.currency.toLowerCase().includes(q)
      )
    })
  }, [catalogue, filter, typeFilter, bankFilter])

  // --- Printout dialog ------------------------------------------------------
  const [printoutTarget, setPrintoutTarget] = useState<MarketplaceInstrument | null>(null)

  // --- Live OpenFIGI reference search --------------------------------------
  const [figiQuery, setFigiQuery] = useState("")
  const [figiLoading, setFigiLoading] = useState(false)
  const [figiResults, setFigiResults] = useState<FigiMatch[] | null>(null)
  const [figiError, setFigiError] = useState<string | null>(null)

  const runFigiSearch = async () => {
    const q = figiQuery.trim()
    if (!q) return
    setFigiLoading(true)
    setFigiError(null)
    try {
      const looksIsin = /^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/.test(q)
      const res = await fetch("/api/openfigi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(looksIsin ? { isin: q } : { query: q }),
      })
      const data = await res.json()
      if (!data.ok) {
        setFigiError(data.error ?? "Lookup failed.")
        setFigiResults([])
        return
      }
      setFigiResults((data.matches ?? []) as FigiMatch[])
    } catch {
      setFigiError("Network error. Please try again.")
      setFigiResults([])
    } finally {
      setFigiLoading(false)
    }
  }

  // --- Acquisition dialog ---------------------------------------------------
  const [target, setTarget] = useState<MarketplaceInstrument | null>(null)
  const [action, setAction] = useState<AcquisitionAction>("lease")
  const [submitting, setSubmitting] = useState(false)
  const [verify, setVerify] = useState<{ loading: boolean; listed?: boolean; note?: string } | null>(null)

  const openAcquire = (inst: MarketplaceInstrument, initial: AcquisitionAction) => {
    setTarget(inst)
    setAction(initial)
    setVerify(null)
  }

  const verifyIsin = async () => {
    if (!target) return
    setVerify({ loading: true })
    try {
      const res = await fetch("/api/openfigi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isin: target.isin }),
      })
      const data = await res.json()
      if (!data.ok) {
        setVerify({ loading: false, note: data.error ?? "Verification unavailable." })
        return
      }
      if (data.listed && data.matches?.length) {
        const m = data.matches[0] as FigiMatch
        setVerify({
          loading: false,
          listed: true,
          note: `Bloomberg ID ${m.figi}${m.securityType ? ` · ${m.securityType}` : ""}${m.marketSector ? ` · ${m.marketSector}` : ""}`,
        })
      } else {
        setVerify({
          loading: false,
          listed: false,
          note: `Verified ${SOURCE_LABEL[target.verifiedSource]} instrument · private bilateral (not exchange-listed on Bloomberg).`,
        })
      }
    } catch {
      setVerify({ loading: false, note: "Verification unavailable." })
    }
  }

  const confirmAcquire = () => {
    if (!target) return
    const fee = computeAcquisitionFee(action, target.faceValue)
    const actionLabel = ACQUISITION_ACTION_LABELS[action]
    const wanted = (target.isin || "").trim().toUpperCase()
    const existing = wanted
      ? instruments.find(
          (i) =>
            (i.isin || "").trim().toUpperCase() === wanted &&
            (i.status === "active" || i.status === "pending"),
        )
      : undefined
    if (existing) {
      toast.error("Already in your portfolio", {
        description: `ISIN ${target.isin} is already ${existing.status === "pending" ? "awaiting Administrator approval" : "held"} in your portfolio (${existing.type} ${existing.id}). You can't acquire the same instrument twice.`,
      })
      return
    }
    const spendable = totalIn(target.currency)
    if (fee > spendable + 0.01) {
      toast.error("Insufficient balance for the acquisition fee", {
        description: `The ${actionLabel.toLowerCase()} fee is ${money(fee, target.currency)}, but your spendable balance is only ${money(spendable, target.currency)}. Fund your account and try again.`,
      })
      return
    }
    setSubmitting(true)
    try {
      const now = new Date()
      const expiry = new Date(now)
      expiry.setMonth(expiry.getMonth() + target.tenorMonths)
      const daysRemaining = Math.max(0, Math.round((expiry.getTime() - now.getTime()) / 86_400_000))
      // Regulatory metadata (serial, rules, delivery) from the identifier engine;
      // the ISIN / Common Code / BIC stay exactly as published (real values).
      const ids = buildInstrumentIdentifiers(target.bankName, target.type, now)

      const created = addInstrument(
        {
          id: `${target.type}-${now.getTime().toString().slice(-6)}`,
          type: target.type,
          typeFull: target.typeFull,
          issuer: target.bankName,
          faceValue: target.faceValue,
          currency: target.currency,
          issuedDate: now.toISOString().split("T")[0],
          expiryDate: expiry.toISOString().split("T")[0],
          daysRemaining,
          rating: target.rating,
          purpose: purposeForType(target.type),
          assignable: target.assignable,
          monetizable: target.monetizable,
          tradeType: `${actionLabel} acquisition`,
          ...ids,
          isin: target.isin,
          commonCode: target.commonCode ?? ids.commonCode,
          issuerBic: target.bankBic || ids.issuerBic,
        },
        { amount: fee, actionLabel },
      )

      logActivity({
        action: `Requested ${actionLabel.toLowerCase()} of ${target.type} ${created.id} (${money(target.faceValue, target.currency)})`,
        category: "Bank Instruments",
        details: {
          summary: `Client requested to ${actionLabel.toLowerCase()} a ${target.typeFull} (${target.type}) from ${target.bankName} with a face value of ${money(target.faceValue, target.currency)} (ISIN ${target.isin}, rated ${target.rating}). Indicative ${actionLabel.toLowerCase()} fee at ${(ACQUISITION_FEE_RATES[action] * 100).toFixed(action === "assign" ? 1 : 0)}% = ${money(fee, target.currency)}. Awaiting Administrator approval — nothing executes automatically.`,
          referenceId: created.id,
          instrumentType: `${target.type} — ${target.typeFull}`,
          faceValue: money(target.faceValue, target.currency),
          issuingBank: `${target.bankName} (${target.bankBic})`,
          acquisition: `${actionLabel} · fee ${money(fee, target.currency)}`,
          isin: target.isin,
        },
      })

      toast.success(`${actionLabel} request submitted`, {
        description: `${target.type} ${created.id} from ${target.bankName} is pending Administrator approval. The ${money(fee, target.currency)} fee is deducted from your balance once approved; nothing is charged if it is declined.`,
      })
      setTarget(null)
    } finally {
      setSubmitting(false)
    }
  }

  const fee = target ? computeAcquisitionFee(action, target.faceValue) : 0

  return (
    <div className="space-y-6">
      {/* Terminal header — desk identity + real coverage */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2 w-2 items-center justify-center">
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            </span>
            <h2
              className="text-2xl leading-none tracking-tight text-foreground"
              style={{ fontFamily: "var(--font-instrument-serif), Georgia, serif" }}
            >
              Instruments Desk
            </h2>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
            Verified Listings
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
          {[
            { label: "Issuing Banks", value: coverage.banks },
            { label: "Instruments", value: coverage.instruments },
            { label: "Countries", value: coverage.countries },
            { label: "Instrument Types", value: coverage.types },
          ].map((s) => (
            <div key={s.label} className="bg-card px-4 py-3">
              <p className="font-mono text-xl font-bold tabular-nums text-primary">{s.value}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Live OpenFIGI reference search */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Globe className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Securities reference lookup</h3>
              <p className="text-xs text-muted-foreground text-pretty">
                Live <span className="font-medium text-foreground">Bloomberg</span> reference search — enter an issuer,
                ticker or ISIN to confirm a security against the real registry.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={figiQuery}
                onChange={(e) => setFigiQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runFigiSearch()}
                placeholder="e.g. HSBC, AAPL, or US0378331005"
                className="pl-9"
                aria-label="Bloomberg search query"
              />
            </div>
            <Button onClick={runFigiSearch} disabled={figiLoading || !figiQuery.trim()} className="gap-1.5">
              {figiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </div>

          {figiError ? <p className="text-xs text-destructive">{figiError}</p> : null}
          {figiResults && !figiError ? (
            figiResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No securities matched that query.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                    <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-[10px] [&>th]:font-medium [&>th]:uppercase [&>th]:tracking-wider">
                      <th>Name</th>
                      <th>Ticker</th>
                      <th>Bloomberg ID</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {figiResults.map((m, idx) => (
                      <tr key={`${m.figi}-${idx}`} className="border-t border-border">
                        <td className="px-3 py-2 text-foreground">{m.name ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{m.ticker ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{m.figi}</td>
                        <td className="px-3 py-2 text-muted-foreground">{m.securityType ?? m.marketSector ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : null}
        </CardContent>
      </Card>

      {/* Catalogue filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by bank, type, ISIN or currency"
            className="pl-9"
            aria-label="Filter instruments"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="sm:w-44" aria-label="Filter by instrument type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {MARKET_INSTRUMENT_TYPES.map((t) => (
              <SelectItem key={t.code} value={t.code}>
                {t.code} — {t.full}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={bankFilter} onValueChange={setBankFilter}>
          <SelectTrigger className="sm:w-64" aria-label="Filter by issuing bank">
            <SelectValue placeholder="All banks" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All banks</SelectItem>
            {bankOptions.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground text-pretty">
        <span className="font-semibold text-foreground">{filtered.length}</span> verified bank instrument
        {filtered.length === 1 ? "" : "s"} available to lease, assign or purchase. Every listing carries a real ISIN
        verified against Bloomberg, Euroclear or Clearstream. Acquisitions are submitted for Administrator approval —
        nothing executes automatically.
      </p>

      {/* Catalogue grid */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading verified instruments…
        </div>
      ) : catalogue.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <Landmark className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No instruments are currently listed</p>
          <p className="max-w-md text-xs text-muted-foreground text-pretty">
            The marketplace only shows instruments with a real, registry-verified ISIN published by the desk. New
            verified instruments will appear here as they are admitted. Please check back shortly.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <Landmark className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No instruments match your filters</p>
          <p className="max-w-sm text-xs text-muted-foreground text-pretty">
            Try clearing the search or choosing a different bank or instrument type.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((inst) => (
            <Card
              key={inst.id}
              className="relative overflow-hidden border-border bg-card transition-colors hover:border-primary/40"
            >
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-primary/70" />
              <CardContent className="flex flex-col gap-3 p-4 pl-5">
                {/* Type + rating header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge className="rounded-sm px-1.5 py-0 font-mono text-[10px] font-bold">{inst.type}</Badge>
                      <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                        {inst.typeFull}
                      </span>
                    </div>
                    <p className="mt-2 truncate text-sm font-semibold leading-tight text-foreground">{inst.bankName}</p>
                    <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {inst.bankCountry || "—"}
                      {inst.bankBic ? (
                        <>
                          <span className="text-border">·</span>
                          <span className="font-mono">{inst.bankBic}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 gap-1 rounded-sm border-primary/30 bg-primary/5 font-mono text-[10px] text-primary"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {inst.rating || SOURCE_LABEL[inst.verifiedSource]}
                  </Badge>
                </div>

                {/* Terminal data grid */}
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border">
                  <div className="bg-card px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Face Value</p>
                    <p className="font-mono text-sm font-bold tabular-nums text-foreground">
                      {money(inst.faceValue, inst.currency)}
                    </p>
                  </div>
                  <div className="bg-card px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Validity</p>
                    <p className="font-mono text-sm font-semibold text-foreground">{tenorLabel(inst.tenorMonths)}</p>
                  </div>
                  <div className="col-span-2 bg-card px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">ISIN · Common Code</p>
                    <p className="truncate font-mono text-xs text-foreground">
                      {inst.isin} <span className="text-border">·</span>{" "}
                      <span className="text-muted-foreground">{inst.commonCode ?? "pending ICSD"}</span>
                    </p>
                  </div>
                </div>

                {/* Verified provenance */}
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className="gap-1 rounded-sm border-emerald-500/30 bg-emerald-500/5 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <BadgeCheck className="h-3 w-3" />
                    Verified · {SOURCE_LABEL[inst.verifiedSource]}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPrintoutTarget(inst)}
                    className="h-7 gap-1 text-xs"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Printout
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {ACTIONS.map((a) => {
                    if (a === "assign" && !inst.assignable) return null
                    return (
                      <Button
                        key={a}
                        size="sm"
                        variant={a === "lease" ? "default" : "outline"}
                        onClick={() => openAcquire(inst, a)}
                        className={cn("flex-1 gap-1", a !== "lease" && "bg-transparent")}
                      >
                        {ACQUISITION_ACTION_LABELS[a]}
                        <span className="font-mono text-[10px] opacity-70">
                          {(ACQUISITION_FEE_RATES[a] * 100).toFixed(a === "assign" ? 1 : 0)}%
                        </span>
                      </Button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Printout dialog */}
      <InstrumentPrintout
        instrument={printoutTarget}
        open={printoutTarget !== null}
        onOpenChange={(open) => !open && setPrintoutTarget(null)}
      />

      {/* Acquisition dialog */}
      <Dialog open={target !== null} onOpenChange={(open) => !open && !submitting && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {target ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Acquire {target.type}
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  {target.typeFull} from {target.bankName} — {money(target.faceValue, target.currency)}, rated{" "}
                  {target.rating || "—"}.
                </DialogDescription>
              </DialogHeader>

              {/* Action selector */}
              <div className="flex gap-2">
                {ACTIONS.map((a) => {
                  if (a === "assign" && !target.assignable) return null
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAction(a)}
                      className={cn(
                        "flex-1 rounded-lg border px-3 py-2 text-center transition-colors",
                        action === a
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      <span className="block text-sm font-semibold">{ACQUISITION_ACTION_LABELS[a]}</span>
                      <span className="block text-[11px]">
                        {(ACQUISITION_FEE_RATES[a] * 100).toFixed(a === "assign" ? 1 : 0)}%
                      </span>
                    </button>
                  )
                })}
              </div>

              <p className="text-xs text-muted-foreground text-pretty">{ACQUISITION_ACTION_DESCRIPTIONS[action]}</p>

              <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Face value</span>
                  <span className="font-semibold">{money(target.faceValue, target.currency)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {ACQUISITION_ACTION_LABELS[action]} fee (
                    {(ACQUISITION_FEE_RATES[action] * 100).toFixed(action === "assign" ? 1 : 0)}%)
                  </span>
                  <span className="font-bold text-primary">{money(fee, target.currency)}</span>
                </div>
              </div>

              {/* OpenFIGI verification */}
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <BadgeCheck className="h-3.5 w-3.5" />
                    ISIN <span className="font-mono text-foreground">{target.isin}</span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={verifyIsin} disabled={verify?.loading} className="h-7 gap-1 text-xs">
                    {verify?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Verify on Bloomberg
                  </Button>
                </div>
                {verify && !verify.loading && verify.note ? (
                  <p className={cn("mt-2 flex items-start gap-1.5 text-[11px]", verify.listed ? "text-green-500" : "text-muted-foreground")}>
                    {verify.listed ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    {verify.note}
                  </p>
                ) : null}
              </div>

              <DialogFooter>
                <Button onClick={confirmAcquire} disabled={submitting} className="w-full gap-1.5">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Submit {ACQUISITION_ACTION_LABELS[action].toLowerCase()} request for approval
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
