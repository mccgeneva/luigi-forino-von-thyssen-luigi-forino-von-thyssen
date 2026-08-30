"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  CreditCard,
  Check,
  X,
  Loader2,
  RefreshCw,
  Sparkles,
  ShieldCheck,
  Settings2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
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
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import { adminListApprovals } from "@/app/actions/approvals"
import { adminDecideCardRequest, adminIssueCard } from "@/app/actions/cards"
import { useActivityLog } from "@/components/activity-tracker"
import type { ApprovalRequest, ApprovalStatus } from "@/lib/approvals-db"
import {
  TIER_LABELS,
  CARD_FEATURES,
  tierVariant,
  defaultControls,
  genCardId,
  genLast4,
  genExpiry,
  type CardNetwork,
  type CardTier,
  type CardFormat,
} from "@/lib/card-requests-store"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]
const NETWORK_TIERS: Record<CardNetwork, CardTier[]> = {
  Visa: ["standard", "gold", "platinum", "signature"],
  Mastercard: ["standard", "gold", "platinum", "world_elite"],
}

const statusVariant: Record<ApprovalStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  awaiting_master: "outline",
  approved: "secondary",
  rejected: "destructive",
  cancelled: "outline",
}

type CardPayload = {
  id?: string
  holder?: string
  network?: CardNetwork
  tier?: CardTier
  format?: CardFormat
  currency?: string
  monthlyLimit?: number
  requestedLimit?: number
  number?: string
  last4?: string
  expiry?: string
  cvv?: string
  purpose?: string
}

function readCard(req: ApprovalRequest): CardPayload {
  return ((req.payload as { card?: CardPayload })?.card ?? {}) as CardPayload
}

/** Digits only. */
function cardDigits(value: string): string {
  return value.replace(/\D/g, "")
}

/** Format a PAN as space-separated groups of 4 (max 19 digits). */
function formatPan(value: string): string {
  return cardDigits(value).slice(0, 19).replace(/(.{4})/g, "$1 ").trim()
}

/** Format expiry input progressively as MM/YY. */
function formatExpiryInput(value: string): string {
  const d = cardDigits(value).slice(0, 4)
  return d.length <= 2 ? d : `${d.slice(0, 2)}/${d.slice(2)}`
}

/**
 * Validate manually-entered card credentials. Returns an error string, or null
 * when valid. The PAN must be 12–19 digits, expiry a real MM/YY, CVV 3–4 digits.
 */
function validateCardCredentials(number: string, expiry: string, cvv: string): string | null {
  const digits = cardDigits(number)
  if (digits.length < 12 || digits.length > 19) return "Enter a valid card number (12–19 digits)."
  const m = expiry.match(/^(\d{2})\/(\d{2})$/)
  if (!m) return "Enter the expiry date as MM/YY."
  const month = Number(m[1])
  if (month < 1 || month > 12) return "The expiry month must be between 01 and 12."
  const code = cardDigits(cvv)
  if (code.length < 3 || code.length > 4) return "Enter a valid CVV (3 or 4 digits)."
  return null
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return iso
  }
}

interface CustomizeState {
  req: ApprovalRequest
  network: CardNetwork
  tier: CardTier
  format: CardFormat
  currency: string
  limit: string
  features: string[]
  number: string
  expiry: string
  cvv: string
}

export function CardManager() {
  const log = useActivityLog()
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [acting, setActing] = useState(false)

  // Review/customize dialog state.
  const [customize, setCustomize] = useState<CustomizeState | null>(null)
  // Reject dialog state.
  const [rejectTarget, setRejectTarget] = useState<ApprovalRequest | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  // Issue-direct form state.
  const [issueClient, setIssueClient] = useState("")
  const [issueNetwork, setIssueNetwork] = useState<CardNetwork>("Visa")
  const [issueTier, setIssueTier] = useState<CardTier>("platinum")
  const [issueFormat, setIssueFormat] = useState<CardFormat>("physical")
  const [issueCurrency, setIssueCurrency] = useState("EUR")
  const [issueLimit, setIssueLimit] = useState("100000")
  // Administrator-entered card credentials.
  const [issueNumber, setIssueNumber] = useState("")
  const [issueExpiry, setIssueExpiry] = useState("")
  const [issueCvv, setIssueCvv] = useState("")
  const [issueFeatures, setIssueFeatures] = useState<string[]>([
    "Airport lounge access",
    "24/7 concierge service",
  ])
  const [issuing, setIssuing] = useState(false)

  useEffect(() => {
    listSelectableClients(ADMIN_PASSCODE)
      .then(setClients)
      .catch(() => setClients([]))
  }, [])

  const clientLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of clients) map.set(c.id, `${c.fullName}${c.company ? ` · ${c.company}` : ""}`)
    return (userId: string) => map.get(userId) ?? userId
  }, [clients])

  const { data: requests = [], isLoading, mutate } = useSWR(
    ["admin-card-approvals"],
    async () => {
      const res = await adminListApprovals(ADMIN_PASSCODE, { kind: "card" })
      return res.ok ? res.requests : []
    },
    { refreshInterval: 20000 },
  )

  const pending = requests.filter((r) => r.status === "pending")
  const decided = requests.filter((r) => r.status !== "pending")
  // The Issue form fulfils a pending request for the chosen client instead of
  // creating a second card, so surface when that will happen.
  const pendingForIssueClient = issueClient ? pending.find((r) => r.userId === issueClient) ?? null : null

  const openCustomize = (req: ApprovalRequest) => {
    const c = readCard(req)
    const network = c.network ?? "Visa"
    const tier = c.tier ?? "platinum"
    setCustomize({
      req,
      network,
      tier,
      format: c.format ?? "physical",
      currency: c.currency ?? req.currency ?? "EUR",
      limit: String(c.requestedLimit ?? c.monthlyLimit ?? req.amount ?? 0),
      features: tier === "platinum" || tier === "signature" || tier === "world_elite"
        ? ["Airport lounge access", "24/7 concierge service"]
        : [],
      // Administrator types the real credentials; prefill any that already exist.
      number: c.number ? formatPan(c.number) : "",
      expiry: c.expiry ?? "",
      cvv: c.cvv ?? "",
    })
  }

  const toggleCustomizeFeature = (feature: string) => {
    setCustomize((prev) =>
      prev
        ? {
            ...prev,
            features: prev.features.includes(feature)
              ? prev.features.filter((f) => f !== feature)
              : [...prev.features, feature],
          }
        : prev,
    )
  }

  const confirmApprove = async () => {
    if (!customize) return
    const numericLimit = Number.parseFloat(customize.limit.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      toast.error("Enter a valid monthly limit greater than 0.")
      return
    }
    const credError = validateCardCredentials(customize.number, customize.expiry, customize.cvv)
    if (credError) {
      toast.error(credError)
      return
    }
    const fullNumber = cardDigits(customize.number)
    const original = readCard(customize.req)
    const finalCard = {
      id: original.id || genCardId(),
      holder: original.holder ?? "",
      network: customize.network,
      tier: customize.tier,
      format: customize.format,
      currency: customize.currency,
      monthlyLimit: numericLimit,
      monthlySpent: 0,
      number: fullNumber,
      last4: fullNumber.slice(-4),
      expiry: customize.expiry,
      cvv: cardDigits(customize.cvv),
      features: customize.features,
      label: `${customize.network} ${TIER_LABELS[customize.tier]}`,
      variant: tierVariant(customize.tier),
      controls: defaultControls(),
      status: "active",
    }
    setActing(true)
    const res = await adminDecideCardRequest(ADMIN_PASSCODE, customize.req.id, "approved", finalCard)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Card approved & activated", {
      description: `${finalCard.label} card delivered to ${clientLabel(customize.req.userId)}.`,
    })
    log({
      action: `Administrator approved a ${finalCard.label} card for ${clientLabel(customize.req.userId)}`,
      category: "Administration / Cards",
      details: {
        summary: `Administrator approved and activated a ${finalCard.label} ${finalCard.format} card with a ${finalCard.currency} ${numericLimit.toLocaleString("en-US")} monthly limit.`,
        referenceId: customize.req.id,
        card: finalCard.label,
        monthlyLimit: `${finalCard.currency} ${numericLimit.toLocaleString("en-US")}`,
        features: finalCard.features.join(", ") || "(none)",
        decision: "Approved",
      },
    })
    setCustomize(null)
    mutate()
  }

  const confirmReject = async () => {
    if (!rejectTarget) return
    if (!rejectReason.trim()) {
      toast.error("A reason is required to reject.")
      return
    }
    setActing(true)
    const res = await adminDecideCardRequest(ADMIN_PASSCODE, rejectTarget.id, "rejected", undefined, rejectReason)
    setActing(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("Card request rejected")
    setRejectTarget(null)
    setRejectReason("")
    mutate()
  }

  const toggleIssueFeature = (feature: string) => {
    setIssueFeatures((prev) =>
      prev.includes(feature) ? prev.filter((f) => f !== feature) : [...prev, feature],
    )
  }

  const handleNetworkChange = (value: string, isIssue: boolean) => {
    const next = value as CardNetwork
    if (isIssue) {
      setIssueNetwork(next)
      if (!NETWORK_TIERS[next].includes(issueTier)) setIssueTier("platinum")
    } else {
      setCustomize((prev) =>
        prev
          ? { ...prev, network: next, tier: NETWORK_TIERS[next].includes(prev.tier) ? prev.tier : "platinum" }
          : prev,
      )
    }
  }

  const handleIssue = async () => {
    const client = clients.find((c) => c.id === issueClient)
    if (!client) {
      toast.error("Select a client to issue to.")
      return
    }
    const numericLimit = Number.parseFloat(issueLimit.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      toast.error("Enter a valid monthly limit greater than 0.")
      return
    }
    const credError = validateCardCredentials(issueNumber, issueExpiry, issueCvv)
    if (credError) {
      toast.error(credError)
      return
    }
    const fullNumber = cardDigits(issueNumber)
    // If this client already has a PENDING card request, fulfil THAT request in
    // place (preserving its card id) instead of issuing a second card — issuing
    // a fresh card here while the request stays pending is what produced two
    // cards (one auto-fake-numbered pending, one with the real numbers).
    const existingPending = pending.find((r) => r.userId === issueClient)
    const existingCardId = existingPending ? readCard(existingPending).id : ""
    const card = {
      id: existingCardId || genCardId(),
      holder: client.fullName,
      network: issueNetwork,
      tier: issueTier,
      format: issueFormat,
      currency: issueCurrency,
      monthlyLimit: numericLimit,
      monthlySpent: 0,
      number: fullNumber,
      last4: fullNumber.slice(-4),
      expiry: issueExpiry,
      cvv: cardDigits(issueCvv),
      features: issueFeatures,
      label: `${issueNetwork} ${TIER_LABELS[issueTier]}`,
      variant: tierVariant(issueTier),
      controls: defaultControls(),
      status: "active",
    }
    setIssuing(true)
    const res = existingPending
      ? await adminDecideCardRequest(ADMIN_PASSCODE, existingPending.id, "approved", card)
      : await adminIssueCard(ADMIN_PASSCODE, issueClient, card)
    setIssuing(false)
    if (!res.ok) {
      toast.error("Could not issue card", { description: res.error })
      return
    }
    toast.success(existingPending ? "Pending request approved & activated" : "Card issued", {
      description: existingPending
        ? `${card.label} card delivered to ${client.fullName} — their pending request was fulfilled (no duplicate).`
        : `${card.label} card delivered to ${client.fullName}.`,
    })
    if (existingPending) mutate()
    log({
      action: `Administrator issued a ${card.label} card to ${client.fullName}`,
      category: "Administration / Cards",
      details: {
        summary: `Administrator issued a premium ${card.label} ${card.format} card with a ${card.currency} ${numericLimit.toLocaleString("en-US")} monthly limit directly to ${client.fullName}.`,
        referenceId: card.id,
        card: card.label,
        monthlyLimit: `${card.currency} ${numericLimit.toLocaleString("en-US")}`,
        features: card.features.join(", ") || "(none)",
        targetAccount: `${client.fullName} — ${client.email}`,
      },
    })
    setIssueClient("")
    setIssueLimit("100000")
    setIssueNumber("")
    setIssueExpiry("")
    setIssueCvv("")
  }

  return (
    <div className="space-y-6">
      {/* Pending card requests */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/15 p-2">
                <CreditCard className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>Card Requests</CardTitle>
                <p className="text-sm text-muted-foreground text-pretty">
                  Review, customize and authorize client card requests. Approving delivers the finalized
                  card to the client&apos;s wallet.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => mutate()} disabled={isLoading}>
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : pending.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No card requests awaiting a decision.
            </p>
          ) : (
            <ul className="space-y-2">
              {pending.map((req) => {
                const c = readCard(req)
                return (
                  <li
                    key={req.id}
                    className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {c.network ?? "Card"} {c.tier ? TIER_LABELS[c.tier] : ""}
                        </Badge>
                        <Badge variant={statusVariant[req.status]} className="text-[10px] capitalize">
                          {req.status}
                        </Badge>
                        <span className="text-sm font-semibold text-foreground">
                          {(c.currency ?? req.currency ?? "EUR")}{" "}
                          {(c.requestedLimit ?? c.monthlyLimit ?? req.amount ?? 0).toLocaleString("en-US")}/mo
                        </span>
                      </div>
                      <p className="text-sm font-medium text-foreground">{req.title}</p>
                      {req.summary && <p className="text-xs text-muted-foreground text-pretty">{req.summary}</p>}
                      <p className="text-[11px] text-muted-foreground">
                        {clientLabel(req.userId)} · submitted {formatDate(req.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button size="sm" className="h-8 gap-1" disabled={acting} onClick={() => openCustomize(req)}>
                        <Settings2 className="h-3.5 w-3.5" /> Review &amp; approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-destructive"
                        disabled={acting}
                        onClick={() => {
                          setRejectReason("")
                          setRejectTarget(req)
                        }}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {decided.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">History</p>
              <ul className="space-y-2">
                {decided.slice(0, 15).map((req) => {
                  const c = readCard(req)
                  return (
                    <li key={req.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-2.5">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Badge variant={statusVariant[req.status]} className="text-[10px] capitalize">
                            {req.status}
                          </Badge>
                          <span className="truncate text-sm text-foreground">
                            {c.network ?? "Card"} {c.tier ? TIER_LABELS[c.tier] : ""} · {clientLabel(req.userId)}
                          </span>
                        </div>
                        {req.decisionNote && (
                          <p className="text-[11px] text-muted-foreground">Reason: {req.decisionNote}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {req.decidedAt ? formatDate(req.decidedAt) : ""}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Issue a premium card directly */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/15 p-2">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Issue Premium Card</CardTitle>
              <p className="text-sm text-muted-foreground text-pretty">
                Create a super-premium Visa or Mastercard and deliver it directly into a client&apos;s
                wallet — active immediately, no request required.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="issue-card-client">Client</Label>
            <Select value={issueClient} onValueChange={setIssueClient}>
              <SelectTrigger id="issue-card-client">
                <SelectValue placeholder="Select a client account" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.fullName} {c.company ? `· ${c.company}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="issue-card-network">Network</Label>
              <Select value={issueNetwork} onValueChange={(v) => handleNetworkChange(v, true)}>
                <SelectTrigger id="issue-card-network">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Visa">Visa</SelectItem>
                  <SelectItem value="Mastercard">Mastercard</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="issue-card-tier">Tier</Label>
              <Select value={issueTier} onValueChange={(v) => setIssueTier(v as CardTier)}>
                <SelectTrigger id="issue-card-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORK_TIERS[issueNetwork].map((t) => (
                    <SelectItem key={t} value={t}>
                      {TIER_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="issue-card-format">Format</Label>
              <Select value={issueFormat} onValueChange={(v) => setIssueFormat(v as CardFormat)}>
                <SelectTrigger id="issue-card-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="physical">Physical</SelectItem>
                  <SelectItem value="virtual">Virtual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="issue-card-currency">Currency</Label>
              <Select value={issueCurrency} onValueChange={setIssueCurrency}>
                <SelectTrigger id="issue-card-currency">
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
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="issue-card-limit">Monthly limit</Label>
              <MoneyInput
                id="issue-card-limit"
                value={issueLimit}
                onValueChange={setIssueLimit}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium">Card credentials</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter the real card number, expiry and CVV — these are delivered to the client exactly as typed.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="issue-card-number">Card number</Label>
                <Input
                  id="issue-card-number"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="1234 5678 9012 3456"
                  value={issueNumber}
                  onChange={(e) => setIssueNumber(formatPan(e.target.value))}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-card-expiry">Expiry (MM/YY)</Label>
                <Input
                  id="issue-card-expiry"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="MM/YY"
                  value={issueExpiry}
                  onChange={(e) => setIssueExpiry(formatExpiryInput(e.target.value))}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-card-cvv">CVV</Label>
                <Input
                  id="issue-card-cvv"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123"
                  value={issueCvv}
                  onChange={(e) => setIssueCvv(cardDigits(e.target.value).slice(0, 4))}
                  className="font-mono"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Premium features</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {CARD_FEATURES.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/30 p-2.5 text-sm">
                  <Checkbox checked={issueFeatures.includes(f)} onCheckedChange={() => toggleIssueFeature(f)} />
                  {f}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs text-muted-foreground text-pretty">
              {pendingForIssueClient
                ? "This client has a pending card request — issuing here will fulfil that request with the details above (updating their existing pending card), so no duplicate card is created."
                : "Issuance is recorded on the approvals backbone and delivered to the client's wallet across devices. The client can then manage limits and controls themselves."}
            </p>
          </div>

          <Button onClick={handleIssue} disabled={issuing} className="w-full sm:w-auto">
            {issuing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
            {pendingForIssueClient ? "Approve pending request" : "Issue card"}
          </Button>
        </CardContent>
      </Card>

      {/* Review & customize dialog */}
      <Dialog open={customize !== null} onOpenChange={(o) => !o && setCustomize(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review &amp; customize card</DialogTitle>
            <DialogDescription className="text-pretty">
              Adjust the card before approving. Your final selection is what the client receives and can
              manage.
            </DialogDescription>
          </DialogHeader>
          {customize && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Requested by <span className="font-medium text-foreground">{clientLabel(customize.req.userId)}</span>
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Network</Label>
                  <Select value={customize.network} onValueChange={(v) => handleNetworkChange(v, false)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Visa">Visa</SelectItem>
                      <SelectItem value="Mastercard">Mastercard</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Tier</Label>
                  <Select
                    value={customize.tier}
                    onValueChange={(v) => setCustomize((p) => (p ? { ...p, tier: v as CardTier } : p))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NETWORK_TIERS[customize.network].map((t) => (
                        <SelectItem key={t} value={t}>
                          {TIER_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Format</Label>
                  <Select
                    value={customize.format}
                    onValueChange={(v) => setCustomize((p) => (p ? { ...p, format: v as CardFormat } : p))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="physical">Physical</SelectItem>
                      <SelectItem value="virtual">Virtual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Currency</Label>
                  <Select
                    value={customize.currency}
                    onValueChange={(v) => setCustomize((p) => (p ? { ...p, currency: v } : p))}
                  >
                    <SelectTrigger>
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
                <div className="grid gap-2 sm:col-span-2">
                  <Label>Approved monthly limit</Label>
                  <Input
                    type="number"
                    min="0"
                    step="1000"
                    value={customize.limit}
                    onChange={(e) => setCustomize((p) => (p ? { ...p, limit: e.target.value } : p))}
                  />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label>Card number</Label>
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="1234 5678 9012 3456"
                    value={customize.number}
                    onChange={(e) =>
                      setCustomize((p) => (p ? { ...p, number: formatPan(e.target.value) } : p))
                    }
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Expiry (MM/YY)</Label>
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="MM/YY"
                    value={customize.expiry}
                    onChange={(e) =>
                      setCustomize((p) => (p ? { ...p, expiry: formatExpiryInput(e.target.value) } : p))
                    }
                    className="font-mono"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>CVV</Label>
                  <Input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="123"
                    value={customize.cvv}
                    onChange={(e) =>
                      setCustomize((p) => (p ? { ...p, cvv: cardDigits(e.target.value).slice(0, 4) } : p))
                    }
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Premium features</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CARD_FEATURES.map((f) => (
                    <label key={f} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/30 p-2.5 text-sm">
                      <Checkbox checked={customize.features.includes(f)} onCheckedChange={() => toggleCustomizeFeature(f)} />
                      {f}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCustomize(null)} disabled={acting}>
              Cancel
            </Button>
            <Button onClick={confirmApprove} disabled={acting}>
              {acting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
              Approve &amp; activate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectTarget !== null} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject card request</DialogTitle>
            <DialogDescription>
              A reason is required and will be recorded in the audit trail and shown to the client.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Explain why this card request is being declined…"
            className="min-h-24 text-base md:text-sm"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)} disabled={acting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReject} disabled={acting || !rejectReason.trim()}>
              {acting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}
              Confirm rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
