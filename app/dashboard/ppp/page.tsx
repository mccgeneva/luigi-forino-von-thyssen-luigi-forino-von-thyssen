"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  TrendingUp,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileText,
  DollarSign,
  Calendar,
  Users,
  Lock,
  ArrowRight,
  Info,
  ExternalLink,
  ShieldCheck,
  Landmark,
  Loader2,
  LogOut,
} from "lucide-react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
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
import { Textarea } from "@/components/ui/textarea"
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
import { usePPPRequests, type PPPRequest } from "@/lib/ppp-requests-store"
import { requestYieldTermination, withdrawYieldTermination } from "@/app/actions/approvals"
import {
  yieldCancellationPenalty,
  YIELD_EARLY_CANCELLATION_PENALTY_RATE,
} from "@/lib/ppp-yield"
import { useInstrumentRequests, isMccHeldInstrument } from "@/lib/instrument-requests-store"
import { computeBenefitSplit } from "@/lib/benefit-split"
import { isLiveRequest } from "@/lib/live-request"
import { convertCurrency } from "@/lib/fx"
import { useLedger } from "@/lib/ledger-store"
import { MCC_HOLDING_OWNER, MCC_BENEFIT_SHARE, CLIENT_BENEFIT_SHARE } from "@/lib/instrument-marketplace"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generatePPPConfirmationPdf } from "@/lib/ppp-confirmation-pdf"
import { Download } from "lucide-react"
import { getActiveInstitutionalYields } from "@/app/actions/institutional-yields"
import { type InstitutionalYield } from "@/lib/institutional-yields-shared"
import { PPP_PROGRAMS, applyProgramOverride, type BuiltInProgram } from "@/lib/ppp-programs"
import { getYieldProgramOverrides } from "@/app/actions/yield-overrides"

// The built-in programs now live in a shared module so the administrator can
// hide / edit them (including their risk level) via the admin Program Controls.
type Program = BuiltInProgram

const currencySymbols: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CHF: "CHF ",
}

const formatCurrency = (value: number) => {
  if (value >= 1000000000) {
    return `$${(value / 1000000000).toFixed(1)}B`
  }
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(0)}M`
  }
  return `$${value.toLocaleString()}`
}

// Currency-aware compact formatter for real (approved) investment figures.
const formatMoney = (value: number, currency: string) => {
  const symbol = currencySymbols[currency] ?? `${currency} `
  if (value >= 1000000000) return `${symbol}${(value / 1000000000).toFixed(2)}B`
  if (value >= 1000000) return `${symbol}${(value / 1000000).toFixed(1)}M`
  return `${symbol}${value.toLocaleString()}`
}

const statusConfig = {
  open: { label: "Open", color: "bg-green-500/10 text-green-500 border-green-500/20" },
  limited: { label: "Limited Spots", color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  invite: { label: "Invite Only", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  closed: { label: "Closed", color: "bg-red-500/10 text-red-500 border-red-500/20" },
}

const sourceLabels: Record<string, string> = {
  cash: "Cash Funds",
  sblc: "SBLC",
  mtn: "MTN",
  bg: "Bank Guarantee",
}

const payoutLabels: Record<string, string> = {
  master: "Master Account (NatWest)",
  trading: "Trading Account (JP Morgan)",
}

const applicationStatusConfig = {
  pending: {
    label: "Pending Approval",
    icon: Clock,
    color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  },
  approved: {
    label: "Approved",
    icon: CheckCircle2,
    color: "bg-green-500/10 text-green-500 border-green-500/20",
  },
  rejected: {
    label: "Rejected",
    icon: XCircle,
    color: "bg-red-500/10 text-red-500 border-red-500/20",
  },
  cancelled: {
    label: "Cancelled",
    icon: XCircle,
    color: "bg-muted text-muted-foreground border-border",
  },
}

export default function PPPPage() {
  const [isApplyOpen, setIsApplyOpen] = useState(false)
  const [selectedProgram, setSelectedProgram] = useState<Program | null>(null)
  const [activeTab, setActiveTab] = useState("programs")
  const [amount, setAmount] = useState("")
  const [sourceOfFunds, setSourceOfFunds] = useState("")
  const [payoutAccount, setPayoutAccount] = useState("")
  // Optional MCC HOLDING SA-owned instrument used to fund this investment. When
  // set, the 75/25 benefit split applies to the returns. "" = none (own funds).
  const [fundingInstrumentId, setFundingInstrumentId] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [detailInvestment, setDetailInvestment] = useState<PPPRequest | null>(null)
  // Early resignation from an ongoing (approved) program: the client requests it
  // and PROPOSES an exit cost + reason; the administrator negotiates the final
  // figure and confirms. `resignTarget` drives the request dialog; `resignCost`
  // and `resignReason` are the client's proposal; `resigning` is the busy flag.
  const [resignTarget, setResignTarget] = useState<PPPRequest | null>(null)
  const [resignCost, setResignCost] = useState("")
  const [resignReason, setResignReason] = useState("")
  const [resigning, setResigning] = useState(false)
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const log = useActivityLog()
  const { requests, addRequest, refresh, hydrated } = usePPPRequests()
  const { instruments } = useInstrumentRequests()
  const { totalIn } = useLedger()

  // Every active, non-blocked bank instrument the client can pledge as the
  // funding source — this INCLUDES the client's OWN instruments (e.g. an inbound
  // MT760 blocked-funds guarantee they hold) as well as MCC HOLDING SA-owned
  // ones. Only an MCC HOLDING SA-owned instrument triggers the 75/25 benefit
  // split; a client's own instrument keeps 100% of the return. (Mirrors the
  // leverage page's pledge picker, which lists all active non-blocked instruments.)
  const pledgeableInstruments = useMemo(
    () => instruments.filter((i) => i.status === "active" && !i.blocked),
    [instruments],
  )
  const selectedFundingInstrument = useMemo(
    () => pledgeableInstruments.find((i) => i.id === fundingInstrumentId) ?? null,
    [pledgeableInstruments, fundingInstrumentId],
  )
  // Whether the SELECTED funding instrument is owned by MCC HOLDING SA (assignee
  // model → 75/25 split). A client's own instrument is not MCC-held → no split.
  const selectedInstrumentIsMccHeld = useMemo(
    () => (selectedFundingInstrument ? isMccHeldInstrument(selectedFundingInstrument) : false),
    [selectedFundingInstrument],
  )

  // Instruments already pledged to a live (pending or approved) yield/PPP
  // application. An instrument can only fund ONE investment at a time — it may
  // not be double-pledged as collateral. Rejected requests release it.
  const committedInstrumentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of requests) {
      if (r.fundingInstrumentId && r.status !== "rejected") ids.add(r.fundingInstrumentId)
    }
    return ids
  }, [requests])

  // Indicative 75/25 split preview for the apply dialog. Uses the LOWER bound of
  // the program's expected-return range applied to the entered amount, converted
  // into the funding INSTRUMENT'S currency (the benefit is generated by that
  // MCC-owned instrument) — purely illustrative; actual distributions follow the
  // realised return.
  const applyBenefitPreview = useMemo(() => {
    if (!selectedFundingInstrument || !selectedInstrumentIsMccHeld || !selectedProgram) return null
    const principal = Number(amount.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(principal) || principal <= 0) return null
    const lowerPct = Number.parseFloat((selectedProgram.expectedReturn.match(/\d+(\.\d+)?/) ?? ["0"])[0])
    if (!Number.isFinite(lowerPct) || lowerPct <= 0) return null
    const programCurrency = selectedProgram.currency ?? "USD"
    const instrumentCurrency = selectedFundingInstrument.currency
    // Return per period in program currency, then converted to the instrument's.
    const grossInProgramCcy = (principal * lowerPct) / 100
    const grossInInstrumentCcy = convertCurrency(grossInProgramCcy, programCurrency, instrumentCurrency)
    return { ...computeBenefitSplit(grossInInstrumentCcy), currency: instrumentCurrency }
  }, [selectedFundingInstrument, selectedInstrumentIsMccHeld, selectedProgram, amount])
  const { show: showPdf } = usePdfViewer()

  // Administrator-published, bank-partner-sourced institutional yields. Only
  // ACTIVE products are returned by the server, so clients never see pending or
  // closed offerings. Fails closed (empty) if the catalogue is unavailable.
  const { data: activeYields = [] } = useSWR<InstitutionalYield[]>(
    "active-institutional-yields",
    () => getActiveInstitutionalYields(),
    { revalidateOnFocus: false },
  )

  // Administrator overrides for the built-in programs. The admin can hide a
  // program entirely or change any displayed parameter (including risk level)
  // from the admin Program Controls. Merge the overrides onto the defaults and
  // drop any the admin has hidden. Fails closed to the built-in defaults.
  const { data: programOverrides = {} } = useSWR(
    "yield-program-overrides",
    () => getYieldProgramOverrides(),
    { revalidateOnFocus: false },
  )
  const programs = useMemo<Program[]>(
    () =>
      PPP_PROGRAMS.map((p) => applyProgramOverride(p, programOverrides[p.id]))
        .filter((p) => !p.hidden)
        .map(({ hidden: _hidden, ...rest }) => rest),
    [programOverrides],
  )

  // Open the existing application dialog for a published institutional yield by
  // mapping it onto the program shape, so it flows through the SAME mandatory
  // Administrator approval workflow as the standard programs.
  const openApplyForYield = (y: InstitutionalYield) => {
    openApplyDialog({
      id: y.id,
      name: y.programName,
      type: "institutional",
      minInvestment: y.minInvestment,
      maxInvestment: y.minInvestment * 100,
      currency: y.currency,
      expectedReturn: y.expectedReturn,
      returnFrequency: y.returnFrequency || "At Maturity",
      duration: y.termLabel,
      status: "open",
      spotsAvailable: 1,
      totalSpots: 1,
      riskLevel: y.riskClass,
      description: y.description,
      requirements: [y.bankName, y.yieldType, y.rating].filter(Boolean) as string[],
    })
  }

  const myApplications = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
      ),
    [requests],
  )
  const pendingCount = myApplications.filter((r) => r.status === "pending").length
  // The tab badge reflects only LIVE applications. `isLiveRequest` is the shared
  // rule (lib/live-request.ts): it excludes terminal statuses (rejected/cancelled)
  // AND terminal markers on an approved record (cancelledAt) so a terminated
  // program never inflates the count, while staying in the list as history.
  const liveApplicationCount = myApplications.filter(isLiveRequest).length

  // Approved applications are the client's real, executed investments. A program
  // terminated early stamps `cancelledAt`, so we require `isLiveRequest` too — a
  // terminated program drops out of the "My Investments" list and summary stats.
  const approvedInvestments = useMemo(
    () => myApplications.filter((r) => r.status === "approved" && isLiveRequest(r)),
    [myApplications],
  )
  const totalInvested = useMemo(
    () => approvedInvestments.reduce((sum, r) => sum + r.amount, 0),
    [approvedInvestments],
  )
  const investmentCurrency = approvedInvestments[0]?.currency ?? "USD"

  // When the client already has applications, open the "My Applications" tab by
  // default so approved/rejected decisions are immediately visible on arrival.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || autoSelectedRef.current) return
    autoSelectedRef.current = true
    if (myApplications.length > 0) {
      setActiveTab("applications")
    }
  }, [hydrated, myApplications.length])

  const resetForm = () => {
    setAmount("")
    setSourceOfFunds("")
    setPayoutAccount("")
    setFundingInstrumentId("")
    setFormError(null)
  }

  const openApplyDialog = (program: Program) => {
    setSelectedProgram(program)
    resetForm()
    setIsApplyOpen(true)
  }

  // Open the early-resignation request dialog, pre-filling the proposed exit cost
  // with the standard 2%-of-principal figure (which the client may edit).
  const openResign = (target: PPPRequest) => {
    setResignCost(yieldCancellationPenalty(target.amount).toFixed(2))
    setResignReason("")
    setResignTarget(target)
  }

  // Submit the early-resignation REQUEST. This moves no money and terminates
  // nothing — it routes to the administrator, who negotiates the final exit cost
  // and confirms. The program keeps running (ROI keeps accruing) until then.
  const confirmResign = async () => {
    const target = resignTarget
    if (!target?.approvalId || resigning) return
    const proposed = Number(resignCost.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(proposed) || proposed < 0) {
      toast.error("Enter a valid proposed exit cost.")
      return
    }
    setResigning(true)
    try {
      const res = await requestYieldTermination(target.approvalId, {
        proposedCost: proposed,
        reason: resignReason.trim() || undefined,
      })
      if (!res.ok) {
        toast.error("Could not submit request", { description: res.error })
        return
      }
      toast.success("Termination request sent", {
        description: `You proposed an exit cost of ${formatMoney(res.proposedCost ?? proposed, res.currency ?? target.currency)}. The administrator will agree the final figure and confirm.`,
      })
      log({
        action: `Requested early termination of yield / PPP program "${target.programName}"`,
        category: "Yield / PPP",
        details: {
          summary: `Client requested to resign from ${target.programName} (${target.id}), proposing an exit cost of ${formatMoney(res.proposedCost ?? proposed, res.currency ?? target.currency)}.${resignReason.trim() ? ` Reason: ${resignReason.trim()}` : ""}`,
          referenceId: target.id,
        },
      })
      setResignTarget(null)
      void refresh()
    } finally {
      setResigning(false)
    }
  }

  // Withdraw a still-pending termination request (before the admin confirms).
  const withdrawResign = async (target: PPPRequest) => {
    if (!target.approvalId || withdrawingId) return
    setWithdrawingId(target.id)
    try {
      const res = await withdrawYieldTermination(target.approvalId)
      if (!res.ok) {
        toast.error("Could not withdraw request", { description: res.error })
        return
      }
      toast.success("Request withdrawn", { description: "Your program continues as normal." })
      void refresh()
    } finally {
      setWithdrawingId(null)
    }
  }

  const submitApplication = () => {
    if (!selectedProgram) return

    const numericAmount = Number(amount.replace(/[^0-9.]/g, ""))
    if (!numericAmount || numericAmount <= 0) {
      setFormError("Please enter a valid investment amount.")
      return
    }
    if (numericAmount < selectedProgram.minInvestment) {
      setFormError(
        `Minimum investment for this program is ${formatCurrency(selectedProgram.minInvestment)}.`,
      )
      return
    }
    if (!sourceOfFunds) {
      setFormError("Please select a source of funds.")
      return
    }
    if (!payoutAccount) {
      setFormError("Please select a payout account.")
      return
    }
    // Prevent double-pledging: a funding instrument already committed to another
    // live (pending/approved) application cannot fund a second one.
    if (fundingInstrumentId && committedInstrumentIds.has(fundingInstrumentId)) {
      setFormError(
        "This instrument is already pledged to another active yield/PPP application. Release that request or choose a different instrument.",
      )
      return
    }
    // A CASH-funded investment (no instrument pledged) deploys the principal from
    // the master account, so the client cannot invest more than they hold. Refuse
    // it here for a visible message — the server enforces the same gate
    // authoritatively (the mirror submission is fire-and-forget, so a server-only
    // rejection would otherwise be silent). An instrument-funded program is
    // collateral-backed and NOT balance-gated.
    if (!selectedFundingInstrument) {
      const availableInCcy = totalIn(selectedProgram.currency)
      if (numericAmount > availableInCcy + 0.01) {
        setFormError(
          `Insufficient funds. This investment deploys ${formatMoney(numericAmount, selectedProgram.currency)} from your master account but only ${formatMoney(
            Math.max(0, availableInCcy),
            selectedProgram.currency,
          )} is available. Fund the account, invest less, or back the program with a bank instrument.`,
        )
        return
      }
    }

    const request = addRequest({
      id: `PPP-REQ-${new Date().getTime().toString().slice(-8)}`,
      programId: selectedProgram.id,
      programName: selectedProgram.name,
      expectedReturn: selectedProgram.expectedReturn,
      returnFrequency: selectedProgram.returnFrequency,
      duration: selectedProgram.duration,
      currency: selectedProgram.currency,
      amount: numericAmount,
      sourceOfFunds: sourceLabels[sourceOfFunds] ?? sourceOfFunds,
      payoutAccount: payoutLabels[payoutAccount] ?? payoutAccount,
      // Pledge the selected funding instrument. Only an MCC HOLDING SA-owned
      // instrument records the 75/25 split; a client's OWN instrument (e.g. their
      // MT760 blocked-funds guarantee) funds the program with no split.
      ...(selectedFundingInstrument
        ? {
            fundingInstrumentId: selectedFundingInstrument.id,
            fundingInstrumentLabel: `${selectedFundingInstrument.type} ${selectedFundingInstrument.id}`,
            ...(selectedInstrumentIsMccHeld
              ? { mccBenefitRate: MCC_BENEFIT_SHARE, clientBenefitRate: CLIENT_BENEFIT_SHARE }
              : {}),
          }
        : {}),
    })

    log({
      action: `Submitted PPP application for ${selectedProgram.name} for Administrator approval`,
      category: "PPP / Yield Programs",
      details: {
        summary: `Client submitted an application to join the "${selectedProgram.name}" program with an investment of ${selectedProgram.currency} ${numericAmount.toLocaleString()}. The application is pending mandatory Administrator approval before execution.`,
        referenceId: request.id,
        program: selectedProgram.name,
        programId: selectedProgram.id,
        investmentAmount: `${selectedProgram.currency} ${numericAmount.toLocaleString()}`,
        sourceOfFunds: sourceLabels[sourceOfFunds] ?? sourceOfFunds,
        payoutAccount: payoutLabels[payoutAccount] ?? payoutAccount,
        expectedReturn: selectedProgram.expectedReturn,
        status: "Pending Administrator Approval",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Application submitted for approval", {
      description: `Your application for ${selectedProgram.name} is pending Administrator approval before execution.`,
    })
    resetForm()
    setIsApplyOpen(false)
    setActiveTab("applications")
  }

  const viewInvestment = (investment: PPPRequest) => {
    setDetailInvestment(investment)
    log({
      action: `Viewed investment details for ${investment.programName}`,
      category: "PPP / Yield Programs",
      details: {
        summary: `Client opened the details for investment ${investment.id} (${investment.programName}).`,
        investmentId: investment.id,
        program: investment.programName,
      },
    })
  }

  const downloadConfirmation = (investment: PPPRequest) => {
    const generated = generatePPPConfirmationPdf({
      reference: investment.id,
      programName: investment.programName,
      amount: investment.amount,
      currency: investment.currency,
      expectedReturn: investment.expectedReturn,
      returnFrequency: investment.returnFrequency,
      duration: investment.duration,
      sourceOfFunds: investment.sourceOfFunds,
      payoutAccount: investment.payoutAccount,
      submittedAt: investment.submittedAt,
      decidedAt: investment.decidedAt,
    })
    showPdf(generated)
    log({
      action: `Downloaded investment confirmation for ${investment.programName}`,
      category: "PPP / Yield Programs",
      details: {
        summary: `Client generated the investment confirmation PDF for ${investment.id} (${investment.programName}).`,
        investmentId: investment.id,
        program: investment.programName,
      },
    })
    toast.success("Investment confirmation ready", {
      description: `Confirmation for ${investment.id} opened for download.`,
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            PPP/Yield Programs
          </h1>
          <p className="text-sm text-muted-foreground">
            Private Placement Programs with high-yield returns
          </p>
        </div>
        <Badge variant="outline" className="w-fit bg-primary/10 text-primary border-primary/20">
          <Shield className="mr-1 h-3 w-3" />
          PRO Account Required
        </Badge>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Active Investment</p>
                <p className="text-2xl font-bold text-foreground mt-1">
                  {totalInvested > 0 ? formatMoney(totalInvested, investmentCurrency) : "$0.00"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {approvedInvestments.length}{" "}
                  {approvedInvestments.length === 1 ? "program" : "programs"}
                </p>
              </div>
              <div className="rounded-lg bg-primary/10 p-3">
                <DollarSign className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Returns</p>
                <p className="text-2xl font-bold text-green-500 mt-1">$0.00</p>
                <p className="text-xs text-muted-foreground mt-1">0.0% YTD</p>
              </div>
              <div className="rounded-lg bg-green-500/10 p-3">
                <TrendingUp className="h-5 w-5 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Next Payout</p>
                <p className="text-2xl font-bold text-foreground mt-1">$0.00</p>
                <p className="text-xs text-muted-foreground mt-1">No scheduled payout</p>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-3">
                <Calendar className="h-5 w-5 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Program Progress</p>
                <p className="text-2xl font-bold text-foreground mt-1">
                  {approvedInvestments.length > 0 ? "Week 1" : "—"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {approvedInvestments.length > 0 ? "Awaiting first cycle" : "No active program"}
                </p>
              </div>
              <div className="rounded-lg bg-orange-500/10 p-3">
                <Clock className="h-5 w-5 text-orange-400" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="programs">Available Programs</TabsTrigger>
          <TabsTrigger value="applications">
            My Applications
            {liveApplicationCount > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2",
                  pendingCount > 0
                    ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    : "bg-primary/10 text-primary border-primary/20",
                )}
              >
                {liveApplicationCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="active">My Investments</TabsTrigger>
          <TabsTrigger value="history">Payout History</TabsTrigger>
        </TabsList>

        <TabsContent value="programs" className="mt-6">
          {/* How PPP Works */}
          <Card className="bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20 mb-6">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <h3 className="font-semibold text-foreground">
                    How Private Placement Programs Work
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    PPPs trade bank assets (MTN, SBLC) at discounted rates on the
                    secondary market. Arbitrage transactions are pre-contracted,
                    providing consistent returns. Programs run 12-40 banking weeks
                    with monthly distributions.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Institutional Yields — Bank Partner Programs (admin-published) */}
          {activeYields.length > 0 && (
            <div className="mb-8">
              <div className="mb-4 flex items-center gap-2">
                <Landmark className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">
                  Institutional Yields — Bank Partner Programs
                </h2>
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                  {activeYields.length} {activeYields.length === 1 ? "offering" : "offerings"}
                </Badge>
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                {activeYields.map((y) => (
                  <Card key={y.id} className="bg-card border-border">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Badge
                            variant="outline"
                            className="mb-2 bg-green-500/10 text-green-500 border-green-500/20 text-[10px]"
                          >
                            Active
                          </Badge>
                          <CardTitle className="text-lg font-semibold text-balance">
                            {y.programName}
                          </CardTitle>
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Landmark className="h-3.5 w-3.5" />
                            {y.bankName} · {y.bankCountry}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-2xl font-bold text-primary">{y.expectedReturn}</p>
                          <p className="text-xs text-muted-foreground">
                            {y.returnFrequency || "At Maturity"}
                          </p>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className="text-[10px] bg-secondary/50">
                          {y.yieldType}
                        </Badge>
                        {y.rating && (
                          <Badge variant="outline" className="text-[10px] bg-secondary/50">
                            {y.rating}
                          </Badge>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground line-clamp-3">{y.description}</p>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-xs text-muted-foreground">Min Investment</p>
                          <p className="text-sm font-semibold text-foreground">
                            {formatMoney(y.minInvestment, y.currency)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Term</p>
                          <p className="text-sm font-semibold text-foreground">{y.termLabel}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Currency</p>
                          <p className="text-sm font-semibold text-foreground">{y.currency}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Risk Classification</p>
                          <p className="text-sm font-semibold text-foreground">{y.riskClass}</p>
                        </div>
                      </div>

                      <Button className="w-full" onClick={() => openApplyForYield(y)}>
                        Request Allocation
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Programs Grid */}
          <div className="grid gap-6 md:grid-cols-2">
            {programs.map((program) => {
              const status = statusConfig[program.status as keyof typeof statusConfig]

              return (
                <Card key={program.id} className="bg-card border-border">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <Badge
                          variant="outline"
                          className={cn("text-xs mb-2", status.color)}
                        >
                          {status.label}
                        </Badge>
                        <CardTitle className="text-lg font-semibold">
                          {program.name}
                        </CardTitle>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-primary">
                          {program.expectedReturn}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {program.returnFrequency}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      {program.description}
                    </p>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Min Investment
                        </p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatCurrency(program.minInvestment)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Max Investment
                        </p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatCurrency(program.maxInvestment)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Duration</p>
                        <p className="text-sm font-semibold text-foreground">
                          {program.duration}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Risk Level</p>
                        <p className="text-sm font-semibold text-foreground">
                          {program.riskLevel}
                        </p>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-muted-foreground">
                          Availability
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {program.spotsAvailable} of {program.totalSpots} spots
                        </span>
                      </div>
                      <Progress
                        value={
                          ((program.totalSpots - program.spotsAvailable) /
                            program.totalSpots) *
                          100
                        }
                        className="h-1"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {program.requirements.map((req, idx) => (
                        <Badge
                          key={idx}
                          variant="outline"
                          className="text-[10px] bg-secondary/50"
                        >
                          {req}
                        </Badge>
                      ))}
                    </div>

                    <Button
                      className="w-full"
                      onClick={() => openApplyDialog(program)}
                      disabled={program.status === "closed"}
                    >
                      {program.status === "invite" ? (
                        <>
                          <Lock className="mr-2 h-4 w-4" />
                          Request Invitation
                        </>
                      ) : (
                        <>
                          Apply Now
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="applications" className="mt-6">
          {myApplications.length > 0 ? (
            <div className="space-y-4">
              {myApplications.map((req) => {
                const cfg = applicationStatusConfig[req.status]
                const StatusIcon = cfg.icon
                return (
                  <Card key={req.id} className="bg-card border-border">
                    <CardContent className="p-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className={cn("text-xs", cfg.color)}>
                              <StatusIcon className="mr-1 h-3 w-3" />
                              {cfg.label}
                            </Badge>
                            <span className="font-semibold text-foreground">
                              {req.programName}
                            </span>
                            <span className="text-xs text-muted-foreground">{req.id}</span>
                          </div>
                          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                            <div className="flex items-center gap-2">
                              <DollarSign className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Investment:</span>
                              <span className="font-medium text-foreground">
                                {req.currency} {req.amount.toLocaleString()}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <TrendingUp className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Expected Return:</span>
                              <span className="text-foreground">{req.expectedReturn}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Source:</span>
                              <span className="text-foreground">{req.sourceOfFunds}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-muted-foreground" />
                              <span className="text-muted-foreground">Submitted:</span>
                              <span className="text-foreground">
                                {new Date(req.submittedAt).toLocaleDateString("en-GB")}
                              </span>
                            </div>
                          </div>
                          {req.status === "rejected" && req.decisionNote && (
                            <p className="text-xs text-red-500">
                              Reason: {req.decisionNote}
                            </p>
                          )}
                          {req.status === "approved" && (
                            <div className="space-y-2 pt-1">
                              <div className="flex flex-wrap gap-2">
                                {req.terminationRequestedAt ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={withdrawingId === req.id}
                                    onClick={() => withdrawResign(req)}
                                  >
                                    {withdrawingId === req.id ? (
                                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                      <XCircle className="mr-2 h-4 w-4" />
                                    )}
                                    Withdraw exit request
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => openResign(req)}
                                  >
                                    <LogOut className="mr-2 h-4 w-4" />
                                    Request early exit
                                  </Button>
                                )}
                              </div>
                              {req.terminationRequestedAt && (
                                <div className="rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
                                  Early-exit request awaiting administrator confirmation
                                  {typeof req.proposedExitCost === "number"
                                    ? ` — you proposed an exit cost of ${formatMoney(req.proposedExitCost, req.currency)}.`
                                    : "."}{" "}
                                  The program keeps earning until the administrator confirms.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Card className="bg-card border-border">
              <CardContent className="p-8 text-center">
                <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground">No Applications Yet</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  Apply to a program and your application will appear here, pending Administrator
                  approval before execution.
                </p>
                <Button className="mt-4" onClick={() => setActiveTab("programs")}>
                  View Programs
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="active" className="mt-6">
          {approvedInvestments.length > 0 ? (
            <div className="space-y-6">
              {approvedInvestments.map((investment) => (
                <Card key={investment.id} className="bg-card border-border">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-lg font-semibold">
                          {investment.programName}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">
                          {investment.id}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="bg-green-500/10 text-green-500 border-green-500/20"
                      >
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Active
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4 sm:grid-cols-4">
                      <div className="rounded-lg bg-secondary/30 p-4">
                        <p className="text-xs text-muted-foreground">
                          Invested Amount
                        </p>
                        <p className="text-xl font-bold text-foreground mt-1">
                          {formatMoney(investment.amount, investment.currency)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-green-500/10 p-4">
                        <p className="text-xs text-muted-foreground">
                          Current Return
                        </p>
                        <p className="text-xl font-bold text-green-500 mt-1">
                          {investment.currency} 0
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Awaiting first payout
                        </p>
                      </div>
                      <div className="rounded-lg bg-secondary/30 p-4">
                        <p className="text-xs text-muted-foreground">
                          Expected Return
                        </p>
                        <p className="text-xl font-bold text-foreground mt-1">
                          {investment.expectedReturn}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {investment.returnFrequency}
                        </p>
                      </div>
                      <div className="rounded-lg bg-secondary/30 p-4">
                        <p className="text-xs text-muted-foreground">Duration</p>
                        <p className="text-xl font-bold text-foreground mt-1">
                          {investment.duration}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3 pt-4 border-t border-border sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm text-muted-foreground">
                        <span>Source: {investment.sourceOfFunds}</span>
                        <span className="mx-2">•</span>
                        <span>Payout: {investment.payoutAccount}</span>
                        {investment.decidedAt && (
                          <>
                            <span className="mx-2">•</span>
                            <span>
                              Approved:{" "}
                              {new Date(investment.decidedAt).toLocaleDateString("en-GB")}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadConfirmation(investment)}
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Download Confirmation
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => viewInvestment(investment)}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          View Details
                        </Button>
                        {investment.terminationRequestedAt ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={withdrawingId === investment.id}
                            onClick={() => withdrawResign(investment)}
                          >
                            {withdrawingId === investment.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <XCircle className="mr-2 h-4 w-4" />
                            )}
                            Withdraw exit request
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => openResign(investment)}
                          >
                            <LogOut className="mr-2 h-4 w-4" />
                            Request early exit
                          </Button>
                        )}
                      </div>
                      {investment.terminationRequestedAt && (
                        <div className="mt-1 rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
                          Early-exit request awaiting administrator confirmation
                          {typeof investment.proposedExitCost === "number"
                            ? ` — you proposed an exit cost of ${formatMoney(investment.proposedExitCost, investment.currency)}.`
                            : "."}{" "}
                          The program keeps earning until the administrator confirms.
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="bg-card border-border">
              <CardContent className="p-8 text-center">
                <TrendingUp className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground">
                  No Active Investments
                </h3>
                <p className="text-sm text-muted-foreground mt-2">
                  Browse available programs and start earning high-yield returns.
                </p>
                <Button className="mt-4" onClick={() => setActiveTab("programs")}>
                  View Programs
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">
                Payout History
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="p-8 text-center">
                <TrendingUp className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground">No Payouts Yet</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  {approvedInvestments.length > 0
                    ? "Your approved program has not generated any payouts yet. Distributions will appear here once the program cycle begins."
                    : "Payouts from approved programs will appear here once your investments start generating returns."}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Apply Dialog */}
      <Dialog open={isApplyOpen} onOpenChange={setIsApplyOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Apply for {selectedProgram?.name}</DialogTitle>
            <DialogDescription>
              Submit your application to join this PPP
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Investment Amount ({selectedProgram?.currency})</Label>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`Min: ${formatCurrency(selectedProgram?.minInvestment || 0)}`}
              />
            </div>
            <div className="grid gap-2">
              <Label>Source of Funds</Label>
              <Select value={sourceOfFunds} onValueChange={setSourceOfFunds}>
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash Funds</SelectItem>
                  <SelectItem value="sblc">SBLC</SelectItem>
                  <SelectItem value="mtn">MTN</SelectItem>
                  <SelectItem value="bg">Bank Guarantee</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Optional funding instrument — a client's OWN instrument (e.g. an
                MT760 blocked-funds guarantee) or an MCC HOLDING SA-owned one. */}
            {pledgeableInstruments.length > 0 ? (
              <div className="grid gap-2">
                <Label>Funding instrument (optional)</Label>
                <Select
                  value={fundingInstrumentId || "none"}
                  onValueChange={(v) => setFundingInstrumentId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None — own funds" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None — cash from master account</SelectItem>
                    {pledgeableInstruments.map((inst) => {
                      const inUse = committedInstrumentIds.has(inst.id)
                      const mccHeld = isMccHeldInstrument(inst)
                      return (
                        <SelectItem key={inst.id} value={inst.id} disabled={inUse}>
                          {inst.type} {inst.id} · {formatMoney(inst.faceValue, inst.currency)}
                          {mccHeld ? " · MCC-held (75/25)" : " · your instrument"}
                          {inUse ? " · already in use" : ""}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Pledge a bank instrument to back this investment instead of cash — including your own
                  instruments such as an inbound MT760 blocked-funds guarantee. An instrument owned by{" "}
                  {MCC_HOLDING_OWNER} applies the 75/25 benefit split below; your own instrument keeps 100% of
                  the return. An instrument already pledged to another live application can&apos;t be used again
                  until that request is released.
                </p>
              </div>
            ) : null}

            {/* 75 / 25 benefit-split disclosure — only when an MCC-held instrument is used. */}
            {selectedFundingInstrument && selectedInstrumentIsMccHeld ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 shrink-0 text-primary" />
                  <p className="text-sm font-medium text-foreground">
                    Benefit split — {selectedFundingInstrument.type} {selectedFundingInstrument.id}
                  </p>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  This instrument is owned by {MCC_HOLDING_OWNER}; you are the assignee. Any return this
                  investment generates is alienated <strong>{Math.round(MCC_BENEFIT_SHARE * 100)}% to{" "}
                  {MCC_HOLDING_OWNER}</strong> and <strong>{Math.round(CLIENT_BENEFIT_SHARE * 100)}% to you</strong>,
                  and the platform calculates and sends each share automatically.
                </p>
                {applyBenefitPreview ? (
                  <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        Indicative return per period ({selectedProgram?.expectedReturn})
                      </span>
                      <span className="font-medium text-foreground">
                        {formatMoney(applyBenefitPreview.grossReturn, applyBenefitPreview.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">{MCC_HOLDING_OWNER} (75%)</span>
                      <span className="font-medium text-foreground">
                        {formatMoney(applyBenefitPreview.mccShare, applyBenefitPreview.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">You keep (25%)</span>
                      <span className="font-semibold text-primary">
                        {formatMoney(applyBenefitPreview.clientShare, applyBenefitPreview.currency)}
                      </span>
                    </div>
                  </div>
                ) : null}
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <Info className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    You still bear 100% of the costs. Figures are indicative, shown per payout period in the
                    instrument&apos;s currency (based on the program&apos;s expected return) — actual distributions
                    follow the realised return.
                  </span>
                </p>
              </div>
            ) : selectedFundingInstrument ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 shrink-0 text-primary" />
                  <p className="text-sm font-medium text-foreground">
                    Backed by your instrument — {selectedFundingInstrument.type} {selectedFundingInstrument.id}
                  </p>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  This is your own instrument ({formatMoney(selectedFundingInstrument.faceValue, selectedFundingInstrument.currency)}),
                  pledged as collateral to fund the program. No cash leaves your master account and there is no
                  benefit split — you keep 100% of the return. It is released when the program ends or the pledge
                  is withdrawn.
                </p>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label>Payout Account</Label>
              <Select value={payoutAccount} onValueChange={setPayoutAccount}>
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="master">Master Account (NatWest)</SelectItem>
                  <SelectItem value="trading">Trading Account (JP Morgan)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-xs text-muted-foreground text-pretty">
                All Yield/PPP applications require mandatory Administrator approval. Submitting this
                form creates a pending request — the program is only executed once an Administrator
                approves it.
              </p>
            </div>
            {formError && (
              <p className="text-sm text-destructive" role="alert">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsApplyOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitApplication}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Submit for Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Investment Details Dialog */}
      <Dialog
        open={!!detailInvestment}
        onOpenChange={(open) => !open && setDetailInvestment(null)}
      >
        <DialogContent className="sm:max-w-[540px]">
          {detailInvestment && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detailInvestment.programName}
                  <Badge
                    variant="outline"
                    className="bg-green-500/10 text-green-500 border-green-500/20"
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Active
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  Investment reference {detailInvestment.id}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-secondary/30 p-3">
                    <p className="text-xs text-muted-foreground">Invested Amount</p>
                    <p className="text-lg font-bold text-foreground mt-1">
                      {formatMoney(detailInvestment.amount, detailInvestment.currency)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-green-500/10 p-3">
                    <p className="text-xs text-muted-foreground">Current Return</p>
                    <p className="text-lg font-bold text-green-500 mt-1">
                      {detailInvestment.currency} 0
                    </p>
                    <p className="text-xs text-muted-foreground">Awaiting first payout</p>
                  </div>
                </div>

                <div className="divide-y divide-border rounded-lg border border-border">
                  {[
                    ["Expected Return", `${detailInvestment.expectedReturn} (${detailInvestment.returnFrequency})`],
                    ["Duration", detailInvestment.duration],
                    ["Source of Funds", detailInvestment.sourceOfFunds],
                    ["Payout Account", detailInvestment.payoutAccount],
                    [
                      "Application Submitted",
                      new Date(detailInvestment.submittedAt).toLocaleString("en-GB"),
                    ],
                    ...(detailInvestment.decidedAt
                      ? [["Approved On", new Date(detailInvestment.decidedAt).toLocaleDateString("en-GB")]]
                      : []),
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm"
                    >
                      <span className="text-muted-foreground">{label}</span>
                      <span className="text-right font-medium text-foreground">{value}</span>
                    </div>
                  ))}
                </div>

                <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs text-muted-foreground text-pretty">
                    Returns are projected, not guaranteed, and are distributed per the program
                    schedule to your nominated payout account. Download the confirmation for your
                    records.
                  </p>
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => setDetailInvestment(null)}>
                  Close
                </Button>
                <Button onClick={() => downloadConfirmation(detailInvestment)}>
                  <Download className="mr-2 h-4 w-4" />
                  Download Confirmation
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={resignTarget !== null} onOpenChange={(open) => !open && !resigning && setResignTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {resignTarget &&
            (() => {
              const standard = yieldCancellationPenalty(resignTarget.amount)
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <LogOut className="h-5 w-5 text-orange-500" />
                      Request early exit
                    </DialogTitle>
                    <DialogDescription>
                      Request to resign from{" "}
                      <span className="font-medium text-foreground">{resignTarget.programName}</span> (
                      {resignTarget.id}) before its term ends. Propose an exit cost (damages) — the administrator
                      agrees the final figure and confirms. The program keeps earning until then.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4 text-sm">
                    <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 p-3">
                      <span className="text-muted-foreground">
                        Standard exit cost ({(YIELD_EARLY_CANCELLATION_PENALTY_RATE * 100).toFixed(0)}% of{" "}
                        {formatMoney(resignTarget.amount, resignTarget.currency)})
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-foreground">
                        {formatMoney(standard, resignTarget.currency)}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="resign-cost">Your proposed exit cost ({resignTarget.currency})</Label>
                      <Input
                        id="resign-cost"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={resignCost}
                        onChange={(e) => setResignCost(e.target.value)}
                        className="text-base md:text-sm"
                      />
                      <button
                        type="button"
                        className="text-xs text-orange-600 hover:underline dark:text-orange-400"
                        onClick={() => setResignCost(standard.toFixed(2))}
                      >
                        Use standard {(YIELD_EARLY_CANCELLATION_PENALTY_RATE * 100).toFixed(0)}%
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="resign-reason">Reason (optional)</Label>
                      <Textarea
                        id="resign-reason"
                        value={resignReason}
                        onChange={(e) => setResignReason(e.target.value)}
                        placeholder="Why you'd like to exit early…"
                        className="min-h-16 text-base md:text-sm"
                      />
                    </div>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      <li>ROI you have already earned is kept — only future ROI stops on termination.</li>
                      <li>The administrator must confirm before anything is charged or terminated.</li>
                      {resignTarget.fundingInstrumentLabel && (
                        <li>
                          On confirmation the funding instrument{" "}
                          <span className="text-foreground">{resignTarget.fundingInstrumentLabel}</span> is released.
                        </li>
                      )}
                    </ul>
                  </div>

                  <DialogFooter className="flex-col gap-2 sm:flex-row">
                    <Button variant="outline" onClick={() => setResignTarget(null)} disabled={resigning}>
                      Keep program
                    </Button>
                    <Button onClick={confirmResign} disabled={resigning}>
                      {resigning ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Sending…
                        </>
                      ) : (
                        <>
                          <LogOut className="mr-2 h-4 w-4" />
                          Send exit request
                        </>
                      )}
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
