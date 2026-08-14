"use client"

import { useState, useMemo, useEffect } from "react"
import { useActivityLog } from "@/components/activity-tracker"
import { convertCurrency } from "@/lib/fx"
import {
  assessPaymentAgainstLimits,
  limitBlockMessage,
  type LimitFigures,
} from "@/lib/account-limits-eval"
import {
  Send,
  Download,
  ArrowUpRight,
  ArrowDownLeft,
  Filter,
  Search,
  Plus,
  MoreHorizontal,
  Calendar,
  Building2,
  Globe,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ShieldCheck,
  Undo2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useBeneficiaries } from "@/lib/beneficiaries-store"
import { useLedger } from "@/lib/ledger-store"
import { usePaymentRequests, type PaymentRequest } from "@/lib/payment-requests-store"
import {
  getPaymentStage,
  paymentStageToGpiStatus,
  PAYMENT_STAGE_LABEL,
  PAYMENT_STAGE_SHORT,
  PAYMENT_STAGE_BADGE_CLASS,
  type PaymentStage,
} from "@/lib/payment-status"
import { requestPaymentRecall } from "@/app/actions/approvals"
import { exportToCsv } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { validateIban, validateBic } from "@/lib/iban-swift"
import { generateReceiptPdf } from "@/lib/receipt-pdf"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { deriveUetr } from "@/lib/swift-gpi"
import { toast } from "sonner"

type Payment = {
  id: string
  uetr: string
  type: string
  amount: string
  currency: string
  beneficiary: string
  beneficiaryCountry: string
  iban: string
  reference: string
  /** For outgoing rows this holds the three-stage key; incoming rows use "received". */
  status: string
  /** Canonical three-stage lifecycle for outgoing payments (undefined for incoming credits). */
  stage?: PaymentStage
  date: string
  time: string
  fee: string
  swiftCode: string
  // Principal partner bank the payment was routed through (outgoing, once approved).
  routedBankName?: string
  routedBankBic?: string
  // ISO timestamp the gpi journey is anchored to (submission / value date).
  baseDate: string
}

// The MCC Capital master account currency. Available funds are read live from
// the ledger store (credited by recorded incoming payments). Payments exceeding
// the available balance are rejected for insufficient funds.
const MASTER_ACCOUNT_CURRENCY = "EUR"

// Platform fee charged on every outgoing payment, on top of the sent amount.
const PLATFORM_FEE_RATE = 0.02

const formatCurrency = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

// Icon per three-stage lifecycle key. Colours come from the shared
// PAYMENT_STAGE_BADGE_CLASS so every surface stays consistent.
const STAGE_ICON: Record<PaymentStage, typeof Clock> = {
  review: Clock,
  initiated: AlertCircle,
  delivered: CheckCircle2,
  rejected: XCircle,
  cancelled: XCircle,
}

/**
 * Resolve the badge icon, colour, and human label for a payment row. Outgoing
 * rows follow the canonical three-stage lifecycle; incoming credits are shown
 * as a simple "Received" success badge.
 */
function getStatusView(payment: Payment): { icon: typeof Clock; color: string; label: string } {
  if (payment.type === "incoming") {
    return {
      icon: ArrowDownLeft,
      color: "bg-green-500/10 text-green-500 border-green-500/20",
      label: "Received",
    }
  }
  const stage = payment.stage ?? "review"
  return {
    icon: STAGE_ICON[stage],
    color: PAYMENT_STAGE_BADGE_CLASS[stage],
    label: PAYMENT_STAGE_SHORT[stage],
  }
}



export default function PaymentsPage() {
  const [isNewPaymentOpen, setIsNewPaymentOpen] = useState(false)
  const [filterStatus, setFilterStatus] = useState("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [payAmount, setPayAmount] = useState("")
  const [payCurrency, setPayCurrency] = useState("EUR")
  const [payBeneficiary, setPayBeneficiary] = useState("")
  const [payCountry, setPayCountry] = useState("")
  const [paySwift, setPaySwift] = useState("")
  const [payIban, setPayIban] = useState("")
  const [payReference, setPayReference] = useState("")
  const [payNotes, setPayNotes] = useState("")
  const [selectedPayeeId, setSelectedPayeeId] = useState("manual")
  const [formError, setFormError] = useState<string | null>(null)
  const { beneficiaries } = useBeneficiaries()
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress, holderRepresentative } = useHolderIdentity()
  const { balanceFor, entries } = useLedger()
  const { requests, addRequest } = usePaymentRequests()

  // The signed-in user's EFFECTIVE account limits (per-user override or the
  // platform default). Read via the non-proxied /api/account-limits route so a
  // stale session cookie can't 401 it (the same route the account card uses).
  // Used only for a friendly client-side pre-check — the authoritative hard
  // block lives server-side in submitApproval.
  const [accountLimits, setAccountLimits] = useState<LimitFigures | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch("/api/account-limits", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.ok && data.limits) setAccountLimits(data.limits as LimitFigures)
      })
      .catch(() => {
        /* pre-check simply won't run; the server gate still enforces */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Live available balance from recorded incoming payments.
  const masterBalance = balanceFor(MASTER_ACCOUNT_CURRENCY)

  // Payment History is derived from persistent sources so rows never disappear
  // on navigation: outgoing rows come from the persisted payment-request store,
  // incoming rows come from the ledger's credit entries.
  const payments = useMemo<Payment[]>(() => {
    const outgoing = requests.map((r) => ({
      ts: new Date(r.submittedAt).getTime(),
      payment: {
        id: r.id,
        // Older records may predate stored UETRs — derive a stable one.
        uetr: r.uetr || deriveUetr(r.id),
        type: "outgoing",
        amount: formatCurrency(r.amount, r.currency),
        currency: r.currency,
        beneficiary: r.beneficiary,
        beneficiaryCountry: r.beneficiaryCountry,
        iban: r.iban,
        reference: r.reference,
        // Canonical three-stage lifecycle: review → initiated → delivered
        // (plus rejected). The stage key doubles as the filterable status.
        stage: getPaymentStage(r),
        status: getPaymentStage(r),
        date: r.submittedAt.split("T")[0],
        time: new Date(r.submittedAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        fee: formatCurrency(r.fee, r.currency),
        swiftCode: r.swiftCode,
        routedBankName: r.routedBankName,
        routedBankBic: r.routedBankBic,
        baseDate: r.submittedAt,
      } as Payment,
    }))
    const incoming = entries
      .filter((e) => e.direction === "credit")
      .map((e) => ({
        ts: new Date(e.date).getTime(),
        payment: {
          id: e.id,
          uetr: deriveUetr(e.id),
          type: "incoming",
          amount: formatCurrency(e.amount, e.currency),
          currency: e.currency,
          beneficiary: e.counterparty,
          beneficiaryCountry: "—",
          iban: e.account || "—",
          reference: e.reference || "—",
          status: "received",
          date: e.date.split("T")[0],
          time: "",
          fee: "—",
          swiftCode: e.bank || "—",
          baseDate: e.date,
        } as Payment,
      }))
    return [...outgoing, ...incoming].sort((a, b) => b.ts - a.ts).map((x) => x.payment)
  }, [requests, entries])

  // Payment row actions: details dialog + report-issue dialog.
  const [viewPaymentTarget, setViewPaymentTarget] = useState<Payment | null>(null)
  const [reportTarget, setReportTarget] = useState<Payment | null>(null)
  const [reportMessage, setReportMessage] = useState("")
  // Recall: the payment a recall is being confirmed for, an in-flight flag, and
  // a local set of ids already requested this session (so the UI reflects the
  // pending state immediately, before the 30s server poll catches up).
  const [recallTarget, setRecallTarget] = useState<Payment | null>(null)
  const [recallBusy, setRecallBusy] = useState(false)
  const [recalledLocal, setRecalledLocal] = useState<Set<string>>(new Set())

  // Map a payment-history row (keyed by local id) back to its source request so
  // we can read the DB approval id and any recall lifecycle state.
  const requestByLocalId = useMemo(() => {
    const map = new Map<string, PaymentRequest>()
    for (const r of requests) map.set(r.id, r)
    return map
  }, [requests])

  // An outgoing, approved (completed) payment that has not already been recalled
  // or had a recall filed can be recalled by the client.
  const canRecall = (payment: Payment): boolean => {
    // A payment can be recalled once it has been approved/initiated (funds have
    // left the account) — whether or not it has yet been confirmed delivered.
    if (payment.type !== "outgoing" || (payment.stage !== "initiated" && payment.stage !== "delivered"))
      return false
    if (recalledLocal.has(payment.id)) return false
    const req = requestByLocalId.get(payment.id)
    return !!req?.approvalId && !req.recallStatus
  }

  const recallStateLabel = (payment: Payment): string | null => {
    if (recalledLocal.has(payment.id)) return "Recall requested"
    const req = requestByLocalId.get(payment.id)
    if (req?.recallStatus === "pending") return "Recall requested"
    if (req?.recallStatus === "recalled") return "Recalled"
    return null
  }

  const confirmRecall = async () => {
    if (!recallTarget) return
    const payment = recallTarget
    const req = requestByLocalId.get(payment.id)
    if (!req?.approvalId) {
      toast.error("This payment can't be recalled yet", {
        description: "Please wait a moment for it to finish syncing, then try again.",
      })
      setRecallTarget(null)
      return
    }
    setRecallBusy(true)
    const res = await requestPaymentRecall(req.approvalId)
    setRecallBusy(false)
    if (res.ok) {
      setRecalledLocal((prev) => new Set(prev).add(payment.id))
      setRecallTarget(null)
      logActivity({
        action: `Requested recall of payment ${payment.id} to ${payment.beneficiary}`,
        category: "Payments",
        details: {
          summary: `Client filed a recall for payment ${payment.id} (${payment.amount} to ${payment.beneficiary}). Pending Administrator approval; on approval the funds are refunded and any recipient credit is reversed.`,
          referenceId: payment.id,
          counterparty: payment.beneficiary,
          amount: payment.amount,
          status: "Recall requested",
        },
      })
      toast.success("Recall submitted for approval", {
        description: `Your recall of ${payment.amount} to ${payment.beneficiary} is pending Administrator approval. Funds are returned once it is approved.`,
      })
    } else {
      toast.error("Recall could not be submitted", { description: res.error })
    }
  }

  const viewPayment = (payment: Payment) => {
    setViewPaymentTarget(payment)
    logActivity({
      action: `Viewed details for payment ${payment.id}`,
      category: "Payments",
      details: {
        summary: `Client opened the details for payment ${payment.id} (${payment.type === "incoming" ? "incoming from" : "outgoing to"} ${payment.beneficiary}) for ${payment.amount}.`,
        referenceId: payment.id,
        counterparty: payment.beneficiary,
        amount: payment.amount,
        reference: payment.reference,
        status: payment.status,
      },
    })
  }

  const downloadReceipt = (payment: Payment) => {
    show(generateReceiptPdf({
      reference: payment.reference || payment.id,
      direction: payment.type === "incoming" ? "credit" : "debit",
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      date: payment.time ? `${payment.date} ${payment.time}` : payment.date,
      counterparty: payment.beneficiary,
      bic: payment.swiftCode,
      iban: payment.iban,
      fee: payment.fee,
      uetr: payment.uetr,
    }))
    logActivity({
      action: `Downloaded receipt for payment ${payment.id}`,
      category: "Payments",
      details: {
        summary: `Client downloaded the PDF receipt for payment ${payment.id} (${payment.type === "incoming" ? "incoming from" : "outgoing to"} ${payment.beneficiary}) for ${payment.amount}.`,
        referenceId: payment.id,
        counterparty: payment.beneficiary,
        amount: payment.amount,
        format: "PDF",
      },
    })
  }

  const copyReference = (payment: Payment) => {
    const ref = payment.reference || payment.id
    navigator.clipboard?.writeText(ref)
    toast.success("Reference copied", {
      description: `Payment reference "${ref}" copied to your clipboard.`,
    })
  }

  const copyUetr = (payment: Payment) => {
    navigator.clipboard?.writeText(payment.uetr)
    toast.success("UETR copied", {
      description: `SWIFT gpi UETR for ${payment.id} copied to your clipboard.`,
    })
  }

  // Opens the details dialog (which contains the SWIFT gpi tracker) and logs a
  // tracking-specific activity entry.
  const trackPayment = (payment: Payment) => {
    setViewPaymentTarget(payment)
    logActivity({
      action: `Tracked payment ${payment.id} via SWIFT gpi`,
      category: "Payments",
      details: {
        summary: `Client opened the SWIFT gpi Tracker for payment ${payment.id} (${payment.type === "incoming" ? "incoming from" : "outgoing to"} ${payment.beneficiary}, ${payment.amount}).`,
        referenceId: payment.id,
        uetr: payment.uetr,
        counterparty: payment.beneficiary,
        amount: payment.amount,
        status: payment.status,
      },
    })
  }

  const submitReport = () => {
    if (!reportTarget) return
    const payment = reportTarget
    logActivity({
      action: `Reported an issue with payment ${payment.id}`,
      category: "Payments",
      details: {
        summary: `Client reported an issue with payment ${payment.id} (${payment.type === "incoming" ? "incoming from" : "outgoing to"} ${payment.beneficiary}, ${payment.amount}).${reportMessage.trim() ? ` Message: ${reportMessage.trim()}` : ""}`,
        referenceId: payment.id,
        counterparty: payment.beneficiary,
        amount: payment.amount,
        message: reportMessage.trim() || "—",
        status: "Submitted to support",
      },
    })
    toast.success("Issue reported", {
      description: `Our team has received your report for ${payment.id} and will follow up by email.`,
    })
    setReportTarget(null)
    setReportMessage("")
  }

  const resetForm = () => {
    setPayAmount("")
    setPayCurrency("EUR")
    setPayBeneficiary("")
    setPayCountry("")
    setPaySwift("")
    setPayIban("")
    setPayReference("")
    setPayNotes("")
    setSelectedPayeeId("manual")
    setFormError(null)
  }

  const handleSelectPayee = (value: string) => {
    setSelectedPayeeId(value)
    if (value === "manual") {
      setPayBeneficiary("")
      setPayCountry("")
      setPaySwift("")
      setPayIban("")
      setPayCurrency("EUR")
      return
    }
    const payee = beneficiaries.find((b) => b.id === value)
    if (payee) {
      setPayBeneficiary(payee.name)
      setPayCountry(payee.beneficiaryCountry || "")
      setPaySwift(payee.swiftBic || "")
      setPayIban(payee.iban || payee.accountNumber || "")
      setPayCurrency(payee.currency || "EUR")
    }
  }

  const handleSendPayment = () => {
    const amountValue = Number.parseFloat(payAmount)
    if (!payBeneficiary.trim()) {
      setFormError("Please enter a beneficiary name.")
      return
    }
    if (!payAmount || Number.isNaN(amountValue) || amountValue <= 0) {
      setFormError("Please enter a valid amount greater than 0.")
      return
    }
    if (!payIban.trim()) {
      setFormError("Please enter the beneficiary IBAN or account number.")
      return
    }
    // If the entry looks like an IBAN, enforce a valid checksum.
    const ibanLike = /^[A-Za-z]{2}[0-9]{2}/.test(payIban.trim().replace(/[\s-]/g, ""))
    if (ibanLike && !validateIban(payIban).valid) {
      setFormError(`IBAN is invalid: ${validateIban(payIban).error}`)
      return
    }
    if (paySwift.trim() && !validateBic(paySwift).valid) {
      setFormError(`SWIFT/BIC is invalid: ${validateBic(paySwift).error}`)
      return
    }
    // A 2% platform fee is charged on top of the outgoing amount.
    const feeValue = Math.round(amountValue * PLATFORM_FEE_RATE * 100) / 100
    const totalDebit = amountValue + feeValue

    // Soft pre-check: warn the customer if the account currently cannot cover
    // amount + fee. Funds are NOT moved here — they are only debited once an
    // Administrator approves the request.
    if (totalDebit > masterBalance) {
      setFormError(
        `Insufficient funds for this request. It requires ${formatCurrency(
          totalDebit,
          MASTER_ACCOUNT_CURRENCY,
        )} (${formatCurrency(amountValue, MASTER_ACCOUNT_CURRENCY)} + ${formatCurrency(
          feeValue,
          MASTER_ACCOUNT_CURRENCY,
        )} platform fee). Available balance: ${formatCurrency(
          masterBalance,
          MASTER_ACCOUNT_CURRENCY,
        )}.`,
      )
      return
    }

    // Account-limit pre-check (friendly): block a payment that would push the
    // user over their administrator-set Daily Limit or Monthly Volume before it
    // is even submitted. The value counted is the PRINCIPAL (not the fee),
    // converted into the limit currency, and prior non-rejected payments in the
    // current UTC day / month are summed. This mirrors the authoritative server
    // gate in submitApproval, which is the real backstop if this is bypassed.
    if (accountLimits) {
      const now = new Date()
      const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      let priorDaily = 0
      let priorMonthly = 0
      for (const r of requests) {
        if (r.status === "rejected") continue
        const t = Date.parse(r.submittedAt)
        if (Number.isNaN(t)) continue
        const value = convertCurrency(r.amount, r.currency || "EUR", accountLimits.currency)
        if (t >= monthStart) priorMonthly += value
        if (t >= dayStart) priorDaily += value
      }
      const attempted = convertCurrency(amountValue, payCurrency, accountLimits.currency)
      const assessment = assessPaymentAgainstLimits({
        limits: accountLimits,
        priorDailyTotal: priorDaily,
        priorMonthlyTotal: priorMonthly,
        amount: attempted,
      })
      if (!assessment.ok) {
        setFormError(limitBlockMessage(assessment))
        return
      }
    }

    const beneficiary = payBeneficiary.trim()
    const country = payCountry.trim() || "—"
    const iban = payIban.trim().toUpperCase() || "—"
    const swift = paySwift.trim().toUpperCase() || "—"
    const reference = payReference.trim() || "—"
    const formattedAmount = formatCurrency(amountValue, payCurrency)
    const formattedFee = formatCurrency(feeValue, payCurrency)
    const formattedTotal = formatCurrency(totalDebit, payCurrency)

    const payeeSource =
      selectedPayeeId === "manual"
        ? "Manually entered"
        : `Saved payee (${beneficiaries.find((b) => b.id === selectedPayeeId)?.name ?? selectedPayeeId})`

    const requestId = `PAY-${new Date().getTime().toString().slice(-8)}`

    // Create a PENDING request. No ledger debit happens until an Administrator
    // approves it — the customer cannot move funds directly.
    addRequest({
      id: requestId,
      beneficiary,
      beneficiaryCountry: country,
      iban,
      swiftCode: swift,
      reference,
      notes: payNotes.trim(),
      currency: payCurrency,
      amount: amountValue,
      fee: feeValue,
      total: totalDebit,
      payeeSource,
    })

    logActivity({
      action: `Submitted outgoing payment of ${formattedAmount} to ${beneficiary} for Administrator approval`,
      category: "Payments",
      details: {
        summary: `Submitted a payment request of ${formattedAmount} to ${beneficiary} (${country}) via SWIFT ${swift}, IBAN ${iban}, plus a ${formattedFee} platform fee (2%) for a total of ${formattedTotal}. The request is pending mandatory Administrator approval — no funds have left the account yet. Reference: ${reference}.`,
        paymentId: requestId,
        direction: "Outgoing / Debit (pending approval)",
        beneficiaryName: beneficiary,
        beneficiaryCountry: country,
        iban,
        swiftBic: swift,
        amount: formattedAmount,
        currency: payCurrency,
        platformFee: `${formattedFee} (2%)`,
        totalToDebitOnApproval: formattedTotal,
        paymentReference: reference,
        notes: payNotes.trim() || "(none)",
        payeeSource,
        status: "Pending Administrator Approval",
      },
    })

    toast.success("Payment submitted for approval", {
      description: `Your payment of ${formattedAmount} to ${beneficiary} is pending Administrator approval. Funds will only be debited once it is approved.`,
    })
    resetForm()
    setIsNewPaymentOpen(false)
  }

  const filteredPayments = payments.filter((payment) => {
    const matchesStatus =
      filterStatus === "all" || payment.status === filterStatus
    const matchesSearch =
      payment.beneficiary.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.reference.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payment.id.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesStatus && matchesSearch
  })

  const handleExportCsv = () => {
    const count = exportToCsv("payments", filteredPayments, [
      { key: "id", label: "Payment ID" },
      { key: "type", label: "Direction" },
      { key: "amount", label: "Amount" },
      { key: "currency", label: "Currency" },
      { key: "beneficiary", label: "Beneficiary" },
      { key: "beneficiaryCountry", label: "Country" },
      { key: "iban", label: "IBAN" },
      { key: "swiftCode", label: "SWIFT/BIC" },
      { key: "reference", label: "Reference" },
      { key: "fee", label: "Fee" },
      { key: "status", label: "Status" },
      { key: "date", label: "Date" },
      { key: "time", label: "Time" },
    ])
    logActivity({
      action: `Exported ${count} payment${count === 1 ? "" : "s"} to CSV`,
      category: "Payments",
      details: {
        summary: `Client exported ${count} payment record${count === 1 ? "" : "s"} (current filters applied) to a CSV file.`,
        recordCount: `${count}`,
        format: "CSV",
      },
    })
  }

  const handleExportPdf = () => {
    if (filteredPayments.length === 0) {
      toast.info("No payments to export", {
        description: "There are no payments matching the current filters.",
      })
      return
    }
    const doc = generateTablePdf({
      title: "Payment History",
      refPrefix: "PAY",
      holderName,
      holderCompany,
      holderAddress,
      holderRepresentative,
      meta: [{ label: "Records", value: `${filteredPayments.length}` }],
      columns: [
        { key: "date", header: "Date" },
        { key: "id", header: "Reference" },
        { key: "beneficiary", header: "Beneficiary" },
        { key: "swiftCode", header: "SWIFT/BIC" },
        { key: "type", header: "Dir." },
        { key: "amount", header: "Amount", align: "right" },
        { key: "status", header: "Status" },
      ],
      rows: filteredPayments as unknown as Record<string, unknown>[],
      footNote: "Payment history exported from the MCC Capital platform with the filters active at the time of export.",
    })
    show({ doc, filename: tablePdfFilename("Payment-History"), title: "Payment History" })
    logActivity({
      action: `Exported ${filteredPayments.length} payment${filteredPayments.length === 1 ? "" : "s"} to PDF`,
      category: "Payments",
      details: {
        summary: `Client previewed/exported ${filteredPayments.length} payment record(s) as a professional PDF.`,
        recordCount: `${filteredPayments.length}`,
        format: "PDF",
      },
    })
  }

  const parseAmount = (value: string) => {
    const numeric = Number.parseFloat(value.replace(/[^0-9.]/g, ""))
    return Number.isNaN(numeric) ? 0 : numeric
  }
  const outgoingTotal = payments
    .filter((p) => p.type === "outgoing")
    .reduce((sum, p) => sum + parseAmount(p.amount), 0)
  const incomingTotal = payments
    .filter((p) => p.type === "incoming")
    .reduce((sum, p) => sum + parseAmount(p.amount), 0)
  const pendingCount = payments.filter((p) => p.stage === "review").length

  const stats = [
    {
      title: "Total Outgoing",
      value: `€${outgoingTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      change: `${payments.filter((p) => p.type === "outgoing").length} payments`,
      icon: ArrowUpRight,
      color: "text-red-400",
    },
    {
      title: "Total Incoming",
      value: `€${incomingTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      change: `${payments.filter((p) => p.type === "incoming").length} payments`,
      icon: ArrowDownLeft,
      color: "text-green-400",
    },
    {
      title: "Pending Payments",
      value: `${pendingCount}`,
      change: "Awaiting settlement",
      icon: Clock,
      color: "text-yellow-400",
    },
    {
      title: "This Month",
      value: `${payments.length}`,
      change: "Transactions",
      icon: Calendar,
      color: "text-blue-400",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payments</h1>
          <p className="text-sm text-muted-foreground">
            Manage incoming and outgoing payments
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
                <Download className="mr-2 h-4 w-4" />
                Export as PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportCsv}>
                <Download className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog
            open={isNewPaymentOpen}
            onOpenChange={(open) => {
              setIsNewPaymentOpen(open)
              if (!open) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                New Payment Request
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Request New Payment</DialogTitle>
                <DialogDescription>
                  Submit an outgoing SWIFT transfer for Administrator approval · Available balance:{" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(masterBalance, MASTER_ACCOUNT_CURRENCY)}
                  </span>
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="payee">Saved Payee</Label>
                  <Select value={selectedPayeeId} onValueChange={handleSelectPayee}>
                    <SelectTrigger id="payee">
                      <SelectValue placeholder="Select a saved payee" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Enter manually</SelectItem>
                      {beneficiaries.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                          {b.iban ? ` · ${b.iban.slice(0, 8)}…` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {beneficiaries.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No saved payees yet. Add them in the Beneficiaries section or enter details manually below.
                    </p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="beneficiary">Beneficiary Name *</Label>
                  <Input
                    id="beneficiary"
                    placeholder="e.g. Apple Distribution Intl."
                    value={payBeneficiary}
                    onChange={(e) => setPayBeneficiary(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="amount">Amount *</Label>
                    <Input id="amount" placeholder="0.00" type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Select value={payCurrency} onValueChange={setPayCurrency}>
                      <SelectTrigger>
                        <SelectValue placeholder="EUR" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="CHF">CHF</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <VerifiedBankField
                    id="swift"
                    label="SWIFT / BIC"
                    kind="bic"
                    maxLength={11}
                    placeholder="XXXXXXXX"
                    value={paySwift}
                    onChange={setPaySwift}
                    onResolved={(info) => {
                      if (info?.country && !payCountry.trim()) setPayCountry(info.country)
                    }}
                  />
                  <div className="grid gap-2">
                    <Label htmlFor="country">Beneficiary Country</Label>
                    <Input id="country" placeholder="e.g. Ireland" value={payCountry} onChange={(e) => setPayCountry(e.target.value)} />
                  </div>
                </div>
                <VerifiedBankField
                  id="iban"
                  label="IBAN / Account Number"
                  kind="iban"
                  required
                  lenient
                  placeholder="XX00 0000 0000 0000 0000 00"
                  value={payIban}
                  onChange={setPayIban}
                  onResolved={(info) => {
                    // Auto-fill the SWIFT/BIC and country from the resolved IBAN.
                    if (info?.bic && !paySwift.trim()) setPaySwift(info.bic)
                    if (info?.country && !payCountry.trim()) setPayCountry(info.country)
                  }}
                />
                <div className="grid gap-2">
                  <Label htmlFor="reference">Payment Reference</Label>
                  <Input id="reference" placeholder="INV-2024-XXX" value={payReference} onChange={(e) => setPayReference(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="notes">Notes (Optional)</Label>
                  <Textarea
                    id="notes"
                    placeholder="Additional payment instructions..."
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                  />
                </div>
                {(() => {
                  const amt = Number.parseFloat(payAmount)
                  if (!payAmount || Number.isNaN(amt) || amt <= 0) return null
                  const fee = Math.round(amt * PLATFORM_FEE_RATE * 100) / 100
                  const total = amt + fee
                  return (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="text-foreground">{formatCurrency(amt, payCurrency)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-muted-foreground">Platform fee (2%)</span>
                        <span className="text-foreground">{formatCurrency(fee, payCurrency)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-2 border-t border-border pt-2 font-medium">
                        <span className="text-foreground">Total to debit on approval</span>
                        <span className="text-foreground">{formatCurrency(total, payCurrency)}</span>
                      </div>
                    </div>
                  )
                })()}
                <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs text-muted-foreground text-pretty">
                    All outgoing payments require mandatory Administrator approval. Submitting this
                    form creates a pending request — no funds leave your account until an
                    Administrator approves it.
                  </p>
                </div>
                {formError && (
                  <p className="text-sm text-destructive" role="alert">
                    {formError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsNewPaymentOpen(false)
                    resetForm()
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={handleSendPayment}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Submit for Approval
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

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
                    {stat.change}
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

      {/* Payments Table */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <CardTitle className="text-lg font-semibold">
              Payment History
            </CardTitle>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search payments..."
                  className="pl-9 w-full sm:w-[250px]"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <Filter className="mr-2 h-4 w-4" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="review">In Review</SelectItem>
              <SelectItem value="initiated">Approved &amp; Initiated</SelectItem>
              <SelectItem value="delivered">Completed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="received">Received (Incoming)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="incoming">Incoming</TabsTrigger>
              <TabsTrigger value="outgoing">Outgoing</TabsTrigger>
            </TabsList>
            <TabsContent value="all" className="mt-0">
              {filteredPayments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
                    <Send className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No payments yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Create a new payment to send funds via SWIFT transfer
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                {filteredPayments.map((payment) => {
                  const status =
                    getStatusView(payment)
                  const StatusIcon = status.icon

                  return (
                    <div
                      key={payment.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border border-border bg-secondary/30"
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                            payment.type === "incoming"
                              ? "bg-green-500/10"
                              : "bg-red-500/10"
                          )}
                        >
                          {payment.type === "incoming" ? (
                            <ArrowDownLeft className="h-5 w-5 text-green-500" />
                          ) : (
                            <ArrowUpRight className="h-5 w-5 text-red-500" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-foreground">
                              {payment.beneficiary}
                            </p>
                            <Badge variant="outline" className="text-[10px]">
                              {payment.beneficiaryCountry}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <code className="text-xs text-muted-foreground">
                              {payment.id}
                            </code>
                            <span className="text-muted-foreground">•</span>
                            <span className="text-xs text-muted-foreground">
                              {payment.reference}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {payment.date} at {payment.time}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-4">
                        <div className="text-right">
                          <p
                            className={cn(
                              "text-lg font-bold",
                              payment.type === "incoming"
                                ? "text-green-500"
                                : "text-foreground"
                            )}
                          >
                            {payment.type === "incoming" ? "+" : "-"}
                            {payment.amount}
                          </p>
                          <div className="flex items-center justify-end gap-2 mt-1">
                            <Badge
                              variant="outline"
                              className={cn("text-[10px]", status.color)}
                            >
                              <StatusIcon className="mr-1 h-3 w-3" />
                              {status.label}
                            </Badge>
                            {recallStateLabel(payment) && (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20"
                              >
                                <Undo2 className="mr-1 h-3 w-3" />
                                {recallStateLabel(payment)}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => viewPayment(payment)}>
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => trackPayment(payment)}>
                              Track Payment (SWIFT gpi)
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => downloadReceipt(payment)}>
                              Download Receipt
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => copyReference(payment)}>
                              Copy Reference
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => copyUetr(payment)}>
                              Copy UETR
                            </DropdownMenuItem>
                            {canRecall(payment) && (
                              <DropdownMenuItem onSelect={() => setRecallTarget(payment)}>
                                <Undo2 className="mr-2 h-4 w-4" />
                                Recall Payment
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => {
                                setReportMessage("")
                                setReportTarget(payment)
                              }}
                            >
                              Report Issue
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
            <TabsContent value="incoming">
              <div className="space-y-3">
                {filteredPayments
                  .filter((p) => p.type === "incoming")
                  .map((payment) => {
                    const status =
                      getStatusView(payment)
                    const StatusIcon = status.icon

                    return (
                      <div
                        key={payment.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border border-border bg-secondary/30"
                      >
                        <div className="flex items-center gap-4">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10">
                            <ArrowDownLeft className="h-5 w-5 text-green-500" />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {payment.beneficiary}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {payment.reference} • {payment.date}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <p className="text-lg font-bold text-green-500">
                            +{payment.amount}
                          </p>
                          <Badge
                            variant="outline"
                            className={cn("text-[10px]", status.color)}
                          >
                            {status.label}
                          </Badge>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </TabsContent>
            <TabsContent value="outgoing">
              <div className="space-y-3">
                {filteredPayments
                  .filter((p) => p.type === "outgoing")
                  .map((payment) => {
                    const status =
                      getStatusView(payment)
                    const StatusIcon = status.icon

                    return (
                      <div
                        key={payment.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border border-border bg-secondary/30"
                      >
                        <div className="flex items-center gap-4">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                            <ArrowUpRight className="h-5 w-5 text-red-500" />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {payment.beneficiary}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {payment.reference} • {payment.date}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <p className="text-lg font-bold text-foreground">
                            -{payment.amount}
                          </p>
                          <Badge
                            variant="outline"
                            className={cn("text-[10px]", status.color)}
                          >
                            {status.label}
                          </Badge>
                          {recallStateLabel(payment) ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20"
                            >
                              <Undo2 className="mr-1 h-3 w-3" />
                              {recallStateLabel(payment)}
                            </Badge>
                          ) : (
                            canRecall(payment) && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8"
                                onClick={() => setRecallTarget(payment)}
                              >
                                <Undo2 className="mr-2 h-4 w-4" />
                                Recall
                              </Button>
                            )
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Payment details dialog */}
      <Dialog
        open={!!viewPaymentTarget}
        onOpenChange={(open) => !open && setViewPaymentTarget(null)}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          {viewPaymentTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Payment Details</DialogTitle>
                <DialogDescription>{viewPaymentTarget.id}</DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-secondary/30 p-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {viewPaymentTarget.type === "incoming" ? "Amount Received" : "Amount Sent"}
                </p>
                <p
                  className={cn(
                    "mt-1 text-2xl font-bold",
                    viewPaymentTarget.type === "incoming" ? "text-green-500" : "text-foreground",
                  )}
                >
                  {viewPaymentTarget.type === "incoming" ? "+" : "-"}
                  {viewPaymentTarget.amount}
                </p>
              </div>
              <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                {[
                  ["Direction", viewPaymentTarget.type === "incoming" ? "Incoming" : "Outgoing"],
                  ["Counterparty", viewPaymentTarget.beneficiary],
                  ["Country", viewPaymentTarget.beneficiaryCountry],
                  ["Reference", viewPaymentTarget.reference],
                  ["IBAN / Account", viewPaymentTarget.iban],
                  ["SWIFT / BIC", viewPaymentTarget.swiftCode],
                  [
                    "Routed Via",
                    viewPaymentTarget.routedBankName
                      ? `${viewPaymentTarget.routedBankName}${viewPaymentTarget.routedBankBic ? ` (${viewPaymentTarget.routedBankBic})` : ""}`
                      : "",
                  ],
                  ["Fee", viewPaymentTarget.fee],
                  [
                    "Status",
                    viewPaymentTarget.type === "incoming"
                      ? "Received"
                      : PAYMENT_STAGE_LABEL[viewPaymentTarget.stage ?? "review"],
                  ],
                  ["Date", viewPaymentTarget.time ? `${viewPaymentTarget.date} ${viewPaymentTarget.time}` : viewPaymentTarget.date],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label} className="bg-card p-3">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-0.5 text-sm font-medium text-foreground break-words">
                        {value}
                      </p>
                    </div>
                  ))}
              </div>

              {/* SWIFT gpi end-to-end tracking */}
              <SwiftGpiTracker
                payment={{
                  uetr: viewPaymentTarget.uetr,
                  // Map the three-stage lifecycle onto the gpi tracker vocabulary
                  // so a "delivered" payment shows fully credited (ACSC) rather
                  // than stalling at "in transit". Incoming credits are always
                  // presented as received by the tracker's incoming branch.
                  status:
                    viewPaymentTarget.type === "incoming"
                      ? "completed"
                      : paymentStageToGpiStatus(viewPaymentTarget.stage ?? "review"),
                  currency: viewPaymentTarget.currency,
                  beneficiaryBic: viewPaymentTarget.swiftCode,
                  beneficiaryName: viewPaymentTarget.beneficiary,
                  beneficiaryCountry: viewPaymentTarget.beneficiaryCountry,
                  baseDate: viewPaymentTarget.baseDate,
                  direction: viewPaymentTarget.type === "incoming" ? "incoming" : "outgoing",
                }}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setViewPaymentTarget(null)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    const target = viewPaymentTarget
                    setViewPaymentTarget(null)
                    downloadReceipt(target)
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download Receipt
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Report issue dialog */}
      <Dialog open={!!reportTarget} onOpenChange={(open) => !open && setReportTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {reportTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Report an Issue</DialogTitle>
                <DialogDescription>
                  Tell us what went wrong with payment {reportTarget.id}. Our support team will
                  review and follow up by email.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{reportTarget.beneficiary}</span>
                  <span className="text-sm font-semibold text-foreground">
                    {reportTarget.amount}
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="report-message">Describe the issue</Label>
                <Textarea
                  id="report-message"
                  value={reportMessage}
                  onChange={(e) => setReportMessage(e.target.value)}
                  placeholder="e.g. The beneficiary has not received the funds, or the amount is incorrect."
                  rows={4}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setReportTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={submitReport}>Submit Report</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Recall payment dialog */}
      <Dialog open={!!recallTarget} onOpenChange={(open) => !open && !recallBusy && setRecallTarget(null)}>
        <DialogContent className="sm:max-w-md">
          {recallTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Recall this payment?</DialogTitle>
                <DialogDescription>
                  This sends a recall request for an administrator to approve. Once approved, the
                  full amount is refunded to your account and any credit to the beneficiary is
                  reversed. No funds move until it is approved.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{recallTarget.beneficiary}</span>
                  <span className="text-sm font-semibold text-foreground">{recallTarget.amount}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="text-xs text-muted-foreground">{recallTarget.id}</code>
                  <span className="text-muted-foreground">•</span>
                  <span className="text-xs text-muted-foreground">{recallTarget.iban}</span>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRecallTarget(null)} disabled={recallBusy}>
                  Cancel
                </Button>
                <Button onClick={confirmRecall} disabled={recallBusy}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  {recallBusy ? "Submitting…" : "Request Recall"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
