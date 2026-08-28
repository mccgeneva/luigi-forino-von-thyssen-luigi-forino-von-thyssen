"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Gauge,
  Shield,
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Layers,
  AlertTriangle,
  Info,
  Lock,
  Banknote,
  Cpu,
  Building2,
  ArrowRight,
  Activity,
  Percent,
  Power,
  PiggyBank,
  Hourglass,
  Loader2,
  X,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import {
  useLeverageRequests,
  accruedInterest,
  LEVERAGE_ACCOUNTS,
  LEVERAGE_RATIOS,
  MAX_LEVERAGE,
  debitInterestRateFor,
  RISK_THRESHOLDS,
  maxLeverageFor,
  leverageRatiosFor,
  type LeverageRequest,
  type LeverageAccountKey,
} from "@/lib/leverage-requests-store"
import { useInstrumentRequests } from "@/lib/instrument-requests-store"
import { useInternalLoans } from "@/lib/internal-loan-store"
import { useMonetizationRequests } from "@/lib/monetization-requests-store"
import { usePPPRequests } from "@/lib/ppp-requests-store"
import { useLedger } from "@/lib/ledger-store"
import { postedLeverageInterest } from "@/lib/leverage-financing"
import { leverageApplicationCharges } from "@/lib/leverage-audit-fee"
import { isLiveRequest } from "@/lib/live-request"
import { Checkbox } from "@/components/ui/checkbox"
import { GuaranteeScoreCard } from "@/components/dashboard/guarantee-score-card"

// Round to 2 dp for money settlement (mirrors the admin switch-off handler).
function round2(n: number) {
  return Math.round(n * 100) / 100
}

const accountIcons: Record<LeverageAccountKey, typeof Building2> = {
  treasury: ShieldCheck,
  master: Building2,
  instruments: Banknote,
  naftahub: Cpu,
}

// The MCC master account is denominated in EUR; USD, GBP and CHF are the
// additional settlement currencies the client can hold and trade in. EUR is
// listed first and used as the default so the leverage screen matches the
// account's base currency instead of defaulting to USD.
const BASE_CURRENCY = "EUR"
const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

const instrumentTypes = [
  "FX / Currencies",
  "Commodities",
  "Indices",
  "Securities / Equities",
  "Precious Metals",
  "Crypto Assets",
]

const statusConfig = {
  pending: {
    label: "Pending Approval",
    icon: Clock,
    color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  },
  approved: {
    label: "Active Line",
    icon: CheckCircle2,
    color: "bg-green-500/10 text-green-500 border-green-500/20",
  },
  rejected: {
    label: "Declined",
    icon: XCircle,
    color: "bg-red-500/10 text-red-500 border-red-500/20",
  },
  switchoff_pending: {
    label: "Switch-Off Pending",
    icon: Hourglass,
    color: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  closed: {
    label: "Closed",
    icon: Power,
    color: "bg-secondary text-muted-foreground border-border",
  },
} satisfies Record<LeverageRequest["status"], { label: string; icon: typeof Clock; color: string }>

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

// Money with cents — used for interest amounts that are small in a live demo.
function formatMoney2(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function daysBetween(fromIso?: string, to: number = Date.now()) {
  if (!fromIso) return 0
  return Math.max(0, (to - new Date(fromIso).getTime()) / (24 * 60 * 60 * 1000))
}

function formatTimestamp(iso?: string) {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("en-GB")
}

// Derive the live risk state of a position from its margin level.
function marginState(level: number) {
  if (!isFinite(level)) {
    return { key: "flat", label: "No Open Position", color: "text-muted-foreground", bar: "bg-muted-foreground" }
  }
  if (level < RISK_THRESHOLDS.stopOut) {
    return { key: "stopout", label: "Stop-Out / Liquidation", color: "text-red-500", bar: "bg-red-500" }
  }
  if (level < RISK_THRESHOLDS.marginCall) {
    return { key: "call", label: "Margin Call", color: "text-red-400", bar: "bg-red-400" }
  }
  if (level < RISK_THRESHOLDS.warning) {
    return { key: "warning", label: "Margin Warning", color: "text-yellow-500", bar: "bg-yellow-500" }
  }
  return { key: "healthy", label: "Healthy", color: "text-green-500", bar: "bg-green-500" }
}

// Interactive margin monitor for an approved leverage line. Lets the client
// model an open position and a simulated market move to see how equity, used
// margin, free margin and margin level react against the platform's
// margin-call (100%) and stop-out (50%) thresholds.
function MarginMonitor({ line }: { line: LeverageRequest }) {
  const [exposurePct, setExposurePct] = useState(40) // % of buying power deployed
  const [marketMove, setMarketMove] = useState(0) // simulated market move in %

  const positionSize = (line.buyingPower * exposurePct) / 100
  const usedMargin = positionSize / line.leverageRatio
  const unrealizedPnL = (positionSize * marketMove) / 100
  const equityNow = line.equity + unrealizedPnL
  const freeMargin = equityNow - usedMargin
  const marginLevel = usedMargin > 0 ? (equityNow / usedMargin) * 100 : Infinity
  const state = marginState(marginLevel)

  // Cap the displayed gauge at 300% so the bar stays readable.
  const gaugePct = isFinite(marginLevel) ? Math.min((marginLevel / 300) * 100, 100) : 100

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Open Position (exposure)</Label>
            <span className="text-sm font-semibold text-foreground">
              {formatMoney(positionSize, line.currency)}
            </span>
          </div>
          <Slider
            value={[exposurePct]}
            onValueChange={(v) => setExposurePct(v[0])}
            min={0}
            max={100}
            step={1}
            aria-label="Position exposure as a percentage of buying power"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {exposurePct}% of {formatMoney(line.buyingPower, line.currency)} buying power
          </p>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Simulated Market Move</Label>
            <span
              className={cn(
                "text-sm font-semibold",
                marketMove > 0 ? "text-green-500" : marketMove < 0 ? "text-red-500" : "text-foreground",
              )}
            >
              {marketMove > 0 ? "+" : ""}
              {marketMove}%
            </span>
          </div>
          <Slider
            value={[marketMove]}
            onValueChange={(v) => setMarketMove(v[0])}
            min={-10}
            max={10}
            step={0.5}
            aria-label="Simulated market move percentage"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Unrealized P&L:{" "}
            <span className={unrealizedPnL >= 0 ? "text-green-500" : "text-red-500"}>
              {unrealizedPnL >= 0 ? "+" : ""}
              {formatMoney(unrealizedPnL, line.currency)}
            </span>
          </p>
        </div>
      </div>

      {/* Margin level gauge */}
      <div className="rounded-lg border border-border bg-secondary/30 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className={cn("h-4 w-4", state.color)} />
            <span className="text-sm font-medium text-foreground">Margin Level</span>
          </div>
          <div className="text-right">
            <span className={cn("text-lg font-bold", state.color)}>
              {isFinite(marginLevel) ? `${marginLevel.toFixed(0)}%` : "∞"}
            </span>
            <Badge variant="outline" className={cn("ml-2", statusBadgeForState(state.key))}>
              {state.label}
            </Badge>
          </div>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full transition-all", state.bar)} style={{ width: `${gaugePct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>Stop-Out {RISK_THRESHOLDS.stopOut}%</span>
          <span>Margin Call {RISK_THRESHOLDS.marginCall}%</span>
          <span>Warning {RISK_THRESHOLDS.warning}%</span>
        </div>
      </div>

      {/* Live metrics */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Equity" value={formatMoney(equityNow, line.currency)} />
        <Metric label="Used Margin" value={formatMoney(usedMargin, line.currency)} />
        <Metric
          label="Free Margin"
          value={formatMoney(freeMargin, line.currency)}
          tone={freeMargin < 0 ? "negative" : "default"}
        />
        <Metric label="Buying Power" value={formatMoney(line.buyingPower, line.currency)} />
      </div>

      {state.key === "call" && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Margin call triggered. Deposit additional funds or reduce exposure to restore your margin
            level above {RISK_THRESHOLDS.marginCall}%.
          </span>
        </div>
      )}
      {state.key === "stopout" && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/15 p-3 text-sm text-red-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Stop-out level reached. At {RISK_THRESHOLDS.stopOut}% the desk will automatically liquidate
            open positions to protect your account from a negative balance.
          </span>
        </div>
      )}
    </div>
  )
}

function statusBadgeForState(key: string) {
  switch (key) {
    case "stopout":
      return "bg-red-500/10 text-red-500 border-red-500/20"
    case "call":
      return "bg-red-500/10 text-red-400 border-red-500/20"
    case "warning":
      return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
    case "healthy":
      return "bg-green-500/10 text-green-500 border-green-500/20"
    default:
      return "bg-secondary text-muted-foreground border-border"
  }
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string
  value: string
  tone?: "default" | "negative"
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-sm font-semibold",
          tone === "negative" ? "text-red-500" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}

// Real-money leverage economics for a live line: shows the borrowed funds
// credited to the balance, the running debit interest accrued at the line's
// risk-based rate, and what it would cost to switch the line off today.
function LeverageEconomics({ line, now }: { line: LeverageRequest; now: number }) {
  const accrued = accruedInterest(line, now)
  const days = daysBetween(line.activatedAt, now)
  const payoff = line.borrowedAmount + accrued
  return (
    <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Percent className="h-4 w-4 text-orange-400" />
        Leverage Economics
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          Active {days < 1 ? "<1" : Math.floor(days)} day{Math.floor(days) === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Borrowed Funds" value={formatMoney(line.borrowedAmount, line.currency)} />
        <Metric label="Interest Rate" value={`${(debitInterestRateFor(line.leverageRatio) * 100).toFixed(2)}% / yr`} />
        <Metric
          label="Accrued Interest"
          value={formatMoney2(accrued, line.currency)}
          tone="negative"
        />
        <Metric label="Payoff if Closed Today" value={formatMoney2(payoff, line.currency)} />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Debit interest accrues continuously on the borrowed {formatMoney(line.borrowedAmount, line.currency)}{" "}
        from activation ({formatTimestamp(line.activatedAt)}). When you switch off the line, the Administrator
        settles the accrued interest and repays the borrowed principal from your balance.
      </p>
    </div>
  )
}

export default function LeveragePage() {
  const [activeTab, setActiveTab] = useState("request")
  const [isRequestOpen, setIsRequestOpen] = useState(false)
  const [account, setAccount] = useState<LeverageAccountKey | "">("")
  const [equity, setEquity] = useState("")
  const [currency, setCurrency] = useState(BASE_CURRENCY)
  const [ratio, setRatio] = useState(String(LEVERAGE_RATIOS[1])) // default 1:5
  const [instrumentType, setInstrumentType] = useState("")
  const [pledgedInstrumentId, setPledgedInstrumentId] = useState("")
  const [notes, setNotes] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [checkingMargin, setCheckingMargin] = useState(false)
  const [feeAcknowledged, setFeeAcknowledged] = useState(false)
  // When the (required) Instrument Type is missing at submit/appeal, we scroll
  // to and highlight the field — the error banner sits far below it in a long
  // dialog, so otherwise the client is stuck not knowing what to fix.
  const [instrumentTypeError, setInstrumentTypeError] = useState(false)
  const instrumentTypeRef = useRef<HTMLDivElement | null>(null)
  const [switchOffTarget, setSwitchOffTarget] = useState<LeverageRequest | null>(null)
  // The client's real balances (EUR-normalised), loaded from the guarantee
  // position API when the request dialog opens. `freeEur` is FREE EQUITY =
  // available balance − outstanding borrowed/financed funds (the only money that
  // can back a cash-funded line). Shown up-front and used to block Apply so a
  // client can never request more margin than they actually hold.
  const [marginInfo, setMarginInfo] = useState<{ freeEur: number; availableEur: number } | null>(null)
  const [marginLoading, setMarginLoading] = useState(false)
  const log = useActivityLog()
  const { requests, addRequest, unwindLine, requestSwitchOff, withdrawLine, hydrated } = useLeverageRequests()
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const { instruments } = useInstrumentRequests()
  // Cross-product engagement: an instrument pledged to a loan, monetization or
  // PPP program is just as "used" as one backing another leverage line. These
  // stores are mounted globally in the dashboard layout, so reading them here
  // lets the picker ban a re-pledge no matter which facility already holds it.
  const { loans: internalLoans } = useInternalLoans()
  const { requests: monetizationRequests } = useMonetizationRequests()
  const { requests: pppRequests } = usePPPRequests()
  const { addDebit, balanceFor, totalIn, entries: ledgerEntries } = useLedger()

  // Active bank instruments the client can pledge as collateral when funding a
  // leverage line from "Bank Instruments". Only approved/active instruments
  // qualify; pending or rejected ones cannot back a line.
  const activeInstruments = useMemo(
    () => instruments.filter((i) => i.status === "active" && !i.blocked),
    [instruments],
  )
  const selectedInstrument = useMemo(
    () => activeInstruments.find((i) => i.id === pledgedInstrumentId),
    [activeInstruments, pledgedInstrumentId],
  )
  // Instruments currently pledged/committed to ANY live facility — a leverage
  // line, an internal loan (collateral), a monetization, or a PPP/yield program.
  // A bank instrument is single-use collateral, so an id in this set can never be
  // pledged again ("debit on debit" is banned). Mirrors the instruments page's
  // `inUseInstrumentIds` so the two views agree.
  const pledgedInstrumentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of requests) {
      if (
        r.pledgedInstrumentId &&
        (r.status === "approved" || r.status === "switchoff_pending" || r.status === "pending")
      ) {
        ids.add(r.pledgedInstrumentId)
      }
    }
    for (const loan of internalLoans) {
      // Live = pending or funded; released once repaid/settled/closed.
      if (loan.collateralInstrumentId && isLiveRequest(loan)) ids.add(loan.collateralInstrumentId)
    }
    for (const m of monetizationRequests) {
      // A rejected OR reversed monetization no longer engages the instrument.
      if (m.instrumentId && m.status !== "rejected" && m.status !== "reversed") ids.add(m.instrumentId)
    }
    for (const p of pppRequests) {
      // A rejected OR cancelled yield/PPP application releases the instrument.
      if (p.fundingInstrumentId && p.status !== "rejected" && p.status !== "cancelled") {
        ids.add(p.fundingInstrumentId)
      }
    }
    return ids
  }, [requests, internalLoans, monetizationRequests, pppRequests])

  // Live clock so accrued interest ticks up while the page is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Load the client's real free equity whenever the request dialog opens, so the
  // available margin can be shown before anything is entered and the form can
  // block an over-allocation on the spot (the server gate is authoritative).
  useEffect(() => {
    if (!isRequestOpen) return
    let cancelled = false
    setMarginLoading(true)
    ;(async () => {
      try {
        const res = await fetch("/api/guarantees", { credentials: "include", cache: "no-store" })
        const data = res.ok ? await res.json() : null
        const inp = data?.ok ? data.score?.inputs : null
        if (!cancelled) {
          if (inp) {
            const availableEur = Number(inp.availableBalance) || 0
            const totalExposure = Number(inp.totalExposure) || 0
            setMarginInfo({ freeEur: Math.max(0, availableEur - totalExposure), availableEur })
          } else {
            setMarginInfo(null)
          }
        }
      } catch {
        if (!cancelled) setMarginInfo(null)
      } finally {
        if (!cancelled) setMarginLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isRequestOpen])

  const myRequests = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
      ),
    [requests],
  )
  // Anything still awaiting an Administrator decision (activation or switch-off).
  const pendingCount = myRequests.filter(
    (r) => r.status === "pending" || r.status === "switchoff_pending",
  ).length
  // Lines that are currently live (active, or active with a switch-off queued).
  const activeLines = myRequests.filter(
    (r) => r.status === "approved" || r.status === "switchoff_pending",
  )
  // Count of lines that are still live or in-flight. `isLiveRequest` is the shared
  // rule (lib/live-request.ts): it excludes terminal statuses (closed / rejected /
  // cancelled) AND terminal markers, while keeping in-flight states like
  // `switchoff_pending`. A closed deal must not keep counting on the tab badge.
  const liveLineCount = myRequests.filter(isLiveRequest).length
  // Active lines can be in different currencies (USD, EUR, GBP, CHF). We can't
  // add across currencies, so totals are grouped per currency and each stat
  // card lists every currency it holds a balance in.
  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { equity: number; borrowed: number; interest: number }>()
    // Always surface every supported currency (EUR, USD, GBP, CHF), even with no
    // active line in it, so the stats show all four rather than EUR alone.
    for (const cur of SUPPORTED_CURRENCIES) {
      map.set(cur, { equity: 0, borrowed: 0, interest: 0 })
    }
    for (const r of activeLines) {
      const cur = map.get(r.currency) ?? { equity: 0, borrowed: 0, interest: 0 }
      cur.equity += r.equity
      cur.borrowed += r.borrowedAmount
      cur.interest += accruedInterest(r, now)
      map.set(r.currency, cur)
    }
    // Keep a stable, readable order for the supported currencies.
    const order = SUPPORTED_CURRENCIES
    return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  }, [activeLines, now])

  // Live exposure broken down by funding category, so the client can see how
  // their leveraged buying power and borrowed funds are distributed across
  // Treasury, Master Banking, Bank Instruments and NAFTAhub. Currencies are
  // summed into a single representative figure per category for the headline
  // (each line keeps its own currency in the detailed list below).
  const exposureByCategory = useMemo(() => {
    return LEVERAGE_ACCOUNTS.map((opt) => {
      const lines = activeLines.filter((r) => r.account === opt.key)
      const buyingPower = lines.reduce((s, r) => s + r.buyingPower, 0)
      const borrowed = lines.reduce((s, r) => s + r.borrowedAmount, 0)
      const equityBase = lines.reduce((s, r) => s + r.equity, 0)
      // Blended ratio across the category's lines (buying power / equity).
      const blendedRatio = equityBase > 0 ? buyingPower / equityBase : 0
      // How much of the category ceiling the blended ratio consumes.
      const utilisation = Math.min(100, (blendedRatio / opt.maxLeverage) * 100)
      const currency = lines[0]?.currency ?? BASE_CURRENCY
      return {
        ...opt,
        count: lines.length,
        buyingPower,
        borrowed,
        equityBase,
        blendedRatio,
        utilisation,
        currency,
      }
    })
  }, [activeLines])

  // If the client already has requests, land on "My Trading Lines" so approval
  // decisions are visible immediately on arrival.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || autoSelectedRef.current) return
    autoSelectedRef.current = true
    if (myRequests.length > 0) setActiveTab("lines")
  }, [hydrated, myRequests.length])

  const numericEquity = Number(equity.replace(/[^0-9.]/g, "")) || 0
  const numericRatio = Number(ratio) || LEVERAGE_RATIOS[0]
  // Leverage ceiling for the selected funding category (Treasury caps at 1:10,
  // the others at 1:30). Until an account is chosen, expose the full ladder.
  const selectedMax = account ? maxLeverageFor(account) : MAX_LEVERAGE
  const availableRatios = account ? leverageRatiosFor(account) : LEVERAGE_RATIOS
  const projectedBuyingPower = numericEquity * numericRatio
  const projectedBorrowed = numericEquity * (numericRatio - 1)
  // Risk-based rate for the chosen ratio (higher leverage → lower rate).
  const projectedAnnualRate = debitInterestRateFor(numericRatio)
  const projectedAnnualInterest = projectedBorrowed * projectedAnnualRate
  // Upfront charges (audit & compliance fee + PPI premium), charged together to
  // the Master Account on confirmation whether the line is accepted or not.
  const applicationCharges = leverageApplicationCharges(numericEquity, numericRatio)
  const auditFee = applicationCharges.auditFee
  const ppiPremium = applicationCharges.ppi
  const totalUpfrontCharge = applicationCharges.total
  // Same-currency available balance used to gate the upfront charges. When the
  // account cannot cover the full total but CAN cover the (small, non-refundable)
  // audit fee, the client is offered a PPI cost APPEAL instead of a hard refusal:
  // the PPI is reserved as a temporary hold pending admin review of a reduced cost.
  const availableForCharges = totalIn(currency)
  const canAffordCharges = totalUpfrontCharge <= 0 || totalUpfrontCharge <= availableForCharges + 0.01
  const canAffordAuditOnly = auditFee <= availableForCharges + 0.01
  // The appeal is ALWAYS available when the full upfront charges can't be
  // covered — never a dead end. Under an appeal the audit fee is charged if
  // affordable, otherwise reserved as a temporary hold alongside the PPI hold
  // (available balance may go negative), pending administrator review.
  const canAppealPpi = !canAffordCharges && totalUpfrontCharge > 0

  // MARGIN AVAILABILITY (cash-funded lines). The equity a client pledges must be
  // money they actually hold. For an EUR line the cap is FREE EQUITY (available
  // balance − outstanding borrowed/financed funds); for a non-EUR line it's the
  // same-currency spendable balance. Instrument-funded lines are collateralised
  // by the pledged instrument, so they are not gated here.
  const isCashFunded = account === "treasury" || account === "master" || account === "naftahub"
  const marginAvailable: number | null = !isCashFunded
    ? null
    : currency === BASE_CURRENCY
      ? marginInfo?.freeEur ?? null
      : balanceFor(currency)
  // Only block once we actually know the figure — never hard-block on a failed
  // load (the server gate still catches it). Non-EUR uses the always-known
  // same-currency balance; EUR requires the loaded free-equity figure.
  const marginKnown = isCashFunded && (currency !== BASE_CURRENCY || marginInfo !== null)
  const equityExceedsMargin =
    marginKnown && marginAvailable != null && numericEquity > marginAvailable + 0.01

  // When the funding category changes, clamp the chosen ratio to that
  // category's ceiling so an out-of-range value can never be submitted.
  const handleAccountChange = (next: LeverageAccountKey) => {
    setAccount(next)
    const cap = maxLeverageFor(next)
    if (Number(ratio) > cap) {
      const allowed = leverageRatiosFor(next)
      setRatio(String(allowed[allowed.length - 1] ?? cap))
    }
    // Leaving the Bank Instruments funding source clears any pledged collateral.
    if (next !== "instruments") {
      setPledgedInstrumentId("")
    }
  }

  // Pledging an instrument fixes the line's collateral: the equity allocation
  // defaults to the instrument's face value and the currency is locked to the
  // instrument's currency, since the line is backed by that specific asset.
  const handlePledgeInstrument = (id: string) => {
    // Never accept an instrument already pledged to a live facility (leverage,
    // loan, monetization or PPP) — single-use collateral, no re-pledge.
    if (pledgedInstrumentIds.has(id)) {
      setFormError("That bank instrument is already pledged to another live facility and cannot be pledged again.")
      return
    }
    setPledgedInstrumentId(id)
    const inst = activeInstruments.find((i) => i.id === id)
    if (inst) {
      setEquity(String(inst.faceValue))
      setCurrency(inst.currency)
    }
  }

  const resetForm = () => {
    setAccount("")
    setEquity("")
    setCurrency(BASE_CURRENCY)
    setRatio(String(LEVERAGE_RATIOS[1]))
    setInstrumentType("")
    setPledgedInstrumentId("")
    setNotes("")
    setFormError(null)
    setInstrumentTypeError(false)
    setFeeAcknowledged(false)
  }

  const submitRequest = async (opts?: { appeal?: boolean }) => {
    const appeal = opts?.appeal === true
    if (checkingMargin) return
    if (!account) {
      setFormError("Please select a funding account.")
      return
    }
    if (!numericEquity || numericEquity <= 0) {
      setFormError("Please enter a valid equity allocation.")
      return
    }
    if (!instrumentType) {
      setFormError("Please select an instrument type to trade — it's near the top of this form.")
      setInstrumentTypeError(true)
      // Bring the empty field into view and open the picker so the fix is obvious.
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          instrumentTypeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
        })
      }
      return
    }
    // Bank Instruments funding must be backed by a specific active instrument,
    // and the pledged equity can't exceed that instrument's face value.
    if (account === "instruments") {
      if (!selectedInstrument) {
        setFormError("Please select an active bank instrument to pledge as collateral.")
        return
      }
      if (numericEquity > selectedInstrument.faceValue) {
        setFormError(
          `Pledged equity cannot exceed the instrument's face value of ${formatMoney(selectedInstrument.faceValue, selectedInstrument.currency)}.`,
        )
        return
      }
      // DOUBLE-PLEDGE BAN: an instrument already backing a live line cannot
      // secure another (no "debit on debit"). The server re-checks across every
      // facility type; this is the immediate, visible block.
      if (pledgedInstrumentIds.has(selectedInstrument.id)) {
        setFormError(
          "This bank instrument is already pledged to another live leverage line. Close that line first, or pledge a different instrument.",
        )
        return
      }
    }

    const cap = maxLeverageFor(account)
    if (numericRatio > cap) {
      const label = LEVERAGE_ACCOUNTS.find((a) => a.key === account)?.label ?? "this account"
      setFormError(`${label} is limited to a maximum leverage of 1:${cap}.`)
      return
    }

    // UPFRONT CHARGES — the client must acknowledge the non-refundable audit &
    // compliance fee plus the PPI premium, and the Master Account must be able
    // to cover the COMBINED total in the line's currency, else the operation is
    // denied. The server (submitApproval) is authoritative and charges both on
    // confirmation.
    if (totalUpfrontCharge > 0) {
      if (!feeAcknowledged) {
        setFormError(
          `Please confirm you accept the ${formatMoney2(totalUpfrontCharge, currency)} audit, compliance & PPI charges before submitting.`,
        )
        return
      }
      const available = totalIn(currency)
      // PPI APPEAL: no upfront affordability requirement — the audit fee is
      // charged if affordable, otherwise reserved as a temporary hold, and the
      // PPI is always reserved as a hold, so available may go negative pending
      // admin review. Only the NORMAL (non-appeal) submit requires full cover.
      if (!appeal && totalUpfrontCharge > available + 0.01) {
        // Not enough for the full charges — refuse the normal submit and let the
        // fee card surface the "Make Appeal / Negotiate Costs" path instead.
        setFormError(
          `This application carries non-refundable charges of ${formatMoney2(totalUpfrontCharge, currency)} (${formatMoney2(auditFee, currency)} audit & compliance + ${formatMoney2(ppiPremium, currency)} PPI), but your Master Account has only ${formatMoney2(Math.max(0, available), currency)} available.${
            canAppealPpi
              ? " If you cannot fund the full PPI now, use “Make Appeal / Negotiate Costs” to request a reduced PPI from the administrator."
              : " Fund your account and try again."
          }`,
        )
        return
      }
    }

    // MARGIN SOLVENCY pre-check (cash-funded lines only). The client must commit
    // their OWN FREE cash as margin. Free equity = available balance − outstanding
    // borrowed/financed principal (from the guarantee position API), so borrowed
    // proceeds and pledged collateral do NOT count as margin — a 0-balance or
    // loan-funded account is blocked here with a clear message. The authoritative
    // gate also lives on the server (submitApproval). Instrument-funded lines are
    // backed by the pledged instrument and skip this check.
    if (account === "treasury" || account === "master" || account === "naftahub") {
      setCheckingMargin(true)
      try {
        const res = await fetch("/api/guarantees", { credentials: "include", cache: "no-store" })
        const data = res.ok ? await res.json() : null
        const inp = data?.ok ? data.score?.inputs : null
        if (inp) {
          const netFreeEur = Math.max(
            0,
            (Number(inp.availableBalance) || 0) - (Number(inp.totalExposure) || 0),
          )
          const fmtEur = (n: number) =>
            `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          // EUR lines compare directly to free equity; non-EUR lines additionally
          // require same-currency cash to cover the equity.
          const equityInsufficientEur = currency === BASE_CURRENCY && numericEquity > netFreeEur + 0.01
          const cashInsufficient = currency !== BASE_CURRENCY && numericEquity > balanceFor(currency) + 0.01
          if (equityInsufficientEur || cashInsufficient) {
            setFormError(
              currency === BASE_CURRENCY
                ? `Insufficient free equity. This line pledges ${formatMoney(numericEquity, currency)} of margin, but your free equity (available balance less outstanding borrowed/financed funds) is only ${fmtEur(netFreeEur)}. Borrowed funds cannot be used as margin — fund your account with fresh funds, repay financing, or pledge a bank instrument instead.`
                : `Insufficient ${currency} balance to cover the ${formatMoney(numericEquity, currency)} margin for this line. Fund your account before applying.`,
            )
            setCheckingMargin(false)
            return
          }
        }
      } catch {
        // If the position can't be verified, don't hard-block the UI — the
        // server gate remains authoritative and will refuse if truly insolvent.
      }
      setCheckingMargin(false)
    }

    const accountOption = LEVERAGE_ACCOUNTS.find((a) => a.key === account)!
    const pledgedLabel = selectedInstrument
      ? `${selectedInstrument.type} ${selectedInstrument.id} · ${selectedInstrument.issuer}`
      : undefined
    const request = addRequest({
      id: `LEV-REQ-${new Date().getTime().toString().slice(-8)}`,
      account,
      accountLabel: accountOption.label,
      equity: numericEquity,
      currency,
      leverageRatio: numericRatio,
      buyingPower: projectedBuyingPower,
      borrowedAmount: projectedBorrowed,
      interestRate: projectedAnnualRate,
      instrumentType,
      pledgedInstrumentId: account === "instruments" ? selectedInstrument?.id : undefined,
      pledgedInstrumentLabel: account === "instruments" ? pledgedLabel : undefined,
      notes: notes.trim() || undefined,
      // PPI appeal: reserve the PPI as a temporary hold pending admin review.
      ppiAppeal: appeal || undefined,
      appealPpiOriginal: appeal ? ppiPremium : undefined,
    })

    log({
      action: `Submitted a 1:${numericRatio} leverage request on the ${accountOption.label} for Administrator approval`,
      category: "Leverage & Risk",
      details: {
        summary: `Client requested a 1:${numericRatio} leveraged trading line against the ${accountOption.label}, allocating ${formatMoney(numericEquity, currency)} of equity. On approval, ${formatMoney(projectedBorrowed, currency)} of borrowed funds would be credited (buying power ${formatMoney(projectedBuyingPower, currency)}), with debit interest of ${(projectedAnnualRate * 100).toFixed(2)}% per year on the borrowed amount, to trade ${instrumentType}. The line requires Administrator approval before activation.`,
        referenceId: request.id,
        fundingAccount: accountOption.label,
        equityAllocated: formatMoney(numericEquity, currency),
        leverage: `1:${numericRatio}`,
        borrowedFunds: formatMoney(projectedBorrowed, currency),
        buyingPower: formatMoney(projectedBuyingPower, currency),
        debitInterestRate: `${(projectedAnnualRate * 100).toFixed(2)}% per year (risk-based rate for 1:${numericRatio})`,
        instrumentType,
        status: "Pending Administrator Approval",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success(appeal ? "PPI appeal submitted" : "Leverage request submitted", {
      description: appeal
        ? `Your 1:${numericRatio} line is pending Administrator review. The ${formatMoney2(auditFee, currency)} audit fee and ${formatMoney2(ppiPremium, currency)} PPI are charged or temporarily reserved pending a reduced-cost decision — your available balance may show negative until then.`
        : `Your 1:${numericRatio} line on the ${accountOption.label} is pending Administrator approval.`,
    })
    resetForm()
    setIsRequestOpen(false)
    setActiveTab("lines")
  }

  // Settlement quote for the line being unwound: the borrowed principal to
  // repay, the outstanding accrued interest (total accrued minus whatever the
  // monthly reconciler has already charged), the total debit, and the balance
  // impact — including whether it would push the account negative.
  const unwindQuote = useMemo(() => {
    const line = switchOffTarget
    if (!line) return null
    const totalInterest = accruedInterest(line, now)
    const alreadyPosted = postedLeverageInterest(line.id, ledgerEntries)
    const interest = Math.max(0, round2(totalInterest - alreadyPosted))
    const principal = line.borrowedAmount
    const totalDebit = round2(principal + interest)
    const currentBalance = balanceFor(line.currency)
    const resultingBalance = round2(currentBalance - totalDebit)
    // A resulting negative balance means repaying the borrowed principal would
    // overdraw the master account. That can no longer be self-settled by the
    // client — it must be routed to the administrator for approval.
    return {
      principal,
      interest,
      totalDebit,
      currentBalance,
      resultingBalance,
      goesNegative: resultingBalance < -0.01,
    }
  }, [switchOffTarget, now, ledgerEntries, balanceFor])

  // Client-initiated INSTANT unwind: repays the borrowed principal and settles
  // any outstanding accrued interest from the balance right away, then closes
  // the line — restoring the balance to its un-leveraged state without waiting
  // for Administrator approval. The client is warned beforehand if this pushes
  // the balance negative, but may still proceed.
  const confirmUnwind = () => {
    const line = switchOffTarget
    const quote = unwindQuote
    if (!line || !quote) return

    // DEEP-NEGATIVE GUARD: if repaying the borrowed principal would overdraw the
    // master account, the client can NO LONGER settle it themselves. Route the
    // request to the Administrator switch-off queue (no ledger movement here);
    // the admin reviews and settles via "Approve & Settle". This prevents a
    // client from unwinding a line straight into a deep-negative balance.
    if (quote.goesNegative) {
      const requested = requestSwitchOff(line.id)
      if (!requested) {
        toast.error("Could not submit the request", { description: "Please refresh and try again." })
        return
      }
      log({
        action: `Requested Administrator switch-off of leverage line ${line.id} (${line.accountLabel}, 1:${line.leverageRatio})`,
        category: "Leverage & Risk",
        details: {
          summary: `Client requested termination of leverage line ${line.id} on the ${line.accountLabel}. Repaying the borrowed ${formatMoney(quote.principal, line.currency)} plus ${formatMoney2(quote.interest, line.currency)} accrued interest would overdraw the account to ${formatMoney2(quote.resultingBalance, line.currency)}, so the request was sent to the Administrator for approval instead of being settled automatically.`,
          referenceId: line.id,
          fundingAccount: line.accountLabel,
          leverage: `1:${line.leverageRatio}`,
          principalToRepay: formatMoney(quote.principal, line.currency),
          interestToSettle: formatMoney2(quote.interest, line.currency),
          projectedBalance: formatMoney2(quote.resultingBalance, line.currency),
          status: "Awaiting Administrator approval",
        },
      })
      toast.warning("Sent to Administrator for approval", {
        description: `Closing ${line.id} would overdraw your ${line.currency} balance to ${formatMoney2(quote.resultingBalance, line.currency)}. An administrator must review and settle it — nothing was deducted.`,
      })
      setSwitchOffTarget(null)
      return
    }

    const ts = new Date().toISOString()

    const repayRef = `LEV-RP-${Date.now().toString().slice(-8)}`
    const repayEntry = addDebit({
      id: repayRef,
      amount: quote.principal,
      currency: line.currency,
      status: "completed",
      date: ts,
      counterparty: "MCC Leverage Desk",
      reference: line.id,
      category: "Leverage Principal Repaid",
      comment: `Repayment of borrowed funds on client termination of 1:${line.leverageRatio} leverage line ${line.id} (${line.accountLabel}).`,
    })
    let interestRef: string | undefined
    if (quote.interest > 0) {
      interestRef = `LEV-IN-${Date.now().toString().slice(-7)}`
      addDebit({
        id: interestRef,
        amount: quote.interest,
        currency: line.currency,
        status: "completed",
        date: ts,
        counterparty: "MCC Leverage Desk",
        reference: line.id,
        category: "Leverage Debit Interest",
        comment: `Accrued debit interest (${(debitInterestRateFor(line.leverageRatio) * 100).toFixed(2)}% per year) settled on client termination of leverage line ${line.id}.`,
      })
    }

    const closed = unwindLine(line.id, {
      settledInterest: quote.interest,
      repayEntryId: repayEntry.id,
      interestEntryId: interestRef,
    })
    if (!closed) {
      toast.error("Could not terminate the line", { description: "Please refresh and try again." })
      return
    }

    log({
      action: `Terminated leverage line ${line.id} (${line.accountLabel}, 1:${line.leverageRatio})`,
      category: "Leverage & Risk",
      details: {
        summary: `Client terminated leverage line ${line.id} on the ${line.accountLabel}. The borrowed ${formatMoney(quote.principal, line.currency)} was repaid and ${formatMoney2(quote.interest, line.currency)} of accrued debit interest was settled from the balance, removing the 1:${line.leverageRatio} multiplier. Resulting balance: ${formatMoney2(quote.resultingBalance, line.currency)}${quote.goesNegative ? " (negative — overdrawn)." : "."}`,
        referenceId: line.id,
        fundingAccount: line.accountLabel,
        leverage: `1:${line.leverageRatio}`,
        principalRepaid: formatMoney(quote.principal, line.currency),
        interestSettled: formatMoney2(quote.interest, line.currency),
        principalLedgerReference: repayRef,
        interestLedgerReference: interestRef || "(none)",
        resultingBalance: formatMoney2(quote.resultingBalance, line.currency),
        status: "Terminated by client",
      },
    })
    if (quote.goesNegative) {
      toast.warning("Leverage terminated — balance is negative", {
        description: `${line.id} closed. Your ${line.currency} balance is now ${formatMoney2(quote.resultingBalance, line.currency)}. Please fund the account to clear the overdraft.`,
      })
    } else {
      toast.success("Leverage terminated", {
        description: `${line.id} closed. ${formatMoney(quote.principal, line.currency)} principal repaid and ${formatMoney2(quote.interest, line.currency)} interest settled.`,
      })
    }
    setSwitchOffTarget(null)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Leverage & Risk</h1>
          <p className="text-sm text-muted-foreground">
            Request leveraged trading lines and monitor margin in real time
          </p>
        </div>
        <Badge variant="outline" className="w-fit border-primary/20 bg-primary/10 text-primary">
          <Gauge className="mr-1 h-3 w-3" />
          Up to 1:{MAX_LEVERAGE} Leverage
        </Badge>
      </div>

      {/* Independent trust/risk score — reflects guarantees, leverage, exposure & payment history */}
      <GuaranteeScoreCard />

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Allocated Equity"
          value={
            <CurrencyLines
              entries={totalsByCurrency}
              select={(t) => t.equity}
              format={formatMoney}
            />
          }
          hint={`${activeLines.length} active line${activeLines.length === 1 ? "" : "s"}`}
          icon={Banknote}
          tint="bg-primary/10 text-primary"
        />
        <StatCard
          label="Borrowed (Leveraged)"
          value={
            <CurrencyLines
              entries={totalsByCurrency}
              select={(t) => t.borrowed}
              format={formatMoney}
            />
          }
          hint="Credited to your balance"
          icon={PiggyBank}
          tint="bg-green-500/10 text-green-500"
        />
        <StatCard
          label="Accrued Debit Interest"
          value={
            <CurrencyLines
              entries={totalsByCurrency}
              select={(t) => t.interest}
              format={formatMoney2}
            />
          }
          hint={`${(projectedAnnualRate * 100).toFixed(2)}% / yr at 1:${numericRatio} · charged monthly`}
          icon={Percent}
          tint="bg-orange-500/10 text-orange-400"
        />
        <StatCard
          label="Pending Requests"
          value={String(pendingCount)}
          hint="Awaiting Administrator"
          icon={Clock}
          tint="bg-yellow-500/10 text-yellow-500"
        />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="request">Request Leverage</TabsTrigger>
          <TabsTrigger value="lines">
            My Trading Lines
            {liveLineCount > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2",
                  pendingCount > 0
                    ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    : "bg-primary/10 text-primary border-primary/20",
                )}
              >
                {liveLineCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="risk">Risk Disclosures</TabsTrigger>
        </TabsList>

        {/* Request tab */}
        <TabsContent value="request" className="mt-6 space-y-6">
          <Card className="border-primary/20 bg-gradient-to-r from-primary/10 to-primary/5">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold text-foreground">How leverage works at MCC</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Allocate your own equity and choose a ratio up to 1:{MAX_LEVERAGE}. On Administrator
                    approval, the borrowed portion — equity × (ratio − 1) — is credited to your balance, and
                    debit interest begins accruing on those borrowed funds under a risk-based scale where a
                    higher ratio carries a lower rate (14% at 1:2, 10% at 1:5, down to 3% at 1:30). One twelfth
                    of the annual interest is charged to your Master Account each month; the borrowed principal
                    is repaid when you switch the line off.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-3">
            {LEVERAGE_ACCOUNTS.map((acc) => {
              const Icon = accountIcons[acc.key]
              return (
                <Card key={acc.key} className="border-border bg-card">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-primary/10 p-2">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <CardTitle className="text-base">{acc.label}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{acc.description}</p>
                    <p className="mt-3 text-xs font-medium text-primary">
                      Up to 1:{acc.maxLeverage} buying power
                    </p>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <Dialog
            open={isRequestOpen}
            onOpenChange={(open) => {
              setIsRequestOpen(open)
              if (!open) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button size="lg" className="w-full sm:w-auto">
                <Gauge className="mr-2 h-4 w-4" />
                Request a Leverage Line
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Request Leverage Line</DialogTitle>
                <DialogDescription>
                  Submit a leveraged trading line (up to 1:{MAX_LEVERAGE}) for Administrator approval.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Funding Account</Label>
                  <Select value={account} onValueChange={(v) => handleAccountChange(v as LeverageAccountKey)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select funding account" />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVERAGE_ACCOUNTS.map((acc) => (
                        <SelectItem key={acc.key} value={acc.key}>
                          <span className="flex w-full items-center justify-between gap-3">
                            <span>{acc.label}</span>
                            <span className="text-xs text-muted-foreground">max 1:{acc.maxLeverage}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Bank Instruments funding: pledge a specific active instrument
                    as collateral. The equity and currency are taken from it. */}
                {account === "instruments" && (
                  <div className="space-y-2">
                    <Label>Pledged Bank Instrument</Label>
                    {activeInstruments.length === 0 ? (
                      <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-500">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          You have no active bank instruments to pledge. Submit an instrument on the
                          Bank Instruments page and have it approved before leveraging against it.
                        </span>
                      </div>
                    ) : (
                      <>
                        <Select value={pledgedInstrumentId} onValueChange={handlePledgeInstrument}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select an active instrument" />
                          </SelectTrigger>
                          <SelectContent>
                            {activeInstruments.map((inst) => {
                              const alreadyPledged = pledgedInstrumentIds.has(inst.id)
                              return (
                                <SelectItem key={inst.id} value={inst.id} disabled={alreadyPledged}>
                                  <span className="flex w-full items-center justify-between gap-3">
                                    <span>
                                      {inst.type} · {inst.issuer}
                                      {alreadyPledged && (
                                        <span className="ml-1 text-xs text-muted-foreground">· already pledged</span>
                                      )}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {formatMoney(inst.faceValue, inst.currency)}
                                    </span>
                                  </span>
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                        {selectedInstrument && (
                          <p className="text-xs text-muted-foreground">
                            {selectedInstrument.typeFull} · {selectedInstrument.id} · face value{" "}
                            {formatMoney(selectedInstrument.faceValue, selectedInstrument.currency)} ·
                            collateral currency {selectedInstrument.currency}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Each bank instrument can back only one facility at a time — an instrument already pledged
                          to a live line cannot be pledged again.
                        </p>
                        {selectedInstrument && pledgedInstrumentIds.has(selectedInstrument.id) && (
                          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                              This instrument is already pledged to another live leverage line. Close that line
                              first, or pledge a different instrument.
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label>Equity Allocation</Label>
                      {/* Always show the client's own funds up-front so the
                          equity they can pledge is never a surprise. */}
                      {isCashFunded && (
                        <span className="text-xs text-muted-foreground">
                          {marginLoading && marginInfo === null && currency === BASE_CURRENCY ? (
                            "Available…"
                          ) : marginAvailable != null ? (
                            <>
                              Available:{" "}
                              <span
                                className={`font-semibold ${equityExceedsMargin ? "text-red-400" : "text-foreground"}`}
                              >
                                {formatMoney(marginAvailable, currency)}
                              </span>
                            </>
                          ) : null}
                        </span>
                      )}
                    </div>
                    <Input
                      inputMode="decimal"
                      placeholder="e.g. 250,000"
                      value={equity}
                      onChange={(e) => setEquity(e.target.value)}
                    />
                    {equityExceedsMargin && (
                      <p className="text-xs text-red-400">
                        {currency === BASE_CURRENCY
                          ? "Exceeds your free equity (own funds available, less borrowed). Borrowed funds can't be used as margin."
                          : `Exceeds your available ${currency} balance.`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Currency</Label>
                    <Select
                      value={currency}
                      onValueChange={setCurrency}
                      disabled={!!selectedInstrument}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_CURRENCIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Leverage Ratio</Label>
                    {account ? (
                      <span className="text-xs text-muted-foreground">
                        {LEVERAGE_ACCOUNTS.find((a) => a.key === account)?.label} ceiling: 1:{selectedMax}
                      </span>
                    ) : null}
                  </div>
                  <Select value={ratio} onValueChange={setRatio}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableRatios.map((r) => (
                        <SelectItem key={r} value={String(r)}>
                          1:{r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2" ref={instrumentTypeRef}>
                  <Label>
                    Instrument Type <span className="text-destructive">*</span>
                  </Label>
                  <Select
                    value={instrumentType}
                    onValueChange={(v) => {
                      setInstrumentType(v)
                      setInstrumentTypeError(false)
                      if (formError) setFormError(null)
                    }}
                  >
                    <SelectTrigger
                      className={
                        instrumentTypeError ? "border-destructive ring-2 ring-destructive/40" : undefined
                      }
                    >
                      <SelectValue placeholder="Select asset class" />
                    </SelectTrigger>
                    <SelectContent>
                      {instrumentTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {instrumentTypeError && (
                    <p className="text-xs text-destructive">
                      Required — pick the asset class this line will trade to continue.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Notes (optional)</Label>
                  <Input
                    placeholder="Strategy or additional context"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>

                {/* Buying power preview */}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  {isCashFunded && marginAvailable != null && (
                    <div className="mb-1 flex items-center justify-between border-b border-primary/20 pb-2 text-sm">
                      <span className="text-muted-foreground">
                        {currency === BASE_CURRENCY ? "Your Free Equity (own funds)" : `Available ${currency}`}
                      </span>
                      <span
                        className={`font-medium ${equityExceedsMargin ? "text-red-400" : "text-foreground"}`}
                      >
                        {formatMoney(marginAvailable, currency)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Your Equity</span>
                    <span className="font-medium text-foreground">
                      {formatMoney(numericEquity, currency)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Leverage Ratio</span>
                    <span className="font-medium text-foreground">1:{numericRatio}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Borrowed Funds (credited on approval)</span>
                    <span className="font-medium text-green-500">
                      +{formatMoney(projectedBorrowed, currency)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      Debit Interest ({(projectedAnnualRate * 100).toFixed(2)}% / yr · 1:{numericRatio})
                    </span>
                    <span className="font-medium text-orange-400">
                      {formatMoney2(projectedAnnualInterest, currency)} / yr
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-primary/20 pt-2">
                    <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                      <TrendingUp className="h-4 w-4 text-primary" />
                      Buying Power
                    </span>
                    <span className="text-lg font-bold text-primary">
                      {formatMoney(projectedBuyingPower, currency)}
                    </span>
                  </div>
                </div>

                {/* Upfront charges — audit & compliance fee + PPI, charged immediately on confirmation */}
                <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-orange-400" />
                    <span className="text-sm font-semibold text-foreground">Upfront application charges</span>
                  </div>

                  {/* Itemized, right-aligned breakdown */}
                  <div className="mt-3 space-y-2 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-muted-foreground">Audit &amp; compliance fee</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {formatMoney2(auditFee, currency)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-muted-foreground">PPI insurance premium</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {formatMoney2(ppiPremium, currency)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 border-t border-orange-500/20 pt-2">
                      <span className="font-semibold text-foreground">Total charged now</span>
                      <span className="font-mono text-base font-bold tabular-nums text-orange-400">
                        {formatMoney2(totalUpfrontCharge, currency)}
                      </span>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    Audit fee is 0.001% × 1:{numericRatio} of the {formatMoney(projectedBuyingPower, currency)} buying
                    power (audit, compliance &amp; Treasury-partner verification); PPI is 0.75% of buying power. On
                    submission both are only{" "}
                    <span className="font-medium text-foreground">reserved (held)</span> on your Master Account — not
                    charged. They are debited{" "}
                    <span className="font-medium text-foreground">only if the administrator approves</span> the line. If
                    the application is{" "}
                    <span className="font-medium text-foreground">rejected — or you withdraw it — nothing is charged</span>{" "}
                    and every reserved amount is released in full.
                  </p>

                  <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-orange-500/20 pt-3 text-xs leading-relaxed text-foreground">
                    <Checkbox
                      checked={feeAcknowledged}
                      onCheckedChange={(v) => setFeeAcknowledged(v === true)}
                      className="mt-0.5 shrink-0"
                    />
                    <span>
                      I confirm and take responsibility for the{" "}
                      <span className="font-semibold">{formatMoney2(totalUpfrontCharge, currency)}</span> in audit,
                      compliance &amp; PPI charges — reserved on my Master Account now and debited only if the line is
                      approved (released in full if it is rejected or I withdraw it).
                    </span>
                  </label>

                  {/* Insufficient funds for the PPI → appeal / negotiate path */}
                  {!canAffordCharges && (
                    <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed">
                      <div className="flex items-center gap-2 text-amber-500">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span className="font-semibold">Insufficient funds for the PPI premium</span>
                      </div>
                      <p className="mt-2 text-muted-foreground">
                        Your Master Account has{" "}
                        <span className="font-medium text-foreground">
                          {formatMoney2(Math.max(0, availableForCharges), currency)}
                        </span>{" "}
                        available, which cannot cover the {formatMoney2(totalUpfrontCharge, currency)} in upfront
                        charges. You can{" "}
                        <span className="font-medium text-foreground">appeal to the administrator</span> for a reduced
                        PPI cost.{" "}
                        {canAffordAuditOnly ? (
                          <>
                            The {formatMoney2(auditFee, currency)} audit fee is charged now and the{" "}
                            {formatMoney2(ppiPremium, currency)} PPI premium is{" "}
                            <span className="font-medium text-foreground">temporarily reserved (held)</span>
                          </>
                        ) : (
                          <>
                            Both the {formatMoney2(auditFee, currency)} audit fee and the{" "}
                            {formatMoney2(ppiPremium, currency)} PPI premium are{" "}
                            <span className="font-medium text-foreground">temporarily reserved (held)</span>
                          </>
                        )}{" "}
                        — your available balance may go negative for these amounts — until the administrator approves a
                        reduced cost or declines the appeal.
                      </p>
                    </div>
                  )}
                </div>

                {formError && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {formError}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsRequestOpen(false)}>
                  Cancel
                </Button>
                {canAppealPpi ? (
                  // Can't fund the full PPI but can cover the audit fee → appeal.
                  <Button
                    onClick={() => void submitRequest({ appeal: true })}
                    disabled={checkingMargin || !feeAcknowledged || equityExceedsMargin}
                    className="bg-amber-500 text-amber-950 hover:bg-amber-500/90"
                  >
                    {checkingMargin ? "Checking margin…" : "Make Appeal / Negotiate Costs"}
                    {!checkingMargin && <ArrowRight className="ml-2 h-4 w-4" />}
                  </Button>
                ) : (
                  <Button
                    onClick={() => void submitRequest()}
                    disabled={
                      checkingMargin ||
                      equityExceedsMargin ||
                      (totalUpfrontCharge > 0 && !feeAcknowledged) ||
                      (totalUpfrontCharge > 0 && !canAffordCharges)
                    }
                  >
                    {checkingMargin
                      ? "Checking margin…"
                      : equityExceedsMargin
                        ? "Insufficient equity"
                        : "Submit for Approval"}
                    {!checkingMargin && !equityExceedsMargin && <ArrowRight className="ml-2 h-4 w-4" />}
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Trading lines tab */}
        <TabsContent value="lines" className="mt-6 space-y-4">
          {activeLines.length > 0 ? (
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-primary" />
                  Exposure by Category
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Leveraged buying power and borrowed funds across your funding categories, each
                  measured against its leverage ceiling.
                </p>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                {exposureByCategory
                  .filter((c) => c.count > 0)
                  .map((c) => {
                    const Icon = accountIcons[c.key]
                    return (
                      <div key={c.key} className="rounded-lg border border-border bg-secondary/40 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <div className="rounded-md bg-primary/10 p-1.5">
                              <Icon className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                              <p className="text-sm font-medium">{c.label}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {c.count} line{c.count === 1 ? "" : "s"} · blended 1:
                                {c.blendedRatio.toFixed(1)} of 1:{c.maxLeverage}
                              </p>
                            </div>
                          </div>
                          <Badge variant="outline" className="border-primary/30 text-primary">
                            {c.utilisation.toFixed(0)}%
                          </Badge>
                        </div>
                        <Progress value={c.utilisation} className="mt-3 h-1.5" />
                        <div className="mt-3 flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Buying power</span>
                          <span className="font-medium">{formatMoney(c.buyingPower, c.currency)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Borrowed</span>
                          <span className="font-medium">{formatMoney(c.borrowed, c.currency)}</span>
                        </div>
                      </div>
                    )
                  })}
              </CardContent>
            </Card>
          ) : null}

          {/* Bank instrument collateral — approved/active instruments (any of
              EUR/USD/GBP/CHF) that can back a leverage line. Surfaced here so
              the client can see, per currency, what collateral is available and
              what is already pledged to a line. */}
          {activeInstruments.length > 0 ? (
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Banknote className="h-4 w-4 text-primary" />
                  Bank Instrument Collateral
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Your active bank instruments eligible to fund a leverage line. Pledge one from the
                  Request Leverage tab using its face value as equity.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {activeInstruments.map((inst) => {
                  const pledged = pledgedInstrumentIds.has(inst.id)
                  return (
                    <div
                      key={inst.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {inst.type} · {inst.id}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {inst.issuer} · {inst.typeFull}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-sm font-semibold text-foreground">
                            {formatMoney(inst.faceValue, inst.currency)}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Face value · {inst.currency}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            pledged
                              ? "border-primary/30 text-primary"
                              : "border-green-500/30 text-green-500",
                          )}
                        >
                          {pledged ? "Pledged" : "Available"}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          ) : null}

          {myRequests.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="flex flex-col items-center justify-center gap-3 p-12 text-center">
                <div className="rounded-full bg-secondary p-3">
                  <Layers className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  You have no leverage lines yet. Request one to get started.
                </p>
                <Button variant="outline" onClick={() => setActiveTab("request")}>
                  Request Leverage
                </Button>
              </CardContent>
            </Card>
          ) : (
            myRequests.map((req) => {
              const status = statusConfig[req.status]
              const StatusIcon = status.icon
              const Icon = accountIcons[req.account]
              return (
                <Card key={req.id} className="border-border bg-card">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg bg-primary/10 p-2">
                          <Icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-base">
                            {req.accountLabel} · 1:{req.leverageRatio}
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {req.instrumentType} · Ref {req.id}
                          </p>
                          {req.pledgedInstrumentLabel && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Collateral: {req.pledgedInstrumentLabel}
                            </p>
                          )}
                        </div>
                      </div>
                      <Badge variant="outline" className={status.color}>
                        <StatusIcon className="mr-1 h-3 w-3" />
                        {status.label}
                      </Badge>
                    </div>
                    {req.modifications && req.modifications.length > 0 && (
                      <Badge variant="outline" className="mt-2 w-fit border-primary/30 text-primary">
                        <Activity className="mr-1 h-3 w-3" />
                        Ratio adjusted by Administrator
                      </Badge>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Metric label="Equity" value={formatMoney(req.equity, req.currency)} />
                      <Metric label="Borrowed" value={formatMoney(req.borrowedAmount, req.currency)} />
                      <Metric label="Buying Power" value={formatMoney(req.buyingPower, req.currency)} />
                      <Metric label="Leverage" value={`1:${req.leverageRatio}`} />
                    </div>

                    {(req.status === "approved" || req.status === "switchoff_pending") &&
                      req.modifications &&
                      req.modifications.length > 0 &&
                      (() => {
                        const last = req.modifications![req.modifications!.length - 1]
                        const credited = last.deltaBorrowed >= 0
                        return (
                          <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-foreground">
                            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <span className="text-muted-foreground">
                              Administrator adjusted leverage from 1:{last.fromRatio} to 1:{last.toRatio} on{" "}
                              {new Date(last.appliedAt).toLocaleDateString("en-GB")}.{" "}
                              {credited
                                ? `${formatMoney(last.deltaBorrowed, req.currency)} of additional borrowed funds credited.`
                                : `${formatMoney(Math.abs(last.deltaBorrowed), req.currency)} of borrowed funds repaid.`}
                              {req.modifications!.length > 1
                                ? ` (${req.modifications!.length} adjustments total)`
                                : ""}
                            </span>
                          </div>
                        )
                      })()}

                    {req.status === "pending" && (
                      <div className="space-y-3">
                        <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-500">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            Awaiting Administrator review. Your audit &amp; PPI charges are only{" "}
                            <span className="font-medium">reserved (held)</span> — nothing is debited unless an
                            administrator reviews the line. Withdraw now to release the reservation in full. On
                            activation, {formatMoney(req.borrowedAmount, req.currency)} of borrowed funds is credited to
                            your balance and {(debitInterestRateFor(req.leverageRatio) * 100).toFixed(2)}% annual debit
                            interest begins.
                          </span>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={withdrawingId === req.id}
                          onClick={async () => {
                            setWithdrawingId(req.id)
                            const ok = await withdrawLine(req.id)
                            setWithdrawingId(null)
                            if (ok) {
                              toast.success("Application withdrawn", {
                                description:
                                  "Your pending leverage application was withdrawn and all reserved charges released — nothing was charged.",
                              })
                            } else {
                              toast.error("Could not withdraw", {
                                description: "This application could not be withdrawn. Please try again.",
                              })
                            }
                          }}
                        >
                          {withdrawingId === req.id ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Withdrawing…
                            </>
                          ) : (
                            <>
                              <X className="mr-2 h-4 w-4" />
                              Withdraw application
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    {req.status === "rejected" && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          Request declined{req.decisionNote ? `: ${req.decisionNote}` : "."} Decided{" "}
                          {formatTimestamp(req.decidedAt)}.
                        </span>
                      </div>
                    )}

                    {(req.status === "approved" || req.status === "switchoff_pending") && (
                      <LeverageEconomics line={req} now={now} />
                    )}

                    {req.status === "switchoff_pending" && (
                      <div className="flex items-start gap-2 rounded-lg border border-orange-500/20 bg-orange-500/10 p-3 text-sm text-orange-400">
                        <Hourglass className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          Switch-off requested {formatTimestamp(req.switchOffRequestedAt)}. Awaiting Administrator
                          approval to settle the accrued interest and repay the borrowed funds.
                        </span>
                      </div>
                    )}

                    {req.status === "approved" && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <Activity className="h-4 w-4 text-primary" />
                            Live Margin Monitor
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-400"
                            onClick={() => setSwitchOffTarget(req)}
                          >
                            <Power className="mr-2 h-4 w-4" />
                            Terminate &amp; Unwind
                          </Button>
                        </div>
                        <MarginMonitor line={req} />
                      </div>
                    )}

                    {req.status === "closed" && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                          <Metric
                            label="Interest Settled"
                            value={formatMoney2(req.settledInterest ?? 0, req.currency)}
                            tone="negative"
                          />
                          <Metric
                            label="Principal Repaid"
                            value={formatMoney(req.borrowedAmount, req.currency)}
                          />
                          <Metric label="Closed" value={formatTimestamp(req.closedAt)} />
                        </div>
                        <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">
                          <Power className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>
                            Leverage switched off. The {formatMoney(req.borrowedAmount, req.currency)} of borrowed
                            funds was repaid and {formatMoney2(req.settledInterest ?? 0, req.currency)} of accrued
                            debit interest was settled from your balance. See the Transactions section for the full
                            breakdown.
                          </span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })
          )}
        </TabsContent>

        {/* Risk disclosures tab */}
        <TabsContent value="risk" className="mt-6 space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Shield className="h-5 w-5 text-primary" />
                Risk Management Policy
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <RiskThreshold
                  label="Margin Warning"
                  value={`${RISK_THRESHOLDS.warning}%`}
                  tone="text-yellow-500"
                  desc="First alert to manage exposure."
                />
                <RiskThreshold
                  label="Margin Call"
                  value={`${RISK_THRESHOLDS.marginCall}%`}
                  tone="text-red-400"
                  desc="Add funds or reduce positions."
                />
                <RiskThreshold
                  label="Stop-Out"
                  value={`${RISK_THRESHOLDS.stopOut}%`}
                  tone="text-red-500"
                  desc="Automatic liquidation begins."
                />
              </div>
            </CardContent>
          </Card>

          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="leverage">
              <AccordionTrigger>Leverage up to 1:{MAX_LEVERAGE}</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Leverage lets you control a position larger than your allocated equity. At 1:{MAX_LEVERAGE},
                every {formatMoney(1, BASE_CURRENCY)} of equity controls {formatMoney(MAX_LEVERAGE, BASE_CURRENCY)} of market
                exposure. Leverage amplifies both gains and losses — a small adverse move can represent a large
                percentage of your margin.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="margin-level">
              <AccordionTrigger>Margin level &amp; used margin</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Margin level is calculated as Equity ÷ Used Margin × 100%. Used margin is the portion of your
                equity reserved to keep positions open (position size ÷ leverage). As unrealized losses reduce
                equity, your margin level falls toward the margin-call and stop-out thresholds.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="margin-call">
              <AccordionTrigger>Margin call at {RISK_THRESHOLDS.marginCall}%</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                If your margin level falls to {RISK_THRESHOLDS.marginCall}%, a margin call is issued. You must
                deposit additional funds or close positions to restore your margin level. No new positions can
                be opened while in a margin-call state.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="stop-out">
              <AccordionTrigger>Stop-out &amp; liquidation at {RISK_THRESHOLDS.stopOut}%</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                If the margin level reaches the {RISK_THRESHOLDS.stopOut}% stop-out level, the trading desk
                automatically closes open positions — starting with the largest loss — until the margin level
                is restored. This protects the account from running into a negative balance.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="interest">
              <AccordionTrigger>
                Debit interest — risk-based scale, higher leverage means a lower rate
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                When a line is activated, the borrowed portion — equity × (ratio − 1) — is credited to your
                balance. Debit interest follows a risk-based inverse scale: a higher leverage multiple signals
                lower risk and carries a lower annual rate — 14% at 1:2, 10% at 1:5, 8% at 1:10, 7% at 1:15,
                6% at 1:20, 4% at 1:25 and 3% at 1:30. One twelfth of the annual interest is automatically
                charged to your Master Account each month (you receive a notification with the amount and
                remaining balance), and any remainder is settled when you switch the line off.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="switchoff">
              <AccordionTrigger>Switching off leverage</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                You can request to switch off a line at any time. The request is sent to the Administrator for
                approval. On approval, all accrued debit interest is calculated up to that moment and deducted
                from your balance, and the borrowed principal is repaid — removing the leverage multiplier and
                clearing the interest. Every movement is recorded in the Transactions section.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="approval">
              <AccordionTrigger>Administrator approval required</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Every activation and switch-off is reviewed by the MCC Administrator before it takes effect.
                Customers cannot activate or deactivate leverage on their own. The relationship desk may contact
                you to confirm strategy and suitability.
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <Card className="border-border bg-card">
            <CardContent className="flex items-start gap-3 p-4">
              <Lock className="mt-0.5 h-5 w-5 text-primary" />
              <p className="text-sm text-muted-foreground">
                Trading on leverage carries a high level of risk and may not be suitable for all investors.
                You could sustain losses in excess of your allocated equity. Ensure you fully understand the
                risks and seek independent advice if necessary.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Instant self-service termination */}
      <Dialog open={!!switchOffTarget} onOpenChange={(open) => !open && setSwitchOffTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {switchOffTarget && unwindQuote && (
            <>
              <DialogHeader>
                <DialogTitle>Terminate &amp; Unwind Leverage</DialogTitle>
                <DialogDescription>
                  Close line {switchOffTarget.id} now and restore your balance to its un-leveraged state.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Borrowed funds to repay</span>
                    <span className="font-medium text-foreground">
                      {formatMoney(unwindQuote.principal, switchOffTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted-foreground">Accrued interest to settle</span>
                    <span className="font-medium text-orange-400">
                      {formatMoney2(unwindQuote.interest, switchOffTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="font-medium text-foreground">Total deducted now</span>
                    <span className="font-bold text-foreground">
                      {formatMoney2(unwindQuote.totalDebit, switchOffTarget.currency)}
                    </span>
                  </div>
                </div>

                {/* Balance impact */}
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Current balance</span>
                    <span className="font-medium text-foreground">
                      {formatMoney2(unwindQuote.currentBalance, switchOffTarget.currency)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted-foreground">Balance after unwind</span>
                    <span
                      className={cn(
                        "font-semibold",
                        unwindQuote.goesNegative ? "text-red-500" : "text-green-500",
                      )}
                    >
                      {formatMoney2(unwindQuote.resultingBalance, switchOffTarget.currency)}
                    </span>
                  </div>
                </div>

                {unwindQuote.goesNegative ? (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Repaying this line would overdraw your {switchOffTarget.currency} balance by{" "}
                      <span className="font-semibold">
                        {formatMoney2(Math.abs(unwindQuote.resultingBalance), switchOffTarget.currency)}
                      </span>
                      . You can&apos;t settle this yourself — the request will be sent to the Administrator for
                      review and settlement. Nothing is deducted now.
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    The borrowed principal is repaid and any accrued debit interest is settled from your balance
                    immediately, removing the leverage multiplier. This is instant and does not require
                    Administrator approval.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSwitchOffTarget(null)}>
                  Cancel
                </Button>
                <Button variant="default" onClick={confirmUnwind}>
                  <Power className="mr-2 h-4 w-4" />
                  {unwindQuote.goesNegative ? "Request Administrator Approval" : "Terminate & Unwind"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Renders a per-currency breakdown inside a stat card. With a single currency
// it shows one large figure; with several it stacks each currency compactly so
// USD, EUR, GBP and CHF balances are all visible without being summed together.
function CurrencyLines({
  entries,
  select,
  format,
}: {
  entries: [string, { equity: number; borrowed: number; interest: number }][]
  select: (t: { equity: number; borrowed: number; interest: number }) => number
  format: (value: number, currency: string) => string
}) {
  if (entries.length === 0) {
    return <span className="text-muted-foreground">{format(0, BASE_CURRENCY)}</span>
  }
  if (entries.length === 1) {
    const [cur, totals] = entries[0]
    return <>{format(select(totals), cur)}</>
  }
  return (
    <span className="flex flex-col gap-0.5 text-lg">
      {entries.map(([cur, totals]) => (
        <span key={cur}>{format(select(totals), cur)}</span>
      ))}
    </span>
  )
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tint,
}: {
  label: string
  value: React.ReactNode
  hint: string
  icon: typeof Banknote
  tint: string
  }) {
  return (
    <Card className="border-border bg-card py-0">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className={cn("shrink-0 rounded-lg p-3", tint)}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function RiskThreshold({
  label,
  value,
  tone,
  desc,
}: {
  label: string
  value: string
  tone: string
  desc: string
}) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-4 text-center">
      <p className={cn("text-2xl font-bold", tone)}>{value}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </div>
  )
}
