"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Building2, Plus, Search, Copy, Check, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useActivityLog } from "@/components/activity-tracker"
import { useCurrentUser } from "@/lib/use-current-user"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { CountryCombobox } from "@/components/country-combobox"
import { getCountryByCode } from "@/lib/countries"
import { validateIban, validateBic, isGenericBankInfo, type BankInfo } from "@/lib/iban-swift"
import { mirrorSubmission } from "@/lib/approval-sync"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  useBankAccounts,
  formatCurrency,
  formatCompactCurrency,
  getRatingColor,
  getStatusColor,
  getFlagEmoji,
} from "@/lib/bank-accounts"

export default function BankAccountsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [currencyFilter, setCurrencyFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [countryFilter, setCountryFilter] = useState("all")
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newIban, setNewIban] = useState("")
  const [newSwift, setNewSwift] = useState("")
  const [newCountry, setNewCountry] = useState("")
  const [newBankName, setNewBankName] = useState("")
  const [newAccountName, setNewAccountName] = useState("")
  const [newAccountType, setNewAccountType] = useState("")
  const [newCurrency, setNewCurrency] = useState("")
  const [newAccountNumber, setNewAccountNumber] = useState("")
  const [newDailyLimit, setNewDailyLimit] = useState("")
  const [newRating, setNewRating] = useState("")
  const [newBranchAddress, setNewBranchAddress] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // Tracks the values we last auto-filled from an IBAN lookup so a fresh lookup
  // never clobbers something the user typed manually (manual edits always win).
  const autoFilledRef = useRef({ bankName: "", swift: "", country: "" })
  const [addError, setAddError] = useState<string | null>(null)
  const logActivity = useActivityLog()
  const user = useCurrentUser()

  // Full account list with live ledger balances overlaid (shared with the
  // per-account detail page so both surfaces render identical data).
  const bankAccounts = useBankAccounts()
  const router = useRouter()

  // Auto-fill Bank Name, SWIFT/BIC and Country from the resolved IBAN. Country
  // always fills (we know it from the IBAN); Bank Name/SWIFT fill only when a
  // real institution resolved (not the generic structural fallback). Each field
  // is only overwritten when empty or still equal to what we last auto-filled,
  // so manual edits are preserved.
  const handleResolvedBank = (info: BankInfo | null) => {
    if (!info) return
    const prev = autoFilledRef.current
    const next = { ...prev }

    if (info.countryCode) {
      setNewCountry((cur) => (cur === "" || cur === prev.country ? info.countryCode : cur))
      next.country = info.countryCode
    }
    if (!isGenericBankInfo(info)) {
      if (info.name) {
        setNewBankName((cur) => (cur === "" || cur === prev.bankName ? info.name : cur))
        next.bankName = info.name
      }
      if (info.bic) {
        setNewSwift((cur) => (cur === "" || cur === prev.swift ? info.bic! : cur))
        next.swift = info.bic
      }
    }
    autoFilledRef.current = next
  }

  const handleAddAccount = async () => {
    if (submitting) return
    if (!newBankName.trim()) {
      setAddError("Bank Name is required.")
      return
    }
    // IBAN is optional: many countries (China, US, Canada, Japan, etc.) do not
    // use IBANs and settle via SWIFT/BIC + a domestic account number. Only
    // validate the IBAN when one was actually entered; otherwise require an
    // account number so the account still has a usable beneficiary identifier.
    const hasIban = newIban.trim().length > 0
    if (hasIban) {
      const ibanCheck = validateIban(newIban)
      if (!ibanCheck.valid) {
        setAddError(`IBAN: ${ibanCheck.error}`)
        return
      }
    } else if (!newAccountNumber.trim()) {
      setAddError("Enter an IBAN, or an Account Number for banks that do not use IBAN.")
      return
    }
    const bicCheck = validateBic(newSwift)
    if (!bicCheck.valid) {
      setAddError(`SWIFT/BIC: ${bicCheck.error}`)
      return
    }
    setAddError(null)

    const countryName = newCountry ? getCountryByCode(newCountry)?.name ?? newCountry : "Not specified"
    const dailyLimitNum = newDailyLimit ? Number(newDailyLimit.replace(/[^0-9.]/g, "")) : null
    // Everything the administrator needs to review and activate the account.
    const payload = {
      bankName: newBankName.trim(),
      accountName: newAccountName.trim() || null,
      accountType: newAccountType || null,
      country: countryName,
      countryCode: newCountry || null,
      iban: newIban.trim() || null,
      swift: newSwift.trim().toUpperCase(),
      currency: newCurrency || null,
      accountNumber: newAccountNumber.trim() || null,
      dailyLimit: dailyLimitNum,
      rating: newRating || null,
      branchAddress: newBranchAddress.trim() || null,
    }
    // Use whichever beneficiary identifier the account actually has.
    const beneficiaryRef = newIban.trim()
      ? `IBAN ${newIban.trim()}`
      : `Account No. ${newAccountNumber.trim()}`
    const summary = `Register ${newBankName.trim()}${
      newCurrency ? ` (${newCurrency})` : ""
    } — ${beneficiaryRef}, SWIFT ${newSwift.trim().toUpperCase()}, ${countryName}.`

    setSubmitting(true)

    // Audit log (attributed to the signed-in client).
    logActivity({
      action: "Submitted a new bank account registration",
      category: "Bank Accounts",
      details: {
        summary: "Client submitted a request to register a new bank account on the platform.",
        bank: newBankName.trim(),
        country: countryName,
        iban: newIban.trim() || "—",
        accountNumber: newAccountNumber.trim() || "—",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })

    // Persist to the cross-client approvals backbone so the administrator can
    // see and decide on it from the Pending Approvals queue (DB-backed, not
    // per-browser). Without this the request was never recorded anywhere the
    // admin could act on.
    const approvalId = await mirrorSubmission({
      kind: "bank_account",
      title: `${newBankName.trim()}${newAccountName.trim() ? ` · ${newAccountName.trim()}` : ""}`,
      summary,
      amount: dailyLimitNum,
      currency: newCurrency || null,
      payload,
    })

    setSubmitting(false)

    if (!approvalId) {
      setAddError(
        "We couldn't submit your account for review right now. Please try again in a moment.",
      )
      return
    }

    setIsAddDialogOpen(false)
    setNewIban("")
    setNewSwift("")
    setNewCountry("")
    setNewBankName("")
    setNewAccountName("")
    setNewAccountType("")
    setNewCurrency("")
    setNewAccountNumber("")
    setNewDailyLimit("")
    setNewRating("")
    setNewBranchAddress("")
    autoFilledRef.current = { bankName: "", swift: "", country: "" }
    toast.success("Account submitted for review", {
      description: "Our onboarding team will verify and activate the account.",
    })
  }

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const filteredAccounts = bankAccounts.filter((account) => {
    const matchesSearch =
      account.bankName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.accountName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.iban.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.swift.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesCurrency = currencyFilter === "all" || account.currency === currencyFilter
    const matchesStatus = statusFilter === "all" || account.status === statusFilter
    const matchesCountry = countryFilter === "all" || account.countryCode === countryFilter
    return matchesSearch && matchesCurrency && matchesStatus && matchesCountry
  })

  // Calculate totals by currency
  const totalsByCurrency = bankAccounts.reduce((acc, account) => {
    if (!acc[account.currency]) {
      acc[account.currency] = { total: 0, available: 0, reserved: 0, count: 0 }
    }
    acc[account.currency].total += account.balance
    acc[account.currency].available += account.availableBalance
    acc[account.currency].reserved += account.reservedBalance
    acc[account.currency].count += 1
    return acc
  }, {} as Record<string, { total: number; available: number; reserved: number; count: number }>)

  // Drop empty/undefined values: a Radix <SelectItem/> must never have an empty
  // string value (it throws), and an account may carry a sparse currency/country.
  const uniqueCurrencies = [...new Set(bankAccounts.map((a) => a.currency))].filter(Boolean)
  const uniqueCountries = [...new Set(bankAccounts.map((a) => a.countryCode))].filter(Boolean)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bank Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {user.company} — business account management
          </p>
        </div>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 bg-amber-500 hover:bg-amber-600 text-zinc-900">
              <Plus className="h-4 w-4" />
              Add Bank Account
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl bg-zinc-900 border-zinc-800">
            <DialogHeader>
              <DialogTitle className="text-foreground">Add New Bank Account</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Register a new bank account to the platform
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-zinc-300">Bank Name</Label>
                  <Input
                    placeholder="e.g., UBS AG"
                    className="bg-zinc-800 border-zinc-700"
                    value={newBankName}
                    onChange={(e) => setNewBankName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-zinc-300" htmlFor="new-account-country">
                    Country
                  </Label>
                  <CountryCombobox
                    id="new-account-country"
                    value={newCountry}
                    onChange={setNewCountry}
                    placeholder="Search and select country"
                    triggerClassName="bg-zinc-800 border-zinc-700 text-zinc-100 hover:bg-zinc-800 hover:text-zinc-100"
                    contentClassName="bg-zinc-900 border-zinc-800"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-zinc-300">Account Name</Label>
                  <Input
                    placeholder="e.g., MCC Primary Operations"
                    className="bg-zinc-800 border-zinc-700"
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-zinc-300">Account Type</Label>
                  <Select value={newAccountType} onValueChange={setNewAccountType}>
                    <SelectTrigger className="bg-zinc-800 border-zinc-700">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-800 border-zinc-700">
                      <SelectItem value="corporate">Corporate Current</SelectItem>
                      <SelectItem value="treasury">Treasury Account</SelectItem>
                      <SelectItem value="trading">Trading Account</SelectItem>
                      <SelectItem value="escrow">Escrow Account</SelectItem>
                      <SelectItem value="trade-finance">Trade Finance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <VerifiedBankField
                  id="new-account-iban"
                  label="IBAN (optional)"
                  kind="iban"
                  placeholder="Leave blank if bank has no IBAN"
                  value={newIban}
                  onChange={setNewIban}
                  onResolved={handleResolvedBank}
                  inputClassName="bg-zinc-800 border-zinc-700"
                />
                <VerifiedBankField
                  id="new-account-swift"
                  label="SWIFT/BIC"
                  kind="bic"
                  maxLength={11}
                  placeholder="e.g., UBSWCHZH80A"
                  value={newSwift}
                  onChange={setNewSwift}
                  inputClassName="bg-zinc-800 border-zinc-700"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-zinc-300">Currency</Label>
                  <Select value={newCurrency} onValueChange={setNewCurrency}>
                    <SelectTrigger className="bg-zinc-800 border-zinc-700">
                      <SelectValue placeholder="Select currency" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-800 border-zinc-700">
                      <SelectItem value="CHF">CHF - Swiss Franc</SelectItem>
                      <SelectItem value="EUR">EUR - Euro</SelectItem>
                      <SelectItem value="USD">USD - US Dollar</SelectItem>
                      <SelectItem value="GBP">GBP - British Pound</SelectItem>
                      <SelectItem value="SGD">SGD - Singapore Dollar</SelectItem>
                      <SelectItem value="JPY">JPY - Japanese Yen</SelectItem>
                      <SelectItem value="AUD">AUD - Australian Dollar</SelectItem>
                      <SelectItem value="HKD">HKD - Hong Kong Dollar</SelectItem>
                      <SelectItem value="AED">AED - UAE Dirham</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-zinc-300">Account Number</Label>
                  <Input
                    placeholder="Account number"
                    className="bg-zinc-800 border-zinc-700"
                    value={newAccountNumber}
                    onChange={(e) => setNewAccountNumber(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-zinc-300">Daily Limit</Label>
                  <Input
                    type="number"
                    placeholder="50000000"
                    className="bg-zinc-800 border-zinc-700"
                    value={newDailyLimit}
                    onChange={(e) => setNewDailyLimit(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-zinc-300">Bank Rating</Label>
                  <Select value={newRating} onValueChange={setNewRating}>
                    <SelectTrigger className="bg-zinc-800 border-zinc-700">
                      <SelectValue placeholder="Select rating" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-800 border-zinc-700">
                      <SelectItem value="AAA">AAA</SelectItem>
                      <SelectItem value="AA+">AA+</SelectItem>
                      <SelectItem value="AA">AA</SelectItem>
                      <SelectItem value="AA-">AA-</SelectItem>
                      <SelectItem value="A+">A+</SelectItem>
                      <SelectItem value="A">A</SelectItem>
                      <SelectItem value="A-">A-</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">Branch Address</Label>
                <Textarea
                  placeholder="Full branch address"
                  className="bg-zinc-800 border-zinc-700"
                  value={newBranchAddress}
                  onChange={(e) => setNewBranchAddress(e.target.value)}
                />
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <Shield className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
                <p className="text-xs text-amber-300/90 leading-relaxed">
                  Clients do not contact partner banks directly. All communication for this
                  account is handled by MCC Client Services and routed through{" "}
                  <span className="font-medium">admin@mccgva.ch</span>.
                </p>
              </div>
            </div>
            {addError && (
              <p className="text-sm text-destructive" role="alert">
                {addError}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(false)} className="border-zinc-700">
                Cancel
              </Button>
              <Button
                className="bg-amber-500 hover:bg-amber-600 text-zinc-900"
                onClick={handleAddAccount}
                disabled={submitting}
              >
                {submitting ? "Submitting…" : "Add Account"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary Cards by Currency */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Object.entries(totalsByCurrency)
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, 5)
          .map(([currency, data]) => (
            <Card key={currency} className="bg-zinc-900/50 border-zinc-800">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-muted-foreground">{currency}</span>
                  <Badge variant="outline" className="text-[10px] border-zinc-700">
                    {data.count} accounts
                  </Badge>
                </div>
                <p className="text-sm sm:text-base lg:text-lg font-bold text-foreground tabular-nums leading-tight break-words [overflow-wrap:anywhere]">
                  {formatCurrency(data.total, currency)}
                </p>
                <p className="text-xs text-emerald-400 mt-1 tabular-nums break-words [overflow-wrap:anywhere]">
                  {formatCurrency(data.available, currency)} available
                </p>
              </CardContent>
            </Card>
          ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by bank, account, IBAN, or SWIFT..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-zinc-900/50 border-zinc-800"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
            <SelectTrigger className="w-[120px] bg-zinc-900/50 border-zinc-800">
              <SelectValue placeholder="Currency" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800">
              <SelectItem value="all">All Currencies</SelectItem>
              {uniqueCurrencies.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={countryFilter} onValueChange={setCountryFilter}>
            <SelectTrigger className="w-[120px] bg-zinc-900/50 border-zinc-800">
              <SelectValue placeholder="Country" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800">
              <SelectItem value="all">All Countries</SelectItem>
              {uniqueCountries.map((country) => (
                <SelectItem key={country} value={country}>
                  {getFlagEmoji(country)} {country}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[120px] bg-zinc-900/50 border-zinc-800">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800">
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending Review</SelectItem>
              <SelectItem value="restricted">Restricted</SelectItem>
              <SelectItem value="dormant">Dormant</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Account Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredAccounts.map((account) => (
          <Card
            key={account.id}
            className="bg-zinc-900/50 border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer"
            onClick={() => router.push(`/dashboard/accounts/${encodeURIComponent(account.id)}`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-xs font-bold text-amber-400">
                    {account.bankLogo}
                  </div>
                  <div>
                    <CardTitle className="text-sm font-medium text-foreground">
                      {account.bankName}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {getFlagEmoji(account.countryCode)} {account.country}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={getRatingColor(account.rating)}>
                    {account.rating}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{account.accountName}</p>
                <p className="text-xs text-muted-foreground">{account.accountType}</p>
              </div>

              {account.id.startsWith("ACC-") ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Balance</span>
                    <span className="text-sm font-semibold text-foreground tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                      {formatCurrency(account.balance, account.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Available</span>
                    <span className="text-sm text-emerald-400 tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                      {formatCurrency(account.availableBalance, account.currency)}
                    </span>
                  </div>
                  {account.reservedBalance > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">Reserved</span>
                      <span className="text-sm text-amber-400 tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                        {formatCurrency(account.reservedBalance, account.currency)}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Received at this account</span>
                    <span className="text-sm font-semibold text-foreground tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                      {formatCurrency(account.trackedBalance ?? 0, account.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Available</span>
                    <span className="text-sm text-emerald-400 tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                      {formatCurrency(account.trackedAvailable ?? 0, account.currency)}
                    </span>
                  </div>
                  {(account.trackedReserved ?? 0) > 0 && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">Reserved</span>
                      <span className="text-sm text-amber-400 tabular-nums text-right min-w-0 [overflow-wrap:anywhere]">
                        {formatCurrency(account.trackedReserved ?? 0, account.currency)}
                      </span>
                    </div>
                  )}
                  <p className="text-[11px] leading-relaxed text-muted-foreground pt-1">
                    Registered external account. Funds received here also settle into your{" "}
                    <span className="font-medium text-foreground">{account.currency} Settlement Account</span>.
                  </p>
                </div>
              )}

              <div className="pt-2 border-t border-zinc-800 space-y-2">
                {(() => {
                  // Show the IBAN when present, otherwise fall back to the
                  // domestic Account Number (banks in China, US, etc. have no IBAN).
                  const hasIban = account.iban && account.iban !== "—"
                  const label = hasIban ? "IBAN" : "Account No."
                  const value = hasIban ? account.iban : account.accountNumber
                  const fieldKey = `ident-${account.id}`
                  return (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-mono text-zinc-400 truncate max-w-[140px]">
                          {value}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => {
                            e.stopPropagation()
                            copyToClipboard(value, fieldKey)
                          }}
                        >
                          {copiedField === fieldKey ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )
                })()}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">SWIFT</span>
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-mono text-zinc-400">{account.swift}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => {
                        e.stopPropagation()
                        copyToClipboard(account.swift, `swift-${account.id}`)
                      }}
                    >
                      {copiedField === `swift-${account.id}` ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <Badge variant="outline" className={getStatusColor(account.status)}>
                  {account.status}
                </Badge>
                <span
                  className="text-[10px] text-muted-foreground whitespace-nowrap"
                  title={
                    account.dailyLimitUnlimited
                      ? "Unlimited"
                      : formatCurrency(account.dailyLimit, account.currency)
                  }
                >
                  Daily Limit:{" "}
                  {account.dailyLimitUnlimited
                    ? "Unlimited"
                    : formatCompactCurrency(account.dailyLimit, account.currency)}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Empty State */}
      {filteredAccounts.length === 0 && (
        <Card className="bg-zinc-900/50 border-zinc-800">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium text-foreground mb-2">No accounts found</p>
            <p className="text-sm text-muted-foreground mb-4">
              Try adjusting your search or filter criteria
            </p>
            <Button
              variant="outline"
              className="border-zinc-700"
              onClick={() => {
                setSearchQuery("")
                setCurrencyFilter("all")
                setStatusFilter("all")
                setCountryFilter("all")
              }}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
