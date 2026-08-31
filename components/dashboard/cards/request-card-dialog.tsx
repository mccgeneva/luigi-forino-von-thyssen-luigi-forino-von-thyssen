"use client"

import { useState } from "react"
import { CreditCard, Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  TIER_LABELS,
  type CardNetwork,
  type CardTier,
  type CardFormat,
  type NewCardRequest,
  type RequestCardResult,
} from "@/lib/card-requests-store"
import { cardFeeFor, formatCardFee } from "@/lib/card-fees"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

const NETWORK_TIERS: Record<CardNetwork, CardTier[]> = {
  Visa: ["standard", "gold", "platinum", "signature"],
  Mastercard: ["standard", "gold", "platinum", "world_elite"],
}

const TIER_NOTE: Record<CardTier, string> = {
  standard: "Everyday spending",
  gold: "Enhanced limits & rewards",
  platinum: "Premium travel & lounge access",
  signature: "Visa Signature — concierge & insurance",
  world_elite: "Mastercard World Elite — top-tier privileges",
}

export function RequestCardDialog({
  holder,
  onRequest,
}: {
  holder: string
  onRequest: (req: NewCardRequest) => Promise<RequestCardResult>
}) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [network, setNetwork] = useState<CardNetwork>("Visa")
  const [tier, setTier] = useState<CardTier>("platinum")
  const [format, setFormat] = useState<CardFormat>("physical")
  const [currency, setCurrency] = useState("EUR")
  const [limit, setLimit] = useState("50000")
  const [purpose, setPurpose] = useState("")

  const reset = () => {
    setNetwork("Visa")
    setTier("platinum")
    setFormat("physical")
    setCurrency("EUR")
    setLimit("50000")
    setPurpose("")
  }

  // One-time issuance fee for the currently-selected format (virtual €300 /
  // physical €1,000), shown upfront and enforced/charged server-side on submit.
  const feeLabel = formatCardFee(cardFeeFor(format))

  const handleNetworkChange = (value: string) => {
    const next = value as CardNetwork
    setNetwork(next)
    // Keep the selected tier valid for the chosen network.
    if (!NETWORK_TIERS[next].includes(tier)) setTier("platinum")
  }

  const submit = async () => {
    if (submitting) return
    const numericLimit = Number.parseFloat(limit.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      toast.error("Enter a valid requested monthly limit greater than 0.")
      return
    }
    setSubmitting(true)
    const result = await onRequest({
      holder,
      network,
      tier,
      format,
      currency,
      requestedLimit: numericLimit,
      purpose: purpose.trim() || undefined,
    })
    setSubmitting(false)
    // On a real-time rejection (e.g. insufficient balance for the fee) keep the
    // dialog open so the user can adjust or fund; the reason is toasted by the
    // page. Only close and reset on success.
    if (result.ok) {
      setOpen(false)
      reset()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <CreditCard className="mr-2 h-4 w-4" />
          Request New Card
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a new card</DialogTitle>
          <DialogDescription className="text-pretty">
            Choose your preferred card. Your request is sent to MCC Capital for review and
            customization before activation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Network */}
          <div className="space-y-2">
            <Label>Card network</Label>
            <div className="grid grid-cols-2 gap-2">
              {(["Visa", "Mastercard"] as CardNetwork[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => handleNetworkChange(n)}
                  className={cn(
                    "flex items-center justify-center rounded-lg border p-3 text-sm font-semibold transition-colors",
                    network === n
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Tier */}
            <div className="space-y-2">
              <Label htmlFor="card-tier">Card tier</Label>
              <Select value={tier} onValueChange={(v) => setTier(v as CardTier)}>
                <SelectTrigger id="card-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORK_TIERS[network].map((t) => (
                    <SelectItem key={t} value={t}>
                      {TIER_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3 text-primary" />
                {TIER_NOTE[tier]}
              </p>
            </div>

            {/* Format */}
            <div className="space-y-2">
              <Label htmlFor="card-format">Format</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as CardFormat)}>
                <SelectTrigger id="card-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="physical">Physical</SelectItem>
                  <SelectItem value="virtual">Virtual</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Currency */}
            <div className="space-y-2">
              <Label htmlFor="card-currency">Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="card-currency">
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

            {/* Requested limit */}
            <div className="space-y-2">
              <Label htmlFor="card-limit">Requested monthly limit</Label>
              <MoneyInput
                id="card-limit"
                value={limit}
                onValueChange={setLimit}
                placeholder="50,000"
              />
            </div>
          </div>

          {/* Purpose */}
          <div className="space-y-2">
            <Label htmlFor="card-purpose">Purpose (optional)</Label>
            <Input
              id="card-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Business travel & procurement"
            />
          </div>

          <div className="rounded-lg border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
            Card holder: <span className="font-medium text-foreground">{holder || "—"}</span>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs text-muted-foreground">
              A one-time{" "}
              <span className="font-semibold text-foreground">{feeLabel} issuance fee</span> (
              {format === "virtual" ? "virtual" : "physical"} card) is debited from your Master
              Account when you submit. If your available balance can&apos;t cover it, the request is
              declined immediately and nothing is charged.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CreditCard className="mr-2 h-4 w-4" />
            )}
            {submitting ? "Processing…" : `Submit & pay ${feeLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
