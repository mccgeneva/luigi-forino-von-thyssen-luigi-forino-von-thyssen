"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ShieldCheck,
  Loader2,
  RefreshCw,
  Search,
  Gauge,
  Pencil,
  CheckCircle2,
  XCircle,
  FileBarChart,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
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
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { AUDIT_RATING_SCALE, riskScoreTone, type AuditRating, type InstrumentAudit } from "@/lib/instrument-audit"

interface InstrumentVM {
  id?: string
  type?: string
  typeFull?: string
  issuer?: string
  faceValue?: number
  currency?: string
  isin?: string
}

interface HeldInstrument {
  approvalId: string
  userId: string
  holderLabel: string
  holderEmail: string
  instrument: InstrumentVM
  audit: InstrumentAudit
  stored: boolean
}

function money(amount: number | undefined, currency: string | undefined): string {
  const n = Number(amount ?? 0)
  return `${currency ?? ""} ${n.toLocaleString("en-US")}`.trim()
}

const toneClass: Record<"positive" | "neutral" | "negative", string> = {
  positive: "text-green-600 dark:text-green-500",
  neutral: "text-amber-600 dark:text-amber-500",
  negative: "text-red-600 dark:text-red-500",
}

function statusBadge(a: InstrumentAudit) {
  if (a.status === "published")
    return <Badge className="bg-green-600 text-white hover:bg-green-600">Published</Badge>
  if (a.status === "rejected") return <Badge variant="destructive">Rejected</Badge>
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Draft{a.overridden ? " · overridden" : ""}
    </Badge>
  )
}

export function InstrumentAuditManager() {
  const [items, setItems] = useState<HeldInstrument[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  // Review / override dialog state
  const [target, setTarget] = useState<HeldInstrument | null>(null)
  const [realisticValue, setRealisticValue] = useState("")
  const [riskScore, setRiskScore] = useState("")
  const [rating, setRating] = useState<AuditRating>("AAA")
  const [monetizationEligible, setMonetizationEligible] = useState(true)
  const [allowedPct, setAllowedPct] = useState("")
  const [investingEligible, setInvestingEligible] = useState(true)
  const [ppiRequired, setPpiRequired] = useState(false)
  const [summary, setSummary] = useState("")
  const [justification, setJustification] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch("/api/admin/instrument-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "list", pin: ADMIN_PASSCODE }),
      })
      const data = await res.json()
      if (!data.ok) {
        setLoadError(
          data.reason === "unauthorized"
            ? "Administrator authorization failed."
            : data.error ?? "Could not load instruments.",
        )
        setItems([])
        return
      }
      setItems(Array.isArray(data.instruments) ? data.instruments : [])
    } catch {
      setLoadError("Could not reach the server. Please try again.")
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      [it.holderLabel, it.holderEmail, it.instrument.issuer, it.instrument.typeFull, it.instrument.type, it.instrument.isin, it.instrument.id]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [items, search])

  const act = useCallback(
    async (approvalId: string, op: "run" | "publish" | "reject" | "override", extra?: Record<string, unknown>) => {
      setBusyId(approvalId)
      try {
        const res = await fetch("/api/admin/instrument-audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ op, pin: ADMIN_PASSCODE, approvalId, ...extra }),
        })
        const data = await res.json()
        if (!data.ok) {
          toast.error(data.error ?? "The action could not be completed.")
          return false
        }
        // Reflect the new audit locally, then reconcile against the server.
        setItems((prev) =>
          prev.map((it) => (it.approvalId === approvalId ? { ...it, audit: data.audit, stored: true } : it)),
        )
        return true
      } catch {
        toast.error("Could not reach the server. Please try again.")
        return false
      } finally {
        setBusyId(null)
      }
    },
    [],
  )

  function openReview(it: HeldInstrument) {
    const a = it.audit
    setTarget(it)
    setRealisticValue(String(a.realisticValue ?? ""))
    setRiskScore(String(a.riskScore ?? ""))
    setRating(a.rating)
    setMonetizationEligible(a.monetizationEligible)
    setAllowedPct(String(Math.round((a.allowedMonetizationPct ?? 0) * 100)))
    setInvestingEligible(a.investingEligible)
    setPpiRequired(a.ppiRequired)
    setSummary(a.summary ?? "")
    setJustification("")
  }

  async function saveOverride() {
    if (!target) return
    if (!justification.trim()) {
      toast.error("A justification is required to override the engine assessment.")
      return
    }
    const ok = await act(target.approvalId, "override", {
      realisticValue: Number(realisticValue) || 0,
      riskScore: Number(riskScore) || 0,
      rating,
      monetizationEligible,
      allowedMonetizationPct: (Number(allowedPct) || 0) / 100,
      investingEligible,
      ppiRequired,
      summary: summary.trim(),
      justification: justification.trim(),
    })
    if (ok) {
      toast.success("Assessment overridden. Publish it to make it visible to the client.")
      setTarget(null)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Bank Instrument Audit Engine
              </CardTitle>
              <CardDescription className="mt-1 max-w-2xl text-pretty">
                Independent valuation & risk certification for every instrument held by a client. Review the engine
                assessment, override any figure with a logged justification, then publish the report to the client.
                Realistic assessed value is always distinguished from the stated face value.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by client, issuer, type, ISIN or reference"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {loadError && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {loadError}
            </p>
          )}

          {!loadError && filtered.length === 0 && !loading && (
            <p className="rounded-lg border border-border bg-secondary/30 p-6 text-center text-sm text-muted-foreground">
              No active instruments to audit.
            </p>
          )}

          <div className="space-y-3">
            {filtered.map((it) => {
              const a = it.audit
              const busy = busyId === it.approvalId
              return (
                <div key={it.approvalId} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-foreground">
                          {it.instrument.typeFull ?? it.instrument.type ?? "Instrument"}
                        </p>
                        {statusBadge(a)}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {it.holderLabel} · {it.instrument.issuer ?? "—"}
                        {it.instrument.isin ? ` · ISIN ${it.instrument.isin}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Face value</p>
                      <p className="font-mono text-sm font-semibold text-foreground">
                        {money(it.instrument.faceValue, it.instrument.currency)}
                      </p>
                    </div>
                  </div>

                  {/* Engine assessment snapshot */}
                  <div className="mt-3 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
                    <div className="bg-secondary/30 p-3">
                      <p className="text-[11px] text-muted-foreground">Realistic value</p>
                      <p className="mt-0.5 font-mono text-sm font-bold text-foreground">
                        {money(a.realisticValue, a.currency)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{(a.realisticPct * 100).toFixed(1)}% of face</p>
                    </div>
                    <div className="bg-secondary/30 p-3">
                      <p className="text-[11px] text-muted-foreground">Risk / rating</p>
                      <p className={`mt-0.5 text-sm font-bold ${toneClass[riskScoreTone(a.riskScore)]}`}>
                        {a.riskScore}/100 · {a.rating}
                      </p>
                    </div>
                    <div className="bg-secondary/30 p-3">
                      <p className="text-[11px] text-muted-foreground">Monetization LTV</p>
                      <p className="mt-0.5 text-sm font-bold text-foreground">
                        {a.monetizationEligible ? `${(a.allowedMonetizationPct * 100).toFixed(0)}%` : "Not eligible"}
                      </p>
                    </div>
                    <div className="bg-secondary/30 p-3">
                      <p className="text-[11px] text-muted-foreground">PPI insurance</p>
                      <p className="mt-0.5 text-sm font-bold text-foreground">{a.ppiRequired ? "Required" : "Not required"}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => void act(it.approvalId, "run")} disabled={busy}>
                      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Gauge className="mr-2 h-4 w-4" />}
                      Run engine
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openReview(it)} disabled={busy}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Review / override
                    </Button>
                    {a.status !== "published" ? (
                      <Button size="sm" onClick={() => void act(it.approvalId, "publish").then((ok) => ok && toast.success("Audit report published to the client."))} disabled={busy}>
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                        Publish report
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void act(it.approvalId, "reject", { reason: "Report retracted by the administrator." }).then((ok) => ok && toast.success("Report retracted."))}
                        disabled={busy}
                      >
                        <XCircle className="mr-2 h-4 w-4" />
                        Retract
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Review / override dialog */}
      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          {target && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FileBarChart className="h-5 w-5 text-primary" />
                  Review audit — {target.instrument.typeFull ?? target.instrument.type}
                </DialogTitle>
                <DialogDescription className="text-pretty">
                  {target.holderLabel} · face value {money(target.instrument.faceValue, target.instrument.currency)}. Any
                  change to an engine figure requires a justification and resets the report to draft for re-publication.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="audit-realistic">Realistic value ({target.instrument.currency})</Label>
                    <MoneyInput
                      id="audit-realistic"
                      value={realisticValue}
                      onValueChange={setRealisticValue}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="audit-risk">Risk score (0–100)</Label>
                    <Input id="audit-risk" inputMode="numeric" value={riskScore} onChange={(e) => setRiskScore(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Classification rating</Label>
                    <Select value={rating} onValueChange={(v) => setRating(v as AuditRating)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUDIT_RATING_SCALE.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="audit-ltv">Allowed monetization %</Label>
                    <Input
                      id="audit-ltv"
                      inputMode="numeric"
                      value={allowedPct}
                      onChange={(e) => setAllowedPct(e.target.value)}
                      disabled={!monetizationEligible}
                    />
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="audit-monet" className="cursor-pointer">
                      Valid for monetization
                    </Label>
                    <Switch id="audit-monet" checked={monetizationEligible} onCheckedChange={setMonetizationEligible} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="audit-invest" className="cursor-pointer">
                      Valid for investing
                    </Label>
                    <Switch id="audit-invest" checked={investingEligible} onCheckedChange={setInvestingEligible} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="audit-ppi" className="cursor-pointer">
                      PPI insurance required for trade
                    </Label>
                    <Switch id="audit-ppi" checked={ppiRequired} onCheckedChange={setPpiRequired} />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="audit-summary">Report summary</Label>
                  <Textarea id="audit-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="audit-justify">Override justification (required)</Label>
                  <Textarea
                    id="audit-justify"
                    rows={2}
                    placeholder="Explain the basis for adjusting the engine assessment…"
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                  />
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => setTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={() => void saveOverride()} disabled={busyId === target.approvalId}>
                  {busyId === target.approvalId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save override
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
