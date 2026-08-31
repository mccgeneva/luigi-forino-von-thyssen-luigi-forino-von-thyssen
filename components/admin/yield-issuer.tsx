"use client"

import { useEffect, useMemo, useState } from "react"
import { Landmark, Loader2, TrendingUp, Check, X, Clock, Trash2, Pencil, Plus } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
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
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { BankCombobox } from "@/components/admin/bank-combobox"
import { partnerBankByKey } from "@/lib/partner-banks"
import {
  getAdminInstitutionalYields,
  publishInstitutionalYield,
  updateInstitutionalYield,
  setInstitutionalYieldStatus,
  removeInstitutionalYield,
} from "@/app/actions/institutional-yields"
import {
  YIELD_TYPES,
  YIELD_RISK_CLASSES,
  YIELD_FREQUENCIES,
  type InstitutionalYield,
  type YieldStatus,
  type PublishYieldInput,
} from "@/lib/institutional-yields-shared"

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD", "HKD"]

const STATUS_META: Record<YieldStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500" },
  active: { label: "Active", className: "border-green-500/20 bg-green-500/10 text-green-500" },
  closed: { label: "Closed", className: "border-red-500/20 bg-red-500/10 text-red-500" },
}

const currencySymbols: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CHF: "CHF " }

function fmtMoney(value: number, currency: string) {
  const symbol = currencySymbols[currency] ?? `${currency} `
  if (value >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`
  return `${symbol}${value.toLocaleString("en-US")}`
}

type Draft = {
  bankKey: string
  programName: string
  yieldType: string
  expectedReturn: string
  returnFrequency: string
  termLabel: string
  termMonths: string
  currency: string
  minInvestment: string
  riskClass: string
  rating: string
  status: YieldStatus
  description: string
  terms: string
}

const emptyDraft: Draft = {
  bankKey: "",
  programName: "",
  yieldType: "",
  expectedReturn: "",
  returnFrequency: "Monthly",
  termLabel: "",
  termMonths: "",
  currency: "USD",
  minInvestment: "",
  riskClass: "",
  rating: "",
  status: "pending",
  description: "",
  terms: "",
}

export function YieldIssuer({ passcode }: { passcode: string }) {
  const [yields, setYields] = useState<InstitutionalYield[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)

  const load = async () => {
    setLoading(true)
    const res = await getAdminInstitutionalYields(passcode)
    if (res.ok) setYields(res.yields)
    else toast.error(res.error)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  const resetForm = () => {
    setDraft(emptyDraft)
    setEditingId(null)
  }

  const startEdit = (y: InstitutionalYield) => {
    setEditingId(y.id)
    setDraft({
      bankKey: y.bankKey,
      programName: y.programName,
      yieldType: y.yieldType,
      expectedReturn: y.expectedReturn,
      returnFrequency: y.returnFrequency || "Monthly",
      termLabel: y.termLabel,
      termMonths: y.termMonths ? String(y.termMonths) : "",
      currency: y.currency,
      minInvestment: String(y.minInvestment),
      riskClass: y.riskClass,
      rating: y.rating,
      status: y.status,
      description: y.description,
      terms: y.terms,
    })
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const selectedBank = draft.bankKey ? partnerBankByKey(draft.bankKey) : undefined

  const submit = async () => {
    const minInvestment = Number(draft.minInvestment.replace(/[^0-9.]/g, ""))
    const termMonths = draft.termMonths ? Number(draft.termMonths.replace(/[^0-9.]/g, "")) : null
    const input: PublishYieldInput = {
      bankKey: draft.bankKey,
      programName: draft.programName,
      yieldType: draft.yieldType,
      expectedReturn: draft.expectedReturn,
      returnFrequency: draft.returnFrequency,
      termLabel: draft.termLabel,
      termMonths,
      currency: draft.currency,
      minInvestment,
      riskClass: draft.riskClass,
      rating: draft.rating,
      status: draft.status,
      description: draft.description,
      terms: draft.terms,
    }
    setSubmitting(true)
    const res = editingId
      ? await updateInstitutionalYield(passcode, { ...input, id: editingId })
      : await publishInstitutionalYield(passcode, input)
    setSubmitting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setYields(res.yields)
    toast.success(editingId ? "Yield updated" : "Yield published", {
      description: editingId
        ? "The institutional yield has been updated."
        : draft.status === "active"
          ? "The yield is now live in the client Yield/PPP section."
          : "The yield was created as pending. Approve it to publish to clients.",
    })
    resetForm()
  }

  const changeStatus = async (id: string, status: YieldStatus) => {
    setBusyId(id)
    const res = await setInstitutionalYieldStatus(passcode, id, status)
    setBusyId(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setYields(res.yields)
    toast.success(
      status === "active" ? "Yield approved & published" : status === "closed" ? "Yield closed" : "Yield set to pending",
    )
  }

  const remove = async (id: string) => {
    setBusyId(id)
    const res = await removeInstitutionalYield(passcode, id)
    setBusyId(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setYields(res.yields)
    toast.success("Yield removed")
    if (editingId === id) resetForm()
  }

  const pendingCount = useMemo(() => yields.filter((y) => y.status === "pending").length, [yields])
  const activeCount = useMemo(() => yields.filter((y) => y.status === "active").length, [yields])

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <TrendingUp className="h-5 w-5 text-primary" />
              {editingId ? "Edit Institutional Yield" : "Add Institutional Yield"}
            </CardTitle>
            {editingId && (
              <Button variant="ghost" size="sm" onClick={resetForm}>
                <Plus className="mr-1 h-4 w-4" />
                New yield
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Create a professional, bank-sourced yield product for the client Yield / PPP section. Products start as
            pending and become visible to clients once approved (Active).
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="yld-bank">Issuing partner bank *</Label>
              <BankCombobox id="yld-bank" value={draft.bankKey} onChange={(key) => set({ bankKey: key })} />
              {selectedBank && (
                <p className="text-[11px] text-muted-foreground">
                  {selectedBank.country} · BIC {selectedBank.bic}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-name">Program / product name *</Label>
              <Input
                id="yld-name"
                placeholder="e.g. Senior Fixed Income Note 2026"
                value={draft.programName}
                onChange={(e) => set({ programName: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-type">Yield type *</Label>
              <Select value={draft.yieldType} onValueChange={(v) => set({ yieldType: v })}>
                <SelectTrigger id="yld-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {YIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-risk">Risk classification *</Label>
              <Select value={draft.riskClass} onValueChange={(v) => set({ riskClass: v })}>
                <SelectTrigger id="yld-risk">
                  <SelectValue placeholder="Select risk band" />
                </SelectTrigger>
                <SelectContent>
                  {YIELD_RISK_CLASSES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-return">Expected return / rate *</Label>
              <Input
                id="yld-return"
                placeholder="e.g. 7.5% p.a. or 12–18%"
                value={draft.expectedReturn}
                onChange={(e) => set({ expectedReturn: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-freq">Return frequency</Label>
              <Select value={draft.returnFrequency} onValueChange={(v) => set({ returnFrequency: v })}>
                <SelectTrigger id="yld-freq">
                  <SelectValue placeholder="Frequency" />
                </SelectTrigger>
                <SelectContent>
                  {YIELD_FREQUENCIES.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-term">Term / duration *</Label>
              <Input
                id="yld-term"
                placeholder="e.g. 24 months / 40 banking weeks"
                value={draft.termLabel}
                onChange={(e) => set({ termLabel: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-termmonths">Term in months (optional)</Label>
              <Input
                id="yld-termmonths"
                inputMode="numeric"
                placeholder="e.g. 24"
                value={draft.termMonths}
                onChange={(e) => set({ termMonths: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-ccy">Currency *</Label>
              <Select value={draft.currency} onValueChange={(v) => set({ currency: v })}>
                <SelectTrigger id="yld-ccy">
                  <SelectValue placeholder="Currency" />
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
            <div className="grid gap-1.5">
              <Label htmlFor="yld-min">Minimum investment *</Label>
              <MoneyInput
                id="yld-min"
                placeholder="e.g. 5,000,000"
                value={draft.minInvestment}
                onValueChange={(v) => set({ minInvestment: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-rating">Instrument rating (optional)</Label>
              <Input
                id="yld-rating"
                placeholder="e.g. AA / Investment Grade"
                value={draft.rating}
                onChange={(e) => set({ rating: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="yld-status">Initial status</Label>
              <Select value={draft.status} onValueChange={(v) => set({ status: v as YieldStatus })}>
                <SelectTrigger id="yld-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending (not visible to clients)</SelectItem>
                  <SelectItem value="active">Active (publish now)</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="yld-desc">Institutional description *</Label>
            <Textarea
              id="yld-desc"
              rows={3}
              placeholder="Describe the program, underlying assets, and how returns are generated — professional-investor grade."
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="yld-terms">Terms &amp; conditions (optional)</Label>
            <Textarea
              id="yld-terms"
              rows={3}
              placeholder="Eligibility, lock-up, early-exit terms, governing law, settlement details…"
              value={draft.terms}
              onChange={(e) => set({ terms: e.target.value })}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
              {editingId ? "Save changes" : "Publish yield"}
            </Button>
            {editingId && (
              <Button variant="outline" onClick={resetForm} disabled={submitting}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg font-semibold">Published Yields</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={STATUS_META.active.className}>
                {activeCount} active
              </Badge>
              <Badge variant="outline" className={STATUS_META.pending.className}>
                {pendingCount} pending
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : yields.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <TrendingUp className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No institutional yields yet. Create one above to publish it to the client Yield/PPP section.
              </p>
            </div>
          ) : (
            yields.map((y) => {
              const status = STATUS_META[y.status]
              const isBusy = busyId === y.id
              return (
                <div key={y.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("text-[10px]", status.className)}>
                          {status.label}
                        </Badge>
                        <span className="font-semibold text-foreground">{y.programName}</span>
                        <span className="text-xs text-muted-foreground">{y.id}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Landmark className="h-3.5 w-3.5" />
                        {y.bankName} · {y.bankCountry}
                      </div>
                      <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                        <span className="text-muted-foreground">
                          Type: <span className="text-foreground">{y.yieldType}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Return: <span className="font-medium text-primary">{y.expectedReturn}</span>{" "}
                          {y.returnFrequency && `· ${y.returnFrequency}`}
                        </span>
                        <span className="text-muted-foreground">
                          Term: <span className="text-foreground">{y.termLabel}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Min: <span className="text-foreground">{fmtMoney(y.minInvestment, y.currency)}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Risk: <span className="text-foreground">{y.riskClass}</span>
                        </span>
                        {y.rating && (
                          <span className="text-muted-foreground">
                            Rating: <span className="text-foreground">{y.rating}</span>
                          </span>
                        )}
                      </div>
                      {y.description && (
                        <p className="max-w-2xl text-xs text-muted-foreground">{y.description}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2 lg:flex-col">
                      {y.status !== "active" && (
                        <Button
                          size="sm"
                          onClick={() => changeStatus(y.id, "active")}
                          disabled={isBusy}
                          className="bg-green-600 text-white hover:bg-green-500"
                        >
                          {isBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                          Approve &amp; publish
                        </Button>
                      )}
                      {y.status === "active" && (
                        <Button size="sm" variant="outline" onClick={() => changeStatus(y.id, "pending")} disabled={isBusy}>
                          <Clock className="mr-1 h-3.5 w-3.5" />
                          Unpublish
                        </Button>
                      )}
                      {y.status !== "closed" && (
                        <Button size="sm" variant="outline" onClick={() => changeStatus(y.id, "closed")} disabled={isBusy}>
                          <X className="mr-1 h-3.5 w-3.5" />
                          Close
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => startEdit(y)} disabled={isBusy}>
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => remove(y.id)}
                        disabled={isBusy}
                        className="text-red-500 hover:text-red-500"
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
