"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Send,
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  Zap,
  Mail,
  Search,
  Download,
  FileText,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { useActivityLog } from "@/components/activity-tracker"
import { useLedger } from "@/lib/ledger-store"
import { usePaymentRequests } from "@/lib/payment-requests-store"
import { useCurrentUser } from "@/lib/use-current-user"
import type { TransferDirectoryEntry } from "@/lib/users"
import { exportToCsv } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { resolveTransferRecipient } from "@/app/actions/transfers"
import { sendInstantTransfer } from "@/app/actions/ledger"
import { toast } from "sonner"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "SGD"]
const INSTANT_CATEGORY = "Internal Transfer"
const APPROVAL_SOURCE = "Send Money (internal transfer)"

type SendMethod = "instant" | "approval"

const formatCurrency = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

const approvalStatusBadge: Record<
  string,
  { label: string; className: string; icon: typeof Clock }
> = {
  pending: {
    label: "Pending approval",
    className: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
    icon: Clock,
  },
  approved: {
    label: "Approved",
    className: "border-green-500/20 bg-green-500/10 text-green-500",
    icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    className: "border-red-500/20 bg-red-500/10 text-red-500",
    icon: XCircle,
  },
}

// A single unified row type so instant settlements and approval requests can
// share one history list.
type HistoryRow = {
  key: string
  kind: "instant" | "approval"
  direction: "credit" | "debit"
  status: "settled" | "pending" | "approved" | "rejected"
  counterparty: string
  reference: string
  note: string
  amount: number
  currency: string
  date: string
  decisionNote?: string
}

export default function SendMoneyPage() {
  const logActivity = useActivityLog()
  const { entries, balanceFor, refresh, hydrated } = useLedger()
  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress } = useHolderIdentity()
  const { requests, addRequest } = usePaymentRequests()

  // Resolve the acting sender from the authoritative signed-in identity (which
  // resolves dynamic, admin-created users from the httpOnly session) rather than
  // the client `mcc_user` cookie. This prevents a payment from ever being
  // attributed to, or sent from, the wrong account.
  const self = useCurrentUser()
  const activeUserId = self.id
  // NOTE: We deliberately do NOT fetch or render a list of platform accounts
  // here. Exposing other clients' names and emails to any sender is a privacy
  // leak. Recipients must be entered by their registered email and are resolved
  // privately on the server via `resolveTransferRecipient`.

  const [method, setMethod] = useState<SendMethod>("instant")
  const [recipientEmail, setRecipientEmail] = useState("")
  const [recipientName, setRecipientName] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  const availableBalance = balanceFor(currency)

  // Live recipient resolution for the instant method. Every account is resolved
  // on the server (which checks the Neon `admin_users` table), so any account
  // that can log in can also receive transfers.
  const [resolvedRecipient, setResolvedRecipient] = useState<TransferDirectoryEntry | undefined>(
    undefined,
  )
  const [resolvingRecipient, setResolvingRecipient] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const email = recipientEmail.trim()
    if (!email) {
      setResolvedRecipient(undefined)
      setResolvingRecipient(false)
      return
    }
    // Debounce a server lookup that resolves the recipient from the database.
    let cancelled = false
    setResolvingRecipient(true)
    const handle = window.setTimeout(async () => {
      try {
        const res = await resolveTransferRecipient(email)
        if (cancelled) return
        setResolvedRecipient(res.ok ? (res.recipient ?? undefined) : undefined)
      } catch {
        if (!cancelled) setResolvedRecipient(undefined)
      } finally {
        if (!cancelled) setResolvingRecipient(false)
      }
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [recipientEmail])

  const recipientIsSelf = resolvedRecipient?.id === activeUserId

  // Unified history: instant settlements come from the ledger, approval
  // requests come from the payment-requests store. Merge and sort by date.
  const history = useMemo<HistoryRow[]>(() => {
    const instant: HistoryRow[] = entries
      .filter((e) => e.category === INSTANT_CATEGORY)
      .map((e) => ({
        key: `instant-${e.id}-${e.direction}-${e.date}`,
        kind: "instant",
        direction: e.direction,
        status: "settled",
        counterparty: e.counterparty,
        reference: e.reference || e.id,
        note: e.comment || "",
        amount: e.amount,
        currency: e.currency,
        date: e.date,
      }))

    const approval: HistoryRow[] = requests
      .filter((r) => r.payeeSource === APPROVAL_SOURCE)
      .map((r) => ({
        key: `approval-${r.id}`,
        kind: "approval",
        direction: "debit",
        status: r.status,
        counterparty: r.beneficiary,
        reference: r.id,
        note: r.notes || "",
        amount: r.amount,
        currency: r.currency,
        date: r.submittedAt,
        decisionNote: r.decisionNote,
      }))

    return [...instant, ...approval].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    )
  }, [entries, requests])

  const filteredHistory = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return history
    return history.filter(
      (t) =>
        t.counterparty.toLowerCase().includes(q) ||
        t.reference.toLowerCase().includes(q) ||
        t.note.toLowerCase().includes(q),
    )
  }, [history, search])

  const sentTotal = history
    .filter((t) => t.direction === "debit" && t.status !== "rejected")
    .reduce((sum, t) => sum + t.amount, 0)
  const receivedTotal = history
    .filter((t) => t.direction === "credit")
    .reduce((sum, t) => sum + t.amount, 0)
  const pendingCount = history.filter((t) => t.status === "pending").length

  const resetForm = () => {
    setRecipientEmail("")
    setRecipientName("")
    setAmount("")
    setReference("")
    setNote("")
    setFormError(null)
  }

  const handleInstantSend = async () => {
    setFormError(null)
    const amountValue = Number.parseFloat(amount)
    const email = recipientEmail.trim().toLowerCase()

    if (!email) {
      setFormError("Please enter the recipient's registered email address.")
      return
    }
    // Resolve across static + dynamic (admin-created) accounts. Prefer the
    // already-resolved recipient, but re-check on the server to be safe.
    let recipient = resolvedRecipient
    if (!recipient || recipient.email.toLowerCase() !== email) {
      const res = await resolveTransferRecipient(email)
      recipient = res.ok ? (res.recipient ?? undefined) : undefined
    }
    if (!recipient) {
      setFormError("No platform account is registered to that email address.")
      return
    }
    if (recipient.id === activeUserId) {
      setFormError("You cannot send an instant transfer to your own account.")
      return
    }
    if (!amount || Number.isNaN(amountValue) || amountValue <= 0) {
      setFormError("Please enter a valid amount greater than 0.")
      return
    }
    if (amountValue > availableBalance) {
      setFormError(
        `Insufficient funds. This transfer needs ${formatCurrency(amountValue, currency)} but only ${formatCurrency(availableBalance, currency)} is available.`,
      )
      return
    }

    // Settle the transfer SERVER-SIDE so both parties see it on any device or
    // browser. (Posting to the browser's localStorage only made the money appear
    // on the same browser, never cross-device.) The server validates the
    // recipient and the sender's available balance, then posts both ledger legs.
    setSending(true)
    const result = await sendInstantTransfer({
      recipientEmail: recipient.email,
      amount: amountValue,
      currency,
      note: note.trim(),
      reference: reference.trim(),
    })
    setSending(false)

    if (!result.ok) {
      setFormError(result.error)
      return
    }

    // Pull the authoritative server ledger so the sender's debit shows instantly.
    refresh()

    toast.success("Transfer sent instantly", {
      description: `${formatCurrency(amountValue, currency)} delivered to ${recipient.displayName} (${recipient.email}).`,
    })
    resetForm()
  }

  const handleApprovalSend = () => {
    setFormError(null)
    const amountValue = Number.parseFloat(amount)
    const to = recipientName.trim()

    if (!to) {
      setFormError("Enter the recipient's name or registered email address.")
      return
    }
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      setFormError("Enter a valid amount greater than 0.")
      return
    }
    if (amountValue > availableBalance) {
      setFormError(
        `Insufficient balance. This transfer needs ${formatCurrency(amountValue, currency)} but only ${formatCurrency(availableBalance, currency)} is available.`,
      )
      return
    }

    const requestId = `TRF-${new Date().getTime().toString().slice(-8)}`
    const formatted = formatCurrency(amountValue, currency)

    addRequest({
      id: requestId,
      beneficiary: to,
      beneficiaryCountry: "—",
      iban: to,
      swiftCode: "—",
      reference: note.trim() || `Internal transfer to ${to}`,
      notes: note.trim(),
      currency,
      amount: amountValue,
      fee: 0,
      total: amountValue,
      payeeSource: APPROVAL_SOURCE,
    })

    logActivity({
      action: `Submitted internal transfer of ${formatted} to ${to} for Administrator approval`,
      category: "Transfers",
      details: {
        summary: `Submitted an internal transfer request of ${formatted} to "${to}" for mandatory Administrator approval. No funds have left the account yet — they will only be debited once the request is approved. Reference: ${requestId}.`,
        reference: requestId,
        recipient: to,
        amount: formatted,
        status: "Pending Administrator Approval",
      },
    })

    toast.success("Transfer submitted for approval", {
      description: `Your transfer of ${formatted} to ${to} is pending Administrator approval. Funds will only be debited once it is approved.`,
    })
    resetForm()
  }

  const sendRows = () =>
    filteredHistory.map((t) => ({
      reference: t.reference,
      method: t.kind === "instant" ? "Instant" : "Approval",
      direction: t.direction === "credit" ? "Received" : "Sent",
      status: t.status,
      amount: formatCurrency(t.amount, t.currency),
      counterparty: t.counterparty,
      note: t.note,
      date: t.date,
    }))

  const handleExportCsv = () => {
    const count = exportToCsv("send-money", sendRows(), [
      { key: "reference", label: "Reference" },
      { key: "method", label: "Method" },
      { key: "direction", label: "Direction" },
      { key: "status", label: "Status" },
      { key: "amount", label: "Amount" },
      { key: "counterparty", label: "Counterparty" },
      { key: "note", label: "Note" },
      { key: "date", label: "Date" },
    ])
    toast.success("Transfers exported", {
      description: `${count} transfer${count === 1 ? "" : "s"} exported to CSV.`,
    })
  }

  const handleExportPdf = () => {
    if (filteredHistory.length === 0) {
      toast.info("No transfers to export", { description: "There are no transfers matching the current filters." })
      return
    }
    const doc = generateTablePdf({
      title: "Transfer History",
      refPrefix: "SND",
      holderName,
      holderCompany,
      holderAddress,
      meta: [{ label: "Records", value: `${filteredHistory.length}` }],
      columns: [
        { key: "date", header: "Date" },
        { key: "reference", header: "Reference" },
        { key: "method", header: "Method" },
        { key: "counterparty", header: "Counterparty" },
        { key: "direction", header: "Dir." },
        { key: "amount", header: "Amount", align: "right" },
        { key: "status", header: "Status" },
      ],
      rows: sendRows(),
      footNote: "Transfer history exported from the MCC Capital platform with the filters active at the time of export.",
    })
    show({ doc, filename: tablePdfFilename("Transfer-History"), title: "Transfer History" })
  }

  const stats = [
    {
      title: "Available Balance",
      value: formatCurrency(availableBalance, currency),
      hint: `${currency} account`,
      icon: Wallet,
      color: "text-primary",
    },
    {
      title: "Total Sent",
      value: formatCurrency(sentTotal, currency),
      hint: pendingCount > 0 ? `${pendingCount} pending approval` : "Settled & approved",
      icon: ArrowUpRight,
      color: "text-red-400",
    },
    {
      title: "Total Received",
      value: formatCurrency(receivedTotal, currency),
      hint: "Instant transfers",
      icon: ArrowDownLeft,
      color: "text-green-400",
    },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Send Money</h1>
          <p className="text-sm text-muted-foreground">
            Transfer funds to another MCC Capital account holder — instantly to a verified account, or
            via Administrator approval for any recipient.
          </p>
        </div>
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

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.title} className="bg-card border-border">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs text-muted-foreground">{stat.title}</p>
                <p className="mt-1 text-xl font-bold text-foreground">{stat.value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{stat.hint}</p>
              </div>
              <div className={cn("rounded-lg bg-secondary/50 p-3", stat.color)}>
                <stat.icon className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Transfer form */}
        <Card className="bg-card border-border lg:col-span-2">
          <CardHeader className="space-y-3">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Send className="h-5 w-5 text-primary" />
              New Transfer
            </CardTitle>
            {/* Method toggle */}
            <Tabs value={method} onValueChange={(v) => { setMethod(v as SendMethod); setFormError(null) }}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="instant" className="gap-1.5">
                  <Zap className="h-3.5 w-3.5" />
                  Instant
                </TabsTrigger>
                <TabsTrigger value="approval" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Approval
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <CardDescription>
              {method === "instant" ? (
                <>
                  Settled in real time to a verified MCC account holder using their registered email.
                </>
              ) : (
                <>
                  Submitted to an MCC Administrator for review. No funds move until the request is
                  approved.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Recipient — depends on method */}
            {method === "instant" ? (
              <div className="space-y-2">
                <Label htmlFor="recipient-email">Recipient email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="recipient-email"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    placeholder="recipient@mccgva.ch"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {recipientEmail.trim() && resolvedRecipient && !recipientIsSelf && (
                  <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 p-2.5">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/20 text-xs text-primary">
                        {resolvedRecipient.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {resolvedRecipient.displayName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {resolvedRecipient.company}
                      </p>
                    </div>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  </div>
                )}
                {recipientEmail.trim() && recipientIsSelf && (
                  <p className="text-xs text-red-400">You cannot transfer to your own account.</p>
                )}
                {recipientEmail.trim() && !resolvedRecipient && resolvingRecipient && (
                  <p className="text-xs text-muted-foreground">Checking account…</p>
                )}
                {recipientEmail.trim() && !resolvedRecipient && !resolvingRecipient && (
                  <p className="text-xs text-muted-foreground">
                    No account found for this email yet.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="recipient-name">Recipient</Label>
                <Input
                  id="recipient-name"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="Name or name@example.com"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger id="currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Available:{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(availableBalance, currency)}
              </span>
            </p>

            {method === "instant" && (
              <div className="space-y-2">
                <Label htmlFor="reference">Reference (optional)</Label>
                <Input
                  id="reference"
                  placeholder="e.g. Invoice 2026-014"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="note">Note (optional)</Label>
              <Textarea
                id="note"
                rows={2}
                placeholder={
                  method === "instant" ? "Add a message for the recipient" : "What's this transfer for?"
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/* Approval method security notice */}
            {method === "approval" && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 p-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Approval required:</span> the transfer
                  is placed in a pending queue and no funds leave your account until an MCC Administrator
                  authorises it.
                </p>
              </div>
            )}

            {formError && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-400">
                {formError}
              </p>
            )}

            {method === "instant" ? (
              <Button
                className="w-full"
                onClick={handleInstantSend}
                disabled={!resolvedRecipient || recipientIsSelf || sending}
              >
                <Zap className="mr-2 h-4 w-4" />
                {sending ? "Sending…" : "Send Instantly"}
              </Button>
            ) : (
              <Button className="w-full" onClick={handleApprovalSend}>
                <Send className="mr-2 h-4 w-4" />
                Submit for Approval
              </Button>
            )}

          </CardContent>
        </Card>

        {/* Unified history */}
        <Card className="bg-card border-border lg:col-span-3">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-lg font-semibold">Transfer History</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search transfers"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </CardHeader>
          <CardContent>
            {!hydrated ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Send className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No transfers yet. Send funds to another account to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredHistory.map((t) => {
                  const isReceived = t.direction === "credit"
                  const approvalBadge =
                    t.kind === "approval"
                      ? approvalStatusBadge[t.status] ?? approvalStatusBadge.pending
                      : null
                  const ApprovalIcon = approvalBadge?.icon
                  return (
                    <div
                      key={t.key}
                      className="flex items-center gap-3 rounded-lg border border-border p-3"
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                          isReceived
                            ? "bg-green-500/10 text-green-500"
                            : t.status === "rejected"
                              ? "bg-red-500/10 text-red-400"
                              : "bg-blue-500/10 text-blue-400",
                        )}
                      >
                        {isReceived ? (
                          <ArrowDownLeft className="h-4 w-4" />
                        ) : t.status === "rejected" ? (
                          <XCircle className="h-4 w-4" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {isReceived ? "From" : "To"} {t.counterparty}
                          </p>
                          <Badge
                            variant="outline"
                            className={cn(
                              "shrink-0 text-[10px]",
                              t.kind === "instant"
                                ? "border-primary/20 bg-primary/10 text-primary"
                                : "border-border bg-secondary/40 text-muted-foreground",
                            )}
                          >
                            {t.kind === "instant" ? "Instant" : "Approval"}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {t.reference} · {formatDate(t.date)}
                        </p>
                        {t.note && (
                          <p className="truncate text-[11px] text-muted-foreground/80">{t.note}</p>
                        )}
                        {t.status === "rejected" && t.decisionNote && (
                          <p className="truncate text-[11px] text-red-400">
                            Reason: {t.decisionNote}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={cn(
                            "text-sm font-semibold",
                            isReceived ? "text-green-500" : "text-foreground",
                          )}
                        >
                          {isReceived ? "+" : "−"}
                          {formatCurrency(t.amount, t.currency)}
                        </p>
                        {t.kind === "instant" ? (
                          <Badge
                            variant="outline"
                            className="mt-1 border-green-500/20 bg-green-500/10 text-[10px] text-green-500"
                          >
                            <CheckCircle2 className="mr-1 h-3 w-3" />
                            Settled
                          </Badge>
                        ) : (
                          approvalBadge && (
                            <Badge
                              variant="outline"
                              className={cn("mt-1 gap-1 text-[10px]", approvalBadge.className)}
                            >
                              {ApprovalIcon && <ApprovalIcon className="h-3 w-3" />}
                              {approvalBadge.label}
                            </Badge>
                          )
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
