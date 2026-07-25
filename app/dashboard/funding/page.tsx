"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Building2,
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  DollarSign,
  Layers,
  Info,
  Landmark,
  Percent,
  ScrollText,
  Lock,
  ArrowRight,
  Gauge,
  FileText,
  Download,
  AlertTriangle,
  FileCheck2,
  UploadCloud,
  Paperclip,
  X,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
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
  useProjectFunding,
  type UploadedFundingDoc,
  type ProjectFundingRequest,
} from "@/lib/project-funding-store"
import { requestMyFundingClosure, cancelMyFundingClosureRequest } from "@/app/actions/funding"
import {
  AES_TIERS,
  AES_MIN_FACILITY,
  AES_ANNUAL_COST_RATE,
  AES_STANDARD_TENOR_YEARS,
  AES_EARLY_REDEMPTION_RATE,
  AES_LIFECYCLE_STAGES,
  AES_EQUITY_COMPONENTS,
  calculateAesEquity,
  calculateCashCommitment,
  annualCostOfCapital,
  type AesEquityComponent,
} from "@/lib/aes"
import {
  REQUIRED_FUNDING_DOCUMENTS,
  SUPPORTING_DOCUMENTS,
  COMPLIANCE_NOTICES,
  BANK_STATEMENT_WAIVER_FEE,
  BANK_STATEMENT_WAIVER_CURRENCY,
} from "@/lib/funding-documents"
import {
  monthlyCostOfCapital,
  accruedCostOfCapital,
  fundingCreditDate,
  computeFundingSettlement,
} from "@/lib/funding-capital"

const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CHF"] as const

const currencySymbols: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CHF: "CHF ",
}

const SECTORS = [
  "Energy & Power",
  "Infrastructure & Transport",
  "Real Estate & Construction",
  "Industrial & Manufacturing",
  "Natural Resources & Mining",
  "Technology & Telecoms",
  "Healthcare & Life Sciences",
  "Agriculture & Food",
  "Other",
]

const formatMoney = (value: number, currency: string) => {
  const symbol = currencySymbols[currency] ?? `${currency} `
  if (!Number.isFinite(value)) return `${symbol}0`
  if (Math.abs(value) >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(2)}B`
  if (Math.abs(value) >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(2)}M`
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

const formatPercent = (rate: number) => `${(rate * 100).toFixed(2)}%`

const statusConfig = {
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
} as const

// Map an application status to the lifecycle stage index (0-based) it has
// reached, so the tracker reflects genuine progress through the 8-stage AES
// process rather than a fabricated position.
const stageIndexForStatus = (status: keyof typeof statusConfig) => {
  if (status === "pending") return 1 // External Due Diligence underway
  if (status === "approved") return 6 // Funding Activation
  return 2 // Rejected: halted at Risk Scoring & Approval
}

export default function ProjectFundingPage() {
  const [activeTab, setActiveTab] = useState("framework")
  const [projectName, setProjectName] = useState("")
  const [sector, setSector] = useState("")
  const [jurisdiction, setJurisdiction] = useState("")
  const [facility, setFacility] = useState("")
  const [currency, setCurrency] = useState<string>("USD")
  const [components, setComponents] = useState<AesEquityComponent[]>(["cash"])
  const [description, setDescription] = useState("")
  // Documentation gate: clients must confirm the required package and indicate
  // whether a qualifying bank statement will be supplied (drives the waiver fee).
  const [docsAcknowledged, setDocsAcknowledged] = useState(false)
  const [bankStatement, setBankStatement] = useState<"yes" | "no" | "">("")
  // Uploaded documents (metadata only), keyed by required-document id.
  const [uploads, setUploads] = useState<Record<string, UploadedFundingDoc>>({})
  const [waiverFeeAccepted, setWaiverFeeAccepted] = useState(false)
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const handleFileSelected = (docId: string, title: string, file: File | undefined) => {
    if (!file) return
    setUploads((prev) => ({
      ...prev,
      [docId]: { docId, title, fileName: file.name, uploadedAt: new Date().toISOString() },
    }))
    setFormError(null)
  }

  const removeUpload = (docId: string) => {
    setUploads((prev) => {
      const next = { ...prev }
      delete next[docId]
      return next
    })
    const input = fileInputs.current[docId]
    if (input) input.value = ""
  }

  const log = useActivityLog()
  const { requests, addRequest, hydrated, refresh } = useProjectFunding()

  // Early-closure request flow (client asks the Administrator to close a
  // facility early; the payoff is quoted live and settled on approval).
  const [closeTarget, setCloseTarget] = useState<ProjectFundingRequest | null>(null)
  const [closeNote, setCloseNote] = useState("")
  const [closeBusy, setCloseBusy] = useState(false)
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null)

  const handleRequestClosure = async () => {
    if (!closeTarget?.approvalId) {
      toast.error("Cannot request closure", {
        description: "This facility is still syncing. Please refresh and try again.",
      })
      return
    }
    setCloseBusy(true)
    const res = await requestMyFundingClosure(closeTarget.approvalId, closeNote.trim() || undefined)
    setCloseBusy(false)
    if (!res.ok) {
      toast.error("Could not submit request", { description: res.error })
      return
    }
    toast.success("Early-closure request submitted", {
      description: `The Administrator will review your request. Quoted payoff today: ${formatMoney(res.quotedPayoff, res.currency)}.`,
    })
    log({
      action: `Requested early closure of project finance facility "${closeTarget.projectName}"`,
      category: "Project Funding / AES",
      details: {
        referenceId: closeTarget.id,
        facility: formatMoney(closeTarget.facility, closeTarget.currency),
        quotedPayoff: formatMoney(res.quotedPayoff, res.currency),
        decision: "Closure requested",
      },
    })
    setCloseTarget(null)
    setCloseNote("")
    void refresh()
  }

  const handleCancelClosure = async (r: ProjectFundingRequest) => {
    if (!r.approvalId) return
    setCancelBusyId(r.id)
    const res = await cancelMyFundingClosureRequest(r.approvalId)
    setCancelBusyId(null)
    if (!res.ok) {
      toast.error("Could not cancel request", { description: res.error })
      return
    }
    toast.success("Closure request withdrawn", {
      description: `Your early-closure request for "${r.projectName}" was cancelled. The facility remains active.`,
    })
    void refresh()
  }

  const myApplications = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
      ),
    [requests],
  )
  const pendingCount = myApplications.filter((r) => r.status === "pending").length
  const approved = useMemo(() => myApplications.filter((r) => r.status === "approved"), [myApplications])

  // Summary stats derive only from approved applications, so the figures reflect
  // real Administrator-approved funding — never demo numbers.
  const approvedCurrency = approved[0]?.currency ?? "USD"
  const totalFacility = approved.reduce((s, r) => s + r.facility, 0)
  const totalEquityCommitted = approved.reduce((s, r) => s + r.totalEquity, 0)
  const totalAnnualCost = approved.reduce((s, r) => s + annualCostOfCapital(r.facility), 0)

  // Open "My Applications" by default when the client already has applications.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (!hydrated || autoSelectedRef.current) return
    autoSelectedRef.current = true
    if (myApplications.length > 0) setActiveTab("applications")
  }, [hydrated, myApplications.length])

  // Live AES calculation for the application form.
  const numericFacility = Number(facility.replace(/[^0-9.]/g, "")) || 0
  const equity = useMemo(() => calculateAesEquity(numericFacility), [numericFacility])
  const cashCommitment = useMemo(
    () => calculateCashCommitment(numericFacility, equity.totalEquity),
    [numericFacility, equity.totalEquity],
  )
  const annualCost = annualCostOfCapital(numericFacility)

  const toggleComponent = (id: AesEquityComponent, checked: boolean) => {
    setComponents((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((c) => c !== id)))
  }

  const resetForm = () => {
    setProjectName("")
    setSector("")
    setJurisdiction("")
    setFacility("")
    setCurrency("USD")
    setComponents(["cash"])
    setDescription("")
    setDocsAcknowledged(false)
    setBankStatement("")
    setUploads({})
    setWaiverFeeAccepted(false)
    Object.values(fileInputs.current).forEach((input) => {
      if (input) input.value = ""
    })
    setFormError(null)
  }

  const submitApplication = () => {
    if (!projectName.trim()) {
      setFormError("Please enter the project name.")
      return
    }
    if (!sector) {
      setFormError("Please select the project sector.")
      return
    }
    if (!jurisdiction.trim()) {
      setFormError("Please enter the project jurisdiction (country).")
      return
    }
    if (!numericFacility || numericFacility < AES_MIN_FACILITY) {
      setFormError(
        `The minimum financing facility structured under AES is ${formatMoney(AES_MIN_FACILITY, currency)}.`,
      )
      return
    }
    if (components.length === 0) {
      setFormError("Select at least one equity component (assets, instruments, and/or cash).")
      return
    }
    if (bankStatement === "") {
      setFormError(
        "Please indicate whether you will provide a qualifying bank statement (Documentation step).",
      )
      return
    }

    const bankStatementProvided = bankStatement === "yes"
    const waiverFeeApplies = !bankStatementProvided

    // Every required document must be attached, except the bank statement when
    // the client opts for the upfront waiver-fee path instead.
    const missing = REQUIRED_FUNDING_DOCUMENTS.filter((doc) => {
      if (doc.id === "bank-statement" && !bankStatementProvided) return false
      return !uploads[doc.id]
    })
    if (missing.length > 0) {
      setFormError(`Please attach all required documents. Missing: ${missing.map((d) => d.title).join(", ")}.`)
      return
    }
    if (waiverFeeApplies && !waiverFeeAccepted) {
      setFormError(
        `Without a bank statement you must accept the upfront ${BANK_STATEMENT_WAIVER_CURRENCY} ${BANK_STATEMENT_WAIVER_FEE.toLocaleString()} evaluation fee to proceed.`,
      )
      return
    }
    if (!docsAcknowledged) {
      setFormError(
        "Please confirm you will submit the complete required documentation package before applying.",
      )
      return
    }

    const uploadedDocuments = Object.values(uploads)

    const request = addRequest({
      id: `PF-REQ-${new Date().getTime().toString().slice(-8)}`,
      projectName: projectName.trim(),
      sector,
      jurisdiction: jurisdiction.trim(),
      description: description.trim() || undefined,
      currency,
      facility: numericFacility,
      totalEquity: equity.totalEquity,
      effectiveRate: equity.effectiveRate,
      equityComponents: components,
      cashCommitmentMin: cashCommitment.min,
      cashCommitmentMax: cashCommitment.max,
      documentsAcknowledged: true,
      bankStatementProvided,
      waiverFeeApplies,
      waiverFeeAccepted: waiverFeeApplies ? waiverFeeAccepted : false,
      waiverFeeAmount: waiverFeeApplies ? BANK_STATEMENT_WAIVER_FEE : undefined,
      waiverFeeCurrency: waiverFeeApplies ? BANK_STATEMENT_WAIVER_CURRENCY : undefined,
      uploadedDocuments,
    })

    log({
      action: `Submitted project funding application "${projectName.trim()}" for Administrator approval`,
      category: "Project Funding / AES",
      details: {
        summary: `Client submitted a project funding dossier for "${projectName.trim()}" (${sector}, ${jurisdiction.trim()}) requesting a facility of ${formatMoney(numericFacility, currency)}. The AES tiered matrix computed a total equity requirement of ${formatMoney(equity.totalEquity, currency)} (effective rate ${formatPercent(equity.effectiveRate)}). The application is pending mandatory Administrator approval and external due diligence.`,
        referenceId: request.id,
        project: projectName.trim(),
        sector,
        jurisdiction: jurisdiction.trim(),
        facilityRequested: formatMoney(numericFacility, currency),
        totalEquityRequirement: formatMoney(equity.totalEquity, currency),
        effectiveEquityRate: formatPercent(equity.effectiveRate),
        equityComposition: components
          .map((c) => AES_EQUITY_COMPONENTS.find((x) => x.id === c)?.label ?? c)
          .join(", "),
        upfrontCashCommitment: `${formatMoney(cashCommitment.min, currency)} – ${formatMoney(cashCommitment.max, currency)}`,
        annualCostOfCapital: `${formatMoney(annualCost, currency)} (1.8%)`,
        documentationAcknowledged: "Yes — full required package",
        documentsAttached: `${uploadedDocuments.length} file(s): ${uploadedDocuments.map((d) => `${d.title} (${d.fileName})`).join("; ")}`,
        bankStatementProvided: bankStatementProvided ? "Yes" : "No",
        bankStatementWaiverFee: waiverFeeApplies
          ? `${BANK_STATEMENT_WAIVER_CURRENCY} ${BANK_STATEMENT_WAIVER_FEE.toLocaleString()} accepted (no bank statement)`
          : "Not applicable",
        status: "Pending Administrator Approval",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Project funding application submitted", {
      description: `"${projectName.trim()}" is pending Administrator approval and external due diligence.`,
    })
    resetForm()
    setActiveTab("applications")
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground text-balance">Project Funding</h1>
          <p className="text-sm text-muted-foreground">
            Institutional project finance via the MCC Capital Adaptive Equity System (AES)
          </p>
        </div>
        <Badge variant="outline" className="w-fit border-primary/20 bg-primary/10 text-primary">
          <ShieldCheck className="mr-1 h-3 w-3" />
          AES Framework
        </Badge>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border bg-card">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Approved Facility</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {totalFacility > 0 ? formatMoney(totalFacility, approvedCurrency) : "—"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {approved.length} {approved.length === 1 ? "project" : "projects"}
                </p>
              </div>
              <div className="rounded-lg bg-primary/10 p-3">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Equity Committed</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {totalEquityCommitted > 0 ? formatMoney(totalEquityCommitted, approvedCurrency) : "—"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Across approved facilities</p>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-3">
                <Layers className="h-5 w-5 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Annual Cost @ 1.8%</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {totalAnnualCost > 0 ? formatMoney(totalAnnualCost, approvedCurrency) : "—"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Fixed institutional rate</p>
              </div>
              <div className="rounded-lg bg-green-500/10 p-3">
                <Percent className="h-5 w-5 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Applications</p>
                <p className="mt-1 text-2xl font-bold text-foreground">{myApplications.length}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {pendingCount} pending review
                </p>
              </div>
              <div className="rounded-lg bg-orange-500/10 p-3">
                <ScrollText className="h-5 w-5 text-orange-400" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="framework">AES Framework</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
          <TabsTrigger value="apply">Apply for Funding</TabsTrigger>
          <TabsTrigger value="applications">
            My Applications
            {myApplications.length > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2",
                  pendingCount > 0
                    ? "border-yellow-500/20 bg-yellow-500/10 text-yellow-500"
                    : "border-primary/20 bg-primary/10 text-primary",
                )}
              >
                {myApplications.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ---------------- Framework ---------------- */}
        <TabsContent value="framework" className="mt-6 space-y-6">
          <Card className="border-primary/20 bg-gradient-to-r from-primary/10 to-primary/5">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h3 className="font-semibold text-foreground">How the Adaptive Equity System works</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    MCC Capital invests directly into your project, sourcing capital through its
                    institutional credit line at a fixed 1.8% annual cost. In exchange, you provide a
                    risk-proportionate equity position calibrated by the AES tiered matrix. Equity
                    assets remain fully owned by you &mdash; MCC takes no ownership and places no lien.
                    Funds are never transferred directly to principals; they are disbursed under
                    treasury control to verified suppliers, contractors, and beneficiaries.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Tiered equity matrix */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Gauge className="h-5 w-5 text-primary" />
                Tiered Equity Rate Matrix
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Progressive calculation across tranches &mdash; not a flat rate. Each band&apos;s rate
                applies only to the capital within it.
              </p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Tranche Range</th>
                      <th className="py-2 pr-4 font-medium">Equity Rate</th>
                      <th className="py-2 font-medium">Positioning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {AES_TIERS.map((tier) => (
                      <tr key={tier.label} className="border-b border-border/50">
                        <td className="py-2.5 pr-4 font-medium text-foreground">{tier.label}</td>
                        <td className="py-2.5 pr-4">
                          <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary">
                            {formatPercent(tier.rate)}
                          </Badge>
                        </td>
                        <td className="py-2.5 text-muted-foreground">{tier.positioning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Equity composition */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Accepted Equity Composition</CardTitle>
              <p className="text-sm text-muted-foreground">
                Equity may be satisfied with one or a combination of the following. All instruments
                must be unencumbered, free of liens, and verifiable through due diligence.
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              {AES_EQUITY_COMPONENTS.map((c) => (
                <div key={c.id} className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="font-medium text-foreground">{c.label}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.description}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 8-stage lifecycle */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">AES Operational Lifecycle</CardTitle>
              <p className="text-sm text-muted-foreground">
                End-to-end deployment from submission to controlled disbursement.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {AES_LIFECYCLE_STAGES.map((stage) => (
                <div key={stage.phase} className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {stage.phase}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{stage.name}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{stage.description}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Protections */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <Lock className="h-5 w-5 text-primary" />
                Investor &amp; Principal Protections
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {[
                "Equity assets are never charged, pledged, or encumbered by MCC Capital — ownership and control remain with the client.",
                "The 1.8% annual return is the sole cost of capital. No management, arrangement, or performance fees.",
                `Standard investment tenor of ${AES_STANDARD_TENOR_YEARS} years, with structured early redemption provisions where applicable.`,
                `Early redemption requires remitting ${formatPercent(AES_EARLY_REDEMPTION_RATE)} of the residual investment balance as settlement.`,
                "Principal identity is not disclosed to the lending institution; external banking is conducted under the MCC fiduciary umbrella.",
                "Independent due diligence by JURIS TREUHAND AG (Zurich) at no cost to the principal; disputes fall under the Canton of Geneva.",
              ].map((text) => (
                <div key={text} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                  <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setActiveTab("documentation")}>
              View Required Documentation
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </TabsContent>

        {/* ---------------- Documentation ---------------- */}
        <TabsContent value="documentation" className="mt-6 space-y-6">
          <Card className="border-primary/20 bg-gradient-to-r from-primary/10 to-primary/5">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h3 className="font-semibold text-foreground">
                    Required Documentation for Application
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    The following package must be submitted in full before MCC Capital begins its
                    review. The LOI and CIS must follow the MCC templates provided below.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Required documents */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Required Documents</CardTitle>
              <p className="text-sm text-muted-foreground">
                Six mandatory items. Download the MCC templates where indicated.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {REQUIRED_FUNDING_DOCUMENTS.map((doc, idx) => (
                <div
                  key={doc.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {idx + 1}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{doc.title}</p>
                        {doc.templated && (
                          <Badge
                            variant="outline"
                            className="border-primary/20 bg-primary/10 text-[10px] text-primary"
                          >
                            MCC template
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {doc.description}
                      </p>
                    </div>
                  </div>
                  {doc.template && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="shrink-0 self-start sm:self-center"
                    >
                      <a href={doc.template} download>
                        <Download className="mr-1.5 h-4 w-4" />
                        Template
                      </a>
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Supporting templates */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg font-semibold">Supporting Templates</CardTitle>
              <p className="text-sm text-muted-foreground">
                Additional forms MCC may require during onboarding.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {SUPPORTING_DOCUMENTS.map((doc) => (
                <div
                  key={doc.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{doc.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {doc.description}
                      </p>
                    </div>
                  </div>
                  {doc.template && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="shrink-0 self-start sm:self-center"
                    >
                      <a href={doc.template} download>
                        <Download className="mr-1.5 h-4 w-4" />
                        Template
                      </a>
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Compliance notices */}
          <Card className="border-yellow-500/20 bg-yellow-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg font-semibold">
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
                Important Compliance Notice
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3">
                <DollarSign className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                <p className="text-sm leading-relaxed text-foreground">
                  {COMPLIANCE_NOTICES.bankStatement}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {COMPLIANCE_NOTICES.standing}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {COMPLIANCE_NOTICES.review}
                </p>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-green-500/20 bg-green-500/10 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                <p className="text-sm font-medium leading-relaxed text-foreground">
                  {COMPLIANCE_NOTICES.assurance}
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => setActiveTab("apply")}>
              Continue to Application
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </TabsContent>

        {/* ---------------- Apply ---------------- */}
        <TabsContent value="apply" className="mt-6">
          <div className="grid gap-6 lg:grid-cols-5">
            {/* Form */}
            <Card className="border-border bg-card lg:col-span-3">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg font-semibold">Project Funding Application</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Submit your project dossier. Approval is subject to external due diligence and a
                  formal risk score.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="pf-name">Project Name</Label>
                  <Input
                    id="pf-name"
                    placeholder="e.g. Adriatic Solar Park Phase II"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Sector</Label>
                    <Select value={sector} onValueChange={setSector}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select sector" />
                      </SelectTrigger>
                      <SelectContent>
                        {SECTORS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pf-jurisdiction">Jurisdiction (Country)</Label>
                    <Input
                      id="pf-jurisdiction"
                      placeholder="e.g. Germany"
                      value={jurisdiction}
                      onChange={(e) => setJurisdiction(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="pf-facility">Financing Facility Requested</Label>
                    <Input
                      id="pf-facility"
                      inputMode="decimal"
                      placeholder="e.g. 50,000,000"
                      value={facility}
                      onChange={(e) => setFacility(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Currency</Label>
                    <Select value={currency} onValueChange={setCurrency}>
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
                <p className="text-xs text-muted-foreground">
                  Minimum facility: {formatMoney(AES_MIN_FACILITY, currency)}
                </p>

                <div className="space-y-2">
                  <Label>Equity Composition</Label>
                  <div className="space-y-2">
                    {AES_EQUITY_COMPONENTS.map((c) => (
                      <label
                        key={c.id}
                        htmlFor={`pf-comp-${c.id}`}
                        className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:bg-muted/40"
                      >
                        <Checkbox
                          id={`pf-comp-${c.id}`}
                          checked={components.includes(c.id)}
                          onCheckedChange={(checked) => toggleComponent(c.id, checked === true)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="block text-sm font-medium text-foreground">{c.label}</span>
                          <span className="block text-xs leading-relaxed text-muted-foreground">
                            {c.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pf-desc">Project Description (optional)</Label>
                  <Textarea
                    id="pf-desc"
                    placeholder="Briefly describe the project, its purpose, and intended use of funds."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>

                <Separator />

                {/* Documentation upload gate */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Required Documentation</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 text-xs text-primary hover:bg-transparent hover:underline"
                      onClick={() => setActiveTab("documentation")}
                    >
                      View list &amp; templates
                    </Button>
                  </div>

                  {/* Always-required documents (everything except the bank statement) */}
                  {REQUIRED_FUNDING_DOCUMENTS.filter((d) => d.id !== "bank-statement").map((doc) => {
                    const uploaded = uploads[doc.id]
                    return (
                      <div key={doc.id} className="rounded-lg border border-border bg-muted/20 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium text-foreground">{doc.title}</p>
                              {doc.templated && (
                                <Badge
                                  variant="outline"
                                  className="border-primary/20 bg-primary/10 text-[10px] text-primary"
                                >
                                  MCC template
                                </Badge>
                              )}
                            </div>
                            {uploaded ? (
                              <p className="mt-1 flex items-center gap-1.5 text-xs text-green-500">
                                <Paperclip className="h-3 w-3 shrink-0" />
                                <span className="truncate">{uploaded.fileName}</span>
                              </p>
                            ) : (
                              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                {doc.description}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {uploaded && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => removeUpload(doc.id)}
                                aria-label={`Remove ${doc.title}`}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                            <input
                              ref={(el) => {
                                fileInputs.current[doc.id] = el
                              }}
                              type="file"
                              className="hidden"
                              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                              onChange={(e) => handleFileSelected(doc.id, doc.title, e.target.files?.[0])}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputs.current[doc.id]?.click()}
                            >
                              <UploadCloud className="mr-1.5 h-4 w-4" />
                              {uploaded ? "Replace" : "Upload"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Will you provide a qualifying bank statement (not older than 1 month, showing
                      3 months of transactions and current balance)?
                    </Label>
                    <Select
                      value={bankStatement}
                      onValueChange={(v) => {
                        setBankStatement(v as "yes" | "no")
                        // Clear the opposite path's data to avoid stale state.
                        if (v === "yes") setWaiverFeeAccepted(false)
                        if (v === "no") removeUpload("bank-statement")
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select an option" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="yes">Yes — bank statement will be provided</SelectItem>
                        <SelectItem value="no">No — bank statement will not be provided</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Bank statement upload (when provided) */}
                  {bankStatement === "yes" && (
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">Bank Statement</p>
                          {uploads["bank-statement"] ? (
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-green-500">
                              <Paperclip className="h-3 w-3 shrink-0" />
                              <span className="truncate">{uploads["bank-statement"].fileName}</span>
                            </p>
                          ) : (
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                              Not older than 1 month, showing at least 3 months of transactions and
                              the current balance.
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {uploads["bank-statement"] && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => removeUpload("bank-statement")}
                              aria-label="Remove bank statement"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                          <input
                            ref={(el) => {
                              fileInputs.current["bank-statement"] = el
                            }}
                            type="file"
                            className="hidden"
                            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                            onChange={(e) =>
                              handleFileSelected("bank-statement", "Bank Statement", e.target.files?.[0])
                            }
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputs.current["bank-statement"]?.click()}
                          >
                            <UploadCloud className="mr-1.5 h-4 w-4" />
                            {uploads["bank-statement"] ? "Replace" : "Upload"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Waiver fee path (no bank statement) */}
                  {bankStatement === "no" && (
                    <div className="space-y-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                        <p className="text-xs leading-relaxed text-foreground">
                          Without a bank statement, an upfront fee of {BANK_STATEMENT_WAIVER_CURRENCY}{" "}
                          {BANK_STATEMENT_WAIVER_FEE.toLocaleString()} is required prior to any
                          evaluation. Applicants unable to provide either will not be considered, and
                          all submitted documents will be permanently deleted for compliance.
                        </p>
                      </div>
                      <label
                        htmlFor="pf-waiver-fee"
                        className="flex cursor-pointer items-start gap-3 rounded-lg border border-yellow-500/20 bg-card/40 p-2.5"
                      >
                        <Checkbox
                          id="pf-waiver-fee"
                          checked={waiverFeeAccepted}
                          onCheckedChange={(checked) => setWaiverFeeAccepted(checked === true)}
                          className="mt-0.5"
                        />
                        <span className="text-xs leading-relaxed text-foreground">
                          I accept the upfront {BANK_STATEMENT_WAIVER_CURRENCY}{" "}
                          {BANK_STATEMENT_WAIVER_FEE.toLocaleString()} evaluation fee in lieu of a
                          bank statement.
                        </span>
                      </label>
                    </div>
                  )}

                  <label
                    htmlFor="pf-docs-ack"
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:bg-muted/40"
                  >
                    <Checkbox
                      id="pf-docs-ack"
                      checked={docsAcknowledged}
                      onCheckedChange={(checked) => setDocsAcknowledged(checked === true)}
                      className="mt-0.5"
                    />
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      I confirm the attached documentation package is complete and accurate, and
                      acknowledge that customers not in good economic standing are automatically
                      rejected by compliance.
                    </span>
                  </label>
                </div>

                {formError && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}

                <Button className="w-full" onClick={submitApplication}>
                  Submit for Approval
                </Button>
              </CardContent>
            </Card>

            {/* Live AES calculation */}
            <Card className="border-border bg-card lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg font-semibold">AES Equity Calculation</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Live, based on the facility you enter. Progressive across tranches.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground">Total Equity Requirement</p>
                  <p className="mt-1 text-3xl font-bold text-foreground">
                    {formatMoney(equity.totalEquity, currency)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Effective rate {formatPercent(equity.effectiveRate)} on{" "}
                    {formatMoney(numericFacility, currency)} facility
                  </p>
                </div>

                {numericFacility > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Tranche Breakdown
                    </p>
                    {equity.tranches
                      .filter((t) => t.amountInBand > 0)
                      .map((t) => (
                        <div key={t.tier.label} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {formatMoney(t.amountInBand, currency)} @ {formatPercent(t.tier.rate)}
                          </span>
                          <span className="font-medium text-foreground">
                            {formatMoney(t.equityForBand, currency)}
                          </span>
                        </div>
                      ))}
                  </div>
                )}

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Upfront Cash Commitment</p>
                      <p className="text-xs text-muted-foreground">
                        0.1% of facility &rarr; 10% of equity, set by risk score
                      </p>
                    </div>
                    <p className="text-right text-sm font-medium text-foreground">
                      {formatMoney(cashCommitment.min, currency)}
                      <span className="text-muted-foreground"> – </span>
                      {formatMoney(cashCommitment.max, currency)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">Annual Cost of Capital</p>
                    <p className="text-sm font-medium text-foreground">
                      {formatMoney(annualCost, currency)}{" "}
                      <span className="text-xs text-muted-foreground">@ 1.8%</span>
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">Standard Tenor</p>
                    <p className="text-sm font-medium text-foreground">
                      {AES_STANDARD_TENOR_YEARS} years
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Figures are indicative. The final cash commitment is fixed on approval using the
                    risk score (0&ndash;10) issued by JURIS TREUHAND AG.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ---------------- My Applications ---------------- */}
        <TabsContent value="applications" className="mt-6 space-y-4">
          {!hydrated ? (
            <Card className="border-border bg-card">
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Loading applications…
              </CardContent>
            </Card>
          ) : myApplications.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
                <div className="rounded-full bg-muted/40 p-3">
                  <Building2 className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium text-foreground">No applications yet</p>
                  <p className="text-sm text-muted-foreground">
                    Submit a project dossier to begin the AES funding process.
                  </p>
                </div>
                <Button onClick={() => setActiveTab("apply")}>Apply for Funding</Button>
              </CardContent>
            </Card>
          ) : (
            myApplications.map((r) => {
              const cfg = statusConfig[r.status]
              const StatusIcon = cfg.icon
              const currentStage = stageIndexForStatus(r.status)
              return (
                <Card key={r.id} className="border-border bg-card">
                  <CardHeader className="pb-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base font-semibold">{r.projectName}</CardTitle>
                          <Badge variant="outline" className={cn("gap-1", cfg.color)}>
                            <StatusIcon className="h-3 w-3" />
                            {cfg.label}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.sector} · {r.jurisdiction} · Ref {r.id}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-foreground">
                          {formatMoney(r.facility, r.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">Facility requested</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">Total Equity</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatMoney(r.totalEquity, r.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatPercent(r.effectiveRate)} effective
                        </p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">Upfront Cash Commitment</p>
                        <p className="text-sm font-semibold text-foreground">
                          {r.status === "approved" && typeof r.cashCommitment === "number"
                            ? formatMoney(r.cashCommitment, r.currency)
                            : `${formatMoney(r.cashCommitmentMin, r.currency)} – ${formatMoney(r.cashCommitmentMax, r.currency)}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {r.status === "approved" && typeof r.riskScore === "number"
                            ? `Risk score ${r.riskScore}/10`
                            : "Range, pre-approval"}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">Annual Cost @ 1.8%</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatMoney(annualCostOfCapital(r.facility), r.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {AES_STANDARD_TENOR_YEARS}-year tenor
                        </p>
                      </div>
                    </div>

                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Equity composition</p>
                      <div className="flex flex-wrap gap-2">
                        {r.equityComponents.map((c) => (
                          <Badge key={c} variant="outline" className="border-border bg-muted/30 text-foreground">
                            {AES_EQUITY_COMPONENTS.find((x) => x.id === c)?.label ?? c}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {r.uploadedDocuments && r.uploadedDocuments.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          Documentation package ({r.uploadedDocuments.length})
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {r.uploadedDocuments.map((d) => (
                            <Badge
                              key={d.docId}
                              variant="outline"
                              className="gap-1 border-border bg-muted/30 font-normal text-foreground"
                            >
                              <Paperclip className="h-3 w-3" />
                              {d.title}
                            </Badge>
                          ))}
                        </div>
                        {r.waiverFeeApplies && (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-yellow-500">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            Upfront evaluation fee {r.waiverFeeCurrency} {(r.waiverFeeAmount ?? 0).toLocaleString()}{" "}
                            {r.waiverFeeAccepted ? "accepted (no bank statement)" : "required"}
                          </p>
                        )}
                      </div>
                    )}

                    {r.status === "approved" && (
                      <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-green-500">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Facility activated &amp; credited to master account
                        </p>
                        <div className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Capital credited</span>
                            <span className="font-medium text-foreground">
                              {formatMoney(r.facility, r.currency)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Next monthly charge</span>
                            <span className="font-medium text-foreground">
                              {formatMoney(monthlyCostOfCapital(r.facility), r.currency)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Interest accrued to date</span>
                            <span className="font-medium text-amber-500">
                              {formatMoney(accruedCostOfCapital(r.facility, fundingCreditDate(r)), r.currency)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Accruing since</span>
                            <span className="font-medium text-foreground">
                              {fundingCreditDate(r).toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground text-pretty">
                          The approved facility is credited to your master account balance. The 1.8%
                          annual debit interest accrues from the funding date and is charged monthly
                          (÷12) at each calendar month-end, with the first month pro-rated to the
                          activation day. Each charge is logged in your transaction history.
                        </p>
                      </div>
                    )}

                    {/* Early liquidation / closure */}
                    {r.status === "approved" && r.closedAt && r.settlement ? (
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                          Facility closed &amp; settled
                        </p>
                        <div className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Principal repaid</span>
                            <span className="font-medium text-foreground">{formatMoney(r.settlement.principal, r.settlement.currency)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Interest settled</span>
                            <span className="font-medium text-foreground">{formatMoney(r.settlement.interest, r.settlement.currency)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Early-exit fee</span>
                            <span className="font-medium text-foreground">{formatMoney(r.settlement.fee, r.settlement.currency)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">Total settled</span>
                            <span className="font-semibold text-foreground">{formatMoney(r.settlement.total, r.settlement.currency)}</span>
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Closed {new Date(r.closedAt).toLocaleString("en-GB")}
                          {r.closureKind === "client_early" ? " · early closure" : " · recalled by administrator"}
                        </p>
                      </div>
                    ) : r.status === "approved" && r.closureRequest ? (
                      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-yellow-600 dark:text-yellow-500">
                          <Clock className="h-3.5 w-3.5" />
                          Early-closure request pending administrator approval
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                          <span className="text-muted-foreground">Quoted payoff</span>
                          <span className="font-medium text-foreground">
                            {formatMoney(r.closureRequest.quotedPayoff, r.closureRequest.currency)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Requested {new Date(r.closureRequest.requestedAt).toLocaleString("en-GB")}. The final
                          payoff is recalculated at settlement.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          disabled={cancelBusyId === r.id}
                          onClick={() => void handleCancelClosure(r)}
                        >
                          {cancelBusyId === r.id ? "Cancelling…" : "Withdraw request"}
                        </Button>
                      </div>
                    ) : r.status === "approved" ? (
                      (() => {
                        const payoff = computeFundingSettlement(r, new Date())
                        return (
                          <div className="rounded-lg border border-border bg-muted/20 p-3">
                            <p className="text-xs font-medium text-foreground">Close facility early</p>
                            <p className="mt-1 text-xs text-muted-foreground text-pretty">
                              Repay the facility ahead of its {AES_STANDARD_TENOR_YEARS}-year tenor. An early-exit
                              fee ({Math.round(AES_EARLY_REDEMPTION_RATE * 100)}% of the remaining-tenor cost of
                              capital) applies. Closure is settled once the Administrator approves your request.
                            </p>
                            <div className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Principal</span>
                                <span className="font-medium text-foreground">{formatMoney(payoff.principal, payoff.currency)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Interest to date</span>
                                <span className="font-medium text-foreground">{formatMoney(payoff.interest, payoff.currency)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Early-exit fee</span>
                                <span className="font-medium text-foreground">{formatMoney(payoff.fee, payoff.currency)}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">Estimated payoff today</span>
                                <span className="font-semibold text-foreground">{formatMoney(payoff.total, payoff.currency)}</span>
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-3"
                              onClick={() => {
                                setCloseNote("")
                                setCloseTarget(r)
                              }}
                            >
                              Request early closure
                            </Button>
                          </div>
                        )
                      })()
                    ) : null}

                    {r.decisionNote && (
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">Administrator note</p>
                        <p className="text-sm text-foreground">{r.decisionNote}</p>
                      </div>
                    )}

                    {/* Lifecycle tracker */}
                    {r.status !== "rejected" && (
                      <div>
                        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          AES Lifecycle
                        </p>
                        <div className="space-y-2">
                          {AES_LIFECYCLE_STAGES.map((stage, idx) => {
                            const done = idx < currentStage
                            const active = idx === currentStage
                            return (
                              <div key={stage.phase} className="flex items-center gap-3">
                                <div
                                  className={cn(
                                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                                    done && "bg-green-500/15 text-green-500",
                                    active && "bg-primary/15 text-primary ring-1 ring-primary/40",
                                    !done && !active && "bg-muted/40 text-muted-foreground",
                                  )}
                                >
                                  {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : stage.phase}
                                </div>
                                <span
                                  className={cn(
                                    "text-sm",
                                    active ? "font-medium text-foreground" : "text-muted-foreground",
                                  )}
                                >
                                  {stage.name}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Submitted {new Date(r.submittedAt).toLocaleString("en-GB")}
                      {r.decidedAt && ` · Decided ${new Date(r.decidedAt).toLocaleString("en-GB")}`}
                    </p>
                  </CardContent>
                </Card>
              )
            })
          )}
        </TabsContent>
      </Tabs>

      {/* Early-closure confirmation with a live payoff breakdown */}
      <Dialog open={!!closeTarget} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <DialogContent>
          {closeTarget &&
            (() => {
              const payoff = computeFundingSettlement(closeTarget, new Date())
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>Confirm early closure</DialogTitle>
                    <DialogDescription>
                      Request early closure of &ldquo;{closeTarget.projectName}&rdquo; ({closeTarget.id}).
                      On Administrator approval, the payoff below is debited from your master account
                      balance and interest stops accruing.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Principal</span>
                        <span className="text-foreground">
                          {formatMoney(payoff.principal, payoff.currency)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-muted-foreground">Outstanding interest</span>
                        <span className="text-foreground">
                          {formatMoney(payoff.interest, payoff.currency)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-muted-foreground">
                          Early-exit fee ({formatPercent(AES_EARLY_REDEMPTION_RATE)})
                        </span>
                        <span className="text-foreground">
                          {formatMoney(payoff.fee, payoff.currency)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 font-semibold">
                        <span className="text-foreground">Payoff today</span>
                        <span className="text-foreground">
                          {formatMoney(payoff.total, payoff.currency)}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground text-pretty">
                      This quote is indicative &mdash; the final payoff is recalculated at the moment the
                      Administrator settles the facility.
                    </p>
                    <div className="space-y-1.5">
                      <label htmlFor="closure-note" className="text-xs font-medium text-foreground">
                        Reason (optional)
                      </label>
                      <Textarea
                        id="closure-note"
                        value={closeNote}
                        onChange={(e) => setCloseNote(e.target.value)}
                        placeholder="Add an optional note for the Administrator"
                        rows={3}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCloseTarget(null)} disabled={closeBusy}>
                      Cancel
                    </Button>
                    <Button onClick={handleRequestClosure} disabled={closeBusy}>
                      {closeBusy ? "Submitting\u2026" : "Submit request"}
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
