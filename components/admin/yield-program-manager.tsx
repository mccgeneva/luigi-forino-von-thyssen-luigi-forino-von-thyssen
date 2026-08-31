"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2, Pencil, RotateCcw, Eye, EyeOff, SlidersHorizontal } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  PPP_PROGRAMS,
  PROGRAM_RISK_LEVELS,
  PROGRAM_STATUSES,
  applyProgramOverride,
  type BuiltInProgram,
  type ProgramStatus,
  type YieldProgramOverride,
} from "@/lib/ppp-programs"
import {
  getAdminYieldProgramOverrides,
  setYieldProgramOverride,
  resetYieldProgramOverride,
} from "@/app/actions/yield-overrides"

const STATUS_META: Record<ProgramStatus, { label: string; className: string }> = {
  open: { label: "Open", className: "border-green-500/20 bg-green-500/10 text-green-500" },
  limited: { label: "Limited", className: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500" },
  invite: { label: "Invite Only", className: "border-purple-500/20 bg-purple-500/10 text-purple-400" },
  closed: { label: "Closed", className: "border-red-500/20 bg-red-500/10 text-red-500" },
}

function fmtMoney(value: number) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`
  return `$${value.toLocaleString("en-US")}`
}

type Draft = {
  name: string
  expectedReturn: string
  returnFrequency: string
  minInvestment: string
  maxInvestment: string
  duration: string
  status: ProgramStatus
  riskLevel: string
  description: string
  spotsAvailable: string
  totalSpots: string
}

function draftFromProgram(p: BuiltInProgram): Draft {
  return {
    name: p.name,
    expectedReturn: p.expectedReturn,
    returnFrequency: p.returnFrequency,
    minInvestment: String(p.minInvestment),
    maxInvestment: String(p.maxInvestment),
    duration: p.duration,
    status: p.status,
    riskLevel: p.riskLevel,
    description: p.description,
    spotsAvailable: String(p.spotsAvailable),
    totalSpots: String(p.totalSpots),
  }
}

export function YieldProgramManager({ passcode }: { passcode: string }) {
  const [overrides, setOverrides] = useState<Record<string, YieldProgramOverride>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const res = await getAdminYieldProgramOverrides(passcode)
      if (!alive) return
      if (res.ok) setOverrides(res.overrides)
      else setLoadError(res.error)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [passcode])

  const effective = useMemo(
    () => PPP_PROGRAMS.map((p) => applyProgramOverride(p, overrides[p.id])),
    [overrides],
  )

  const toggleHidden = async (programId: string, hidden: boolean) => {
    setBusyId(programId)
    const res = await setYieldProgramOverride(passcode, programId, { hidden })
    setBusyId(null)
    if (res.ok) {
      setOverrides(res.overrides)
      toast.success(hidden ? "Program hidden from customers" : "Program visible to customers")
    } else {
      toast.error("Update failed", { description: res.error })
    }
  }

  const openEdit = (programId: string) => {
    const eff = effective.find((p) => p.id === programId)
    if (!eff) return
    setDraft(draftFromProgram(eff))
    setEditId(programId)
  }

  const saveEdit = async () => {
    if (!editId || !draft) return
    setSaving(true)
    const res = await setYieldProgramOverride(passcode, editId, {
      name: draft.name.trim() || null,
      expectedReturn: draft.expectedReturn.trim() || null,
      returnFrequency: draft.returnFrequency.trim() || null,
      minInvestment: draft.minInvestment.trim() ? Number(draft.minInvestment) : null,
      maxInvestment: draft.maxInvestment.trim() ? Number(draft.maxInvestment) : null,
      duration: draft.duration.trim() || null,
      status: draft.status,
      riskLevel: draft.riskLevel.trim() || null,
      description: draft.description.trim() || null,
      spotsAvailable: draft.spotsAvailable.trim() ? Number(draft.spotsAvailable) : null,
      totalSpots: draft.totalSpots.trim() ? Number(draft.totalSpots) : null,
    })
    setSaving(false)
    if (res.ok) {
      setOverrides(res.overrides)
      setEditId(null)
      setDraft(null)
      toast.success("Program updated for customers")
    } else {
      toast.error("Update failed", { description: res.error })
    }
  }

  const resetProgram = async (programId: string) => {
    setBusyId(programId)
    const res = await resetYieldProgramOverride(passcode, programId)
    setBusyId(null)
    if (res.ok) {
      setOverrides(res.overrides)
      toast.success("Program reset to default parameters")
    } else {
      toast.error("Reset failed", { description: res.error })
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Program Controls — Built-in Yields</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Hide, edit or reset any of the standard programs customers see in the Yield / PPP section — including their
          risk level and returns. Changes take effect immediately. Bank-partner institutional yields are managed above.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading program controls…
          </div>
        ) : loadError ? (
          <p className="py-4 text-sm text-red-400">{loadError}</p>
        ) : (
          effective.map((p) => {
            const hasOverride = Boolean(overrides[p.id])
            const status = STATUS_META[p.status]
            const busy = busyId === p.id
            return (
              <div
                key={p.id}
                className={cn(
                  "rounded-lg border border-border bg-background/60 p-4",
                  p.hidden && "opacity-60",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{p.name}</span>
                      <Badge variant="outline" className={cn("text-[10px]", status.className)}>
                        {status.label}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] bg-secondary/50">
                        Risk: {p.riskLevel}
                      </Badge>
                      {p.hidden && (
                        <Badge variant="outline" className="text-[10px] border-red-500/20 bg-red-500/10 text-red-400">
                          Hidden
                        </Badge>
                      )}
                      {hasOverride && !p.hidden && (
                        <Badge variant="outline" className="text-[10px] border-primary/20 bg-primary/10 text-primary">
                          Customized
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.expectedReturn} · {p.returnFrequency} · {p.duration} · {fmtMoney(p.minInvestment)}–
                      {fmtMoney(p.maxInvestment)} · {p.spotsAvailable}/{p.totalSpots} spots
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      {p.hidden ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                      <Switch
                        checked={!p.hidden}
                        disabled={busy}
                        onCheckedChange={(visible) => toggleHidden(p.id, !visible)}
                        aria-label={p.hidden ? "Show program" : "Hide program"}
                      />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => openEdit(p.id)} disabled={busy}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => resetProgram(p.id)}
                      disabled={busy || !hasOverride}
                      title={hasOverride ? "Reset to default" : "No changes to reset"}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </CardContent>

      {/* Edit dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => (!o ? (setEditId(null), setDraft(null)) : null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit program</DialogTitle>
            <DialogDescription>
              These values are shown to customers immediately. Use “Reset” on the row to restore the built-in defaults.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="yp-name">Program name</Label>
                <Input id="yp-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="yp-return">Expected return</Label>
                  <Input
                    id="yp-return"
                    value={draft.expectedReturn}
                    onChange={(e) => setDraft({ ...draft, expectedReturn: e.target.value })}
                    placeholder="e.g. 40-60%"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="yp-freq">Return frequency</Label>
                  <Input
                    id="yp-freq"
                    value={draft.returnFrequency}
                    onChange={(e) => setDraft({ ...draft, returnFrequency: e.target.value })}
                    placeholder="e.g. Monthly"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Risk level</Label>
                  <Select value={draft.riskLevel} onValueChange={(v) => setDraft({ ...draft, riskLevel: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select risk" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROGRAM_RISK_LEVELS.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Availability status</Label>
                  <Select
                    value={draft.status}
                    onValueChange={(v) => setDraft({ ...draft, status: v as ProgramStatus })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROGRAM_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_META[s].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="yp-min">Min investment</Label>
                  <MoneyInput
                    id="yp-min"
                    value={draft.minInvestment}
                    onValueChange={(v) => setDraft({ ...draft, minInvestment: v })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="yp-max">Max investment</Label>
                  <MoneyInput
                    id="yp-max"
                    value={draft.maxInvestment}
                    onValueChange={(v) => setDraft({ ...draft, maxInvestment: v })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="yp-spots">Spots available</Label>
                  <Input
                    id="yp-spots"
                    inputMode="numeric"
                    value={draft.spotsAvailable}
                    onChange={(e) => setDraft({ ...draft, spotsAvailable: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="yp-total">Total spots</Label>
                  <Input
                    id="yp-total"
                    inputMode="numeric"
                    value={draft.totalSpots}
                    onChange={(e) => setDraft({ ...draft, totalSpots: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="yp-duration">Duration</Label>
                <Input
                  id="yp-duration"
                  value={draft.duration}
                  onChange={(e) => setDraft({ ...draft, duration: e.target.value })}
                  placeholder="e.g. 40 banking weeks"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="yp-desc">Description</Label>
                <Textarea
                  id="yp-desc"
                  rows={3}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setEditId(null)
                setDraft(null)
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
