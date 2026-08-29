"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import {
  FileText,
  Search,
  Filter,
  Download,
  MoreHorizontal,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
  Shield,
  Building2,
  Calendar,
  TrendingUp,
  Layers,
  ArrowRight,
  XCircle,
  Ban,
  Lock,
  Landmark,
  Copy,
  ShieldCheck,
  Banknote,
  Percent,
  Globe,
  Radio,
  Trash2,
  Undo2,
  Sparkles,
  Handshake,
  MessageSquare,
  ArrowUpRight,
  ChevronDown,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Messenger } from "@/components/bankeka/messenger"
import { listConversations, getThread, sendMessage, deleteMessage } from "@/app/actions/bankeka"
import { BANKEKA_ADMIN_ID, BANKEKA_ADMIN_LABEL, BANKEKA_ADMIN_INITIALS } from "@/lib/bankeka-shared"
import { cn } from "@/lib/utils"
import { useActivityLog } from "@/components/activity-tracker"
import { exportToCsv } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { toast } from "sonner"
import { useInstrumentRequests, isMccHeldInstrument, type Instrument } from "@/lib/instrument-requests-store"
import { riskScoreTone } from "@/lib/instrument-audit"
import { useLedger } from "@/lib/ledger-store"
import { removeMyLedgerEntry } from "@/app/actions/ledger"
import { computeMonetizationEquity } from "@/lib/monetization-equity"
import { InstrumentMarketplace } from "@/components/dashboard/instrument-marketplace"
import { IsinTools, type IsinAcquisitionRequest } from "@/components/instruments/isin-tools"
import { EdgarTools } from "@/components/instruments/edgar-tools"
import { buildInstrumentIdentifiers } from "@/lib/instrument-identifiers"
import {
  MARKET_INSTRUMENT_TYPES,
  ACQUISITION_ACTION_LABELS,
  ACQUISITION_FEE_RATES,
  MCC_HOLDING_OWNER,
  isMccOwnedAction,
} from "@/lib/instrument-marketplace"
import { resolveTransferRecipient } from "@/app/actions/transfers"
import { acceptInstrumentUpgrade, declineInstrumentUpgrade, counterInstrumentUpgrade } from "@/app/actions/approvals"
import { INSTRUMENT_UPGRADE_FEE_LABEL, isUpgradeOpen } from "@/lib/instrument-upgrade"
import {
  instrumentManagementFee,
  formatInstrumentFee,
  INSTRUMENT_MANAGEMENT_FEE_LABEL,
} from "@/lib/instrument-fees"
import type { TransferDirectoryEntry } from "@/lib/users"
import { useLeverageRequests } from "@/lib/leverage-requests-store"
import { usePPPRequests } from "@/lib/ppp-requests-store"
import { useInternalLoans } from "@/lib/internal-loan-store"
import { isLiveRequest } from "@/lib/live-request"
import {
  useMonetizationRequests,
  type MonetizationStructure,
} from "@/lib/monetization-requests-store"
import { computeTieredInterest, formatTierBound } from "@/lib/tiered-debit-interest"
import { generateInstrumentCertificate } from "@/lib/certificate-pdf"
import { generateMt760, generateMt799 } from "@/lib/swift-mt"

const MONETIZATION_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "SGD"]

const MONETIZATION_STRUCTURES: {
  value: MonetizationStructure
  label: string
  hint: string
  defaultRate: number
}[] = [
  {
    value: "CreditLine",
    label: "Non-recourse credit line",
    hint: "Loan / credit facility secured against the instrument (no recourse to the holder).",
    defaultRate: 65,
  },
  {
    value: "Discounting",
    label: "Discounting / outright purchase",
    hint: "The monetizer discounts and purchases the instrument for immediate proceeds.",
    defaultRate: 80,
  },
  {
    value: "CollateralTransfer",
    label: "Collateral transfer (MT760)",
    hint: "Instrument is collateral-transferred via SWIFT MT760 for credit enhancement.",
    defaultRate: 50,
  },
]

const BANKING_DETAILS = [
  { label: "Bank", value: "Barclays Bank PLC" },
  { label: "Branch", value: "1 Churchill Place" },
  { label: "Account Number", value: "23385574" },
  { label: "Sort Code", value: "20-00-00" },
  { label: "IBAN", value: "GB02 BARC 2000 0023 3855 74" },
  { label: "SWIFT/BIC", value: "BARCGB22XXX" },
  { label: "City", value: "Leicester, LE87 2BB" },
  { label: "Country", value: "United Kingdom" },
]

const typeColors = {
  SBLC: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  MTN: "bg-green-500/10 text-green-400 border-green-500/20",
  BG: "bg-orange-500/10 text-orange-400 border-orange-500/20",
}

const statusConfig = {
  active: { icon: CheckCircle2, color: "text-green-500", bg: "bg-green-500/10" },
  pending: { icon: Clock, color: "text-yellow-500", bg: "bg-yellow-500/10" },
  rejected: { icon: XCircle, color: "text-red-500", bg: "bg-red-500/10" },
  expired: { icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10" },
  cancelled: { icon: Ban, color: "text-muted-foreground", bg: "bg-muted" },
  transferred: { icon: ArrowRight, color: "text-muted-foreground", bg: "bg-muted" },
}

const formatCurrency = (value: number, currency: string) => {
  const symbols: Record<string, string> = {
    EUR: "€",
    USD: "$",
    GBP: "£",
    CHF: "CHF ",
  }
  // Fall back to the ISO code prefix for currencies without a dedicated symbol
  // (e.g. AED, SGD, HKD, JPY) so values never render "undefined…".
  const symbol = symbols[currency] ?? `${currency} `
  return `${symbol}${value.toLocaleString()}`
}

export default function InstrumentsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterStatus, setFilterStatus] = useState("all")
  // Read-only portfolio: clients can no longer create, cancel, or delete
  // instruments. Bank instruments are issued and managed exclusively by the
  // administrator; the client view only displays them.
  const { instruments, transferInstrument, addInstrument, deleteInstrument, returnInstrument, refresh: refreshInstruments } =
    useInstrumentRequests()
  const { totalIn, balanceFor, addDebit, entries: ledgerEntries, refresh: refreshLedger, hydrated: ledgerHydrated } = useLedger()
  const { addRequest: addMonetizationRequest, requests: monetizationRequests, hydrated: monetizationHydrated } = useMonetizationRequests()
  const { requests: leverageRequests } = useLeverageRequests()
  const { requests: pppRequests } = usePPPRequests()
  const { loans: internalLoans } = useInternalLoans()

  // Delete confirmation target (client-initiated removal of an unused holding).
  const [deleteTarget, setDeleteTarget] = useState<Instrument | null>(null)
  // Return-to-marketplace target (assigned/reserved instrument going back).
  const [returnTarget, setReturnTarget] = useState<Instrument | null>(null)
  // Administrator transformation-upgrade offer the customer can accept/decline.
  const [upgradeTarget, setUpgradeTarget] = useState<Instrument | null>(null)
  const [upgradeBusy, setUpgradeBusy] = useState(false)
  const [upgradeDiscuss, setUpgradeDiscuss] = useState(false)
  const [counterValue, setCounterValue] = useState("")
  const [counterNote, setCounterNote] = useState("")
  const [counterBusy, setCounterBusy] = useState(false)

  // Open the negotiation dialog for an instrument's upgrade offer, resetting the
  // per-offer counter/chat state.
  const openUpgrade = (inst: Instrument) => {
    setUpgradeTarget(inst)
    setUpgradeDiscuss(false)
    setCounterValue("")
    setCounterNote("")
  }
  const closeUpgrade = () => {
    if (upgradeBusy || counterBusy) return
    setUpgradeTarget(null)
    setUpgradeDiscuss(false)
  }

  // Instrument ids that are "in use" by the account and therefore may NOT be
  // deleted: pledged to a leverage line (anything but a rejected/closed line) or
  // referenced by a monetization request (anything but a rejected one). Only a
  // holding that is engaged nowhere can be removed by the client.
  const inUseInstrumentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const req of leverageRequests) {
      if (!req.pledgedInstrumentId) continue
      if (req.status !== "rejected" && req.status !== "closed") ids.add(req.pledgedInstrumentId)
    }
    for (const req of monetizationRequests) {
      if (!req.instrumentId) continue
      // A rejected OR reversed monetization no longer engages the instrument.
      if (req.status !== "rejected" && req.status !== "reversed") ids.add(req.instrumentId)
    }
    for (const req of pppRequests) {
      if (!req.fundingInstrumentId) continue
      // A rejected OR cancelled yield/PPP application releases the funding instrument.
      if (req.status !== "rejected" && req.status !== "cancelled") ids.add(req.fundingInstrumentId)
    }
    for (const loan of internalLoans) {
      if (!loan.collateralInstrumentId) continue
      // A pledged instrument stays locked while the loan is live (pending or
      // funded) and is released once it is repaid/settled.
      if (isLiveRequest(loan)) ids.add(loan.collateralInstrumentId)
    }
    return ids
  }, [leverageRequests, monetizationRequests, pppRequests, internalLoans])

  // Human-readable list of the trading / debit scenarios that currently engage
  // an instrument, so a return can tell the holder exactly what reconciliation
  // to revoke first. Empty = free to return.
  const usageReasons = (inst: Instrument): string[] => {
    const reasons: string[] = []
    if (inst.blocked) {
      reasons.push("an Administrator transformation upgrade — respond to the offer first")
    }
    if (monetizationRequests.some((r) => r.instrumentId === inst.id && r.status !== "rejected" && r.status !== "reversed")) {
      reasons.push("a monetization — reverse it first")
    }
    if (leverageRequests.some((r) => r.pledgedInstrumentId === inst.id && r.status !== "rejected" && r.status !== "closed")) {
      reasons.push("a leverage line — close it first")
    }
    if (pppRequests.some((r) => r.fundingInstrumentId === inst.id && r.status !== "rejected" && r.status !== "cancelled")) {
      reasons.push("a yield / PPP application — cancel it first")
    }
    if (internalLoans.some((l) => l.collateralInstrumentId === inst.id && isLiveRequest(l))) {
      reasons.push("an internal loan — repay it to release the collateral first")
    }
    return reasons
  }

  // A client may delete a holding only when it is not engaged anywhere and has
  // not already been transferred away (a transferred card is a historical echo
  // of an instrument the account no longer controls).
  const canDeleteInstrument = (inst: Instrument) =>
    inst.status !== "transferred" && !inst.blocked && !inUseInstrumentIds.has(inst.id)

  // Instrument ids that already have a LIVE monetization request (pending review
  // or approved). Such an instrument cannot be monetized again — its value is
  // already pledged/advanced against. A rejected request frees the instrument to
  // be monetized afresh. This gates every Monetize entry point below.
  const monetizedInstrumentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const req of monetizationRequests) {
      // A rejected OR reversed monetization releases the instrument — it is no
      // longer pledged, so it may be transferred / re-monetized again.
      if (req.instrumentId && req.status !== "rejected" && req.status !== "reversed") {
        ids.add(req.instrumentId)
      }
    }
    return ids
  }, [monetizationRequests])
  const isMonetized = (inst: Instrument) => monetizedInstrumentIds.has(inst.id)

  // Map each pledged instrument id -> its active leverage line, so a BG that was
  // pledged to an approved leverage facility (e.g. 1:5) surfaces its leveraged
  // value (face value × ratio) directly on the instrument. Only "approved"
  // (live) lines count toward the leveraged figure.
  const leverageByInstrument = useMemo(() => {
    const map = new Map<string, (typeof leverageRequests)[number]>()
    for (const req of leverageRequests) {
      if (req.status !== "approved" || !req.pledgedInstrumentId) continue
      // If several lines reference the same instrument, keep the most recent.
      const existing = map.get(req.pledgedInstrumentId)
      if (!existing || new Date(req.submittedAt) > new Date(existing.submittedAt)) {
        map.set(req.pledgedInstrumentId, req)
      }
    }
    return map
  }, [leverageRequests])

  // View Details + Assign/Transfer/Monetize dialogs
  const [viewTarget, setViewTarget] = useState<Instrument | null>(null)
  const [actionTarget, setActionTarget] = useState<{
    instrument: Instrument
    action: "Assign/Transfer" | "Monetize"
  } | null>(null)
  const [actionDestination, setActionDestination] = useState("")
  // Recipient verification for the transfer flow: the holder must confirm WHO
  // they are sending to before the transfer can be submitted.
  const [recipientStatus, setRecipientStatus] = useState<
    "idle" | "checking" | "found" | "notfound" | "self" | "error"
  >("idle")
  const [recipient, setRecipient] = useState<TransferDirectoryEntry | null>(null)
  const [transferring, setTransferring] = useState(false)

  // Dedicated bank-instrument monetization request (MT760, advance rate, etc.)
  const [monetizeTarget, setMonetizeTarget] = useState<Instrument | null>(null)
  const [monetizeForm, setMonetizeForm] = useState({
    structure: "CreditLine" as MonetizationStructure,
    advanceRate: "65",
    proceedsCurrency: "EUR",
    monetizationPlatform: "",
    receivingBank: "MCC Capital Master Account",
    receivingBankBic: "",
    mt760Ref: "",
    mt799Ref: "",
    pofReference: "",
    bclReference: "",
    notes: "",
  })

  const logActivity = useActivityLog()
  const router = useRouter()
  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress, holderRepresentative } = useHolderIdentity()

  const handleCopyBankingDetails = () => {
    const text = BANKING_DETAILS.map((r) => `${r.label}: ${r.value}`).join("\n")
    navigator.clipboard?.writeText(text)
    toast.success("Banking details copied", {
      description: "Barclays Bank PLC account details copied to your clipboard.",
    })
    logActivity({
      action: "Copied dedicated bank instrument banking details",
      category: "Bank Instruments",
      details: {
        summary:
          "Client copied the dedicated Barclays Bank PLC banking details reserved for bank instrument transactions.",
        bank: "Barclays Bank PLC",
        iban: "GB02 BARC 2000 0023 3855 74",
        swift: "BARCGB22XXX",
      },
    })
  }


  // Acquire an instrument straight from a verified ISIN (ISIN Tools tab). The
  // request rides the same approvals backbone as the Marketplace, so it appears
  // in the portfolio once the Administrator approves it — nothing auto-executes.
  const acquireFromIsin = async (req: IsinAcquisitionRequest) => {
    const actionLabel = ACQUISITION_ACTION_LABELS[req.action]
    // Block entirely when this ISIN is already held or awaiting approval — no
    // duplicate positions / double fees. Rejected / cancelled / expired /
    // transferred instruments do NOT count as held.
    const wanted = req.isin.trim().toUpperCase()
    const existing = instruments.find(
      (i) =>
        (i.isin || "").trim().toUpperCase() === wanted &&
        (i.status === "active" || i.status === "pending"),
    )
    if (existing) {
      toast.error("Already in your portfolio", {
        description: `ISIN ${req.isin} is already ${existing.status === "pending" ? "awaiting Administrator approval" : "held"} in your portfolio (${existing.type} ${existing.id}). You can't acquire the same instrument twice.`,
      })
      return { ok: false }
    }
    // Block when the fee can't be covered by total spendable balance (all
    // currencies, converted). The Administrator approval re-enforces this with FX.
    const spendable = totalIn(req.currency)
    if (req.fee > spendable + 0.01) {
      toast.error("Insufficient balance for the acquisition fee", {
        description: `The ${actionLabel.toLowerCase()} fee is ${formatCurrency(req.fee, req.currency)}, but your spendable balance is only ${formatCurrency(spendable, req.currency)}. Fund your account and try again.`,
      })
      return { ok: false }
    }
    const now = new Date()
    const expiry = new Date(now)
    expiry.setMonth(expiry.getMonth() + req.tenorMonths)
    const daysRemaining = Math.max(
      0,
      Math.round((expiry.getTime() - now.getTime()) / 86_400_000),
    )
    // Enrich with governing rules / serial / BIC from the identifier engine, but
    // keep the client's VERIFIED ISIN (don't regenerate a new one).
    const ids = buildInstrumentIdentifiers(req.issuer, req.type, now)
    const typeMeta = MARKET_INSTRUMENT_TYPES.find((t) => t.code === req.type)

    const created = addInstrument({
      id: `${req.type}-${now.getTime().toString().slice(-6)}`,
      type: req.type,
      typeFull: req.typeFull,
      issuer: req.issuer,
      faceValue: req.faceValue,
      currency: req.currency,
      issuedDate: now.toISOString().split("T")[0],
      expiryDate: expiry.toISOString().split("T")[0],
      daysRemaining,
      rating: "A+",
      purpose: typeMeta?.purpose ?? "Bank instrument",
      assignable: typeMeta?.assignable ?? true,
      monetizable: typeMeta?.monetizable ?? true,
      tradeType: `${actionLabel} acquisition (ISIN lookup)`,
      acquisitionAction: req.action,
      // Assign keeps ownership with MCC HOLDING SA (client is assignee, 75/25
      // benefit split); lease/purchase transfer ownership to the client.
      owner: isMccOwnedAction(req.action) ? MCC_HOLDING_OWNER : undefined,
      ...ids,
      isin: req.isin,
      issuerBic: ids.issuerBic,
    }, { amount: req.fee, actionLabel })

    logActivity({
      action: `Requested ${actionLabel.toLowerCase()} of ${req.type} ${created.id} via ISIN ${req.isin}`,
      category: "Bank Instruments",
      details: {
        summary: `Client looked up ISIN ${req.isin} (${req.listed ? `exchange-listed${req.figi ? ` — Bloomberg ID ${req.figi}` : ""}` : "private / bilateral"}) and requested to ${actionLabel.toLowerCase()} a ${req.typeFull} (${req.type}) from ${req.issuer}, face value ${formatCurrency(req.faceValue, req.currency)}. Indicative ${actionLabel.toLowerCase()} fee ${formatCurrency(req.fee, req.currency)}. Awaiting Administrator approval — nothing executes automatically.`,
        referenceId: created.id,
        isin: req.isin,
        instrumentType: `${req.type} — ${req.typeFull}`,
        faceValue: formatCurrency(req.faceValue, req.currency),
        issuingBank: req.issuer,
        acquisition: `${actionLabel} · fee ${formatCurrency(req.fee, req.currency)}`,
        marketStatus: req.listed ? "Exchange-listed" : "Private / bilateral",
      },
    })

    toast.success(`${actionLabel} request submitted`, {
      description: `${req.type} ${created.id} (ISIN ${req.isin}) is pending Administrator approval. The ${formatCurrency(req.fee, req.currency)} fee is deducted from your balance once approved; nothing is charged if it is declined.`,
    })
    return { ok: true }
  }

  const viewInstrument = (instrument: Instrument) => {
    router.push(`/dashboard/instruments/${encodeURIComponent(instrument.id)}`)
    logActivity({
      action: `Viewed details for ${instrument.type} ${instrument.id}`,
      category: "Bank Instruments",
      details: {
        summary: `Client opened the details for the ${instrument.typeFull} (${instrument.type}) ${instrument.id} with a face value of ${formatCurrency(instrument.faceValue, instrument.currency)}.`,
        referenceId: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatCurrency(instrument.faceValue, instrument.currency),
        issuingBank: instrument.issuer,
        status: instrument.status,
      },
    })
  }

  // Accept the Administrator's transformation offer: the fresh instrument is
  // issued into the portfolio immediately and the old blocked one is retired.
  const acceptUpgrade = async () => {
    const target = upgradeTarget
    if (!target?.approvalId || upgradeBusy) return
    setUpgradeBusy(true)
    try {
      const res = await acceptInstrumentUpgrade(target.approvalId)
      if (!res.ok) {
        toast.error("Could not accept upgrade", { description: res.error })
        return
      }
      toast.success("Upgrade accepted", {
        description: `Your new ${target.upgrade?.newTypeFull} from ${target.upgrade?.newIssuer} is now active in your portfolio.`,
      })
      logActivity({
        action: `Confirmed transformation upgrade for ${target.id}`,
        category: "Bank Instruments",
        details: {
          summary: `Confirmed the deal to transform ${target.id} into a ${target.upgrade?.newCurrency} ${target.upgrade?.newFaceValue.toLocaleString("en-US")} ${target.upgrade?.newTypeFull} from ${target.upgrade?.newIssuer}. Fresh instrument issued; old one retired.`,
          referenceId: target.id,
        },
      })
      setUpgradeTarget(null)
      setUpgradeDiscuss(false)
      void refreshInstruments()
    } finally {
      setUpgradeBusy(false)
    }
  }

  // Decline the offer: the instrument stays active; any charged fee is refunded.
  const declineUpgrade = async () => {
    const target = upgradeTarget
    if (!target?.approvalId || upgradeBusy) return
    setUpgradeBusy(true)
    try {
      const res = await declineInstrumentUpgrade(target.approvalId)
      if (!res.ok) {
        toast.error("Could not decline upgrade", { description: res.error })
        return
      }
      const refundLabel =
        res.refunded && res.refunded > 0
          ? `The ${res.currency} ${res.refunded.toLocaleString("en-US")} fee was refunded. `
          : ""
      toast.success("Offer declined", {
        description: `${refundLabel}Your instrument remains active and available.`,
      })
      logActivity({
        action: `Declined transformation upgrade for ${target.id}`,
        category: "Bank Instruments",
        details: {
          summary: `Declined the transformation offer for ${target.id}. ${refundLabel}Instrument remains active.`,
          referenceId: target.id,
        },
      })
      setUpgradeTarget(null)
      setUpgradeDiscuss(false)
      void refreshInstruments()
    } finally {
      setUpgradeBusy(false)
    }
  }

  // Send a counter-offer for the new instrument's face value during negotiation.
  const submitCounter = async () => {
    const target = upgradeTarget
    if (!target?.approvalId || counterBusy) return
    const value = Number(counterValue.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a valid counter-offer amount")
      return
    }
    setCounterBusy(true)
    try {
      const res = await counterInstrumentUpgrade(target.approvalId, value, counterNote.trim() || undefined)
      if (!res.ok) {
        toast.error("Could not send counter-offer", { description: res.error })
        return
      }
      toast.success("Counter-offer sent", {
        description: `The administrator will review your proposed ${target.upgrade?.newCurrency} ${value.toLocaleString("en-US")} face value.`,
      })
      logActivity({
        action: `Counter-offer on transformation upgrade for ${target.id}`,
        category: "Bank Instruments",
        details: {
          summary: `Proposed a new face value of ${target.upgrade?.newCurrency} ${value.toLocaleString("en-US")} for the transformation of ${target.id}.`,
          referenceId: target.id,
        },
      })
      setCounterValue("")
      setCounterNote("")
      void refreshInstruments()
    } finally {
      setCounterBusy(false)
    }
  }

  const requestInstrumentAction = (
    instrument: Instrument,
    action: "Assign/Transfer" | "Monetize",
  ) => {
    // Guard: an instrument locked in an Administrator transformation/upgrade is
    // blocked on behalf of the customer and cannot be used for anything until the
    // upgrade completes (new instrument issued) or is declined.
    if (instrument.blocked) {
      toast.error("Instrument blocked", {
        description: `${instrument.id} is locked while a transformation upgrade is in progress. Respond to the upgrade offer first.`,
      })
      return
    }
    if (action === "Monetize") {
      // Guard: an instrument with a live (pending or approved) monetization is
      // already pledged and cannot be monetized again until that request is
      // rejected. Prevents double-advancing against the same collateral.
      if (isMonetized(instrument)) {
        toast.error("Already monetized", {
          description: `${instrument.id} already has an active monetization request. It can't be monetized again unless that request is rejected.`,
        })
        return
      }
      const defaultStructure = MONETIZATION_STRUCTURES[0]
      setMonetizeForm({
        structure: defaultStructure.value,
        advanceRate: String(defaultStructure.defaultRate),
        proceedsCurrency: MONETIZATION_CURRENCIES.includes(instrument.currency)
          ? instrument.currency
          : "EUR",
        monetizationPlatform: "",
        receivingBank: "MCC Capital Master Account",
        receivingBankBic: "",
        mt760Ref: "",
        mt799Ref: "",
        pofReference: "",
        bclReference: "",
        notes: "",
      })
      setGeneratedSwift(null)
      setMonetizeTarget(instrument)
      return
    }
    // Guard: an instrument with a live (pending or approved) monetization is
    // pledged as collateral — proceeds have been advanced against it. It cannot
    // be assigned or transferred away, otherwise the client would keep the cash
    // AND hand off the underlying instrument (a double-spend). The pledge must
    // be released (monetization rejected/unwound) before any transfer.
    if (isMonetized(instrument)) {
      toast.error("Instrument is pledged", {
        description: `${instrument.id} has an active monetization and can't be transferred or assigned until that monetization is released.`,
      })
      return
    }
    setActionDestination("")
    setRecipient(null)
    setRecipientStatus("idle")
    setActionTarget({ instrument, action })
  }

  const setMon = <K extends keyof typeof monetizeForm>(
    key: K,
    value: (typeof monetizeForm)[K],
  ) => setMonetizeForm((prev) => ({ ...prev, [key]: value }))

  // Real SWIFT FIN generated from the instrument + monetization details.
  const [generatedSwift, setGeneratedSwift] = useState<{
    mt760: string
    mt799: string
  } | null>(null)

  // Build well-formed MT760 (collateral transfer / SBLC) + MT799 (RWA pre-advice)
  // messages from the live monetization inputs and auto-fill their references.
  const handleGenerateSwift = () => {
    if (!monetizeTarget) return
    const instrument = monetizeTarget
    const platformBic = "BARCGB22" // dedicated bank-instrument account (Barclays)
    const counterpartyBic =
      monetizeForm.receivingBankBic.trim().toUpperCase() || "DEUTDEFF"
    const mt760Reference = `MT760-${instrument.id}`.slice(0, 16)
    const mt799Reference = `MT799-${instrument.id}`.slice(0, 16)
    const today = new Date().toISOString().slice(0, 10)
    const structureLabel =
      MONETIZATION_STRUCTURES.find((s) => s.value === monetizeForm.structure)?.label ??
      monetizeForm.structure

    const mt760 = generateMt760({
      senderBic: platformBic,
      receiverBic: counterpartyBic,
      senderReference: mt760Reference,
      relatedReference: instrument.id.slice(0, 16),
      purpose: monetizeForm.structure === "CollateralTransfer" ? "ICCO" : "ISSU",
      form: instrument.type === "SBLC" ? "STBY" : "DGAR",
      applicableRules: instrument.type === "SBLC" ? "ISPR" : "URDG",
      issueDate: today,
      expiryDate: instrument.expiryDate,
      currency: instrument.currency,
      amount: instrument.faceValue,
      applicant: { nameAndAddress: ["MCC CAPITAL LTD", "LONDON, UNITED KINGDOM"] },
      beneficiary: {
        bic: counterpartyBic,
        nameAndAddress: [monetizeForm.monetizationPlatform.trim() || "MONETIZATION COUNTERPARTY"],
      },
      terms: `COLLATERAL TRANSFER OF ${instrument.type} ${instrument.id} FOR ${structureLabel.toUpperCase()} AT ${monetizeAdvanceRate}PCT LTV. PROCEEDS ${monetizeForm.proceedsCurrency} ${monetizeProceeds.toLocaleString("en-US")} TO ${monetizeForm.receivingBank.toUpperCase()}.`,
    }).raw

    const mt799 = generateMt799({
      senderBic: platformBic,
      receiverBic: counterpartyBic,
      senderReference: mt799Reference,
      relatedReference: mt760Reference,
      narrative: `WE HEREBY CONFIRM ON BEHALF OF MCC CAPITAL THAT WE ARE READY, WILLING AND ABLE TO PROCEED WITH THE MONETIZATION OF ${instrument.typeFull.toUpperCase()} (${instrument.type}) REF ${instrument.id}, FACE VALUE ${instrument.currency} ${instrument.faceValue.toLocaleString("en-US")}, ISSUED BY ${instrument.issuer.toUpperCase()}. STRUCTURE: ${structureLabel.toUpperCase()} AT ${monetizeAdvanceRate}PCT LTV. THIS MESSAGE IS A PRE-ADVICE AND DOES NOT CONSTITUTE A FINANCIAL OBLIGATION.`,
    }).raw

    setGeneratedSwift({ mt760, mt799 })
    setMon("mt760Ref", mt760Reference)
    setMon("mt799Ref", mt799Reference)
    toast.success("SWIFT messages generated", {
      description: `MT760 (${mt760Reference}) and MT799 (${mt799Reference}) drafted and referenced.`,
    })
    logActivity({
      action: `Generated MT760 + MT799 for monetization of ${instrument.type} ${instrument.id}`,
      category: "Bank Instruments",
      details: {
        summary: `Client generated well-formed SWIFT MT760 (collateral transfer) and MT799 (RWA pre-advice) messages for the monetization of ${instrument.typeFull} (${instrument.type}) ${instrument.id}, face value ${formatCurrency(instrument.faceValue, instrument.currency)}. References ${mt760Reference} / ${mt799Reference}.`,
        referenceId: instrument.id,
        mt760: mt760Reference,
        mt799: mt799Reference,
        receivingBankBic: counterpartyBic,
      },
    })
  }

  const monetizeAdvanceRate = Number.parseFloat(monetizeForm.advanceRate)
  // LTV / advance rate is only valid between 1% and 100% inclusive.
  const monetizeLtvValid =
    Number.isFinite(monetizeAdvanceRate) && monetizeAdvanceRate >= 1 && monetizeAdvanceRate <= 100
  // Monetize against the leveraged value when the instrument is pledged to an
  // approved leverage line (e.g. €50M BG at 1:5 -> €250M), otherwise face value.
  const monetizeLeverageLine = monetizeTarget
    ? leverageByInstrument.get(monetizeTarget.id)
    : undefined
  const monetizeBaseValue = monetizeTarget
    ? (monetizeLeverageLine?.buyingPower ?? monetizeTarget.faceValue)
    : 0
  const monetizeProceeds =
    monetizeTarget && Number.isFinite(monetizeAdvanceRate)
      ? Math.round(monetizeBaseValue * (monetizeAdvanceRate / 100))
      : 0
  // Monetization upfront cost, all reserved in the INSTRUMENT'S OWN CURRENCY:
  //   • EQUITY DEPOSIT — scales linearly with LTV (0.75% at 1% LTV → 5% at 100%)
  //   • PPI — Payment Protection Insurance, 1% of the advance, funded from the
  //     same upfront deposit.
  // The client must hold the FULL amount (equity + PPI) before the request is
  // sent; otherwise the operation is refused with an explanation and no request
  // is created. `monetizeReserve` is the TOTAL upfront that gets blocked.
  const monetizeReserveCurrency = monetizeTarget?.currency ?? "EUR"
  const monetizeEquityQuote =
    monetizeTarget && Number.isFinite(monetizeAdvanceRate)
      ? computeMonetizationEquity(monetizeProceeds, monetizeAdvanceRate)
      : { ltvPercent: 0, equityRate: 0, equityDeposit: 0, ppi: 0, totalUpfront: 0 }
  const monetizeEquityRate = monetizeEquityQuote.equityRate
  const monetizeEquityDeposit = monetizeEquityQuote.equityDeposit
  const monetizePpi = monetizeEquityQuote.ppi
  const monetizeReserve = monetizeEquityQuote.totalUpfront
  const monetizeReserveAvailable = monetizeTarget ? balanceFor(monetizeReserveCurrency) : 0
  const monetizeReserveShortfall = Math.max(0, monetizeReserve - monetizeReserveAvailable)
  const canCoverMonetizeReserve =
    monetizeReserve <= 0 || monetizeReserveAvailable + 0.01 >= monetizeReserve

  // Assign / Transfer fee: 0.2% of the instrument's face value, charged UPFRONT
  // and IMMEDIATELY (the transfer moves the instrument on confirmation — there
  // is no Administrator step). Verified against the client's balance in the
  // instrument's own currency before the transfer is allowed to proceed.
  const TRANSFER_FEE_RATE = ACQUISITION_FEE_RATES.assign // 0.2%
  const transferFeeCurrency = actionTarget?.instrument.currency ?? "EUR"
  const transferFee = actionTarget
    ? Math.round(actionTarget.instrument.faceValue * TRANSFER_FEE_RATE)
    : 0
  const transferFeeAvailable = actionTarget ? balanceFor(transferFeeCurrency) : 0
  const transferFeeShortfall = Math.max(0, transferFee - transferFeeAvailable)
  const canCoverTransferFee = transferFee <= 0 || transferFeeAvailable + 0.01 >= transferFee

  const canSubmitMonetization = !!monetizeTarget && monetizeLtvValid && canCoverMonetizeReserve
  // Progressive (tiered) debit-interest pricing on the gross proceeds — the
  // outstanding debit the client will owe. Shown live so the client sees the
  // blended effective rate and per-tranche breakdown before submitting.
  const monetizePricing = computeTieredInterest(monetizeProceeds)

  const confirmMonetization = () => {
    if (!monetizeTarget) return
    if (!canSubmitMonetization) {
      toast.error("Check the advance rate", {
        description: "Enter a loan-to-value / advance rate between 1 and 100 percent.",
      })
      return
    }
    const instrument = monetizeTarget
    // Submit-time re-check: the dialog may have been opened while another tab /
    // device monetized this instrument. The server enforces this authoritatively
    // too, but this gives immediate feedback instead of an optimistic rollback.
    if (monetizedInstrumentIds.has(instrument.id)) {
      toast.error("Instrument already monetized", {
        description: `${instrument.id} already has a live monetization. Reverse it before monetizing again.`,
      })
      return
    }
    // Same-currency solvency gate: 0.75% of the advance must be reservable from
    // the balance in the INSTRUMENT'S currency, or the operation is refused.
    if (!canCoverMonetizeReserve) {
      toast.error("Operation not possible — insufficient equity", {
        description: `Monetizing ${instrument.id} at ${monetizeAdvanceRate}% LTV requires ${formatCurrency(monetizeReserve, monetizeReserveCurrency)} blocked in ${monetizeReserveCurrency} — a ${(monetizeEquityRate * 100).toFixed(2)}% equity deposit (${formatCurrency(monetizeEquityDeposit, monetizeReserveCurrency)}) plus 1% PPI (${formatCurrency(monetizePpi, monetizeReserveCurrency)}). You have ${formatCurrency(monetizeReserveAvailable, monetizeReserveCurrency)} available — short by ${formatCurrency(monetizeReserveShortfall, monetizeReserveCurrency)}. Fund your ${monetizeReserveCurrency} balance and try again.`,
      })
      return
    }
    const structureLabel =
      MONETIZATION_STRUCTURES.find((s) => s.value === monetizeForm.structure)?.label ??
      monetizeForm.structure

    const created = addMonetizationRequest({
      instrumentId: instrument.id,
      instrumentType: instrument.type,
      instrumentTypeFull: instrument.typeFull,
      issuer: instrument.issuer,
      faceValue: instrument.faceValue,
      currency: instrument.currency,
      monetizedValue: monetizeBaseValue,
      leverageRatio: monetizeLeverageLine?.leverageRatio,
      structure: monetizeForm.structure,
      advanceRatePercent: monetizeAdvanceRate,
      grossProceeds: monetizeProceeds,
      proceedsCurrency: monetizeForm.proceedsCurrency,
      monetizationPlatform: monetizeForm.monetizationPlatform.trim(),
      receivingBank: monetizeForm.receivingBank.trim(),
      receivingBankBic: monetizeForm.receivingBankBic.trim().toUpperCase(),
      mt760Ref: monetizeForm.mt760Ref.trim(),
      mt799Ref: monetizeForm.mt799Ref.trim(),
      mt760Raw: generatedSwift?.mt760,
      mt799Raw: generatedSwift?.mt799,
      pofReference: monetizeForm.pofReference.trim(),
      bclReference: monetizeForm.bclReference.trim(),
      notes: monetizeForm.notes.trim(),
    })

    // Block the 0.75% reserve immediately as a server-persisted HOLD in the
    // instrument's currency. It reduces the available balance now, stays blocked
    // while the request is pending/approved (facility collateral), and is
    // released automatically by the reconciler below if it is declined/reversed.
    if (monetizeReserve > 0) {
      addDebit({
        id: `MON-RSV-${created.id}`,
        amount: monetizeReserve,
        currency: monetizeReserveCurrency,
        status: "hold",
        date: new Date().toISOString(),
        counterparty: `Monetization equity + PPI — ${instrument.type} ${instrument.id}`,
        reference: created.id,
        category: "Monetization Reserve",
        comment: `Equity deposit ${(monetizeEquityRate * 100).toFixed(2)}% (${formatCurrency(monetizeEquityDeposit, monetizeReserveCurrency)}) + 1% PPI (${formatCurrency(monetizePpi, monetizeReserveCurrency)}) blocked in ${monetizeReserveCurrency} against monetization of ${instrument.type} ${instrument.id} at ${monetizeAdvanceRate}% LTV. Released automatically if the request is declined or reversed.`,
      })
    }

    toast.success("Monetization request submitted", {
      description: `Request ${created.id} for ${instrument.id} is pending Administrator authorization. ${formatCurrency(monetizeReserve, monetizeReserveCurrency)} is now blocked from your ${monetizeReserveCurrency} balance (equity ${formatCurrency(monetizeEquityDeposit, monetizeReserveCurrency)} + PPI ${formatCurrency(monetizePpi, monetizeReserveCurrency)}). The ${formatCurrency(monetizeProceeds, monetizeForm.proceedsCurrency)} gross proceeds will be credited to your Master Account only once it is approved.`,
    })
    logActivity({
      action: `Requested monetization of ${instrument.type} ${instrument.id} (${formatCurrency(instrument.faceValue, instrument.currency)})`,
      category: "Bank Instruments",
      details: {
        summary: `Client submitted a monetization request ${created.id} for the ${instrument.typeFull} (${instrument.type}) ${instrument.id} issued by ${instrument.issuer}, face value ${formatCurrency(instrument.faceValue, instrument.currency)}. Structure: ${structureLabel} at ${monetizeAdvanceRate}% LTV for gross proceeds of ${formatCurrency(monetizeProceeds, monetizeForm.proceedsCurrency)}. UETR ${created.uetr}.`,
        referenceId: created.id,
        uetr: created.uetr,
        instrumentRef: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatCurrency(instrument.faceValue, instrument.currency),
        structure: structureLabel,
        advanceRate: `${monetizeAdvanceRate}%`,
        grossProceeds: formatCurrency(monetizeProceeds, monetizeForm.proceedsCurrency),
        monetizationPlatform: monetizeForm.monetizationPlatform.trim() || "—",
        mt760: monetizeForm.mt760Ref.trim() || "(pending)",
        decision: "Submitted",
      },
    })

    setMonetizeTarget(null)
  }

  // Release monetization reserve holds once their request is no longer live.
  // The 0.75% reserve stays blocked while a request is PENDING or APPROVED
  // (active facility collateral); when it is rejected or reversed — or the
  // optimistic request was rolled back on a server refusal — the matching
  // `MON-RSV-<id>` hold is deleted so the funds return to available. Guarded on
  // BOTH stores being hydrated so a slow requests-load can never release a
  // legitimately-pending reserve.
  const releasedReservesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!ledgerHydrated || !monetizationHydrated) return
    const activeIds = new Set(
      monetizationRequests
        .filter((r) => r.status === "pending" || r.status === "approved")
        .map((r) => r.id),
    )
    const stale = ledgerEntries.filter(
      (e) =>
        e.status === "hold" &&
        e.direction === "debit" &&
        e.category === "Monetization Reserve" &&
        typeof e.id === "string" &&
        e.id.startsWith("MON-RSV-") &&
        !activeIds.has(e.id.slice("MON-RSV-".length)) &&
        !releasedReservesRef.current.has(e.id),
    )
    if (stale.length === 0) return
    stale.forEach((e) => releasedReservesRef.current.add(e.id))
    void (async () => {
      for (const e of stale) {
        await removeMyLedgerEntry(e.id)
      }
      void refreshLedger()
    })()
  }, [monetizationRequests, ledgerEntries, ledgerHydrated, monetizationHydrated, refreshLedger])

  // Step 1 — verify the recipient email resolves to a real, active account and
  // show the holder exactly WHO they are about to transfer to before confirming.
  const verifyRecipient = async () => {
    const email = actionDestination.trim()
    if (!email) {
      setRecipient(null)
      setRecipientStatus("idle")
      return
    }
    setRecipientStatus("checking")
    setRecipient(null)
    try {
      const res = await resolveTransferRecipient(email)
      if (res.ok && res.recipient) {
        setRecipient(res.recipient)
        setRecipientStatus("found")
      } else {
        setRecipientStatus("notfound")
      }
    } catch {
      setRecipientStatus("error")
    }
  }

  // Step 2 — confirm the transfer. The instrument moves immediately: it leaves
  // this portfolio (shown "Transferred") and becomes active for the recipient.
  const confirmInstrumentAction = async () => {
    if (!actionTarget || !recipient) return
    const { instrument } = actionTarget
    // Defense-in-depth: never let a pledged (monetized) instrument leave the
    // portfolio, even if this dialog was opened before the monetization landed.
    if (isMonetized(instrument)) {
      toast.error("Instrument is pledged", {
        description: `${instrument.id} has an active monetization and can't be transferred until it is released.`,
      })
      setActionTarget(null)
      return
    }
    if (!instrument.approvalId) {
      toast.error("This instrument can't be transferred", {
        description: "It is still syncing. Please refresh and try again.",
      })
      return
    }
    // Upfront 0.2% fee, same-currency solvency gate. The transfer executes
    // immediately, so the client must hold the fee in the instrument's currency
    // BEFORE it moves; otherwise the operation is denied with an explanation.
    if (!canCoverTransferFee) {
      toast.error("Operation not possible — insufficient funds for the transfer fee", {
        description: `Transferring ${instrument.id} carries a 0.2% fee of ${formatCurrency(transferFee, transferFeeCurrency)}, charged upfront in ${transferFeeCurrency}. You have ${formatCurrency(transferFeeAvailable, transferFeeCurrency)} available — short by ${formatCurrency(transferFeeShortfall, transferFeeCurrency)}. Fund your ${transferFeeCurrency} balance and try again.`,
      })
      return
    }
    setTransferring(true)
    const res = await transferInstrument(instrument.approvalId, recipient.email)
    setTransferring(false)
    if (!res.ok) {
      toast.error("Transfer failed", { description: res.error })
      return
    }
    // Charge the 0.2% transfer fee immediately (deterministic id = idempotent).
    if (transferFee > 0) {
      addDebit({
        id: `XFER-FEE-${instrument.approvalId}`,
        amount: transferFee,
        currency: transferFeeCurrency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: `Instrument transfer fee — ${instrument.type} ${instrument.id}`,
        reference: instrument.id,
        category: "Instrument Transfer Fee",
        comment: `0.2% assign/transfer fee on ${formatCurrency(instrument.faceValue, instrument.currency)} face value, charged upfront on transfer of ${instrument.type} ${instrument.id} to ${res.recipientName} (${recipient.email}).`,
      })
    }
    logActivity({
      action: `Transferred ${instrument.type} ${instrument.id} (${formatCurrency(instrument.faceValue, instrument.currency)}) to ${res.recipientName}`,
      category: "Bank Instruments",
      details: {
        summary: `Client transferred the ${instrument.typeFull} (${instrument.type}) ${instrument.id} with a face value of ${formatCurrency(instrument.faceValue, instrument.currency)} to ${res.recipientName} (${recipient.email}). The instrument left this portfolio and is now active for the recipient.`,
        referenceId: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatCurrency(instrument.faceValue, instrument.currency),
        issuingBank: instrument.issuer,
        recipient: `${res.recipientName} — ${recipient.email}`,
        status: "Transferred",
      },
    })
    toast.success("Instrument transferred", {
      description: `${instrument.id} is now in ${res.recipientName}'s portfolio.`,
    })
    setActionTarget(null)
    setActionDestination("")
    setRecipient(null)
    setRecipientStatus("idle")
  }

  const downloadCertificate = (instrument: Instrument) => {
    show(generateInstrumentCertificate({
      id: instrument.id,
      type: instrument.type,
      typeFull: instrument.typeFull,
      issuer: instrument.issuer,
      faceValue: formatCurrency(instrument.faceValue, instrument.currency),
      currency: instrument.currency,
      status: instrument.status,
      rating: instrument.rating,
      purpose: instrument.purpose,
      issuedDate: instrument.issuedDate,
      expiryDate: instrument.expiryDate,
      assignable: instrument.assignable,
      monetizable: instrument.monetizable,
      isin: instrument.isin,
      commonCode: instrument.commonCode,
      cusip: instrument.cusip,
      serialNumber: instrument.serialNumber,
      issuerBic: instrument.issuerBic,
      issuerAddress: instrument.issuerAddress,
      issuerCountry: instrument.issuerCountry,
      placeOfIssue: instrument.placeOfIssue,
      governingLaw: instrument.governingLaw,
      deliveryMethod: instrument.deliveryMethod,
      form: instrument.form,
    }))
    logActivity({
      action: `Downloaded certificate for ${instrument.type} ${instrument.id}`,
      category: "Bank Instruments",
      details: {
        summary: `Client downloaded the PDF certificate for the ${instrument.typeFull} (${instrument.type}) ${instrument.id} with a face value of ${formatCurrency(instrument.faceValue, instrument.currency)}, issued by ${instrument.issuer}.`,
        referenceId: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatCurrency(instrument.faceValue, instrument.currency),
        issuingBank: instrument.issuer,
        format: "PDF",
      },
    })
  }

  // Instruments with an OPEN upgrade offer (negotiating or legacy proposed).
  // These get an unmissable dedicated section at the top of the portfolio.
  const upgradeOffers = useMemo(
    () => instruments.filter((i) => isUpgradeOpen(i.upgrade)),
    [instruments],
  )

  const filteredInstruments = instruments.filter((instrument) => {
    const matchesSearch =
      instrument.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      instrument.issuer.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType = filterType === "all" || instrument.type === filterType
    // Transferred instruments have left this portfolio — the client no longer
    // controls them. Keep them out of the default ("all") view so it reflects
    // only current holdings, but still surface them when explicitly filtered
    // to "Transferred" as a historical record.
    const matchesStatus =
      filterStatus === "all"
        ? instrument.status !== "transferred"
        : instrument.status === filterStatus
    return matchesSearch && matchesType && matchesStatus
  })

  const handleExportPdf = () => {
    if (filteredInstruments.length === 0) {
      toast.info("No instruments to export", { description: "There are no instruments matching the current filters." })
      return
    }
    const doc = generateTablePdf({
      title: "Bank Instruments Register",
      refPrefix: "INS",
      holderName,
      holderCompany,
      holderAddress,
      holderRepresentative,
      meta: [{ label: "Records", value: `${filteredInstruments.length}` }],
      columns: [
        { key: "id", header: "Reference" },
        { key: "type", header: "Type" },
        { key: "issuer", header: "Issuing Bank" },
        { key: "faceValue", header: "Face Value", align: "right" },
        { key: "rating", header: "Rating" },
        { key: "status", header: "Status" },
        { key: "expiryDate", header: "Expiry" },
      ],
      rows: filteredInstruments.map((i) => ({
        ...i,
        faceValue: `${i.currency} ${i.faceValue.toLocaleString()}`,
      })) as unknown as Record<string, unknown>[],
      footNote: "Bank instruments register exported from the MCC Capital platform with the filters active at the time of export.",
    })
    show({ doc, filename: tablePdfFilename("Bank-Instruments"), title: "Bank Instruments Register" })
    logActivity({
      action: `Exported ${filteredInstruments.length} bank instrument${filteredInstruments.length === 1 ? "" : "s"} to PDF`,
      category: "Bank Instruments",
      details: {
        summary: `Client previewed/exported ${filteredInstruments.length} bank instrument record(s) as a professional PDF.`,
        recordCount: `${filteredInstruments.length}`,
        format: "PDF",
      },
    })
  }

  const handleExportCsv = () => {
    const count = exportToCsv(
      "bank-instruments",
      filteredInstruments.map((i) => ({
        ...i,
        faceValue: `${i.currency} ${i.faceValue.toLocaleString()}`,
        assignable: i.assignable ? "Yes" : "No",
        monetizable: i.monetizable ? "Yes" : "No",
      })),
      [
        { key: "id", label: "Reference ID" },
        { key: "type", label: "Type" },
        { key: "typeFull", label: "Instrument" },
        { key: "issuer", label: "Issuing Bank" },
        { key: "faceValue", label: "Face Value" },
        { key: "currency", label: "Currency" },
        { key: "status", label: "Status" },
        { key: "rating", label: "Rating" },
        { key: "purpose", label: "Purpose" },
        { key: "issuedDate", label: "Issued Date" },
        { key: "expiryDate", label: "Expiry Date" },
        { key: "assignable", label: "Assignable" },
        { key: "monetizable", label: "Monetizable" },
      ],
    )
    logActivity({
      action: `Exported ${count} bank instrument${count === 1 ? "" : "s"} to CSV`,
      category: "Bank Instruments",
      details: {
        summary: `Client exported ${count} bank instrument record${count === 1 ? "" : "s"} (current filters applied) to a CSV file.`,
        recordCount: `${count}`,
        format: "CSV",
      },
    })
  }

  const totalFaceValue = instruments.reduce((sum, i) => sum + i.faceValue, 0)
  const activeCount = instruments.filter((i) => i.status === "active").length
  const pendingItems = instruments.filter((i) => i.status === "pending")
  const pendingValue = pendingItems.reduce((sum, i) => sum + i.faceValue, 0)
  const primaryCurrency = instruments[0]?.currency ?? "EUR"

  // Total leveraged facility: for each instrument with an approved leverage line,
  // count its leveraged value (buyingPower = face × ratio); otherwise the face
  // value. This is what the client's instruments are actually worth as trading
  // collateral once leverage is applied (e.g. €50M BG at 1:5 -> €250M).
  const leveragedInstruments = instruments.filter((i) => leverageByInstrument.has(i.id))
  const totalLeveragedValue = instruments.reduce((sum, i) => {
    const line = leverageByInstrument.get(i.id)
    return sum + (line ? line.buyingPower : i.faceValue)
  }, 0)
  const hasLeverage = leveragedInstruments.length > 0

  const stats = [
    {
      title: "Total Face Value",
      value: formatCurrency(totalFaceValue, primaryCurrency),
      subtext: "Across all instruments",
      icon: FileText,
      color: "text-primary",
    },
    hasLeverage
      ? {
          title: "Leveraged Facility",
          value: formatCurrency(totalLeveragedValue, primaryCurrency),
          subtext: `${leveragedInstruments.length} leveraged instrument${leveragedInstruments.length === 1 ? "" : "s"}`,
          icon: Layers,
          color: "text-primary",
        }
      : {
          title: "Active Instruments",
          value: `${activeCount}`,
          subtext: "Ready for trading",
          icon: CheckCircle2,
          color: "text-green-400",
        },
    {
      title: "Pending Issuance",
      value: `${pendingItems.length}`,
      subtext: formatCurrency(pendingValue, primaryCurrency),
      icon: Clock,
      color: "text-yellow-400",
    },
    {
      title: "Total Requests",
      value: `${instruments.length}`,
      subtext: "SBLC, MTN & BG",
      icon: TrendingUp,
      color: "text-blue-400",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Bank Instruments
          </h1>
          <p className="text-sm text-muted-foreground">
            Trade SBLC, MTN, and Bank Guarantees
          </p>
        </div>
        <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportPdf}>
                  <FileText className="mr-2 h-4 w-4" />
                  Export as PDF
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportCsv}>
                  <Download className="mr-2 h-4 w-4" />
                  Export as CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
        </div>
      </div>

      <Tabs defaultValue="portfolio" className="space-y-6">
        <TabsList>
          <TabsTrigger value="portfolio">My Portfolio</TabsTrigger>
          <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            <TabsTrigger value="isin-tools">ISIN Tools</TabsTrigger>
            <TabsTrigger value="edgar">SEC / EDGAR</TabsTrigger>
          </TabsList>

        <TabsContent value="portfolio" className="space-y-6">
      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{stat.title}</p>
                  <p className="text-2xl font-bold text-foreground mt-1">
                    {stat.value}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {stat.subtext}
                  </p>
                </div>
                <div className="rounded-lg bg-secondary p-3">
                  <stat.icon className={cn("h-5 w-5", stat.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pricing Info */}
      <Card className="bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold text-foreground">
                Instrument Pricing (AAA+ Rated)
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Competitive rates through our bank partners
              </p>
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Reserve / Assign</p>
                <p className="text-lg font-bold text-primary">0.2%</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Lease</p>
                <p className="text-lg font-bold text-primary">4%</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Purchase</p>
                <p className="text-lg font-bold text-primary">23%</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dedicated Banking Details */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-secondary p-2.5">
                <Landmark className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg font-semibold">
                  Dedicated Banking Details for Bank Instrument Transactions
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground text-pretty">
                  This bank account is exclusively designated for the receipt and processing of
                  funds related to bank instrument trading activities.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={handleCopyBankingDetails}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
            {BANKING_DETAILS.map((row) => (
              <div key={row.label} className="bg-card p-3">
                <p className="text-xs text-muted-foreground">{row.label}</p>
                <p className="mt-0.5 font-medium text-foreground break-words">{row.value}</p>
              </div>
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-xs text-muted-foreground text-pretty">
              This account is strictly reserved for transactions associated with bank instruments
              and related financial operations.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Upgrade offers — unmissable section for any instrument the admin has
          proposed to transform. Open the negotiate/confirm dialog from here. */}
      {upgradeOffers.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Handshake className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-lg font-semibold text-foreground">
                Instrument upgrade {upgradeOffers.length > 1 ? "offers" : "offer"}
              </CardTitle>
              <Badge className="ml-1 bg-amber-500 text-amber-950 hover:bg-amber-500">
                {upgradeOffers.length} to review
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              The administrator has proposed transforming the instrument{upgradeOffers.length > 1 ? "s" : ""} below into a
              fresh one. Discuss the value, send a counter-offer, then confirm to publish it — no fee is charged until
              you confirm.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {upgradeOffers.map((inst) => {
              const u = inst.upgrade!
              return (
                <div
                  key={inst.approvalId ?? inst.id}
                  className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {inst.typeFull}{" "}
                      <span className="text-muted-foreground">
                        ({formatCurrency(inst.faceValue, inst.currency)})
                      </span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span className="text-foreground">
                        {u.newCurrency} {u.newFaceValue.toLocaleString("en-US")} {u.newTypeFull}
                      </span>
                      <span className="text-muted-foreground">by {u.newIssuer}</span>
                    </p>
                    {u.customerCounterFaceValue ? (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                        Your counter-offer: {u.newCurrency} {u.customerCounterFaceValue.toLocaleString("en-US")} — awaiting
                        the administrator.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="shrink-0 bg-amber-500 text-amber-950 hover:bg-amber-500/90"
                    onClick={() => openUpgrade(inst)}
                  >
                    Review &amp; negotiate
                  </Button>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Instruments List */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <CardTitle className="text-lg font-semibold">
              My Instruments
            </CardTitle>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search instruments..."
                  className="pl-9 w-full sm:w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="w-full sm:w-[130px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="SBLC">SBLC</SelectItem>
                  <SelectItem value="MTN">MTN</SelectItem>
                  <SelectItem value="BG">BG</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-full sm:w-[130px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Current Holdings</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="transferred">Transferred Out</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="grid" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="grid">Grid View</TabsTrigger>
              <TabsTrigger value="list">List View</TabsTrigger>
            </TabsList>
            <TabsContent value="grid">
              {filteredInstruments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No instruments yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Start a new trade to add SBLC, MTN, or Bank Guarantees
                  </p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filteredInstruments.map((instrument) => {
                  const status =
                    statusConfig[instrument.status as keyof typeof statusConfig]
                  const StatusIcon = status.icon
                  const progressPercent = Math.min(
                    100,
                    (instrument.daysRemaining / 365) * 100
                  )

                  return (
                    <div
                      key={instrument.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => router.push(`/dashboard/instruments/${encodeURIComponent(instrument.id)}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          router.push(`/dashboard/instruments/${encodeURIComponent(instrument.id)}`)
                        }
                      }}
                      className="cursor-pointer rounded-lg border border-border bg-secondary/30 p-4 transition-colors hover:border-primary/40 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                            <FileText className="h-5 w-5 text-primary" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs font-medium",
                                  typeColors[
                                    instrument.type as keyof typeof typeColors
                                  ]
                                )}
                              >
                                {instrument.type}
                              </Badge>
                              <code className="text-xs text-muted-foreground">
                                {instrument.id}
                              </code>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              {instrument.typeFull}
                            </p>
                            {isMccHeldInstrument(instrument) ? (
                              <span className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                <Lock className="h-2.5 w-2.5" />
                                Owned by {MCC_HOLDING_OWNER} · you keep 25%
                              </span>
                            ) : null}
                            {isUpgradeOpen(instrument.upgrade) ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openUpgrade(instrument)
                                }}
                                className="mt-1.5 flex w-fit items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                              >
                                <Handshake className="h-2.5 w-2.5" />
                                {instrument.upgrade?.customerCounterFaceValue ? "Upgrade offer — counter sent" : "Upgrade offer — negotiate"}
                              </button>
                            ) : instrument.blocked ? (
                              <span className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-muted-foreground/30 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                <Ban className="h-2.5 w-2.5" />
                                Blocked — upgrade in progress
                              </span>
                            ) : null}
                            {instrument.audit ? (
                              <span className="mt-1.5 inline-flex w-fit items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                <ShieldCheck className="h-2.5 w-2.5" />
                                Audited · {instrument.audit.rating}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={() => viewInstrument(instrument)}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            {isUpgradeOpen(instrument.upgrade) && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => openUpgrade(instrument)}
                                  className="text-amber-600 focus:text-amber-600 dark:text-amber-400"
                                >
                                  <Handshake className="mr-2 h-4 w-4" />
                                  Review &amp; negotiate upgrade
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}
                            {instrument.status === "active" &&
                              instrument.assignable &&
                              (isMonetized(instrument) ? (
                                <DropdownMenuItem disabled>
                                  <ArrowRight className="mr-2 h-4 w-4" />
                                  Transfer (pledged)
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={() => requestInstrumentAction(instrument, "Assign/Transfer")}
                                >
                                  <ArrowRight className="mr-2 h-4 w-4" />
                                  Transfer
                                </DropdownMenuItem>
                              ))}
                            {instrument.status === "active" &&
                              instrument.monetizable &&
                              (isMonetized(instrument) ? (
                                <DropdownMenuItem disabled>
                                  <TrendingUp className="mr-2 h-4 w-4" />
                                  Monetized
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={() => requestInstrumentAction(instrument, "Monetize")}
                                >
                                  <TrendingUp className="mr-2 h-4 w-4" />
                                  Monetize
                                </DropdownMenuItem>
                              ))}
                            <DropdownMenuItem onClick={() => downloadCertificate(instrument)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download Certificate
                            </DropdownMenuItem>
                            {isMccHeldInstrument(instrument) && instrument.status === "active" ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => setReturnTarget(instrument)}>
                                  <Undo2 className="mr-2 h-4 w-4" />
                                  Return to marketplace
                                </DropdownMenuItem>
                              </>
                            ) : (
                              canDeleteInstrument(instrument) && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => setDeleteTarget(instrument)}
                                    className="text-destructive focus:text-destructive"
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
                                </>
                              )
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            Face Value
                          </span>
                          <span className="text-lg font-bold text-foreground">
                            {formatCurrency(
                              instrument.faceValue,
                              instrument.currency
                            )}
                          </span>
                        </div>

                        {instrument.upgrade?.status === "proposed" && (
                          <button
                            type="button"
                            onClick={() => setUpgradeTarget(instrument)}
                            className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-left transition-colors hover:bg-amber-500/20"
                          >
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600">
                              <Sparkles className="h-3.5 w-3.5" />
                              Transformation offer — action required
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Blocked while an upgrade to a {instrument.upgrade.newTypeFull} from{" "}
                              {instrument.upgrade.newIssuer} is offered. Tap to review.
                            </p>
                          </button>
                        )}

                        {leverageByInstrument.has(instrument.id) && (
                          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                            <div className="flex items-center justify-between">
                              <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                                <Layers className="h-3.5 w-3.5" />
                                Leveraged 1:{leverageByInstrument.get(instrument.id)!.leverageRatio}
                              </span>
                              <span className="text-lg font-bold text-primary">
                                {formatCurrency(
                                  leverageByInstrument.get(instrument.id)!.buyingPower,
                                  instrument.currency
                                )}
                              </span>
                            </div>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              Total trading facility after leverage
                            </p>
                          </div>
                        )}

                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            Issuer
                          </span>
                          <div className="flex items-center gap-1">
                            <Building2 className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-foreground">
                              {instrument.issuer}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            Rating
                          </span>
                          <Badge
                            variant="outline"
                            className="bg-primary/10 text-primary border-primary/20 text-[10px]"
                          >
                            <Shield className="mr-1 h-3 w-3" />
                            {instrument.rating}
                          </Badge>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            Status
                          </span>
                          <div className="flex items-center gap-1">
                            <StatusIcon className={cn("h-3 w-3", status.color)} />
                            <span
                              className={cn("text-xs capitalize", status.color)}
                            >
                              {instrument.status}
                            </span>
                          </div>
                        </div>

                        <div className="pt-3 border-t border-border">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-muted-foreground">
                              Expires: {instrument.expiryDate}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {instrument.daysRemaining} days
                            </span>
                          </div>
                          <Progress
                            value={progressPercent}
                            className="h-1"
                          />
                        </div>

                        <div className="flex gap-2 pt-2">
                          {instrument.status === "transferred" ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-muted text-muted-foreground border-border"
                            >
                              <ArrowRight className="mr-1 h-3 w-3" />
                              No longer held — transferred out
                            </Badge>
                          ) : (
                            <>
                              {instrument.assignable &&
                                (instrument.status === "active" ? (
                                  isMonetized(instrument) ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-muted text-muted-foreground border-border"
                                    >
                                      <Lock className="mr-1 h-3 w-3" />
                                      Pledged
                                    </Badge>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        requestInstrumentAction(instrument, "Assign/Transfer")
                                      }}
                                      aria-label={`Transfer ${instrument.type} ${instrument.id}`}
                                      className="inline-flex items-center gap-1 rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                    >
                                      <ArrowRight className="h-3 w-3" />
                                      Assign / Transfer
                                    </button>
                                  )
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] bg-blue-500/10 text-blue-400 border-blue-500/20"
                                  >
                                    Assignable
                                  </Badge>
                                ))}
                              {instrument.monetizable &&
                                (instrument.status === "active" ? (
                                  isMonetized(instrument) ? (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] bg-muted text-muted-foreground border-border"
                                    >
                                      <TrendingUp className="mr-1 h-3 w-3" />
                                      Monetized
                                    </Badge>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        requestInstrumentAction(instrument, "Monetize")
                                      }}
                                      aria-label={`Monetize ${instrument.type} ${instrument.id}`}
                                      className="inline-flex items-center gap-1 rounded-md border border-green-500/20 bg-green-500/10 px-2 py-1 text-[10px] font-medium text-green-400 transition-colors hover:bg-green-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40"
                                    >
                                      <TrendingUp className="h-3 w-3" />
                                      Monetize
                                    </button>
                                  )
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] bg-green-500/10 text-green-400 border-green-500/20"
                                  >
                                    Monetizable
                                  </Badge>
                                ))}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              )}
            </TabsContent>
            <TabsContent value="list">
              {filteredInstruments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No instruments yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Start a new trade to add SBLC, MTN, or Bank Guarantees
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                {filteredInstruments.map((instrument) => {
                  const status =
                    statusConfig[instrument.status as keyof typeof statusConfig]
                  const StatusIcon = status.icon

                  return (
                    <div
                      key={instrument.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => router.push(`/dashboard/instruments/${encodeURIComponent(instrument.id)}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          router.push(`/dashboard/instruments/${encodeURIComponent(instrument.id)}`)
                        }
                      }}
                      className="flex cursor-pointer flex-col justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-4 transition-colors hover:border-primary/40 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                          <FileText className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-xs",
                                typeColors[
                                  instrument.type as keyof typeof typeColors
                                ]
                              )}
                            >
                              {instrument.type}
                            </Badge>
                            <span className="font-medium text-foreground">
                              {instrument.id}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {instrument.issuer} • {instrument.purpose}
                          </p>
                          {isMccHeldInstrument(instrument) ? (
                            <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              <Lock className="h-2.5 w-2.5" />
                              Owned by {MCC_HOLDING_OWNER} · you keep 25%
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        {leverageByInstrument.has(instrument.id) && (
                          <div className="text-right">
                            <p className="flex items-center justify-end gap-1 text-lg font-bold text-primary">
                              <Layers className="h-4 w-4" />
                              {formatCurrency(
                                leverageByInstrument.get(instrument.id)!.buyingPower,
                                instrument.currency
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Leveraged 1:{leverageByInstrument.get(instrument.id)!.leverageRatio}
                            </p>
                          </div>
                        )}
                        <div className="text-right">
                          <p className="text-lg font-bold text-foreground">
                            {formatCurrency(
                              instrument.faceValue,
                              instrument.currency
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {leverageByInstrument.has(instrument.id) ? "Face value" : `Expires ${instrument.expiryDate}`}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-xs capitalize",
                            status.color,
                            status.bg
                          )}
                        >
                          <StatusIcon className="mr-1 h-3 w-3" />
                          {instrument.status}
                        </Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={() => viewInstrument(instrument)}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  )
                })}
              </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {monetizationRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Monetization Requests</CardTitle>
            <CardDescription>
              Gross proceeds are credited to your Master Account only after an Administrator approves the
              request. Pending requests do not affect your balance yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[...monetizationRequests]
                .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
                .map((req) => {
                  const tone =
                    req.status === "approved"
                      ? { icon: CheckCircle2, color: "text-green-500", bg: "bg-green-500/10", label: "Approved — credited" }
                      : req.status === "rejected"
                        ? { icon: XCircle, color: "text-red-500", bg: "bg-red-500/10", label: "Rejected" }
                        : req.status === "reversed"
                          ? { icon: Ban, color: "text-muted-foreground", bg: "bg-muted", label: "Reversed — debited back" }
                          : { icon: Clock, color: "text-yellow-500", bg: "bg-yellow-500/10", label: "Pending approval" }
                  const ToneIcon = tone.icon
                  return (
                    <div
                      key={req.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <span className={`mt-0.5 rounded-md p-1.5 ${tone.bg}`}>
                          <ToneIcon className={`h-4 w-4 ${tone.color}`} />
                        </span>
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium text-foreground">
                            {req.instrumentType} {req.instrumentId} · {req.structure}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {req.advanceRatePercent}% advance on{" "}
                            {formatCurrency(req.monetizedValue, req.currency)} · Ref {req.id}
                          </p>
                          {req.status === "rejected" && req.decisionNote && (
                            <p className="text-xs text-red-400">Reason: {req.decisionNote}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
                        <span className="text-sm font-semibold text-foreground">
                          {formatCurrency(req.grossProceeds, req.proceedsCurrency)}
                        </span>
                        <Badge variant="outline" className={`text-[10px] ${tone.color}`}>
                          {tone.label}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
            </div>
          </CardContent>
        </Card>
      )}
        </TabsContent>

        <TabsContent value="marketplace">
          <InstrumentMarketplace />
        </TabsContent>

        <TabsContent value="isin-tools" className="space-y-4">
          <IsinTools
            title="Verify an ISIN &amp; add it to your portfolio"
            description="Paste any bank instrument's ISIN to validate its format and ISO 6166 check digit, retrieve its live Bloomberg market data (issuer, Bloomberg ID, ticker, exchange, type), then trade it and add it to your portfolio for Administrator approval."
            onLog={logActivity}
            onAcquire={acquireFromIsin}
          />

          {/* One-tap verification of the client's own portfolio ISINs */}
          {(() => {
            const withIsin = instruments.filter((i) => i.isin)
            if (withIsin.length === 0) return null
            return (
              <Card className="border-border bg-card">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">Verify your instruments</h3>
                  </div>
                  <p className="text-xs text-muted-foreground text-pretty">
                    Copy any of your portfolio ISINs into the tool above to confirm its identifiers.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {withIsin.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(i.isin!)
                          toast.success("ISIN copied", {
                            description: `${i.type} ${i.id} — ${i.isin}. Paste it into the ISIN tool above to verify.`,
                          })
                        }}
                        className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:bg-muted/50"
                      >
                        <Badge className="font-mono text-[10px]">{i.type}</Badge>
                        <span className="font-mono text-foreground">{i.isin}</span>
                        <Copy className="h-3 w-3 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })()}
        </TabsContent>

        <TabsContent value="edgar" className="space-y-4">
          <EdgarTools
            title="Pull issuer filings from SEC.gov &amp; EDGAR"
            description="Search any SEC-registered issuing bank or corporate by name or ticker to automatically pull its prospectuses, registration statements and filing documents straight from the SEC's official EDGAR systems."
            onLog={logActivity}
            logCategory="Bank Instruments"
          />
        </TabsContent>
      </Tabs>

      {/* View Details dialog */}
      <Dialog open={!!viewTarget} onOpenChange={(open) => !open && setViewTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {viewTarget && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      typeColors[viewTarget.type as keyof typeof typeColors],
                    )}
                  >
                    {viewTarget.type}
                  </Badge>
                  <DialogTitle>{viewTarget.id}</DialogTitle>
                </div>
                <DialogDescription>{viewTarget.typeFull}</DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-center">
                <p className="text-xs text-muted-foreground">Face Value</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatCurrency(viewTarget.faceValue, viewTarget.currency)}
                </p>
                {viewTarget.isin && (
                  <p className="mt-1 font-mono text-xs tracking-wider text-muted-foreground">
                    ISIN {viewTarget.isin}
                  </p>
                )}
              </div>
              {leverageByInstrument.has(viewTarget.id) && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
                  <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-primary">
                    <Layers className="h-3.5 w-3.5" />
                    Leveraged Trading Facility (1:{leverageByInstrument.get(viewTarget.id)!.leverageRatio})
                  </p>
                  <p className="mt-1 text-2xl font-bold text-primary">
                    {formatCurrency(
                      leverageByInstrument.get(viewTarget.id)!.buyingPower,
                      viewTarget.currency
                    )}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {formatCurrency(viewTarget.faceValue, viewTarget.currency)} face value × {leverageByInstrument.get(viewTarget.id)!.leverageRatio} leverage
                  </p>
                </div>
              )}
              {(viewTarget.isin || viewTarget.serialNumber) && (
                <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                  {(
                    [
                      ["ISIN", viewTarget.isin],
                      ["Common Code", viewTarget.commonCode],
                      ["CUSIP", viewTarget.cusip],
                      ["Serial / Reference", viewTarget.serialNumber],
                      ["SWIFT / BIC", viewTarget.issuerBic],
                      ["Governing Rules", viewTarget.governingLaw],
                      ["Delivery", viewTarget.deliveryMethod],
                      ["Form", viewTarget.form],
                    ] as [string, string | undefined][]
                  )
                    .filter(([, value]) => Boolean(value))
                    .map(([label, value]) => (
                      <div key={label} className="bg-card p-3">
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="mt-0.5 font-mono text-sm font-medium text-foreground break-words">{value}</p>
                      </div>
                    ))}
                </div>
              )}
              <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                {(
                  [
                    ["Issuing Bank", viewTarget.issuer],
                    ["Registered Office", viewTarget.issuerAddress],
                    ["Credit Rating", viewTarget.rating],
                    ["Purpose", viewTarget.purpose],
                    ["Status", viewTarget.status.charAt(0).toUpperCase() + viewTarget.status.slice(1)],
                    ["Issued Date", viewTarget.issuedDate],
                    ["Expiry Date", viewTarget.expiryDate],
                    ["Days Remaining", `${viewTarget.daysRemaining} days`],
                    ["Assignable", viewTarget.assignable ? "Yes" : "No"],
                    ["Monetizable", viewTarget.monetizable ? "Yes" : "No"],
                  ] as [string, string | undefined][]
                )
                  .filter(([, value]) => Boolean(value))
                  .map(([label, value]) => (
                    <div key={label} className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</p>
                    </div>
                  ))}
              </div>

              {viewTarget.audit && (
                <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <ShieldCheck className="h-4 w-4 text-primary" />
                      Independent Audit &amp; Valuation
                    </p>
                    <Badge variant="outline" className="text-[10px]">
                      Certified · {viewTarget.audit.rating}
                    </Badge>
                  </div>

                  {/* Realistic value clearly distinguished from face value */}
                  <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">Stated face value</p>
                      <p className="mt-0.5 text-sm font-medium text-muted-foreground line-through decoration-muted-foreground/40">
                        {formatCurrency(viewTarget.audit.faceValue, viewTarget.audit.currency)}
                      </p>
                    </div>
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">Realistic assessed value</p>
                      <p className="mt-0.5 text-sm font-bold text-foreground">
                        {formatCurrency(viewTarget.audit.realisticValue, viewTarget.audit.currency)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {(viewTarget.audit.realisticPct * 100).toFixed(1)}% of stated face
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">Risk score</p>
                      <p
                        className={cn(
                          "mt-0.5 text-sm font-bold",
                          riskScoreTone(viewTarget.audit.riskScore) === "positive"
                            ? "text-green-600 dark:text-green-500"
                            : riskScoreTone(viewTarget.audit.riskScore) === "neutral"
                              ? "text-amber-600 dark:text-amber-500"
                              : "text-red-600 dark:text-red-500",
                        )}
                      >
                        {viewTarget.audit.riskScore}/100
                      </p>
                    </div>
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">Classification rating</p>
                      <p className="mt-0.5 text-sm font-bold text-foreground">{viewTarget.audit.rating}</p>
                    </div>
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">Valid for monetization</p>
                      <p className="mt-0.5 text-sm font-medium text-foreground">
                        {viewTarget.audit.monetizationEligible
                          ? `Up to ${(viewTarget.audit.allowedMonetizationPct * 100).toFixed(0)}% LTV`
                          : "Not eligible"}
                      </p>
                    </div>
                    <div className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">PPI insurance for trade</p>
                      <p className="mt-0.5 text-sm font-medium text-foreground">
                        {viewTarget.audit.ppiRequired ? "Required" : "Not required"}
                      </p>
                    </div>
                  </div>

                  {viewTarget.audit.summary && (
                    <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                      {viewTarget.audit.summary}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Independent assessment · engine {viewTarget.audit.engineVersion}
                    {viewTarget.audit.publishedAt
                      ? ` · published ${new Date(viewTarget.audit.publishedAt).toLocaleDateString()}`
                      : ""}
                    . Assessed value is an independent estimate and may differ from the stated face value.
                  </p>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setViewTarget(null)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    const target = viewTarget
                    setViewTarget(null)
                    downloadCertificate(target)
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download Certificate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Transfer dialog */}
      <Dialog
        open={!!actionTarget}
        onOpenChange={(open) => {
          if (!open) {
            setActionTarget(null)
            setActionDestination("")
            setRecipient(null)
            setRecipientStatus("idle")
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          {actionTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Transfer Instrument</DialogTitle>
                <DialogDescription>
                  {`Transfer ${actionTarget.instrument.id} to another account holder. Enter their registered email — we'll confirm who they are before you send. Once confirmed, the instrument moves to their portfolio immediately.`}
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{actionTarget.instrument.typeFull}</span>
                  <span className="text-sm font-semibold text-foreground">
                    {formatCurrency(actionTarget.instrument.faceValue, actionTarget.instrument.currency)}
                  </span>
                </div>
              </div>

              {/* Upfront 0.2% transfer fee + same-currency solvency status */}
              <div
                className={cn(
                  "rounded-lg border p-3",
                  canCoverTransferFee ? "border-primary/20 bg-primary/5" : "border-destructive/40 bg-destructive/10",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Transfer fee (0.2%, charged upfront)</span>
                  <span className="text-base font-semibold text-foreground">
                    {formatCurrency(transferFee, transferFeeCurrency)}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Available {transferFeeCurrency} balance</span>
                  <span className={cn("font-medium", canCoverTransferFee ? "text-foreground" : "text-destructive")}>
                    {formatCurrency(transferFeeAvailable, transferFeeCurrency)}
                  </span>
                </div>
                {canCoverTransferFee ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <Lock className="mt-px h-3 w-3 shrink-0" />
                    <span>
                      This fee is deducted from your {transferFeeCurrency} balance the moment the transfer is confirmed.
                    </span>
                  </p>
                ) : (
                  <div className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive">
                    <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Operation not possible.</strong> The 0.2% fee of{" "}
                      {formatCurrency(transferFee, transferFeeCurrency)} must be paid upfront in {transferFeeCurrency}, but
                      only {formatCurrency(transferFeeAvailable, transferFeeCurrency)} is available — short by{" "}
                      {formatCurrency(transferFeeShortfall, transferFeeCurrency)}. Fund your {transferFeeCurrency} balance
                      before transferring this instrument.
                    </span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="action-destination">Recipient account email</Label>
                <div className="flex gap-2">
                  <Input
                    id="action-destination"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    value={actionDestination}
                    onChange={(e) => {
                      setActionDestination(e.target.value)
                      // Any edit invalidates a prior verification — force re-check.
                      setRecipient(null)
                      setRecipientStatus("idle")
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void verifyRecipient()
                      }
                    }}
                    placeholder="name@example.com"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void verifyRecipient()}
                    disabled={!actionDestination.trim() || recipientStatus === "checking"}
                  >
                    {recipientStatus === "checking" ? "Checking…" : "Check"}
                  </Button>
                </div>

                {/* Recipient verification result */}
                {recipientStatus === "found" && recipient && (
                  <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 p-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-500/20 text-xs font-semibold text-green-500">
                      {recipient.initials}
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                        <span className="truncate">{recipient.displayName}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {recipient.company ? `${recipient.company} · ` : ""}
                        {recipient.email}
                      </p>
                    </div>
                  </div>
                )}
                {recipientStatus === "notfound" && (
                  <p className="flex items-center gap-1.5 text-sm text-red-500">
                    <XCircle className="h-4 w-4 shrink-0" />
                    No active account is registered with that email.
                  </p>
                )}
                {recipientStatus === "error" && (
                  <p className="flex items-center gap-1.5 text-sm text-red-500">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    Couldn&apos;t verify the recipient right now. Please try again.
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setActionTarget(null)} disabled={transferring}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void confirmInstrumentAction()}
                  disabled={recipientStatus !== "found" || !recipient || transferring || !canCoverTransferFee}
                >
                  {transferring
                    ? "Transferring…"
                    : !canCoverTransferFee
                      ? "Insufficient balance for fee"
                      : "Confirm Transfer"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Bank Instrument Monetization dialog */}
      <Dialog
        open={!!monetizeTarget}
        onOpenChange={(open) => {
          if (!open) {
            setMonetizeTarget(null)
            setGeneratedSwift(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {monetizeTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Banknote className="h-5 w-5 text-primary" />
                  Monetize Bank Instrument
                </DialogTitle>
                <DialogDescription>
                  {`Raise liquidity against ${monetizeTarget.id} (${monetizeTarget.typeFull}). The request is verified against its SWIFT messaging and authorized by the Administrator before proceeds are credited.`}
                </DialogDescription>
              </DialogHeader>

              {/* Instrument summary */}
              <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
                {[
                  ["Instrument", `${monetizeTarget.type} — ${monetizeTarget.typeFull}`],
                  ["Issuing Bank", monetizeTarget.issuer],
                  [
                    "Face Value",
                    formatCurrency(monetizeTarget.faceValue, monetizeTarget.currency),
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</p>
                  </div>
                ))}
              </div>

              {monetizeLeverageLine && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-primary">
                      <Layers className="h-4 w-4" />
                      Leveraged collateral value (1:{monetizeLeverageLine.leverageRatio})
                    </span>
                    <span className="text-lg font-bold text-primary">
                      {formatCurrency(monetizeBaseValue, monetizeTarget.currency)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {`Monetization is applied to the leveraged value (${formatCurrency(monetizeTarget.faceValue, monetizeTarget.currency)} face × ${monetizeLeverageLine.leverageRatio}), not just the face value.`}
                  </p>
                </div>
              )}

              {/* Structure & economics */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="mon-structure">Monetization Structure *</Label>
                  <Select
                    value={monetizeForm.structure}
                    onValueChange={(v) => {
                      const next = MONETIZATION_STRUCTURES.find((s) => s.value === v)
                      setMonetizeForm((prev) => ({
                        ...prev,
                        structure: v as MonetizationStructure,
                        advanceRate: next ? String(next.defaultRate) : prev.advanceRate,
                      }))
                    }}
                  >
                    <SelectTrigger id="mon-structure">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONETIZATION_STRUCTURES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {MONETIZATION_STRUCTURES.find((s) => s.value === monetizeForm.structure)?.hint}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-rate">Advance Rate / LTV (%) *</Label>
                  <div className="relative">
                    <Percent className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="mon-rate"
                      inputMode="decimal"
                      min={1}
                      max={100}
                      className={cn("pl-9", monetizeForm.advanceRate && !monetizeLtvValid && "border-destructive")}
                      value={monetizeForm.advanceRate}
                      onChange={(e) => {
                        // Keep only digits + a single decimal point, then cap at 100.
                        const cleaned = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
                        const num = Number.parseFloat(cleaned)
                        setMon("advanceRate", Number.isFinite(num) && num > 100 ? "100" : cleaned)
                      }}
                      placeholder="e.g. 65"
                    />
                  </div>
                  {monetizeForm.advanceRate && !monetizeLtvValid ? (
                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-destructive">
                      <AlertCircle className="mt-px h-3 w-3 shrink-0" />
                      <span>The LTV / advance rate must be between 1% and 100%.</span>
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-currency">Proceeds Currency *</Label>
                  <Select
                    value={monetizeForm.proceedsCurrency}
                    onValueChange={(v) => setMon("proceedsCurrency", v)}
                  >
                    <SelectTrigger id="mon-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONETIZATION_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 sm:col-span-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {`Estimated gross proceeds (${monetizeForm.advanceRate || "0"}% of ${monetizeLeverageLine ? "leveraged value" : "face value"} ${formatCurrency(monetizeBaseValue, monetizeForm.proceedsCurrency)})`}
                    </span>
                    <span className="text-lg font-semibold text-foreground">
                      {formatCurrency(monetizeProceeds, monetizeForm.proceedsCurrency)}
                    </span>
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <Clock className="mt-px h-3 w-3 shrink-0" />
                    <span>
                      These proceeds are credited to your Master Account only after an Administrator approves the
                      request — not on submission. Until then it stays pending and your balance is unchanged.
                    </span>
                  </p>
                </div>

                {/* Upfront equity deposit (LTV-scaled) + PPI, blocked in the instrument's currency */}
                <div
                  className={cn(
                    "rounded-lg border p-3 sm:col-span-2",
                    canCoverMonetizeReserve ? "border-primary/20 bg-primary/5" : "border-destructive/40 bg-destructive/10",
                  )}
                >
                  <p className="mb-2 text-sm font-medium text-foreground">
                    Upfront equity deposit — blocked in {monetizeReserveCurrency}
                  </p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        Equity ({(monetizeEquityRate * 100).toFixed(2)}% at {monetizeAdvanceRate || 0}% LTV)
                      </span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(monetizeEquityDeposit, monetizeReserveCurrency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">PPI — Payment Protection Insurance (1% of advance)</span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(monetizePpi, monetizeReserveCurrency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1.5">
                      <span className="font-medium text-foreground">Total blocked upfront</span>
                      <span className="text-base font-semibold text-foreground">
                        {formatCurrency(monetizeReserve, monetizeReserveCurrency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Available {monetizeReserveCurrency} balance</span>
                      <span className={cn("font-medium", canCoverMonetizeReserve ? "text-foreground" : "text-destructive")}>
                        {formatCurrency(monetizeReserveAvailable, monetizeReserveCurrency)}
                      </span>
                    </div>
                  </div>
                  {canCoverMonetizeReserve ? (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      <Lock className="mt-px h-3 w-3 shrink-0" />
                      <span>
                        The equity scales from 0.75% at 1% LTV to 5% at 100% LTV; the PPI premium is funded from it. The
                        full amount is blocked from your {monetizeReserveCurrency} Master Account on submission and
                        released automatically if the request is declined or reversed.
                      </span>
                    </p>
                  ) : (
                    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive">
                      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                      <span>
                        <strong>Operation not possible.</strong> You must reserve{" "}
                        {formatCurrency(monetizeReserve, monetizeReserveCurrency)} upfront in {monetizeReserveCurrency} —
                        a {(monetizeEquityRate * 100).toFixed(2)}% equity deposit plus 1% PPI — but only{" "}
                        {formatCurrency(monetizeReserveAvailable, monetizeReserveCurrency)} is available, short by{" "}
                        {formatCurrency(monetizeReserveShortfall, monetizeReserveCurrency)}. Fund your{" "}
                        {monetizeReserveCurrency} balance before monetizing this instrument.
                      </span>
                    </div>
                  )}
                </div>

                {/* Progressive (tiered) debit interest on the gross proceeds. */}
                {monetizePricing.totalAnnualInterest > 0 && (
                  <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3 sm:col-span-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">
                        Debit interest (adaptive composite)
                      </span>
                      <span className="text-sm font-semibold text-primary">
                        {(monetizePricing.effectiveRate * 100).toFixed(2)}% p.a. blended
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Charged monthly (1/12 of annual)</span>
                      <span className="font-medium text-orange-400">
                        {formatCurrency(monetizePricing.monthlyInterest, monetizeForm.proceedsCurrency)} / mo
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Total annual interest</span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(monetizePricing.totalAnnualInterest, monetizeForm.proceedsCurrency)} / yr
                      </span>
                    </div>
                    {/* Per-tranche breakdown — marginal pricing, like tax brackets. */}
                    <div className="space-y-1 border-t border-border pt-2">
                      {monetizePricing.tranches.map((t, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-[11px] text-muted-foreground"
                        >
                          <span>
                            {formatTierBound(t.from)}
                            {"–"}
                            {t.upTo === null ? "∞" : formatTierBound(t.upTo)} @ {(t.annualRate * 100).toFixed(2)}%
                            {" · "}
                            {formatCurrency(t.portion, monetizeForm.proceedsCurrency)}
                          </span>
                          <span className="font-medium text-foreground">
                            {formatCurrency(t.annualInterest, monetizeForm.proceedsCurrency)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Interest is applied marginally — only the portion of the facility within each tier is
                      charged at that tier&apos;s rate, so you never pay the top rate on the whole facility.
                      Accrual begins the day funds are credited and is deducted monthly from your Master Account.
                    </p>
                  </div>
                )}
              </div>

              {/* Coordination */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mon-platform">Monetizer / Program (optional)</Label>
                  <Input
                    id="mon-platform"
                    value={monetizeForm.monetizationPlatform}
                    onChange={(e) => setMon("monetizationPlatform", e.target.value)}
                    placeholder="e.g. PPP / Yield Program"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-recv-bic">Receiving Bank BIC / SWIFT (optional)</Label>
                  <Input
                    id="mon-recv-bic"
                    value={monetizeForm.receivingBankBic}
                    onChange={(e) => setMon("receivingBankBic", e.target.value)}
                    placeholder="e.g. BARCGB22"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="mon-recv-bank">Receiving Bank</Label>
                  <Input
                    id="mon-recv-bank"
                    value={monetizeForm.receivingBank}
                    onChange={(e) => setMon("receivingBank", e.target.value)}
                    placeholder="Bank receiving the monetization proceeds"
                  />
                </div>
              </div>

              {/* SWIFT messaging & documentation */}
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">SWIFT messaging</p>
                    <p className="text-xs text-muted-foreground">
                      Auto-build well-formed MT760 (collateral transfer) and MT799 (RWA pre-advice) FIN
                      from this instrument and fill the references below.
                    </p>
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={handleGenerateSwift}>
                    <Radio className="mr-2 h-4 w-4" />
                    Generate SWIFT messages
                  </Button>
                </div>
                {generatedSwift && (
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {(
                      [
                        { label: "MT760 — Guarantee / collateral transfer", raw: generatedSwift.mt760 },
                        { label: "MT799 — RWA pre-advice", raw: generatedSwift.mt799 },
                      ] as const
                    ).map((m) => (
                      <div key={m.label} className="space-y-2 rounded-md border border-border bg-background p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">{m.label}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => {
                              void navigator.clipboard.writeText(m.raw)
                              toast.success("Copied SWIFT message to clipboard")
                            }}
                          >
                            <Copy className="mr-1.5 h-3.5 w-3.5" />
                            Copy
                          </Button>
                        </div>
                        <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] leading-relaxed text-foreground">
                          {m.raw}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mon-mt760">MT760 Reference</Label>
                  <Input
                    id="mon-mt760"
                    value={monetizeForm.mt760Ref}
                    onChange={(e) => setMon("mt760Ref", e.target.value)}
                    placeholder="Guarantee / collateral transfer ref"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-mt799">MT799 Reference</Label>
                  <Input
                    id="mon-mt799"
                    value={monetizeForm.mt799Ref}
                    onChange={(e) => setMon("mt799Ref", e.target.value)}
                    placeholder="Pre-advice / RWA assurance ref"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-pof">Proof of Funds (POF) Reference</Label>
                  <Input
                    id="mon-pof"
                    value={monetizeForm.pofReference}
                    onChange={(e) => setMon("pofReference", e.target.value)}
                    placeholder="POF document reference"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mon-bcl">Bank Comfort Letter (BCL) Reference</Label>
                  <Input
                    id="mon-bcl"
                    value={monetizeForm.bclReference}
                    onChange={(e) => setMon("bclReference", e.target.value)}
                    placeholder="BCL document reference"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="mon-notes">Notes (optional)</Label>
                  <Input
                    id="mon-notes"
                    value={monetizeForm.notes}
                    onChange={(e) => setMon("notes", e.target.value)}
                    placeholder="Any additional coordination detail"
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setMonetizeTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={confirmMonetization} disabled={!canSubmitMonetization}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {canCoverMonetizeReserve ? "Submit for Authorization" : "Insufficient reserve balance"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirm removal of an unused holding from the portfolio. */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {deleteTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Trash2 className="h-5 w-5 text-destructive" />
                  Delete instrument
                </DialogTitle>
                <DialogDescription>
                  Remove{" "}
                  <span className="font-medium text-foreground">
                    {deleteTarget.typeFull} ({deleteTarget.id})
                  </span>{" "}
                  issued by {deleteTarget.issuer} from your portfolio. This holding is not pledged to any leverage line
                  or monetization request, so it can be safely removed. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              {(() => {
                const fee = instrumentManagementFee(deleteTarget.faceValue)
                if (fee <= 0) return null
                return (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                    <Percent className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-pretty">
                      A one-time management &amp; settlement fee of{" "}
                      <span className="font-semibold">{formatInstrumentFee(fee, deleteTarget.currency)}</span> (
                      {INSTRUMENT_MANAGEMENT_FEE_LABEL} of the {formatInstrumentFee(deleteTarget.faceValue, deleteTarget.currency)}{" "}
                      face value) will be debited from your Master Account when you settle out this instrument.
                    </p>
                  </div>
                )
              })()}
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    const target = deleteTarget
                    const fee = instrumentManagementFee(target.faceValue)
                    deleteInstrument(target.id)
                    logActivity({
                      action: `Removed bank instrument ${target.id} from portfolio`,
                      category: "Bank Instruments",
                      details: {
                        summary: `Client removed ${target.typeFull} (${target.id}) issued by ${target.issuer} from their portfolio. The instrument was not pledged or monetized.`,
                        referenceId: target.id,
                        ...(fee > 0 ? { fee: formatInstrumentFee(fee, target.currency) } : {}),
                      },
                    })
                    toast.success("Instrument removed", {
                      description:
                        fee > 0
                          ? `${target.type} ${target.id} removed. A management fee of ${formatInstrumentFee(fee, target.currency)} was charged to your Master Account.`
                          : `${target.type} ${target.id} has been removed from your portfolio.`,
                    })
                    setDeleteTarget(null)
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete instrument
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={returnTarget !== null} onOpenChange={(o) => !o && setReturnTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {returnTarget &&
            (() => {
              const reasons = usageReasons(returnTarget)
              const blocked = reasons.length > 0
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      {blocked ? (
                        <AlertCircle className="h-5 w-5 text-yellow-500" />
                      ) : (
                        <Undo2 className="h-5 w-5 text-primary" />
                      )}
                      Return to marketplace
                    </DialogTitle>
                    <DialogDescription>
                      {blocked ? (
                        <>
                          <span className="font-medium text-foreground">
                            {returnTarget.typeFull} ({returnTarget.id})
                          </span>{" "}
                          is currently used in {reasons.join(", ")}. You must revoke the reconciliation before it can
                          be returned. Once nothing engages it, come back here to return it.
                        </>
                      ) : (
                        <>
                          Return{" "}
                          <span className="font-medium text-foreground">
                            {returnTarget.typeFull} ({returnTarget.id})
                          </span>{" "}
                          issued by {returnTarget.issuer} to the marketplace. It will be removed from your portfolio
                          and become available to everyone again. This action cannot be undone.
                        </>
                      )}
                    </DialogDescription>
                  </DialogHeader>
                  {blocked && (
                    <ul className="list-disc space-y-1 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 pl-8 text-sm text-foreground">
                      {reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setReturnTarget(null)}>
                      {blocked ? "Understood" : "Cancel"}
                    </Button>
                    {!blocked && (
                      <Button
                        onClick={() => {
                          const target = returnTarget
                          returnInstrument(target.id)
                          logActivity({
                            action: `Returned bank instrument ${target.id} to the marketplace`,
                            category: "Bank Instruments",
                            details: {
                              summary: `Client returned ${target.typeFull} (${target.id}) issued by ${target.issuer} to the marketplace. The instrument was not engaged in any monetization, leverage or yield scenario and is now available to everyone again.`,
                              referenceId: target.id,
                            },
                          })
                          toast.success("Returned to marketplace", {
                            description: `${target.type} ${target.id} has been removed from your portfolio and is available again.`,
                          })
                          setReturnTarget(null)
                        }}
                      >
                        <Undo2 className="mr-2 h-4 w-4" />
                        Return to marketplace
                      </Button>
                    )}
                  </DialogFooter>
                </>
              )
            })()}
        </DialogContent>
      </Dialog>

      <Dialog open={upgradeTarget !== null} onOpenChange={(o) => !o && closeUpgrade()}>
        <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          {upgradeTarget?.upgrade &&
            (() => {
              const u = upgradeTarget.upgrade!
              const money = (v: number, ccy: string) =>
                `${ccy} ${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
              const feePreview = u.fee > 0 ? u.fee : 0
              return (
                <>
                  <DialogHeader className="shrink-0 border-b p-4 pr-12">
                    <DialogTitle className="flex items-center gap-2">
                      <Handshake className="h-5 w-5 text-amber-500" />
                      Negotiate transformation upgrade
                    </DialogTitle>
                    <DialogDescription className="text-pretty">
                      The administrator proposes transforming{" "}
                      <span className="font-medium text-foreground">
                        {upgradeTarget.typeFull} ({upgradeTarget.id})
                      </span>{" "}
                      into a fresh instrument. Discuss the value, send a counter-offer, then confirm — no fee until you
                      confirm.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border bg-muted/40 p-3">
                        <p className="text-xs text-muted-foreground">Current</p>
                        <p className="mt-1 font-medium text-foreground">{upgradeTarget.typeFull}</p>
                        <p className="text-xs text-muted-foreground">{upgradeTarget.issuer}</p>
                        <p className="mt-1 font-semibold">{money(upgradeTarget.faceValue, upgradeTarget.currency)}</p>
                      </div>
                      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                        <p className="text-xs text-amber-600">Proposed</p>
                        <p className="mt-1 font-medium text-foreground">{u.newTypeFull}</p>
                        <p className="text-xs text-muted-foreground">
                          {u.newIssuer}
                          {u.newIssuerCountry ? ` · ${u.newIssuerCountry}` : ""}
                        </p>
                        <p className="mt-1 font-semibold text-amber-600">{money(u.newFaceValue, u.newCurrency)}</p>
                      </div>
                    </div>

                    {u.customerCounterFaceValue ? (
                      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                        <p className="font-medium text-foreground">Your latest counter-offer</p>
                        <p className="mt-0.5 text-amber-600 dark:text-amber-400">
                          {money(u.customerCounterFaceValue, u.newCurrency)} — awaiting the administrator's revision.
                        </p>
                        {u.customerCounterNote ? (
                          <p className="mt-1 text-muted-foreground">"{u.customerCounterNote}"</p>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <span className="text-muted-foreground">
                        Expertise &amp; upgrade fee ({INSTRUMENT_UPGRADE_FEE_LABEL}, one-time)
                      </span>
                      <span className="font-semibold text-foreground">{money(feePreview, u.feeCurrency)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground text-pretty">
                      {u.feeCharged || u.status === "proposed"
                        ? "The fee has already been charged. Confirming issues the new instrument immediately and retires the current one; declining refunds the fee and keeps your instrument active."
                        : "No fee has been charged yet. The fee is taken from your Master Account only when you confirm the agreed deal, at which point the new instrument is issued and the current one retired. While you negotiate, your instrument stays fully usable."}
                    </p>

                    {u.terms && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground text-pretty">
                        <span className="font-medium text-foreground">Terms &amp; agreements: </span>
                        {u.terms}
                      </div>
                    )}
                    {u.note && (
                      <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground text-pretty">
                        <span className="font-medium text-foreground">Note from the administrator: </span>
                        {u.note}
                      </div>
                    )}

                    {/* Counter-offer — only while still negotiating (not legacy proposed). */}
                    {u.status === "negotiating" && (
                      <div className="space-y-2 rounded-lg border border-border p-3">
                        <Label className="text-xs font-medium text-foreground">
                          Propose a different face value ({u.newCurrency})
                        </Label>
                        <Input
                          inputMode="decimal"
                          placeholder={`e.g. ${u.newFaceValue.toLocaleString("en-US")}`}
                          value={counterValue}
                          onChange={(e) => setCounterValue(e.target.value)}
                        />
                        <Textarea
                          placeholder="Optional message to the administrator…"
                          className="min-h-[60px] text-sm"
                          value={counterNote}
                          onChange={(e) => setCounterNote(e.target.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={submitCounter}
                          disabled={counterBusy || !counterValue.trim()}
                        >
                          {counterBusy ? "Sending…" : "Send counter-offer"}
                        </Button>
                      </div>
                    )}

                    {/* Discuss with the administrator (embedded Messenger). */}
                    <div className="rounded-lg border border-border">
                      <button
                        type="button"
                        onClick={() => setUpgradeDiscuss((v) => !v)}
                        className="flex w-full items-center justify-between p-3 text-sm font-medium text-foreground"
                      >
                        <span className="flex items-center gap-2">
                          <MessageSquare className="h-4 w-4 text-muted-foreground" />
                          Discuss with the administrator
                        </span>
                        <ChevronDown className={cn("h-4 w-4 transition-transform", upgradeDiscuss && "rotate-180")} />
                      </button>
                      {upgradeDiscuss && (
                        <div className="border-t p-2">
                          <Messenger
                            key={upgradeTarget.approvalId ?? upgradeTarget.id}
                            scope={`instrument-upgrade-${upgradeTarget.approvalId ?? upgradeTarget.id}`}
                            fetchConversations={listConversations}
                            fetchThread={getThread}
                            send={sendMessage}
                            deleteMessage={deleteMessage}
                            attachmentsEnabled
                            hideConversationList
                            initialThreadId={BANKEKA_ADMIN_ID}
                            initialParticipant={{
                              id: BANKEKA_ADMIN_ID,
                              name: BANKEKA_ADMIN_LABEL,
                              company: "",
                              initials: BANKEKA_ADMIN_INITIALS,
                              isAdmin: true,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  <DialogFooter className="shrink-0 flex-col gap-2 border-t p-4 sm:flex-row">
                    <Button variant="outline" onClick={declineUpgrade} disabled={upgradeBusy || counterBusy}>
                      {upgradeBusy ? "Working…" : "Decline offer"}
                    </Button>
                    <Button
                      onClick={acceptUpgrade}
                      disabled={upgradeBusy || counterBusy}
                      className="bg-amber-600 hover:bg-amber-700"
                    >
                      <Handshake className="mr-2 h-4 w-4" />
                      {upgradeBusy ? "Working…" : "Confirm & accept deal"}
                    </Button>
                  </DialogFooter>
                </>
              )
            })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}
