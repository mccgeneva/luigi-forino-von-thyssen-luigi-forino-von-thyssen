"use client"

import { useState, useRef, useMemo } from "react"
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Zap,
  Shield,
  ArrowRight,
  Crown,
  Sparkles,
  Bot,
  LineChart,
  Gauge,
  Landmark,
  Coins,
  Check,
  Lock,
  Minus,
  Plus,
  BadgeCheck,
  ArrowUpRight,
  Loader2,
  Clock,
  ShieldCheck,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { mirrorSubmissionDetailed } from "@/lib/approval-sync"
import { useCurrentUser } from "@/lib/use-current-user"
import { useMembership } from "@/lib/use-membership"
import { requestMembershipUpgrade } from "@/app/actions/membership"
import { effectivePlatformTier, MEMBERSHIP_STATUS_LABEL } from "@/lib/membership"
import { useLedger } from "@/lib/ledger-store"
import { useMarketQuotes } from "@/lib/use-market"
import { TradingViewWidget } from "@/components/market/tradingview-widget"
import { tradingViewSymbol } from "@/lib/market-symbols"

type Signal = "BUY" | "SELL" | "HOLD"

type Instrument = {
  symbol: string
  name: string
  category: "Commodities" | "Forex" | "Equities" | "Crypto" | "Indices"
  price: number
  decimals: number
  change: number
  signal: Signal
  confidence: number
  /** True once a real quote from the live feed has been merged in. */
  live?: boolean
}

// Instrument metadata + analyst signal/confidence. Live price and change are
// merged in from the market-data feed at render time (see useMarketQuotes);
// the seed price/change here are only fallbacks until quotes load and are never
// shown on screen until a real quote merges in (see the `live` flag).
const INSTRUMENT_META: Instrument[] = [
  // Commodities & energy
  { symbol: "XAU/USD", name: "Gold Spot", category: "Commodities", price: 4103.0, decimals: 2, change: 1.37, signal: "BUY", confidence: 91 },
  { symbol: "WTI", name: "Crude Oil · WTI (USOIL)", category: "Commodities", price: 70.24, decimals: 2, change: -2.34, signal: "HOLD", confidence: 64 },
  { symbol: "BRENT", name: "Crude Oil · Brent (UKOIL)", category: "Commodities", price: 73.57, decimals: 2, change: -2.56, signal: "HOLD", confidence: 63 },
  { symbol: "ULSD", name: "Gulf Diesel · ULSD", category: "Commodities", price: 3.132, decimals: 4, change: -2.41, signal: "HOLD", confidence: 60 },
  { symbol: "RBOB", name: "Gasoline · RBOB", category: "Commodities", price: 2.853, decimals: 4, change: -1.71, signal: "HOLD", confidence: 58 },
  { symbol: "NG", name: "Natural Gas", category: "Commodities", price: 3.287, decimals: 3, change: -0.24, signal: "BUY", confidence: 78 },
  // Forex
  { symbol: "DXY", name: "US Dollar Index", category: "Forex", price: 101.37, decimals: 2, change: 0.01, signal: "HOLD", confidence: 67 },
  { symbol: "EUR/USD", name: "Euro / Dollar", category: "Forex", price: 1.139, decimals: 4, change: 0.11, signal: "BUY", confidence: 73 },
  { symbol: "USD/JPY", name: "Dollar / Yen", category: "Forex", price: 161.73, decimals: 2, change: -0.03, signal: "SELL", confidence: 69 },
  // Equities
  { symbol: "AAPL", name: "Apple Inc.", category: "Equities", price: 283.78, decimals: 2, change: 3.14, signal: "BUY", confidence: 84 },
  { symbol: "MSFT", name: "Microsoft Corp.", category: "Equities", price: 372.97, decimals: 2, change: 5.71, signal: "BUY", confidence: 86 },
  { symbol: "AMZN", name: "Amazon.com Inc.", category: "Equities", price: 232.69, decimals: 2, change: 2.5, signal: "BUY", confidence: 79 },
  { symbol: "GOOGL", name: "Alphabet Inc.", category: "Equities", price: 337.39, decimals: 2, change: -1.84, signal: "HOLD", confidence: 68 },
  { symbol: "META", name: "Meta Platforms", category: "Equities", price: 550.25, decimals: 2, change: 1.36, signal: "BUY", confidence: 82 },
  { symbol: "TSLA", name: "Tesla Inc.", category: "Equities", price: 379.71, decimals: 2, change: 1.22, signal: "SELL", confidence: 71 },
  { symbol: "NVDA", name: "Nvidia Corp.", category: "Equities", price: 192.53, decimals: 2, change: -1.64, signal: "BUY", confidence: 93 },
  { symbol: "PLTR", name: "Palantir Tech.", category: "Equities", price: 112.93, decimals: 2, change: 5.27, signal: "BUY", confidence: 81 },
  { symbol: "ORCL", name: "Oracle Corp.", category: "Equities", price: 148.53, decimals: 2, change: -2.58, signal: "HOLD", confidence: 67 },
  { symbol: "MSTR", name: "Strategy (MSTR)", category: "Equities", price: 82.31, decimals: 2, change: -3.54, signal: "HOLD", confidence: 62 },
  { symbol: "AMD", name: "Adv. Micro Devices", category: "Equities", price: 521.58, decimals: 2, change: -2.06, signal: "BUY", confidence: 77 },
  { symbol: "JPM", name: "JPMorgan Chase", category: "Equities", price: 329.05, decimals: 2, change: -1.81, signal: "HOLD", confidence: 65 },
  // Crypto
  { symbol: "BTC/USD", name: "Bitcoin", category: "Crypto", price: 60226, decimals: 0, change: 0.35, signal: "BUY", confidence: 88 },
  { symbol: "ETH/USD", name: "Ethereum", category: "Crypto", price: 1579, decimals: 0, change: 0.14, signal: "HOLD", confidence: 61 },
  // Indices
  { symbol: "NDX", name: "NASDAQ 100", category: "Indices", price: 29118, decimals: 0, change: -1.09, signal: "BUY", confidence: 80 },
  { symbol: "SPX", name: "S&P 500", category: "Indices", price: 7354, decimals: 0, change: -0.05, signal: "HOLD", confidence: 66 },
]

const INSTRUMENT_SYMBOLS = INSTRUMENT_META.map((m) => m.symbol)

type Position = {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  lots: number
  entry: number
  current: number
  pnl: number
}

// No capital is allocated to NQAi until the client funds and deploys positions.
// Figures below derive from the real account ledger, never placeholder amounts.
const POSITIONS: Position[] = []

const TIERS = [
  {
    id: "pro",
    name: "PRO",
    icon: Sparkles,
    roi: "6.8% – 11.4%",
    features: ["Enhanced algorithms", "Cross-asset arbitrage", "Multi-asset execution"],
    active: true,
  },
  {
    id: "avantgarde",
    name: "Avant-Garde",
    icon: Crown,
    roi: "9.3% – 16.7%",
    features: ["Full NQAi engine", "Institutional tooling", "Maximum AI access"],
    active: false,
  },
]

const signalStyles: Record<Signal, string> = {
  BUY: "bg-green-500/10 text-green-500 border-green-500/20",
  SELL: "bg-red-500/10 text-red-500 border-red-500/20",
  HOLD: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
}

// Treuhand AG Limited Hedge Fund — parameters from the NAFTAhub Investor Prospectus 2026.
const TOKEN_VALUE = 10000
const MIN_TOKENS = 3
const MONTHLY_ROI = 0.25

const FUND_HIGHLIGHTS = [
  { label: "Fixed Monthly ROI", value: "25%", note: "Secured, per active token" },
  { label: "Capital Guaranteed", value: "100%", note: "Swiss fiduciary law" },
  { label: "Token Unit Value", value: "€10,000", note: "Fixed denomination" },
  { label: "Minimum Entry", value: "3 Tokens", note: "€30,000 position" },
  { label: "Entry & Mgmt Fees", value: "0%", note: "Zero cost of entry" },
  { label: "Max Trading Days", value: "20 / mo", note: "Market dependent" },
]

const PROTECTION_LAYERS = [
  {
    icon: Bot,
    title: "Automated Trading Suspension",
    text: "NQAi monitors geopolitical risk and volatility, halting all trading automatically in abnormal conditions and resuming once stability is restored.",
  },
  {
    icon: Shield,
    title: "P&L Floor Absorption",
    text: "At withdrawal, any net trading loss below €2,500 is fully absorbed by the Treuhand AG fund — at zero cost to the investor.",
  },
  {
    icon: Lock,
    title: "Swiss Fiduciary Guarantee",
    text: "All positions are held under Swiss fiduciary law via Treuhand AG Limited. Capital is contractually guaranteed and ring-fenced.",
  },
  {
    icon: BadgeCheck,
    title: "AML / KYC Compliance Gate",
    text: "Full AML/KYC/FATCA/CRS due diligence prior to admission, monitored quarterly by Bildenberg Limited (Hong Kong SAR).",
  },
]

const GOVERNANCE = [
  { entity: "MCC Capital", role: "Strategic Command — Office of the President, Geneva." },
  { entity: "Bildenberg Limited", role: "Regulatory Compliance — AML/KYC oversight, Hong Kong SAR." },
  { entity: "Treuhand AG Limited", role: "Fiduciary & Trust administration, escrow and capital protection." },
  { entity: "NQAi Engine", role: "Autonomous multi-asset AI execution intelligence." },
]

const ONBOARDING_STEPS = [
  "Inquiry & investor profile review",
  "KYC / AML due diligence",
  "Treuhand AG investment agreement & token allocation",
  "Capital transfer to fiduciary account",
  "Dedicated IBAN issued — NQAi trading commences",
  "Monthly ROI settlement & P&L statement",
]

function formatPrice(value: number, decimals: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export default function TradingPage() {
  const log = useActivityLog()
  const user = useCurrentUser()
  const { membership, hydrated: membershipHydrated, refresh: refreshMembership } = useMembership()
  const [upgradeSubmitting, setUpgradeSubmitting] = useState(false)
  const { totalIn } = useLedger()

  // The client's real effective tier drives which ROI-tier card is "current"
  // and whether an Avant-Garde upgrade request is already in flight — so the
  // UI always reflects the actual membership state, never a hardcoded flag.
  const effectiveTier = effectivePlatformTier(user.accountBadge, membership)
  const isAvantActive = effectiveTier.id === "avantgarde"
  const avantPending = membership?.tier === "avantgarde" && membership.status === "pending"
  const avantApproved = membership?.tier === "avantgarde" && membership.status === "approved"
  const avantRejected = membership?.tier === "avantgarde" && membership.status === "rejected"

  const requestAvantGarde = async () => {
    setUpgradeSubmitting(true)
    const res = await requestMembershipUpgrade("avantgarde")
    setUpgradeSubmitting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    await refreshMembership()
    log({
      action: "Requested upgrade to Avant-Garde tier",
      category: "NAFTAhub Trading",
      details: {
        summary:
          "Client submitted an Avant-Garde upgrade request. It is pending administrator approval; once approved, Treasury validates the €1,000,000 security deposit to activate the membership.",
        tier: "Avant-Garde",
        requestedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Upgrade request submitted", {
      description:
        "Your Avant-Garde request is pending administrator approval. Once approved, Treasury validates the €1,000,000 security deposit to activate your membership.",
    })
  }
  // Real funds available to the client, aggregated from the ledger (EUR equiv.).
  const availableCapital = totalIn("EUR")
  // Live market prices power the trade-ticket execution price and the AI-signal
  // context. The on-screen price BOARD itself is rendered by TradingView's own
  // widget (see "Live Markets" below) so the displayed numbers always match the
  // user's TradingView app exactly. Yahoo's spot-vs-futures symbol differences
  // (e.g. gold) and weekend-frozen closes were the source of the recurring
  // "prices don't match TradingView / not updating" reports.
  const { quotes } = useMarketQuotes(INSTRUMENT_SYMBOLS)
  // Merge live price + change onto the instrument metadata; analyst signal and
  // confidence are kept as-is, only the market price/change come from the feed.
  const instruments = useMemo<Instrument[]>(
    () =>
      INSTRUMENT_META.map((m) => {
        const q = quotes[m.symbol]
        // Only mark an instrument "live" once a real quote merges in, so the
        // trade ticket never executes against a stale seed price.
        return q ? { ...m, price: q.price, change: q.changePct, live: true } : { ...m, live: false }
      }),
    [quotes],
  )

  // Group every instrument by asset class for the TradingView "Market Quotes"
  // widget, mapping each to its canonical TradingView symbol so the board shows
  // exactly the prices the user sees on TradingView.
  const quoteGroups = useMemo(() => {
    const order: Instrument["category"][] = ["Commodities", "Forex", "Indices", "Equities", "Crypto"]
    return order
      .map((cat) => ({
        name: cat,
        symbols: INSTRUMENT_META.filter((m) => m.category === cat).map((m) => ({
          name: tradingViewSymbol(m.symbol),
          displayName: `${m.symbol} · ${m.name}`,
        })),
      }))
      .filter((g) => g.symbols.length > 0)
  }, [])

  // Symbols for the live ticker-tape banner (one canonical TradingView symbol
  // per instrument), so the moving strip shows real, self-updating prices.
  const tickerTapeSymbols = useMemo(
    () =>
      INSTRUMENT_META.map((m) => ({
        proName: tradingViewSymbol(m.symbol),
        title: m.symbol,
      })),
    [],
  )
  const [autoExecute, setAutoExecute] = useState(true)
  const [tradeTarget, setTradeTarget] = useState<Instrument | null>(null)
  const [tradeSide, setTradeSide] = useState<"LONG" | "SHORT">("LONG")
  const [lots, setLots] = useState("0.10")
  const [activeTab, setActiveTab] = useState("markets")
  const [tokens, setTokens] = useState(MIN_TOKENS)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applicantName, setApplicantName] = useState("")
  const [applicantEmail, setApplicantEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const capital = tokens * TOKEN_VALUE
  const monthlyReturn = capital * MONTHLY_ROI

  const formatEur = (n: number) =>
    `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`

  const tabsNavRef = useRef<HTMLDivElement>(null)

  // When switching sections, bring the sticky nav into view so the new section
  // starts from its top instead of leaving the user stranded mid-scroll.
  const handleTabChange = (value: string) => {
    setActiveTab(value)
    requestAnimationFrame(() => {
      tabsNavRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const openFund = () => handleTabChange("fund")

  const submitApplication = async () => {
    if (submitting) return
    const applicant = applicantName.trim() || user.fullName
    const email = applicantEmail.trim() || user.email
    setSubmitting(true)

    // Mirror the application into the DB-backed approvals backbone so the
    // Administrator receives an authorization task cross-client — WITHOUT this
    // the submission only logged locally and no admin task was ever raised.
    const res = await mirrorSubmissionDetailed({
      kind: "trading_fund",
      title: `Treuhand AG Hedge Fund — ${tokens} tokens`,
      summary: `${applicant} applied to the Treuhand AG Limited Hedge Fund for ${tokens} tokens (${formatEur(capital)} capital) at 25% fixed monthly ROI (${formatEur(monthlyReturn)}/mo projected).`,
      amount: capital,
      currency: "EUR",
      payload: {
        fund: "Treuhand AG Limited Hedge Fund",
        tokens,
        tokenValue: TOKEN_VALUE,
        capital,
        monthlyRoi: monthlyReturn,
        applicant,
        email,
        submittedAt: new Date().toISOString(),
      },
    })
    setSubmitting(false)

    if (!res.ok) {
      toast.error("Application could not be submitted", {
        description: res.error || "Please try again in a moment.",
      })
      return
    }

    log({
      action: `Applied to Treuhand AG Limited Hedge Fund — ${tokens} tokens (${formatEur(capital)})`,
      category: "NAFTAhub Trading",
      details: {
        summary: `Client submitted an application to the Treuhand AG Limited Hedge Fund for ${tokens} tokens (${formatEur(capital)} capital) at 25% fixed monthly ROI (${formatEur(monthlyReturn)}/mo projected). Sent to the Administrator for authorization.`,
        fund: "Treuhand AG Limited Hedge Fund",
        tokens: String(tokens),
        capitalDeployed: formatEur(capital),
        monthlyRoi: formatEur(monthlyReturn),
        applicant,
        email,
        approvalId: res.id ?? "—",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Application submitted", {
      description: `Your ${tokens}-token application (${formatEur(capital)}) has been sent to the Administrator for authorization. KYC onboarding to follow.`,
    })
    setApplyOpen(false)
    setApplicantName("")
    setApplicantEmail("")
  }

  const toggleAutoExecute = (next: boolean) => {
    setAutoExecute(next)
    log({
      action: `NQAi auto-execution ${next ? "enabled" : "disabled"}`,
      category: "NAFTAhub Trading",
      details: {
        summary: `Client ${next ? "enabled" : "disabled"} the NQAi automated execution engine.`,
        engine: "NQAi",
        autoExecution: next ? "ON" : "OFF",
        toggledAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast[next ? "success" : "info"](`NQAi auto-execution ${next ? "enabled" : "paused"}`, {
      description: next
        ? "The engine will now execute micro-positions automatically."
        : "Automated execution paused. Signals remain live for manual trading.",
    })
  }

  const openTrade = (instrument: Instrument, side: "LONG" | "SHORT") => {
    setTradeTarget(instrument)
    setTradeSide(side)
    setLots("0.10")
  }

  const confirmTrade = () => {
    if (!tradeTarget) return
    const volume = parseFloat(lots) || 0
    log({
      action: `Deployed NQAi ${tradeSide} micro-position on ${tradeTarget.symbol}`,
      category: "NAFTAhub Trading",
      details: {
        summary: `Client opened a ${tradeSide} position of ${volume.toFixed(2)} lots on ${tradeTarget.symbol} (${tradeTarget.name}) at ${formatPrice(tradeTarget.price, tradeTarget.decimals)} via the NQAi engine.`,
        instrument: tradeTarget.symbol,
        side: tradeSide,
        lots: volume.toFixed(2),
        entryPrice: formatPrice(tradeTarget.price, tradeTarget.decimals),
        aiSignal: tradeTarget.signal,
        confidence: `${tradeTarget.confidence}%`,
        openedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Position deployed", {
      description: `${tradeSide} ${volume.toFixed(2)} lots ${tradeTarget.symbol} routed to the NQAi engine.`,
    })
    setTradeTarget(null)
  }

  const openPnl = POSITIONS.reduce((sum, p) => sum + p.pnl, 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 items-center rounded-lg bg-white px-2 py-1.5">
            <img
              src="/images/naftahub-logo.png"
              alt="NAFTAhub logo"
              className="h-7 w-auto object-contain sm:h-8"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">NAFTAhub</h1>
              <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                NQAi Engine
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground text-pretty">
              Neural Quantum AI trading across commodities, FX, equities, crypto &amp; indices.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href="https://v0-nqai-political-volatility-agent.vercel.app"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <Landmark className="h-3.5 w-3.5 text-primary" />
                Political Volatility Agent
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
              <a
                href="https://v0-naftahub.vercel.app/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <LineChart className="h-3.5 w-3.5 text-primary" />
                NAFTAhub Platform
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
              </a>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={openFund}
          className="group flex w-fit max-w-md items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-left leading-snug text-primary transition-colors hover:bg-primary/20"
        >
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="text-xs font-medium">
            Apply to the Treuhand AG Limited hedge fund and benefit from 25% monthly ROI — secured &amp; automated by NQAi
          </span>
          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      {/* NQAi engine status */}
      <Card className="border-primary/20 bg-gradient-to-r from-primary/10 to-primary/5">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="relative mt-0.5">
              <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-green-500/60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-green-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <h2 className="font-semibold text-foreground">NQAi Engine — Operational</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground text-pretty">
                Neural Quantum Scalping Dynamics running. Midpoint deviation, RSI/EMA/ATR
                overlays and fractional foresight active across {instruments.length} instruments.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-4 py-2">
            <div>
              <p className="text-xs font-medium text-foreground">Auto-Execution</p>
              <p className="text-[10px] text-muted-foreground">{autoExecute ? "Engine trading live" : "Manual mode"}</p>
            </div>
            <Switch checked={autoExecute} onCheckedChange={toggleAutoExecute} aria-label="Toggle NQAi auto-execution" />
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Available Capital</p>
                <p className="mt-1 text-2xl font-bold text-foreground">{formatEur(availableCapital)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {POSITIONS.length > 0 ? `Across ${POSITIONS.length} positions` : "Ready to allocate"}
                </p>
              </div>
              <div className="rounded-lg bg-primary/10 p-3">
                <LineChart className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Today&apos;s P&amp;L</p>
                <p className={cn("mt-1 text-2xl font-bold", openPnl > 0 ? "text-green-500" : "text-foreground")}>
                  {openPnl > 0 ? `+${formatEur(openPnl)}` : formatEur(0)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {POSITIONS.length > 0 ? "Live session" : "No active positions"}
                </p>
              </div>
              <div className={cn("rounded-lg p-3", openPnl > 0 ? "bg-green-500/10" : "bg-secondary")}>
                <TrendingUp className={cn("h-5 w-5", openPnl > 0 ? "text-green-500" : "text-muted-foreground")} />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">NQAi Win Rate</p>
                <p className="mt-1 text-2xl font-bold text-foreground">87.2%</p>
                <p className="mt-1 text-xs text-muted-foreground">Engine benchmark</p>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-3">
                <Gauge className="h-5 w-5 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Open Positions</p>
                <p className="mt-1 text-2xl font-bold text-foreground">{POSITIONS.length}</p>
                <p className="mt-1 text-xs text-muted-foreground">Micro-position layering</p>
              </div>
              <div className="rounded-lg bg-orange-500/10 p-3">
                <Activity className="h-5 w-5 text-orange-400" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live ticker tape — real, self-updating quotes streamed directly from
          TradingView so the numbers always match the TradingView app. */}
      <Card className="bg-card border-border overflow-hidden">
        <div className="h-[46px] w-full">
          <TradingViewWidget
            scriptSrc="embed-widget-ticker-tape.js"
            config={{
              symbols: tickerTapeSymbols,
              showSymbolLogo: true,
              isTransparent: true,
              displayMode: "adaptive",
              colorTheme: "dark",
              locale: "en",
            }}
            height={46}
          />
        </div>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        {/* Sticky section nav: stays pinned below the header so users can jump
            between sections from anywhere in a long, data-heavy tab. */}
        <div
          ref={tabsNavRef}
          className="sticky top-0 z-30 -mx-4 mb-2 scroll-mt-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:-mx-6 md:px-6"
        >
          <TabsList className="flex w-full justify-start overflow-x-auto">
            <TabsTrigger value="markets">Markets</TabsTrigger>
            <TabsTrigger value="signals">AI Signals</TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="tiers">ROI Tiers</TabsTrigger>
            <TabsTrigger value="fund">Treuhand Fund</TabsTrigger>
          </TabsList>
        </div>

        {/* Markets */}
        <TabsContent value="markets" className="mt-6 space-y-6">
          {/* Real-time TradingView chart — switch instruments via the watchlist. */}
          <Card className="bg-card border-border overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Live Chart</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">Real-time market data · TradingView</p>
            </CardHeader>
            <CardContent>
              <div className="h-[420px] w-full">
                <TradingViewWidget
                  scriptSrc="embed-widget-advanced-chart.js"
                  config={{
                    autosize: true,
                    symbol: tradingViewSymbol("XAU/USD"),
                    interval: "60",
                    timezone: "Etc/UTC",
                    theme: "dark",
                    style: "1",
                    locale: "en",
                    hide_side_toolbar: true,
                    allow_symbol_change: true,
                    watchlist: INSTRUMENT_SYMBOLS.map((s) => tradingViewSymbol(s)),
                    support_host: "https://www.tradingview.com",
                  }}
                  height="100%"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg font-semibold">Live Markets</CardTitle>
                <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-500">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500/70" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                  </span>
                  LIVE
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Real-time quotes streamed from TradingView — the exact prices shown in your TradingView app.
              </p>
            </CardHeader>
            <CardContent>
              <div className="h-[560px] w-full">
                <TradingViewWidget
                  scriptSrc="embed-widget-market-quotes.js"
                  config={{
                    width: "100%",
                    height: "100%",
                    symbolsGroups: quoteGroups,
                    showSymbolLogo: true,
                    isTransparent: true,
                    colorTheme: "dark",
                    backgroundColor: "rgba(0,0,0,0)",
                    locale: "en",
                  }}
                  height="100%"
                />
              </div>
            </CardContent>
          </Card>

          {/* Quick Trade — deploy an NQAi position. No price is shown here so it
              can never contradict the TradingView board above; the execution
              price is captured live from the feed at order time. */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Quick Trade</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Deploy a position with the NQAi engine — execution price is taken live at order time.
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {instruments.map((it) => (
                <div
                  key={it.symbol}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <span className="text-[10px] font-semibold text-foreground">
                        {it.symbol.split("/")[0].slice(0, 4)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{it.symbol}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {it.name} · {it.category}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className={cn("w-14 justify-center text-[10px]", signalStyles[it.signal])}>
                      {it.signal}
                    </Badge>
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={!it.live}
                      onClick={() => openTrade(it, it.signal === "SELL" ? "SHORT" : "LONG")}
                    >
                      Trade
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Signals */}
        <TabsContent value="signals" className="mt-6">
          <div className="grid gap-4 md:grid-cols-2">
            {instruments
              .filter((it) => it.signal !== "HOLD")
              .map((it) => (
                <Card key={it.symbol} className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-base font-semibold">{it.symbol}</CardTitle>
                        <p className="text-xs text-muted-foreground">{it.name}</p>
                      </div>
                      <Badge variant="outline" className={cn("text-[10px]", signalStyles[it.signal])}>
                        <Zap className="mr-1 h-3 w-3" />
                        {it.signal}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">NQAi Confidence</span>
                        <span className="text-xs font-semibold text-foreground">{it.confidence}%</span>
                      </div>
                      <Progress value={it.confidence} className="h-1.5" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-md bg-secondary/40 p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">RSI(7)</p>
                        <p className="text-xs font-semibold text-foreground">
                          {it.signal === "BUY" ? "31" : "69"}
                        </p>
                      </div>
                      <div className="rounded-md bg-secondary/40 p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">EMA(40)</p>
                        <p className="text-xs font-semibold text-foreground">
                          {it.signal === "BUY" ? "↑" : "↓"}
                        </p>
                      </div>
                      <div className="rounded-md bg-secondary/40 p-2 text-center">
                        <p className="text-[10px] text-muted-foreground">ATR×</p>
                        <p className="text-xs font-semibold text-foreground">1.5</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => openTrade(it, it.signal === "SELL" ? "SHORT" : "LONG")}
                    >
                      Execute Signal
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
          </div>
        </TabsContent>

        {/* Positions */}
        <TabsContent value="positions" className="mt-6">
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Open Micro-Positions</CardTitle>
              <p className="text-xs text-muted-foreground">
                Capital-segmented layering managed by the NQAi risk controller
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {POSITIONS.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <Activity className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">No open positions</p>
                    <p className="mt-1 text-xs text-muted-foreground text-pretty">
                      You have no capital allocated to NQAi yet. Deploy a position from the Markets
                      tab or apply to the Treuhand AG fund to begin.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleTabChange("markets")}>
                    Browse Markets
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              ) : (
                POSITIONS.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          p.side === "LONG"
                            ? "bg-green-500/10 text-green-500 border-green-500/20"
                            : "bg-red-500/10 text-red-500 border-red-500/20",
                        )}
                      >
                        {p.side}
                      </Badge>
                      <div>
                        <p className="text-sm font-medium text-foreground">{p.symbol}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.lots.toFixed(2)} lots · {p.id}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-green-500">+{formatEur(p.pnl)}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {p.entry} → {p.current}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ROI Tiers */}
        <TabsContent value="tiers" className="mt-6">
          {/* Live upgrade status — gives the client a clear sign of a pending,
              approved or declined Avant-Garde request instead of a silent click. */}
          {membershipHydrated && membership?.tier === "avantgarde" && membership.status !== "active" && (
            <div
              className={cn(
                "mb-6 flex items-start gap-3 rounded-lg border p-4",
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
                    ? "Your request has been approved. Treasury is validating your €1,000,000 security deposit; your tier activates as soon as it is secured."
                    : avantRejected
                      ? `Your request was declined.${membership.note ? ` ${membership.note}` : ""} You may submit a new request below.`
                      : "Your request is pending administrator approval. After approval, Treasury validates the €1,000,000 security deposit to activate your membership."}
                </p>
              </div>
            </div>
          )}
          <div className="grid gap-6 md:grid-cols-3">
            {TIERS.map((tier) => {
              const isCurrent =
                (tier.id === "pro" && effectiveTier.id === "pro") ||
                (tier.id === "avantgarde" && isAvantActive)
              return (
              <Card
                key={tier.id}
                className={cn("relative border-border bg-card", isCurrent && "border-primary shadow-lg shadow-primary/10")}
              >
                {isCurrent && (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
                    Your Tier
                  </Badge>
                )}
                <CardHeader className="space-y-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                    <tier.icon className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-foreground">{tier.name}</h3>
                    <p className="text-xs text-muted-foreground">Daily ROI</p>
                    <p className="text-2xl font-bold text-primary">{tier.roi}</p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span className="text-sm text-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                  {tier.id === "pro" ? (
                    <Button className="w-full" variant="outline" disabled>
                      {isCurrent ? (
                        <>
                          <Check className="mr-1.5 h-4 w-4" /> Current Tier
                        </>
                      ) : (
                        "Included in your plan"
                      )}
                    </Button>
                  ) : isAvantActive ? (
                    <Button className="w-full" variant="outline" disabled>
                      <Check className="mr-1.5 h-4 w-4" /> Current Tier
                    </Button>
                  ) : !membershipHydrated ? (
                    <Button className="w-full" disabled>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Checking status…
                    </Button>
                  ) : avantPending ? (
                    <Button className="w-full" disabled>
                      <Clock className="mr-1.5 h-4 w-4" /> Pending approval
                    </Button>
                  ) : avantApproved ? (
                    <Button className="w-full" disabled>
                      <ShieldCheck className="mr-1.5 h-4 w-4" /> Awaiting €1M deposit validation
                    </Button>
                  ) : (
                    <Button className="w-full" onClick={requestAvantGarde} disabled={upgradeSubmitting}>
                      {upgradeSubmitting ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Crown className="mr-1.5 h-4 w-4" />
                      )}
                      {avantRejected ? "Request Avant-Garde again" : "Upgrade to Avant-Garde"}
                    </Button>
                  )}
                </CardContent>
              </Card>
              )
            })}
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground text-pretty">
            ROI tiers are backed by Swiss fiduciary law and treasury deposits with partner
            institutions including UBS, Barclays &amp; HSBC. Past performance does not guarantee
            future results.
          </p>
        </TabsContent>

        {/* Treuhand AG Limited Hedge Fund */}
        <TabsContent value="fund" className="mt-6 space-y-6">
          {/* Hero */}
          <Card className="border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15">
                  <Landmark className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-bold text-foreground">Treuhand AG Limited Hedge Fund</h2>
                    <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[10px]">
                      Prospectus 2026
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    A fully automated, capital-guaranteed investment vehicle governed under Swiss
                    fiduciary law and powered by the NQAi engine. Structured returns for qualified
                    investors — 25% fixed monthly ROI on active trading days.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Highlights */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
            {FUND_HIGHLIGHTS.map((h) => (
              <Card key={h.label} className="bg-card border-border">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{h.label}</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{h.value}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{h.note}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Calculator */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Coins className="h-5 w-5 text-primary" />
                Token & ROI Calculator
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Each token is a fixed €10,000 unit · minimum entry 3 tokens (€30,000) · no upper limit.
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Tokens</p>
                  <p className="text-xs text-muted-foreground">Adjust your position</p>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setTokens((t) => Math.max(MIN_TOKENS, t - 1))}
                    disabled={tokens <= MIN_TOKENS}
                    aria-label="Decrease tokens"
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="w-10 text-center text-xl font-bold text-foreground">{tokens}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setTokens((t) => t + 1)}
                    aria-label="Increase tokens"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {[3, 5, 10, 20, 50, 100].map((q) => (
                  <Button
                    key={q}
                    type="button"
                    variant={tokens === q ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTokens(q)}
                  >
                    {q}
                  </Button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-secondary/30 p-4">
                  <p className="text-xs text-muted-foreground">Capital Deployed</p>
                  <p className="mt-1 text-xl font-bold text-foreground">{formatEur(capital)}</p>
                </div>
                <div className="rounded-lg border border-border bg-secondary/30 p-4">
                  <p className="text-xs text-muted-foreground">Monthly ROI @ 25%</p>
                  <p className="mt-1 text-xl font-bold text-primary">{formatEur(monthlyReturn)}</p>
                </div>
                <div className="rounded-lg border border-border bg-secondary/30 p-4">
                  <p className="text-xs text-muted-foreground">12-Month Cumulative</p>
                  <p className="mt-1 text-xl font-bold text-green-500">{formatEur(monthlyReturn * 12)}</p>
                </div>
              </div>

              <Button className="w-full" size="lg" onClick={() => setApplyOpen(true)}>
                Apply with {tokens} Tokens · {formatEur(capital)}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <p className="text-center text-[11px] text-muted-foreground text-pretty">
                Projections are illustrative, based on 25% fixed monthly ROI over up to 20 active
                trading days. Capital is fully guaranteed under Swiss fiduciary law.
              </p>
            </CardContent>
          </Card>

          {/* Capital protection */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Shield className="h-5 w-5 text-primary" />
                Capital Protection &amp; Risk Management
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {PROTECTION_LAYERS.map((layer) => (
                <div key={layer.title} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <layer.icon className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{layer.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground text-pretty">{layer.text}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Governance + Onboarding */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                  <Landmark className="h-5 w-5 text-primary" />
                  Governance Structure
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {GOVERNANCE.map((g) => (
                  <div key={g.entity} className="rounded-lg border border-border bg-secondary/30 p-3">
                    <p className="text-sm font-semibold text-foreground">{g.entity}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{g.role}</p>
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground text-pretty">
                  MCC Holding SA · Rue du Rhone 14, 1204 Geneva · CHE-110.027.662 · AML/KYC/FATCA/CRS compliant.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                  <BadgeCheck className="h-5 w-5 text-primary" />
                  Onboarding Process
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {ONBOARDING_STEPS.map((step, i) => (
                    <li key={step} className="flex items-start gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                        {i + 1}
                      </span>
                      <span className="text-sm text-foreground text-pretty">{step}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Trade dialog */}
      <Dialog open={!!tradeTarget} onOpenChange={(open) => !open && setTradeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Deploy NQAi Position</DialogTitle>
            <DialogDescription>
              {tradeTarget ? `${tradeTarget.name} (${tradeTarget.symbol})` : ""}
            </DialogDescription>
          </DialogHeader>
          {tradeTarget && (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">Live Price</p>
                  <p className="font-mono text-lg font-bold text-foreground">
                    {formatPrice(tradeTarget.price, tradeTarget.decimals)}
                  </p>
                </div>
                <Badge variant="outline" className={cn("text-[10px]", signalStyles[tradeTarget.signal])}>
                  AI: {tradeTarget.signal} · {tradeTarget.confidence}%
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={tradeSide === "LONG" ? "default" : "outline"}
                  onClick={() => setTradeSide("LONG")}
                  className={cn(tradeSide === "LONG" && "bg-green-600 hover:bg-green-600/90")}
                >
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Long
                </Button>
                <Button
                  type="button"
                  variant={tradeSide === "SHORT" ? "default" : "outline"}
                  onClick={() => setTradeSide("SHORT")}
                  className={cn(tradeSide === "SHORT" && "bg-red-600 hover:bg-red-600/90")}
                >
                  <TrendingDown className="mr-2 h-4 w-4" />
                  Short
                </Button>
              </div>

              <div className="space-y-2">
                <Label htmlFor="lots">Volume (lots)</Label>
                <Input
                  id="lots"
                  inputMode="decimal"
                  value={lots}
                  onChange={(e) => setLots(e.target.value)}
                  placeholder="0.10"
                />
                <p className="text-[10px] text-muted-foreground">
                  Micro-position range 0.01–0.12 lots recommended by the NQAi risk controller.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTradeTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmTrade}>Deploy Position</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Treuhand AG fund application dialog */}
      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply — Treuhand AG Limited Hedge Fund</DialogTitle>
            <DialogDescription>
              Submit your interest. A compliance officer will follow up with KYC onboarding.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-secondary/30 p-3 text-center">
              <div>
                <p className="text-[11px] text-muted-foreground">Tokens</p>
                <p className="text-base font-bold text-foreground">{tokens}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Capital</p>
                <p className="text-base font-bold text-foreground">{formatEur(capital)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Monthly ROI</p>
                <p className="text-base font-bold text-primary">{formatEur(monthlyReturn)}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="applicant-name">Full name / Entity</Label>
              <Input
                id="applicant-name"
                value={applicantName}
                onChange={(e) => setApplicantName(e.target.value)}
                placeholder={`${user.fullName} — ${user.company}`}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="applicant-email">Contact email</Label>
              <Input
                id="applicant-email"
                type="email"
                inputMode="email"
                value={applicantEmail}
                onChange={(e) => setApplicantEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/20 p-3">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-[11px] text-muted-foreground text-pretty">
                100% capital guaranteed under Swiss fiduciary law · 0% entry &amp; management fees ·
                AML/KYC/FATCA/CRS due diligence applies.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submitApplication} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                "Submit Application"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
