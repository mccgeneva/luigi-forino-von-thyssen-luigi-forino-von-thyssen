"use client"

import { useState } from "react"
import { Check, Crown, Star, Building2, Lock, Loader2, Clock, ShieldCheck, Eye } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { useCurrentUser } from "@/lib/use-current-user"
import { useMembership } from "@/lib/use-membership"
import { requestMembershipUpgrade } from "@/app/actions/membership"
import { effectivePlatformTier, MEMBERSHIP_STATUS_LABEL } from "@/lib/membership"

const plans = [
  {
    id: "pro",
    name: "PRO",
    icon: Star,
    price: "€25,000",
    period: "/ year",
    deposit: "€500,000",
    leverageDeposit: "€50,000",
    description: "For active private investors and SMEs",
    highlighted: false,
    features: [
      "Multi-currency IBAN accounts",
      "SWIFT MT103 & MT760 transfers",
      "Up to €5M trading volume / month",
      "Standard bank instruments access",
      "Dedicated account manager",
      "Email & phone support",
    ],
  },
  {
    id: "avantgarde",
    name: "Avant-Garde",
    icon: Crown,
    price: "€120,000",
    period: "/ year",
    deposit: "€1,000,000",
    leverageDeposit: "€100,000",
    description: "For institutions and high-net-worth clients",
    highlighted: true,
    features: [
      "Everything in PRO, plus:",
      "Unlimited trading volume",
      "Priority SBLC / MTN / BG issuance",
      "Fiduciary & asset custody mandate",
      "PPP / yield program enrollment",
      "24/7 dedicated relationship manager",
      "Bespoke compliance & legal desk",
    ],
  },
]

const bankPartners = [
  "JP Morgan Chase",
  "UBS Switzerland",
  "HSBC London",
  "Deutsche Bank AG",
  "Barclays Bank",
  "NatWest Bank PLC",
  "BNP Paribas",
  "Citibank N.A.",
  "Credit Suisse",
  "Standard Chartered",
  "Société Générale",
  "Santander",
  "Banking Circle",
  "Goldman Sachs",
  "Morgan Stanley",
  "BlackRock",
]

export default function PlansPage() {
  const log = useActivityLog()
  const user = useCurrentUser()
  const { membership, hydrated, refresh } = useMembership()
  const [submitting, setSubmitting] = useState(false)

  const tier = effectivePlatformTier(user.accountBadge, membership)
  // The tier id this plan card represents must match the effective tier id to
  // be flagged as the client's current plan.
  const currentTierId = tier.id // "visitor" | "pro" | "avantgarde" | "other"
  const isVisitor = currentTierId === "visitor"

  const selectPro = (planName: string, price?: string, deposit?: string) => {
    log({
      action: `Requested to select the ${planName} plan`,
      category: "Plans & Pricing",
      details: {
        summary: `Client requested the "${planName}" membership plan${price ? ` priced at ${price} / year` : ""}${deposit ? `, with a ${deposit} refundable security deposit blocked in our treasury bank` : ""}. The relationship manager should follow up to confirm activation.`,
        plan: planName,
        price: price ? `${price} / year` : "(see plan details)",
        securityDeposit: deposit ? `${deposit} (blocked in treasury bank)` : "(see plan details)",
        requestedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success(`${planName} request submitted`, {
      description: "Your relationship manager will follow up to confirm activation.",
    })
  }

  const requestAvantGarde = async () => {
    setSubmitting(true)
    const res = await requestMembershipUpgrade("avantgarde")
    setSubmitting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    await refresh()
    toast.success("Upgrade request submitted", {
      description:
        "Your Avant-Garde request is pending administrator approval. Once approved, Treasury validates the €1,000,000 security deposit to activate your membership.",
    })
  }

  // Status messaging for the Avant-Garde card, driven by the membership grant.
  const isAvantActive = currentTierId === "avantgarde"
  const avantPending = membership?.tier === "avantgarde" && membership.status === "pending"
  const avantApproved = membership?.tier === "avantgarde" && membership.status === "approved"
  const avantRejected = membership?.tier === "avantgarde" && membership.status === "rejected"

  const renderButton = (planId: string) => {
    if (planId === "pro") {
      if (currentTierId === "pro") {
        return (
          <Button className="w-full" variant="outline" disabled>
            <Check className="mr-1.5 h-4 w-4" /> Current plan
          </Button>
        )
      }
      return (
        <Button
          className="w-full"
          variant="outline"
          onClick={() => selectPro("PRO", "€25,000", "€500,000")}
        >
          Select PRO
        </Button>
      )
    }

    // Avant-Garde card.
    if (isAvantActive) {
      return (
        <Button className="w-full" variant="outline" disabled>
          <Check className="mr-1.5 h-4 w-4" /> Current plan
        </Button>
      )
    }
    if (!hydrated) {
      return (
        <Button className="w-full" disabled>
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Checking status…
        </Button>
      )
    }
    if (avantPending) {
      return (
        <Button className="w-full" disabled>
          <Clock className="mr-1.5 h-4 w-4" /> Pending approval
        </Button>
      )
    }
    if (avantApproved) {
      return (
        <Button className="w-full" disabled>
          <ShieldCheck className="mr-1.5 h-4 w-4" /> Awaiting €1M deposit validation
        </Button>
      )
    }
    return (
      <Button className="w-full" onClick={requestAvantGarde} disabled={submitting}>
        {submitting ? (
          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        ) : (
          <Crown className="mr-1.5 h-4 w-4" />
        )}
        {avantRejected ? "Request Avant-Garde again" : "Upgrade to Avant-Garde"}
      </Button>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Plans &amp; Pricing</h1>
        <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground text-pretty">
          Choose the membership that matches your trading ambitions. All plans include
          AAA+ rated banking partners and Swiss-grade security.
        </p>
      </div>

      {/* Visitor (pre-subscription) notice */}
      {isVisitor && (
        <div className="mx-auto flex max-w-4xl items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <Eye className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">You&apos;re on a Visitor account</p>
            <p className="text-xs text-muted-foreground text-pretty">
              Your Visitor account is read-only: explore the platform and NQAi, and receive incoming top-ups,
              but payments, trading and treasury operations stay locked until you subscribe. Your KYC is already
              on file, so choose a plan below to upgrade instantly — no re-verification needed.
            </p>
          </div>
        </div>
      )}

      {/* Live upgrade status */}
      {hydrated && membership && membership.tier === "avantgarde" && membership.status !== "active" && (
        <div
          className={cn(
            "mx-auto flex max-w-4xl items-start gap-3 rounded-lg border p-4",
            avantApproved
              ? "border-primary/30 bg-primary/5"
              : avantRejected
                ? "border-destructive/30 bg-destructive/5"
                : "border-amber-500/30 bg-amber-500/10",
          )}
        >
          {avantApproved ? (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          ) : avantRejected ? (
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          ) : (
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              Avant-Garde upgrade — {MEMBERSHIP_STATUS_LABEL[membership.status]}
            </p>
            <p className="text-xs text-muted-foreground text-pretty">
              {avantApproved
                ? "Your request has been approved. Treasury is validating your €1,000,000 security deposit; your membership activates as soon as it is secured."
                : avantRejected
                  ? `Your request was declined.${membership.note ? ` ${membership.note}` : ""} You may submit a new request below.`
                  : "Your request is pending administrator approval. After approval, Treasury validates the €1,000,000 security deposit to activate your membership."}
            </p>
          </div>
        </div>
      )}

      {/* Plans */}
      <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
        {plans.map((plan) => {
          const isCurrent =
            (plan.id === "pro" && currentTierId === "pro") ||
            (plan.id === "avantgarde" && isAvantActive)
          return (
            <Card
              key={plan.id}
              className={cn(
                "relative border-border bg-card",
                plan.highlighted && "border-primary shadow-lg shadow-primary/10",
                isCurrent && "ring-2 ring-primary",
              )}
            >
              {isCurrent ? (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-success text-success-foreground">
                  Your membership
                </Badge>
              ) : (
                plan.highlighted && (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
                    Most Popular
                  </Badge>
                )
              )}
              <CardHeader className="space-y-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                  <plan.icon className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">{plan.name}</h2>
                  <p className="text-xs text-muted-foreground">{plan.description}</p>
                </div>
                <div className="flex items-end gap-1">
                  <span className="text-3xl font-bold text-foreground">{plan.price}</span>
                  <span className="pb-1 text-sm text-muted-foreground">{plan.period}</span>
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {plan.deposit} security deposit
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Refundable, blocked in our treasury bank
                    </p>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Or{" "}
                      <span className="font-semibold text-primary">{plan.leverageDeposit}</span>{" "}
                      with 1:10 leverage — subject to administrator approval
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="text-sm text-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
                {renderButton(plan.id)}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Bank partners */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">AAA+ Banking Partners</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Instruments issued and confirmed through top-rated global institutions
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {bankPartners.map((bank) => (
              <div
                key={bank}
                className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2"
              >
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">{bank}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
