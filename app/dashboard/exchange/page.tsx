"use client"

import { useState, useEffect, useMemo } from "react"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { useLedger } from "@/lib/ledger-store"
import { useMarketQuotes } from "@/lib/use-market"
import { TradingViewWidget } from "@/components/market/tradingview-widget"
import {
  ArrowDownUp,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertCircle,
  CheckCircle2,
  History,
  Bell,
  Settings,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

const currencies = [
  { code: "EUR", name: "Euro", symbol: "€", flag: "🇪🇺" },
  { code: "USD", name: "US Dollar", symbol: "$", flag: "🇺🇸" },
  { code: "GBP", name: "British Pound", symbol: "£", flag: "🇬🇧" },
  { code: "CHF", name: "Swiss Franc", symbol: "Fr", flag: "🇨🇭" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", flag: "🇯🇵" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", flag: "🇦🇺" },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$", flag: "🇨🇦" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$", flag: "🇸🇬" },
]

// Fallback USD value of 1 unit of each currency, used only until live quotes
// arrive. Live values override these from the market-data feed.
const FALLBACK_USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.0892,
  GBP: 1.2645,
  CHF: 1.1303,
  JPY: 0.006688,
  AUD: 0.6542,
  CAD: 0.7416,
  SGD: 0.7407,
}

// FX pairs displayed in the "Live Rates" panel, with display precision.
const FX_PAIRS: { pair: string; decimals: number }[] = [
  { pair: "EUR/USD", decimals: 4 },
  { pair: "GBP/USD", decimals: 4 },
  { pair: "USD/CHF", decimals: 4 },
  { pair: "EUR/GBP", decimals: 4 },
  { pair: "USD/JPY", decimals: 2 },
  { pair: "AUD/USD", decimals: 4 },
  { pair: "USD/CAD", decimals: 4 },
  { pair: "EUR/CHF", decimals: 4 },
]

// Display symbols whose live quotes we need to derive every cross-rate above.
const FX_SYMBOLS = [
  "EUR/USD",
  "GBP/USD",
  "USD/CHF",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "USD/SGD",
  "EUR/GBP",
  "EUR/CHF",
]

export default function ExchangePage() {
  const [fromCurrency, setFromCurrency] = useState("EUR")
  const [toCurrency, setToCurrency] = useState("USD")
  const [fromAmount, setFromAmount] = useState("1000")
  const [toAmount, setToAmount] = useState("1089.20")
  const [isExecuting, setIsExecuting] = useState(false)
  const logActivity = useActivityLog()
  const { addReceipt, addDebit, balanceFor, entries } = useLedger()

  // Live FX quotes drive both the conversion calculator and the rates panel.
  const { quotes, updatedAt, isLoading: isRefreshing, refresh } = useMarketQuotes(FX_SYMBOLS)
  const lastUpdate = updatedAt ?? new Date()

  // USD value of 1 unit of each currency, derived from live cross-rates
  // (falling back to seed values until the first quotes load).
  const usdPerUnit = useMemo<Record<string, number>>(() => {
    const px = (s: string) => quotes[s]?.price
    const inv = (s: string) => {
      const p = quotes[s]?.price
      return p && p > 0 ? 1 / p : undefined
    }
    return {
      USD: 1,
      EUR: px("EUR/USD") ?? FALLBACK_USD_PER_UNIT.EUR,
      GBP: px("GBP/USD") ?? FALLBACK_USD_PER_UNIT.GBP,
      CHF: inv("USD/CHF") ?? FALLBACK_USD_PER_UNIT.CHF,
      JPY: inv("USD/JPY") ?? FALLBACK_USD_PER_UNIT.JPY,
      AUD: px("AUD/USD") ?? FALLBACK_USD_PER_UNIT.AUD,
      CAD: inv("USD/CAD") ?? FALLBACK_USD_PER_UNIT.CAD,
      SGD: inv("USD/SGD") ?? FALLBACK_USD_PER_UNIT.SGD,
    }
  }, [quotes])

  // Rate to convert 1 unit of `from` into `to`.
  const getRate = (from: string, to: string): number => {
    const fromUsd = usdPerUnit[from] ?? 1
    const toUsd = usdPerUnit[to] ?? 1
    return fromUsd / toUsd
  }

  // Live rates panel: real price + percentage change per pair.
  const liveRates = FX_PAIRS.map(({ pair, decimals }) => {
    const q = quotes[pair]
    return {
      pair,
      decimals,
      rate: q?.price ?? 0,
      change: q?.changePct ?? 0,
      trend: (q?.changePct ?? 0) >= 0 ? "up" : "down",
      hasQuote: Boolean(q),
    }
  })

  // Derive the on-page "Recent Exchanges" list directly from the ledger so every
  // executed conversion shows up here in real time. Each conversion posts a
  // source debit (id = ref, category "Currency Exchange") and a target credit
  // (id = `${ref}-RCV`); we pair them by reference to reconstruct the trade.
  const recentExchanges = entries
    .filter((e) => e.direction === "debit" && e.category === "Currency Exchange")
    .map((debit) => {
      const credit = entries.find((e) => e.id === `${debit.id}-RCV`)
      const d = new Date(debit.date)
      const rate = credit && debit.amount > 0 ? credit.amount / debit.amount : 0
      return {
        id: debit.id,
        fromCurrency: debit.currency,
        toCurrency: credit?.currency ?? "",
        fromAmount: debit.amount,
        toAmount: credit?.amount ?? 0,
        rate: Number(rate.toFixed(4)),
        status: debit.status === "completed" ? "completed" : "pending",
        date: Number.isNaN(d.getTime()) ? debit.date : d.toISOString().split("T")[0],
        time: Number.isNaN(d.getTime())
          ? ""
          : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        sortKey: Number.isNaN(d.getTime()) ? 0 : d.getTime(),
      }
    })
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 8)

  const currentRate = getRate(fromCurrency, toCurrency)
  const conversionFee = 0.004 // 0.4%

  // Percentage change for the selected pair, taken from the directly-quoted
  // pair when available (e.g. EUR/USD), otherwise derived from the two legs.
  const pairChangePct = (() => {
    const direct = quotes[`${fromCurrency}/${toCurrency}`]?.changePct
    if (typeof direct === "number") return direct
    const fromUsd = quotes[`${fromCurrency}/USD`]?.changePct ?? 0
    const toUsd = quotes[`${toCurrency}/USD`]?.changePct ?? 0
    return Number((fromUsd - toUsd).toFixed(2))
  })()

  const numericFrom = parseFloat(fromAmount.replace(/,/g, "")) || 0
  const feeAmount = numericFrom * conversionFee
  const totalDebit = numericFrom + feeAmount
  const availableBalance = balanceFor(fromCurrency)

  // True (natural) balance of a currency, EXCLUDING internal auto-cover rows
  // (FX-COVER-*). The server's auto-cover reconciler silently converts EUR to
  // fill any overdrawn pocket and pins it to exactly 0, which hides real
  // deficits. On the FX screen we show the GENUINE position so a conversion
  // INTO an overdrawn currency never looks like it "vanished" — it first repays
  // the deficit before the visible balance can rise.
  const naturalBalanceFor = (currency: string) =>
    entries
      .filter(
        (e) =>
          e.currency === currency &&
          e.status === "completed" &&
          !e.subAccountId &&
          !(e.id ?? "").startsWith("FX-COVER-"),
      )
      .reduce((sum, e) => sum + (e.direction === "credit" ? e.amount : -e.amount), 0)

  const toNaturalBalance = naturalBalanceFor(toCurrency)
  const toIsOverdrawn = toNaturalBalance < -0.01
  const toSymbol = currencies.find((c) => c.code === toCurrency)?.symbol ?? ""

  // Any currency pocket that is genuinely (naturally) overdrawn. While ANY
  // pocket is negative, the server's auto-cover reconciler immediately sweeps
  // freshly-converted funds to plug that shortfall — so a conversion "appears
  // for a few seconds then disappears" and each attempt bleeds the 0.4% fee,
  // pushing the deficit deeper. We block conversions until the overdraft is
  // settled so money can never churn away like this.
  const overdrawnPockets = currencies
    .map((c) => ({ code: c.code, symbol: c.symbol, natural: naturalBalanceFor(c.code) }))
    .filter((p) => p.natural < -0.01)
  const worstOverdrawn = overdrawnPockets.slice().sort((a, b) => a.natural - b.natural)[0]
  const accountHasOverdraft = overdrawnPockets.length > 0

  const handleExecuteExchange = () => {
    if (numericFrom <= 0) {
      toast.error("Enter an amount to convert")
      return
    }
    if (fromCurrency === toCurrency) {
      toast.error("Choose two different currencies")
      return
    }
    // Block while any pocket is overdrawn — otherwise auto-cover instantly sweeps
    // the proceeds to fill the shortfall (funds "vanish") and the fee is lost.
    if (worstOverdrawn) {
      const owed = Math.abs(worstOverdrawn.natural).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      toast.error("Settle your overdraft first", {
        description: `Your ${worstOverdrawn.code} balance is overdrawn by ${worstOverdrawn.symbol}${owed}. Converting now would be applied to that shortfall, so the funds wouldn't remain in ${toCurrency}. Please clear the overdraft before exchanging.`,
      })
      logActivity({
        action: `FX conversion ${fromCurrency} → ${toCurrency} DECLINED — account overdrawn (${worstOverdrawn.code})`,
        category: "Currency Exchange",
        details: {
          summary: `Conversion blocked because the ${worstOverdrawn.code} pocket is overdrawn by ${worstOverdrawn.symbol}${owed}; converting would only be swept into that shortfall.`,
          outcome: "DECLINED — Overdrawn balance",
        },
      })
      return
    }
    // The source amount plus the 0.4% fee must be covered by the balance.
    if (totalDebit > availableBalance) {
      toast.error("Insufficient funds", {
        description: `You need ${currencies.find((c) => c.code === fromCurrency)?.symbol}${totalDebit.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (incl. fee) but only have ${currencies.find((c) => c.code === fromCurrency)?.symbol}${availableBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${fromCurrency}.`,
      })
      logActivity({
        action: `FX conversion ${fromCurrency} → ${toCurrency} DECLINED — insufficient funds`,
        category: "Currency Exchange",
        details: {
          summary: `Attempted to convert ${fromCurrency} ${numericFrom.toLocaleString()} to ${toCurrency} but the ${fromCurrency} balance was insufficient (needed ${totalDebit.toFixed(2)}, available ${availableBalance.toFixed(2)}).`,
          outcome: "DECLINED — Insufficient funds",
        },
      })
      return
    }

    setIsExecuting(true)
    const receivedAmount = numericFrom * currentRate
    const ref = `FX-${Date.now().toString().slice(-8)}`
    const nowIso = new Date().toISOString()

    // Debit the source currency (amount sold).
    addDebit({
      id: ref,
      amount: numericFrom,
      currency: fromCurrency,
      status: "completed",
      date: nowIso,
      counterparty: `FX Conversion → ${toCurrency}`,
      reference: ref,
      category: "Currency Exchange",
    })
    // Debit the 0.4% conversion fee in the source currency.
    if (feeAmount > 0) {
      addDebit({
        id: `${ref}-FEE`,
        amount: Math.round(feeAmount * 100) / 100,
        currency: fromCurrency,
        status: "completed",
        date: nowIso,
        counterparty: "MCC FX Fee (0.4%)",
        reference: `${ref} — fee`,
        category: "Exchange Fee",
      })
    }
    // Credit the target currency (amount received).
    addReceipt({
      id: `${ref}-RCV`,
      amount: Math.round(receivedAmount * 100) / 100,
      currency: toCurrency,
      status: "completed",
      date: nowIso,
      counterparty: `FX Conversion ← ${fromCurrency}`,
      reference: ref,
      category: "Currency Exchange",
    })

    logActivity({
      action: `Executed FX conversion: ${fromCurrency} ${numericFrom.toLocaleString()} → ${toCurrency} ${receivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      category: "Currency Exchange",
      details: {
        summary: `Client converted ${fromCurrency} ${numericFrom.toLocaleString()} into ${toCurrency} ${receivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} at a rate of 1 ${fromCurrency} = ${currentRate.toFixed(4)} ${toCurrency}, with a 0.4% conversion fee (${fromCurrency} ${feeAmount.toFixed(2)}). Balances updated.`,
        reference: ref,
        sellCurrency: fromCurrency,
        sellAmount: `${fromCurrency} ${numericFrom.toLocaleString()}`,
        buyCurrency: toCurrency,
        buyAmount: `${toCurrency} ${receivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        exchangeRate: `1 ${fromCurrency} = ${currentRate.toFixed(4)} ${toCurrency}`,
        feePercent: "0.4%",
        fee: `${fromCurrency} ${feeAmount.toFixed(2)}`,
        executedAt: new Date().toLocaleString("en-GB"),
      },
    })

    // If the target pocket was overdrawn, the new funds first repay that
    // shortfall, so the visible balance may not rise by the full amount (or at
    // all). Say so plainly instead of implying a fresh positive balance.
    const projectedNatural = toNaturalBalance + Math.round(receivedAmount * 100) / 100
    const offsetNote = toIsOverdrawn
      ? projectedNatural > 0.01
        ? ` Your ${toCurrency} pocket was overdrawn, so ${toSymbol}${Math.abs(toNaturalBalance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of this first cleared the shortfall — visible ${toCurrency} balance is now about ${toSymbol}${projectedNatural.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        : ` This reduced an existing ${toCurrency} overdraft — the visible ${toCurrency} balance stays near ${toSymbol}0.00 until the shortfall is fully covered.`
      : ""
    toast.success("Exchange executed", {
      description: `Converted ${fromCurrency} ${numericFrom.toLocaleString()} → ${toCurrency} ${receivedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}.${offsetNote || " Balances updated."}`,
    })
    setIsExecuting(false)
  }

  useEffect(() => {
    const numericAmount = parseFloat(fromAmount.replace(/,/g, "")) || 0
    const converted = (numericAmount * currentRate).toFixed(2)
    setToAmount(parseFloat(converted).toLocaleString())
    // currentRate moves whenever live quotes update, so the receive amount
    // stays in sync with the market in real time.
  }, [fromAmount, currentRate])

  const handleSwap = () => {
    setFromCurrency(toCurrency)
    setToCurrency(fromCurrency)
    setFromAmount(toAmount.replace(/,/g, ""))
  }

  const refreshRates = () => {
    refresh()
  }

  const handleSetAlert = () => {
    logActivity({
      action: `Set a rate alert for ${fromCurrency}/${toCurrency}`,
      category: "Currency Exchange",
      details: {
        summary: `Client created a rate alert for the ${fromCurrency}/${toCurrency} pair (current rate ${currentRate.toFixed(4)}).`,
        pair: `${fromCurrency}/${toCurrency}`,
        currentRate: currentRate.toFixed(4),
        createdAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Rate alert created", {
      description: `We'll notify you of changes to ${fromCurrency}/${toCurrency}.`,
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Currency Exchange
          </h1>
          <p className="text-sm text-muted-foreground">
            Trade 330+ forex pairs with live rates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-muted-foreground">Markets Open</span>
          </div>
          <Button variant="outline" size="sm" onClick={refreshRates}>
            <RefreshCw
              className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")}
            />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Exchange Calculator */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">
                Exchange Calculator
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* From Currency */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">You Send</Label>
                {/* Spendable balance for the selected send currency, shown
                    up-front on its own strip so the long figure never crowds
                    the label. Max fills the largest amount net of the fee. */}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Available {fromCurrency}
                    </span>
                    <span className="truncate font-mono text-sm font-semibold tabular-nums text-foreground">
                      {currencies.find((c) => c.code === fromCurrency)?.symbol}
                      {availableBalance.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      // Max sendable = balance net of the 0.4% fee, so the
                      // total debit (amount + fee) never exceeds the balance.
                      const max = availableBalance / (1 + conversionFee)
                      setFromAmount((Math.floor(max * 100) / 100).toString())
                    }}
                    disabled={availableBalance <= 0}
                    className="shrink-0 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
                  >
                    Max
                  </button>
                </div>
                <div className="flex gap-2">
                  <Select value={fromCurrency} onValueChange={setFromCurrency}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {currencies.map((currency) => (
                        <SelectItem key={currency.code} value={currency.code}>
                          <div className="flex items-center gap-2">
                            <span>{currency.flag}</span>
                            <span>{currency.code}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <MoneyInput
                    value={fromAmount}
                    onValueChange={setFromAmount}
                    className="flex-1 text-lg font-mono"
                    placeholder="0.00"
                  />
                </div>
              </div>

              {/* Swap Button */}
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full"
                  onClick={handleSwap}
                >
                  <ArrowDownUp className="h-4 w-4" />
                </Button>
              </div>

              {/* To Currency */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">You Receive</Label>
                {/* True (natural) balance of the target currency, excluding
                    internal auto-cover rows, so a conversion into an overdrawn
                    pocket is honest rather than showing a masked 0.00. */}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Current {toCurrency} balance
                  </span>
                  <span
                    className={cn(
                      "truncate font-mono text-sm font-semibold tabular-nums",
                      toIsOverdrawn ? "text-red-500" : "text-foreground",
                    )}
                  >
                    {toSymbol}
                    {toNaturalBalance.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                {toIsOverdrawn && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Your {toCurrency} pocket is currently overdrawn by{" "}
                      <span className="font-mono font-semibold">
                        {toSymbol}
                        {Math.abs(toNaturalBalance).toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      . This conversion first repays that shortfall — your visible {toCurrency}{" "}
                      balance only rises once you convert more than the overdrawn amount.
                    </span>
                  </div>
                )}
                <div className="flex gap-2">
                  <Select value={toCurrency} onValueChange={setToCurrency}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {currencies.map((currency) => (
                        <SelectItem key={currency.code} value={currency.code}>
                          <div className="flex items-center gap-2">
                            <span>{currency.flag}</span>
                            <span>{currency.code}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Computed display only — you type in "You Send". Kept fully
                      non-interactive so iOS never grabs focus and pops the
                      Copy/AutoFill menu with no keyboard ("where's the keyboard?"). */}
                  <Input
                    value={toAmount}
                    readOnly
                    tabIndex={-1}
                    inputMode="none"
                    aria-readonly
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    onMouseDown={(e) => e.preventDefault()}
                    onFocus={(e) => e.currentTarget.blur()}
                    className="flex-1 text-lg font-mono bg-secondary cursor-default pointer-events-none"
                    placeholder="0.00"
                  />
                </div>
              </div>

              {/* Rate Info */}
              <div className="rounded-lg bg-secondary/50 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Exchange Rate
                  </span>
                  <span className="text-sm font-mono font-semibold text-foreground">
                    1 {fromCurrency} = {currentRate.toFixed(4)} {toCurrency}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Conversion Fee (0.4%)
                  </span>
                  <span className="text-sm font-mono text-foreground">
                    {currencies.find((c) => c.code === fromCurrency)?.symbol}
                    {(
                      parseFloat(fromAmount.replace(/,/g, "")) * conversionFee
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-sm font-medium text-foreground">
                    You Pay
                  </span>
                  <span className="text-lg font-bold text-foreground">
                    {currencies.find((c) => c.code === fromCurrency)?.symbol}
                    {totalDebit.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Available {fromCurrency}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-mono",
                      totalDebit > availableBalance
                        ? "text-red-500"
                        : "text-foreground",
                    )}
                  >
                    {currencies.find((c) => c.code === fromCurrency)?.symbol}
                    {availableBalance.toLocaleString("en-US", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </div>

              {accountHasOverdraft && worstOverdrawn && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                  Your {worstOverdrawn.code} balance is overdrawn by {worstOverdrawn.symbol}
                  {Math.abs(worstOverdrawn.natural).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  . Currency exchange is paused until the overdraft is settled — converting now
                  would be swept into the shortfall instead of staying in your target currency.
                </div>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleExecuteExchange}
                disabled={
                  isExecuting || numericFrom <= 0 || totalDebit > availableBalance || accountHasOverdraft
                }
              >
                {accountHasOverdraft
                  ? "Settle Overdraft First"
                  : totalDebit > availableBalance
                    ? "Insufficient Funds"
                    : "Execute Exchange"}
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Rate guaranteed for 30 seconds • Last updated:{" "}
                {lastUpdate.toLocaleTimeString()}
              </p>
            </CardContent>
          </Card>

          {/* Rate Chart */}
          <Card className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold">
                  {fromCurrency}/{toCurrency} Rate Chart
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  24 hour performance
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    pairChangePct >= 0
                      ? "bg-green-500/10 text-green-500 border-green-500/20"
                      : "bg-red-500/10 text-red-500 border-red-500/20",
                  )}
                >
                  {pairChangePct >= 0 ? (
                    <TrendingUp className="mr-1 h-3 w-3" />
                  ) : (
                    <TrendingDown className="mr-1 h-3 w-3" />
                  )}
                  {pairChangePct >= 0 ? "+" : ""}
                  {pairChangePct.toFixed(2)}%
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-[220px] w-full">
                <TradingViewWidget
                  scriptSrc="embed-widget-mini-symbol-overview.js"
                  config={{
                    symbol: `FX:${fromCurrency}${toCurrency}`,
                    width: "100%",
                    height: "100%",
                    locale: "en",
                    dateRange: "1D",
                    colorTheme: "dark",
                    isTransparent: true,
                    autosize: true,
                    chartOnly: false,
                  }}
                  height="100%"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Sidebar */}
        <div className="space-y-6">
          {/* Live Rates */}
          <Card className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-lg font-semibold">Live Rates</CardTitle>
              <Button variant="ghost" size="icon" onClick={refreshRates}>
                <RefreshCw
                  className={cn("h-4 w-4", isRefreshing && "animate-spin")}
                />
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {liveRates.map((rate) => (
                  <div
                    key={rate.pair}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {rate.pair}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-foreground">
                        {rate.hasQuote ? rate.rate.toFixed(rate.decimals) : "—"}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          !rate.hasQuote
                            ? "bg-secondary text-muted-foreground border-border"
                            : rate.trend === "up"
                              ? "bg-green-500/10 text-green-500 border-green-500/20"
                              : "bg-red-500/10 text-red-500 border-red-500/20"
                        )}
                      >
                        {rate.trend === "up" ? (
                          <TrendingUp className="mr-1 h-3 w-3" />
                        ) : (
                          <TrendingDown className="mr-1 h-3 w-3" />
                        )}
                        {Math.abs(rate.change).toFixed(2)}%
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Recent Exchanges */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <History className="h-4 w-4" />
                Recent Exchanges
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recentExchanges.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary mb-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No exchanges yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Your currency conversions will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                {recentExchanges.map((exchange) => (
                  <div
                    key={exchange.id}
                    className="rounded-lg border border-border bg-secondary/30 p-3"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <code className="text-xs text-muted-foreground">
                        {exchange.id}
                      </code>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          exchange.status === "completed"
                            ? "bg-green-500/10 text-green-500 border-green-500/20"
                            : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                        )}
                      >
                        {exchange.status === "completed" ? (
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                        ) : (
                          <Clock className="mr-1 h-3 w-3" />
                        )}
                        {exchange.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {exchange.fromCurrency}{" "}
                          {exchange.fromAmount.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {exchange.date} at {exchange.time}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-500">
                          {exchange.toCurrency}{" "}
                          {exchange.toAmount.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          @ {exchange.rate}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              )}
            </CardContent>
          </Card>

          {/* Rate Alerts */}
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Bell className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Rate Alerts
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Get notified on rate changes
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleSetAlert}>
                  <Settings className="mr-2 h-3 w-3" />
                  Set Alert
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
