"use client"

import { useCallback, useEffect, useState } from "react"
import { Ship, Clock, MapPin, Anchor, Flame, Droplet, Handshake, Loader2, Gauge, RefreshCw, MessageSquare, CheckCircle2, FileText, ArrowRight } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  type SpotDeal,
  type VesselType,
  dealCountdown,
  VESSEL_TYPE_LABELS,
} from "@/lib/spot-deals-shared"
import { listLiveSpotDeals, recordSpotDealInterest, acceptSpotDeal, listMyReservedSpotDeals } from "@/app/actions/spot-deals"
import { useCommodityDeals, DEAL_STAGES, type CommodityDeal } from "@/lib/commodity-deals-store"
import { AisFeedStatus, VesselLivePositionLine } from "@/components/dashboard/vessel-live-position"

const VESSEL_ICON: Record<VesselType, typeof Ship> = {
  crude: Droplet,
  product: Ship,
  gas: Flame,
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

/** A live, self-updating countdown chip. Re-renders every second off a shared tick. */
function CountdownChip({ expiresAt, tick }: { expiresAt: string; tick: number }) {
  const cd = dealCountdown(expiresAt, tick)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums",
        cd.expired
          ? "border-muted-foreground/30 bg-muted text-muted-foreground"
          : cd.urgent
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      <Clock className="h-3 w-3" />
      {cd.expired ? "Expired" : cd.label}
    </span>
  )
}

function SpotDealCard({
  deal,
  tick,
  onSelect,
}: {
  deal: SpotDeal
  tick: number
  onSelect: (deal: SpotDeal) => void
}) {
  const Icon = VESSEL_ICON[deal.vesselType]
  const cd = dealCountdown(deal.expiresAt, tick)
  return (
    <Card className="overflow-hidden border-border bg-card transition-colors hover:border-primary/40">
      <CardContent className="flex flex-col gap-4 p-5">
        {/* Header: product + countdown */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-pretty text-sm font-semibold leading-tight text-foreground">{deal.product}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{VESSEL_TYPE_LABELS[deal.vesselType]}</p>
            </div>
          </div>
          <CountdownChip expiresAt={deal.expiresAt} tick={tick} />
        </div>

        {/* Vessel + route */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
          <div className="col-span-2 flex items-center gap-1.5 text-foreground">
            <Anchor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{deal.vesselName}</span>
            <span className="text-muted-foreground">IMO {deal.vesselImo}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{deal.loadPort}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{deal.incoterm}</span>
          </div>
          {/* Real-time AIS position for this vessel (live provider only). */}
          <div className="col-span-2 border-t border-border/60 pt-2">
            <VesselLivePositionLine imo={deal.vesselImo} />
          </div>
        </div>

        {/* Commercials */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Quantity</p>
            <p className="text-sm font-semibold text-foreground">
              {deal.quantity.toLocaleString("en-US")} {deal.unit}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Spot price</p>
            <p className="text-sm font-semibold text-foreground">
              {formatMoney(deal.spotPrice, deal.currency)}
              <span className="text-xs font-normal text-muted-foreground">/{deal.unit}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total value</p>
            <p className="text-base font-bold text-primary">{formatMoney(deal.totalValue, deal.currency)}</p>
          </div>
          <Button size="sm" disabled={cd.expired} onClick={() => onSelect(deal)} className="gap-1.5">
            <Handshake className="h-4 w-4" />
            Accept / Negotiate
          </Button>
        </div>

        {deal.terms ? <p className="text-pretty text-xs text-muted-foreground">{deal.terms}</p> : null}
      </CardContent>
    </Card>
  )
}

// Status of the tracked commodity deal behind a reserved cargo.
function trackedStatusLine(linked: CommodityDeal | undefined): { label: string; tone: string } {
  if (!linked) return { label: "Setting up tracked deal…", tone: "text-muted-foreground" }
  if (linked.delivered) return { label: "Delivered · deal performed", tone: "text-green-500" }
  const stageLabel = DEAL_STAGES.find((s) => s.key === linked.stage)?.label ?? linked.stage
  switch (linked.status) {
    case "approved":
      return { label: `Approved · ${stageLabel}`, tone: "text-green-500" }
    case "rejected":
      return { label: "Rejected by Administrator", tone: "text-destructive" }
    case "cancelled":
      return { label: "Revoked", tone: "text-muted-foreground" }
    default:
      return { label: `Pending review · ${stageLabel}`, tone: "text-primary" }
  }
}

/** A cargo the current user has reserved — theirs until delivery, off the public board. */
function ReservedDealCard({
  deal,
  linked,
  onOpen,
}: {
  deal: SpotDeal
  linked: CommodityDeal | undefined
  onOpen: () => void
}) {
  const Icon = VESSEL_ICON[deal.vesselType]
  const status = trackedStatusLine(linked)
  return (
    <Card className="overflow-hidden border-primary/40 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-pretty text-sm font-semibold leading-tight text-foreground">{deal.product}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{VESSEL_TYPE_LABELS[deal.vesselType]}</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
            <CheckCircle2 className="h-3 w-3" />
            Reserved by you
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Tracked deal</span>
          <span className={cn("text-xs font-semibold", status.tone)}>{status.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
          <div className="col-span-2 flex items-center gap-1.5 text-foreground">
            <Anchor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{deal.vesselName}</span>
            <span className="text-muted-foreground">IMO {deal.vesselImo}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{deal.loadPort}</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{deal.incoterm}</span>
          </div>
          <div className="col-span-2 border-t border-border/60 pt-2">
            <VesselLivePositionLine imo={deal.vesselImo} />
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Quantity</p>
            <p className="text-sm font-semibold text-foreground">
              {deal.quantity.toLocaleString("en-US")} {deal.unit}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Spot price</p>
            <p className="text-sm font-semibold text-foreground">
              {formatMoney(deal.spotPrice, deal.currency)}
              <span className="text-xs font-normal text-muted-foreground">/{deal.unit}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total value</p>
            <p className="text-base font-bold text-primary">{formatMoney(deal.totalValue, deal.currency)}</p>
          </div>
          <Button size="sm" onClick={onOpen} className="gap-1.5">
            {linked ? <ArrowRight className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            {linked ? "Manage deal" : "Open deal"}
          </Button>
        </div>

        <p className="text-pretty text-xs text-muted-foreground">
          Reserved exclusively for you and removed from the public board. Manage payment, bank instruments, POF and POP
          in the deal workflow — it stays open through to delivery.
        </p>
      </CardContent>
    </Card>
  )
}

export function SpotDealsBoard({
  onEngage,
  onOpenTrackedDeal,
}: {
  onEngage: (deal: SpotDeal, mode: "accepted" | "negotiate") => void
  onOpenTrackedDeal: (trackedDealId: string) => void
}) {
  const { deals: trackedDeals } = useCommodityDeals()
  const [deals, setDeals] = useState<SpotDeal[]>([])
  const [reserved, setReserved] = useState<SpotDeal[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const [live, mine] = await Promise.all([listLiveSpotDeals(), listMyReservedSpotDeals()])
      setDeals(live)
      setReserved(mine)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Refresh the board periodically so newly published / withdrawn deals appear.
    const poll = setInterval(load, 30_000)
    // Drive all countdowns from a single 1s tick.
    const ticker = setInterval(() => setTick(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(ticker)
    }
  }, [load])

  // Drop deals the moment their countdown hits zero, without waiting for a poll.
  const liveDeals = deals.filter((d) => dealCountdown(d.expiresAt, tick).expired === false)

  // The deal whose Accept/Negotiate confirmation dialog is open, plus a busy flag.
  const [selected, setSelected] = useState<SpotDeal | null>(null)
  const [accepting, setAccepting] = useState(false)

  const handleSelect = useCallback((deal: SpotDeal) => setSelected(deal), [])

  // Accept = reserve the cargo. Claims it server-side (published → engaged) so it
  // leaves the public board for everyone, then auto-creates the tracked commodity
  // deal. Optimistic removal gives immediate, unmistakable feedback.
  const handleAccept = useCallback(async () => {
    if (!selected || accepting) return
    setAccepting(true)
    try {
      const res = await acceptSpotDeal(selected.id)
      if (!res.ok) {
        toast.error(res.error ?? "Could not accept this offer.")
        // It may have just been taken — refresh so the board reflects reality.
        load()
        setSelected(null)
        return
      }
      // Move it out of the public board and into the user's own reserved list.
      setDeals((prev) => prev.filter((d) => d.id !== selected.id))
      setReserved((prev) =>
        prev.some((d) => d.id === selected.id) ? prev : [{ ...selected, status: "engaged" }, ...prev],
      )
      // Auto-create (and navigate to) the tracked commodity deal with full tooling.
      onEngage(selected, "accepted")
      setSelected(null)
      // Reconcile with the server so the reserved card reflects the stored record.
      load()
    } finally {
      setAccepting(false)
    }
  }, [selected, accepting, onEngage, load])

  // Negotiate = open the deal form to propose different terms WITHOUT reserving.
  // The offer intentionally stays live on the board for others.
  const handleNegotiate = useCallback(() => {
    if (!selected) return
    recordSpotDealInterest(selected.id, "engaged").catch(() => {})
    onEngage(selected, "negotiate")
    toast.success("Loaded into the deal form to negotiate", {
      description: "Adjust the terms and submit for Administrator approval. The offer stays open until accepted.",
    })
    setSelected(null)
  }, [selected, onEngage])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading live spot offers…
      </div>
    )
  }

  // The user's reserved cargoes — always shown (when present), even if the public
  // board is empty, so an accepted deal never "disappears" on its owner.
  const reservedSection =
    reserved.length > 0 ? (
      <div className="space-y-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Your reserved cargoes
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Spot deals you accepted. Reserved exclusively for you until delivery — others can no longer see them.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {reserved.map((deal) => {
            const linked = trackedDeals.find((d) => d.spotDealId === deal.id)
            return (
              <ReservedDealCard
                key={deal.id}
                deal={deal}
                linked={linked}
                // If the tracked deal already exists, jump straight to it; otherwise
                // create it now (heals cargoes reserved before auto-create existed).
                onOpen={() => (linked ? onOpenTrackedDeal(linked.id) : onEngage(deal, "accepted"))}
              />
            )
          })}
        </div>
      </div>
    ) : null

  const dialog = (
    <Dialog open={selected !== null} onOpenChange={(open) => !open && !accepting && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-pretty">{selected?.product}</DialogTitle>
            <DialogDescription className="text-pretty">
              {selected
                ? `${selected.quantity.toLocaleString("en-US")} ${selected.unit} aboard ${selected.vesselName} (IMO ${selected.vesselImo}) — ${selected.incoterm}${selected.loadPort ? ` ${selected.loadPort}` : ""}.`
                : null}
            </DialogDescription>
          </DialogHeader>

          {selected ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Spot price</span>
                <span className="font-semibold">
                  {formatMoney(selected.spotPrice, selected.currency)}/{selected.unit}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Total value</span>
                <span className="font-bold text-primary">{formatMoney(selected.totalValue, selected.currency)}</span>
              </div>
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground text-pretty">
            <span className="font-medium text-foreground">Accept &amp; reserve</span> claims this cargo and removes it
            from the public board, then pre-fills a deal for Administrator approval.{" "}
            <span className="font-medium text-foreground">Negotiate</span> opens the deal form to propose different
            terms while leaving the offer open. Nothing executes or moves funds automatically.
          </p>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button onClick={handleAccept} disabled={accepting} className="w-full gap-1.5">
              {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Handshake className="h-4 w-4" />}
              Accept &amp; reserve cargo
            </Button>
            <Button variant="outline" onClick={handleNegotiate} disabled={accepting} className="w-full gap-1.5">
              <MessageSquare className="h-4 w-4" />
              Negotiate terms
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  )

  return (
    <div className="space-y-8">
      {/* AIS feed connectivity — one honest indicator for the whole board. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <span className="text-xs text-muted-foreground">
          Vessel positions are streamed from a live AIS provider.
        </span>
        <AisFeedStatus />
      </div>

      {reservedSection}

      {liveDeals.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Ship className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">No live spot deals right now</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Special limited-time cargoes published by the trading desk will appear here.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load} className="gap-1.5 bg-transparent">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{liveDeals.length}</span> limited-time spot{" "}
              {liveDeals.length === 1 ? "offer" : "offers"} from the trading desk. Accepting reserves the cargo for you
              — nothing executes automatically.
            </p>
            <Button variant="ghost" size="sm" onClick={load} className="gap-1.5">
              <RefreshCw className="h-4 w-4" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {liveDeals.map((deal) => (
              <SpotDealCard key={deal.id} deal={deal} tick={tick} onSelect={handleSelect} />
            ))}
          </div>
        </div>
      )}

      {dialog}
    </div>
  )
}
