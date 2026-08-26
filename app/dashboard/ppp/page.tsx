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
import { cancelMyApprovedYield } from "@/app/actions/approvals"
import {
  yieldCancellationPenalty,
  YIELD_EARLY_CANCELLATION_PENALTY_RATE,
} from "@/lib/ppp-yield"
import { useInstrumentRequests, isMccHeldInstrument } from "@/lib/instrument-requests-store"
import { computeBenefitSplit } from "@/lib/benefit-split"
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
  // Early-cancellation of an ongoing (approved) program: confirm target + busy.
  const [cancelTarget, setCancelTarget] = useState<PPPRequest | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const log = useActivityLog()
  const { requests, addRequest, refresh, hydrated } = usePPPRequests()
  const { instruments } = useInstrumentRequests()
  const { totalIn } = useLedger()

  // Active, MCC HOLDING SA-owned instruments the client can nominate as the
  // funding source. Using one triggers the 75% MCC / 25% client benefit split.
  const mccOwnedInstruments = useMemo(
    () => instruments.filter((i) => i.status === "active" && !i.blocked && isMccHeldInstrument(i)),
    [instruments],
  )
  const selectedFundingInstrument = useMemo(
    () => mccOwnedInstruments.find((i) => i.id === fundingInstrumentId) ?? null,
    [mccOwnedInstruments, fundingInstrumentId],
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
    if (!selectedFundingInstrument || !selectedProgram) return null
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
  }, [selectedFundingInstrument, selectedProgram, amount])
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

  // Approved applications are the client's real, executed investments. We derive
  // the "My Investments" list and the summary stats directly from these so the
  // numbers reflect genuine Administrator-approved activity — never fake demo
  // figures. New investments have no payouts yet until the program runs.
  const approvedInvestments = useMemo(
    () => myApplications.filter((r) => r.status === "approved"),
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

  // Cancel an ongoing (approved) program instantly: earned ROI is kept, future
  // ROI stops, the funding instrument is freed, and the early-cancellation
  // penalty is debited from the Master Account (server-authoritative).
  const confirmCancel = async () => {
    const target = cancelTarget
    if (!target?.approvalId || cancelling) return
    setCancelling(true)
    try {
      const res = await cancelMyApprovedYield(target.approvalId)
      if (!res.ok) {
        toast.error("Could not cancel program", { description: res.error })
        return
      }
      const penaltyLabel =
        res.penalty && res.penalty > 0
          ? `${res.currency} ${res.penalty.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} penalty charged. `
          : ""
      toast.success("Program cancelled", {
        description: `${penaltyLabel}ROI already earned was kept, future ROI stopped, and the funding instrument is now free.`,
      })
      log({
        action: `Cancelled yield / PPP program "${target.programName}"`,
        category: "Yield / PPP",
        details: {
          summary: `Client cancelled the ongoing program ${target.programName} (${target.id}) before term end. ${penaltyLabel}Earned ROI kept; future ROI stopped; funding instrument released.`,
          referenceId: target.id,
        },
      })
      setCancelTarget(null)
      void refresh()
    } finally {
      setCancelling(false)
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
      // If funded by an MCC HOLDING SA-owned instrument, record the 75/25 split
      // so approved returns can be distributed accordingly.
      ...(selectedFundingInstrument
        ? {
            fundingInstrumentId: selectedFundingInstrument.id,
            fundingInstrumentLabel: `${selectedFundingInstrument.type} ${selectedFundingInstrument.id}`,
            mccBenefitRate: MCC_BENEFIT_SHARE,
            clientBenefitRate: CLIENT_BENEFIT_SHARE,
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
            {myApplications.length > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2",
                  pendingCount > 0
                    ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    : "bg-primary/10 text-primary border-primary/20",
                )}
              >
                {myApplications.length}
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
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setCancelTarget(investment)}
                        >
                          <XCircle className="mr-2 h-4 w-4" />
                          Cancel program
                        </Button>
                      </div>
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

            {/* Optional MCC HOLDING SA-owned instrument as the funding source. */}
            {mccOwnedInstruments.length > 0 ? (
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
                    <SelectItem value="none">None — own funds (no split)</SelectItem>
                    {mccOwnedInstruments.map((inst) => {
                      const inUse = committedInstrumentIds.has(inst.id)
                      return (
                        <SelectItem key={inst.id} value={inst.id} disabled={inUse}>
                          {inst.type} {inst.id} · {formatMoney(inst.faceValue, inst.currency)}
                          {inUse ? " · already in use" : ""}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Instruments owned by {MCC_HOLDING_OWNER} (acquired via reserve/assign) can fund this
                  investment. Selecting one applies the benefit split below. An instrument already pledged to
                  another live application can&apos;t be used again until that request is released.
                </p>
              </div>
            ) : null}

            {/* 75 / 25 benefit-split disclosure — only when an MCC instrument is used. */}
            {selectedFundingInstrument ? (
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

      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && !cancelling && setCancelTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {cancelTarget &&
            (() => {
              const penalty = yieldCancellationPenalty(cancelTarget.amount)
              const penaltyLabel = `${cancelTarget.currency} ${penalty.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-destructive" />
                      Cancel ongoing program
                    </DialogTitle>
                    <DialogDescription>
                      Cancel{" "}
                      <span className="font-medium text-foreground">{cancelTarget.programName}</span> (
                      {cancelTarget.id}) before its term ends. This is settled instantly and cannot be undone.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                      <span className="text-foreground">
                        Early-cancellation penalty ({(YIELD_EARLY_CANCELLATION_PENALTY_RATE * 100).toFixed(0)}% of{" "}
                        {formatMoney(cancelTarget.amount, cancelTarget.currency)})
                      </span>
                      <span className="font-semibold text-destructive">{penaltyLabel}</span>
                    </div>
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                      <li>The penalty is debited from your Master Account.</li>
                      <li>ROI you have already earned is kept — only future ROI stops.</li>
                      {cancelTarget.fundingInstrumentLabel && (
                        <li>
                          The funding instrument{" "}
                          <span className="text-foreground">{cancelTarget.fundingInstrumentLabel}</span> is freed and
                          can be returned to the marketplace.
                        </li>
                      )}
                    </ul>
                  </div>

                  <DialogFooter className="flex-col gap-2 sm:flex-row">
                    <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={cancelling}>
                      Keep program
                    </Button>
                    <Button variant="destructive" onClick={confirmCancel} disabled={cancelling}>
                      {cancelling ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Cancelling…
                        </>
                      ) : (
                        <>
                          <XCircle className="mr-2 h-4 w-4" />
                          Cancel &amp; pay {penaltyLabel}
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
