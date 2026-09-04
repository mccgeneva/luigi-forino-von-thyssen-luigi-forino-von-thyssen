"use client"

import { useRef, useState } from "react"
import { Copy, Check, Download, Share2, Landmark, Info, Wallet, ShieldCheck, ArrowDownLeft, Lock } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
 import { Input } from "@/components/ui/input"
 import { MoneyInput } from "@/components/ui/money-input"
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
import { useActivityLog } from "@/components/activity-tracker"
import { useLedger } from "@/lib/ledger-store"
import { useCurrentUser } from "@/lib/use-current-user"
import { addLedgerEntryForUserAdmin } from "@/app/actions/ledger"
import { getActiveUserId } from "@/lib/user-scope"
import { VerifiedBankField } from "@/components/verified-bank-field"
import type { BankInfo } from "@/lib/iban-swift"

const currencySymbols: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF",
}

function formatCurrency(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || currency
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compose a single-line bank label from resolved directory info. */
function formatSenderBank(info: BankInfo): string {
  const cityLine = [info.postalCode, info.city].filter(Boolean).join(" ")
  const where = [cityLine, info.country].filter(Boolean).join(", ")
  return [info.name, info.bic ? `SWIFT ${info.bic}` : "", where].filter(Boolean).join(" · ")
}

// MCC Capital master receiving account (matches the Bank Accounts section)
const receivingAccount = {
  accountName: "MCC Capital",
  bankName: "Banking Circle - German Branch",
  iban: "DE73 2022 0800 0029 2908 19",
  swift: "SXPYDEHHXXX",
  currency: "EUR",
  bankAddress: "80333 München, Germany",
  beneficiaryAddress: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  reference: "MCC-INBOUND",
}

export default function ReceiveFundsPage() {
  const logActivity = useActivityLog()
  const { balanceFor, refresh } = useLedger()
  // The beneficiary of the client's own receiving account is the client's OWN
  // entity (their company, else full name) — not the platform label "MCC
  // Capital". Payers must see the account holder as this user's own company.
  const currentUser = useCurrentUser()
  const beneficiaryName =
    (currentUser.company && currentUser.company !== "—" ? currentUser.company.trim() : "") ||
    (currentUser.fullName && currentUser.fullName !== "Account" ? currentUser.fullName.trim() : "") ||
    receivingAccount.accountName
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [reqAmount, setReqAmount] = useState("")
  const [reqCurrency, setReqCurrency] = useState("EUR")
  const [reqReference, setReqReference] = useState("")

  // Read-only balance. Incoming payments can only be credited by MCC Capital's
  // operations desk (administrator) after the funds settle on the platform
  // account — clients can never post a credit to their own balance here.
  const currentBalance = balanceFor("EUR")

  // --- Administrator-only: record a received payment (credit the balance) ----
  // The form below is gated by the administrator passcode and verified
  // server-side by `addLedgerEntryForUserAdmin`. A client without the passcode
  // cannot credit anything; the page stays read-only for them. The credit is
  // posted to the account currently being viewed (the signed-in session).
  const [adminPasscode, setAdminPasscode] = useState("")
  const [rcvReceiptNo, setRcvReceiptNo] = useState("")
  const [rcvSender, setRcvSender] = useState("")
  const [rcvSenderAccount, setRcvSenderAccount] = useState("")
  const [rcvSenderBank, setRcvSenderBank] = useState("")
  const [rcvAmount, setRcvAmount] = useState("")
  const [rcvCurrency, setRcvCurrency] = useState("EUR")
  const [rcvComment, setRcvComment] = useState("")
  const [posting, setPosting] = useState(false)
  // Tracks the last value we auto-filled into "Sender Bank" from an IBAN
  // lookup, so a fresh lookup never clobbers a value the admin typed manually.
  const autoFilledBankRef = useRef("")

  // Auto-resolve the sender bank from a valid sender IBAN. Manual edits win:
  // we only overwrite the bank field when it's empty or still equals what we
  // last auto-filled.
  const handleResolvedSenderBank = (info: BankInfo | null) => {
    if (!info) return
    const resolved = formatSenderBank(info)
    if (!resolved) return
    const prev = autoFilledBankRef.current
    setRcvSenderBank((cur) => (cur === "" || cur === prev ? resolved : cur))
    autoFilledBankRef.current = resolved
  }

  const resetReceiveForm = () => {
    setRcvReceiptNo("")
    setRcvSender("")
    setRcvSenderAccount("")
    setRcvSenderBank("")
    autoFilledBankRef.current = ""
    setRcvAmount("")
    setRcvComment("")
  }

  const handleRecordReceipt = async () => {
    if (!adminPasscode.trim()) {
      toast.error("Administrator passcode is required")
      return
    }
    const amountValue = Number.parseFloat(rcvAmount)
    if (!rcvReceiptNo.trim()) {
      toast.error("Receipt number is required")
      return
    }
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      toast.error("Enter a valid amount greater than 0")
      return
    }

    const userId = getActiveUserId()
    const receiptId = rcvReceiptNo.trim().toUpperCase()
    setPosting(true)
    try {
      const result = await addLedgerEntryForUserAdmin(adminPasscode.trim(), userId, {
        id: receiptId,
        direction: "credit",
        amount: amountValue,
        currency: rcvCurrency,
        status: "completed",
        date: new Date().toISOString(),
        counterparty: rcvSender.trim() || "Unknown sender",
        account: rcvSenderAccount.trim() || undefined,
        bank: rcvSenderBank.trim() || undefined,
        reference: receiptId,
        comment: rcvComment.trim() || undefined,
        category: "Incoming Transfer",
      })

      if (!result.ok) {
        toast.error("Could not record payment", { description: result.error })
        return
      }

      // Re-read the persisted ledger so the credited balance shows immediately.
      refresh()

      const formatted = formatCurrency(amountValue, rcvCurrency)
      logActivity({
        action: `Administrator recorded received payment ${formatted} (Receipt ${receiptId})`,
        category: "Receive Funds",
        details: {
          summary: `Administrator confirmed and posted an incoming payment of ${formatted} from ${rcvSender.trim() || "an external sender"} (receipt ${receiptId}). The account balance was credited after verification.`,
          receipt: receiptId,
          amount: formatted,
          currency: rcvCurrency,
          sender: rcvSender.trim() || "(not provided)",
        },
      })

      toast.success(`Payment recorded: ${formatted}`, {
        description: `Receipt ${receiptId} credited to the account's ${rcvCurrency} balance.`,
      })
      resetReceiveForm()
    } catch (err) {
      toast.error("Could not record payment", { description: (err as Error).message })
    } finally {
      setPosting(false)
    }
  }

  const copyToClipboard = (label: string, value: string) => {
    navigator.clipboard?.writeText(value)
    setCopiedField(label)
    logActivity({
      action: `Copied receiving detail: ${label}`,
      category: "Receive Funds",
      details: {
        summary: `Client copied their "${label}" receiving detail to share with a payer.`,
        field: label,
        value: label === "Payment request" ? "(full request summary)" : value,
      },
    })
    setTimeout(() => setCopiedField(null), 1500)
  }

  const detailRows: { label: string; value: string }[] = [
    { label: "Account Holder", value: beneficiaryName },
    { label: "Bank", value: receivingAccount.bankName },
    { label: "IBAN", value: receivingAccount.iban },
    { label: "SWIFT / BIC", value: receivingAccount.swift },
    { label: "Currency", value: receivingAccount.currency },
    { label: "Bank Address", value: receivingAccount.bankAddress },
    { label: "Beneficiary Address", value: receivingAccount.beneficiaryAddress },
  ]

  const requestSummary = [
    `Please remit funds to the following account:`,
    ``,
    `Account Holder: ${beneficiaryName}`,
    `Bank: ${receivingAccount.bankName}`,
    `IBAN: ${receivingAccount.iban}`,
    `SWIFT/BIC: ${receivingAccount.swift}`,
    reqAmount
      ? `Amount: ${reqCurrency} ${Number.parseFloat(reqAmount || "0").toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `Currency: ${receivingAccount.currency}`,
    `Reference: ${reqReference || receivingAccount.reference}`,
  ].join("\n")

  const shareRequest = () => {
    copyToClipboard("Payment request", requestSummary)
    const amountText = reqAmount
      ? `${reqCurrency} ${Number.parseFloat(reqAmount).toLocaleString()}`
      : "(any amount)"
    logActivity({
      action: `Generated incoming payment request for ${amountText}`,
      category: "Receive Funds",
      details: {
        summary: `Client generated a payment request asking a payer to remit ${amountText} to ${beneficiaryName} (IBAN ${receivingAccount.iban}, SWIFT ${receivingAccount.swift}). Reference: ${reqReference || receivingAccount.reference}.`,
        requestedAmount: amountText,
        currency: reqCurrency,
        reference: reqReference || receivingAccount.reference,
        receivingAccount: beneficiaryName,
        iban: receivingAccount.iban,
        swiftBic: receivingAccount.swift,
      },
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Receive Funds</h1>
        <p className="text-sm text-muted-foreground">
          Share these account details with the payer to receive an incoming transfer. You do not move money here &mdash; the sender uses them to credit your account.
        </p>
      </div>

      {/* Info banner to distinguish from Send Payment */}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">How receiving works:</span> Send Payment debits your master account to pay someone else. Receiving Funds is the opposite &mdash; you give the sender your coordinates below and the funds arrive into your MCC Capital account.
        </p>
      </div>

      {/* Current balance summary — reflects all recorded incoming payments */}
      <Card className="bg-card border-border">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Current EUR Balance
              </p>
              <p className="text-2xl font-bold text-foreground">
                {formatCurrency(currentBalance, "EUR")}
              </p>
            </div>
          </div>
          <p className="max-w-xs text-xs text-muted-foreground">
            Your balance updates automatically once MCC Capital confirms and posts an incoming payment to your account. This figure is read-only.
          </p>
        </CardContent>
      </Card>

      {/* Read-only notice: crediting is administrator-controlled */}
      <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Incoming payments are verified by MCC Capital</p>
          <p className="text-sm text-muted-foreground text-pretty">
            For your protection, only MCC Capital&apos;s operations desk can credit incoming funds, and only after the money has actually settled on the platform account. You cannot post a receipt to your own balance. Share the coordinates below with your payer, then track the credit in your transaction history once it clears.
          </p>
        </div>
      </div>

      {/* Administrator-only: record a received payment and credit this account */}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-amber-500/10 p-2 text-amber-500">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg">Administrator: Record a Received Payment</CardTitle>
              <CardDescription>
                Restricted to MCC Capital staff. Enter the administrator passcode to confirm a settled incoming payment and credit this account.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="rcv-passcode">Administrator Passcode</Label>
            <Input
              id="rcv-passcode"
              type="password"
              autoComplete="off"
              placeholder="Enter administrator passcode"
              value={adminPasscode}
              onChange={(e) => setAdminPasscode(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="rcv-receipt">Receipt Nº</Label>
              <Input
                id="rcv-receipt"
                placeholder="PPY3175227"
                value={rcvReceiptNo}
                onChange={(e) => setRcvReceiptNo(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rcv-sender">Sender Name</Label>
              <Input
                id="rcv-sender"
                placeholder="e.g. Glencore International AG"
                value={rcvSender}
                onChange={(e) => setRcvSender(e.target.value)}
              />
            </div>
            <VerifiedBankField
              id="rcv-sender-account"
              label="Sender IBAN / account (optional)"
              kind="iban"
              lenient
              value={rcvSenderAccount}
              onChange={setRcvSenderAccount}
              onResolved={handleResolvedSenderBank}
              placeholder="e.g. DE73202208000029290819"
            />
            <div className="grid gap-2">
              <Label htmlFor="rcv-sender-bank">Sender Bank (optional)</Label>
              <Input
                id="rcv-sender-bank"
                placeholder="Auto-filled from a recognised IBAN — or type manually"
                value={rcvSenderBank}
                onChange={(e) => setRcvSenderBank(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rcv-amount">Amount</Label>
              <MoneyInput
                id="rcv-amount"
                placeholder="0.00"
                value={rcvAmount}
                onValueChange={setRcvAmount}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rcv-currency">Currency</Label>
              <Select value={rcvCurrency} onValueChange={setRcvCurrency}>
                <SelectTrigger id="rcv-currency">
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
          <div className="grid gap-2">
            <Label htmlFor="rcv-comment">Comment (optional)</Label>
            <Textarea
              id="rcv-comment"
              placeholder="Payment description / remittance information"
              value={rcvComment}
              onChange={(e) => setRcvComment(e.target.value)}
              rows={2}
            />
          </div>
          <Button onClick={handleRecordReceipt} disabled={posting} className="w-full sm:w-auto">
            <ArrowDownLeft className="mr-2 h-4 w-4" />
            {posting ? "Posting…" : "Verify & Credit Balance"}
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Your receiving details */}
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-green-500/10 p-2 text-green-400">
                <Landmark className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-lg">Your Account Details</CardTitle>
                <CardDescription>Provide these to the remitting party</CardDescription>
              </div>
              <Badge variant="outline" className="ml-auto border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                Active
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {detailRows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-3 rounded-lg bg-secondary/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{row.label}</p>
                  <p className="truncate font-mono text-sm text-foreground">{row.value}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => copyToClipboard(row.label, row.value)}
                  aria-label={`Copy ${row.label}`}
                >
                  {copiedField === row.label ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Create a payment request */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-lg">Request a Payment</CardTitle>
            <CardDescription>
              Optionally specify an amount and reference, then share the full request.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="req-amount">Amount (optional)</Label>
                <MoneyInput
                  id="req-amount"
                  placeholder="0.00"
                  value={reqAmount}
                  onValueChange={setReqAmount}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="req-currency">Currency</Label>
                <Select value={reqCurrency} onValueChange={setReqCurrency}>
                  <SelectTrigger id="req-currency">
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
            <div className="grid gap-2">
              <Label htmlFor="req-reference">Reference</Label>
              <Input
                id="req-reference"
                placeholder={receivingAccount.reference}
                value={reqReference}
                onChange={(e) => setReqReference(e.target.value)}
              />
            </div>

            <div className="rounded-lg border border-border bg-secondary/30 p-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Request Preview</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{requestSummary}</pre>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={shareRequest} className="flex-1">
                {copiedField === "Payment request" ? (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    Copied
                  </>
                ) : (
                  <>
                    <Share2 className="mr-2 h-4 w-4" />
                    Copy Payment Request
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                className="flex-1 bg-transparent"
                onClick={() => copyToClipboard("All details", detailRows.map((r) => `${r.label}: ${r.value}`).join("\n"))}
              >
                <Download className="mr-2 h-4 w-4" />
                Copy All Details
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
