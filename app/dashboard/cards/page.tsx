"use client"

import { useMemo, useState, useEffect } from "react"
import { toast } from "sonner"
import { CreditCard as CreditCardIcon, CheckCircle2, Clock, Ban, Trash2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { CardVisual, type BankCard } from "@/components/dashboard/bank-cards"
import { useActivityLog } from "@/components/activity-tracker"
import { useCurrentUser } from "@/lib/use-current-user"
import {
  useCardRequests,
  TIER_LABELS,
  type ClientCard,
  type NewCardRequest,
} from "@/lib/card-requests-store"
import { RequestCardDialog } from "@/components/dashboard/cards/request-card-dialog"
import { CardDetailPanel } from "@/components/dashboard/cards/card-detail-panel"

const STATUS_BADGE: Record<ClientCard["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "default" },
  active: { label: "Active", variant: "secondary" },
  blocked: { label: "Blocked", variant: "destructive" },
  rejected: { label: "Declined", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
}

/** Map a ClientCard onto the shared embossed card visual. */
function toBankCard(c: ClientCard): BankCard {
  return {
    id: c.id,
    label: `${c.network} ${TIER_LABELS[c.tier]}`,
    holder: c.holder,
    last4: c.last4,
    expiry: c.expiry,
    network: c.network === "Visa" ? "VISA" : "Mastercard",
    variant: c.variant,
    frozen: c.status === "blocked" || c.status === "pending",
  }
}

export default function CardsPage() {
  const log = useActivityLog()
  const user = useCurrentUser()
  const { cards, requestCard, deleteCard } = useCardRequests()

  const [activeId, setActiveId] = useState<string | null>(null)

  const handleRemove = (card: ClientCard) => {
    deleteCard(card.id)
    if (activeId === card.id) setActiveId(null)
    log({
      action: `Removed a declined ${card.network} ${TIER_LABELS[card.tier]} card`,
      category: "Cards",
      details: {
        summary: `Client removed the declined ${card.network} ${TIER_LABELS[card.tier]} card (ending ${card.last4}) from their wallet view.`,
      },
    })
    toast.success("Card removed", {
      description: "The declined card has been removed from your wallet.",
    })
  }

  // Keep a valid selection as the list changes (new request, activation, etc.).
  useEffect(() => {
    if (cards.length === 0) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (!activeId || !cards.some((c) => c.id === activeId)) {
      setActiveId(cards[0].id)
    }
  }, [cards, activeId])

  const activeCard = cards.find((c) => c.id === activeId) ?? null

  const counts = useMemo(() => {
    return {
      active: cards.filter((c) => c.status === "active").length,
      pending: cards.filter((c) => c.status === "pending").length,
      blocked: cards.filter((c) => c.status === "blocked").length,
    }
  }, [cards])

  const handleRequest = (req: NewCardRequest) => {
    const card = requestCard(req)
    setActiveId(card.id)
    log({
      action: `Requested a new ${req.network} ${TIER_LABELS[req.tier]} card`,
      category: "Cards",
      details: {
        summary: `Client requested a new ${req.network} ${TIER_LABELS[req.tier]} ${req.format} card with a ${req.currency} ${req.requestedLimit.toLocaleString("en-US")} monthly limit${req.purpose ? ` for ${req.purpose}` : ""}. Awaiting administrator approval.`,
        network: req.network,
        tier: TIER_LABELS[req.tier],
        requestedLimit: `${req.currency} ${req.requestedLimit.toLocaleString("en-US")}`,
        purpose: req.purpose ?? "(not specified)",
      },
    })
    toast.success("Card request submitted", {
      description: "MCC Capital will review and activate your card shortly.",
    })
  }

  const holder = user.cardHolderPerson || user.cardHolderCompany || ""

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cards</h1>
          <p className="text-sm text-muted-foreground">
            Request, activate and manage your MCC Capital Visa &amp; Mastercard cards
          </p>
        </div>
        <RequestCardDialog holder={holder} onRequest={handleRequest} />
      </div>

      {/* Status overview */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile icon={CheckCircle2} label="Active" value={counts.active} tone="text-emerald-500" />
        <StatTile icon={Clock} label="Pending" value={counts.pending} tone="text-amber-500" />
        <StatTile icon={Ban} label="Blocked" value={counts.blocked} tone="text-destructive" />
      </div>

      {cards.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <CreditCardIcon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">No cards yet</p>
              <p className="text-sm text-muted-foreground">
                Request your first MCC Capital card to get started.
              </p>
            </div>
            <RequestCardDialog holder={holder} onRequest={handleRequest} />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Card carousel */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => {
              const badge = STATUS_BADGE[card.status]
              const removable = card.status === "rejected" || card.status === "cancelled"
              return (
                <div key={card.id} className="group relative text-left">
                  <button
                    onClick={() => setActiveId(card.id)}
                    className="block w-full rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Select ${card.network} ${TIER_LABELS[card.tier]} card`}
                  >
                    <CardVisual
                      card={toBankCard(card)}
                      className={
                        activeId === card.id ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
                      }
                    />
                  </button>
                  <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
                    <Badge variant={badge.variant} className="text-[10px]">
                      {badge.label}
                    </Badge>
                    {removable && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            size="icon"
                            className="h-7 w-7 rounded-full shadow-md"
                            aria-label={`Remove declined ${card.network} ${TIER_LABELS[card.tier]} card`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove this card?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the declined {card.network} {TIER_LABELS[card.tier]} card
                              (ending {card.last4}) from your wallet. This only affects your view — it
                              does not reverse the administrator&apos;s decision.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleRemove(card)}>Remove</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Selected card management */}
          {activeCard && <CardDetailPanel key={activeCard.id} card={activeCard} />}
        </>
      )}
    </div>
  )
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2
  label: string
  value: number
  tone: string
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary/50">
          <Icon className={`h-5 w-5 ${tone}`} />
        </div>
        <div>
          <p className="text-xl font-bold text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}
