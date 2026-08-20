import { Building2, Landmark, Gauge, ShieldCheck, HandCoins, type LucideIcon } from "lucide-react"
import type { DebitKind } from "@/lib/debit-schedule"

/** Shared presentation metadata for each debit product kind. */
export const KIND_META: Record<
  DebitKind,
  { label: string; short: string; icon: LucideIcon; iconWrap: string }
> = {
  funding: {
    label: "AES Project Funding",
    short: "Loan",
    icon: Building2,
    iconWrap: "bg-primary/10 text-primary",
  },
  monetization: {
    label: "Credit Facility",
    short: "Loan",
    icon: Landmark,
    iconWrap: "bg-primary/10 text-primary",
  },
  leverage: {
    label: "Leverage Line",
    short: "Leverage",
    icon: Gauge,
    iconWrap: "bg-accent/60 text-accent-foreground",
  },
  treasury: {
    label: "Treasury Financing",
    short: "Debit",
    icon: ShieldCheck,
    iconWrap: "bg-secondary text-secondary-foreground",
  },
  internal_loan: {
    label: "Internal Loan",
    short: "Loan",
    icon: HandCoins,
    iconWrap: "bg-primary/10 text-primary",
  },
}
