"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Save, ShieldAlert, ShieldCheck, Search, RefreshCw, Sparkles, Copy, Check, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DEFAULT_GUARANTEE_CONFIG,
  riskBandLabel,
  applyGuaranteeOverride,
  type GuaranteeConfig,
  type GuaranteeScore,
} from "@/lib/guarantees-accumulator"
import type { OverdraftStatus } from "@/lib/overdraft"

type ScoredUser = {
  id: string
  fullName: string
  company: string
  email: string
  score: GuaranteeScore | null
  overdraft?: OverdraftStatus | null
  /** Forced risk score (0..100) set by the admin slider, or null = automatic. */
  override?: number | null
}

function eur(n: number) {
  return `EUR ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

function bandTone(band: string) {
  return band === "high"
    ? "text-red-600 dark:text-red-500"
    : band === "moderate"
      ? "text-amber-600 dark:text-amber-500"
      : "text-green-600 dark:text-green-500"
}

export function GuaranteesManager({ passcode }: { passcode: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [users, setUsers] = useState<ScoredUser[]>([])
  const [config, setConfig] = useState<GuaranteeConfig>(DEFAULT_GUARANTEE_CONFIG)
  const [search, setSearch] = useState("")

  // NQAi client-message drafting
  const [draftTarget, setDraftTarget] = useState<ScoredUser | null>(null)
  const [draftDecision, setDraftDecision] = useState<"approve" | "decline">("decline")
  const [draftAmount, setDraftAmount] = useState("")
  const [draftNote, setDraftNote] = useState("")
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftMessage, setDraftMessage] = useState("")
  const [copied, setCopied] = useState(false)

  // Silent per-customer gauge override — a draggable score bar per row.
  // `dragScore` holds the LIVE value while a row's bar is being dragged (so the
  // headline number + band update instantly); it clears once committed.
  const [dragScore, setDragScore] = useState<Record<string, number>>({})
  const [overrideBusy, setOverrideBusy] = useState<string | null>(null)
  const commitTimer = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Persist a forced score (or null to clear → automatic). Optimistically writes
  // the override onto the row so it survives the next reload.
  async function commitOverride(u: ScoredUser, forcedScore: number | null) {
    setOverrideBusy(u.id)
    try {
      const res = await fetch("/api/admin/guarantees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "set-override", pin: passcode, userId: u.id, forcedScore }),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error(data.reason === "unauthorized" ? "Authorization required." : data.error || "Could not apply.")
        return
      }
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, override: forcedScore } : x)))
      toast.success(
        forcedScore === null
          ? "Override cleared — automatic scoring restored."
          : `Score forced to ${forcedScore.toFixed(2)} — silently applied to the client's account.`,
      )
    } catch (err) {
      toast.error((err as Error)?.message || "Could not apply.")
    } finally {
      setOverrideBusy(null)
    }
  }

  // Dragging the bar: update the live value immediately, then debounce the save
  // so we persist once the admin settles on a value (not on every pixel).
  function onDragScore(u: ScoredUser, value: number) {
    const v = Math.max(0, Math.min(100, Math.round(value * 100) / 100))
    setDragScore((prev) => ({ ...prev, [u.id]: v }))
    if (commitTimer.current[u.id]) clearTimeout(commitTimer.current[u.id])
    commitTimer.current[u.id] = setTimeout(() => {
      void commitOverride(u, v)
    }, 500)
  }

  function clearOverride(u: ScoredUser) {
    if (commitTimer.current[u.id]) clearTimeout(commitTimer.current[u.id])
    setDragScore((prev) => {
      const next = { ...prev }
      delete next[u.id]
      return next
    })
    void commitOverride(u, null)
  }

  /** The score the row should DISPLAY: live drag > saved override > computed. */
  function displayScoreFor(u: ScoredUser): { score: GuaranteeScore | null; forced: boolean } {
    const live = dragScore[u.id]
    const forcedVal = live != null ? live : u.override != null ? u.override : null
    if (forcedVal == null || !u.score) return { score: u.score, forced: false }
    return { score: applyGuaranteeOverride(u.score, forcedVal, config.highRiskThreshold), forced: true }
  }

  function openDraft(u: ScoredUser) {
    setDraftTarget(u)
    // Default the decision to the honest one for this profile.
    setDraftDecision(u.score?.highRisk ? "decline" : "approve")
    setDraftAmount("")
    setDraftNote("")
    setDraftMessage("")
    setCopied(false)
  }

  async function generateDraft() {
    if (!draftTarget) return
    setDraftBusy(true)
    setDraftMessage("")
    try {
      const res = await fetch("/api/admin/guarantees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({
          op: "draft-message",
          pin: passcode,
          userId: draftTarget.id,
          decision: draftDecision,
          amount: draftAmount.trim() || undefined,
          note: draftNote.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error(data.reason === "unauthorized" ? "Authorization required." : data.error || "Draft failed.")
        return
      }
      setDraftMessage(String(data.message || ""))
    } catch (err) {
      toast.error((err as Error)?.message || "Draft failed.")
    } finally {
      setDraftBusy(false)
    }
  }

  async function copyDraft() {
    if (!draftMessage) return
    try {
      await navigator.clipboard.writeText(draftMessage)
      setCopied(true)
      toast.success("Message copied — paste it into the client discussion.")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Copy failed — select the text and copy manually.")
    }
  }

  async function load() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch("/api/admin/guarantees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "load", pin: passcode }),
      })
      const data = await res.json()
      if (!data.ok) {
        setLoadError(data.reason === "unauthorized" ? "Administrator authorization required." : data.error || "Failed to load.")
        setUsers([])
        return
      }
      setConfig({ ...DEFAULT_GUARANTEE_CONFIG, ...data.config })
      setUsers(Array.isArray(data.users) ? data.users : [])
    } catch (err) {
      setLoadError((err as Error)?.message || "Network error.")
      setUsers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    setSaving(true)
    try {
      const res = await fetch("/api/admin/guarantees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "save", pin: passcode, config }),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error(data.reason === "unauthorized" ? "Authorization required." : data.error || "Save failed.")
        return
      }
      toast.success("Scoring configuration saved. Re-scoring all accounts…")
      await load()
    } catch (err) {
      toast.error((err as Error)?.message || "Save failed.")
    } finally {
      setSaving(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.fullName.toLowerCase().includes(q) ||
        u.company.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    )
  }, [users, search])

  const highRiskCount = users.filter((u) => u.score?.highRisk).length

  const setNum = (key: keyof GuaranteeConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setConfig((c) => ({ ...c, [key]: Number(e.target.value) }))

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Guarantees Accumulator
              </CardTitle>
              <CardDescription>
                Independent trust/risk engine. Risk score = √(weighted sum of factors) − time credit. Accounts above the
                high-risk threshold are blocked from opening new leverage, monetization, project funding and treasury
                financing.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              <span className="ml-1">Refresh</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Weights */}
          <div>
            <p className="mb-2 text-sm font-semibold text-foreground">Factor weights</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <Label className="text-xs">Security deposit</Label>
                <Input type="number" min="0" step="0.1" value={config.weightSecurityDeposit} onChange={setNum("weightSecurityDeposit")} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Leverage load</Label>
                <Input type="number" min="0" step="0.1" value={config.weightLeverageLoad} onChange={setNum("weightLeverageLoad")} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Exposure</Label>
                <Input type="number" min="0" step="0.1" value={config.weightExposure} onChange={setNum("weightExposure")} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Payment penalty</Label>
                <Input type="number" min="0" step="0.1" value={config.weightPaymentPenalty} onChange={setNum("weightPaymentPenalty")} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Track record</Label>
                <Input type="number" min="0" step="0.1" value={config.weightTrackRecord} onChange={setNum("weightTrackRecord")} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Overdraft</Label>
                <Input type="number" min="0" step="0.1" value={config.weightOverdraft} onChange={setNum("weightOverdraft")} className="mt-1" />
              </div>
            </div>
          </div>

          {/* Controlled overdraft */}
          <div>
            <p className="mb-2 text-sm font-semibold text-foreground">Controlled overdraft</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Overdraft risk points (full)</Label>
                <Input type="number" min="0" step="1" value={config.overdraftRiskFull} onChange={setNum("overdraftRiskFull")} className="mt-1" />
                <p className="mt-1 text-[11px] text-muted-foreground">Risk a fully-used overdraft (100% of the 8% ceiling) contributes, scaled by usage. 144 ⇒ √144 = 12 (above the default 10 gate).</p>
              </div>
              <div className="flex items-end">
                <p className="text-[11px] text-muted-foreground">
                  Accounts may go negative up to 8% of their secured treasury security deposit (including any
                  financed portion) to settle platform charges. A negative balance raises this score and
                  hard-blocks new leverage/financing until cleared.
                </p>
              </div>
            </div>
          </div>

          {/* New-account (thin-file) risk */}
          <div>
            <p className="mb-2 text-sm font-semibold text-foreground">New-account risk</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">New-account risk points</Label>
                <Input type="number" min="0" step="1" value={config.newAccountRisk} onChange={setNum("newAccountRisk")} className="mt-1" />
                <p className="mt-1 text-[11px] text-muted-foreground">Provisional risk a brand-new account starts with. 144 ⇒ risk score √144 = 12 (above the default 10 gate).</p>
              </div>
              <div>
                <Label className="text-xs">Seasoning window (days)</Label>
                <Input type="number" min="1" step="1" value={config.seasoningDays} onChange={setNum("seasoningDays")} className="mt-1" />
                <p className="mt-1 text-[11px] text-muted-foreground">Days over which the new-account risk decays to zero as the account builds a clean history.</p>
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Proven-capital threshold (EUR)</Label>
                <Input type="number" min="1" step="1000" value={config.provenCapital} onChange={setNum("provenCapital")} className="mt-1" />
                <p className="mt-1 text-[11px] text-muted-foreground">Net equity (paid-in guarantees + balance − outstanding exposure) that fully cancels the new-account risk. Borrowed/financed collateral nets out, so a leveraged deposit earns no offset and stays high risk.</p>
              </div>
            </div>
          </div>

          {/* Thresholds & credits */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label className="text-xs">High-risk threshold</Label>
              <Input type="number" min="0.1" step="0.5" value={config.highRiskThreshold} onChange={setNum("highRiskThreshold")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Age credit / year</Label>
              <Input type="number" min="0" step="0.1" value={config.ageCreditPerYear} onChange={setNum("ageCreditPerYear")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Max age credit</Label>
              <Input type="number" min="0" step="0.5" value={config.ageCreditMax} onChange={setNum("ageCreditMax")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Penalty / overdue</Label>
              <Input type="number" min="0" step="1" value={config.penaltyPerOverdue} onChange={setNum("penaltyPerOverdue")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Target coverage ×</Label>
              <Input type="number" min="0.1" step="0.1" value={config.targetCoverage} onChange={setNum("targetCoverage")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Equity credit @ (EUR)</Label>
              <Input type="number" min="1" step="1000" value={config.equityCreditFull} onChange={setNum("equityCreditFull")} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Max equity credit</Label>
              <Input type="number" min="0" step="0.5" value={config.equityCreditMax} onChange={setNum("equityCreditMax")} className="mt-1" />
            </div>
          </div>
          <p className="-mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Equity saving: blocked equity earns up to <strong>Max equity credit</strong> risk-score points, reached at
            the <strong>Equity credit @</strong> amount (linear below it). It also counts as posted collateral.
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 p-3">
            <div className="flex items-center gap-3">
              <Switch checked={config.enforce} onCheckedChange={(v) => setConfig((c) => ({ ...c, enforce: v }))} id="enforce" />
              <Label htmlFor="enforce" className="text-sm">
                Enforce blocking of high-risk accounts
                <span className="block text-xs text-muted-foreground">When off, accounts are scored but never blocked.</span>
              </Label>
            </div>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span className="ml-1">Save configuration</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              Account risk scores
              {highRiskCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {highRiskCount} high risk
                </Badge>
              )}
            </CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search clients"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-56 pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="py-6 text-center text-sm text-destructive">{loadError}</p>
          ) : loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No accounts to score.</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((u) => {
                const { score: s, forced } = displayScoreFor(u)
                return (
                  <div key={u.id} className="rounded-lg border border-border bg-secondary/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {u.company?.trim() || u.fullName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{u.fullName} · {u.email}</p>
                      </div>
                      {s ? (
                        <div className="flex items-center gap-2">
                          <span className={cn("text-lg font-bold tabular-nums", bandTone(s.band))}>
                            {s.finalScore.toFixed(2)}
                          </span>
                          <Badge
                            variant={s.highRisk ? "destructive" : "outline"}
                            className={cn(!s.highRisk && bandTone(s.band))}
                          >
                            {s.highRisk ? <ShieldAlert className="mr-1 h-3 w-3" /> : null}
                            {riskBandLabel(s.band)}
                          </Badge>
                          {forced && (
                            <Badge
                              variant="outline"
                              className="border-primary/40 text-[10px] uppercase tracking-wide text-primary"
                            >
                              Forced
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <Badge variant="outline">no data</Badge>
                      )}
                    </div>

                    {s && (
                      <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-border bg-border text-center sm:grid-cols-6">
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Security deposit</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.securityDeposit}</p>
                        </div>
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Leverage load</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.leverageLoad}</p>
                        </div>
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Exposure</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.exposure}</p>
                        </div>
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Payment penalty</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.paymentPenalty}</p>
                        </div>
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Track record</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.trackRecord ?? 0}</p>
                        </div>
                        <div className="bg-card p-2">
                          <p className="text-[10px] text-muted-foreground">Overdraft</p>
                          <p className="text-xs font-semibold text-foreground tabular-nums">{s.factors.overdraft ?? 0}</p>
                        </div>
                      </div>
                    )}

                    {u.overdraft?.inOverdraft && (
                      <p className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-500">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        Controlled overdraft: {eur(u.overdraft.negativeEur)} of {eur(u.overdraft.limitEur)} used (8% of
                        deposit) · new financing hard-blocked until positive
                      </p>
                    )}

                    {s && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        √(weighted {s.weightedSum.toFixed(0)}) = risk {s.riskScore.toFixed(2)} − age credit{" "}
                        {s.ageCredit.toFixed(2)}
                        {(s.equityCredit ?? 0) > 0 ? ` − equity credit ${s.equityCredit.toFixed(2)}` : ""} ={" "}
                        <span className="font-medium text-foreground">{s.finalScore.toFixed(2)}</span>
                        {"  ·  "}exposure {eur(s.inputs.totalExposure)} · guarantees {eur(s.inputs.guarantees)} · available{" "}
                        {eur(s.inputs.availableBalance)}
                        {(s.inputs.equitySavings ?? 0) > 0 ? ` · equity ${eur(s.inputs.equitySavings)}` : ""}
                        {s.inputs.overdueCharges > 0 ? ` · ${s.inputs.overdueCharges} overdue` : ""}
                      </p>
                    )}

                    {s && (
                      <div className="mt-3 border-t border-border pt-3">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            Drag to set risk score
                            {forced ? (
                              <Badge variant="outline" className="border-primary/40 px-1.5 py-0 text-[9px] uppercase text-primary">
                                forced
                              </Badge>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/70">(automatic)</span>
                            )}
                          </span>
                          <span className={cn("text-sm font-bold tabular-nums", bandTone(s.band))}>
                            {s.finalScore.toFixed(2)}
                          </span>
                        </div>
                        <Slider
                          value={[s.finalScore]}
                          min={0}
                          max={100}
                          step={0.5}
                          disabled={overrideBusy === u.id}
                          onValueChange={(vals) => onDragScore(u, vals[0] ?? 0)}
                          aria-label="Force risk score"
                        />
                        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground/70">
                          <span className="text-green-600 dark:text-green-500">0 · low</span>
                          <span>high-risk above {config.highRiskThreshold.toFixed(0)}</span>
                          <span className="text-red-600 dark:text-red-500">100 · high</span>
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            disabled={overrideBusy === u.id || (u.override == null && dragScore[u.id] == null)}
                            onClick={() => clearOverride(u)}
                          >
                            {overrideBusy === u.id ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            )}
                            Reset to automatic
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => openDraft(u)}>
                            <Sparkles className="h-4 w-4" />
                            <span className="ml-1">Draft client message</span>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!draftTarget} onOpenChange={(o) => !o && setDraftTarget(null)}>
        <DialogContent className="flex max-h-[90dvh] max-w-lg flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Draft client message
            </DialogTitle>
            <DialogDescription>
              {draftTarget
                ? `NQAi will write a kind, copy-paste message for ${draftTarget.company?.trim() || draftTarget.fullName} explaining the loan decision. No internal scores are ever shown to the client.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Decision</Label>
                <Select value={draftDecision} onValueChange={(v) => setDraftDecision(v as "approve" | "decline")}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approve">Approve facility</SelectItem>
                    <SelectItem value="decline">Decline — outside risk appetite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Requested amount (optional)</Label>
                <Input
                  placeholder="e.g. EUR 5,000,000"
                  value={draftAmount}
                  onChange={(e) => setDraftAmount(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Note to NQAi (optional, private — not quoted to the client)</Label>
              <Textarea
                placeholder="Any extra context, conditions, or a specific tone you want…"
                value={draftNote}
                onChange={(e) => setDraftNote(e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>

            <Button onClick={() => void generateDraft()} disabled={draftBusy} className="w-full">
              {draftBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              <span className="ml-1">{draftMessage ? "Regenerate" : "Generate with NQAi"}</span>
            </Button>

            {draftMessage && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Message to the client (editable)</Label>
                  <Button variant="ghost" size="sm" onClick={() => void copyDraft()}>
                    {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                    <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
                  </Button>
                </div>
                <Textarea
                  value={draftMessage}
                  onChange={(e) => setDraftMessage(e.target.value)}
                  rows={10}
                  className="text-sm leading-relaxed"
                />
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border pt-3">
            <Button variant="outline" onClick={() => setDraftTarget(null)}>
              Close
            </Button>
            {draftMessage && (
              <Button onClick={() => void copyDraft()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1">Copy message</span>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
