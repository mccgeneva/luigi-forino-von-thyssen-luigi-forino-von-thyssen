"use client"

import { useEffect, useMemo, useState } from "react"
import { Layers, Save, Loader2, RotateCcw, Plus, Trash2, Calculator } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { calculateTieredFee, DEFAULT_FEE_TIERS, type FeeTier } from "@/lib/tiered-fees"

/** A tier row in the editor. `max` empty string = unbounded top tier. */
interface EditRow {
  min: string
  max: string
  /** Rate as a PERCENT string in the UI (e.g. "2" for 2%). */
  ratePct: string
}

function toRows(tiers: FeeTier[]): EditRow[] {
  return tiers.map((t) => ({
    min: String(t.min),
    max: t.max == null ? "" : String(t.max),
    ratePct: String(+(t.rate * 100).toFixed(6)),
  }))
}

function rowsToTiers(rows: EditRow[]): FeeTier[] {
  return rows.map((r) => ({
    min: Number(r.min.replace(/[^0-9.]/g, "")) || 0,
    max: r.max.trim() === "" ? null : Number(r.max.replace(/[^0-9.]/g, "")) || 0,
    rate: (Number(r.ratePct) || 0) / 100,
  }))
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

export function FeeTierManager({ passcode }: { passcode: string }) {
  const [rows, setRows] = useState<EditRow[]>(toRows(DEFAULT_FEE_TIERS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sample, setSample] = useState("3500000")

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)
    ;(async () => {
      try {
        const resp = await fetch("/api/fee-tiers", { credentials: "include", cache: "no-store" })
        const data = await resp.json()
        if (!active) return
        if (data.ok && Array.isArray(data.tiers) && data.tiers.length) {
          setRows(toRows(data.tiers as FeeTier[]))
        }
      } catch {
        if (active) setLoadError("Could not load the current fee table — showing defaults.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [passcode])

  const tiers = useMemo(() => rowsToTiers(rows), [rows])

  // Validation: ascending mins, exactly one unbounded (last) tier, rates 0–100%.
  const validation = useMemo(() => {
    if (rows.length === 0) return "Add at least one tier."
    const sorted = [...tiers].sort((a, b) => a.min - b.min)
    for (const t of tiers) {
      if (!Number.isFinite(t.min) || t.min < 0) return "Each tier needs a valid lower bound."
      if (t.max != null && (!Number.isFinite(t.max) || t.max <= t.min)) return "Each tier's upper bound must exceed its lower bound."
      if (!Number.isFinite(t.rate) || t.rate < 0 || t.rate > 1) return "Rates must be between 0% and 100%."
    }
    const unbounded = tiers.filter((t) => t.max == null)
    if (unbounded.length !== 1) return "Exactly one tier must be the unbounded top tier (empty upper bound)."
    if (sorted[sorted.length - 1].max != null) return "The unbounded tier must be the highest (largest lower bound)."
    return null
  }, [rows, tiers])

  const sampleQuote = useMemo(() => {
    const amt = Number(sample.replace(/[^0-9.]/g, "")) || 0
    return calculateTieredFee(amt, validation ? DEFAULT_FEE_TIERS : tiers)
  }, [sample, tiers, validation])

  const updateRow = (i: number, patch: Partial<EditRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const addRow = () =>
    setRows((prev) => {
      // New bracket seeded above the current highest bounded min.
      const maxMin = prev.reduce((m, r) => Math.max(m, Number(r.min.replace(/[^0-9.]/g, "")) || 0), 0)
      return [...prev, { min: String(maxMin + 1_000_000), max: "", ratePct: "0.1" }]
    })

  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i))

  const resetDefaults = () => setRows(toRows(DEFAULT_FEE_TIERS))

  const save = async () => {
    if (validation) {
      toast.error("Fix the tier table first", { description: validation })
      return
    }
    setSaving(true)
    try {
      const resp = await fetch("/api/fee-tiers", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: passcode, tiers }),
      })
      const data = await resp.json()
      if (data.ok && Array.isArray(data.tiers)) {
        setRows(toRows(data.tiers as FeeTier[]))
        toast.success("Fee tiers updated", {
          description: "The new marginal tier table now applies to all incoming and outgoing payments.",
        })
      } else if (data.reason === "unauthorized") {
        toast.error("Administrator authorization failed", { description: "Re-open the panel with your passcode." })
      } else {
        toast.error("Couldn't save", { description: data.error || "Please try again." })
      }
    } catch {
      toast.error("Couldn't reach the server", { description: "Please try again." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            Transaction Fee Tiers
          </CardTitle>
          <CardDescription>
            A progressive, bracket-based fee applied to every incoming and outgoing payment: each portion of the amount
            is charged only at the rate of its own tier (marginal pricing). Thresholds are in native currency units.
            Changes here apply platform-wide with no redeploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading current fee tiers…
            </div>
          ) : (
            <>
              {loadError && <p className="text-[11px] text-amber-600">{loadError}</p>}

              {/* Column headers (hidden on mobile, shown from sm) */}
              <div className="hidden gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[1fr_1fr_90px_36px]">
                <span>From</span>
                <span>To (blank = ∞)</span>
                <span>Rate %</span>
                <span />
              </div>

              <div className="space-y-3">
                {rows.map((row, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_90px_36px] sm:items-center sm:border-0 sm:p-0"
                  >
                    <div className="space-y-1">
                      <Label className="text-[11px] sm:hidden">From</Label>
                      <MoneyInput placeholder="0" value={row.min} onValueChange={(v) => updateRow(i, { min: v })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] sm:hidden">To (blank = no cap)</Label>
                      <MoneyInput
                        placeholder="∞ (top tier)"
                        value={row.max}
                        onValueChange={(v) => updateRow(i, { max: v })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] sm:hidden">Rate %</Label>
                      <Input
                        inputMode="decimal"
                        placeholder="2"
                        value={row.ratePct}
                        onChange={(e) => updateRow(i, { ratePct: e.target.value.replace(/[^0-9.]/g, "") })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeRow(i)}
                      aria-label={`Remove tier ${i + 1}`}
                      disabled={rows.length <= 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={addRow}>
                <Plus className="h-4 w-4" />
                Add tier
              </Button>

              {validation && <p className="text-[11px] text-destructive">{validation}</p>}

              {/* Live sample calculation */}
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Calculator className="h-4 w-4 text-primary" />
                  Sample calculation
                </Label>
                <MoneyInput placeholder="3,500,000" value={sample} onValueChange={setSample} />
                <div className="space-y-0.5 text-xs">
                  {sampleQuote.breakdown.map((b, i) => (
                    <div key={i} className="flex items-center justify-between text-muted-foreground">
                      <span>
                        {fmt(b.min)}
                        {b.max == null ? "+" : ` – ${fmt(b.max)}`} @ {(b.rate * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% on {fmt(b.amountInTier)}
                      </span>
                      <span className="text-foreground">{fmt(b.fee)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-border pt-1 font-medium">
                    <span className="text-foreground">
                      Total fee ({(sampleQuote.effectiveRate * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}% effective)
                    </span>
                    <span className="text-foreground">{fmt(sampleQuote.totalFee)}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={save} disabled={saving || !!validation} className="w-full gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save fee tiers
                </Button>
                <Button onClick={resetDefaults} disabled={saving} variant="outline" className="w-full gap-2 sm:w-auto">
                  <RotateCcw className="h-4 w-4" />
                  Reset to defaults
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
