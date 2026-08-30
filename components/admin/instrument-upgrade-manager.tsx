"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ArrowUpCircle, Loader2, RefreshCw, Search, Sparkles, MessageSquare, Pencil, Undo2, Handshake, Lock } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
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
import { Messenger } from "@/components/bankeka/messenger"
import { adminListConversations, adminGetThread, adminReply, adminDeleteMessage } from "@/app/actions/bankeka"
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
  /** Non-null when the instrument is pledged/reserved to a live facility and cannot be upgraded. */
  engagedReason?: string | null
}

function money(amount: number | undefined, currency: string | undefined): string {
  const n = Number(amount ?? 0)
  return `${currency ?? ""} ${n.toLocaleString("en-US")}`.trim()
}

const NEGOTIATION_TERMS =
  "The customer's instrument stays fully usable while the value is negotiated — nothing is blocked or charged. When the customer confirms the deal, the one-time expertise & upgrade fee is charged to their Master Account, the upgraded instrument is delivered into their portfolio, and the old one is retired."

export function InstrumentUpgradeManager() {
  const [items, setItems] = useState<HeldInstrument[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  // Propose / revise dialog state
  const [target, setTarget] = useState<HeldInstrument | null>(null)
  const [mode, setMode] = useState<"start" | "revise">("start")
  const [bankKey, setBankKey] = useState("")
  const [newTypeCode, setNewTypeCode] = useState("SBLC")
  const [newFaceValue, setNewFaceValue] = useState("")
  const [newCurrency, setNewCurrency] = useState("EUR")
  const [terms, setTerms] = useState("")
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // Inline discussion + per-row busy state
  const [discussFor, setDiscussFor] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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
    setMode("start")
    setBankKey("")
    setNewTypeCode(it.instrument.type || "SBLC")
    setNewFaceValue("")
    setNewCurrency(it.instrument.currency || "EUR")
    setTerms(NEGOTIATION_TERMS)
    setNote("")
  }, [])

  const openRevise = useCallback((it: HeldInstrument) => {
    const u = it.upgrade
    setTarget(it)
    setMode("revise")
    setBankKey("")
    setNewTypeCode(u?.newType || it.instrument.type || "SBLC")
    // Prefill with the customer's counter-offer if they made one, else the current proposal.
    setNewFaceValue(String(u?.customerCounterFaceValue ?? u?.newFaceValue ?? ""))
    setNewCurrency(u?.newCurrency || it.instrument.currency || "EUR")
    setTerms(u?.terms || NEGOTIATION_TERMS)
    setNote(u?.note || "")
  }, [])

  // Fee is 0.08% of the NEGOTIATED new face value (in the new currency) — it must
  // track what the admin types, not the original instrument value.
  const negotiatedFace = Number(newFaceValue.replace(/,/g, "")) || 0
  const fee = instrumentUpgradeFee(negotiatedFace)

  const submitDeal = useCallback(async () => {
    if (!target) return
    const faceNum = Number(newFaceValue.replace(/,/g, ""))
    if (mode === "start" && !bankKey) {
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
          op: mode,
          pin: ADMIN_PASSCODE,
          approvalId: target.approvalId,
          newBankKey: bankKey || undefined,
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
        toast.error(data.error ?? "The offer could not be sent.")
        return
      }
      toast.success(mode === "revise" ? "Revised offer sent to the customer." : "Upgrade proposed — no fee charged until the customer confirms.")
      setTarget(null)
      void load()
    } catch {
      toast.error("Could not reach the server. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }, [target, mode, bankKey, newFaceValue, newTypeCode, newCurrency, terms, note, load])

  const withdraw = useCallback(
    async (it: HeldInstrument) => {
      setBusyId(it.approvalId)
      try {
        const res = await fetch("/api/admin/instrument-upgrade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ op: "cancel", pin: ADMIN_PASSCODE, approvalId: it.approvalId }),
        })
        const data = await res.json()
        if (!data.ok) {
          toast.error(data.error ?? "The offer could not be withdrawn.")
          return
        }
        toast.success(
          data.refunded > 0
            ? `Offer withdrawn. ${money(data.refunded, data.currency)} fee refunded to the customer.`
            : "Offer withdrawn.",
        )
        void load()
      } catch {
        toast.error("Could not reach the server. Please try again.")
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

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
              Propose transforming a customer&apos;s held instrument into a fresh, better one from a reputable partner
              bank. Negotiate the face value with the customer (chat + counter-offers) — the one-time{" "}
              {INSTRUMENT_UPGRADE_FEE_LABEL} expertise &amp; upgrade fee is charged only when they confirm.
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
              const u = it.upgrade
              const negotiating = u?.status === "negotiating"
              const legacyProposed = u?.status === "proposed"
              const open = negotiating || legacyProposed
              const requested = u?.status === "requested"
              const counter = u?.customerCounterFaceValue
              const engaged = !open && u?.status !== "accepted" && !!it.engagedReason
              return (
                <li
                  key={it.approvalId}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{it.instrument.typeFull ?? it.instrument.type ?? "Instrument"}</span>
                        <span className="text-sm text-muted-foreground">{money(it.instrument.faceValue, it.instrument.currency)}</span>
                        {negotiating ? (
                          <Badge variant="secondary" className="gap-1">
                            <Handshake className="size-3" /> In negotiation
                          </Badge>
                        ) : legacyProposed ? (
                          <Badge variant="secondary" className="gap-1">
                            <Handshake className="size-3" /> Awaiting confirmation
                          </Badge>
                        ) : u?.status === "accepted" ? (
                          <Badge className="gap-1 bg-primary/15 text-primary">
                            <Sparkles className="size-3" /> Upgraded
                          </Badge>
                        ) : engaged ? (
                          <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
                            <Lock className="size-3" /> Reserved
                          </Badge>
                        ) : requested ? (
                          <Badge className="gap-1 bg-primary/15 text-primary">
                            <Sparkles className="size-3" /> Customer requested
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm">
                        <span className="font-medium text-foreground">{it.holderLabel}</span>
                        {it.holderEmail ? <span className="text-muted-foreground"> · {it.holderEmail}</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {it.instrument.issuer ?? "—"} · {it.instrument.isin ?? it.instrument.id}
                      </p>
                      {open && u ? (
                        <p className="text-xs text-muted-foreground">
                          Proposed: {money(u.newFaceValue, u.newCurrency)} {u.newTypeFull} — {u.newIssuer}
                        </p>
                      ) : null}
                      {engaged && it.engagedReason ? (
                        <p className="flex items-center gap-1 text-xs text-amber-600">
                          <Lock className="size-3" /> {it.engagedReason}
                        </p>
                      ) : null}
                      {requested && !engaged ? (
                        <p className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
                          <Sparkles className="mr-1 inline size-3" />
                          <span className="font-semibold">{it.holderLabel}</span>
                          {it.holderEmail ? ` (${it.holderEmail})` : ""} requested this upgrade
                          {u?.newTypeFull ? ` into a ${u.newTypeFull}` : ""}
                          {u?.customerRequestNote ? ` — "${u.customerRequestNote}"` : ""}. Propose terms below.
                        </p>
                      ) : null}
                      {open && counter ? (
                        <p className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600">
                          <Handshake className="size-3" /> Customer counter-offer: {money(counter, u?.newCurrency)}
                          {u?.customerCounterNote ? ` — "${u.customerCounterNote}"` : ""}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {open ? (
                        <>
                          <Button
                            size="sm"
                            variant={discussFor === it.approvalId ? "secondary" : "outline"}
                            onClick={() => setDiscussFor(discussFor === it.approvalId ? null : it.approvalId)}
                          >
                            <MessageSquare className="mr-2 size-4" />
                            {discussFor === it.approvalId ? "Hide chat" : "Discuss"}
                          </Button>
                          <Button size="sm" onClick={() => openRevise(it)}>
                            <Pencil className="mr-2 size-4" /> Revise
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void withdraw(it)}
                            disabled={busyId === it.approvalId}
                          >
                            {busyId === it.approvalId ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <Undo2 className="mr-2 size-4" />
                            )}
                            Withdraw
                          </Button>
                        </>
                      ) : u?.status === "accepted" ? (
                        <span className="text-sm text-muted-foreground">Completed</span>
                      ) : engaged ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
                          <Lock className="size-3.5" /> Reserved — cannot be upgraded
                        </span>
                      ) : (
                        <Button size="sm" onClick={() => openStart(it)}>
                          <ArrowUpCircle className="mr-2 size-4" /> Propose upgrade
                        </Button>
                      )}
                    </div>
                  </div>

                  {discussFor === it.approvalId ? (
                    <div className="rounded-lg border border-border bg-card p-2">
                      <Messenger
                        key={it.approvalId}
                        scope={`admin-instr-upgrade-${it.approvalId}`}
                        fetchConversations={() => adminListConversations(ADMIN_PASSCODE)}
                        fetchThread={(id) => adminGetThread(ADMIN_PASSCODE, id)}
                        send={(id, body, atts) => adminReply(ADMIN_PASSCODE, id, body, atts)}
                        deleteMessage={(m) => adminDeleteMessage(ADMIN_PASSCODE, m)}
                        attachmentsEnabled
                        uploadPayload={JSON.stringify({ passcode: ADMIN_PASSCODE })}
                        hideConversationList
                        initialThreadId={it.userId}
                        initialParticipant={{
                          id: it.userId,
                          name: it.holderLabel,
                          company: "",
                          initials: it.holderLabel
                            .split(/\s+/)
                            .map((w) => w[0])
                            .filter(Boolean)
                            .slice(0, 2)
                            .join("")
                            .toUpperCase(),
                          isAdmin: false,
                        }}
                        initialDraft={`Regarding the transformation upgrade of your ${it.instrument.typeFull ?? "instrument"} (${money(
                          it.instrument.faceValue,
                          it.instrument.currency,
                        )}): `}
                      />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* Propose / revise dialog */}
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{mode === "revise" ? "Revise upgrade offer" : "Propose instrument upgrade"}</DialogTitle>
            <DialogDescription>
              {target ? (
                <>
                  {mode === "revise" ? "Revising the offer for " : "Proposing a fresh instrument for "}
                  {target.holderLabel}&apos;s {target.instrument.typeFull ?? "instrument"} (
                  {money(target.instrument.faceValue, target.instrument.currency)}). No fee is charged until the
                  customer confirms.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {/* Show the customer's counter-offer to react to, when revising */}
          {mode === "revise" && target?.upgrade?.customerCounterFaceValue ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="flex items-center gap-1 font-medium text-amber-600">
                <Handshake className="size-4" /> Customer counter-offer
              </p>
              <p className="mt-1 text-foreground">
                {money(target.upgrade.customerCounterFaceValue, target.upgrade.newCurrency)}
                {target.upgrade.customerCounterNote ? ` — "${target.upgrade.customerCounterNote}"` : ""}
              </p>
              <button
                type="button"
                className="mt-2 text-xs font-medium text-primary underline"
                onClick={() => setNewFaceValue(String(target.upgrade?.customerCounterFaceValue ?? ""))}
              >
                Use this value
              </button>
            </div>
          ) : null}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="up-bank">
                Reputable partner bank (new issuer)
                {mode === "revise" && target?.upgrade?.newIssuer ? ` — currently ${target.upgrade.newIssuer}` : ""}
              </Label>
              <BankCombobox id="up-bank" value={bankKey} onChange={setBankKey} />
              {mode === "revise" ? (
                <p className="text-xs text-muted-foreground">Leave unchanged to keep the current issuer.</p>
              ) : null}
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
              <MoneyInput
                id="up-face"
                value={newFaceValue}
                onValueChange={setNewFaceValue}
                placeholder="e.g. 150,000,000"
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

            {/* Fee summary — informational; charged only on customer confirm */}
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Expertise &amp; upgrade fee ({INSTRUMENT_UPGRADE_FEE_LABEL} of {money(negotiatedFace, newCurrency)})
                </span>
                <span className="font-semibold">{money(fee, newCurrency)}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Charged to the customer&apos;s Master Account only when they confirm the deal (balance verified first).
                Nothing is charged now.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void submitDeal()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Handshake className="mr-2 size-4" />}
              {mode === "revise" ? "Send revised offer" : "Propose deal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
