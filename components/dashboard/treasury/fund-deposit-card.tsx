"use client"

import { useMemo, useState } from "react"
import { PiggyBank, Loader2, Wallet, AlertTriangle, TrendingDown, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
 import { MoneyInput } from "@/components/ui/money-input"
import { cn } from "@/lib/utils"
import {
  type TreasuryAccount,
  treasuryShortfall,
  financedAmountFor,
  getProfile,
} from "@/lib/treasury-store"
import { fundTreasuryDepositFromBalance } from "@/app/actions/treasury"

const fmt0 = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
const fmt2 = (value: number, currency = "EUR") =>
  `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Stat({
  label,
  value,
  tone = "default",
  Icon,
}: {
  label: string
  value: string
  tone?: "default" | "positive" | "negative"
  Icon: typeof Wallet
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p
        className={cn(
          "mt-1 text-lg font-semibold",
          tone === "positive" && "text-green-500",
          tone === "negative" && "text-orange-400",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * Client self-service: fund the treasury security deposit with the client's own
 * money from the master account balance. The applied cash raises their
 * contribution — first filling any remaining shortfall, then buying DOWN the
 * leverage-financed portion so the financed amount and its 1.8% debit cycle fee
 * fall. The server is authoritative for the balance gate and all coverage math;
 * this surface only proposes an amount.
 */
export function FundDepositCard({
  account,
  currency = "EUR",
  availableEur,
  onFunded,
}: {
  account: TreasuryAccount
  currency?: string
  /** Spendable EUR balance on the master account (from useLedger totalIn). */
  availableEur: number
  onFunded?: () => void
}) {
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)

  const shortfall = treasuryShortfall(account)
  const financed = financedAmountFor(account)
  const collateral = Math.max(0, account.skrCollateral || 0)
  const required = account.requiredDeposit || getProfile(account.profile).requiredDeposit

  // Most own-cash that still does something useful: fully self-secure with no
  // leverage. Beyond this, extra cash would just be locked.
  const maxUseful = Math.max(0, required - collateral - account.customerContribution)
  const available = Math.max(0, availableEur)

  const parsed = Number(amount)
  const validAmount = Number.isFinite(parsed) && parsed > 0
  // What the server will actually apply, so the client sees the real effect.
  const willApply = validAmount ? Math.min(parsed, maxUseful, available) : 0

  const projectedFinanced = useMemo(() => {
    if (!account.leverageEnabled || willApply <= 0) return financed
    // Increasing contribution first fills the shortfall (which is uncovered, not
    // financed), then reduces the financed amount 1:1.
    const reduceFinancedBy = Math.max(0, willApply - shortfall)
    return Math.max(0, financed - reduceFinancedBy)
  }, [account.leverageEnabled, willApply, financed, shortfall])

  const setQuick = (value: number) => setAmount(String(Math.max(0, Math.round(value))))

  const submit = async () => {
    if (!validAmount) {
      toast.error("Enter an amount to apply to your security deposit.")
      return
    }
    setBusy(true)
    try {
      const res = await fundTreasuryDepositFromBalance(parsed)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(
        res.financed > 0
          ? `${fmt2(res.applied, currency)} applied. Leverage-financed portion is now ${fmt0(res.financed, currency)}.`
          : `${fmt2(res.applied, currency)} applied. Your deposit is now fully secured by your own funds.`,
      )
      setAmount("")
      onFunded?.()
    } catch {
      toast.error("The deposit funding could not be completed. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // Nothing to do when the deposit is already fully funded by the client's own
  // contribution (no shortfall and no leverage left to buy down).
  if (maxUseful <= 0.01) return null

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-2">
          <PiggyBank className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Fund Security Deposit</CardTitle>
          <Badge variant="outline" className="ml-auto gap-1.5 border-primary/20 bg-primary/10 text-primary">
            <Wallet className="h-3.5 w-3.5" />
            From master balance
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Master balance" value={fmt0(available, currency)} Icon={Wallet} tone="positive" />
          <Stat
            label="Deposit shortfall"
            value={fmt0(shortfall, currency)}
            Icon={AlertTriangle}
            tone={shortfall > 0 ? "negative" : "default"}
          />
          <Stat
            label="Leverage-financed"
            value={fmt0(financed, currency)}
            Icon={TrendingDown}
            tone={financed > 0 ? "negative" : "default"}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span className="text-pretty">
            Apply your own funds from the master account to your security deposit. Your money first covers any
            shortfall, then buys down the leverage-financed portion — reducing the amount financed by MCC HOLDING SA
            and the {(account.feeRate * 100).toFixed(1)}% p.a. debit cycle fee it carries.
          </span>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {currency}
              </span>
              <MoneyInput
                value={amount}
                onValueChange={setAmount}
                placeholder="0.00"
                className="h-11 pl-12 text-base"
                aria-label="Amount to apply to your security deposit"
              />
            </div>
            <Button onClick={submit} disabled={busy || !validAmount || willApply <= 0} className="min-h-11 gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PiggyBank className="h-4 w-4" />}
              Apply {willApply > 0 ? fmt2(willApply, currency) : ""}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {shortfall > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9"
                disabled={busy}
                onClick={() => setQuick(Math.min(shortfall, available))}
              >
                Fill shortfall — {fmt0(Math.min(shortfall, available), currency)}
              </Button>
            )}
            {maxUseful > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9"
                disabled={busy}
                onClick={() => setQuick(Math.min(maxUseful, available))}
              >
                {financed > 0 ? "Buy down all leverage" : "Fully self-fund"} — {fmt0(Math.min(maxUseful, available), currency)}
              </Button>
            )}
          </div>

          {validAmount && willApply > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {fmt2(willApply, currency)} will be debited from your master account.
              {account.leverageEnabled && willApply > shortfall
                ? ` Leverage-financed portion falls to ${fmt0(projectedFinanced, currency)}.`
                : ""}
              {parsed > willApply
                ? ` (Capped from ${fmt2(parsed, currency)} — that is all that is useful or available.)`
                : ""}
            </p>
          )}
          {validAmount && willApply <= 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-orange-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Your master balance ({fmt2(available, currency)}) can&apos;t fund this. Add funds first.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
