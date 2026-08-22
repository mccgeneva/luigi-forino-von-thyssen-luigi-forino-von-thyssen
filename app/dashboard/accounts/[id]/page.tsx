"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  Building2,
  Check,
  Copy,
  Shield,
  ArrowUpRight,
  Download,
  Mail,
  FileText,
  Lock,
  ChevronRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useActivityLog } from "@/components/activity-tracker"
import { useCurrentUser } from "@/lib/use-current-user"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generateAccountDetailsPdf } from "@/lib/account-details-pdf"
import { useLedger, type LedgerEntry } from "@/lib/ledger-store"
import {
  useBankAccounts,
  formatCurrency,
  getRatingColor,
  getStatusColor,
  getFlagEmoji,
  normalizeAccountRef,
} from "@/lib/bank-accounts"

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const logActivity = useActivityLog()
  const currentUser = useCurrentUser()
  const { show: showPdf } = usePdfViewer()
  const bankAccounts = useBankAccounts()
  const { entries } = useLedger()
  const [copiedField, setCopiedField] = useState<string | null>(null)
  // Whether the reserved-funds breakdown dialog is open.
  const [reservedOpen, setReservedOpen] = useState(false)

  const id = decodeURIComponent(params.id)
  const account = useMemo(() => bankAccounts.find((a) => a.id === id), [bankAccounts, id])

  // The individual held debits that make up this account's Reserved figure, so
  // the client can see exactly WHY funds are locked and WHAT each hold is for.
  // The filter mirrors how the reserved total itself is computed in
  // `useBankAccounts`: a registered (external) account matches held debits whose
  // receiving IBAN is this account; a settlement account matches every held
  // debit in its currency.
  const reservedEntries: LedgerEntry[] = useMemo(() => {
    if (!account) return []
    const isRegistered = !account.id.startsWith("ACC-")
    const target = normalizeAccountRef(account.iban)
    return entries
      .filter((e) => {
        if (e.currency !== account.currency) return false
        if (e.status !== "hold" || e.direction !== "debit") return false
        if (!isRegistered) return true
        const ref = e.receivedAccount ? e.receivedAccount : e.account
        return normalizeAccountRef(ref) === target
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [account, entries])

  const reservedTotal = reservedEntries.reduce((sum, e) => sum + e.amount, 0)

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  if (!account) {
    return (
      <div className="mx-auto max-w-3xl">
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href="/dashboard/accounts">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Accounts
          </Link>
        </Button>
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <Building2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Account not found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              We couldn&apos;t find an account with reference <code className="text-foreground">{id}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleSendPayment = () => {
    logActivity({
      action: `Started a payment from ${account.accountName ?? account.bankName}`,
      category: "Payments",
      details: {
        summary: `Client initiated a payment from "${account.accountName ?? account.bankName}".`,
        account: account.accountName ?? account.bankName ?? "—",
      },
    })
    router.push("/dashboard/payments")
  }

  const handleContactViaMcc = () => {
    const accountLabel = account.accountName ?? account.bankName ?? "my account"
    const subject = encodeURIComponent(`Account enquiry: ${accountLabel}`)
    const body = encodeURIComponent(
      `Hello MCC Client Services,\n\nI would like to make an enquiry regarding my account "${accountLabel}".\n\n[Please describe your request here]\n\nKind regards,`,
    )
    logActivity({
      action: `Contacted MCC about ${accountLabel}`,
      category: "Bank Accounts",
      details: {
        summary: `Client request routed to MCC admin (admin@mccgva.ch) regarding "${accountLabel}". Direct partner-bank contact is disabled.`,
        routedTo: "admin@mccgva.ch",
        account: accountLabel,
      },
    })
    window.location.href = `mailto:admin@mccgva.ch?subject=${subject}&body=${body}`
    toast.success("Request routed to MCC", {
      description: "Your enquiry is handled by MCC and sent to admin@mccgva.ch.",
    })
  }

  const handleExportAccount = () => {
    // Payment-instructions sheet: discloses ONLY the beneficiary and the banking
    // coordinates needed to remit funds into this account — no balances, limits,
    // volume, activity or other internal information.
    //
    // The beneficiary of the client's OWN master account (ACC-001) is the client
    // themselves — the entity/person that receives funds — NOT "MCC Capital"
    // (the platform label baked into the account record). We therefore use the
    // signed-in holder's own legal entity name (company) or full name. External
    // funding accounts keep their own beneficiary as-is.
    const isOwnAccount = account.id === "ACC-001"
    const holderCompany = currentUser.company?.trim()
    const holderName =
      isOwnAccount
        ? (holderCompany && holderCompany !== "—" ? holderCompany : currentUser.fullName) || account.accountName
        : account.accountName

    const generated = generateAccountDetailsPdf({
      accountName: holderName,
      bankName: account.bankName,
      country: account.country,
      currency: account.currency,
      accountNumber: account.accountNumber,
      iban: account.iban,
      swift: account.swift,
      sortCode: account.sortCode,
      routingNumber: account.routingNumber,
      bsb: account.bsb,
      branchCode: account.branchCode,
      branchAddress: account.branchAddress,
    })
    showPdf(generated)

    logActivity({
      action: `Exported payment instructions for ${account.bankName ?? holderName ?? "account"}`,
      category: "Bank Accounts",
      details: {
        summary: `Client exported payment instructions (beneficiary and banking coordinates only) — beneficiary "${holderName}".`,
        account: holderName ?? account.bankName ?? "—",
        currency: account.currency,
      },
    })
  }

  const handleViewStatement = () => {
    const scope = account.id === "ACC-001" ? "master" : `cur:${account.currency}`
    router.push(`/dashboard/statements?account=${encodeURIComponent(scope)}`)
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" onClick={() => router.back()} className="mb-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <Card className="bg-card border-border">
        <CardContent className="p-6">
          {/* Header */}
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-secondary text-lg font-bold text-amber-400">
              {account.bankLogo}
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">{account.bankName}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {getFlagEmoji(account.countryCode)} {account.country}
                </span>
                <Badge variant="outline" className={getRatingColor(account.rating)}>
                  {account.rating}
                </Badge>
                <Badge variant="outline" className={getStatusColor(account.status)}>
                  {account.status}
                </Badge>
              </div>
            </div>
          </div>

          <Tabs defaultValue="details" className="mt-6">
            <TabsList className="bg-secondary/50">
              <TabsTrigger value="details">Account Details</TabsTrigger>
              <TabsTrigger value="banking">Banking Info</TabsTrigger>
              <TabsTrigger value="limits">Limits & Volume</TabsTrigger>
              <TabsTrigger value="contact">Contact</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-4 space-y-4">
              <Card className="bg-secondary/40 border-border">
                <CardContent className="p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Account Name</p>
                      <p className="text-sm font-medium text-foreground">{account.accountName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Account Type</p>
                      <p className="text-sm font-medium text-foreground">{account.accountType}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Account Number</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-mono text-foreground">{account.accountNumber}</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={() => copyToClipboard(account.accountNumber, "acc-num")}
                        >
                          {copiedField === "acc-num" ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Currency</p>
                      <p className="text-sm font-medium text-foreground">{account.currency}</p>
                    </div>
                  </div>

                  {(() => {
                    const isRegistered = !account.id.startsWith("ACC-")
                    const total = isRegistered ? (account.trackedBalance ?? 0) : account.balance
                    const available = isRegistered ? (account.trackedAvailable ?? 0) : account.availableBalance
                    const reserved = isRegistered ? (account.trackedReserved ?? 0) : account.reservedBalance
                    return (
                      <div className="border-t border-border pt-4">
                        {/* Total balance — the headline figure, given full width so
                            large amounts never wrap mid-number. */}
                        <div className="rounded-lg bg-secondary p-4">
                          <p className="text-xs text-muted-foreground mb-1">
                            {isRegistered ? "Received Here" : "Total Balance"}
                          </p>
                          <p className="text-2xl sm:text-3xl font-bold text-foreground tabular-nums whitespace-nowrap overflow-x-auto">
                            {formatCurrency(total, account.currency)}
                          </p>
                        </div>

                        {/* Available / Reserved breakdown as full-width statement
                            rows: label on the left, amount right-aligned on one line. */}
                        <div className="mt-3 rounded-lg bg-secondary divide-y divide-border/60">
                          <div className="flex items-center justify-between gap-4 px-4 py-3">
                            <span className="text-sm text-muted-foreground">Available</span>
                            <span className="text-base sm:text-lg font-bold text-emerald-400 tabular-nums whitespace-nowrap">
                              {formatCurrency(available, account.currency)}
                            </span>
                          </div>
                          {reserved > 0 ? (
                            <button
                              type="button"
                              onClick={() => setReservedOpen(true)}
                              aria-label={`See why ${formatCurrency(reserved, account.currency)} is reserved`}
                              className="group/reserved flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-b-lg"
                            >
                              <span className="flex flex-col">
                                <span className="text-sm text-muted-foreground">Reserved</span>
                                <span className="text-[11px] font-medium text-amber-400/80 underline underline-offset-2">
                                  View details
                                </span>
                              </span>
                              <span className="flex items-center gap-1.5">
                                <span className="text-base sm:text-lg font-bold text-amber-400 tabular-nums whitespace-nowrap">
                                  {formatCurrency(reserved, account.currency)}
                                </span>
                                <ChevronRight className="h-4 w-4 shrink-0 text-amber-400/70 transition-transform group-hover/reserved:translate-x-0.5" />
                              </span>
                            </button>
                          ) : (
                            <div className="flex items-center justify-between gap-4 px-4 py-3">
                              <span className="text-sm text-muted-foreground">Reserved</span>
                              <span className="text-base sm:text-lg font-bold text-amber-400 tabular-nums whitespace-nowrap">
                                {formatCurrency(reserved, account.currency)}
                              </span>
                            </div>
                          )}
                        </div>
                        {isRegistered && (
                          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                            This is a registered external account. The figures above track funds received at this
                            specific bank. The same funds also settle into your{" "}
                            <span className="font-medium text-foreground">{account.currency} Settlement Account</span>,
                            so they are reflected in your master balance and transaction history.
                          </p>
                        )}
                      </div>
                    )
                  })()}

                  <div className="border-t border-border pt-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">Opened</p>
                        <p className="text-sm text-foreground">
                          {new Date(account.openDate).toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Last Activity</p>
                        <p className="text-sm text-foreground">
                          {new Date(account.lastActivity).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="banking" className="mt-4 space-y-4">
              <Card className="bg-secondary/40 border-border">
                <CardContent className="p-4 space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">IBAN</p>
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                      <span className="text-foreground break-all">{account.iban}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 ml-auto shrink-0"
                        onClick={() => copyToClipboard(account.iban, "detail-iban")}
                      >
                        {copiedField === "detail-iban" ? (
                          <Check className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">SWIFT/BIC</p>
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                      <span className="text-foreground">{account.swift}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 ml-auto"
                        onClick={() => copyToClipboard(account.swift, "detail-swift")}
                      >
                        {copiedField === "detail-swift" ? (
                          <Check className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {account.sortCode && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Sort Code</p>
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                        <span className="text-foreground">{account.sortCode}</span>
                      </div>
                    </div>
                  )}
                  {account.routingNumber && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Routing Number (ABA)</p>
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                        <span className="text-foreground">{account.routingNumber}</span>
                      </div>
                    </div>
                  )}
                  {account.bsb && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">BSB</p>
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                        <span className="text-foreground">{account.bsb}</span>
                      </div>
                    </div>
                  )}
                  {account.branchCode && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Branch Code</p>
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary font-mono">
                        <span className="text-foreground">{account.branchCode}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="limits" className="mt-4 space-y-4">
              <Card className="bg-secondary/40 border-border">
                <CardContent className="p-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="min-w-0 p-4 rounded-lg bg-secondary">
                      <p className="text-xs text-muted-foreground mb-1">Daily Limit</p>
                      <p className="text-base sm:text-lg font-bold text-foreground leading-tight tabular-nums break-words">
                        {account.dailyLimitUnlimited
                          ? "Unlimited"
                          : formatCurrency(account.dailyLimit, account.currency)}
                      </p>
                    </div>
                    <div className="min-w-0 p-4 rounded-lg bg-secondary">
                      <p className="text-xs text-muted-foreground mb-1">Monthly Volume</p>
                      <p className="text-base sm:text-lg font-bold text-foreground leading-tight tabular-nums break-words">
                        {account.monthlyVolumeUnlimited
                          ? "Unlimited"
                          : formatCurrency(account.monthlyVolume, account.currency)}
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Relationship Tier</p>
                    <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
                      {account.relationship}
                    </Badge>
                  </div>
                  {account.escrowDetails && (
                    <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs text-amber-400 font-medium mb-1">Escrow Notice</p>
                      <p className="text-sm text-amber-300">{account.escrowDetails}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="contact" className="mt-4 space-y-4">
              <Card className="bg-secondary/40 border-border">
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <Shield className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-amber-300">Communication handled by MCC</p>
                      <p className="text-xs text-amber-300/80 leading-relaxed">
                        For your security and compliance, clients do not contact partner banks directly. All
                        requests relating to this account are managed by your MCC relationship team and routed
                        through <span className="font-medium">admin@mccgva.ch</span>.
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Managed by</p>
                    <p className="text-sm font-medium text-foreground">MCC Client Services</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Branch Address</p>
                    <p className="text-sm text-foreground">{account.branchAddress}</p>
                  </div>
                  <Button
                    className="w-full bg-amber-500 hover:bg-amber-600 text-zinc-900 gap-2"
                    onClick={handleContactViaMcc}
                  >
                    <Mail className="h-4 w-4" />
                    Contact MCC about this account
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Actions */}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="outline" className="gap-2" onClick={handleViewStatement}>
              <FileText className="h-4 w-4" />
              View Statement
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleExportAccount}>
              <Download className="h-4 w-4" />
              Export Details
            </Button>
            <Button variant="outline" className="gap-2" onClick={handleSendPayment}>
              <ArrowUpRight className="h-4 w-4" />
              Send Payment
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Reserved-funds breakdown: every held debit that locks part of this
          account's balance, so the client sees exactly what each hold is for. */}
      <Dialog open={reservedOpen} onOpenChange={setReservedOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-amber-400" />
              Reserved funds · {account.currency}
            </DialogTitle>
            <DialogDescription>
              These transactions are on hold, so their total is set aside from your available balance
              at {account.accountName ?? account.bankName} until each one settles or is released.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">Total reserved</span>
              <span className="text-sm font-bold text-amber-400">
                {formatCurrency(reservedTotal, account.currency)}
              </span>
            </div>

            {reservedEntries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No reserved transactions.
              </p>
            ) : (
              <ul className="max-h-80 space-y-2 overflow-y-auto">
                {reservedEntries.map((e) => (
                  <li key={e.id} className="rounded-lg border border-border bg-secondary/40 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {e.counterparty || e.category || "Reserved transaction"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(e.date).toLocaleDateString("en-GB", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                          {e.category ? ` · ${e.category}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-amber-400">
                        {formatCurrency(e.amount, e.currency)}
                      </span>
                    </div>
                    {(e.comment || e.bank) && (
                      <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
                        {e.comment || "Held pending settlement"}
                        {e.bank ? ` · ${e.bank}` : ""}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] font-mono text-muted-foreground/70">
                      Ref {e.reference || e.id}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-[11px] text-muted-foreground text-pretty">
              Reserved funds stay in your account but cannot be spent until the underlying transaction
              completes. Once settled or cancelled, the hold is released back to your available balance.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
