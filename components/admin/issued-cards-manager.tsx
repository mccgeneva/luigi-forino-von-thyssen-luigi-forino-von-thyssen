"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  CreditCard,
  Loader2,
  RefreshCw,
  Pencil,
  Trash2,
  Snowflake,
  Search,
  ShieldAlert,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
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
import {
  TIER_LABELS,
  CARD_FEATURES,
  type CardNetwork,
  type CardTier,
  type CardFormat,
} from "@/lib/card-requests-store"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]
const NETWORK_TIERS: Record<CardNetwork, CardTier[]> = {
  Visa: ["standard", "gold", "platinum", "signature"],
  Mastercard: ["standard", "gold", "platinum", "world_elite"],
}

interface IssuedCard {
  approvalId: string
  userId: string
  holderLabel: string
  holderEmail: string
  card: {
    id?: string
    holder?: string
    network?: CardNetwork
    tier?: CardTier
    format?: CardFormat
    currency?: string
    monthlyLimit?: number
    number?: string
    last4?: string
    expiry?: string
    cvv?: string
    features?: string[]
    status?: string
  }
  status: string
  createdAt: string
  decidedAt: string | null
}

interface EditState {
  target: IssuedCard
  network: CardNetwork
  tier: CardTier
  format: CardFormat
  currency: string
  limit: string
  features: string[]
  status: "active" | "blocked"
  number: string
  expiry: string
  cvv: string
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
/** Validate manually-entered card credentials; returns an error string or null. */
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

function formatDate(iso: string | null): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return iso
  }
}

async function callApi(payload: Record<string, unknown>) {
  const resp = await fetch("/api/admin/cards", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: ADMIN_PASSCODE, ...payload }),
  })
  return resp.json()
}

export function IssuedCardsManager() {
  const [cards, setCards] = useState<IssuedCard[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)

  const [revokeTarget, setRevokeTarget] = useState<IssuedCard | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await callApi({ op: "list" })
      if (data.ok) {
        setCards(Array.isArray(data.cards) ? data.cards : [])
      } else if (data.reason === "unauthorized") {
        setLoadError("Administrator session not recognized. Re-open the panel with your passcode.")
      } else {
        setLoadError(data.error || "Could not load issued cards.")
      }
    } catch {
      setLoadError("Could not reach the server. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cards
    return cards.filter((c) => {
      const hay = [
        c.holderLabel,
        c.holderEmail,
        c.card.network,
        c.card.tier,
        c.card.last4,
        c.card.currency,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [cards, search])

  const openEdit = (target: IssuedCard) => {
    const network = target.card.network ?? "Visa"
    const tier = target.card.tier ?? "standard"
    setEdit({
      target,
      network,
      tier,
      format: target.card.format ?? "physical",
      currency: target.card.currency ?? "EUR",
      limit: String(target.card.monthlyLimit ?? 0),
      features: Array.isArray(target.card.features) ? target.card.features : [],
      status: target.status === "blocked" ? "blocked" : "active",
      number: target.card.number ? formatPan(target.card.number) : "",
      expiry: target.card.expiry ?? "",
      cvv: target.card.cvv ?? "",
    })
  }

  const toggleFeature = (feature: string) => {
    setEdit((prev) =>
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

  const handleNetworkChange = (value: string) => {
    const next = value as CardNetwork
    setEdit((prev) =>
      prev
        ? { ...prev, network: next, tier: NETWORK_TIERS[next].includes(prev.tier) ? prev.tier : "platinum" }
        : prev,
    )
  }

  const saveEdit = async () => {
    if (!edit) return
    const numericLimit = Number.parseFloat(edit.limit.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
      toast.error("Enter a valid monthly limit greater than 0.")
      return
    }
    // Credentials are optional on EDIT: only validate + update them when the
    // administrator has actually entered a full number here (so editing just the
    // limit on a card never forces re-typing the PAN). Any entry is validated.
    const enteredDigits = cardDigits(edit.number)
    const credentialFields: Record<string, unknown> = {}
    if (enteredDigits.length > 0 || edit.expiry.trim() || edit.cvv.trim()) {
      const credError = validateCardCredentials(edit.number, edit.expiry, edit.cvv)
      if (credError) {
        toast.error(credError)
        return
      }
      credentialFields.number = enteredDigits
      credentialFields.last4 = enteredDigits.slice(-4)
      credentialFields.expiry = edit.expiry
      credentialFields.cvv = cardDigits(edit.cvv)
    }
    setSaving(true)
    let res: { ok: boolean; error?: string }
    try {
      res = await callApi({
        op: "update",
        approvalId: edit.target.approvalId,
        network: edit.network,
        tier: edit.tier,
        format: edit.format,
        currency: edit.currency,
        monthlyLimit: numericLimit,
        features: edit.features,
        status: edit.status,
        ...credentialFields,
      })
    } catch {
      res = { ok: false, error: "Could not reach the server." }
    }
    setSaving(false)
    if (!res.ok) {
      toast.error("Couldn't update card", { description: res.error })
      return
    }
    toast.success("Card updated", {
      description: `${edit.network} ${TIER_LABELS[edit.tier]} card saved for ${edit.target.holderLabel}.`,
    })
    setEdit(null)
    void load()
  }

  const confirmRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    let res: { ok: boolean; error?: string }
    try {
      res = await callApi({ op: "revoke", approvalId: revokeTarget.approvalId })
    } catch {
      res = { ok: false, error: "Could not reach the server." }
    }
    setRevoking(false)
    if (!res.ok) {
      toast.error("Couldn't remove card", { description: res.error })
      return
    }
    toast.success("Card removed", {
      description: `The card was removed from ${revokeTarget.holderLabel}'s wallet.`,
    })
    setRevokeTarget(null)
    void load()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/15 p-2">
              <CreditCard className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Issued Cards</CardTitle>
              <p className="text-sm text-muted-foreground text-pretty">
                Every card linked to a customer account. Edit a card&apos;s network, tier, limit,
                features or freeze state, or remove it from the customer&apos;s wallet.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by holder, email, network, tier or last 4…"
            className="pl-9"
          />
        </div>

        {loadError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {loadError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {cards.length === 0 ? "No cards have been issued yet." : "No cards match your search."}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((c) => (
              <li
                key={c.approvalId}
                className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {c.card.network ?? "Card"} {c.card.tier ? TIER_LABELS[c.card.tier] : ""}
                    </Badge>
                    <Badge
                      variant={c.status === "blocked" ? "destructive" : "secondary"}
                      className="text-[10px] capitalize"
                    >
                      {c.status === "blocked" ? "Frozen" : "Active"}
                    </Badge>
                    <span className="text-sm font-semibold text-foreground">
                      {(c.card.currency ?? "EUR")}{" "}
                      {(c.card.monthlyLimit ?? 0).toLocaleString("en-US")}/mo
                    </span>
                    {c.card.last4 && (
                      <span className="text-xs text-muted-foreground">•••• {c.card.last4}</span>
                    )}
                    {c.card.format && (
                      <span className="text-[11px] capitalize text-muted-foreground">{c.card.format}</span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground">{c.holderLabel}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {c.holderEmail ? `${c.holderEmail} · ` : ""}issued {formatDate(c.decidedAt ?? c.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => openEdit(c)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 text-destructive"
                    onClick={() => setRevokeTarget(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Edit dialog */}
      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit card</DialogTitle>
            <DialogDescription className="text-pretty">
              Changes apply immediately to the customer&apos;s wallet across devices.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Linked to <span className="font-medium text-foreground">{edit.target.holderLabel}</span>
                {edit.target.card.last4 ? ` · •••• ${edit.target.card.last4}` : ""}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>Network</Label>
                  <Select value={edit.network} onValueChange={handleNetworkChange}>
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
                    value={edit.tier}
                    onValueChange={(v) => setEdit((p) => (p ? { ...p, tier: v as CardTier } : p))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NETWORK_TIERS[edit.network].map((t) => (
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
                    value={edit.format}
                    onValueChange={(v) => setEdit((p) => (p ? { ...p, format: v as CardFormat } : p))}
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
                    value={edit.currency}
                    onValueChange={(v) => setEdit((p) => (p ? { ...p, currency: v } : p))}
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
                <div className="grid gap-2">
                  <Label>Monthly limit</Label>
                  <MoneyInput
                    value={edit.limit}
                    onValueChange={(v) => setEdit((p) => (p ? { ...p, limit: v } : p))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Card state</Label>
                  <Select
                    value={edit.status}
                    onValueChange={(v) => setEdit((p) => (p ? { ...p, status: v as "active" | "blocked" } : p))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="blocked">Frozen</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-primary" />
                  <p className="text-sm font-medium">Card credentials</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {edit.target.card.number
                    ? "Update the card number, expiry or CVV. These are shown to the client exactly as typed."
                    : "This card has no stored number yet. Enter the real number, expiry and CVV to set them, or leave blank to keep the current values."}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2 sm:col-span-2">
                    <Label>Card number</Label>
                    <Input
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="1234 5678 9012 3456"
                      value={edit.number}
                      onChange={(e) => setEdit((p) => (p ? { ...p, number: formatPan(e.target.value) } : p))}
                      className="font-mono"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Expiry (MM/YY)</Label>
                    <Input
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="MM/YY"
                      value={edit.expiry}
                      onChange={(e) =>
                        setEdit((p) => (p ? { ...p, expiry: formatExpiryInput(e.target.value) } : p))
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
                      value={edit.cvv}
                      onChange={(e) => setEdit((p) => (p ? { ...p, cvv: cardDigits(e.target.value).slice(0, 4) } : p))}
                      className="font-mono"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Premium features</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CARD_FEATURES.map((f) => (
                    <label
                      key={f}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/30 p-2.5 text-sm"
                    >
                      <Checkbox checked={edit.features.includes(f)} onCheckedChange={() => toggleFeature(f)} />
                      {f}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pencil className="mr-2 h-4 w-4" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm dialog */}
      <Dialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this card?</DialogTitle>
            <DialogDescription className="text-pretty">
              This permanently removes the card from{" "}
              <span className="font-medium text-foreground">{revokeTarget?.holderLabel}</span>&apos;s wallet.
              The customer is notified. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <Snowflake className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs text-muted-foreground text-pretty">
              To temporarily block spending instead of deleting, use Edit and set the card state to
              &quot;Frozen&quot;.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRevoke} disabled={revoking}>
              {revoking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Remove card
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
