"use client"

import { CreditCard, Wifi } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCurrentUser } from "@/lib/use-current-user"

export type BankCard = {
  id: string
  label: string
  holder: string
  last4: string
  expiry: string
  network: "VISA" | "Mastercard"
  variant: "amber" | "dark" | "platinum"
  frozen?: boolean
}

/**
 * Builds the card set for a given user. The card holder names come from the
 * signed-in user so each client sees their own name/company embossed on the
 * cards — no shared/hardcoded identity.
 */
export function buildCards(holderPerson: string, holderCompany: string): BankCard[] {
  return [
    {
      id: "card-1",
      label: "MCC Platinum Debit",
      holder: holderPerson,
      last4: "4417",
      expiry: "08/29",
      network: "VISA",
      variant: "amber",
    },
    {
      id: "card-2",
      label: "MCC Business Credit",
      holder: holderCompany,
      last4: "9032",
      expiry: "11/28",
      network: "Mastercard",
      variant: "dark",
    },
    {
      id: "card-3",
      label: "MCC Virtual Card",
      holder: holderPerson,
      last4: "5586",
      expiry: "03/27",
      network: "VISA",
      variant: "platinum",
      frozen: true,
    },
  ]
}

/** Hook returning the current user's bank cards. */
export function useCards(): BankCard[] {
  const user = useCurrentUser()
  return buildCards(user.cardHolderPerson, user.cardHolderCompany)
}

const variantStyles: Record<BankCard["variant"], string> = {
  amber: "bg-gradient-to-br from-primary via-primary/85 to-orange-800 text-primary-foreground",
  dark: "bg-gradient-to-br from-secondary via-card to-background text-foreground border border-border",
  platinum: "bg-gradient-to-br from-zinc-300 via-zinc-400 to-zinc-600 text-zinc-900",
}

export function CardVisual({ card, className }: { card: BankCard; className?: string }) {
  // NOTE: the aspect-ratio box is a plain BLOCK wrapper (not a flex container).
  // Putting `aspect-ratio` on an element that is itself `display:flex` makes some
  // browsers (notably iOS Safari) ignore the ratio and stretch the card into a
  // giant panel. The flex layout lives on an absolutely-positioned inner layer.
  return (
    <div
      className={cn(
        "relative aspect-[1.586/1] w-full max-w-sm overflow-hidden rounded-xl shadow-lg",
        variantStyles[card.variant],
        card.frozen && "opacity-60",
        className,
      )}
    >
      <div className="absolute inset-0 flex flex-col justify-between p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider opacity-80">MCC Capital</p>
            <p className="mt-0.5 text-[11px] opacity-70">{card.label}</p>
          </div>
          <Wifi className="h-5 w-5 rotate-90 opacity-80" />
        </div>

        <div className="flex h-8 w-11 items-center justify-center rounded-md bg-white/25">
          <CreditCard className="h-4 w-4 opacity-90" />
        </div>

        <div>
          <p className="font-mono text-base tracking-[0.2em]">
            {"•••• •••• •••• "}
            {card.last4}
          </p>
          <div className="mt-2 flex items-end justify-between">
            <div>
              <p className="text-[9px] uppercase tracking-wider opacity-70">Card Holder</p>
              <p className="text-xs font-medium">{card.holder}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] uppercase tracking-wider opacity-70">Expires</p>
              <p className="text-xs font-medium">{card.expiry}</p>
            </div>
            <p className="text-sm font-bold italic">{card.network}</p>
          </div>
        </div>
      </div>

      {card.frozen && (
        <span className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-semibold text-foreground">
          Frozen
        </span>
      )}
    </div>
  )
}
