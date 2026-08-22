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
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generatePPPConfirmationPdf } from "@/lib/ppp-confirmation-pdf"
import { Download } from "lucide-react"
import { getActiveInstitutionalYields } from "@/app/actions/institutional-yields"
import { type InstitutionalYield } from "@/lib/institutional-yields-shared"

const programs = [
  {
    id: "PPP-MICRO-001",
    name: "Micro Cap Program",
    type: "micro",
    minInvestment: 50000000,
    maxInvestment: 100000000,
    currency: "USD",
    expectedReturn: "20-40%",
    returnFrequency: "Monthly",
    duration: "12 months",
    status: "open",
    spotsAvailable: 3,
    totalSpots: 10,
    riskLevel: "Medium",
    description:
      "Entry-level PPP designed for investors starting with $50M. Monthly returns with quarterly compounding options.",
    requirements: [
      "PRO or Avant-Garde account",
      "Cash funds or AAA+ rated instruments",
      "12-month commitment",
    ],
  },
  {
    id: "PPP-SMALL-002",
    name: "Small Cap Program",
    type: "small",
    minInvestment: 100000000,
    maxInvestment: 500000000,
    currency: "USD",
    expectedReturn: "40-60%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "open",
    spotsAvailable: 5,
    totalSpots: 8,
    riskLevel: "Medium",
    description:
      "Standard PPP for qualified investors. Monthly distributions with reinvestment options available.",
    requirements: [
      "PRO or Avant-Garde account",
      "Cash funds or Securities (BG/SBLC/MTN)",
      "40-week commitment",
    ],
  },
  {
    id: "PPP-MID-003",
    name: "Mid Cap Program",
    type: "mid",
    minInvestment: 500000000,
    maxInvestment: 1000000000,
    currency: "USD",
    expectedReturn: "60-80%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "limited",
    spotsAvailable: 2,
    totalSpots: 5,
    riskLevel: "Medium-Low",
    description:
      "Premium program for substantial investments. Enhanced returns with priority execution.",
    requirements: [
      "Avant-Garde account required",
      "Verified source of funds",
      "Joint venture agreement",
    ],
  },
  {
    id: "PPP-LARGE-004",
    name: "Large Cap Program",
    type: "large",
    minInvestment: 1000000000,
    maxInvestment: 5000000000,
    currency: "USD",
    expectedReturn: "80-100%",
    returnFrequency: "Monthly",
    duration: "40 banking weeks",
    status: "invite",
    spotsAvailable: 1,
    totalSpots: 3,
    riskLevel: "Low",
    description:
      "Exclusive program for institutional investors and major funds. Maximum returns with dedicated trading desk.",
    requirements: [
      "Avant-Garde account",
      "Direct relationship with trading desk",
    ],
  },
]

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
}

export default function PPPPage() {
  const [isApplyOpen, setIsApplyOpen] = useState(false)
  const [selectedProgram, setSelectedProgram] = useState<typeof programs[0] | null>(null)
  const [activeTab, setActiveTab] = useState("programs")
  const [amount, setAmount] = useState("")
  const [sourceOfFunds, setSourceOfFunds] = useState("")
  const [payoutAccount, setPayoutAccount] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [detailInvestment, setDetailInvestment] = useState<PPPRequest | null>(null)
  const log = useActivityLog()
  const { requests, addRequest, hydrated } = usePPPRequests()
  const { show: showPdf } = usePdfViewer()

  // Administrator-published, bank-partner-sourced institutional yields. Only
  // ACTIVE products are returned by the server, so clients never see pending or
  // closed offerings. Fails closed (empty) if the catalogue is unavailable.
  const { data: activeYields = [] } = useSWR<InstitutionalYield[]>(
    "active-institutional-yields",
    () => getActiveInstitutionalYields(),
    { revalidateOnFocus: false },
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
    setFormError(null)
  }

  const openApplyDialog = (program: typeof programs[0]) => {
    setSelectedProgram(program)
    resetForm()
    setIsApplyOpen(true)
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
        <DialogContent className="sm:max-w-[500px]">
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
    </div>
  )
}
