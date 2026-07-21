"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Landmark,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Trash2,
  Plus,
  BadgeCheck,
  Eye,
  EyeOff,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { isValidCusip } from "@/lib/instrument-identifiers"
import { MARKET_INSTRUMENT_TYPES } from "@/lib/instrument-marketplace"
import {
  getAdminMarketplaceInstruments,
  publishInstrument,
  setInstrumentAvailability,
  removeInstrument,
  type MarketplaceInstrument,
  type VerifiedSource,
} from "@/app/actions/marketplace-instruments"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD", "HKD", "JPY"]
const SOURCE_LABEL: Record<VerifiedSource, string> = {
  bloomberg: "Bloomberg (live-verified)",
  euroclear: "Euroclear",
  clearstream: "Clearstream",
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString("en-US")}`
  }
}

interface VerifyState {
  loading: boolean
  checked: boolean
  listed?: boolean
  note?: string
}

const EMPTY_FORM = {
  isin: "",
  cusip: "",
  commonCode: "",
  bankName: "",
  bankBic: "",
  bankCountry: "",
  typeCode: "SBLC",
  faceValue: "",
  currency: "USD",
  tenorMonths: "12",
  rating: "AAA",
  assignable: true,
  monetizable: true,
  verifiedSource: "euroclear" as VerifiedSource,
  attestEuroclear: false,
  attestClearstream: false,
  attestSwift: false,
  issueDate: "",
  maturityDate: "",
  issuerDetails: "",
  beneficiaryTerms: "",
  deliveryMethod: "SWIFT MT760 (bank-to-bank, authenticated)",
  governingLaw: "",
  notes: "",
  printoutUrl: "",
}

export function MarketplaceInstrumentManager() {
  const [instruments, setInstruments] = useState<MarketplaceInstrument[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [verify, setVerify] = useState<VerifyState>({ loading: false, checked: false })
  const [publishing, setPublishing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const setField = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (key === "isin") setVerify({ loading: false, checked: false })
  }

  useEffect(() => {
    let active = true
    getAdminMarketplaceInstruments(ADMIN_PASSCODE)
      .then((res) => {
        if (!active) return
        if (!res.ok) {
          toast.error(res.error)
          return
        }
        setInstruments(res.instruments)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  const isinLooksValid = /^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/.test(form.isin.trim())
  const cusipLooksValid = form.cusip.trim() === "" || isValidCusip(form.cusip.trim())

  const runVerify = async () => {
    const isin = form.isin.trim().toUpperCase()
    if (!isinLooksValid) {
      setVerify({ loading: false, checked: true, listed: false, note: "ISIN must be 12 characters (2 letters + 9 + check digit)." })
      return
    }
    setVerify({ loading: true, checked: false })
    try {
      const res = await fetch("/api/openfigi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isin }),
      })
      const data = await res.json()
      if (!data.ok) {
        setVerify({ loading: false, checked: true, note: data.error ?? "Verification unavailable." })
        return
      }
      if (data.listed && data.matches?.length) {
        const m = data.matches[0]
        setVerify({
          loading: false,
          checked: true,
          listed: true,
          note: `Listed on Bloomberg · ${m.figi}${m.name ? ` · ${m.name}` : ""}${m.securityType ? ` · ${m.securityType}` : ""}`,
        })
      } else {
        setVerify({
          loading: false,
          checked: true,
          listed: false,
          note: "Valid ISIN, but not Bloomberg-listed. Publish as Euroclear/Clearstream with its Common Code.",
        })
      }
    } catch {
      setVerify({ loading: false, checked: true, note: "Network error during verification." })
    }
  }

  const canPublish = useMemo(() => {
    if (!isinLooksValid || !form.bankName.trim() || !form.faceValue.trim()) return false
    if (!cusipLooksValid) return false
    if (form.verifiedSource === "bloomberg") return verify.checked && verify.listed === true
    // Euroclear / Clearstream require a 9-digit Common Code.
    return /^\d{9}$/.test(form.commonCode.trim())
  }, [isinLooksValid, cusipLooksValid, form, verify])

  const publish = async () => {
    const typeMeta = MARKET_INSTRUMENT_TYPES.find((t) => t.code === form.typeCode)
    setPublishing(true)
    const res = await publishInstrument(ADMIN_PASSCODE, {
      isin: form.isin,
      cusip: form.cusip || null,
      commonCode: form.commonCode || null,
      bankName: form.bankName,
      bankBic: form.bankBic,
      bankCountry: form.bankCountry,
      type: form.typeCode,
      typeFull: typeMeta?.full ?? form.typeCode,
      faceValue: Number.parseFloat(form.faceValue.replace(/,/g, "")),
      currency: form.currency,
      tenorMonths: Number.parseInt(form.tenorMonths, 10) || 12,
      rating: form.rating,
      assignable: form.assignable,
      monetizable: form.monetizable,
      verifiedSource: form.verifiedSource,
      attestEuroclear: form.attestEuroclear,
      attestClearstream: form.attestClearstream,
      attestSwift: form.attestSwift,
      issueDate: form.issueDate || null,
      maturityDate: form.maturityDate || null,
      issuerDetails: form.issuerDetails || null,
      beneficiaryTerms: form.beneficiaryTerms || null,
      deliveryMethod: form.deliveryMethod || null,
      governingLaw: form.governingLaw || null,
      notes: form.notes || null,
      printoutUrl: form.printoutUrl || null,
    })
    setPublishing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setInstruments(res.instruments)
    setForm({ ...EMPTY_FORM })
    setVerify({ loading: false, checked: false })
    toast.success("Instrument published", {
      description: `${res.instrument.type} ${res.instrument.isin} is now live in the marketplace.`,
    })
  }

  const toggleAvailability = async (inst: MarketplaceInstrument) => {
    setBusyId(inst.id)
    const res = await setInstrumentAvailability(ADMIN_PASSCODE, inst.id, !inst.available)
    setBusyId(null)
    if (!res.ok) return toast.error(res.error)
    setInstruments(res.instruments)
  }

  const remove = async (inst: MarketplaceInstrument) => {
    setBusyId(inst.id)
    const res = await removeInstrument(ADMIN_PASSCODE, inst.id)
    setBusyId(null)
    if (!res.ok) return toast.error(res.error)
    setInstruments(res.instruments)
    toast.success("Instrument removed")
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          <Landmark className="h-5 w-5 text-primary" />
          Marketplace Instrument Catalogue
          <Badge variant="secondary" className="ml-auto bg-secondary text-foreground">
            {instruments.length} published
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground text-pretty">
          Publish only instruments that carry a <span className="font-medium text-foreground">real ISIN</span> verified
          against Bloomberg, Euroclear, or Clearstream. Nothing is generated automatically — the marketplace shows
          exactly what you publish here, and the Common Code is stored as you enter it (it is assigned by the ICSD, not
          derived from the ISIN).
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* --- Add form --- */}
        <div className="space-y-4 rounded-lg border border-border bg-secondary/20 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* ISIN + verify */}
            <div className="space-y-1.5">
              <Label htmlFor="mkt-isin">ISIN</Label>
              <div className="flex gap-2">
                <Input
                  id="mkt-isin"
                  value={form.isin}
                  onChange={(e) => setField("isin", e.target.value.toUpperCase())}
                  placeholder="e.g. XS1234567890"
                  className="font-mono"
                />
                <Button type="button" variant="outline" onClick={runVerify} disabled={verify.loading || !isinLooksValid} className="shrink-0 gap-1.5 bg-transparent">
                  {verify.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                  Verify
                </Button>
              </div>
              {verify.checked && verify.note ? (
                <p className={cn("flex items-start gap-1.5 text-[11px]", verify.listed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                  {verify.listed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  {verify.note}
                </p>
              ) : null}
            </div>

            {/* Common code */}
            <div className="space-y-1.5">
              <Label htmlFor="mkt-cc">Common Code (Euroclear/Clearstream)</Label>
              <Input
                id="mkt-cc"
                value={form.commonCode}
                onChange={(e) => setField("commonCode", e.target.value.replace(/\D/g, "").slice(0, 9))}
                placeholder="9 digits, e.g. 123456789"
                className="font-mono"
                inputMode="numeric"
              />
            </div>

            {/* CUSIP */}
            <div className="space-y-1.5">
              <Label htmlFor="mkt-cusip">CUSIP (optional, US issuers)</Label>
              <Input
                id="mkt-cusip"
                value={form.cusip}
                onChange={(e) => setField("cusip", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 9))}
                placeholder="9 chars, e.g. 037833100"
                className="font-mono"
              />
              {form.cusip && !cusipLooksValid ? (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  CUSIP must be 9 characters with a valid check digit.
                </p>
              ) : null}
            </div>

            {/* Verification source */}
            <div className="space-y-1.5">
              <Label>Verification source</Label>
              <Select value={form.verifiedSource} onValueChange={(v) => setField("verifiedSource", v as VerifiedSource)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bloomberg">Bloomberg (live-verified ISIN)</SelectItem>
                  <SelectItem value="euroclear">Euroclear (Common Code)</SelectItem>
                  <SelectItem value="clearstream">Clearstream (Common Code)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {form.verifiedSource === "bloomberg"
                  ? "The ISIN must resolve live on Bloomberg to publish."
                  : "A 9-digit Common Code from the ICSD admission is required."}
              </p>
            </div>

            {/* Type */}
            <div className="space-y-1.5">
              <Label>Instrument type</Label>
              <Select value={form.typeCode} onValueChange={(v) => setField("typeCode", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MARKET_INSTRUMENT_TYPES.map((t) => (
                    <SelectItem key={t.code} value={t.code}>{t.code} — {t.full}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Bank */}
            <div className="space-y-1.5">
              <Label htmlFor="mkt-bank">Issuing bank</Label>
              <Input id="mkt-bank" value={form.bankName} onChange={(e) => setField("bankName", e.target.value)} placeholder="e.g. HSBC Bank PLC" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mkt-bic">Bank BIC</Label>
                <Input id="mkt-bic" value={form.bankBic} onChange={(e) => setField("bankBic", e.target.value.toUpperCase())} placeholder="HBUKGB4B" className="font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mkt-country">Country</Label>
                <Input id="mkt-country" value={form.bankCountry} onChange={(e) => setField("bankCountry", e.target.value)} placeholder="United Kingdom" />
              </div>
            </div>

            {/* Face value + currency */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mkt-face">Face value</Label>
                <Input id="mkt-face" value={form.faceValue} onChange={(e) => setField("faceValue", e.target.value)} placeholder="10000000" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => setField("currency", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Tenor + rating */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mkt-tenor">Tenor (months)</Label>
                <Input id="mkt-tenor" value={form.tenorMonths} onChange={(e) => setField("tenorMonths", e.target.value.replace(/\D/g, ""))} placeholder="12" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mkt-rating">Issuer rating</Label>
                <Input id="mkt-rating" value={form.rating} onChange={(e) => setField("rating", e.target.value.toUpperCase())} placeholder="AAA" />
              </div>
            </div>
          </div>

          {/* Multi-registry verification attestations */}
          <div className="rounded-md border border-border/60 bg-card p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Trusted-source verification
            </p>
            <p className="mb-3 text-[11px] text-muted-foreground text-pretty">
              Bloomberg is confirmed automatically when the ISIN resolves live. Tick the registries you have confirmed
              this instrument against — the date is recorded and shown to customers. Attest only what is genuinely
              verified; nothing here is assumed.
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <span className="flex items-center gap-2 text-sm">
                <BadgeCheck
                  className={cn(
                    "h-4 w-4",
                    verify.listed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/50",
                  )}
                />
                Bloomberg
                <span className="text-[11px] text-muted-foreground">
                  {verify.listed ? "live-verified" : "verify ISIN above"}
                </span>
              </span>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={form.attestEuroclear} onCheckedChange={(c) => setField("attestEuroclear", c)} />
                Euroclear
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={form.attestClearstream} onCheckedChange={(c) => setField("attestClearstream", c)} />
                Clearstream
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch checked={form.attestSwift} onCheckedChange={(c) => setField("attestSwift", c)} />
                SWIFT
              </label>
            </div>
          </div>

          {/* Printout / tearsheet fields */}
          <div className="rounded-md border border-border/60 bg-card p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Instrument printout details (shown to customers)</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mkt-issue">Issue date</Label>
                <Input id="mkt-issue" type="date" value={form.issueDate} onChange={(e) => setField("issueDate", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mkt-maturity">Maturity date</Label>
                <Input id="mkt-maturity" type="date" value={form.maturityDate} onChange={(e) => setField("maturityDate", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mkt-delivery">Delivery method</Label>
                <Input id="mkt-delivery" value={form.deliveryMethod} onChange={(e) => setField("deliveryMethod", e.target.value)} placeholder="SWIFT MT760" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mkt-law">Governing law / rules</Label>
                <Input id="mkt-law" value={form.governingLaw} onChange={(e) => setField("governingLaw", e.target.value)} placeholder="ISP98 · ICC 590" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mkt-issuer">Issuer details</Label>
                <Textarea id="mkt-issuer" value={form.issuerDetails} onChange={(e) => setField("issuerDetails", e.target.value)} placeholder="Registered office, issuing branch, contact desk…" rows={2} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mkt-benef">Beneficiary / transfer terms</Label>
                <Textarea id="mkt-benef" value={form.beneficiaryTerms} onChange={(e) => setField("beneficiaryTerms", e.target.value)} placeholder="Assignment, transferability, confirmation terms…" rows={2} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mkt-notes">Notes</Label>
                <Textarea id="mkt-notes" value={form.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Any additional disclosures for customers." rows={2} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mkt-pdf">Printout PDF URL (optional)</Label>
                <Input id="mkt-pdf" value={form.printoutUrl} onChange={(e) => setField("printoutUrl", e.target.value)} placeholder="https://… link to the scanned instrument document" />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={form.assignable} onCheckedChange={(c) => setField("assignable", c)} /> Assignable
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={form.monetizable} onCheckedChange={(c) => setField("monetizable", c)} /> Monetizable
            </label>
            <Button type="button" onClick={publish} disabled={!canPublish || publishing} className="ml-auto gap-1.5">
              {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Publish instrument
            </Button>
          </div>
          {!canPublish && form.isin.trim() ? (
            <p className="text-[11px] text-muted-foreground">
              {form.verifiedSource === "bloomberg"
                ? "Verify the ISIN on Bloomberg (must be listed) before publishing."
                : "Enter a valid ISIN, a 9-digit Common Code, a bank and a face value to publish."}
            </p>
          ) : null}
        </div>

        {/* --- Published list --- */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading catalogue…
          </div>
        ) : instruments.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
            <Landmark className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No instruments published yet</p>
            <p className="max-w-sm text-sm text-muted-foreground text-pretty">
              The marketplace is empty until you publish a verified instrument above. Customers will never see fabricated
              or placeholder ISINs.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {instruments.map((inst) => (
              <div key={inst.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/60 bg-card px-3 py-2.5", !inst.available && "opacity-60")}>
                <Badge className="rounded-sm px-1.5 py-0 font-mono text-[10px] font-bold">{inst.type}</Badge>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{inst.bankName}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {inst.isin}{inst.commonCode ? ` · CC ${inst.commonCode}` : ""}
                  </p>
                </div>
                <span className="font-mono text-sm tabular-nums text-foreground">{money(inst.faceValue, inst.currency)}</span>
                <Badge variant="outline" className="gap-1 rounded-sm border-primary/30 bg-primary/5 text-[10px] text-primary">
                  <ShieldCheck className="h-3 w-3" />
                  {SOURCE_LABEL[inst.verifiedSource]}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => toggleAvailability(inst)} disabled={busyId === inst.id} className="h-8 gap-1 text-xs">
                    {busyId === inst.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : inst.available ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    {inst.available ? "Listed" : "Hidden"}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(inst)} disabled={busyId === inst.id} className="h-8 gap-1 text-xs text-destructive hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
