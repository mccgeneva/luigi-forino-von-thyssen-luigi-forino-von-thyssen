"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Landmark,
  Building2,
  Globe2,
  Layers,
  Check,
  X,
  ArrowDownToLine,
  Wallet,
  Plus,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useLedger } from "@/lib/ledger-store"
import { getActiveUserId } from "@/lib/user-scope"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { countrySupportsIban, generateIban, isValidIban, formatIban } from "@/lib/iban"
import {
  ACCOUNT_TYPES,
  PARTNER_BANKS,
  reconciledTotal,
  type GatewayAccount,
  type GatewayAccountType,
  type AccountCoordinates,
} from "@/lib/gateway-store"
import type { PartnerBank } from "@/lib/partner-banks"
import {
  getAllGatewayAccountsAdmin,
  approveGatewayAccountAdmin,
  rejectGatewayAccountAdmin,
  recordGatewayFundingAdmin,
} from "@/app/actions/gateway"
import { getPartnerBankDirectory } from "@/app/actions/gateway-banks"
import {
  allocateBankSlotAdmin,
  getBankAvailabilityForCurrency,
  type BankAvailability,
} from "@/app/actions/bank-inventory"

const typeIcons: Record<GatewayAccountType, typeof Building2> = {
  virtual_iban: Landmark,
  collection: Layers,
  multicurrency: Globe2,
}

function rand(len: number, alphabet = "0123456789") {
  let out = ""
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

// Generate bank coordinates for an approved account. IBAN jurisdictions get a
// structurally valid, MOD-97-checksummed IBAN seeded from the bank's BIC stem;
// non-IBAN jurisdictions (US ABA, SG local clearing) get domestic coordinates.
function generateCoordinates(bank: PartnerBank, holder: string): AccountCoordinates {
  const initials = holder
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase()
  const reference = `MCC-${initials || "CLT"}-${rand(6)}`

  if (countrySupportsIban(bank.countryCode)) {
    const iban = generateIban(bank.countryCode, bank.bic.slice(0, 4), bank.nationalBankCode)
    return {
      partnerBankKey: bank.key,
      partnerBankName: bank.name,
      scheme: "iban",
      iban,
      bic: bank.bic,
      // The domestic account number is the IBAN's trailing digits, for display.
      accountNumber: iban.slice(-8),
      reference,
    }
  }

  // Domestic (non-IBAN) jurisdictions: US uses a 9-digit ABA routing number;
  // others use a local bank/branch code. No IBAN is issued.
  const routingNumber = bank.countryCode === "US" ? rand(9) : rand(7)
  return {
    partnerBankKey: bank.key,
    partnerBankName: bank.name,
    scheme: "domestic",
    bic: bank.bic,
    accountNumber: rand(bank.countryCode === "US" ? 10 : 12),
    routingNumber,
    reference,
  }
}

const formatMoney = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const formatTimestamp = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

export function GatewayManager() {
  // The admin manager reads EVERY client's gateway accounts (passcode verified
  // server-side) and mutates them on the owning user, crediting that client's
  // Master Account on reconciliation — not the signed-in admin's own ledger.
  const { refresh: refreshLiveLedger } = useLedger()

  const [accounts, setAccounts] = useState<GatewayAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Live partner-bank directory (baseline + database-added banks) so the admin
  // can resolve and approve ANY bank a client picked, including DB-added ones.
  const [directory, setDirectory] = useState<PartnerBank[]>(PARTNER_BANKS)
  useEffect(() => {
    let active = true
    getPartnerBankDirectory().then((banks) => {
      if (active && banks.length) setDirectory(banks)
    })
    return () => {
      active = false
    }
  }, [])
  const resolveBank = (key: string | undefined) => directory.find((b) => b.key === key)

  useEffect(() => {
    let active = true
    setLoading(true)
    getAllGatewayAccountsAdmin(ADMIN_PASSCODE)
      .then((res) => {
        if (!active) return
        if (!res.ok) {
          toast.error(res.error)
          setAccounts([])
          return
        }
        setAccounts(res.accounts)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  // If a mutation touched the currently signed-in user, refresh their live ledger.
  const refreshLiveIfSelf = (userId: string) => {
    if (getActiveUserId() === userId) void refreshLiveLedger()
  }

  const pending = useMemo(() => accounts.filter((a) => a.status === "pending"), [accounts])
  const active = useMemo(() => accounts.filter((a) => a.status === "active"), [accounts])
  const decided = useMemo(
    () =>
      accounts
        .filter((a) => a.status === "rejected" || a.status === "active" || a.status === "closed")
        .sort((a, b) => new Date(b.decidedAt ?? 0).getTime() - new Date(a.decidedAt ?? 0).getTime()),
    [accounts],
  )

  // Approval dialog state
  const [approveTarget, setApproveTarget] = useState<GatewayAccount | null>(null)
  const [bankKey, setBankKey] = useState("")
  // Live per-bank slot availability for the approve dialog's currency, keyed by
  // bank key, so the picker reflects which correspondent pools have free slots.
  const [availability, setAvailability] = useState<Map<string, BankAvailability>>(new Map())

  const refreshAvailability = async (currency: string) => {
    try {
      const rows = await getBankAvailabilityForCurrency(currency)
      const map = new Map<string, BankAvailability>()
      for (const row of rows) map.set(row.bankKey, row)
      setAvailability(map)
    } catch {
      setAvailability(new Map())
    }
  }

  // Reject dialog state
  const [rejectTarget, setRejectTarget] = useState<GatewayAccount | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  // Funding dialog state
  const [fundingTarget, setFundingTarget] = useState<GatewayAccount | null>(null)
  const [payer, setPayer] = useState("")
  const [fundingRef, setFundingRef] = useState("")
  const [amount, setAmount] = useState("")

  const openApprove = (account: GatewayAccount) => {
    // Any bank can issue in any currency, so default to the client's preferred
    // bank as-is; only fall back if it is somehow missing from the directory.
    const preferred = account.preferredBankKey
    const usable = resolveBank(preferred) ? preferred : (directory[0]?.key ?? "")
    setBankKey(usable)
    setApproveTarget(account)
    void refreshAvailability(account.currency)
  }

  const confirmApprove = async () => {
    if (!approveTarget || !bankKey) return
    const selectedBank = resolveBank(bankKey)
    if (!selectedBank) {
      toast.error("Select a valid partner bank.")
      return
    }
    setBusy(true)
    // Reserve one account slot from the chosen bank's currency pool BEFORE we
    // issue any coordinates. This is the authoritative capacity gate: a
    // disabled or exhausted pool returns an error and nothing is issued.
    const allocation = await allocateBankSlotAdmin(ADMIN_PASSCODE, bankKey, approveTarget.currency)
    if (!allocation.ok) {
      setBusy(false)
      toast.error(allocation.error)
      void refreshAvailability(approveTarget.currency)
      return
    }
    const coordinates = generateCoordinates(selectedBank, approveTarget.accountHolder)
    // Final safety net: never persist an account with an invalid IBAN.
    if (coordinates.scheme === "iban" && !isValidIban(coordinates.iban ?? "")) {
      setBusy(false)
      toast.error("Generated IBAN failed validation. Please try again.")
      return
    }
    const res = await approveGatewayAccountAdmin(
      ADMIN_PASSCODE,
      approveTarget.userId,
      approveTarget.id,
      coordinates,
    )
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setAccounts(res.accounts)
    refreshLiveIfSelf(approveTarget.userId)
    toast.success("Account approved", {
      description: `${coordinates.partnerBankName} coordinates assigned to ${approveTarget.id} · ${allocation.remaining} ${approveTarget.currency} slot${allocation.remaining === 1 ? "" : "s"} left.`,
    })
    setApproveTarget(null)
    setBankKey("")
  }

  const confirmReject = async () => {
    if (!rejectTarget) return
    setBusy(true)
    const res = await rejectGatewayAccountAdmin(
      ADMIN_PASSCODE,
      rejectTarget.userId,
      rejectTarget.id,
      rejectReason.trim() || undefined,
    )
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setAccounts(res.accounts)
    toast.success("Request declined", { description: `${rejectTarget.id} was declined.` })
    setRejectTarget(null)
    setRejectReason("")
  }

  const openFunding = (account: GatewayAccount) => {
    setPayer("")
    setAmount("")
    setFundingRef(account.coordinates?.reference ?? "")
    setFundingTarget(account)
  }

  // Record an inbound funding event and reconcile it server-side: the client's
  // Master Account is credited in the shared ledger by the server action.
  const confirmFunding = async () => {
    if (!fundingTarget) return
    const value = Number.parseFloat(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a valid amount.")
      return
    }
    if (!payer.trim()) {
      toast.error("Enter the payer name.")
      return
    }
    setBusy(true)
    const res = await recordGatewayFundingAdmin(ADMIN_PASSCODE, fundingTarget.userId, fundingTarget.id, {
      amount: value,
      payer: payer.trim(),
      reference: fundingRef.trim() || undefined,
    })
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setAccounts(res.accounts)
    refreshLiveIfSelf(fundingTarget.userId)
    toast.success("Funds reconciled", {
      description: `${formatMoney(value, fundingTarget.currency)} credited to the Master Account.`,
    })
    setFundingTarget(null)
  }

  return (
    <>
      {/* Pending account requests */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg font-semibold">Pending Account Requests</CardTitle>
            {pending.length > 0 && (
              <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500">
                {pending.length}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Check className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {loading
                  ? "Loading gateway account requests…"
                  : "No pending account requests. All gateway applications have been reviewed."}
              </p>
            </div>
          ) : (
            pending.map((account) => {
              const Icon = typeIcons[account.type]
              return (
                <div
                  key={account.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {ACCOUNT_TYPES[account.type].label} · {account.currency}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {account.accountHolder}
                        {account.company ? ` · ${account.company}` : ""} · Ref {account.id}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Preferred bank:{" "}
                        <span className="font-medium text-foreground">
                          {resolveBank(account.preferredBankKey)?.name ?? "No preference"}
                        </span>
                      </p>
                      <p className="mt-1 max-w-xl text-xs text-muted-foreground text-pretty">
                        {account.purpose}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => openApprove(account)} disabled={busy}>
                      <Check className="mr-1 h-4 w-4" />
                      Approve & Assign
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setRejectReason("")
                        setRejectTarget(account)
                      }}
                    >
                      <X className="mr-1 h-4 w-4" />
                      Decline
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Active accounts — funding reconciliation */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg font-semibold">Funding & Reconciliation</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {active.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <ArrowDownToLine className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No active gateway accounts yet. Approve a request to enable funding.
              </p>
            </div>
          ) : (
            active.map((account) => {
              const bank = resolveBank(account.coordinates?.partnerBankKey)
              return (
                <div key={account.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {ACCOUNT_TYPES[account.type].label} · {account.currency} · {account.accountHolder}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {bank?.name} ·{" "}
                        {account.coordinates?.scheme === "iban" && account.coordinates.iban
                          ? formatIban(account.coordinates.iban)
                          : `Acct ${account.coordinates?.accountNumber ?? "—"}`}{" "}
                        · Ref {account.coordinates?.reference}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Reconciled to Master:{" "}
                        <span className="font-medium text-green-500">
                          {formatMoney(reconciledTotal(account), account.currency)}
                        </span>
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openFunding(account)} disabled={busy}>
                      <Plus className="mr-1 h-4 w-4" />
                      Record Funding
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* Decision history */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Gateway Decision History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {decided.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No decisions recorded yet.</p>
          ) : (
            decided.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {ACCOUNT_TYPES[account.type].label} · {account.currency} · {account.accountHolder}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    Ref {account.id} · {formatTimestamp(account.decidedAt)}
                  </p>
                </div>
                {account.status === "active" ? (
                  <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500">
                    Approved · {resolveBank(account.coordinates?.partnerBankKey)?.name}
                  </Badge>
                ) : account.status === "rejected" ? (
                  <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-400">
                    Declined
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    Closed
                  </Badge>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Approve dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve & Assign Partner Bank</DialogTitle>
            <DialogDescription>
              {approveTarget
                ? `Assign a correspondent bank for ${approveTarget.accountHolder}'s ${ACCOUNT_TYPES[approveTarget.type].label} (${approveTarget.currency}). Coordinates are generated on approval.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Partner bank</Label>
            <Select value={bankKey} onValueChange={setBankKey}>
              <SelectTrigger>
                <SelectValue placeholder="Select a partner bank" />
              </SelectTrigger>
              <SelectContent>
                {[...directory]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((bank) => {
                    const preferred = approveTarget?.preferredBankKey === bank.key
                    const avail = availability.get(bank.key)
                    const exhausted = !!avail && (!avail.enabled || avail.remaining <= 0)
                    return (
                      <SelectItem key={bank.key} value={bank.key} disabled={exhausted}>
                        {bank.name} ({bank.country})
                        {preferred ? " · client preference" : ""}
                        {avail
                          ? !avail.enabled
                            ? " · pool disabled"
                            : ` · ${avail.remaining} slot${avail.remaining === 1 ? "" : "s"} left`
                          : ""}
                      </SelectItem>
                    )
                  })}
              </SelectContent>
            </Select>
            {approveTarget && (
              <p className="text-xs text-muted-foreground">
                {resolveBank(approveTarget.preferredBankKey) ? (
                  <>
                    Client requested{" "}
                    <span className="font-medium text-foreground">
                      {resolveBank(approveTarget.preferredBankKey)?.name}
                    </span>
                    .{" "}
                  </>
                ) : null}
                {countrySupportsIban(resolveBank(bankKey)?.countryCode)
                  ? "A valid IBAN will be generated for this jurisdiction."
                  : "Domestic coordinates (no IBAN) will be issued for this jurisdiction."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmApprove}
              disabled={
                !bankKey ||
                busy ||
                (() => {
                  const a = availability.get(bankKey)
                  return !!a && (!a.enabled || a.remaining <= 0)
                })()
              }
            >
              Approve & Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline Account Request</DialogTitle>
            <DialogDescription>
              {rejectTarget ? `Decline ${rejectTarget.id}. The client will see the reason below.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="gw-reject-reason">Reason (optional)</Label>
            <Textarea
              id="gw-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="e.g. Additional KYC documentation required before a collection account can be opened."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmReject} disabled={busy}>
              Decline Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Funding dialog */}
      <Dialog open={!!fundingTarget} onOpenChange={(o) => !o && setFundingTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Inbound Funding</DialogTitle>
            <DialogDescription>
              {fundingTarget
                ? `Record funds received at ${resolveBank(fundingTarget.coordinates?.partnerBankKey)?.name} against ${fundingTarget.id}. The amount is reconciled into ${fundingTarget.accountHolder}'s Master Account.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="gw-payer">Payer</Label>
              <Input
                id="gw-payer"
                value={payer}
                onChange={(e) => setPayer(e.target.value)}
                placeholder="Originating counterparty"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gw-amount">Amount ({fundingTarget?.currency})</Label>
              <MoneyInput
                id="gw-amount"
                value={amount}
                onValueChange={setAmount}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gw-funding-ref">Remittance reference</Label>
              <Input
                id="gw-funding-ref"
                value={fundingRef}
                onChange={(e) => setFundingRef(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFundingTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmFunding} disabled={busy}>Record & Reconcile</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
