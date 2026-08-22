"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ArrowUpCircle, Loader2, RefreshCw, Search, Lock, Sparkles } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { BankCombobox } from "@/components/admin/bank-combobox"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { INSTRUMENT_UPGRADE_FEE_LABEL, instrumentUpgradeFee, type InstrumentUpgrade } from "@/lib/instrument-upgrade"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "SGD", "HKD"]

// Instrument type → full label, offered for the fresh upgraded instrument.
const INSTRUMENT_TYPES: { code: string; full: string }[] = [
  { code: "SBLC", full: "Standby Letter of Credit" },
  { code: "BG", full: "Bank Guarantee" },
  { code: "DLC", full: "Documentary Letter of Credit" },
  { code: "MTN", full: "Medium Term Note" },
  { code: "EMTN", full: "Euro Medium Term Note" },
  { code: "LC", full: "Letter of Credit" },
  { code: "CD", full: "Certificate of Deposit" },
  { code: "POF", full: "Proof of Funds" },
]

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
  upgrade: InstrumentUpgrade | null
}

function money(amount: number | undefined, currency: string | undefined): string {
  const n = Number(amount ?? 0)
  return `${currency ?? ""} ${n.toLocaleString("en-US")}`.trim()
}

export function InstrumentUpgradeManager() {
  const [items, setItems] = useState<HeldInstrument[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  // Start-upgrade dialog state
  const [target, setTarget] = useState<HeldInstrument | null>(null)
  const [bankKey, setBankKey] = useState("")
  const [newTypeCode, setNewTypeCode] = useState("SBLC")
  const [newFaceValue, setNewFaceValue] = useState("")
  const [newCurrency, setNewCurrency] = useState("EUR")
  const [terms, setTerms] = useState("")
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch("/api/admin/instrument-upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "list", pin: ADMIN_PASSCODE }),
      })
      const data = await res.json()
      if (!data.ok) {
        setLoadError(data.reason === "unauthorized" ? "Administrator authorization failed." : data.error ?? "Could not load instruments.")
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
    return items.filter((i) => {
      const inst = i.instrument
      return (
        i.holderLabel.toLowerCase().includes(q) ||
        i.holderEmail.toLowerCase().includes(q) ||
        String(inst.typeFull ?? "").toLowerCase().includes(q) ||
        String(inst.issuer ?? "").toLowerCase().includes(q) ||
        String(inst.isin ?? "").toLowerCase().includes(q) ||
        String(inst.id ?? "").toLowerCase().includes(q)
      )
    })
  }, [items, search])

  const openStart = useCallback((it: HeldInstrument) => {
    setTarget(it)
    setBankKey("")
    setNewTypeCode(it.instrument.type || "SBLC")
    setNewFaceValue("")
    setNewCurrency(it.instrument.currency || "EUR")
    setTerms(
      `The customer's existing instrument is blocked from all use while the transformation is arranged. On acceptance, the upgraded instrument is delivered into the customer's portfolio and the old one is retired. The ${INSTRUMENT_UPGRADE_FEE_LABEL} expertise & upgrade fee is charged upfront and refunded only if the customer declines the deal.`,
    )
    setNote("")
  }, [])

  const oldFace = Number(target?.instrument.faceValue ?? 0)
  const oldCurrency = target?.instrument.currency ?? "USD"
  const fee = instrumentUpgradeFee(oldFace)

  const submitStart = useCallback(async () => {
    if (!target) return
    const faceNum = Number(newFaceValue.replace(/,/g, ""))
    if (!bankKey) {
      toast.error("Select a reputable partner bank for the new instrument.")
      return
    }
    if (!Number.isFinite(faceNum) || faceNum <= 0) {
      toast.error("Enter a valid negotiated face value.")
      return
    }
    const typeDef = INSTRUMENT_TYPES.find((t) => t.code === newTypeCode) ?? INSTRUMENT_TYPES[0]
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/instrument-upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({
          op: "start",
          pin: ADMIN_PASSCODE,
          approvalId: target.approvalId,
          newBankKey: bankKey,
          newType: typeDef.code,
          newTypeFull: typeDef.full,
          newFaceValue: faceNum,
          newCurrency,
          terms: terms.trim(),
          note: note.trim(),
        }),
      })
      const data = await res.json()
      if (!data.ok) {
        toast.error(data.error ?? "The upgrade could not be started.")
        return
      }
      toast.success(
        `Upgrade proposed. Old instrument blocked and ${money(data.fee, data.feeCurrency)} expertise fee charged.`,
      )
      setTarget(null)
      void load()
    } catch {
      toast.error("Could not reach the server. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }, [target, bankKey, newFaceValue, newTypeCode, newCurrency, terms, note, load])

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <ArrowUpCircle className="size-5 text-primary" />
              Instrument Transformation & Upgrade
            </CardTitle>
            <CardDescription className="mt-1">
              Block a customer&apos;s held instrument and transform it into a fresh, better one from a reputable
              partner bank. A one-time {INSTRUMENT_UPGRADE_FEE_LABEL} expertise &amp; upgrade fee is
              charged upfront (balance checked first).
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="shrink-0">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            <span className="ml-2 hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by holder, instrument, issuer or ISIN"
            className="pl-9 text-base"
          />
        </div>

        {loadError ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {loadError}
          </p>
        ) : null}

        {filtered.length === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No active bank instruments found.</p>
        ) : (
          <ul className="space-y-3">
            {filtered.map((it) => {
              const inProgress = it.upgrade?.status === "proposed"
              return (
                <li
                  key={it.approvalId}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{it.instrument.typeFull ?? it.instrument.type ?? "Instrument"}</span>
                      <span className="text-sm text-muted-foreground">{money(it.instrument.faceValue, it.instrument.currency)}</span>
                      {inProgress ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="size-3" /> Blocked — upgrade proposed
                        </Badge>
                      ) : it.upgrade?.status === "accepted" ? (
                        <Badge className="gap-1 bg-primary/15 text-primary">
                          <Sparkles className="size-3" /> Upgraded
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {it.holderLabel} · {it.instrument.issuer ?? "—"} · {it.instrument.isin ?? it.instrument.id}
                    </p>
                    {inProgress && it.upgrade ? (
                      <p className="text-xs text-muted-foreground">
                        Proposed: {money(it.upgrade.newFaceValue, it.upgrade.newCurrency)} {it.upgrade.newTypeFull} — {it.upgrade.newIssuer}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0">
                    {inProgress ? (
                      <span className="text-sm text-muted-foreground">Awaiting customer acceptance</span>
                    ) : (
                      <Button size="sm" onClick={() => openStart(it)}>
                        <ArrowUpCircle className="mr-2 size-4" /> Start upgrade
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* Start-upgrade dialog */}
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Transform &amp; upgrade instrument</DialogTitle>
            <DialogDescription>
              {target ? (
                <>
                  Blocking {target.holderLabel}&apos;s {target.instrument.typeFull ?? "instrument"} (
                  {money(target.instrument.faceValue, target.instrument.currency)}) and proposing a fresh instrument.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="up-bank">Reputable partner bank (new issuer)</Label>
              <BankCombobox id="up-bank" value={bankKey} onChange={setBankKey} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="up-type">New instrument type</Label>
                <Select value={newTypeCode} onValueChange={setNewTypeCode}>
                  <SelectTrigger id="up-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INSTRUMENT_TYPES.map((t) => (
                      <SelectItem key={t.code} value={t.code}>
                        {t.code} — {t.full}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="up-ccy">Currency</Label>
                <Select value={newCurrency} onValueChange={setNewCurrency}>
                  <SelectTrigger id="up-ccy">
                    <SelectValue />
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="up-face">Negotiated new face value</Label>
              <Input
                id="up-face"
                inputMode="numeric"
                value={newFaceValue}
                onChange={(e) => setNewFaceValue(e.target.value)}
                placeholder="e.g. 150000000"
                className="text-base"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="up-terms">Terms &amp; agreements</Label>
              <Textarea id="up-terms" value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} className="text-base" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="up-note">Note to customer (optional)</Label>
              <Input id="up-note" value={note} onChange={(e) => setNote(e.target.value)} className="text-base" />
            </div>

            {/* Fee summary */}
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Expertise &amp; upgrade fee ({INSTRUMENT_UPGRADE_FEE_LABEL} of {money(oldFace, oldCurrency)})
                </span>
                <span className="font-semibold">{money(fee, oldCurrency)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Charged to the customer&apos;s Master Account now. Their balance is verified first — the upgrade is
                refused if they cannot cover it. Refunded automatically if the customer declines the deal.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void submitStart()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Lock className="mr-2 size-4" />}
              Block &amp; propose ({money(fee, oldCurrency)})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
