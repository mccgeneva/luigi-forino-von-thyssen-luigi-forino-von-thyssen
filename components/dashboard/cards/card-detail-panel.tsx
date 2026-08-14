"use client"

import { useState } from "react"
import {
  Snowflake,
  Eye,
  EyeOff,
  ShieldCheck,
  Lock,
  Smartphone,
  Globe,
  Globe2,
  Clock,
  XCircle,
  Trash2,
  Check,
  Sparkles,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import {
  useCardRequests,
  TIER_LABELS,
  type ClientCard,
  type CardControls,
} from "@/lib/card-requests-store"

const CONTROL_META: { id: keyof CardControls; label: string; icon: typeof Globe }[] = [
  { id: "online", label: "Online payments", icon: Globe },
  { id: "contactless", label: "Contactless", icon: Smartphone },
  { id: "atm", label: "ATM withdrawals", icon: Lock },
  { id: "international", label: "International use", icon: Globe2 },
]

function money(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US")}`
}

export function CardDetailPanel({ card }: { card: ClientCard }) {
  const { setLimit, setBlocked, setControl, cancelRequest, deleteCard } = useCardRequests()
  const log = useActivityLog()
  const [detailsVisible, setDetailsVisible] = useState(false)
  const [limitDraft, setLimitDraft] = useState(String(card.monthlyLimit))
  const [editingLimit, setEditingLimit] = useState(false)

  const cardName = `${card.network} ${TIER_LABELS[card.tier]}`

  // ---- Pending ----------------------------------------------------------
  if (card.status === "pending") {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">{cardName}</CardTitle>
          <p className="text-xs text-muted-foreground">Awaiting administrator review</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Request pending approval</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Your {cardName} request was submitted{" "}
                {card.submittedAt ? new Date(card.submittedAt).toLocaleString("en-GB") : ""} and is being
                reviewed by MCC Capital. You can manage it here once activated.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Requested limit" value={money(card.requestedLimit ?? card.monthlyLimit, card.currency)} />
            <Detail label="Format" value={card.format === "virtual" ? "Virtual" : "Physical"} />
            {card.purpose && <Detail label="Purpose" value={card.purpose} />}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={() => {
              cancelRequest(card.id)
              log({
                action: `Cancelled the pending ${cardName} card request`,
                category: "Cards",
                details: { summary: `Client cancelled their pending ${cardName} card request.`, card: cardName },
              })
              toast.success("Card request cancelled")
            }}
          >
            <XCircle className="mr-2 h-4 w-4" />
            Cancel request
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ---- Rejected / cancelled --------------------------------------------
  if (card.status === "rejected" || card.status === "cancelled") {
    const rejected = card.status === "rejected"
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">{cardName}</CardTitle>
          <p className="text-xs text-muted-foreground">{rejected ? "Request declined" : "Request cancelled"}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {rejected ? "This request was declined" : "This request was cancelled"}
              </p>
              {rejected && card.decisionNote && (
                <p className="text-xs text-muted-foreground text-pretty">Reason: {card.decisionNote}</p>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => deleteCard(card.id)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove from wallet
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ---- Active / blocked -------------------------------------------------
  const blocked = card.status === "blocked"
  const spentPct = card.monthlyLimit > 0 ? Math.min(100, Math.round((card.monthlySpent / card.monthlyLimit) * 100)) : 0

  const saveLimit = () => {
    const next = Number.parseFloat(limitDraft.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(next) || next <= 0) {
      toast.error("Enter a valid limit greater than 0.")
      return
    }
    setLimit(card.id, next)
    setEditingLimit(false)
    log({
      action: `Adjusted the monthly limit on ${cardName} ending ${card.last4}`,
      category: "Cards",
      details: {
        summary: `Client set the monthly spending limit for ${cardName} (•••• ${card.last4}) to ${money(next, card.currency)}.`,
        card: cardName,
        last4: card.last4,
        newLimit: money(next, card.currency),
      },
    })
    toast.success("Spending limit updated", { description: `New limit: ${money(next, card.currency)}` })
  }

  const toggleBlock = () => {
    const willBlock = !blocked
    setBlocked(card.id, willBlock)
    log({
      action: `${willBlock ? "Blocked" : "Unblocked"} ${cardName} ending ${card.last4}`,
      category: "Cards",
      details: {
        summary: `Client ${willBlock ? "blocked" : "unblocked"} the ${cardName} card (•••• ${card.last4}). It is now ${willBlock ? "blocked and cannot be used" : "active and ready for use"}.`,
        card: cardName,
        last4: card.last4,
        newState: willBlock ? "Blocked" : "Active",
      },
    })
    toast.success(willBlock ? "Card blocked" : "Card unblocked")
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-lg font-semibold">
            {cardName} •••• {card.last4}
          </CardTitle>
          <Badge variant={blocked ? "destructive" : "secondary"} className="capitalize">
            {card.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{card.format === "virtual" ? "Virtual" : "Physical"} card settings and security controls</p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-2">
          <Button variant={blocked ? "default" : "outline"} size="sm" onClick={toggleBlock}>
            <Snowflake className="mr-2 h-4 w-4" />
            {blocked ? "Unblock Card" : "Block Card"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDetailsVisible((v) => !v)}>
            {detailsVisible ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {detailsVisible ? "Hide Details" : "Show Details"}
          </Button>
        </div>

        {detailsVisible && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-secondary/30 p-4 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Card Number</p>
              <p className="font-mono text-sm text-foreground">
                {card.number
                  ? card.number.replace(/\D/g, "").replace(/(.{4})/g, "$1 ").trim()
                  : `•••• •••• •••• ${card.last4}`}
              </p>
            </div>
            <Detail mono label="Expires" value={card.expiry} />
            <Detail mono label="CVV" value={card.cvv} />
            <Detail mono label="Network" value={card.network} />
          </div>
        )}

        {/* Spending limit */}
        <div className="rounded-lg border border-border bg-secondary/20 p-4">
          <div className="flex items-end justify-between">
            <span className="text-2xl font-bold text-foreground">{money(card.monthlySpent, card.currency)}</span>
            <span className="text-sm text-muted-foreground">of {money(card.monthlyLimit, card.currency)}</span>
          </div>
          <Progress value={spentPct} className="mt-2" />
          <p className="mt-1 text-xs text-muted-foreground">{spentPct}% of monthly limit used</p>

          {editingLimit ? (
            <div className="mt-3 flex items-center gap-2">
              <Input
                type="number"
                min="0"
                step="1000"
                value={limitDraft}
                onChange={(e) => setLimitDraft(e.target.value)}
                className="h-9"
              />
              <Button size="sm" onClick={saveLimit}>
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingLimit(false)
                  setLimitDraft(String(card.monthlyLimit))
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditingLimit(true)}>
              Adjust limit
            </Button>
          )}
        </div>

        {/* Usage controls */}
        <div className="space-y-3">
          {CONTROL_META.map((control) => (
            <div
              key={control.id}
              className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <control.icon className="h-4 w-4 text-primary" />
                </div>
                <span className="text-sm text-foreground">{control.label}</span>
              </div>
              <Switch
                checked={card.controls[control.id]}
                disabled={blocked}
                onCheckedChange={(checked) => {
                  setControl(card.id, control.id, checked)
                  log({
                    action: `${checked ? "Enabled" : "Disabled"} ${control.label.toLowerCase()} on ${cardName} ending ${card.last4}`,
                    category: "Cards",
                    details: {
                      summary: `Client ${checked ? "enabled" : "disabled"} "${control.label}" for the ${cardName} card (•••• ${card.last4}).`,
                      card: cardName,
                      last4: card.last4,
                      control: control.label,
                      newState: checked ? "Enabled" : "Disabled",
                    },
                  })
                }}
              />
            </div>
          ))}
        </div>

        {/* Premium features */}
        {card.features.length > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-foreground">Premium features</span>
            </div>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {card.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Check className="h-3.5 w-3.5 text-primary" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <p className="text-xs text-muted-foreground">3-D Secure enabled — online transactions require biometric approval.</p>
        </div>
      </CardContent>
    </Card>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm text-foreground" : "text-sm font-medium text-foreground"}>{value}</p>
    </div>
  )
}
