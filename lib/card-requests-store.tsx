"use client"

import { createContext, useContext } from "react"
import { mirrorSubmission, mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { cancelMyApproval, updateMyApprovalRecord } from "@/app/actions/approvals"

// ---------------------------------------------------------------------------
// Payment card lifecycle store.
//
// Mirrors the instrument store's architecture: a per-user localStorage read
// model that MIRRORS each request into the DB-backed approvals backbone (so the
// administrator can review/customize/approve cross-client) and RECONCILES the
// administrator's decision back here. Unlike instruments, an approved card may
// have been CUSTOMIZED by the administrator (network, tier, limit, features),
// so we also pull the finalized card from the approval payload and adopt it.
//
// After activation the client manages the card locally (spending limit,
// block/unblock, controls) — those edits live in this isolated, per-user store.
// ---------------------------------------------------------------------------

export type CardNetwork = "Visa" | "Mastercard"
export type CardTier = "standard" | "gold" | "platinum" | "signature" | "world_elite"
export type CardFormat = "physical" | "virtual"
export type CardStatus = "pending" | "active" | "blocked" | "rejected" | "cancelled"
export type CardVariant = "amber" | "dark" | "platinum"

export interface CardControls {
  online: boolean
  contactless: boolean
  atm: boolean
  international: boolean
}

export interface ClientCard {
  id: string
  /** DB approval id once mirrored, so admin decisions reconcile back. */
  approvalId?: string
  label: string
  holder: string
  network: CardNetwork
  tier: CardTier
  format: CardFormat
  /** Full card number (PAN), entered by the administrator at issuance. When
   *  present it is the real number shown to the client; `last4` is derived
   *  from it. Optional for legacy cards issued before manual entry existed. */
  number?: string
  last4: string
  expiry: string
  /** 3-digit card security code (CVV/CVC), entered by the administrator. */
  cvv: string
  currency: string
  monthlyLimit: number
  monthlySpent: number
  status: CardStatus
  controls: CardControls
  features: string[]
  variant: CardVariant
  /** Client's requested values (kept for the audit/admin view). */
  requestedLimit?: number
  purpose?: string
  submittedAt?: string
  decidedAt?: string
  decisionNote?: string
}

export const TIER_LABELS: Record<CardTier, string> = {
  standard: "Standard",
  gold: "Gold",
  platinum: "Platinum",
  signature: "Signature",
  world_elite: "World Elite",
}

export const CARD_FEATURES = [
  "Airport lounge access",
  "24/7 concierge service",
  "Comprehensive travel insurance",
  "Purchase protection",
  "Premium metal card",
  "Elevated cashback rewards",
  "No foreign transaction fees",
  "Priority customer support",
] as const

export function tierVariant(tier: CardTier): CardVariant {
  if (tier === "platinum" || tier === "world_elite") return "platinum"
  if (tier === "gold" || tier === "signature") return "amber"
  return "dark"
}

export function defaultControls(): CardControls {
  return { online: true, contactless: true, atm: true, international: false }
}

/** Generate a stable-ish demo card id. */
export function genCardId(): string {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase()
  return `CARD-${Date.now().toString(36).toUpperCase()}-${rand}`
}

/** Random last-4 for the embossed number (demo issuance). */
export function genLast4(): string {
  return String(Math.floor(1000 + Math.random() * 9000))
}

/** Random 3-digit security code (CVV/CVC) for demo issuance. */
export function genCvv(): string {
  return String(Math.floor(100 + Math.random() * 900))
}

/** Expiry four years out, formatted MM/YY. */
export function genExpiry(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 4)
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`
}

/**
 * Build a ClientCard from a server approval record. The payload may carry:
 *  - `card`: the administrator-FINALIZED card (network, tier, limit, features)
 *    set when the request was approved or when the admin issued a card directly.
 *  - `record`: the client's own post-activation management edits (spending
 *    limit, block state, usage controls) — these follow the user across devices.
 * The finalized card is the base; client edits overlay it. The DB lifecycle
 * decides pending/active/rejected, except a client "blocked" state is preserved.
 */
function cardFromApproval(rec: ApprovalRecord): ClientCard | null {
  const p = rec.payload as { card?: Partial<ClientCard> & { id: string }; record?: Partial<ClientCard> } | undefined
  const finalized = p?.card
  const clientEdits = p?.record
  // While pending there is no finalized card yet; show the requested card.
  const base = finalized ?? (clientEdits as (Partial<ClientCard> & { id: string }) | undefined)
  if (!base?.id) return null

  const lifecycle = mapApprovalStatus(rec.status, { approvedStatus: "active", rejectedStatus: "rejected" })
  // Honour a client-set "blocked" on an otherwise-active card.
  const clientStatus = clientEdits?.status
  const status: CardStatus =
    lifecycle === "active" && clientStatus === "blocked" ? "blocked" : (lifecycle as CardStatus)

  return hydrateCard({
    ...base,
    ...(clientEdits ?? {}),
    id: base.id,
    approvalId: rec.id,
    status,
    decidedAt: rec.decidedAt ?? base.decidedAt,
    decisionNote: rec.decisionNote ?? base.decisionNote,
  })
}

/** Normalize a possibly-partial stored/remote card into a complete ClientCard. */
function hydrateCard(raw: Partial<ClientCard> & { id: string }): ClientCard {
  const tier = (raw.tier as CardTier) ?? "standard"
  return {
    id: raw.id,
    approvalId: raw.approvalId,
    label: raw.label ?? `${raw.network ?? "Visa"} ${TIER_LABELS[tier]}`,
    holder: raw.holder ?? "",
    network: (raw.network as CardNetwork) ?? "Visa",
    tier,
    format: (raw.format as CardFormat) ?? "physical",
    number: typeof raw.number === "string" && raw.number.trim() ? raw.number : undefined,
    // Prefer a last4 derived from the admin-entered full number so the two
    // never disagree; fall back to a stored last4, then a generated one.
    last4:
      (typeof raw.number === "string" && raw.number.replace(/\D/g, "").slice(-4)) ||
      raw.last4 ||
      genLast4(),
    expiry: raw.expiry ?? genExpiry(),
    cvv: raw.cvv ?? genCvv(),
    currency: raw.currency ?? "EUR",
    monthlyLimit: Number(raw.monthlyLimit ?? 0),
    monthlySpent: Number(raw.monthlySpent ?? 0),
    status: (raw.status as CardStatus) ?? "pending",
    controls: { ...defaultControls(), ...(raw.controls ?? {}) },
    features: Array.isArray(raw.features) ? raw.features : [],
    variant: (raw.variant as CardVariant) ?? tierVariant(tier),
    requestedLimit: raw.requestedLimit,
    purpose: raw.purpose,
    submittedAt: raw.submittedAt,
    decidedAt: raw.decidedAt,
    decisionNote: raw.decisionNote,
  }
}

export interface NewCardRequest {
  holder: string
  network: CardNetwork
  tier: CardTier
  format: CardFormat
  currency: string
  requestedLimit: number
  purpose?: string
}

interface CardRequestsContextValue {
  cards: ClientCard[]
  /** Submit a new card request (status = pending) for administrator review. */
  requestCard: (req: NewCardRequest) => ClientCard
  /** Update a card's monthly spending limit (active cards only). */
  setLimit: (id: string, limit: number) => void
  /** Block (freeze) or unblock an active card. */
  setBlocked: (id: string, blocked: boolean) => void
  /** Toggle one of the card's usage controls. */
  setControl: (id: string, control: keyof CardControls, enabled: boolean) => void
  /** Cancel a still-pending request. */
  cancelRequest: (id: string) => void
  /** Remove a card/record from the wallet entirely. */
  deleteCard: (id: string) => void
  hydrated: boolean
}

const CardRequestsContext = createContext<CardRequestsContextValue | null>(null)

export function CardRequestsProvider({ children }: { children: React.ReactNode }) {
  // List sourced entirely from the server (Neon). The custom mapper folds the
  // administrator-finalized card together with the client's own management
  // edits, so the wallet is identical on any device/browser. No localStorage.
  const {
    records: cards,
    setRecords: setCards,
    hydrated,
    refresh,
  } = useServerRequestList<ClientCard>("card", { fromApproval: cardFromApproval })

  /** Persist a client-owned management edit to a card's server record. */
  const persistCardEdit = (card: ClientCard | undefined, patch: Partial<ClientCard>) => {
    if (!card?.approvalId) return
    void updateMyApprovalRecord(card.approvalId, patch as Record<string, unknown>)
  }

  const requestCard: CardRequestsContextValue["requestCard"] = (req) => {
    const tier = req.tier
    const card: ClientCard = hydrateCard({
      id: genCardId(),
      holder: req.holder,
      network: req.network,
      tier,
      format: req.format,
      currency: req.currency,
      monthlyLimit: req.requestedLimit,
      requestedLimit: req.requestedLimit,
      purpose: req.purpose,
      status: "pending",
      label: `${req.network} ${TIER_LABELS[tier]}`,
      variant: tierVariant(tier),
      submittedAt: new Date().toISOString(),
    })
    setCards([card, ...cards])
    // Mirror into the DB so the administrator can review/customize cross-client.
    // The requested card is stored under BOTH `card` (so a pending request still
    // renders before the admin finalizes it) and is the basis the admin edits.
    void mirrorSubmission({
      kind: "card",
      title: `${card.label} card`,
      summary: `${card.network} ${TIER_LABELS[tier]} ${card.format} card requested with a ${card.currency} ${card.requestedLimit?.toLocaleString("en-US")} monthly limit${card.purpose ? ` (${card.purpose})` : ""}.`,
      amount: card.requestedLimit ?? null,
      currency: card.currency,
      payload: { card: { ...card } },
    }).then(() => {
      void refresh()
    })
    return card
  }

  const setLimit: CardRequestsContextValue["setLimit"] = (id, limit) => {
    const next = Math.max(0, limit)
    const target = cards.find((c) => c.id === id)
    setCards(cards.map((c) => (c.id === id ? { ...c, monthlyLimit: next } : c)))
    persistCardEdit(target, { monthlyLimit: next })
  }

  const setBlocked: CardRequestsContextValue["setBlocked"] = (id, blocked) => {
    const target = cards.find((c) => c.id === id)
    let nextStatus: CardStatus | undefined
    setCards(
      cards.map((c) => {
        if (c.id !== id) return c
        if (blocked && c.status === "active") {
          nextStatus = "blocked"
          return { ...c, status: "blocked" }
        }
        if (!blocked && c.status === "blocked") {
          nextStatus = "active"
          return { ...c, status: "active" }
        }
        return c
      }),
    )
    if (nextStatus) persistCardEdit(target, { status: nextStatus })
  }

  const setControl: CardRequestsContextValue["setControl"] = (id, control, enabled) => {
    const target = cards.find((c) => c.id === id)
    const nextControls = target ? { ...target.controls, [control]: enabled } : undefined
    setCards(cards.map((c) => (c.id === id ? { ...c, controls: { ...c.controls, [control]: enabled } } : c)))
    if (nextControls) persistCardEdit(target, { controls: nextControls })
  }

  const cancelRequest: CardRequestsContextValue["cancelRequest"] = (id) => {
    const target = cards.find((c) => c.id === id)
    setCards(cards.map((c) => (c.id === id && c.status === "pending" ? { ...c, status: "cancelled" } : c)))
    if (target?.approvalId && target.status === "pending") {
      void cancelMyApproval(target.approvalId).then(() => void refresh())
    }
  }

  const deleteCard: CardRequestsContextValue["deleteCard"] = (id) => {
    const target = cards.find((c) => c.id === id)
    setCards(cards.filter((c) => c.id !== id))
    // Removing a still-pending request cancels it server-side; decided cards are
    // server-owned and will re-hydrate (a delete is a local view action only).
    if (target?.approvalId && target.status === "pending") {
      void cancelMyApproval(target.approvalId).then(() => void refresh())
    }
  }

  return (
    <CardRequestsContext.Provider
      value={{
        cards,
        requestCard,
        setLimit,
        setBlocked,
        setControl,
        cancelRequest,
        deleteCard,
        hydrated,
      }}
    >
      {children}
    </CardRequestsContext.Provider>
  )
}

export function useCardRequests() {
  const ctx = useContext(CardRequestsContext)
  if (!ctx) {
    throw new Error("useCardRequests must be used within a CardRequestsProvider")
  }
  return ctx
}
