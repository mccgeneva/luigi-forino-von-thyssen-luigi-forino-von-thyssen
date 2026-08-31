"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CreditCard, Loader2, Upload, Sparkles, ReceiptText, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { adminRecordCardTransaction } from "@/app/actions/cards"
import { CARD_TRANSACTION_FEE_LABEL, CARD_TRANSACTION_FEE_RATE } from "@/lib/card-transaction-fees"
import { useActivityLog } from "@/components/activity-tracker"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]
const round2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number, ccy: string) =>
  `${ccy} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

interface ClientOption {
  id: string
  fullName: string
  company?: string
  email?: string
}

export function CardTransactionRecorder() {
  const log = useActivityLog()
  const fileRef = useRef<HTMLInputElement>(null)

  const [clients, setClients] = useState<ClientOption[]>([])
  const [clientId, setClientId] = useState("")

  const [analyzing, setAnalyzing] = useState(false)
  const [recording, setRecording] = useState(false)
  const [receiptName, setReceiptName] = useState("")
  const [extractError, setExtractError] = useState<string | null>(null)

  const [merchant, setMerchant] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [date, setDate] = useState("")
  const [last4, setLast4] = useState("")
  const [network, setNetwork] = useState("")
  const [reference, setReference] = useState("")
  const [notes, setNotes] = useState("")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch("/api/admin/cards", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pin: ADMIN_PASSCODE, op: "list" }),
        })
        const data = await resp.json()
        if (!cancelled && data.ok && Array.isArray(data.clients)) setClients(data.clients)
      } catch {
        /* non-fatal — admin can still record after choosing a client once loaded */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const numericAmount = round2(Number((amount || "").replace(/[^0-9.]/g, "")))
  const validAmount = Number.isFinite(numericAmount) && numericAmount > 0
  const fee = validAmount ? round2(numericAmount * CARD_TRANSACTION_FEE_RATE) : 0
  const total = validAmount ? round2(numericAmount + fee) : 0
  const canRecord = !!clientId && validAmount && !recording && !analyzing

  const selectedClient = useMemo(() => clients.find((c) => c.id === clientId), [clients, clientId])

  const resetForm = useCallback(() => {
    setMerchant("")
    setAmount("")
    setDate("")
    setLast4("")
    setNetwork("")
    setReference("")
    setNotes("")
    setReceiptName("")
    setExtractError(null)
    if (fileRef.current) fileRef.current.value = ""
  }, [])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setReceiptName(file.name)
    setExtractError(null)
    setAnalyzing(true)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("passcode", ADMIN_PASSCODE)
      const resp = await fetch("/api/admin/card-transaction/extract", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body: form,
      })
      const data = await resp.json()
      if (!data.ok) {
        setExtractError(data.error || "Could not read the receipt. Enter the details manually.")
        return
      }
      const d = data.data as {
        merchant?: string
        amount?: string
        currency?: string
        date?: string
        last4?: string
        cardNetwork?: string
        reference?: string
        summary?: string
      }
      if (d.merchant) setMerchant(d.merchant)
      if (d.amount) setAmount(d.amount.replace(/[^0-9.]/g, ""))
      if (d.currency && CURRENCIES.includes(d.currency.toUpperCase())) setCurrency(d.currency.toUpperCase())
      if (d.date) setDate(d.date)
      if (d.last4) setLast4(d.last4.replace(/\D/g, "").slice(-4))
      if (d.cardNetwork) setNetwork(d.cardNetwork)
      if (d.reference) setReference(d.reference)
      if (d.summary) setNotes(d.summary)
      toast.success("Receipt analyzed", { description: "Review the details below, then record the transaction." })
    } catch {
      setExtractError("Could not analyze the receipt. Enter the details manually.")
    } finally {
      setAnalyzing(false)
    }
  }

  const record = async () => {
    if (!canRecord) return
    setRecording(true)
    const res = await adminRecordCardTransaction(ADMIN_PASSCODE, clientId, {
      amount: numericAmount,
      currency,
      merchant,
      date,
      last4,
      reference,
      network,
      notes,
    })
    setRecording(false)
    if (!res.ok) {
      toast.error("Could not record transaction", { description: res.error })
      return
    }
    toast.success("Transaction recorded", {
      description: `${fmt(res.amount, res.currency)} + ${CARD_TRANSACTION_FEE_LABEL} fee (${fmt(res.fee, res.currency)}) = ${fmt(res.total, res.currency)} charged to ${selectedClient?.fullName ?? "the client"}.`,
    })
    log({
      action: `Recorded a card transaction for ${selectedClient?.fullName ?? clientId}`,
      category: "Administration / Cards",
      details: {
        summary: `Charged ${fmt(res.total, res.currency)} (amount ${fmt(res.amount, res.currency)} + ${CARD_TRANSACTION_FEE_LABEL} fee ${fmt(res.fee, res.currency)}) to the Master Account.`,
        merchant: merchant || "(none)",
        reference: reference || "(none)",
      },
    })
    resetForm()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ReceiptText className="h-5 w-5 text-primary" />
          Record a card transaction
        </CardTitle>
        <p className="text-sm text-muted-foreground text-pretty">
          Upload a PDF or photo of a card receipt to read it automatically, or enter the details by hand. The amount
          plus a {CARD_TRANSACTION_FEE_LABEL} fee is debited from the client&apos;s Master Account and reflects on their
          balance automatically.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Client */}
        <div className="space-y-1.5">
          <Label htmlFor="ctr-client">Client account</Label>
          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger id="ctr-client">
              <SelectValue placeholder="Select a client account" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.fullName}
                  {c.company ? ` — ${c.company}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Upload */}
        <div className="rounded-lg border border-dashed border-border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={analyzing}
            >
              {analyzing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              {analyzing ? "Reading receipt…" : "Upload receipt (PDF / image)"}
            </Button>
            {receiptName && (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                {receiptName}
              </span>
            )}
          </div>
          {extractError && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {extractError}
            </p>
          )}
        </div>

        {/* Details */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ctr-merchant">Merchant</Label>
            <Input id="ctr-merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Apple Store" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ctr-amount">Amount</Label>
            <MoneyInput id="ctr-amount" value={amount} onValueChange={setAmount} placeholder="0.00" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ctr-currency">Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="ctr-currency">
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
          <div className="space-y-1.5">
            <Label htmlFor="ctr-date">Transaction date</Label>
            <Input id="ctr-date" value={date} onChange={(e) => setDate(e.target.value)} placeholder="e.g. 30/08/2026" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ctr-last4">Card last 4 (optional)</Label>
            <Input
              id="ctr-last4"
              inputMode="numeric"
              value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="9268"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ctr-ref">Reference (optional)</Label>
            <Input id="ctr-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Authorization / reference number" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ctr-notes">Receipt reading / notes</Label>
            <Textarea
              id="ctr-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What the receipt says — auto-filled from the uploaded document; edit if needed. Stored with the transaction and shown to the client."
              rows={2}
            />
          </div>
        </div>

        {/* Fee summary */}
        <div className="divide-y divide-border rounded-lg border border-border">
          <div className="flex items-center justify-between px-3 py-2.5 text-sm">
            <span className="text-muted-foreground">Transaction amount</span>
            <span className="font-medium text-foreground">{validAmount ? fmt(numericAmount, currency) : "—"}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5 text-sm">
            <span className="text-muted-foreground">Platform fee ({CARD_TRANSACTION_FEE_LABEL})</span>
            <span className="font-medium text-foreground">{validAmount ? fmt(fee, currency) : "—"}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5 text-sm">
            <span className="font-semibold text-foreground">Total charged to Master Account</span>
            <span className="font-bold text-foreground">{validAmount ? fmt(total, currency) : "—"}</span>
          </div>
        </div>

        <Button onClick={record} disabled={!canRecord} className="w-full sm:w-auto">
          {recording ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
          Record transaction &amp; charge account
        </Button>
      </CardContent>
    </Card>
  )
}
