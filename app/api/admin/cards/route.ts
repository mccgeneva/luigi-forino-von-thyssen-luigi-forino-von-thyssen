import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import { listDynamicUsers } from "@/lib/admin-users-db"
import {
  getApprovalById,
  updateApprovalPayload,
  deleteApproval,
  listAllApprovals,
} from "@/lib/approvals-db"
import { insertNotification } from "@/lib/notifications-db"
import { KIND_HREF } from "@/lib/approval-kinds"

export const runtime = "nodejs"

// -----------------------------------------------------------------------------
// Administrator credit-card management API.
//
// A dedicated, non-proxied endpoint for MANAGING already-issued cards linked to
// customer accounts: list every issued card across clients, EDIT a card
// (network, tier, format, currency, monthly limit, features, active/blocked),
// and DELETE (revoke) a card so it is removed from the customer's wallet.
//
// This is an /api route (NOT a Server Action) on purpose: admin Server-Action
// reads POST to /dashboard/* and are silently 401'd by the session proxy when
// the signed meta cookie looks stale (common in the preview iframe / resumed
// PWA), which leaves lists mysteriously empty. This route bypasses that proxy
// and returns real JSON. It also imports the lib/* DATA modules directly rather
// than the "use server" action wrappers (importing those into an API route can
// 500 at load time). Every op is gated once by adminActionAuthorized(pin).
// -----------------------------------------------------------------------------

type CardTier = "standard" | "gold" | "platinum" | "signature" | "world_elite"
type CardNetwork = "Visa" | "Mastercard"
type CardVariant = "amber" | "dark" | "platinum"

const TIER_LABELS: Record<CardTier, string> = {
  standard: "Standard",
  gold: "Gold",
  platinum: "Platinum",
  signature: "Signature",
  world_elite: "World Elite",
}

function tierVariant(tier: CardTier): CardVariant {
  if (tier === "platinum" || tier === "world_elite") return "platinum"
  if (tier === "gold" || tier === "signature") return "amber"
  return "dark"
}

type CardPayload = {
  id?: string
  holder?: string
  network?: CardNetwork
  tier?: CardTier
  format?: "physical" | "virtual"
  currency?: string
  monthlyLimit?: number
  monthlySpent?: number
  last4?: string
  expiry?: string
  features?: string[]
  label?: string
  variant?: CardVariant
  status?: string
}

/** An issued card shaped for the admin management list. */
type IssuedCard = {
  approvalId: string
  userId: string
  holderLabel: string
  holderEmail: string
  card: CardPayload
  status: string
  createdAt: string
  decidedAt: string | null
}

function describe(card: CardPayload): string {
  const network = card?.network ?? "Card"
  const tier = card?.tier ? TIER_LABELS[card.tier] : ""
  const format = card?.format ?? ""
  return `${network}${tier ? ` ${tier}` : ""}${format ? ` ${format}` : ""}`.trim()
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 200 })
  }

  const pin = String(body.pin ?? "")
  const op = String(body.op ?? "")

  try {
    if (!(await adminActionAuthorized(pin))) {
      return NextResponse.json({ ok: false, reason: "unauthorized", cards: [], clients: [] }, { status: 200 })
    }

    // Build a userId → { label, email } map from the active client roster.
    const users = await listDynamicUsers()
    const clientMap = new Map<string, { label: string; email: string }>()
    const clients = users
      .filter((u) => u.status === "active")
      .map((u) => {
        const label = u.profile.company
          ? `${u.profile.fullName} · ${u.profile.company}`
          : u.profile.fullName
        clientMap.set(u.id, { label, email: u.email })
        return { id: u.id, fullName: u.profile.fullName, company: u.profile.company, email: u.email }
      })

    if (op === "list") {
      const approvals = await listAllApprovals({ kind: "card" })
      // An ISSUED card is an approved card approval that carries a finalized card.
      const cards: IssuedCard[] = approvals
        .filter((a) => a.status === "approved")
        .map((a) => {
          const payload = (a.payload ?? {}) as { card?: CardPayload; record?: CardPayload }
          const card: CardPayload = { ...(payload.card ?? {}), ...(payload.record ?? {}) }
          const who = clientMap.get(a.userId)
          return {
            approvalId: a.id,
            userId: a.userId,
            holderLabel: who?.label ?? card.holder ?? a.userId,
            holderEmail: who?.email ?? "",
            card,
            status: String(card.status ?? "active"),
            createdAt: a.createdAt,
            decidedAt: a.decidedAt ?? null,
          }
        })
        .filter((c) => !!c.card.id)
      return NextResponse.json({ ok: true, cards, clients }, { status: 200 })
    }

    if (op === "update") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "card") {
        return NextResponse.json({ ok: false, error: "Card not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as { card?: CardPayload; record?: CardPayload }
      const prev: CardPayload = { ...(payload.card ?? {}), ...(payload.record ?? {}) }

      const network = (String(body.network ?? prev.network ?? "Visa") as CardNetwork)
      const tier = (String(body.tier ?? prev.tier ?? "standard") as CardTier)
      const format = (String(body.format ?? prev.format ?? "physical") as "physical" | "virtual")
      const currency = String(body.currency ?? prev.currency ?? "EUR")
      const rawLimit = Number(body.monthlyLimit)
      const monthlyLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : Number(prev.monthlyLimit ?? 0)
      const features = Array.isArray(body.features) ? (body.features as string[]) : prev.features ?? []
      const statusIn = String(body.status ?? prev.status ?? "active")
      const status = statusIn === "blocked" ? "blocked" : "active"

      // Write the authoritative values into BOTH `card` (the finalized base) and
      // `record` (the client-overlay that WINS in the wallet's materializer), so
      // the customer always sees exactly what the administrator set here.
      const merged: CardPayload = {
        ...prev,
        network,
        tier,
        format,
        currency,
        monthlyLimit,
        features,
        status,
        label: `${network} ${TIER_LABELS[tier]}`,
        variant: tierVariant(tier),
      }
      await updateApprovalPayload(approvalId, {
        ...(existing.payload ?? {}),
        card: { ...(payload.card ?? {}), ...merged },
        record: { ...(payload.record ?? {}), ...merged },
        finalized: true,
      })

      try {
        await insertNotification({
          userId: existing.userId,
          tone: status === "blocked" ? "warning" : "info",
          title: status === "blocked" ? "A card was frozen" : "Your card was updated",
          body:
            status === "blocked"
              ? `MCC Capital temporarily froze your ${describe(merged)} card. Contact support for details.`
              : `MCC Capital updated your ${describe(merged)} card (limit ${currency} ${monthlyLimit.toLocaleString("en-US")}).`,
          href: KIND_HREF.card ?? "/dashboard/cards",
        })
      } catch {
        /* notification is best-effort */
      }

      return NextResponse.json({ ok: true }, { status: 200 })
    }

    if (op === "revoke") {
      const approvalId = String(body.approvalId ?? "")
      const existing = await getApprovalById(approvalId)
      if (!existing || existing.kind !== "card") {
        return NextResponse.json({ ok: false, error: "Card not found." }, { status: 200 })
      }
      const payload = (existing.payload ?? {}) as { card?: CardPayload; record?: CardPayload }
      const card: CardPayload = { ...(payload.card ?? {}), ...(payload.record ?? {}) }
      const deleted = await deleteApproval(approvalId)
      if (!deleted) {
        return NextResponse.json({ ok: false, error: "The card could not be removed." }, { status: 200 })
      }
      try {
        await insertNotification({
          userId: existing.userId,
          tone: "warning",
          title: "A card was removed",
          body: `MCC Capital removed your ${describe(card)} card from your wallet.`,
          href: KIND_HREF.card ?? "/dashboard/cards",
        })
      } catch {
        /* best-effort */
      }
      return NextResponse.json({ ok: true }, { status: 200 })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 200 })
  } catch (err) {
    console.log("[v0] admin cards api failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be completed." }, { status: 200 })
  }
}
