"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ShieldCheck,
  Lock,
  Check,
  X,
  Clock,
  ArrowUpRight,
  Building2,
  Globe,
  LogOut,
  AlertTriangle,
  FileText,
  TrendingUp,
  Trash2,
  Layers,
  Landmark,
  Ship,
  Package,
  Banknote,
  Gauge,
  Power,
  Users,
  Wallet,
  Award,
  BadgeCheck,
  Repeat,
  ScrollText,
  MessageSquareText,
  Settings,
  ChevronRight,
  ArrowLeft,
  ClipboardList,
  CreditCard,
  Send,
  RefreshCw,
  Handshake,
  ArrowRight,
  Tag,
  Fingerprint,
  User,
  Undo2,
  PackageCheck,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
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
import { cn } from "@/lib/utils"
import { parseSwiftMessage } from "@/lib/swift-mt"
import { useActivityLog } from "@/components/activity-tracker"
import { useLedger } from "@/lib/ledger-store"
import { usePaymentRequests, type PaymentRequest } from "@/lib/payment-requests-store"
import {
  banksForCurrency,
  partnerBankByKey,
  suggestedBankFor,
} from "@/lib/gateway-store"
import { getAllGatewayAccountsAdmin } from "@/app/actions/gateway"
import { listAllSwiftRoutingRequestsAdmin } from "@/app/actions/swift-routing"
import { useInstrumentRequests, type Instrument } from "@/lib/instrument-requests-store"
import {
  useMonetizationRequests,
  type MonetizationRequest,
} from "@/lib/monetization-requests-store"
import { computeTieredInterest } from "@/lib/tiered-debit-interest"
  import { usePPPRequests, type PPPRequest } from "@/lib/ppp-requests-store"
  import { type ProjectFundingRequest } from "@/lib/project-funding-store"
  import { useFiduciaryRequests, type FiduciaryRequest } from "@/lib/fiduciary-requests-store"
  import { calculateCashCommitment, annualCostOfCapital, AES_EQUITY_COMPONENTS } from "@/lib/aes"
import { computeFundingSettlement } from "@/lib/funding-capital"
import { useDOFRequests, type DOFRequest } from "@/lib/dof-requests-store"
import { useDTCRequests, type DTCRequest } from "@/lib/dtc-requests-store"
import { useEuroclearRequests, type EuroclearRequest } from "@/lib/euroclear-requests-store"
import {
  useCommodityDeals,
  DEAL_STAGES,
  type CommodityDeal,
  type DealDocument,
} from "@/lib/commodity-deals-store"
import { formatQuantityWithEquivalent, formatUnitPriceFor } from "@/lib/petroleum-products"
import {
  useLeverageRequests,
  accruedInterest,
  maxLeverageFor,
  leverageRatiosFor,
  LEVERAGE_ACCOUNTS,
  type LeverageRequest,
} from "@/lib/leverage-requests-store"
import { postedLeverageInterest } from "@/lib/leverage-financing"
import { round2 } from "@/lib/interest-accrual"
import { ADMIN_PASSCODE, ADMIN_SESSION_KEY } from "@/lib/admin-config"
import { verifyAdminGate, confirmAdminSession } from "@/app/actions/admin-session"
import { resetServerAccountDataForUser } from "@/app/actions/reset-account"
import { listUsers, type AdminUserView } from "@/app/actions/admin-users"
import { AdminGatewaySection } from "@/components/dashboard/admin-gateway-section"
import { SwiftRoutingQueue } from "@/components/admin/swift-routing-queue"
import { AdminReconciliationSection } from "@/components/dashboard/admin-reconciliation-section"
import { TreasuryManager } from "@/components/admin/treasury-manager"
import { UserManager } from "@/components/admin/user-manager"
import { MembershipManager } from "@/components/admin/membership-manager"
import { BeneficiaryManager } from "@/components/admin/beneficiary-manager"
import { PendingApprovals } from "@/components/admin/pending-approvals"
import {
  adminCountPending,
  adminDecideApproval,
  adminUpdateApprovalRecord,
  adminMarkPaymentDelivered,
} from "@/app/actions/approvals"
import {
  getPaymentStage,
  PAYMENT_STAGE_SHORT,
  PAYMENT_STAGE_BADGE_CLASS,
} from "@/lib/payment-status"
import {
  adminListProjectFinance,
  adminExecuteFundingClosure,
  adminDeclineFundingClosure,
} from "@/app/actions/funding"
import { KIND_LABELS, type ApprovalKind } from "@/lib/approval-kinds"
import { adminListPendingKyc } from "@/app/actions/beneficiaries"
import { BalanceManager } from "@/components/admin/balance-manager"
import { SkrManager } from "@/components/admin/skr-manager"
import { SkrOverview } from "@/components/admin/skr-overview"
import { InstrumentIssuer } from "@/components/admin/instrument-issuer"
import { MarketplaceInstrumentManager } from "@/components/admin/marketplace-instrument-manager"
import { CardManager } from "@/components/admin/card-manager"
import { CertificateManager } from "@/components/admin/certificate-manager"
import { BankekaBroadcastManager } from "@/components/admin/bankeka-broadcast-manager"
 import { SpotDealManager } from "@/components/admin/spot-deal-manager"
import { DocumentTraceability } from "@/components/admin/document-traceability"
import { SecurityAudit } from "@/components/admin/security-audit"
import { ProjectFinanceAdmin } from "@/components/admin/project-finance-admin"
import { toast } from "sonner"

const MASTER_ACCOUNT_CURRENCY = "EUR"

const formatCurrency = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const formatTimestamp = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

export default function AdminPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [passcode, setPasscode] = useState("")
  const [gateError, setGateError] = useState<string | null>(null)
  // Which admin view is open. "menu" shows the dashboard of clickable section
  // cards; any other value renders that single section with a back-to-menu bar.
  const [activeView, setActiveView] = useState<string>("menu")

  const { requests, approveRequest, rejectRequest, markDelivered } = usePaymentRequests()
  const {
    instruments,
    approveInstrument,
    rejectInstrument,
  } = useInstrumentRequests()
  const {
    requests: monetizationRequests,
    approveRequest: approveMonetization,
    rejectRequest: rejectMonetization,
  } = useMonetizationRequests()
  const {
    requests: pppRequests,
    approveRequest: approvePPP,
    rejectRequest: rejectPPP,
  } = usePPPRequests()
  // Project funding is reviewed CROSS-CLIENT (every client's applications), so it
  // is sourced from the DB-backed approvals backbone — NOT the per-user
  // `useProjectFunding` store, which only ever sees the admin's OWN account data
  // (the bug where a client's submission never appeared in the admin queue).
  const [fundingRequests, setFundingRequests] = useState<ProjectFundingRequest[]>([])
  const loadAdminFunding = useCallback(async () => {
    try {
      // Enriched with OWNER identity (name + email) and closure lifecycle fields
      // so the queue can show WHO each facility belongs to and surface early
      // closure requests / settled facilities.
      const res = await adminListProjectFinance(ADMIN_PASSCODE)
      if (!res.ok) return
      setFundingRequests(res.facilities.map((f) => f.record))
    } catch {
      // Non-fatal: the funding review queue just stays empty if it can't load.
    }
  }, [])
  const {
    requests: fiduciaryRequests,
    approveRequest: approveFiduciary,
    rejectRequest: rejectFiduciary,
  } = useFiduciaryRequests()
  const {
    requests: dofRequests,
    approveRequest: approveDOF,
    rejectRequest: rejectDOF,
  } = useDOFRequests()
  const {
    requests: dtcRequests,
    approveRequest: approveDTC,
    rejectRequest: rejectDTC,
  } = useDTCRequests()
  const {
    requests: euroclearRequests,
    approveRequest: approveEuroclear,
    rejectRequest: rejectEuroclear,
  } = useEuroclearRequests()
  const {
    deals: commodityDeals,
    approveDeal,
    rejectDeal,
    verifyDocument,
    rejectDocument,
  } = useCommodityDeals()
  const {
    requests: leverageRequests,
    approveRequest: approveLeverage,
    rejectRequest: rejectLeverage,
    modifyRatio: modifyLeverageRatio,
    approveSwitchOff: approveLeverageSwitchOff,
    rejectSwitchOff: rejectLeverageSwitchOff,
  } = useLeverageRequests()
  const { addReceipt, addDebit, balanceFor, entries: ledgerEntries } = useLedger()
  const logActivity = useActivityLog()

  const [rejectTarget, setRejectTarget] = useState<PaymentRequest | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  // Per-request payout partner bank selection (keyed by payment id). When a
  // request has no explicit choice yet, the approval flow falls back to the
  // currency's suggested correspondent bank.
  const [payoutBankByRequest, setPayoutBankByRequest] = useState<Record<string, string>>({})
  const [rejectInstrumentTarget, setRejectInstrumentTarget] = useState<Instrument | null>(null)
  const [rejectInstrumentReason, setRejectInstrumentReason] = useState("")
  const [rejectPPPTarget, setRejectPPPTarget] = useState<PPPRequest | null>(null)
  const [rejectPPPReason, setRejectPPPReason] = useState("")
  const [rejectFundingTarget, setRejectFundingTarget] = useState<ProjectFundingRequest | null>(null)
  const [rejectFundingReason, setRejectFundingReason] = useState("")
  const [approveFundingTarget, setApproveFundingTarget] = useState<ProjectFundingRequest | null>(null)
  const [approveFundingScore, setApproveFundingScore] = useState("5")
  // Recall / terminate / liquidate a facility (clawback), or approve a client's
  // early-closure request. `kind` records which flow opened the dialog.
  const [closeFundingTarget, setCloseFundingTarget] = useState<{
    facility: ProjectFundingRequest
    kind: "admin_recall" | "client_early"
  } | null>(null)
  const [closeFundingNote, setCloseFundingNote] = useState("")
  const [closeFundingBusy, setCloseFundingBusy] = useState(false)
  const [declineClosureTarget, setDeclineClosureTarget] = useState<ProjectFundingRequest | null>(null)
  const [declineClosureReason, setDeclineClosureReason] = useState("")
  const [rejectFiduciaryTarget, setRejectFiduciaryTarget] = useState<FiduciaryRequest | null>(null)
  const [rejectFiduciaryReason, setRejectFiduciaryReason] = useState("")
  const [rejectDOFTarget, setRejectDOFTarget] = useState<DOFRequest | null>(null)
  const [rejectDOFReason, setRejectDOFReason] = useState("")
  const [rejectMonetizationTarget, setRejectMonetizationTarget] =
    useState<MonetizationRequest | null>(null)
  const [rejectMonetizationReason, setRejectMonetizationReason] = useState("")
  const [swiftViewTarget, setSwiftViewTarget] = useState<MonetizationRequest | null>(null)
  const [rejectDTCTarget, setRejectDTCTarget] = useState<DTCRequest | null>(null)
  const [rejectDTCReason, setRejectDTCReason] = useState("")
  const [rejectEuroclearTarget, setRejectEuroclearTarget] = useState<EuroclearRequest | null>(null)
  const [rejectEuroclearReason, setRejectEuroclearReason] = useState("")
  const [rejectDealTarget, setRejectDealTarget] = useState<CommodityDeal | null>(null)
  const [rejectDealReason, setRejectDealReason] = useState("")
  const [rejectDocTarget, setRejectDocTarget] = useState<{ deal: CommodityDeal; doc: DealDocument } | null>(
    null,
  )
  const [rejectDocReason, setRejectDocReason] = useState("")
  const [rejectLeverageTarget, setRejectLeverageTarget] = useState<LeverageRequest | null>(null)
  const [rejectLeverageReason, setRejectLeverageReason] = useState("")
  const [rejectSwitchOffTarget, setRejectSwitchOffTarget] = useState<LeverageRequest | null>(null)
  const [rejectSwitchOffReason, setRejectSwitchOffReason] = useState("")
  // Modify-ratio dialog: the active line being adjusted, the chosen new ratio
  // and an optional note for the audit trail.
  const [modifyRatioTarget, setModifyRatioTarget] = useState<LeverageRequest | null>(null)
  const [modifyRatioValue, setModifyRatioValue] = useState("")
  const [modifyRatioNote, setModifyRatioNote] = useState("")
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [resetConfirm, setResetConfirm] = useState("")
  const [resetting, setResetting] = useState(false)
  // Danger-Zone target picker: which specific account to reset.
  const [resetAccounts, setResetAccounts] = useState<AdminUserView[]>([])
  const [resetAccountsLoading, setResetAccountsLoading] = useState(false)
  const [resetTargetId, setResetTargetId] = useState<string>("")

  // Restore unlock state for the current tab session — but only after the
  // server re-confirms this session is an admin. A persisted flag alone (e.g.
  // left in sessionStorage by a previous user who logged out on this device)
  // can never unlock the panel; the server role check is authoritative.
  useEffect(() => {
    let cancelled = false
    let flagged = false
    try {
      flagged = window.sessionStorage.getItem(ADMIN_SESSION_KEY) === "true"
    } catch {
      flagged = false
    }
    if (!flagged) return
    ;(async () => {
      try {
        const stillAdmin = await confirmAdminSession()
        if (cancelled) return
        if (stillAdmin) {
          setUnlocked(true)
        } else {
          try {
            window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
          } catch {
            // ignore
          }
        }
      } catch {
        // On error, stay locked and require an explicit unlock.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Count of beneficiaries awaiting a KYC decision (across every client). The
  // BeneficiaryManager owns the full review UI; here we only need the count so
  // KYC can appear in the Pending Decisions command center. Refetched whenever
  // the panel unlocks so the figure is current.
  const [pendingKycCount, setPendingKycCount] = useState(0)
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await adminListPendingKyc(ADMIN_PASSCODE)
        if (!cancelled && res.ok) setPendingKycCount(res.beneficiaries.length)
      } catch {
        // Non-fatal: the KYC tile just shows 0 if the count can't be loaded.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlocked])

  // Count of Payment Gateway account requests awaiting an administrator decision
  // (across EVERY client). Gateway requests live in their own DB table, separate
  // from the approvals backbone, so without this the command center and the
  // Payment Gateway tile would never surface them — the admin would see
  // "nothing to approve" even while clients have pending requests. Refetched on
  // unlock so the figure is current.
  const [pendingGatewayCount, setPendingGatewayCount] = useState(0)
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await getAllGatewayAccountsAdmin(ADMIN_PASSCODE)
        if (!cancelled && res.ok) {
          setPendingGatewayCount(res.accounts.filter((a) => a.status === "pending").length)
        }
      } catch {
        // Non-fatal: the Payment Gateway tile just shows 0 if it can't load.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlocked])

  // Pending SWIFT messages submitted by clients for routing & approval. Without
  // surfacing this count the admin lands on the menu and sees "nothing to
  // approve" even while clients have messages awaiting routing. Refetched on
  // unlock so the figure is current.
  const [pendingSwiftRoutingCount, setPendingSwiftRoutingCount] = useState(0)
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await listAllSwiftRoutingRequestsAdmin(ADMIN_PASSCODE)
        if (!cancelled && res.ok) {
          setPendingSwiftRoutingCount(res.requests.filter((r) => r.status === "pending").length)
        }
      } catch {
        // Non-fatal: the SWIFT Routing tile just shows 0 if it can't load.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlocked])

  // Count of certificate requests awaiting an administrator decision (across
  // EVERY client). Certificate requests live in their own DB table, separate
  // from the approvals backbone, so without this the Certificates tile would
  // always read 0 — leaving the admin to believe there is "nothing to approve"
  // even while a client's request is pending. Read via the certificates Route
  // Handler (not a Server Action) so it is reliable on production/webviews.
  const [pendingCertificateCount, setPendingCertificateCount] = useState(0)
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/admin/certificates", {
          headers: { "x-admin-passcode": ADMIN_PASSCODE },
          cache: "no-store",
        })
        const json = (await res.json()) as { ok: boolean; requests?: unknown[] }
        if (!cancelled && json.ok && Array.isArray(json.requests)) {
          setPendingCertificateCount(json.requests.length)
        }
      } catch {
        // Non-fatal: the Certificates tile just shows 0 if the count can't load.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlocked, activeView])

  // Cross-client pending counts from the DB-backed approvals backbone. Unlike
  // the localStorage stores above (which only ever see the ADMIN's own browser
  // data), this reflects requests submitted by ANY client. It is the source of
  // truth for the unified "All Pending Approvals" dashboard and command center.
  // Refetched whenever the panel unlocks and whenever we return to the menu.
  const [dbPending, setDbPending] = useState<Record<string, number>>({})
  // The type a command-center tile deep-links into when opening the dashboard.
  const [approvalsInitialKind, setApprovalsInitialKind] = useState<ApprovalKind | undefined>(undefined)
  useEffect(() => {
    if (!unlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const counts = await adminCountPending(ADMIN_PASSCODE)
        if (!cancelled) setDbPending(counts)
      } catch {
        // Non-fatal: tiles fall back to 0 if counts can't be loaded.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [unlocked, activeView])

  // Load the cross-client project funding applications whenever the panel
  // unlocks or the admin navigates (mirrors how `dbPending` counts refresh), so
  // the AES review queue always reflects every client's latest submissions.
  useEffect(() => {
    if (!unlocked) return
    void loadAdminFunding()
  }, [unlocked, activeView, loadAdminFunding])

  const dbPendingTotal = useMemo(
    () => Object.values(dbPending).reduce((sum, n) => sum + (n || 0), 0),
    [dbPending],
  )

  const [gateChecking, setGateChecking] = useState(false)
  const handleUnlock = async () => {
    if (gateChecking) return
    setGateChecking(true)
    setGateError(null)
    try {
      // Authorization is decided on the SERVER: the caller must be an admin
      // account AND present the correct PIN. The browser never compares the
      // secret, so it cannot be bypassed by reading the bundle or setting a
      // client flag.
      const res = await verifyAdminGate(passcode.trim())
      if (res.ok) {
        setUnlocked(true)
        setGateError(null)
        setPasscode("")
        try {
          window.sessionStorage.setItem(ADMIN_SESSION_KEY, "true")
        } catch {
          // ignore
        }
      } else if (res.reason === "forbidden") {
        setGateError("This account is not authorized to access the Administrator Panel.")
      } else {
        setGateError("Incorrect administrator passcode. Please try again.")
      }
    } catch {
      setGateError("Could not verify administrator access. Please try again.")
    } finally {
      setGateChecking(false)
    }
  }

  const handleLock = () => {
    setUnlocked(false)
    try {
      window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
    } catch {
      // ignore
    }
  }

  const masterBalance = balanceFor(MASTER_ACCOUNT_CURRENCY)

  const pending = useMemo(
    () =>
      requests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [requests],
  )
  const decided = useMemo(
    () =>
      requests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [requests],
  )

  const pendingInstruments = useMemo(
    () =>
      instruments
        .filter((i) => i.status === "pending")
        .sort(
          (a, b) =>
            new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime(),
        ),
    [instruments],
  )
  const decidedInstruments = useMemo(
    () =>
      instruments
        .filter((i) => i.status === "active" || i.status === "rejected")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt || 0).getTime() -
            new Date(a.decidedAt || a.submittedAt || 0).getTime(),
        ),
    [instruments],
  )

  const formatFace = (instrument: Instrument) =>
    `${instrument.currency} ${instrument.faceValue.toLocaleString()}`

  const handleApproveInstrument = (instrument: Instrument) => {
    const approved = approveInstrument(instrument.id)
    if (!approved) return
    toast.success("Instrument approved", {
      description: `${instrument.type} ${instrument.id} (${formatFace(instrument)}) has been issued and is now active.`,
    })
    logActivity({
      action: `Administrator approved ${instrument.type} ${instrument.id} (${formatFace(instrument)})`,
      category: "Administration",
      details: {
        summary: `Administrator approved the ${instrument.typeFull} (${instrument.type}) request ${instrument.id} with a face value of ${formatFace(instrument)}, issued by ${instrument.issuer}. The instrument is now active.`,
        referenceId: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatFace(instrument),
        issuingBank: instrument.issuer,
        decision: "Approved",
      },
    })
  }

  const confirmRejectInstrument = () => {
    if (!rejectInstrumentTarget) return
    const instrument = rejectInstrumentTarget
    rejectInstrument(instrument.id, rejectInstrumentReason)
    toast.success("Instrument rejected", {
      description: `The ${instrument.type} request ${instrument.id} (${formatFace(instrument)}) was rejected.`,
    })
    logActivity({
      action: `Administrator rejected ${instrument.type} ${instrument.id} (${formatFace(instrument)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected the ${instrument.typeFull} (${instrument.type}) request ${instrument.id} with a face value of ${formatFace(instrument)}, issued by ${instrument.issuer}. The instrument was not issued.${rejectInstrumentReason.trim() ? ` Reason: ${rejectInstrumentReason.trim()}` : ""}`,
        referenceId: instrument.id,
        instrumentType: `${instrument.type} — ${instrument.typeFull}`,
        faceValue: formatFace(instrument),
        issuingBank: instrument.issuer,
        decision: "Rejected",
        reason: rejectInstrumentReason.trim() || "(none)",
      },
    })
    setRejectInstrumentTarget(null)
    setRejectInstrumentReason("")
  }

  const pendingPPP = useMemo(
    () =>
      pppRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [pppRequests],
  )
  const decidedPPP = useMemo(
    () =>
      pppRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [pppRequests],
  )

  const formatPPPAmount = (r: PPPRequest) => `${r.currency} ${r.amount.toLocaleString()}`

  const handleApprovePPP = (request: PPPRequest) => {
    const approved = approvePPP(request.id)
    if (!approved) return
    toast.success("PPP application approved", {
      description: `${request.programName} application ${request.id} (${formatPPPAmount(request)}) has been approved and activated.`,
    })
    logActivity({
      action: `Administrator approved PPP application ${request.id} for ${request.programName} (${formatPPPAmount(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator approved the "${request.programName}" application ${request.id} with an investment of ${formatPPPAmount(request)}. The program is now active.`,
        referenceId: request.id,
        program: request.programName,
        investmentAmount: formatPPPAmount(request),
        sourceOfFunds: request.sourceOfFunds,
        payoutAccount: request.payoutAccount,
        decision: "Approved",
      },
    })
  }

  const confirmRejectPPP = () => {
    if (!rejectPPPTarget) return
    const request = rejectPPPTarget
    rejectPPP(request.id, rejectPPPReason)
    toast.success("PPP application rejected", {
      description: `The ${request.programName} application ${request.id} (${formatPPPAmount(request)}) was rejected.`,
    })
    logActivity({
      action: `Administrator rejected PPP application ${request.id} for ${request.programName} (${formatPPPAmount(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected the "${request.programName}" application ${request.id} with an investment of ${formatPPPAmount(request)}. The program was not executed.${rejectPPPReason.trim() ? ` Reason: ${rejectPPPReason.trim()}` : ""}`,
        referenceId: request.id,
        program: request.programName,
        investmentAmount: formatPPPAmount(request),
        decision: "Rejected",
        reason: rejectPPPReason.trim() || "(none)",
      },
    })
    setRejectPPPTarget(null)
    setRejectPPPReason("")
  }

  const pendingFunding = useMemo(
    () =>
      fundingRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [fundingRequests],
  )
  const decidedFunding = useMemo(
    () =>
      fundingRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [fundingRequests],
  )

  // Approved facilities the client is actively holding (funded, not yet settled).
  const activeFundingFacilities = useMemo(
    () =>
      fundingRequests
        .filter((r) => r.status === "approved" && !r.closedAt)
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [fundingRequests],
  )
  // Facilities with a client-initiated early-closure request awaiting a decision.
  const fundingClosureRequests = useMemo(
    () => activeFundingFacilities.filter((r) => !!r.closureRequest),
    [activeFundingFacilities],
  )

  const formatFundingAmount = (r: ProjectFundingRequest) =>
    `${r.currency} ${r.facility.toLocaleString()}`

  const formatMoney = (currency: string, n: number) =>
    `${currency} ${Math.round(n).toLocaleString("en-US")}`

  const confirmApproveFunding = async () => {
    if (!approveFundingTarget) return
    const request = approveFundingTarget
    if (!request.approvalId) {
      toast.error("Cannot approve project funding", {
        description: "This application is still syncing. Please refresh and try again.",
      })
      return
    }
    const score = Math.min(10, Math.max(0, Number(approveFundingScore) || 0))
    const commitment = calculateCashCommitment(request.facility, request.totalEquity, score)
    // Persist the due-diligence risk score + fixed cash commitment onto the
    // client's record so they follow the application across devices and show in
    // the client's funding history. Best-effort; the decision is what matters.
    await adminUpdateApprovalRecord(ADMIN_PASSCODE, request.approvalId, {
      riskScore: score,
      cashCommitment: commitment.applicable,
    })
    // Decide cross-client through the DB. The approved facility capital and the
    // ongoing 1.8% monthly cost-of-capital are posted onto the CLIENT's ledger by
    // the client-side FundingCapitalReconciler (deterministic FND-CAP/FND-ROI
    // ids), so no balance credit is applied here — project_funding is therefore
    // excluded from the server's CREDIT_KINDS to avoid a double credit.
    const res = await adminDecideApproval(ADMIN_PASSCODE, request.approvalId, "approved")
    if (!res.ok) {
      toast.error("Could not approve project funding", { description: res.error })
      return
    }
    void loadAdminFunding()
    toast.success("Project funding approved & capital credited", {
      description: `${request.projectName} (${formatFundingAmount(request)}) approved with risk score ${score}/10. Facility credited to the master account; 1.8% p.a. cost of capital accrues monthly.`,
    })
    logActivity({
      action: `Administrator approved project funding ${request.id} for "${request.projectName}" (${formatFundingAmount(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator approved the AES project funding application ${request.id} ("${request.projectName}", ${request.sector}, ${request.jurisdiction}) for a facility of ${formatFundingAmount(request)}. Total equity requirement ${request.currency} ${request.totalEquity.toLocaleString()}. Risk score ${score}/10 fixes the upfront cash commitment at ${request.currency} ${Math.round(commitment.applicable).toLocaleString()}. Capital activates at 1.8% annual cost.`,
        referenceId: request.id,
        project: request.projectName,
        sector: request.sector,
        jurisdiction: request.jurisdiction,
        facility: formatFundingAmount(request),
        totalEquity: `${request.currency} ${request.totalEquity.toLocaleString()}`,
        riskScore: `${score}/10`,
        cashCommitment: `${request.currency} ${Math.round(commitment.applicable).toLocaleString()}`,
        annualCost: `${request.currency} ${Math.round(annualCostOfCapital(request.facility)).toLocaleString()}`,
        decision: "Approved",
      },
    })
    setApproveFundingTarget(null)
    setApproveFundingScore("5")
  }

  const confirmRejectFunding = async () => {
    if (!rejectFundingTarget) return
    const request = rejectFundingTarget
    if (!request.approvalId) {
      toast.error("Cannot reject project funding", {
        description: "This application is still syncing. Please refresh and try again.",
      })
      return
    }
    const res = await adminDecideApproval(
      ADMIN_PASSCODE,
      request.approvalId,
      "rejected",
      rejectFundingReason.trim() || "Application rejected after review.",
    )
    if (!res.ok) {
      toast.error("Could not reject project funding", { description: res.error })
      return
    }
    void loadAdminFunding()
    toast.success("Project funding rejected", {
      description: `The "${request.projectName}" application ${request.id} (${formatFundingAmount(request)}) was rejected.`,
    })
    logActivity({
      action: `Administrator rejected project funding ${request.id} for "${request.projectName}" (${formatFundingAmount(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected the AES project funding application ${request.id} ("${request.projectName}") for a facility of ${formatFundingAmount(request)}. The funding will not be activated.${rejectFundingReason.trim() ? ` Reason: ${rejectFundingReason.trim()}` : ""}`,
        referenceId: request.id,
        project: request.projectName,
        facility: formatFundingAmount(request),
        decision: "Rejected",
        reason: rejectFundingReason.trim() || "(none)",
      },
    })
    setRejectFundingTarget(null)
    setRejectFundingReason("")
  }

  // Recall / terminate / liquidate a facility (clawback) OR approve a client's
  // early-closure request. Debits the payoff (principal + interest + early-exit
  // fee) from the owner's balance and marks the facility settled.
  const confirmCloseFunding = async () => {
    if (!closeFundingTarget) return
    const { facility, kind } = closeFundingTarget
    if (!facility.approvalId) {
      toast.error("Cannot close facility", {
        description: "This facility is still syncing. Please refresh and try again.",
      })
      return
    }
    setCloseFundingBusy(true)
    const res = await adminExecuteFundingClosure(ADMIN_PASSCODE, facility.approvalId, {
      kind,
      note: closeFundingNote.trim() || undefined,
    })
    setCloseFundingBusy(false)
    if (!res.ok) {
      toast.error("Could not close facility", { description: res.error })
      return
    }
    void loadAdminFunding()
    toast.success(kind === "client_early" ? "Early closure approved" : "Facility recalled & liquidated", {
      description: `"${facility.projectName}" settled — a payoff of ${formatMoney(res.settlement.currency, res.settlement.total)} was debited from ${facility.ownerName ?? "the owner"}'s balance.`,
    })
    setCloseFundingTarget(null)
    setCloseFundingNote("")
  }

  // Decline a client's pending early-closure request (facility stays active).
  const confirmDeclineClosure = async () => {
    if (!declineClosureTarget?.approvalId) return
    const res = await adminDeclineFundingClosure(
      ADMIN_PASSCODE,
      declineClosureTarget.approvalId,
      declineClosureReason.trim() || undefined,
    )
    if (!res.ok) {
      toast.error("Could not decline request", { description: res.error })
      return
    }
    void loadAdminFunding()
    toast.success("Closure request declined", {
      description: `The early-closure request for "${declineClosureTarget.projectName}" was declined. The facility remains active.`,
    })
    setDeclineClosureTarget(null)
    setDeclineClosureReason("")
  }

  const pendingFiduciary = useMemo(
    () =>
      fiduciaryRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [fiduciaryRequests],
  )
  const decidedFiduciary = useMemo(
    () =>
      fiduciaryRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [fiduciaryRequests],
  )

  const fiduciaryValueText = (r: FiduciaryRequest) =>
    r.estimatedValue > 0
      ? `${r.currency} ${r.estimatedValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—"

  const handleApproveFiduciary = (request: FiduciaryRequest) => {
    const approved = approveFiduciary(request.id)
    if (!approved) return
    toast.success("Fiduciary service job actioned", {
      description: `${request.serviceLabel} (${request.id}) has been approved by the custody desk.`,
    })
    logActivity({
      action: `Administrator actioned fiduciary service job ${request.id} — ${request.serviceLabel}`,
      category: "Administration",
      details: {
        summary: `Administrator (custody desk) approved fiduciary service job ${request.id}: ${request.serviceLabel}.${request.assetType ? ` Asset: ${request.assetType}.` : ""}${request.estimatedValue > 0 ? ` Value ${fiduciaryValueText(request)}.` : ""}`,
        referenceId: request.id,
        service: request.serviceLabel,
        asset: request.assetType || "(not applicable)",
        estimatedValue: fiduciaryValueText(request),
        decision: "Approved",
      },
    })
  }

  const confirmRejectFiduciary = () => {
    if (!rejectFiduciaryTarget) return
    const request = rejectFiduciaryTarget
    rejectFiduciary(request.id, rejectFiduciaryReason)
    toast.success("Fiduciary service job rejected", {
      description: `${request.serviceLabel} (${request.id}) was rejected.`,
    })
    logActivity({
      action: `Administrator rejected fiduciary service job ${request.id} — ${request.serviceLabel}`,
      category: "Administration",
      details: {
        summary: `Administrator (custody desk) rejected fiduciary service job ${request.id}: ${request.serviceLabel}.${rejectFiduciaryReason.trim() ? ` Reason: ${rejectFiduciaryReason.trim()}` : ""}`,
        referenceId: request.id,
        service: request.serviceLabel,
        decision: "Rejected",
        reason: rejectFiduciaryReason.trim() || "(none)",
      },
    })
    setRejectFiduciaryTarget(null)
    setRejectFiduciaryReason("")
  }

  const pendingLeverage = useMemo(
    () =>
      leverageRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [leverageRequests],
  )
  // Active lines for which the client has requested a switch-off.
  const pendingSwitchOff = useMemo(
    () =>
      leverageRequests
        .filter((r) => r.status === "switchoff_pending")
        .sort(
          (a, b) =>
            new Date(b.switchOffRequestedAt || b.submittedAt).getTime() -
            new Date(a.switchOffRequestedAt || a.submittedAt).getTime(),
        ),
    [leverageRequests],
  )
  // History excludes lines that are still active or awaiting a switch-off decision.
  const decidedLeverage = useMemo(
    () =>
      leverageRequests
        .filter((r) => r.status === "rejected" || r.status === "closed" || r.status === "approved")
        .sort(
          (a, b) =>
            new Date(b.closedAt || b.decidedAt || b.submittedAt).getTime() -
            new Date(a.closedAt || a.decidedAt || a.submittedAt).getTime(),
        ),
    [leverageRequests],
  )

  // Currently live lines (active, or active with a switch-off queued). These are
  // the lines an Administrator can re-rate via the modify-ratio control, and the
  // basis for the firm's leverage exposure monitor.
  const activeLeverage = useMemo(
    () =>
      leverageRequests
        .filter((r) => r.status === "approved" || r.status === "switchoff_pending")
        .sort((a, b) => new Date(b.activatedAt || b.submittedAt).getTime() - new Date(a.activatedAt || a.submittedAt).getTime()),
    [leverageRequests],
  )

  // Firm-wide exposure broken down by funding category, so the Administrator can
  // monitor how borrowed capital and buying power are concentrated across
  // Treasury, Master Banking, Bank Instruments and NAFTAhub and how close each
  // category sits to its leverage ceiling.
  const leverageExposure = useMemo(() => {
    return LEVERAGE_ACCOUNTS.map((opt) => {
      const lines = activeLeverage.filter((r) => r.account === opt.key)
      const borrowed = lines.reduce((s, r) => s + r.borrowedAmount, 0)
      const buyingPower = lines.reduce((s, r) => s + r.buyingPower, 0)
      const equityBase = lines.reduce((s, r) => s + r.equity, 0)
      const blendedRatio = equityBase > 0 ? buyingPower / equityBase : 0
      const utilisation = Math.min(100, (blendedRatio / opt.maxLeverage) * 100)
      const currency = lines[0]?.currency ?? "EUR"
      return { ...opt, count: lines.length, borrowed, buyingPower, equityBase, blendedRatio, utilisation, currency }
    })
  }, [activeLeverage])

  const formatLeverageMoney = (r: LeverageRequest, value: number) =>
    `${r.currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  const formatLeverageMoney2 = (r: LeverageRequest, value: number) =>
    `${r.currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const handleApproveLeverage = async (request: LeverageRequest) => {
    // The borrowed funds must be credited to the CLIENT's balance (the shared
    // data owner), not the admin's own ledger. Approve through the server so the
    // DB approval flips to "approved" and `applyLedgerEffect` posts the
    // borrowed-funds credit (APPR-<approvalId>) onto the client's ledger — the
    // same ledger their Account Balances reads from. The previous version
    // credited the admin's own books via addReceipt and only mutated local
    // state, so the client's balance never moved.
    if (!request.approvalId) {
      toast.error("Cannot activate leverage", {
        description: "This request is still syncing. Please refresh and try again.",
      })
      return
    }
    const res = await adminDecideApproval(ADMIN_PASSCODE, request.approvalId, "approved")
    if (!res.ok) {
      toast.error("Could not activate leverage line", { description: res.error })
      return
    }
    const creditRef = `APPR-${request.approvalId}`
    // Reflect activation locally for instant feedback; the server record (now
    // approved + activated) is authoritative on the next refresh. Don't gate the
    // confirmation on this — the server approval already succeeded.
    approveLeverage(request.id, creditRef)
    toast.success("Leverage line activated", {
      description: `${formatLeverageMoney(request, request.borrowedAmount)} credited. ${request.id} is live at 1:${request.leverageRatio} (buying power ${formatLeverageMoney(request, request.buyingPower)}).`,
    })
    logActivity({
      action: `Administrator activated leverage line ${request.id} (${request.accountLabel}, 1:${request.leverageRatio})`,
      category: "Administration",
      details: {
        summary: `Administrator approved and activated a 1:${request.leverageRatio} leverage line ${request.id} on the ${request.accountLabel}. ${formatLeverageMoney(request, request.borrowedAmount)} of borrowed funds was credited to the client's balance (equity ${formatLeverageMoney(request, request.equity)}, buying power ${formatLeverageMoney(request, request.buyingPower)}) to trade ${request.instrumentType}. Debit interest of ${(request.interestRate * 100).toFixed(1)}% per year now accrues on the borrowed amount.`,
        referenceId: request.id,
        fundingAccount: request.accountLabel,
        equityAllocated: formatLeverageMoney(request, request.equity),
        leverage: `1:${request.leverageRatio}`,
        borrowedFundsCredited: formatLeverageMoney(request, request.borrowedAmount),
        buyingPower: formatLeverageMoney(request, request.buyingPower),
        debitInterestRate: `${(request.interestRate * 100).toFixed(1)}% per year`,
        ledgerReference: creditRef,
        instrumentType: request.instrumentType,
        decision: "Approved",
      },
    })
  }

  // Approve a switch-off: settle accrued interest and repay the borrowed
  // principal from the client's balance, then close the line.
  const handleApproveSwitchOff = (request: LeverageRequest) => {
    // Total lifetime interest, minus whatever has already been collected
    // month-by-month by the LeverageInterestReconciler. At switch-off we only
    // settle the REMAINDER so the client is never charged twice for the same
    // accrued interest.
    const totalInterest = accruedInterest(request, Date.now())
    const alreadyPosted = postedLeverageInterest(request.id, ledgerEntries)
    const interest = Math.max(0, round2(totalInterest - alreadyPosted))
    const now = new Date().toISOString()
    const repayRef = `LEV-RP-${Date.now().toString().slice(-8)}`
    const repayEntry = addDebit({
      id: repayRef,
      amount: request.borrowedAmount,
      currency: request.currency,
      status: "completed",
      date: now,
      counterparty: "MCC Leverage Desk",
      reference: request.id,
      category: "Leverage Principal Repaid",
      comment: `Repayment of borrowed funds on switch-off of 1:${request.leverageRatio} leverage line ${request.id} (${request.accountLabel}).`,
    })
    let interestRef: string | undefined
    if (interest > 0) {
      interestRef = `LEV-IN-${Date.now().toString().slice(-7)}`
      addDebit({
        id: interestRef,
        amount: interest,
        currency: request.currency,
        status: "completed",
        date: now,
        counterparty: "MCC Leverage Desk",
        reference: request.id,
        category: "Leverage Debit Interest",
        comment: `Accrued debit interest (${(request.interestRate * 100).toFixed(1)}% per year) settled on switch-off of leverage line ${request.id}.`,
      })
    }
    const closed = approveLeverageSwitchOff(request.id, {
      settledInterest: interest,
      repayEntryId: repayEntry.id,
      interestEntryId: interestRef,
    })
    if (!closed) return
    toast.success("Leverage switched off", {
      description: `${request.id} closed. ${formatLeverageMoney(request, request.borrowedAmount)} principal repaid and ${formatLeverageMoney2(request, interest)} interest settled.`,
    })
    logActivity({
      action: `Administrator switched off leverage line ${request.id} (${request.accountLabel}, 1:${request.leverageRatio})`,
      category: "Administration",
      details: {
        summary: `Administrator approved the switch-off of leverage line ${request.id} on the ${request.accountLabel}. Accrued debit interest of ${formatLeverageMoney2(request, interest)} was settled and the borrowed principal of ${formatLeverageMoney(request, request.borrowedAmount)} was repaid from the client's balance. The leverage multiplier was removed and the interest cleared.`,
        referenceId: request.id,
        fundingAccount: request.accountLabel,
        leverage: `1:${request.leverageRatio}`,
        principalRepaid: formatLeverageMoney(request, request.borrowedAmount),
        interestSettled: formatLeverageMoney2(request, interest),
        principalLedgerReference: repayRef,
        interestLedgerReference: interestRef || "(none)",
        decision: "Switched Off",
      },
    })
  }

  // Administrator re-rates an active leverage line within its category ceiling.
  // The borrowed principal is re-settled on the ledger: a credit tops up the
  // client's balance when the ratio increases, a debit claws back the surplus
  // when it decreases. Interest accrued under the prior ratio is captured so
  // future accrual continues cleanly on the new principal.
  const confirmModifyRatio = () => {
    const request = modifyRatioTarget
    if (!request) return
    const cap = maxLeverageFor(request.account)
    const toRatio = Number(modifyRatioValue)
    if (!toRatio || toRatio < 1) {
      toast.error("Enter a valid leverage ratio.")
      return
    }
    if (toRatio > cap) {
      toast.error(`${request.accountLabel} is limited to a maximum leverage of 1:${cap}.`)
      return
    }
    if (toRatio === request.leverageRatio) {
      toast.error("The new ratio matches the current ratio.")
      return
    }

    const newBorrowed = request.equity * (toRatio - 1)
    const delta = newBorrowed - request.borrowedAmount // >0 credit, <0 repay
    const interestToDate = accruedInterest(request, Date.now())
    const now = new Date().toISOString()

    let adjustmentRef: string | undefined
    if (delta > 0) {
      adjustmentRef = `LEV-MC-${Date.now().toString().slice(-8)}`
      addReceipt({
        id: adjustmentRef,
        amount: delta,
        currency: request.currency,
        status: "completed",
        date: now,
        counterparty: "MCC Leverage Desk",
        reference: request.id,
        category: "Leverage Ratio Adjustment",
        comment: `Additional borrowed funds credited on increase of leverage line ${request.id} (${request.accountLabel}) from 1:${request.leverageRatio} to 1:${toRatio}.`,
      })
    } else if (delta < 0) {
      adjustmentRef = `LEV-MD-${Date.now().toString().slice(-8)}`
      addDebit({
        id: adjustmentRef,
        amount: Math.abs(delta),
        currency: request.currency,
        status: "completed",
        date: now,
        counterparty: "MCC Leverage Desk",
        reference: request.id,
        category: "Leverage Ratio Adjustment",
        comment: `Borrowed funds repaid on reduction of leverage line ${request.id} (${request.accountLabel}) from 1:${request.leverageRatio} to 1:${toRatio}.`,
      })
    }

    const updated = modifyLeverageRatio(request.id, {
      toRatio,
      interestToDate,
      adjustmentEntryId: adjustmentRef,
      note: modifyRatioNote,
    })
    if (!updated) {
      toast.error("Unable to modify this leverage line.")
      return
    }

    toast.success("Leverage ratio updated", {
      description: `${request.id} re-rated from 1:${request.leverageRatio} to 1:${toRatio}. ${
        delta > 0
          ? `${formatLeverageMoney(request, delta)} credited`
          : delta < 0
            ? `${formatLeverageMoney(request, Math.abs(delta))} repaid`
            : "No ledger change"
      }.`,
    })
    logActivity({
      action: `Administrator modified leverage line ${request.id} (${request.accountLabel}) from 1:${request.leverageRatio} to 1:${toRatio}`,
      category: "Administration",
      details: {
        summary: `Administrator re-rated active leverage line ${request.id} on the ${request.accountLabel} from 1:${request.leverageRatio} to 1:${toRatio} (within the category ceiling of 1:${cap}). Borrowed principal moved from ${formatLeverageMoney(request, request.borrowedAmount)} to ${formatLeverageMoney(updated, updated.borrowedAmount)} and buying power to ${formatLeverageMoney(updated, updated.buyingPower)}. ${
          delta > 0
            ? `${formatLeverageMoney(request, delta)} of additional borrowed funds was credited to the client's balance.`
            : delta < 0
              ? `${formatLeverageMoney(request, Math.abs(delta))} of borrowed funds was repaid from the client's balance.`
              : "No ledger movement was required."
        } Interest of ${formatLeverageMoney2(request, interestToDate)} accrued under the prior ratio; future debit interest now accrues on the new principal.${modifyRatioNote.trim() ? ` Note: ${modifyRatioNote.trim()}` : ""}`,
        referenceId: request.id,
        fundingAccount: request.accountLabel,
        previousLeverage: `1:${request.leverageRatio}`,
        newLeverage: `1:${toRatio}`,
        categoryCeiling: `1:${cap}`,
        previousBorrowed: formatLeverageMoney(request, request.borrowedAmount),
        newBorrowed: formatLeverageMoney(updated, updated.borrowedAmount),
        newBuyingPower: formatLeverageMoney(updated, updated.buyingPower),
        ledgerAdjustment:
          delta > 0
            ? `+${formatLeverageMoney(request, delta)} credited`
            : delta < 0
              ? `-${formatLeverageMoney(request, Math.abs(delta))} debited`
              : "None",
        ledgerReference: adjustmentRef || "(none)",
        interestAccruedToDate: formatLeverageMoney2(request, interestToDate),
        decision: "Ratio Modified",
      },
    })
    setModifyRatioTarget(null)
    setModifyRatioValue("")
    setModifyRatioNote("")
  }

  const confirmRejectSwitchOff = () => {
    if (!rejectSwitchOffTarget) return
    const request = rejectSwitchOffTarget
    rejectLeverageSwitchOff(request.id, rejectSwitchOffReason)
    toast.success("Switch-off request rejected", {
      description: `The switch-off of ${request.id} was declined. The line remains active.`,
    })
    logActivity({
      action: `Administrator rejected the switch-off request for leverage line ${request.id} (${request.accountLabel})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected the client's request to switch off leverage line ${request.id} on the ${request.accountLabel}. The line remains active and debit interest continues to accrue.${rejectSwitchOffReason.trim() ? ` Reason: ${rejectSwitchOffReason.trim()}` : ""}`,
        referenceId: request.id,
        fundingAccount: request.accountLabel,
        leverage: `1:${request.leverageRatio}`,
        decision: "Switch-Off Rejected",
        reason: rejectSwitchOffReason.trim() || "(none)",
      },
    })
    setRejectSwitchOffTarget(null)
    setRejectSwitchOffReason("")
  }

  const confirmRejectLeverage = () => {
    if (!rejectLeverageTarget) return
    const request = rejectLeverageTarget
    rejectLeverage(request.id, rejectLeverageReason)
    toast.success("Leverage request rejected", {
      description: `The ${request.accountLabel} 1:${request.leverageRatio} line ${request.id} was rejected. No trading line was opened.`,
    })
    logActivity({
      action: `Administrator rejected leverage request ${request.id} (${request.accountLabel}, 1:${request.leverageRatio})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected the 1:${request.leverageRatio} leverage request ${request.id} on the ${request.accountLabel} (${formatLeverageMoney(request, request.equity)} equity, ${formatLeverageMoney(request, request.buyingPower)} buying power). No trading line was opened.${rejectLeverageReason.trim() ? ` Reason: ${rejectLeverageReason.trim()}` : ""}`,
        referenceId: request.id,
        fundingAccount: request.accountLabel,
        equityAllocated: formatLeverageMoney(request, request.equity),
        leverage: `1:${request.leverageRatio}`,
        instrumentType: request.instrumentType,
        decision: "Rejected",
        reason: rejectLeverageReason.trim() || "(none)",
      },
    })
    setRejectLeverageTarget(null)
    setRejectLeverageReason("")
  }

  const pendingDOF = useMemo(
    () =>
      dofRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [dofRequests],
  )
  const decidedDOF = useMemo(
    () =>
      dofRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [dofRequests],
  )

  const formatDOFAmount = (r: DOFRequest) => formatCurrency(r.amount, r.currency)

  const handleApproveDOF = (request: DOFRequest) => {
    // Credit the institutional funds into the master ledger at approval time.
    const credited = addReceipt({
      id: request.id,
      amount: request.amount,
      currency: request.currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: request.originatorName,
      account: request.originatorAccount || undefined,
      bank: request.originatorBank
        ? `${request.originatorBank}${request.originatorBankBic ? ` (${request.originatorBankBic})` : ""}`
        : undefined,
      reference: request.mt103Ref || request.id,
      comment: `Institutional Download of Funds from ${request.originatorName} via ${request.originatorBank} (${request.originatorBankBic}). Settlement: ${request.settlementMethod}. UETR ${request.uetr}.${request.mt202Ref ? ` MT202 ${request.mt202Ref}.` : ""}`,
      category: "Download of Funds",
    })

    const approved = approveDOF(request.id, credited.id)
    if (!approved) return

    toast.success("Download of Funds authorized", {
      description: `${formatDOFAmount(request)} from ${request.originatorName} has been credited to the master account.`,
    })
    logActivity({
      action: `Administrator authorized Download of Funds ${request.id} of ${formatDOFAmount(request)}`,
      category: "Administration",
      details: {
        summary: `Administrator authorized institutional Download of Funds ${request.id}. Credited ${formatDOFAmount(request)} from ${request.originatorName} via ${request.originatorBank} (${request.originatorBankBic}) into the master account. Settlement method ${request.settlementMethod}, value date ${request.valueDate}. UETR ${request.uetr}.`,
        referenceId: request.id,
        uetr: request.uetr,
        amountCredited: formatDOFAmount(request),
        originator: request.originatorName,
        sendingBank: `${request.originatorBank} (${request.originatorBankBic})`,
        settlementMethod: request.settlementMethod,
        mt103: request.mt103Ref || "(none)",
        mt202: request.mt202Ref || "(none)",
        decision: "Approved",
      },
    })
  }

  const confirmRejectDOF = () => {
    if (!rejectDOFTarget) return
    const request = rejectDOFTarget
    rejectDOF(request.id, rejectDOFReason)
    toast.success("Download of Funds rejected", {
      description: `The request ${request.id} for ${formatDOFAmount(request)} was rejected. No funds were credited.`,
    })
    logActivity({
      action: `Administrator rejected Download of Funds ${request.id} of ${formatDOFAmount(request)}`,
      category: "Administration",
      details: {
        summary: `Administrator rejected institutional Download of Funds ${request.id} for ${formatDOFAmount(request)} from ${request.originatorName}. No funds were credited.${rejectDOFReason.trim() ? ` Reason: ${rejectDOFReason.trim()}` : ""}`,
        referenceId: request.id,
        uetr: request.uetr,
        amount: formatDOFAmount(request),
        originator: request.originatorName,
        decision: "Rejected",
        reason: rejectDOFReason.trim() || "(none)",
      },
    })
    setRejectDOFTarget(null)
    setRejectDOFReason("")
  }

  const pendingMonetization = useMemo(
    () =>
      monetizationRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [monetizationRequests],
  )
  const decidedMonetization = useMemo(
    () =>
      monetizationRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [monetizationRequests],
  )

  const MONETIZATION_STRUCTURE_LABELS: Record<MonetizationRequest["structure"], string> = {
    CreditLine: "Non-recourse credit line",
    Discounting: "Discounting / purchase",
    CollateralTransfer: "Collateral transfer (MT760)",
  }
  const formatMonetizationProceeds = (r: MonetizationRequest) =>
    formatCurrency(r.grossProceeds, r.proceedsCurrency)

  const handleApproveMonetization = (request: MonetizationRequest) => {
    // Credit the monetization proceeds into the master ledger at approval time.
    const credited = addReceipt({
      id: request.id,
      amount: request.grossProceeds,
      currency: request.proceedsCurrency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: request.monetizationPlatform || request.issuer,
      bank: request.receivingBank
        ? `${request.receivingBank}${request.receivingBankBic ? ` (${request.receivingBankBic})` : ""}`
        : undefined,
      reference: request.mt760Ref || request.id,
      comment: `Monetization of ${request.instrumentTypeFull} (${request.instrumentType}) ${request.instrumentId} issued by ${request.issuer}. Structure: ${MONETIZATION_STRUCTURE_LABELS[request.structure]} at ${request.advanceRatePercent}% LTV on ${formatCurrency(request.monetizedValue, request.currency)}${request.leverageRatio ? ` leveraged value (${formatCurrency(request.faceValue, request.currency)} face × ${request.leverageRatio})` : " face value"}. UETR ${request.uetr}.${request.mt760Ref ? ` MT760 ${request.mt760Ref}.` : ""}`,
      category: "Instrument Monetization",
    })

    const approved = approveMonetization(request.id, credited.id)
    if (!approved) return

    toast.success("Monetization authorized", {
      description: `${formatMonetizationProceeds(request)} of proceeds for ${request.instrumentId} has been credited to the master account.`,
    })
    logActivity({
      action: `Administrator authorized monetization ${request.id} of ${formatMonetizationProceeds(request)}`,
      category: "Administration",
      details: {
        summary: `Administrator authorized monetization ${request.id} of the ${request.instrumentTypeFull} (${request.instrumentType}) ${request.instrumentId} issued by ${request.issuer}. Credited ${formatMonetizationProceeds(request)} (${MONETIZATION_STRUCTURE_LABELS[request.structure]}, ${request.advanceRatePercent}% LTV on ${formatCurrency(request.faceValue, request.currency)}) into the master account. UETR ${request.uetr}.`,
        referenceId: request.id,
        uetr: request.uetr,
        instrumentRef: request.instrumentId,
        instrument: `${request.instrumentType} — ${request.instrumentTypeFull}`,
        structure: MONETIZATION_STRUCTURE_LABELS[request.structure],
        advanceRate: `${request.advanceRatePercent}%`,
        proceedsCredited: formatMonetizationProceeds(request),
        mt760: request.mt760Ref || "(none)",
        decision: "Approved",
      },
    })
  }

  const confirmRejectMonetization = () => {
    if (!rejectMonetizationTarget) return
    const request = rejectMonetizationTarget
    rejectMonetization(request.id, rejectMonetizationReason)
    toast.success("Monetization rejected", {
      description: `The request ${request.id} for ${request.instrumentId} was rejected. No proceeds were credited.`,
    })
    logActivity({
      action: `Administrator rejected monetization ${request.id} of ${formatMonetizationProceeds(request)}`,
      category: "Administration",
      details: {
        summary: `Administrator rejected monetization ${request.id} of the ${request.instrumentTypeFull} (${request.instrumentType}) ${request.instrumentId}. No proceeds were credited.${rejectMonetizationReason.trim() ? ` Reason: ${rejectMonetizationReason.trim()}` : ""}`,
        referenceId: request.id,
        uetr: request.uetr,
        instrumentRef: request.instrumentId,
        proceeds: formatMonetizationProceeds(request),
        decision: "Rejected",
        reason: rejectMonetizationReason.trim() || "(none)",
      },
    })
    setRejectMonetizationTarget(null)
    setRejectMonetizationReason("")
  }

  const pendingDTC = useMemo(
    () =>
      dtcRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [dtcRequests],
  )
  const decidedDTC = useMemo(
    () =>
      dtcRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [dtcRequests],
  )

  const formatDTCCash = (r: DTCRequest) =>
    r.settlementBasis === "DVP" ? formatCurrency(r.cashAmount, r.currency) : "Free of Payment"

  const handleApproveDTC = (request: DTCRequest) => {
    // For DVP trades the cash leg moves at settlement: a delivery credits the
    // proceeds, a receipt debits the cost. FOP trades move no cash.
    if (request.settlementBasis === "DVP" && request.direction === "receive") {
      if (request.currency === MASTER_ACCOUNT_CURRENCY && request.cashAmount > masterBalance) {
        toast.error("Insufficient funds to settle", {
          description: `This receipt needs ${formatCurrency(request.cashAmount, request.currency)} but only ${formatCurrency(masterBalance, MASTER_ACCOUNT_CURRENCY)} is available.`,
        })
        return
      }
    }

    let settledEntryId: string | undefined
    if (request.settlementBasis === "DVP" && request.cashAmount > 0) {
      const common = {
        amount: request.cashAmount,
        currency: request.currency,
        status: "completed" as const,
        date: new Date().toISOString(),
        counterparty: request.counterpartyName,
        bank: request.agentBank
          ? `${request.agentBank}${request.agentBankBic ? ` (${request.agentBankBic})` : ""}`
          : undefined,
        reference: request.mt54xRef || request.id,
      }
      if (request.direction === "deliver") {
        const credited = addReceipt({
          ...common,
          id: request.id,
          comment: `DVP cash proceeds from delivery of ${request.securityName} (ISIN ${request.isin}) via ${request.depository}. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
          category: "Securities Settlement",
        })
        settledEntryId = credited.id
      } else {
        const debited = addDebit({
          ...common,
          id: request.id,
          comment: `DVP cash payment for receipt of ${request.securityName} (ISIN ${request.isin}) via ${request.depository}. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
          category: "Securities Settlement",
        })
        settledEntryId = debited.id
      }
    }

    const approved = approveDTC(request.id, settledEntryId)
    if (!approved) return

    toast.success("Securities settlement authorized", {
      description: `${request.depository} ${request.direction === "deliver" ? "delivery" : "receipt"} of ${request.securityName} has settled (${formatDTCCash(request)}).`,
    })
    logActivity({
      action: `Administrator authorized ${request.depository} settlement ${request.id} (${formatDTCCash(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator authorized ${request.depository} ${request.settlementBasis} settlement ${request.id}: ${request.direction === "deliver" ? "delivered" : "received"} ${request.quantity.toLocaleString()} of ${request.securityName} (ISIN ${request.isin}) against ${formatDTCCash(request)}. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
        referenceId: request.id,
        uetr: request.uetr,
        depository: request.depository,
        settlementBasis: request.settlementBasis,
        direction: request.direction,
        security: `${request.securityName} (${request.isin})`,
        cashLeg: formatDTCCash(request),
        counterparty: request.counterpartyName,
        decision: "Approved",
      },
    })
  }

  const confirmRejectDTC = () => {
    if (!rejectDTCTarget) return
    const request = rejectDTCTarget
    rejectDTC(request.id, rejectDTCReason)
    toast.success("Securities settlement rejected", {
      description: `Instruction ${request.id} for ${request.securityName} was rejected. Nothing settled.`,
    })
    logActivity({
      action: `Administrator rejected ${request.depository} settlement ${request.id} (${formatDTCCash(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected ${request.depository} ${request.settlementBasis} settlement ${request.id} for ${request.securityName} (ISIN ${request.isin}). No securities settled and no cash moved.${rejectDTCReason.trim() ? ` Reason: ${rejectDTCReason.trim()}` : ""}`,
        referenceId: request.id,
        uetr: request.uetr,
        depository: request.depository,
        security: `${request.securityName} (${request.isin})`,
        cashLeg: formatDTCCash(request),
        counterparty: request.counterpartyName,
        decision: "Rejected",
        reason: rejectDTCReason.trim() || "(none)",
      },
    })
    setRejectDTCTarget(null)
    setRejectDTCReason("")
  }

  // --- Euroclear Settlement (MT540-543 securities instructions) ---------
  const pendingEuroclear = useMemo(
    () =>
      euroclearRequests
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [euroclearRequests],
  )
  const decidedEuroclear = useMemo(
    () =>
      euroclearRequests
        .filter((r) => r.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [euroclearRequests],
  )

  const formatEuroclearCash = (r: EuroclearRequest) =>
    r.settlementBasis === "DVP" ? formatCurrency(r.cashAmount, r.currency) : "Free of Payment"

  const handleApproveEuroclear = (request: EuroclearRequest) => {
    // For DVP trades the cash leg moves at settlement: a delivery credits the
    // proceeds, a receipt debits the cost. FOP trades move no cash.
    if (request.settlementBasis === "DVP" && request.direction === "receive") {
      if (request.currency === MASTER_ACCOUNT_CURRENCY && request.cashAmount > masterBalance) {
        toast.error("Insufficient funds to settle", {
          description: `This receipt needs ${formatCurrency(request.cashAmount, request.currency)} but only ${formatCurrency(masterBalance, MASTER_ACCOUNT_CURRENCY)} is available.`,
        })
        return
      }
    }

    let settledEntryId: string | undefined
    if (request.settlementBasis === "DVP" && request.cashAmount > 0) {
      const common = {
        amount: request.cashAmount,
        currency: request.currency,
        status: "completed" as const,
        date: new Date().toISOString(),
        counterparty: request.counterpartyName,
        bank: request.custodianBank
          ? `${request.custodianBank}${request.custodianBic ? ` (${request.custodianBic})` : ""}`
          : undefined,
        reference: request.mt54xRef || request.id,
      }
      if (request.direction === "deliver") {
        const credited = addReceipt({
          ...common,
          id: request.id,
          comment: `DVP cash proceeds from delivery of ${request.securityName} (ISIN ${request.isin}) via Euroclear. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
          category: "Securities Settlement",
        })
        settledEntryId = credited.id
      } else {
        const debited = addDebit({
          ...common,
          id: request.id,
          comment: `DVP cash payment for receipt of ${request.securityName} (ISIN ${request.isin}) via Euroclear. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
          category: "Securities Settlement",
        })
        settledEntryId = debited.id
      }
    }

    const approved = approveEuroclear(request.id, settledEntryId)
    if (!approved) return

    toast.success("Euroclear settlement authorized", {
      description: `Euroclear ${request.direction === "deliver" ? "delivery" : "receipt"} of ${request.securityName} has settled (${formatEuroclearCash(request)}).`,
    })
    logActivity({
      action: `Administrator authorized Euroclear settlement ${request.id} (${formatEuroclearCash(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator authorized Euroclear ${request.settlementBasis} settlement ${request.id}: ${request.direction === "deliver" ? "delivered" : "received"} ${request.quantity.toLocaleString()} of ${request.securityName} (ISIN ${request.isin}) against ${formatEuroclearCash(request)}. Counterparty ${request.counterpartyName}. UETR ${request.uetr}.`,
        referenceId: request.id,
        uetr: request.uetr,
        depository: "Euroclear",
        settlementBasis: request.settlementBasis,
        direction: request.direction,
        security: `${request.securityName} (${request.isin})`,
        cashLeg: formatEuroclearCash(request),
        counterparty: request.counterpartyName,
        decision: "Approved",
      },
    })
  }

  const confirmRejectEuroclear = () => {
    if (!rejectEuroclearTarget) return
    const request = rejectEuroclearTarget
    rejectEuroclear(request.id, rejectEuroclearReason)
    toast.success("Euroclear settlement rejected", {
      description: `Instruction ${request.id} for ${request.securityName} was rejected. Nothing settled.`,
    })
    logActivity({
      action: `Administrator rejected Euroclear settlement ${request.id} (${formatEuroclearCash(request)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected Euroclear ${request.settlementBasis} settlement ${request.id} for ${request.securityName} (ISIN ${request.isin}). No securities settled and no cash moved.${rejectEuroclearReason.trim() ? ` Reason: ${rejectEuroclearReason.trim()}` : ""}`,
        referenceId: request.id,
        uetr: request.uetr,
        depository: "Euroclear",
        security: `${request.securityName} (${request.isin})`,
        cashLeg: formatEuroclearCash(request),
        counterparty: request.counterpartyName,
        decision: "Rejected",
        reason: rejectEuroclearReason.trim() || "(none)",
      },
    })
    setRejectEuroclearTarget(null)
    setRejectEuroclearReason("")
  }

  // --- Commodity Trading (deals + POP/POF documents) -------------------
  const pendingDeals = useMemo(
    () =>
      commodityDeals
        .filter((d) => d.status === "pending")
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [commodityDeals],
  )
  const decidedDeals = useMemo(
    () =>
      commodityDeals
        .filter((d) => d.status !== "pending")
        .sort(
          (a, b) =>
            new Date(b.decidedAt || b.submittedAt).getTime() -
            new Date(a.decidedAt || a.submittedAt).getTime(),
        ),
    [commodityDeals],
  )

  const handleVerifyDoc = (deal: CommodityDeal, doc: DealDocument) => {
    verifyDocument(deal.id, doc.id)
    toast.success("Document verified", {
      description: `${doc.docType} on ${deal.id} marked as verified.`,
    })
    logActivity({
      action: `Administrator verified ${doc.module} document (${doc.docType}) for deal ${deal.id}`,
      category: "Administration",
      details: {
        summary: `Administrator verified ${doc.module} document "${doc.docType}" (v${doc.currentVersion}) on commodity deal ${deal.id} "${deal.title}".`,
        referenceId: deal.id,
        uetr: deal.uetr,
        module: doc.module,
        docType: doc.docType,
        decision: "Verified",
      },
    })
  }

  const confirmRejectDoc = () => {
    if (!rejectDocTarget) return
    const { deal, doc } = rejectDocTarget
    rejectDocument(deal.id, doc.id, rejectDocReason)
    toast.success("Document rejected", {
      description: `${doc.docType} on ${deal.id} was rejected. The client can submit a new version.`,
    })
    logActivity({
      action: `Administrator rejected ${doc.module} document (${doc.docType}) for deal ${deal.id}`,
      category: "Administration",
      details: {
        summary: `Administrator rejected ${doc.module} document "${doc.docType}" (v${doc.currentVersion}) on commodity deal ${deal.id} "${deal.title}".${rejectDocReason.trim() ? ` Reason: ${rejectDocReason.trim()}` : ""}`,
        referenceId: deal.id,
        uetr: deal.uetr,
        module: doc.module,
        docType: doc.docType,
        decision: "Rejected",
        reason: rejectDocReason.trim() || "(none)",
      },
    })
    setRejectDocTarget(null)
    setRejectDocReason("")
  }

  const handleApproveDeal = (deal: CommodityDeal) => {
    const unverified = deal.documents.filter((d) => d.status !== "verified")
    if (deal.documents.length === 0) {
      toast.error("No documents to review", {
        description: "This deal has no POP/POF documents. Confirm with the client before authorizing.",
      })
    } else if (unverified.length > 0) {
      toast.warning("Some documents are not verified", {
        description: `${unverified.length} document(s) remain unverified. You can still authorize, but review them first.`,
      })
    }
    // Credit the deal proceeds into the master ledger so balances and the
    // Transactions section reflect the executed commodity trade. Mirrors the
    // DOF / DTC / monetization settlement pattern.
    let settledEntryId: string | undefined
    if (deal.approxValue > 0) {
      const swiftRef =
        deal.mt103Ref || deal.mt202Ref || deal.mt799Ref || deal.uetr
      const credited = addReceipt({
        id: deal.id,
        amount: deal.approxValue,
        currency: deal.currency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: deal.buyerName || deal.sellerName || "Commodity counterparty",
        bank: deal.receivingBank
          ? `${deal.receivingBank}${deal.receivingBankBic ? ` (${deal.receivingBankBic})` : ""}`
          : deal.sendingBank || undefined,
        reference: swiftRef,
        category: "Commodity Settlement",
        comment: `Proceeds from authorized commodity deal ${deal.id} "${deal.title}" (${deal.category}${deal.commodity ? `, ${deal.commodity}` : ""}${deal.quantity ? ` ${deal.quantity}` : ""}). Buyer ${deal.buyerName}, Seller ${deal.sellerName}. Routed ${deal.sendingBankBic || deal.sendingBank || "—"} → ${deal.receivingBankBic || deal.receivingBank || "—"}. UETR ${deal.uetr}.`,
      })
      settledEntryId = credited.id
    }
    const approved = approveDeal(deal.id, undefined, settledEntryId)
    if (!approved) return
    toast.success("Deal authorized for execution", {
      description: `${deal.id} "${deal.title}" moved to the Execution stage${settledEntryId ? ` and ${formatCurrency(deal.approxValue, deal.currency)} credited to the master account.` : "."}`,
    })
    logActivity({
      action: `Administrator authorized commodity deal ${deal.id} (${formatCurrency(deal.approxValue, deal.currency)})`,
      category: "Administration",
      details: {
        summary: `Administrator authorized commodity deal ${deal.id} "${deal.title}" (${deal.category}, ${deal.commodity || "—"} ${deal.quantity ? `${deal.quantity}` : ""}) valued ~${formatCurrency(deal.approxValue, deal.currency)}. Buyer ${deal.buyerName}, Seller ${deal.sellerName}. Advanced to Execution.${settledEntryId ? ` ${formatCurrency(deal.approxValue, deal.currency)} credited to the master account (ref ${settledEntryId}).` : ""} UETR ${deal.uetr}.`,
        referenceId: deal.id,
        uetr: deal.uetr,
        category: deal.category,
        value: formatCurrency(deal.approxValue, deal.currency),
        settledEntryId,
        decision: "Approved",
      },
    })
  }

  const confirmRejectDeal = () => {
    if (!rejectDealTarget) return
    const deal = rejectDealTarget
    rejectDeal(deal.id, rejectDealReason)
    toast.success("Deal rejected", {
      description: `${deal.id} "${deal.title}" was rejected. Nothing executes.`,
    })
    logActivity({
      action: `Administrator rejected commodity deal ${deal.id} (${formatCurrency(deal.approxValue, deal.currency)})`,
      category: "Administration",
      details: {
        summary: `Administrator rejected commodity deal ${deal.id} "${deal.title}" (${deal.category}). No execution proceeds.${rejectDealReason.trim() ? ` Reason: ${rejectDealReason.trim()}` : ""}`,
        referenceId: deal.id,
        uetr: deal.uetr,
        category: deal.category,
        value: formatCurrency(deal.approxValue, deal.currency),
        decision: "Rejected",
        reason: rejectDealReason.trim() || "(none)",
      },
    })
    setRejectDealTarget(null)
    setRejectDealReason("")
  }

  // Load the selectable account directory when the Danger Zone is opened.
  const loadResetAccounts = async () => {
    setResetAccountsLoading(true)
    const res = await listUsers(ADMIN_PASSCODE)
    setResetAccountsLoading(false)
    if (res.ok) {
      setResetAccounts(res.users)
    } else {
      toast.error("Could not load accounts", { description: res.error })
    }
  }

  useEffect(() => {
    if (activeView === "danger" && resetAccounts.length === 0 && !resetAccountsLoading) {
      void loadResetAccounts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView])

  const resetTarget = resetAccounts.find((a) => a.id === resetTargetId) ?? null

  const handleResetAccount = async () => {
    if (!resetTargetId) {
      toast.error("Select an account to reset first.")
      return
    }
    setResetting(true)

    // Wipe the SELECTED account's SERVER-side data. Balances, transactions,
    // requests, beneficiaries, instruments and notifications live in Neon, and
    // the in-memory stores re-hydrate from the server on login — so the server
    // wipe is what makes the reset actually stick. The action is scoped strictly
    // to the chosen account id, so no other user's data is touched.
    const serverResult = await resetServerAccountDataForUser(ADMIN_PASSCODE, resetTargetId)
    if (!serverResult.ok) {
      setResetting(false)
      toast.error("Reset failed", { description: serverResult.error })
      return
    }

    logActivity({
      action: `Administrator reset account data for ${serverResult.targetName}`,
      category: "Administration",
      details: {
        summary: `Administrator reset the account "${serverResult.targetName}" (${serverResult.targetEmail}) to a brand-new state. All balances set to 0.00 and every transaction, payment request, bank instrument, Yield/PPP application, beneficiary and notification permanently deleted on the server. No other account was affected.`,
        decision: "Account Reset",
        targetAccount: `${serverResult.targetName} — ${serverResult.targetEmail}`,
        scope: "Balances, transactions, payment requests, instruments, Yield/PPP applications, beneficiaries",
        serverRowsCleared: String(serverResult.cleared),
      },
    })

    setResetting(false)
    setResetDialogOpen(false)
    setResetConfirm("")
    toast.success(`Account reset: ${serverResult.targetName}`, {
      description: `Cleared ${serverResult.cleared} record(s). The account is now in a brand-new state and will show empty balances on next login.`,
    })
    setResetTargetId("")
  }

  const handleApprove = (request: PaymentRequest) => {
    // Funds only move now, at approval time. Guard against insufficient balance
    // in case the available balance changed since submission.
    if (request.currency === MASTER_ACCOUNT_CURRENCY && request.total > masterBalance) {
      toast.error("Insufficient funds to approve", {
        description: `This payment needs ${formatCurrency(request.total, request.currency)} but only ${formatCurrency(masterBalance, MASTER_ACCOUNT_CURRENCY)} is available.`,
      })
      return
    }

    // Resolve the payout partner bank: the Administrator's explicit choice, or
    // the suggested correspondent for the request currency as a sensible default.
    const routedBank =
      partnerBankByKey(payoutBankByRequest[request.id]) ?? suggestedBankFor(request.currency)

    const approved = approveRequest(request.id, {
      routedBankKey: routedBank.key,
      routedBankName: routedBank.name,
      routedBankBic: routedBank.bic,
    })
    if (!approved) return

    // Debit the principal as the outgoing payment.
    addDebit({
      id: request.id,
      amount: request.amount,
      currency: request.currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: request.beneficiary,
      account: request.iban,
      bank: request.swiftCode,
      reference: request.reference,
      comment: `Outgoing SWIFT payment to ${request.beneficiary} (${request.beneficiaryCountry}), routed via ${routedBank.name} (${routedBank.bic}), approved by Administrator.`,
      category: "Outgoing Transfer",
    })
    // Debit the 2% platform fee as a separate entry.
    if (request.fee > 0) {
      addDebit({
        id: `${request.id}-FEE`,
        amount: request.fee,
        currency: request.currency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: "MCC Platform Fee (2%)",
        reference: `${request.reference} — fee`,
        category: "Payment Fee",
      })
    }

    toast.success("Payment approved", {
      description: `${formatCurrency(request.amount, request.currency)} to ${request.beneficiary} has been approved, routed via ${routedBank.name}, and debited.`,
    })
    logActivity({
      action: `Administrator approved payment ${request.id} of ${formatCurrency(request.amount, request.currency)} to ${request.beneficiary}`,
      category: "Administration",
      details: {
        summary: `Administrator approved outgoing payment ${request.id} to ${request.beneficiary} (${request.beneficiaryCountry}). Routed through ${routedBank.name} (${routedBank.bic}). Debited ${formatCurrency(request.amount, request.currency)} plus a ${formatCurrency(request.fee, request.currency)} platform fee (2%) for a total of ${formatCurrency(request.total, request.currency)}. IBAN ${request.iban}, SWIFT ${request.swiftCode}.`,
        paymentId: request.id,
        beneficiary: request.beneficiary,
        routedVia: `${routedBank.name} (${routedBank.bic})`,
        amount: formatCurrency(request.amount, request.currency),
        platformFee: formatCurrency(request.fee, request.currency),
        totalDebited: formatCurrency(request.total, request.currency),
        decision: "Approved",
      },
    })
  }

  const confirmReject = () => {
    if (!rejectTarget) return
    const request = rejectTarget
    rejectRequest(request.id, rejectReason)
    toast.success("Payment rejected", {
      description: `The request for ${formatCurrency(request.amount, request.currency)} to ${request.beneficiary} was rejected. No funds were moved.`,
    })
    logActivity({
      action: `Administrator rejected payment ${request.id} of ${formatCurrency(request.amount, request.currency)} to ${request.beneficiary}`,
      category: "Administration",
      details: {
        summary: `Administrator rejected outgoing payment ${request.id} to ${request.beneficiary} (${request.beneficiaryCountry}) for ${formatCurrency(request.amount, request.currency)}. No funds were debited.${rejectReason.trim() ? ` Reason: ${rejectReason.trim()}` : ""}`,
        paymentId: request.id,
        beneficiary: request.beneficiary,
        amount: formatCurrency(request.amount, request.currency),
        decision: "Rejected",
        reason: rejectReason.trim() || "(none)",
      },
    })
    setRejectTarget(null)
    setRejectReason("")
  }

  // Stage 3: confirm an approved outgoing payment reached the beneficiary,
  // advancing it from "Approved & Initiated" to "Completed — Funds Delivered".
  // The funds already left the account at approval, so no money moves here. We
  // update the local view optimistically and persist to the server so the change
  // survives the next refresh and is reflected on the client's side.
  const handleMarkPaymentDelivered = async (request: PaymentRequest) => {
    markDelivered(request.id)
    toast.success("Payment marked delivered", {
      description: `${formatCurrency(request.amount, request.currency)} to ${request.beneficiary} is now confirmed delivered and complete.`,
    })
    logActivity({
      action: `Administrator confirmed payment ${request.id} delivered to ${request.beneficiary}`,
      category: "Administration",
      details: {
        summary: `Administrator confirmed outgoing payment ${request.id} to ${request.beneficiary} (${request.beneficiaryCountry}) was delivered to the beneficiary account. Funds ${formatCurrency(request.amount, request.currency)} already debited at approval; this is a delivery confirmation only.`,
        paymentId: request.id,
        beneficiary: request.beneficiary,
        amount: formatCurrency(request.amount, request.currency),
        decision: "Completed — Funds Delivered",
      },
    })
    if (request.approvalId) {
      const res = await adminMarkPaymentDelivered(ADMIN_PASSCODE, request.approvalId)
      if (!res.ok) {
        toast.error("Could not persist delivery", { description: res.error })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pending Decisions command center
  // A single index of everything awaiting an administrator decision across all
  // workflows. Each entry links to the full section below (which holds the
  // proper approve / reject / moderate controls for that item type), so the
  // admin can see and jump to anything outstanding from one place at the top.
  // ---------------------------------------------------------------------------
  // `view` is the section id passed to openView() so the banner can jump
  // straight to the section that actually holds the approve/reject controls.
  // All request-type counts now come from the DB (cross-client). Each entry
  // jumps to the unified "approvals" dashboard, pre-filtered to that type, so
  // clicking a count always lands on a section that actually shows the items —
  // regardless of which client submitted them. KYC keeps its own count/section
  // since the BeneficiaryManager already provides the full cross-client review.
  const pendingCategories: {
    id: string
    view: string
    label: string
    count: number
    icon: typeof ShieldCheck
    kind?: ApprovalKind
  }[] = [
    { id: "section-kyc", view: "kyc", label: "KYC Verification", count: pendingKycCount, icon: ShieldCheck },
    { id: "section-gateway", view: "gateway", label: "Gateway Accounts", count: pendingGatewayCount, icon: Globe },
    { id: "section-swiftrouting", view: "swiftrouting", label: "SWIFT Routing", count: pendingSwiftRoutingCount, icon: Send },
    { id: "section-payments", view: "approvals", kind: "payment", label: "Outgoing Payments", count: dbPending.payment ?? 0, icon: ArrowUpRight },
    { id: "section-instruments", view: "approvals", kind: "instrument", label: "Bank Instruments", count: dbPending.instrument ?? 0, icon: FileText },
    { id: "section-ppp", view: "approvals", kind: "ppp", label: "Yield / PPP", count: dbPending.ppp ?? 0, icon: TrendingUp },
    { id: "section-funding", view: "approvals", kind: "project_funding", label: "Project Funding", count: dbPending.project_funding ?? 0, icon: Building2 },
    { id: "section-fiduciary", view: "approvals", kind: "fiduciary", label: "Fiduciary & Assets", count: dbPending.fiduciary ?? 0, icon: Landmark },
    { id: "section-leverage", view: "approvals", kind: "leverage", label: "Leverage Lines", count: dbPending.leverage ?? 0, icon: Gauge },
    { id: "section-switchoff", view: "approvals", kind: "leverage_switchoff", label: "Leverage Switch-Off", count: dbPending.leverage_switchoff ?? 0, icon: Power },
    { id: "section-dof", view: "approvals", kind: "dof", label: "Download of Funds", count: dbPending.dof ?? 0, icon: Banknote },
    { id: "section-monetization", view: "approvals", kind: "monetization", label: "Instrument Monetization", count: dbPending.monetization ?? 0, icon: Landmark },
    { id: "section-dtc", view: "approvals", kind: "dtc", label: "DTC Settlement", count: dbPending.dtc ?? 0, icon: Layers },
    { id: "section-euroclear", view: "approvals", kind: "euroclear", label: "Euroclear Settlement", count: dbPending.euroclear ?? 0, icon: Globe },
    { id: "section-commodity", view: "approvals", kind: "commodity", label: "Commodity Deals", count: dbPending.commodity ?? 0, icon: Ship },
  ]

  const actionablePending = pendingCategories.filter((c) => c.count > 0)
  const totalPendingDecisions = actionablePending.reduce((sum, c) => sum + c.count, 0)

  // Open a command-center entry: deep-link into the unified dashboard with the
  // right type pre-selected, or fall back to the entry's own section (KYC).
  const openPending = (c: { view: string; kind?: ApprovalKind }) => {
    setApprovalsInitialKind(c.kind)
    openView(c.view)
  }

  // ---------------------------------------------------------------------------
  // Admin Menu registry
  // Every admin feature is exposed as a clickable card grouped by area. Clicking
  // a card opens that section (activeView); counts surface outstanding work.
  // ---------------------------------------------------------------------------
  const navGroups = [
    {
      title: "Approvals & Requests",
      items: [
        { id: "approvals", label: "All Pending Approvals", description: "Cross-client queue for every request type, with bulk actions.", icon: ClipboardList, count: dbPendingTotal },
        { id: "payments", label: "Outgoing Payments", description: "Review and authorize pending wire transfers.", icon: ArrowUpRight, count: pending.length },
        { id: "instruments", label: "Bank Instruments", description: "Approve SBLC, BG and MTN issuance requests.", icon: FileText, count: pendingInstruments.length },
        { id: "ppp", label: "Yield / PPP", description: "Review private placement & yield applications.", icon: TrendingUp, count: pendingPPP.length },
        { id: "funding", label: "Project Funding", description: "Assess AES project funding applications.", icon: Building2, count: pendingFunding.length },
        { id: "leverage", label: "Leverage Lines", description: "Approve leverage and switch-off requests.", icon: Gauge, count: pendingLeverage.length + pendingSwitchOff.length },
        { id: "fiduciary", label: "Fiduciary & Assets", description: "Process fiduciary service jobs.", icon: Landmark, count: pendingFiduciary.length },
        { id: "dof", label: "Download of Funds", description: "Authorize download-of-funds requests.", icon: Banknote, count: pendingDOF.length },
        { id: "monetization", label: "Monetization", description: "Review instrument monetization requests.", icon: Layers, count: pendingMonetization.length },
        { id: "cards", label: "Payment Cards", description: "Review, customize and issue client payment cards.", icon: CreditCard, count: dbPending.card ?? 0 },
      ],
    },
    {
      title: "Settlement & Trading",
      items: [
        { id: "settlement", label: "Securities Settlement", description: "DTC and Euroclear settlement instructions.", icon: Globe, count: pendingDTC.length + pendingEuroclear.length },
        { id: "commodity", label: "Commodity Deals", description: "POP/POF review and trade execution.", icon: Ship, count: pendingDeals.length },
        { id: "spotdeals", label: "Spot Deals & Vessels", description: "Manage tankers and publish limited-time spot offers.", icon: Tag, count: 0 },
      ],
    },
    {
      title: "Safe Keeping Receipts (SKR)",
      items: [
        { id: "skr-overview", label: "SKR Overview", description: "Portfolio-wide custody position across every client.", icon: Gauge, count: 0 },
        { id: "skr", label: "SKR Management", description: "Create, assign, transfer and administer safe-keeping receipts.", icon: ShieldCheck, count: 0 },
      ],
    },
    {
      title: "Administration",
      items: [
        { id: "users", label: "Client Accounts", description: "Create, edit, suspend and reset users.", icon: Users, count: 0 },
        { id: "membership", label: "Membership Upgrades", description: "Approve tiers and validate deposits.", icon: Award, count: 0 },
        { id: "balances", label: "Balances & Transactions", description: "Credit, debit, adjust and reverse.", icon: Wallet, count: 0 },
        { id: "kyc", label: "KYC / Beneficiaries", description: "Verify beneficiaries and KYC documents.", icon: BadgeCheck, count: pendingKycCount },
        { id: "gateway", label: "Payment Gateway", description: "Approve client account requests; configure partner banks and routing.", icon: Settings, count: pendingGatewayCount },
        { id: "swiftrouting", label: "SWIFT Routing", description: "Review client SWIFT messages and route them to the chosen beneficiary.", icon: Send, count: pendingSwiftRoutingCount },
        { id: "reconciliation", label: "Reconciliation", description: "Automated payment reconciliation engine.", icon: Repeat, count: 0 },
        { id: "treasury", label: "Treasury Services", description: "Security deposits and 1:10 leverage.", icon: Landmark, count: 0 },
        { id: "certificates", label: "Certificates", description: "Issue and re-issue official certificates.", icon: ScrollText, count: pendingCertificateCount },
        { id: "bankeka", label: "Bankeka Messenger", description: "Broadcast secure messages and reply to clients.", icon: MessageSquareText, count: 0 },
      ],
    },
    {
      title: "System",
      items: [
        { id: "traceability", label: "Document Traceability", description: "Trace any generated document back to the account, IP and biometric on file.", icon: Fingerprint, count: 0 },
        { id: "audit", label: "Security Audit", description: "Trace any client's logins, devices, location, identity, selfie and full activity history.", icon: ShieldCheck, count: 0 },
        { id: "danger", label: "Danger Zone", description: "Reset account data to a brand-new state.", icon: AlertTriangle, count: 0 },
      ],
    },
  ]

  const activeNav = navGroups.flatMap((g) => g.items).find((i) => i.id === activeView) ?? null

  const openView = (id: string) => {
    setActiveView(id)
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const scrollToSection = (id: string) => {
    if (typeof document === "undefined") return
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
      // Brief highlight so the admin sees which section they landed on.
      el.classList.add("ring-2", "ring-primary", "ring-offset-2", "ring-offset-background")
      window.setTimeout(
        () => el.classList.remove("ring-2", "ring-primary", "ring-offset-2", "ring-offset-background"),
        1600,
      )
    }
  }

  // Passcode gate
  if (!unlocked) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center justify-center py-16">
        <Card className="w-full bg-card border-border">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl font-semibold">Administrator Area</CardTitle>
            <p className="text-sm text-muted-foreground text-pretty">
              This area is restricted. Enter the Administrator passcode to review and approve
              outgoing payments, bank instrument requests, and Yield/PPP applications.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-passcode">Administrator Passcode</Label>
              <Input
                id="admin-passcode"
                type="password"
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value)
                  setGateError(null)
                }}
                onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                placeholder="Enter passcode"
                autoComplete="off"
              />
              {gateError && (
                <p className="text-sm text-destructive" role="alert">
                  {gateError}
                </p>
              )}
            </div>
            <Button className="w-full" onClick={handleUnlock}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Unlock Administrator Panel
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Top bar: branding + exit + lock (always visible) */}
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={() => openView("menu")}
          className="flex items-start gap-3 text-left"
          aria-label="Back to Admin Menu"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Administrator Panel</h1>
            <p className="text-sm text-muted-foreground text-pretty">
              MCC Capital · Banking &amp; Trade Platform control center
            </p>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleLock}>
            <Lock className="mr-2 h-4 w-4" />
            Lock Panel
          </Button>
          <Button variant="default" size="sm" asChild>
            <a href="/dashboard">
              <LogOut className="mr-2 h-4 w-4" />
              Exit Admin Panel
            </a>
          </Button>
        </div>
      </div>

      {/* Breadcrumb / back bar — shown inside any section */}
      {activeView !== "menu" && activeNav && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => openView("menu")}
              className="font-medium text-foreground hover:text-primary"
            >
              Admin Menu
            </button>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground">{activeNav.label}</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => openView("menu")}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Admin Menu
          </Button>
        </div>
      )}

      {/* ============================= ADMIN MENU ============================= */}
      {activeView === "menu" && (
        <div className="space-y-6">

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="bg-card border-border">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs text-muted-foreground">Pending Approval</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {pending.length +
                  pendingInstruments.length +
                  pendingPPP.length +
                  pendingFunding.length +
                  pendingFiduciary.length +
                  pendingDOF.length +
                  pendingMonetization.length +
                  pendingLeverage.length +
                  pendingSwitchOff.length}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {pending.length} payments · {pendingInstruments.length} instruments ·{" "}
                {pendingPPP.length} PPP · {pendingFunding.length} funding ·{" "}
                {pendingFiduciary.length} fiduciary · {pendingDOF.length} DOF ·{" "}
                {pendingMonetization.length} monetization · {pendingLeverage.length} leverage ·{" "}
                {pendingSwitchOff.length} switch-off
              </p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <Clock className="h-5 w-5 text-yellow-400" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs text-muted-foreground">Awaiting Total</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {formatCurrency(
                  pending
                    .filter((r) => r.currency === MASTER_ACCOUNT_CURRENCY)
                    .reduce((s, r) => s + r.total, 0),
                  MASTER_ACCOUNT_CURRENCY,
                )}
              </p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <ArrowUpRight className="h-5 w-5 text-red-400" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="flex items-center justify-between p-4">
            <div>
              <p className="text-xs text-muted-foreground">Available Balance</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {formatCurrency(masterBalance, MASTER_ACCOUNT_CURRENCY)}
              </p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <Building2 className="h-5 w-5 text-blue-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Outstanding-work alert banner */}
      {totalPendingDecisions > 0 ? (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col gap-4 p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary/15 p-2">
                <Clock className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {totalPendingDecisions} item{totalPendingDecisions === 1 ? "" : "s"} awaiting a decision
                </p>
                <p className="text-xs text-muted-foreground text-pretty">
                  Tap an item below to jump straight to where you can approve, reject or process it.
                </p>
              </div>
            </div>
            {/* Actionable breakdown — one button per outstanding queue so the
                admin can jump directly instead of hunting through sections. */}
            <div className="flex flex-wrap gap-2">
              {actionablePending.map((c) => {
                const Icon = c.icon
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openPending(c)}
                    className="flex items-center gap-2 rounded-lg border border-primary/30 bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-secondary"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary" />
                    <span className="font-medium text-foreground">{c.label}</span>
                    <Badge className="shrink-0">{c.count}</Badge>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="rounded-lg bg-secondary p-2">
              <Check className="h-5 w-5 text-green-400" />
            </div>
            <p className="text-sm text-muted-foreground">
              All caught up. No items are currently awaiting a decision.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Interactive section menu — grouped clickable cards */}
      <div className="space-y-8">
        {navGroups.map((group) => (
          <div key={group.title} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h2>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openView(item.id)}
                    className="group flex items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-secondary"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-foreground">{item.label}</p>
                        {item.count > 0 && <Badge className="shrink-0">{item.count}</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground text-pretty">
                        {item.description}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
        </div>
      )}
      {/* =========================== END ADMIN MENU =========================== */}

      {/* Unified cross-client Pending Approvals dashboard */}
      {activeView === "approvals" && <PendingApprovals initialKind={approvalsInitialKind} />}

      {/* Outgoing Payments section */}
      {activeView === "payments" && (
      <div className="space-y-6">
      {/* Pending requests */}
      <Card id="section-payments" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Payment Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pending.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending requests. All outgoing payments have been reviewed.
              </p>
            </div>
          ) : (
            pending.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border bg-secondary/30 p-4"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <span className="font-medium text-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">To:</span>
                        <span className="font-medium text-foreground">{r.beneficiary}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Country:</span>
                        <span className="text-foreground">{r.beneficiaryCountry}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">IBAN:</span>
                        <span className="break-all font-mono text-xs text-foreground">{r.iban}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">SWIFT:</span>
                        <span className="font-mono text-xs text-foreground">{r.swiftCode}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Reference:</span>
                        <span className="text-foreground">{r.reference}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Source:</span>
                        <span className="text-foreground">{r.payeeSource}</span>
                      </div>
                    </div>
                    {r.notes && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        <span className="font-medium">Notes:</span> {r.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="font-medium text-foreground">
                          {formatCurrency(r.amount, r.currency)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-muted-foreground">Fee (2%)</span>
                        <span className="text-foreground">{formatCurrency(r.fee, r.currency)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 font-semibold">
                        <span className="text-foreground">Total</span>
                        <span className="text-foreground">{formatCurrency(r.total, r.currency)}</span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-border bg-card p-3">
                      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Landmark className="h-3.5 w-3.5" />
                        Route via partner bank
                      </Label>
                      <Select
                        value={payoutBankByRequest[r.id] ?? suggestedBankFor(r.currency).key}
                        onValueChange={(value) =>
                          setPayoutBankByRequest((prev) => ({ ...prev, [r.id]: value }))
                        }
                      >
                        <SelectTrigger className="mt-2 h-9 text-xs">
                          <SelectValue placeholder="Select payout bank" />
                        </SelectTrigger>
                        <SelectContent>
                          {banksForCurrency(r.currency).map((bank) => (
                            <SelectItem key={bank.key} value={bank.key} className="text-xs">
                              {bank.name} · {bank.bic}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                        Defaults to the suggested {r.currency} correspondent. Settlement is routed
                        through the selected principal partner bank.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApprove(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectReason("")
                          setRejectTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decided.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Approved and rejected requests will appear here.
            </p>
          ) : (
            decided.map((r) => {
              // Three-stage lifecycle: review → initiated → delivered (+ rejected).
              const stage = getPaymentStage(r)
              const canMarkDelivered = stage === "initiated"
              return (
              <div
                key={r.id}
                className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className={cn("text-[10px]", PAYMENT_STAGE_BADGE_CLASS[stage])}>
                    {stage === "delivered" ? (
                      <PackageCheck className="mr-1 h-3 w-3" />
                    ) : stage === "rejected" ? (
                      <X className="mr-1 h-3 w-3" />
                    ) : (
                      <Check className="mr-1 h-3 w-3" />
                    )}
                    {PAYMENT_STAGE_SHORT[stage]}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {r.beneficiary} · {formatCurrency(r.amount, r.currency)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 sm:justify-end">
                  {canMarkDelivered && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 text-emerald-600"
                      onClick={() => handleMarkPaymentDelivered(r)}
                      title="Confirm the funds reached the beneficiary account. Marks this payment complete for the client."
                    >
                      <PackageCheck className="h-3.5 w-3.5" /> Mark funds delivered
                    </Button>
                  )}
                  <span className="text-sm font-medium text-foreground">
                    {formatCurrency(r.total, r.currency)}
                  </span>
                </div>
              </div>
              )
            })
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Payment Cards section */}
      {activeView === "cards" && (
      <div className="space-y-6">
        <CardManager />
      </div>
      )}

      {/* Bank Instruments section */}
      {activeView === "instruments" && (
      <div className="space-y-6">
      {/* Issue a bank instrument directly into a client's portfolio */}
      <InstrumentIssuer />
      {/* Publish real, registry-verified instruments to the client marketplace */}
      <MarketplaceInstrumentManager />
      {/* Pending instrument requests */}
      <Card id="section-instruments" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Instrument Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingInstruments.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending instrument requests. All bank instruments have been reviewed.
              </p>
            </div>
          ) : (
            pendingInstruments.map((i) => (
              <div key={i.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {i.type}
                      </Badge>
                      <span className="font-medium text-foreground">{i.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(i.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Instrument:</span>
                        <span className="font-medium text-foreground">{i.typeFull}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Issuer:</span>
                        <span className="text-foreground">{i.issuer}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Purpose:</span>
                        <span className="text-foreground">{i.purpose}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Rating:</span>
                        <span className="text-foreground">{i.rating}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Issued:</span>
                        <span className="text-foreground">{i.issuedDate}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Expiry:</span>
                        <span className="text-foreground">{i.expiryDate}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Face Value</span>
                        <span className="font-semibold text-foreground">{formatFace(i)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        size="sm"
                        onClick={() => handleApproveInstrument(i)}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectInstrumentReason("")
                          setRejectInstrumentTarget(i)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Instrument decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Instrument Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedInstruments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Approved and rejected instruments will appear here.
            </p>
          ) : (
            decidedInstruments.map((i) => (
              <div
                key={i.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      i.status === "active"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {i.status === "active" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {i.status === "active" ? "Approved" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {i.type} · {i.typeFull}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {i.id} · {formatTimestamp(i.decidedAt)}
                      {i.decisionNote ? ` · ${i.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{formatFace(i)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Yield / PPP section */}
      {activeView === "ppp" && (
      <div className="space-y-6">
      {/* Pending PPP applications */}
      <Card id="section-ppp" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Yield/PPP Applications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingPPP.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending Yield/PPP applications. All applications have been reviewed.
              </p>
            </div>
          ) : (
            pendingPPP.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <span className="font-medium text-foreground">{r.programName}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Expected Return:</span>
                        <span className="font-medium text-foreground">{r.expectedReturn}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Duration:</span>
                        <span className="text-foreground">{r.duration}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Source:</span>
                        <span className="text-foreground">{r.sourceOfFunds}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Payout:</span>
                        <span className="text-foreground">{r.payoutAccount}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Investment</span>
                        <span className="font-semibold text-foreground">
                          {formatPPPAmount(r)}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApprovePPP(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectPPPReason("")
                          setRejectPPPTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* PPP decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Yield/PPP Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedPPP.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Approved and rejected applications will appear here.
            </p>
          ) : (
            decidedPPP.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Approved" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.programName}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{formatPPPAmount(r)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Project Funding section */}
      {activeView === "funding" && (
      <div className="space-y-6">
      {/* Admin-originated project finance + treasury financing */}
      <ProjectFinanceAdmin onDone={() => void loadAdminFunding()} />

      {/* Pending Project Funding applications */}
      <Card id="section-funding" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Project Funding (AES)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingFunding.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending project funding applications. All applications have been reviewed.
              </p>
            </div>
          ) : (
            pendingFunding.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <span className="font-medium text-foreground">{r.projectName}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    {r.ownerName && (
                      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs">
                        <User className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground">Applicant:</span>
                        <span className="font-medium text-foreground">{r.ownerName}</span>
                        {r.ownerEmail && <span className="text-muted-foreground">· {r.ownerEmail}</span>}
                        {r.ownerCompany && <span className="text-muted-foreground">· {r.ownerCompany}</span>}
                      </div>
                    )}
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Sector:</span>
                        <span className="text-foreground">{r.sector}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Jurisdiction:</span>
                        <span className="text-foreground">{r.jurisdiction}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Total Equity:</span>
                        <span className="text-foreground">
                          {r.currency} {Math.round(r.totalEquity).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Equity:</span>
                        <span className="text-foreground">
                          {r.equityComponents
                            .map((c) => AES_EQUITY_COMPONENTS.find((x) => x.id === c)?.label ?? c)
                            .join(", ")}
                        </span>
                      </div>
                    </div>
                    {r.description && (
                      <p className="text-xs text-muted-foreground text-pretty">{r.description}</p>
                    )}
                    {r.uploadedDocuments && r.uploadedDocuments.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          Docs ({r.uploadedDocuments.length}):
                        </span>
                        {r.uploadedDocuments.map((d) => (
                          <Badge
                            key={d.docId}
                            variant="outline"
                            className="gap-1 border-border bg-secondary/40 text-[10px] font-normal text-foreground"
                          >
                            <FileText className="h-3 w-3" />
                            {d.title}
                          </Badge>
                        ))}
                        {r.waiverFeeApplies && (
                          <Badge
                            variant="outline"
                            className="border-yellow-500/20 bg-yellow-500/10 text-[10px] text-yellow-500"
                          >
                            No bank statement · {r.waiverFeeCurrency}{" "}
                            {(r.waiverFeeAmount ?? 0).toLocaleString()} fee{" "}
                            {r.waiverFeeAccepted ? "accepted" : "pending"}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Facility</span>
                        <span className="font-semibold text-foreground">
                          {formatFundingAmount(r)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-muted-foreground">Cash commitment</span>
                        <span className="text-xs text-foreground">
                          {r.currency} {Math.round(r.cashCommitmentMin).toLocaleString()} –{" "}
                          {Math.round(r.cashCommitmentMax).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        size="sm"
                        onClick={() => {
                          setApproveFundingScore("5")
                          setApproveFundingTarget(r)
                        }}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectFundingReason("")
                          setRejectFundingTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Project Funding decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Project Funding Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedFunding.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Approved and rejected applications will appear here.
            </p>
          ) : (
            decidedFunding.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Approved" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.projectName}</p>
                    {r.ownerName && (
                      <p className="text-xs text-foreground/80">
                        {r.ownerName}
                        {r.ownerEmail ? ` · ${r.ownerEmail}` : ""}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.status === "approved" && typeof r.riskScore === "number"
                        ? ` · Risk ${r.riskScore}/10`
                        : ""}
                      {r.closedAt ? " · Settled / closed" : ""}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{formatFundingAmount(r)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Client early-closure requests awaiting a decision */}
      {fundingClosureRequests.length > 0 && (
        <Card className="border-yellow-500/30 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Clock className="h-5 w-5 text-yellow-500" />
              Early Closure Requests
              <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500">
                {fundingClosureRequests.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {fundingClosureRequests.map((r) => {
              const payoff = computeFundingSettlement(r, new Date())
              return (
                <div key={r.id} className="rounded-lg border border-yellow-500/20 bg-secondary/30 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{r.projectName}</span>
                        <span className="text-xs text-muted-foreground">{r.id}</span>
                      </div>
                      <p className="flex items-center gap-1 text-xs text-foreground">
                        <User className="h-3 w-3 text-muted-foreground" />
                        {r.ownerName ?? "Account holder"}
                        {r.ownerEmail ? <span className="text-muted-foreground">· {r.ownerEmail}</span> : null}
                      </p>
                      {r.closureRequest?.note && (
                        <p className="text-xs italic text-muted-foreground text-pretty">
                          &ldquo;{r.closureRequest.note}&rdquo;
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Requested {formatTimestamp(r.closureRequest?.requestedAt)}
                      </p>
                    </div>
                    <div className="flex flex-col items-stretch gap-3 lg:w-64 lg:shrink-0">
                      <div className="rounded-lg border border-border bg-card p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Principal</span>
                          <span className="text-foreground">{formatMoney(payoff.currency, payoff.principal)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-muted-foreground">Interest to date</span>
                          <span className="text-foreground">{formatMoney(payoff.currency, payoff.interest)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-muted-foreground">Early-exit fee</span>
                          <span className="text-foreground">{formatMoney(payoff.currency, payoff.fee)}</span>
                        </div>
                        <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                          <span className="font-medium text-muted-foreground">Payoff</span>
                          <span className="font-semibold text-foreground">{formatMoney(payoff.currency, payoff.total)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          className="flex-1"
                          size="sm"
                          onClick={() => {
                            setCloseFundingNote("")
                            setCloseFundingTarget({ facility: r, kind: "client_early" })
                          }}
                        >
                          <Check className="mr-1 h-4 w-4" />
                          Approve &amp; settle
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => {
                            setDeclineClosureReason("")
                            setDeclineClosureTarget(r)
                          }}
                        >
                          <X className="mr-1 h-4 w-4" />
                          Decline
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Active facilities — recall / terminate / liquidate */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Active Facilities</CardTitle>
          <p className="text-sm text-muted-foreground">
            Funded facilities currently on client balances. Recall to claw back the capital, settle
            outstanding cost of capital and the early-exit fee, and close the facility.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeFundingFacilities.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No active facilities. Approved facilities that have not been settled will appear here.
            </p>
          ) : (
            activeFundingFacilities.map((r) => {
              const payoff = computeFundingSettlement(r, new Date())
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-3 rounded-lg border border-border p-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-[10px] text-green-500">
                        <Check className="mr-1 h-3 w-3" />
                        Active
                      </Badge>
                      <span className="font-medium text-foreground">{r.projectName}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      {r.closureRequest && (
                        <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-[10px] text-yellow-500">
                          Closure requested
                        </Badge>
                      )}
                    </div>
                    <p className="flex items-center gap-1 text-xs text-foreground">
                      <User className="h-3 w-3 text-muted-foreground" />
                      {r.ownerName ?? "Account holder"}
                      {r.ownerEmail ? <span className="text-muted-foreground">· {r.ownerEmail}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Facility {formatFundingAmount(r)} · funded {formatTimestamp(r.decidedAt)} · payoff today{" "}
                      <span className="font-medium text-foreground">{formatMoney(payoff.currency, payoff.total)}</span>
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive lg:shrink-0"
                    onClick={() => {
                      setCloseFundingNote("")
                      setCloseFundingTarget({ facility: r, kind: "admin_recall" })
                    }}
                  >
                    <Undo2 className="mr-1 h-4 w-4" />
                    Recall / Liquidate
                  </Button>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Leverage Lines section */}
      {activeView === "leverage" && (
      <div className="space-y-6">
      {/* Pending leverage requests */}
      <Card id="section-leverage" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Leverage Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingLeverage.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending leverage requests. All trading lines have been reviewed.
              </p>
            </div>
          ) : (
            pendingLeverage.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <span className="font-medium text-foreground">
                        {r.accountLabel} · 1:{r.leverageRatio}
                      </span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Banknote className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Equity:</span>
                        <span className="font-medium text-foreground">
                          {formatLeverageMoney(r, r.equity)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Gauge className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Leverage:</span>
                        <span className="text-foreground">1:{r.leverageRatio}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Instrument:</span>
                        <span className="text-foreground">{r.instrumentType}</span>
                      </div>
                      {r.notes && (
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Notes:</span>
                          <span className="text-foreground">{r.notes}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-64 lg:shrink-0">
                    <div className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Borrowed (credit on approve)</span>
                        <span className="font-semibold text-green-500">
                          +{formatLeverageMoney(r, r.borrowedAmount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Buying Power</span>
                        <span className="font-semibold text-foreground">
                          {formatLeverageMoney(r, r.buyingPower)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Debit Interest</span>
                        <span className="text-foreground">{(r.interestRate * 100).toFixed(1)}% / yr</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApproveLeverage(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectLeverageReason("")
                          setRejectLeverageTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Pending leverage switch-off requests */}
      <Card id="section-switchoff" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Leverage Switch-Off</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingSwitchOff.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending switch-off requests. Active lines awaiting closure will appear here.
              </p>
            </div>
          ) : (
            pendingSwitchOff.map((r) => {
              const interest = accruedInterest(r, Date.now())
              const total = r.borrowedAmount + interest
              return (
                <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className="border-orange-500/20 bg-orange-500/10 text-orange-400 text-[10px]"
                        >
                          <Power className="mr-1 h-3 w-3" />
                          Switch-Off Requested
                        </Badge>
                        <span className="font-medium text-foreground">
                          {r.accountLabel} · 1:{r.leverageRatio}
                        </span>
                        <span className="text-xs text-muted-foreground">{r.id}</span>
                        <span className="text-xs text-muted-foreground">
                          Requested {formatTimestamp(r.switchOffRequestedAt)}
                        </span>
                      </div>
                      <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <Banknote className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Equity:</span>
                          <span className="font-medium text-foreground">
                            {formatLeverageMoney(r, r.equity)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Gauge className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Activated:</span>
                          <span className="text-foreground">{formatTimestamp(r.activatedAt)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-stretch gap-3 lg:w-64 lg:shrink-0">
                      <div className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Principal to repay</span>
                          <span className="font-semibold text-foreground">
                            {formatLeverageMoney(r, r.borrowedAmount)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Accrued interest</span>
                          <span className="font-semibold text-orange-400">
                            {formatLeverageMoney2(r, interest)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between border-t border-border pt-1.5">
                          <span className="font-medium text-foreground">Total deducted</span>
                          <span className="font-bold text-foreground">
                            {formatLeverageMoney2(r, total)}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button className="flex-1" size="sm" onClick={() => handleApproveSwitchOff(r)}>
                          <Power className="mr-1 h-4 w-4" />
                          Approve &amp; Settle
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => {
                            setRejectSwitchOffReason("")
                            setRejectSwitchOffTarget(r)
                          }}
                        >
                          <X className="mr-1 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Leverage exposure monitor */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Leverage Exposure by Category</CardTitle>
          <p className="text-sm text-muted-foreground">
            Firm-wide borrowed capital and buying power across funding categories, each measured
            against its leverage ceiling.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {leverageExposure.map((c) => (
            <div key={c.key} className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{c.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.count} active line{c.count === 1 ? "" : "s"} · blended 1:{c.blendedRatio.toFixed(1)} of
                    max 1:{c.maxLeverage}
                  </p>
                </div>
                <Badge variant="outline" className="border-primary/30 text-primary">
                  {c.utilisation.toFixed(0)}%
                </Badge>
              </div>
              <Progress value={c.utilisation} className="mt-3 h-1.5" />
              <div className="mt-3 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Borrowed exposure</span>
                <span className="font-medium text-foreground">
                  {c.currency} {c.borrowed.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Buying power</span>
                <span className="font-medium text-foreground">
                  {c.currency} {c.buyingPower.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Active leverage lines with ratio modification */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Active Leverage Lines</CardTitle>
          <p className="text-sm text-muted-foreground">
            Re-rate a live line within its category ceiling. Increasing the ratio credits additional
            borrowed funds; decreasing it repays the surplus from the client&apos;s balance.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeLeverage.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Gauge className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No active leverage lines. Approved trading lines will appear here.
              </p>
            </div>
          ) : (
            activeLeverage.map((r) => {
              const cap = maxLeverageFor(r.account)
              return (
                <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className="border-green-500/20 bg-green-500/10 text-green-500 text-[10px]"
                        >
                          <Check className="mr-1 h-3 w-3" />
                          Active
                        </Badge>
                        <span className="font-medium text-foreground">
                          {r.accountLabel} · 1:{r.leverageRatio}
                        </span>
                        <span className="text-xs text-muted-foreground">{r.id}</span>
                        <span className="text-xs text-muted-foreground">max 1:{cap}</span>
                        {r.modifications && r.modifications.length > 0 ? (
                          <Badge variant="outline" className="border-primary/30 text-primary text-[10px]">
                            {r.modifications.length} adjustment{r.modifications.length === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <Banknote className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Equity:</span>
                          <span className="font-medium text-foreground">{formatLeverageMoney(r, r.equity)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Buying Power:</span>
                          <span className="text-foreground">{formatLeverageMoney(r, r.buyingPower)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Gauge className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Borrowed:</span>
                          <span className="text-foreground">{formatLeverageMoney(r, r.borrowedAmount)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Instrument:</span>
                          <span className="text-foreground">{r.instrumentType}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-stretch gap-3 lg:w-64 lg:shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setModifyRatioValue(String(r.leverageRatio))
                          setModifyRatioNote("")
                          setModifyRatioTarget(r)
                        }}
                      >
                        <Gauge className="mr-1 h-4 w-4" />
                        Modify Ratio
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Leverage decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Leverage Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedLeverage.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Activated, closed and rejected leverage lines will appear here.
            </p>
          ) : (
            decidedLeverage.map((r) => {
              const badge =
                r.status === "approved"
                  ? { cls: "border-green-500/20 bg-green-500/10 text-green-500", icon: Check, label: "Activated" }
                  : r.status === "closed"
                    ? { cls: "border-border bg-secondary text-muted-foreground", icon: Power, label: "Closed" }
                    : { cls: "border-red-500/20 bg-red-500/10 text-red-500", icon: X, label: "Rejected" }
              const BadgeIcon = badge.icon
              return (
                <div
                  key={r.id}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className={cn("text-[10px]", badge.cls)}>
                      <BadgeIcon className="mr-1 h-3 w-3" />
                      {badge.label}
                    </Badge>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {r.accountLabel} · 1:{r.leverageRatio}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.id} · {formatTimestamp(r.closedAt || r.decidedAt)}
                        {r.status === "closed"
                          ? ` · interest settled ${formatLeverageMoney2(r, r.settledInterest ?? 0)}`
                          : r.decisionNote
                            ? ` · ${r.decisionNote}`
                            : ""}
                      </p>
                    </div>
                  </div>
                  <span className="text-sm font-medium text-foreground">
                    {r.status === "closed"
                      ? formatLeverageMoney(r, r.borrowedAmount)
                      : formatLeverageMoney(r, r.buyingPower)}
                  </span>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Fiduciary & Assets section */}
      {activeView === "fiduciary" && (
      <div className="space-y-6">
      {/* Pending Fiduciary service jobs */}
      <Card id="section-fiduciary" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Pending Fiduciary Service Jobs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingFiduciary.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending fiduciary service jobs. All requests have been actioned.
              </p>
            </div>
          ) : (
            pendingFiduciary.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <span className="font-medium text-foreground">{r.serviceLabel}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      {r.assetType && (
                        <div className="flex items-center gap-2">
                          <Landmark className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Asset:</span>
                          <span className="text-foreground">{r.assetType}</span>
                        </div>
                      )}
                      {r.estimatedValue > 0 && (
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Value:</span>
                          <span className="text-foreground">{fiduciaryValueText(r)}</span>
                        </div>
                      )}
                    </div>
                    {r.notes && (
                      <p className="text-xs text-muted-foreground text-pretty">{r.notes}</p>
                    )}
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApproveFiduciary(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectFiduciaryReason("")
                          setRejectFiduciaryTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Fiduciary decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Fiduciary Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedFiduciary.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Approved and rejected service jobs will appear here.
            </p>
          ) : (
            decidedFiduciary.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Approved" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.serviceLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{fiduciaryValueText(r)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Download of Funds section */}
      {activeView === "dof" && (
      <div className="space-y-6">
      {/* Pending Download of Funds */}
      <Card id="section-dof" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Pending Download of Funds (Institutional)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingDOF.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending Download of Funds requests. All requests have been reviewed.
              </p>
            </div>
          ) : (
            pendingDOF.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {r.settlementMethod}
                      </Badge>
                      <span className="font-medium text-foreground">{r.originatorName}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Sending Bank:</span>
                        <span className="text-foreground">
                          {r.originatorBank} ({r.originatorBankBic})
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Correspondent:</span>
                        <span className="text-foreground">{r.correspondentBank}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">MT103:</span>
                        <span className="text-foreground">{r.mt103Ref || "—"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">MT202:</span>
                        <span className="text-foreground">{r.mt202Ref || "—"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">POF / BCL:</span>
                        <span className="text-foreground">
                          {r.pofReference || "—"} / {r.bclReference || "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Value Date:</span>
                        <span className="text-foreground">{r.valueDate}</span>
                      </div>
                      {(r.isin || r.cusip) && (
                        <div className="flex items-center gap-2 sm:col-span-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Securities:</span>
                          <span className="text-foreground">
                            {r.isin ? `ISIN ${r.isin}` : ""}
                            {r.isin && r.cusip ? " · " : ""}
                            {r.cusip ? `CUSIP ${r.cusip}` : ""}
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      UETR {r.uetr}
                    </p>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="font-semibold text-foreground">{formatDOFAmount(r)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApproveDOF(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Authorize
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectDOFReason("")
                          setRejectDOFTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Download of Funds decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Download of Funds Decision History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedDOF.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Authorized and rejected requests will appear here.
            </p>
          ) : (
            decidedDOF.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Authorized" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.originatorName}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{formatDOFAmount(r)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Monetization section */}
      {activeView === "monetization" && (
      <div className="space-y-6">
      {/* Pending Bank Instrument Monetization */}
      <Card id="section-monetization" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Pending Bank Instrument Monetization
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingMonetization.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending monetization requests. All requests have been reviewed.
              </p>
            </div>
          ) : (
            pendingMonetization.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {r.instrumentType}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {MONETIZATION_STRUCTURE_LABELS[r.structure]}
                      </Badge>
                      <span className="font-medium text-foreground">{r.instrumentId}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Issuer:</span>
                        <span className="text-foreground">{r.issuer}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Face Value:</span>
                        <span className="text-foreground">
                          {formatCurrency(r.faceValue, r.currency)}
                        </span>
                      </div>
                      {r.leverageRatio ? (
                        <div className="flex items-center gap-2">
                          <Layers className="h-4 w-4 text-primary" />
                          <span className="text-muted-foreground">Leveraged Value:</span>
                          <span className="font-medium text-primary">
                            {formatCurrency(r.monetizedValue, r.currency)} (1:{r.leverageRatio})
                          </span>
                        </div>
                      ) : null}
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Advance Rate:</span>
                        <span className="text-foreground">
                          {r.advanceRatePercent}% LTV on {formatCurrency(r.monetizedValue, r.currency)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Debit Interest:</span>
                        <span className="text-foreground">
                          {(computeTieredInterest(r.grossProceeds).effectiveRate * 100).toFixed(2)}% p.a. blended ·{" "}
                          {formatCurrency(computeTieredInterest(r.grossProceeds).monthlyInterest, r.proceedsCurrency)}/mo
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Monetizer:</span>
                        <span className="text-foreground">{r.monetizationPlatform || "—"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">MT760 / MT799:</span>
                        <span className="text-foreground">
                          {r.mt760Ref || "—"} / {r.mt799Ref || "—"}
                        </span>
                        {(r.mt760Raw || r.mt799Raw) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => setSwiftViewTarget(r)}
                          >
                            Inspect FIN
                          </Button>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">POF / BCL:</span>
                        <span className="text-foreground">
                          {r.pofReference || "—"} / {r.bclReference || "—"}
                        </span>
                      </div>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      UETR {r.uetr}
                    </p>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Proceeds</span>
                        <span className="font-semibold text-foreground">
                          {formatMonetizationProceeds(r)}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        size="sm"
                        onClick={() => handleApproveMonetization(r)}
                      >
                        <Check className="mr-1 h-4 w-4" />
                        Authorize
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectMonetizationReason("")
                          setRejectMonetizationTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Monetization decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Monetization Decision History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedMonetization.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Authorized and rejected requests will appear here.
            </p>
          ) : (
            decidedMonetization.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Authorized" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.instrumentId}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">
                  {formatMonetizationProceeds(r)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Securities Settlement section (DTC + Euroclear) */}
      {activeView === "settlement" && (
      <div className="space-y-6">
      {/* Pending Securities Settlement (DTC / Euroclear) */}
      <Card id="section-dtc" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Pending Securities Settlement (DTC / Euroclear)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingDTC.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending securities settlement instructions. All have been reviewed.
              </p>
            </div>
          ) : (
            pendingDTC.map((r) => (
              <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {r.depository}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {r.direction === "deliver" ? "Deliver" : "Receive"} · {r.settlementBasis}
                      </Badge>
                      <span className="font-medium text-foreground">{r.securityName}</span>
                      <span className="text-xs text-muted-foreground">{r.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </span>
                    </div>
                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">ISIN:</span>
                        <span className="text-foreground">{r.isin}</span>
                      </div>
                      {r.cusip && (
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">CUSIP:</span>
                          <span className="text-foreground">{r.cusip}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Quantity:</span>
                        <span className="text-foreground">{r.quantity.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Counterparty:</span>
                        <span className="text-foreground">{r.counterpartyName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          {r.depository === "DTC" ? "Participant #" : "Euroclear Acct"}:
                        </span>
                        <span className="text-foreground">{r.participantNumber}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Settlement Date:</span>
                        <span className="text-foreground">{r.valueDate}</span>
                      </div>
                      {r.mt54xRef && (
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">MT540–543:</span>
                          <span className="text-foreground">{r.mt54xRef}</span>
                        </div>
                      )}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      UETR {r.uetr}
                    </p>
                  </div>

                  <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                    <div className="rounded-lg border border-border bg-card p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Cash Leg</span>
                        <span className="font-semibold text-foreground">{formatDTCCash(r)}</span>
                      </div>
                      {r.settlementBasis === "DVP" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.direction === "deliver"
                            ? "Will credit master account"
                            : "Will debit master account"}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button className="flex-1" size="sm" onClick={() => handleApproveDTC(r)}>
                        <Check className="mr-1 h-4 w-4" />
                        Authorize
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectDTCReason("")
                          setRejectDTCTarget(r)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Securities Settlement decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Securities Settlement Decision History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedDTC.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Settled and rejected instructions will appear here.
            </p>
          ) : (
            decidedDTC.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Settled" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {r.securityName}{" "}
                      <span className="text-xs text-muted-foreground">({r.depository})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">{formatDTCCash(r)}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Pending Euroclear Settlement (MT540-543) */}
      <Card id="section-euroclear" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Landmark className="h-5 w-5 text-primary" />
            Pending Euroclear Settlement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingEuroclear.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending Euroclear settlement instructions. All have been reviewed.
              </p>
            </div>
          ) : (
            pendingEuroclear.map((r) => {
              const mt =
                r.direction === "deliver"
                  ? r.settlementBasis === "DVP"
                    ? "543"
                    : "542"
                  : r.settlementBasis === "DVP"
                    ? "541"
                    : "540"
              return (
                <div key={r.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                        >
                          <Clock className="mr-1 h-3 w-3" />
                          Pending
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          Euroclear
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          MT{mt}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {r.direction === "deliver" ? "Deliver" : "Receive"} · {r.settlementBasis}
                        </Badge>
                        <span className="font-medium text-foreground">{r.securityName}</span>
                        <span className="text-xs text-muted-foreground">{r.id}</span>
                        <span className="text-xs text-muted-foreground">
                          Submitted {formatTimestamp(r.submittedAt)}
                        </span>
                      </div>
                      <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">ISIN:</span>
                          <span className="text-foreground">{r.isin}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Layers className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Quantity:</span>
                          <span className="text-foreground">{r.quantity.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Counterparty:</span>
                          <span className="text-foreground">{r.counterpartyName}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Euroclear Acct:</span>
                          <span className="text-foreground">{r.euroclearAccount}</span>
                        </div>
                        {r.custodianBank && (
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Custodian:</span>
                            <span className="text-foreground">{r.custodianBank}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Settlement Date:</span>
                          <span className="text-foreground">{r.valueDate}</span>
                        </div>
                        {r.mt54xRef && (
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">MT54x Ref:</span>
                            <span className="text-foreground">{r.mt54xRef}</span>
                          </div>
                        )}
                      </div>
                      <p className="font-mono text-xs text-muted-foreground break-all">
                        UETR {r.uetr}
                      </p>
                    </div>

                    <div className="flex flex-col items-stretch gap-3 lg:w-56 lg:shrink-0">
                      <div className="rounded-lg border border-border bg-card p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Cash Leg</span>
                          <span className="font-semibold text-foreground">
                            {formatEuroclearCash(r)}
                          </span>
                        </div>
                        {r.settlementBasis === "DVP" && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {r.direction === "deliver"
                              ? "Will credit master account"
                              : "Will debit master account"}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          className="flex-1"
                          size="sm"
                          onClick={() => handleApproveEuroclear(r)}
                        >
                          <Check className="mr-1 h-4 w-4" />
                          Authorize
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => {
                            setRejectEuroclearReason("")
                            setRejectEuroclearTarget(r)
                          }}
                        >
                          <X className="mr-1 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Euroclear Settlement decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Euroclear Settlement Decision History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedEuroclear.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Settled and rejected instructions will appear here.
            </p>
          ) : (
            decidedEuroclear.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      r.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {r.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {r.status === "approved" ? "Settled" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {r.securityName}{" "}
                      <span className="text-xs text-muted-foreground">(Euroclear · {r.isin})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.id} · {formatTimestamp(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">
                  {formatEuroclearCash(r)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Commodity Deals section */}
      {activeView === "commodity" && (
      <div className="space-y-6">
      {/* Cross-client approval queue (DB-backed): every commodity deal a client
          registers — including one-click quotation requests — appears here for
          approval/rejection regardless of which device it was submitted from. */}
      <PendingApprovals initialKind="commodity" />

      {/* Pending Commodity Deals (POP / POF review + execution authorization) —
          rich document review for deals present in this session's local store. */}
      <Card id="section-commodity" className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <Ship className="h-5 w-5 text-primary" />
            POP / POF Document Review &amp; Execution
          </CardTitle>
          <CardDescription className="text-pretty">
            Detailed Proof of Product / Proof of Funds review for deals available on this device.
            Use the approval queue above to approve or reject the registered deal itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pendingDeals.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending commodity deals. All have been reviewed.
              </p>
            </div>
          ) : (
            pendingDeals.map((deal) => {
              const popDocs = deal.documents.filter((d) => d.module === "POP")
              const pofDocs = deal.documents.filter((d) => d.module === "POF")
              const renderDoc = (doc: DealDocument) => {
                const latest = doc.versions[doc.versions.length - 1]
                return (
                  <div
                    key={doc.id}
                    className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            doc.status === "verified"
                              ? "border-green-500/20 bg-green-500/10 text-green-500"
                              : doc.status === "rejected"
                                ? "border-red-500/20 bg-red-500/10 text-red-500"
                                : "border-blue-500/20 bg-blue-500/10 text-blue-500",
                          )}
                        >
                          {doc.status === "verified"
                            ? "Verified"
                            : doc.status === "rejected"
                              ? "Rejected"
                              : "Submitted"}
                        </Badge>
                        <span className="text-sm font-medium text-foreground">{doc.docType}</span>
                        <Badge variant="outline" className="text-[10px]">
                          v{doc.currentVersion}
                        </Badge>
                        {doc.swiftRef && (
                          <Badge variant="outline" className="text-[10px]">
                            SWIFT {doc.swiftRef}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {latest?.fileName}
                        {latest?.reference ? ` · ${latest.reference}` : ""}
                        {latest?.issuedBy ? ` · ${latest.issuedBy}` : ""}
                        {latest?.issueDate ? ` · ${latest.issueDate}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 border-green-500/30 text-green-600 hover:bg-green-500/10"
                        disabled={doc.status === "verified"}
                        onClick={() => handleVerifyDoc(deal, doc)}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        Verify
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={doc.status === "rejected"}
                        onClick={() => {
                          setRejectDocReason("")
                          setRejectDocTarget({ deal, doc })
                        }}
                      >
                        <X className="mr-1 h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  </div>
                )
              }
              return (
                <div key={deal.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]"
                      >
                        <Clock className="mr-1 h-3 w-3" />
                        Pending
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {deal.category}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {deal.tradeStructure} · {deal.instrumentType}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        Stage: {DEAL_STAGES.find((s) => s.key === deal.stage)?.label}
                      </Badge>
                      <span className="font-medium text-foreground">{deal.title}</span>
                      <span className="text-xs text-muted-foreground">{deal.id}</span>
                      <span className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(deal.submittedAt)}
                      </span>
                    </div>

                    <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div className="flex items-center gap-2">
                        <Banknote className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Value:</span>
                        <span className="text-foreground">
                          {formatCurrency(deal.approxValue, deal.currency)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Commodity:</span>
                        <span className="text-foreground">{deal.commodity || "—"}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Quantity:</span>
                        <span className="text-foreground">
                          {formatQuantityWithEquivalent(deal.quantity, deal.commodity)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Banknote className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Unit price:</span>
                        <span className="text-foreground">
                          {formatUnitPriceFor(deal.approxValue, deal.quantity, deal.currency) || "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Route:</span>
                        <span className="text-foreground">
                          {deal.originCountry || "—"} → {deal.destinationCountry || "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Buyer:</span>
                        <span className="text-foreground">{deal.buyerName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Seller:</span>
                        <span className="text-foreground">{deal.sellerName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Banks:</span>
                        <span className="text-foreground">
                          {deal.sendingBankBic || deal.sendingBank || "—"} →{" "}
                          {deal.receivingBankBic || deal.receivingBank || "—"}
                        </span>
                      </div>
                    </div>

                    {(deal.mt103Ref || deal.mt202Ref || deal.mt799Ref) && (
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {deal.mt103Ref && <span>MT103: {deal.mt103Ref}</span>}
                        {deal.mt202Ref && <span>· MT202: {deal.mt202Ref}</span>}
                        {deal.mt799Ref && <span>· MT799: {deal.mt799Ref}</span>}
                      </div>
                    )}

                    {deal.notes && (
                      <p className="rounded-md border border-border bg-card p-2 text-xs text-muted-foreground text-pretty">
                        {deal.notes}
                      </p>
                    )}

                    <p className="font-mono text-xs text-muted-foreground break-all">UETR {deal.uetr}</p>

                    {/* Pending amendment — old → new, decided in the Approvals queue. */}
                    {deal.pendingAmendment?.status === "pending" && (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
                        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                          <Handshake className="h-3.5 w-3.5" />
                          Amendment pending — decide in the Pending Approvals queue
                        </div>
                        {(
                          [
                            {
                              label: "Value",
                              from: formatCurrency(deal.pendingAmendment.previous.approxValue, deal.currency),
                              to: formatCurrency(deal.pendingAmendment.proposed.approxValue, deal.currency),
                              changed:
                                Math.round(deal.pendingAmendment.previous.approxValue * 100) !==
                                Math.round(deal.pendingAmendment.proposed.approxValue * 100),
                            },
                            {
                              label: "Quantity",
                              from: deal.pendingAmendment.previous.quantity || "—",
                              to: deal.pendingAmendment.proposed.quantity || "—",
                              changed:
                                deal.pendingAmendment.previous.quantity !== deal.pendingAmendment.proposed.quantity,
                            },
                            {
                              label: "Terms",
                              from: deal.pendingAmendment.previous.tradeStructure,
                              to: deal.pendingAmendment.proposed.tradeStructure,
                              changed:
                                deal.pendingAmendment.previous.tradeStructure !==
                                deal.pendingAmendment.proposed.tradeStructure,
                            },
                          ] as const
                        ).map((r) => (
                          <div key={r.label} className="flex flex-wrap items-center gap-1.5">
                            <span className="w-14 shrink-0 text-muted-foreground">{r.label}:</span>
                            <span className={r.changed ? "text-muted-foreground line-through" : "text-foreground"}>
                              {r.from}
                            </span>
                            {r.changed && (
                              <>
                                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="font-medium text-foreground">{r.to}</span>
                              </>
                            )}
                          </div>
                        ))}
                        <p className="mt-1.5 text-muted-foreground">
                          <span className="font-medium text-foreground">Reason:</span>{" "}
                          {deal.pendingAmendment.reason}
                        </p>
                      </div>
                    )}

                    {/* Negotiation log + counterparty position (audit trail). */}
                    {(deal.negotiationNotes?.length || deal.counterpartyPosition) && (
                      <div className="rounded-md border border-border bg-card p-2.5 text-xs">
                        <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                          <MessageSquareText className="h-3.5 w-3.5 text-primary" />
                          Negotiation log
                        </p>
                        {deal.counterpartyPosition && (
                          <p className="mb-1.5 text-muted-foreground">
                            <span className="font-medium text-foreground">Counterparty position:</span>{" "}
                            {deal.counterpartyPosition}
                          </p>
                        )}
                        <div className="space-y-1">
                          {deal.negotiationNotes?.map((n) => (
                            <div key={n.id} className="text-muted-foreground">
                              <span className="font-medium text-foreground">{n.author}</span>
                              <span className="text-[10px]"> ({n.authorRole})</span>: {n.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* POP documents */}
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <Package className="h-4 w-4 text-primary" />
                        Proof of Product ({popDocs.length})
                      </p>
                      {popDocs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No POP documents submitted.</p>
                      ) : (
                        <div className="space-y-2">{popDocs.map(renderDoc)}</div>
                      )}
                    </div>

                    {/* POF documents */}
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <Banknote className="h-4 w-4 text-primary" />
                        Proof of Funds ({pofDocs.length})
                      </p>
                      {pofDocs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No POF documents submitted.</p>
                      ) : (
                        <div className="space-y-2">{pofDocs.map(renderDoc)}</div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      <Button size="sm" onClick={() => handleApproveDeal(deal)}>
                        <Check className="mr-1 h-4 w-4" />
                        Authorize Execution
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => {
                          setRejectDealReason("")
                          setRejectDealTarget(deal)
                        }}
                      >
                        <X className="mr-1 h-4 w-4" />
                        Reject Deal
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Commodity deal decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Commodity Deal Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {decidedDeals.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No decisions yet. Authorized and rejected deals will appear here.
            </p>
          ) : (
            decidedDeals.map((deal) => (
              <div
                key={deal.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      deal.status === "approved"
                        ? "border-green-500/20 bg-green-500/10 text-green-500"
                        : "border-red-500/20 bg-red-500/10 text-red-500",
                    )}
                  >
                    {deal.status === "approved" ? (
                      <Check className="mr-1 h-3 w-3" />
                    ) : (
                      <X className="mr-1 h-3 w-3" />
                    )}
                    {deal.status === "approved" ? "Authorized" : "Rejected"}
                  </Badge>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}{" "}
                      <span className="text-xs text-muted-foreground">({deal.category})</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {deal.id} · {formatTimestamp(deal.decidedAt)}
                      {deal.decisionNote ? ` · ${deal.decisionNote}` : ""}
                    </p>
                  </div>
                </div>
                <span className="text-sm font-medium text-foreground">
                  {formatCurrency(deal.approxValue, deal.currency)}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      </div>
      )}

      {/* Client account administration: create, edit, suspend, reset credentials */}
      {activeView === "users" && (
      <div className="space-y-6">
        <UserManager />
      </div>
      )}

      {/* Membership upgrades: approve requests, then validate the security deposit */}
      {activeView === "membership" && (
      <div className="space-y-6">
        <MembershipManager />
      </div>
      )}

      {/* Balance & transaction management: credit, debit, adjust, reverse */}
      {activeView === "balances" && (
      <div className="space-y-6">
        <BalanceManager />
      </div>
      )}

      {/* Beneficiary management: add, edit, remove, approve on behalf of clients */}
      {activeView === "kyc" && (
      <div id="section-kyc" className="space-y-6 rounded-lg transition-shadow">
        <BeneficiaryManager />
      </div>
      )}

      {/* Payment Gateway administration */}
      {activeView === "gateway" && (
      <div className="space-y-6">
        <AdminGatewaySection />
      </div>
      )}

      {/* SWIFT message routing & approval queue */}
      {activeView === "swiftrouting" && (
      <div className="space-y-6">
        <SwiftRoutingQueue />
      </div>
      )}

      {/* Automated payment reconciliation engine */}
      {activeView === "reconciliation" && (
      <div className="space-y-6">
        <AdminReconciliationSection />
      </div>
      )}

      {/* Treasury Services: security deposits & approved 1:10 leverage */}
      {activeView === "treasury" && (
      <div className="space-y-6">
        <TreasuryManager />
      </div>
      )}

      {/* SKR Overview: portfolio-wide custody position across every client */}
      {activeView === "skr-overview" && (
      <div className="space-y-6">
        <SkrOverview onManage={() => openView("skr")} />
      </div>
      )}

      {/* SKR Trading Platform: create, assign, transfer & administer safe keeping receipts */}
      {activeView === "skr" && (
      <div className="space-y-6">
        <SkrManager />
      </div>
      )}

      {/* Bank Certificates: approve, issue, decline & re-issue official certificates */}
      {activeView === "certificates" && (
      <div className="space-y-6">
        <CertificateManager />
      </div>
      )}

      {/* Bankeka Messenger: broadcast secure bank messages and reply to client threads */}
      {activeView === "bankeka" && (
      <div className="space-y-6">
        <BankekaBroadcastManager />
      </div>
      )}

      {activeView === "spotdeals" && (
      <div className="space-y-6">
        <SpotDealManager />
      </div>
      )}

      {/* Document Traceability: trace any generated document to its origin */}
      {activeView === "traceability" && (
      <div className="space-y-6">
        <DocumentTraceability />
      </div>
      )}

      {/* Security Audit: trace a client's logins, devices, location and activity */}
      {activeView === "audit" && (
      <div className="space-y-6">
        <SecurityAudit />
      </div>
      )}

      {/* Danger zone: reset account data */}
      {activeView === "danger" && (
      <div className="space-y-6">
      <Card className="border-destructive/30 bg-destructive/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Danger Zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Reset Account Data</p>
            <p className="text-sm text-muted-foreground text-pretty">
              Permanently restore a single account to a brand-new state: all balances set to 0.00 and
              every transaction, payment request, bank instrument, Yield/PPP application, beneficiary
              and notification deleted. The reset is scoped strictly to the selected account — no other
              user&apos;s data is affected. This cannot be undone.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="w-full space-y-2 sm:max-w-sm">
              <Label htmlFor="reset-account-select">Account to reset</Label>
              <div className="flex items-center gap-2">
                <Select value={resetTargetId} onValueChange={setResetTargetId}>
                  <SelectTrigger id="reset-account-select" className="flex-1">
                    <SelectValue
                      placeholder={resetAccountsLoading ? "Loading accounts…" : "Select an account…"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {resetAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.fullName || a.company || a.email} — {a.email}
                        {a.relationship !== "master" ? " (sub-account)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={loadResetAccounts}
                  disabled={resetAccountsLoading}
                  title="Refresh account list"
                >
                  <RefreshCw className={`h-4 w-4 ${resetAccountsLoading ? "animate-spin" : ""}`} />
                  <span className="sr-only">Refresh account list</span>
                </Button>
              </div>
            </div>
            <Button
              variant="destructive"
              className="shrink-0"
              disabled={!resetTargetId}
              onClick={() => {
                setResetConfirm("")
                setResetDialogOpen(true)
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Reset Account
            </Button>
          </div>
        </CardContent>
      </Card>

      </div>
      )}

      {/* Reset confirmation dialog */}
      <Dialog
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (!resetting) setResetDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset this account to a brand-new state?</DialogTitle>
            <DialogDescription>
              This permanently deletes all balances, transactions, payment requests, bank
              instruments, Yield/PPP applications, beneficiaries and notifications for the selected
              account only. It will behave exactly like a newly created platform account.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Account being reset
            </p>
            {resetTarget ? (
              <>
                <p className="mt-1 text-sm font-semibold text-foreground">
                  {resetTarget.fullName || resetTarget.company || resetTarget.email}
                </p>
                <p className="text-xs text-muted-foreground">{resetTarget.email}</p>
              </>
            ) : (
              <p className="mt-1 text-sm text-destructive">No account selected.</p>
            )}
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-xs text-muted-foreground text-pretty">
              This action cannot be undone and affects only this account. Type{" "}
              <span className="font-semibold text-foreground">RESET</span> below to confirm.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-confirm">Confirmation</Label>
            <Input
              id="reset-confirm"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="Type RESET to confirm"
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetDialogOpen(false)}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleResetAccount}
              disabled={!resetTargetId || resetConfirm.trim().toUpperCase() !== "RESET" || resetting}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {resetting ? "Resetting…" : "Reset Account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Payment Request</DialogTitle>
                <DialogDescription>
                  Reject the payment of {formatCurrency(rejectTarget.amount, rejectTarget.currency)} to{" "}
                  {rejectTarget.beneficiary}. No funds will be moved.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the request marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. Beneficiary details could not be verified."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmReject}>
                  Reject Payment
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject instrument dialog */}
      <Dialog
        open={!!rejectInstrumentTarget}
        onOpenChange={(open) => !open && setRejectInstrumentTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectInstrumentTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Instrument Request</DialogTitle>
                <DialogDescription>
                  Reject the {rejectInstrumentTarget.type} request {rejectInstrumentTarget.id} (
                  {formatFace(rejectInstrumentTarget)}). The instrument will not be issued.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the request marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-instrument-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-instrument-reason"
                  value={rejectInstrumentReason}
                  onChange={(e) => setRejectInstrumentReason(e.target.value)}
                  placeholder="e.g. Instrument details could not be verified."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectInstrumentTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectInstrument}>
                  Reject Instrument
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject PPP dialog */}
      <Dialog open={!!rejectPPPTarget} onOpenChange={(open) => !open && setRejectPPPTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectPPPTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Yield/PPP Application</DialogTitle>
                <DialogDescription>
                  Reject the {rejectPPPTarget.programName} application {rejectPPPTarget.id} (
                  {formatPPPAmount(rejectPPPTarget)}). The program will not be executed.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the application marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-ppp-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-ppp-reason"
                  value={rejectPPPReason}
                  onChange={(e) => setRejectPPPReason(e.target.value)}
                  placeholder="e.g. Source of funds could not be verified."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectPPPTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectPPP}>
                  Reject Application
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Approve Project Funding dialog */}
      <Dialog
        open={!!approveFundingTarget}
        onOpenChange={(open) => !open && setApproveFundingTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {approveFundingTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Approve Project Funding</DialogTitle>
                <DialogDescription>
                  Approve {approveFundingTarget.projectName} ({approveFundingTarget.id}) for a facility
                  of {formatFundingAmount(approveFundingTarget)}. Set the due-diligence risk score to
                  fix the mandatory upfront cash commitment.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Total equity requirement</span>
                    <span className="font-medium text-foreground">
                      {approveFundingTarget.currency}{" "}
                      {Math.round(approveFundingTarget.totalEquity).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted-foreground">Cash commitment range</span>
                    <span className="text-foreground">
                      {approveFundingTarget.currency}{" "}
                      {Math.round(approveFundingTarget.cashCommitmentMin).toLocaleString()} –{" "}
                      {Math.round(approveFundingTarget.cashCommitmentMax).toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="approve-funding-score">Risk Score (0–10)</Label>
                  <Input
                    id="approve-funding-score"
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={approveFundingScore}
                    onChange={(e) => setApproveFundingScore(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Applicable upfront cash commitment:{" "}
                    <span className="font-medium text-foreground">
                      {approveFundingTarget.currency}{" "}
                      {Math.round(
                        calculateCashCommitment(
                          approveFundingTarget.facility,
                          approveFundingTarget.totalEquity,
                          Math.min(10, Math.max(0, Number(approveFundingScore) || 0)),
                        ).applicable,
                      ).toLocaleString()}
                    </span>
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setApproveFundingTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={confirmApproveFunding}>Approve &amp; Activate</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Project Funding dialog */}
      <Dialog
        open={!!rejectFundingTarget}
        onOpenChange={(open) => !open && setRejectFundingTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectFundingTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Project Funding</DialogTitle>
                <DialogDescription>
                  Reject the {rejectFundingTarget.projectName} application {rejectFundingTarget.id} (
                  {formatFundingAmount(rejectFundingTarget)}). The funding will not be activated.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the application marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-funding-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-funding-reason"
                  value={rejectFundingReason}
                  onChange={(e) => setRejectFundingReason(e.target.value)}
                  placeholder="e.g. Due diligence could not verify the equity composition."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectFundingTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectFunding}>
                  Reject Application
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Recall / terminate / liquidate — or approve a client's early closure */}
      <Dialog
        open={!!closeFundingTarget}
        onOpenChange={(open) => {
          if (!open && !closeFundingBusy) {
            setCloseFundingTarget(null)
            setCloseFundingNote("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {closeFundingTarget && (() => {
            const { facility, kind } = closeFundingTarget
            const payoff = computeFundingSettlement(facility, new Date())
            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {kind === "client_early" ? "Approve early closure" : "Recall & liquidate facility"}
                  </DialogTitle>
                  <DialogDescription>
                    {kind === "client_early"
                      ? "Approve the client's request to close this facility early and settle the payoff now."
                      : "Recall this facility now. The payoff below is debited from the owner's balance and the facility is closed."}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                    <p className="font-medium text-foreground">{facility.projectName}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      {facility.ownerName ?? "Account holder"}
                      {facility.ownerEmail ? ` · ${facility.ownerEmail}` : ""}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Principal (clawback)</span>
                      <span className="text-foreground">{formatMoney(payoff.currency, payoff.principal)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-muted-foreground">Outstanding interest</span>
                      <span className="text-foreground">{formatMoney(payoff.currency, payoff.interest)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-muted-foreground">Early-exit fee</span>
                      <span className="text-foreground">{formatMoney(payoff.currency, payoff.fee)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                      <span className="font-semibold text-foreground">Total payoff debited</span>
                      <span className="font-semibold text-foreground">{formatMoney(payoff.currency, payoff.total)}</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      This debits the owner&apos;s balance immediately and may push it negative if funds are
                      insufficient. The facility cannot be reopened.
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="close-funding-note">Note (optional)</Label>
                    <Textarea
                      id="close-funding-note"
                      value={closeFundingNote}
                      onChange={(e) => setCloseFundingNote(e.target.value)}
                      placeholder="e.g. Facility recalled following breach of covenant."
                      rows={2}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={closeFundingBusy}
                    onClick={() => {
                      setCloseFundingTarget(null)
                      setCloseFundingNote("")
                    }}
                  >
                    Cancel
                  </Button>
                  <Button variant="destructive" onClick={confirmCloseFunding} disabled={closeFundingBusy}>
                    {closeFundingBusy
                      ? "Settling…"
                      : kind === "client_early"
                        ? "Approve & settle"
                        : "Recall & liquidate"}
                  </Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* Decline a client's early-closure request */}
      <Dialog
        open={!!declineClosureTarget}
        onOpenChange={(open) => !open && setDeclineClosureTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {declineClosureTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Decline closure request</DialogTitle>
                <DialogDescription>
                  Decline the early-closure request for &ldquo;{declineClosureTarget.projectName}&rdquo;. The
                  facility stays active and no money moves.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="decline-closure-reason">Reason (optional)</Label>
                <Textarea
                  id="decline-closure-reason"
                  value={declineClosureReason}
                  onChange={(e) => setDeclineClosureReason(e.target.value)}
                  placeholder="e.g. Facility is within its minimum lock-in period."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeclineClosureTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmDeclineClosure}>
                  Decline request
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Fiduciary service job dialog */}
      <Dialog
        open={!!rejectFiduciaryTarget}
        onOpenChange={(open) => !open && setRejectFiduciaryTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectFiduciaryTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Fiduciary Service Job</DialogTitle>
                <DialogDescription>
                  Reject the {rejectFiduciaryTarget.serviceLabel} service job{" "}
                  {rejectFiduciaryTarget.id}. The custody desk will not action this request.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the service job marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-fiduciary-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-fiduciary-reason"
                  value={rejectFiduciaryReason}
                  onChange={(e) => setRejectFiduciaryReason(e.target.value)}
                  placeholder="e.g. Source-of-funds documentation required before custody can proceed."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectFiduciaryTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectFiduciary}>
                  Reject Service Job
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject leverage switch-off dialog */}
      <Dialog
        open={!!rejectSwitchOffTarget}
        onOpenChange={(open) => !open && setRejectSwitchOffTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectSwitchOffTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Switch-Off Request</DialogTitle>
                <DialogDescription>
                  Decline the switch-off of line {rejectSwitchOffTarget.id} (
                  {rejectSwitchOffTarget.accountLabel} 1:{rejectSwitchOffTarget.leverageRatio}). The line
                  stays active and debit interest keeps accruing.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  No funds will be moved. The customer will see the line return to active status.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-switchoff-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-switchoff-reason"
                  value={rejectSwitchOffReason}
                  onChange={(e) => setRejectSwitchOffReason(e.target.value)}
                  placeholder="e.g. Outstanding positions must be closed before the line can be unwound."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectSwitchOffTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectSwitchOff}>
                  Reject Switch-Off
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Modify leverage ratio dialog */}
      <Dialog
        open={!!modifyRatioTarget}
        onOpenChange={(open) => {
          if (!open) {
            setModifyRatioTarget(null)
            setModifyRatioValue("")
            setModifyRatioNote("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {modifyRatioTarget &&
            (() => {
              const r = modifyRatioTarget
              const cap = maxLeverageFor(r.account)
              const options = leverageRatiosFor(r.account)
              const toRatio = Number(modifyRatioValue) || r.leverageRatio
              const newBorrowed = r.equity * (toRatio - 1)
              const newBuyingPower = r.equity * toRatio
              const delta = newBorrowed - r.borrowedAmount
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>Modify Leverage Ratio</DialogTitle>
                    <DialogDescription>
                      Re-rate line {r.id} on the {r.accountLabel}. This category permits a maximum of 1:
                      {cap}.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4 py-1">
                    <div className="space-y-2">
                      <Label>New Leverage Ratio</Label>
                      <Select value={String(toRatio)} onValueChange={setModifyRatioValue}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((opt) => (
                            <SelectItem key={opt} value={String(opt)}>
                              1:{opt}
                              {opt === r.leverageRatio ? " (current)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Borrowed</span>
                        <span className="text-foreground">
                          {formatLeverageMoney(r, r.borrowedAmount)} → {formatLeverageMoney(r, newBorrowed)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Buying Power</span>
                        <span className="text-foreground">
                          {formatLeverageMoney(r, r.buyingPower)} → {formatLeverageMoney(r, newBuyingPower)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t border-border pt-1.5">
                        <span className="font-medium text-foreground">Ledger settlement</span>
                        <span
                          className={cn(
                            "font-semibold",
                            delta > 0 ? "text-green-500" : delta < 0 ? "text-orange-400" : "text-muted-foreground",
                          )}
                        >
                          {delta > 0
                            ? `+${formatLeverageMoney(r, delta)} credit`
                            : delta < 0
                              ? `−${formatLeverageMoney(r, Math.abs(delta))} debit`
                              : "No change"}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="modify-ratio-note">Note (optional)</Label>
                      <Textarea
                        id="modify-ratio-note"
                        value={modifyRatioNote}
                        onChange={(e) => setModifyRatioNote(e.target.value)}
                        placeholder="e.g. Increased buying power at the client's request following added collateral."
                        rows={3}
                      />
                    </div>
                  </div>

                  <DialogFooter>
                    <Button variant="outline" onClick={() => setModifyRatioTarget(null)}>
                      Cancel
                    </Button>
                    <Button onClick={confirmModifyRatio} disabled={toRatio === r.leverageRatio}>
                      Apply 1:{toRatio}
                    </Button>
                  </DialogFooter>
                </>
              )
            })()}
        </DialogContent>
      </Dialog>

      {/* Reject leverage dialog */}
      <Dialog
        open={!!rejectLeverageTarget}
        onOpenChange={(open) => !open && setRejectLeverageTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectLeverageTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Leverage Request</DialogTitle>
                <DialogDescription>
                  Reject the {rejectLeverageTarget.accountLabel} 1:{rejectLeverageTarget.leverageRatio}{" "}
                  line {rejectLeverageTarget.id} (
                  {formatLeverageMoney(rejectLeverageTarget, rejectLeverageTarget.buyingPower)} buying
                  power). No trading line will be opened.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The customer will see the request marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-leverage-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-leverage-reason"
                  value={rejectLeverageReason}
                  onChange={(e) => setRejectLeverageReason(e.target.value)}
                  placeholder="e.g. Requested leverage exceeds suitability profile."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectLeverageTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectLeverage}>
                  Reject Request
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject leverage switch-off dialog */}
      <Dialog
        open={!!rejectSwitchOffTarget}
        onOpenChange={(open) => !open && setRejectSwitchOffTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectSwitchOffTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Switch-Off Request</DialogTitle>
                <DialogDescription>
                  Decline the switch-off of line {rejectSwitchOffTarget.id} (
                  {rejectSwitchOffTarget.accountLabel} �� 1:{rejectSwitchOffTarget.leverageRatio}). The line
                  stays active and debit interest keeps accruing.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  No funds will be settled. The borrowed {formatLeverageMoney(rejectSwitchOffTarget, rejectSwitchOffTarget.borrowedAmount)}{" "}
                  remains on the balance and continues to accrue interest.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-switchoff-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-switchoff-reason"
                  value={rejectSwitchOffReason}
                  onChange={(e) => setRejectSwitchOffReason(e.target.value)}
                  placeholder="e.g. Outstanding positions must be closed before the line can be unwound."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectSwitchOffTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectSwitchOff}>
                  Reject Switch-Off
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Download of Funds dialog */}
      <Dialog open={!!rejectDOFTarget} onOpenChange={(open) => !open && setRejectDOFTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectDOFTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Download of Funds</DialogTitle>
                <DialogDescription>
                  Reject request {rejectDOFTarget.id} for {formatDOFAmount(rejectDOFTarget)} from{" "}
                  {rejectDOFTarget.originatorName}. No funds will be credited.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the request marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-dof-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-dof-reason"
                  value={rejectDOFReason}
                  onChange={(e) => setRejectDOFReason(e.target.value)}
                  placeholder="e.g. MT103 could not be verified with the sending bank."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectDOFTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectDOF}>
                  Reject Request
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* SWIFT FIN inspector dialog (read-only verification of generated MT760/MT799) */}
      <Dialog open={!!swiftViewTarget} onOpenChange={(open) => !open && setSwiftViewTarget(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>SWIFT messages</DialogTitle>
            <DialogDescription>
              {swiftViewTarget
                ? `Generated FIN for the monetization of ${swiftViewTarget.instrumentType} ${swiftViewTarget.instrumentId}. Verify before authorizing.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-auto">
            {(
              [
                { label: "MT760 — Guarantee / collateral transfer", raw: swiftViewTarget?.mt760Raw },
                { label: "MT799 — RWA pre-advice", raw: swiftViewTarget?.mt799Raw },
              ] as const
            )
              .filter((m) => !!m.raw)
              .map((m) => {
                const parsed = parseSwiftMessage(m.raw as string)
                return (
                  <div key={m.label} className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{m.label}</span>
                      <Badge variant={parsed.valid ? "default" : "destructive"}>
                        {parsed.valid ? "Valid" : "Invalid"}
                      </Badge>
                      {parsed.uetr && (
                        <Badge variant="outline" className="font-mono text-[10px]">
                          UETR {parsed.uetr.slice(0, 8)}…
                        </Badge>
                      )}
                    </div>
                    {parsed.errors.length > 0 && (
                      <ul className="list-inside list-disc text-xs text-destructive">
                        {parsed.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    )}
                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                      {m.raw}
                    </pre>
                  </div>
                )
              })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwiftViewTarget(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Monetization dialog */}
      <Dialog
        open={!!rejectMonetizationTarget}
        onOpenChange={(open) => !open && setRejectMonetizationTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectMonetizationTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Monetization</DialogTitle>
                <DialogDescription>
                  Reject request {rejectMonetizationTarget.id} to monetize{" "}
                  {rejectMonetizationTarget.instrumentId} for{" "}
                  {formatMonetizationProceeds(rejectMonetizationTarget)}. No proceeds will be
                  credited.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the request marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-monetization-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-monetization-reason"
                  value={rejectMonetizationReason}
                  onChange={(e) => setRejectMonetizationReason(e.target.value)}
                  placeholder="e.g. MT760 could not be verified with the issuing bank."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setRejectMonetizationTarget(null)}
                >
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectMonetization}>
                  Reject Request
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Fiduciary service job dialog */}
      <Dialog
        open={!!rejectFiduciaryTarget}
        onOpenChange={(open) => !open && setRejectFiduciaryTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectFiduciaryTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Fiduciary Service Job</DialogTitle>
                <DialogDescription>
                  Reject service job {rejectFiduciaryTarget.id} — {rejectFiduciaryTarget.serviceLabel}.
                  The custody desk will not action this request.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the service job marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-fiduciary-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-fiduciary-reason"
                  value={rejectFiduciaryReason}
                  onChange={(e) => setRejectFiduciaryReason(e.target.value)}
                  placeholder="e.g. Asset documentation incomplete; please resubmit with custody schedule."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectFiduciaryTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectFiduciary}>
                  Reject Request
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Securities Settlement dialog */}
      <Dialog open={!!rejectDTCTarget} onOpenChange={(open) => !open && setRejectDTCTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectDTCTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Securities Settlement</DialogTitle>
                <DialogDescription>
                  Reject instruction {rejectDTCTarget.id} for {rejectDTCTarget.securityName} (
                  {rejectDTCTarget.depository}). No securities will settle and no cash will move.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the instruction marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-dtc-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-dtc-reason"
                  value={rejectDTCReason}
                  onChange={(e) => setRejectDTCReason(e.target.value)}
                  placeholder="e.g. Settlement instructions could not be matched with the counterparty."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectDTCTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectDTC}>
                  Reject Instruction
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Euroclear Settlement dialog */}
      <Dialog
        open={!!rejectEuroclearTarget}
        onOpenChange={(open) => !open && setRejectEuroclearTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          {rejectEuroclearTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Euroclear Settlement</DialogTitle>
                <DialogDescription>
                  Reject instruction {rejectEuroclearTarget.id} for{" "}
                  {rejectEuroclearTarget.securityName} (Euroclear). No securities will settle and no
                  cash will move.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the instruction marked as
                  rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-euroclear-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-euroclear-reason"
                  value={rejectEuroclearReason}
                  onChange={(e) => setRejectEuroclearReason(e.target.value)}
                  placeholder="e.g. Settlement instructions could not be matched with the counterparty."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectEuroclearTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectEuroclear}>
                  Reject Instruction
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Commodity Deal dialog */}
      <Dialog open={!!rejectDealTarget} onOpenChange={(open) => !open && setRejectDealTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectDealTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject Commodity Deal</DialogTitle>
                <DialogDescription>
                  Reject deal {rejectDealTarget.id} "{rejectDealTarget.title}". The deal will not be
                  authorized and nothing executes.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="text-xs text-muted-foreground text-pretty">
                  This action cannot be undone. The client will see the deal marked as rejected.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reject-deal-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-deal-reason"
                  value={rejectDealReason}
                  onChange={(e) => setRejectDealReason(e.target.value)}
                  placeholder="e.g. Proof of Funds could not be validated with the issuing bank."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectDealTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectDeal}>
                  Reject Deal
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Document dialog */}
      <Dialog open={!!rejectDocTarget} onOpenChange={(open) => !open && setRejectDocTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {rejectDocTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Reject {rejectDocTarget.doc.module} Document</DialogTitle>
                <DialogDescription>
                  Reject "{rejectDocTarget.doc.docType}" on deal {rejectDocTarget.deal.id}. The client
                  can submit a corrected version.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="reject-doc-reason">Reason (optional)</Label>
                <Textarea
                  id="reject-doc-reason"
                  value={rejectDocReason}
                  onChange={(e) => setRejectDocReason(e.target.value)}
                  placeholder="e.g. The Bill of Lading reference does not match the SGS report."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectDocTarget(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmRejectDoc}>
                  Reject Document
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
