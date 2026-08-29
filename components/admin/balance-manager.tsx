"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDownLeft, ArrowUpRight, Trash2, Wallet, Plus, Loader2, Pencil, Undo2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { toast } from "sonner"
import { useLedger, type LedgerDirection, type LedgerEntry, type LedgerStatus } from "@/lib/ledger-store"
import {
  getLedgerForUserAdmin,
  addLedgerEntryForUserAdmin,
  removeLedgerEntryForUserAdmin,
  updateLedgerEntryForUserAdmin,
  reverseLedgerEntryForUserAdmin,
  listRegisteredAccountsForUserAdmin,
  type RegisteredAccountOption,
} from "@/app/actions/ledger"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import { getActiveUserId } from "@/lib/user-scope"
import { useActivityLog } from "@/components/activity-tracker"
import { VerifiedBankField } from "@/components/verified-bank-field"
import type { BankInfo } from "@/lib/iban-swift"

/** Generate a unique receipt/reference id, matching the platform's style. */
function generateReceiptId(prefix = "ADM"): string {
  const n = Math.floor(1_000_000 + Math.random() * 9_000_000)
  return `${prefix}${n}`
}

const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "SGD"]

const todayISO = () => new Date().toISOString().slice(0, 10)

const fmt = (value: number, currency: string) =>
  `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

/** Compose a single-line bank address from resolved directory info. */
const formatBankAddress = (info: BankInfo): string => {
  const cityLine = [info.postalCode, info.city].filter(Boolean).join(" ")
  return [info.address, cityLine, info.country].filter(Boolean).join(", ")
}

export function BalanceManager() {
  const { refresh: refreshLiveLedger } = useLedger()
  const logActivity = useActivityLog()

  // CRITICAL: never default to a real account. If this started on a real user
  // (e.g. the first registry user), an admin who posted a payment without first
  // changing the dropdown would silently credit/debit THAT account — which is
  // exactly how payments were landing on the wrong client (mesa@ipostrad.com).
  // Start empty so a client must be explicitly chosen before anything can post.
  const [targetUserId, setTargetUserId] = useState("")
  // The full set of accounts the admin can manage: all active accounts in the
  // database, fetched once on mount.
  const [clients, setClients] = useState<SelectableClient[]>([])

  useEffect(() => {
    let active = true
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        if (active && list.length) setClients(list)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const [direction, setDirection] = useState<LedgerDirection>("credit")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [status, setStatus] = useState<LedgerStatus>("completed")
  const [date, setDate] = useState(todayISO())
  const [counterparty, setCounterparty] = useState("")
  const [account, setAccount] = useState("")
  // The client's OWN receiving account (registered external IBAN) this incoming
  // payment landed in, so it surfaces as a per-bank sub-balance for the client.
  const [receivedAccount, setReceivedAccount] = useState("")
  const [registeredAccounts, setRegisteredAccounts] = useState<RegisteredAccountOption[]>([])
  // Bank details — auto-resolved from the IBAN above, each manually overridable.
  const [swift, setSwift] = useState("")
  const [bankName, setBankName] = useState("")
  const [bankAddress, setBankAddress] = useState("")
  // The last values we auto-filled from an IBAN lookup. A field is only
  // overwritten by a new lookup when the admin hasn't manually edited it (i.e.
  // it still equals what we last auto-filled, or is empty), so manual overrides
  // always win.
  const autoFilledRef = useRef({ swift: "", bankName: "", bankAddress: "" })
  const [reference, setReference] = useState("")
  const [description, setDescription] = useState("")

  // The target client's ledger, loaded from Neon (passcode-verified).
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Edit-an-existing-entry dialog state.
  const [editEntry, setEditEntry] = useState<LedgerEntry | null>(null)
  const [editAmount, setEditAmount] = useState("")
  const [editStatus, setEditStatus] = useState<LedgerStatus>("completed")
  const [editCounterparty, setEditCounterparty] = useState("")
  const [editComment, setEditComment] = useState("")
  const [editBusy, setEditBusy] = useState(false)
  const [reversingId, setReversingId] = useState<string | null>(null)

  // A client is "selected" only when targetUserId matches a real account in the
  // list. When nothing is selected we use a neutral placeholder rather than
  // silently falling back to a real user — so no label, balance, or write can
  // ever be attributed to an account the admin did not explicitly choose.
  const selectedClient = clients.find((c) => c.id === targetUserId)
  const hasTarget = !!targetUserId && !!selectedClient
  const targetUser = selectedClient ?? { fullName: "No client selected", company: "—", email: "" }
  const isIncoming = direction === "credit"

  // Load the selected client's ledger from the server whenever the target
  // changes. The admin passcode is verified server-side.
  useEffect(() => {
    // Nothing to load until a real client is explicitly selected.
    if (!targetUserId) {
      setEntries([])
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    getLedgerForUserAdmin(ADMIN_PASSCODE, targetUserId)
      .then((res) => {
        if (!active) return
        if (!res.ok) {
          toast.error(res.error)
          setEntries([])
          return
        }
        setEntries(res.entries)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [targetUserId])

  // Load the client's registered (external) accounts so an incoming payment can
  // be attributed to the specific bank it arrived in. Reset any prior choice.
  useEffect(() => {
    setReceivedAccount("")
    if (!targetUserId) {
      setRegisteredAccounts([])
      return
    }
    let active = true
    listRegisteredAccountsForUserAdmin(ADMIN_PASSCODE, targetUserId).then((res) => {
      if (!active) return
      setRegisteredAccounts(res.ok ? res.accounts : [])
    })
    return () => {
      active = false
    }
  }, [targetUserId])

  const balances = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of entries) {
      if (e.status !== "completed") continue
      const cur = map.get(e.currency) ?? 0
      map.set(e.currency, cur + (e.direction === "credit" ? e.amount : -e.amount))
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [entries])

  // Auto-fill SWIFT/BIC, bank name and bank address from a resolved IBAN — but
  // never clobber a field the admin has manually overridden.
  const handleResolvedBank = (info: BankInfo | null) => {
    if (!info) return
    const resolvedSwift = info.bic ?? ""
    const resolvedName = info.name ?? ""
    const resolvedAddress = formatBankAddress(info)
    // Snapshot the previous auto-filled values BEFORE updating the ref, so the
    // functional setState comparisons use stable values (not the new ones).
    const prev = autoFilledRef.current
    if (resolvedSwift) setSwift((cur) => (cur === "" || cur === prev.swift ? resolvedSwift : cur))
    if (resolvedName) setBankName((cur) => (cur === "" || cur === prev.bankName ? resolvedName : cur))
    if (resolvedAddress)
      setBankAddress((cur) => (cur === "" || cur === prev.bankAddress ? resolvedAddress : cur))
    autoFilledRef.current = {
      swift: resolvedSwift || prev.swift,
      bankName: resolvedName || prev.bankName,
      bankAddress: resolvedAddress || prev.bankAddress,
    }
  }

  const resetForm = () => {
    setAmount("")
    setCounterparty("")
    setAccount("")
    setReceivedAccount("")
    setSwift("")
    setBankName("")
    setBankAddress("")
    autoFilledRef.current = { swift: "", bankName: "", bankAddress: "" }
    setReference("")
    setDescription("")
    setDate(todayISO())
    setStatus("completed")
  }

  // If the edited account is the one currently signed in, refresh its live view.
  const refreshLiveIfSelf = () => {
    if (getActiveUserId() === targetUserId) void refreshLiveLedger()
  }

  const handleSubmit = async () => {
    if (!hasTarget) {
      toast.error("Select the client account to post this payment to first.")
      return
    }
    const numeric = Number(amount)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error("Enter a valid amount greater than zero.")
      return
    }
    if (!counterparty.trim()) {
      toast.error(isIncoming ? "Enter the sender name." : "Enter the beneficiary name.")
      return
    }

    const id = reference.trim() || generateReceiptId(isIncoming ? "PPY" : "OUT")
    const isoDate = date ? new Date(`${date}T12:00:00`).toISOString() : new Date().toISOString()

    // Compose the resolved/overridden bank details into the single ledger
    // `bank` field (no schema change): "Name · SWIFT XXX · Address".
    const composedBank = [
      bankName.trim(),
      swift.trim() ? `SWIFT ${swift.trim().toUpperCase()}` : "",
      bankAddress.trim(),
    ]
      .filter(Boolean)
      .join(" · ")

    setSaving(true)
    const res = await addLedgerEntryForUserAdmin(ADMIN_PASSCODE, targetUserId, {
      id,
      direction,
      amount: numeric,
      currency,
      status,
      date: isoDate,
      counterparty: counterparty.trim(),
      account: account.trim() || undefined,
      bank: composedBank || undefined,
      // Attribute incoming funds to the client's chosen receiving bank so it
      // shows as a per-bank sub-balance; only meaningful for credits.
      receivedAccount: isIncoming && receivedAccount.trim() ? receivedAccount.trim() : undefined,
      reference: id,
      comment: description.trim() || undefined,
      category: isIncoming ? "Incoming Payment" : "Outgoing Payment",
    })
    setSaving(false)

    if (!res.ok) {
      toast.error(res.error)
      return
    }

    setEntries(res.entries)
    refreshLiveIfSelf()

    toast.success(isIncoming ? "Incoming payment credited" : "Outgoing payment debited", {
      description: `${fmt(numeric, currency)} ${isIncoming ? "credited to" : "debited from"} ${targetUser.fullName} (${targetUser.company}).`,
    })

    logActivity({
      action: `Administrator ${isIncoming ? "credited" : "debited"} ${fmt(numeric, currency)} ${isIncoming ? "to" : "from"} ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator manually registered an ${isIncoming ? "incoming" : "outgoing"} payment of ${fmt(numeric, currency)} ${isIncoming ? "to" : "from"} the account of ${targetUser.fullName} (${targetUser.company}). Status: ${status}. ${counterparty.trim() ? `${isIncoming ? "Sender" : "Beneficiary"}: ${counterparty.trim()}.` : ""}${description.trim() ? ` Reference: ${description.trim()}.` : ""}`,
        referenceId: id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        type: isIncoming ? "Incoming Payment" : "Outgoing Payment",
        amount: fmt(numeric, currency),
        counterparty: counterparty.trim() || "(none)",
        counterpartyAccount: account.trim() || "(none)",
        counterpartyBankName: bankName.trim() || "(none)",
        counterpartySwift: swift.trim().toUpperCase() || "(none)",
        counterpartyBankAddress: bankAddress.trim() || "(none)",
        status,
        valueDate: fmtDate(isoDate),
      },
    })

    resetForm()
  }

  const handleDelete = async (entryId: string) => {
    if (!hasTarget) return
    const res = await removeLedgerEntryForUserAdmin(ADMIN_PASSCODE, targetUserId, entryId)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setEntries(res.entries)
    refreshLiveIfSelf()
    toast.success("Entry removed", {
      description: `Transaction ${entryId} was removed from ${targetUser.fullName}'s ledger.`,
    })
    logActivity({
      action: `Administrator removed ledger entry ${entryId} from ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator removed transaction ${entryId} from the account of ${targetUser.fullName} (${targetUser.company}).`,
        referenceId: entryId,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: "Removed",
      },
    })
  }

  const openEdit = (e: LedgerEntry) => {
    setEditEntry(e)
    setEditAmount(String(e.amount))
    setEditStatus(e.status)
    setEditCounterparty(e.counterparty ?? "")
    setEditComment(e.comment ?? "")
  }

  const handleSaveEdit = async () => {
    if (!editEntry || !hasTarget) return
    const numeric = Number(editAmount)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error("Enter a valid amount greater than zero.")
      return
    }
    setEditBusy(true)
    const res = await updateLedgerEntryForUserAdmin(ADMIN_PASSCODE, targetUserId, {
      ...editEntry,
      amount: numeric,
      status: editStatus,
      counterparty: editCounterparty.trim(),
      comment: editComment.trim() || undefined,
    })
    setEditBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setEntries(res.entries)
    refreshLiveIfSelf()
    toast.success("Transaction updated", {
      description: `${editEntry.id} was updated on ${targetUser.fullName}'s ledger.`,
    })
    logActivity({
      action: `Administrator edited ledger entry ${editEntry.id} for ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator edited transaction ${editEntry.id} on the account of ${targetUser.fullName} (${targetUser.company}). New amount: ${fmt(numeric, editEntry.currency)}. Status: ${editStatus}.`,
        referenceId: editEntry.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        status: editStatus,
      },
    })
    setEditEntry(null)
  }

  const handleReverse = async (entryId: string) => {
    if (!hasTarget) return
    setReversingId(entryId)
    const res = await reverseLedgerEntryForUserAdmin(ADMIN_PASSCODE, targetUserId, entryId)
    setReversingId(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setEntries(res.entries)
    refreshLiveIfSelf()
    toast.success("Transaction reversed", {
      description: `A reversing entry for ${entryId} was posted to ${targetUser.fullName}'s ledger.`,
    })
    logActivity({
      action: `Administrator reversed ledger entry ${entryId} for ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator reversed transaction ${entryId} on the account of ${targetUser.fullName} (${targetUser.company}). A mirror entry was posted to net the balance.`,
        referenceId: entryId,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: "Reversed",
      },
    })
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Wallet className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold">Balance Management</CardTitle>
            <p className="text-sm text-muted-foreground text-pretty">
              Register an incoming or outgoing payment directly to any client account. Changes
              update the client&apos;s balance and transaction history immediately.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Target account */}
        <div className="space-y-2">
          <Label>Client account</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.fullName} — {u.company} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading ledger…
            </p>
          )}
        </div>

        {/* Current balances for the selected account */}
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Current balances — {targetUser.fullName}
          </p>
          {balances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No balances yet (empty ledger).</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {balances.map(([cur, val]) => (
                <Badge key={cur} variant="outline" className="text-sm font-semibold">
                  {fmt(val, cur)}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Direction */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setDirection("credit")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border p-3 text-sm font-medium transition-colors",
              isIncoming
                ? "border-green-500/50 bg-green-500/10 text-green-400"
                : "border-border bg-card text-muted-foreground hover:bg-secondary",
            )}
          >
            <ArrowDownLeft className="h-4 w-4" />
            Incoming (credit)
          </button>
          <button
            type="button"
            onClick={() => setDirection("debit")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border p-3 text-sm font-medium transition-colors",
              !isIncoming
                ? "border-red-500/50 bg-red-500/10 text-red-400"
                : "border-border bg-card text-muted-foreground hover:bg-secondary",
            )}
          >
            <ArrowUpRight className="h-4 w-4" />
            Outgoing (debit)
          </button>
        </div>

        {/* Amount + currency */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="bm-amount">Amount</Label>
            <MoneyInput
              id="bm-amount"
              placeholder="0.00"
              value={amount}
              onValueChange={setAmount}
            />
          </div>
          <div className="space-y-2">
            <Label>Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="w-full">
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

        {/* Status + date */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as LedgerStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="hold">On Hold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bm-date">Value date</Label>
            <Input
              id="bm-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        {/* Counterparty details */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bm-counterparty">{isIncoming ? "Sender name" : "Beneficiary name"}</Label>
            <Input
              id="bm-counterparty"
              placeholder={isIncoming ? "e.g. Luigi Forino" : "e.g. ACME Trading Ltd"}
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
            />
          </div>
          <VerifiedBankField
            id="bm-account"
            label={isIncoming ? "Sender IBAN / account" : "Beneficiary IBAN / account"}
            kind="iban"
            lenient
            value={account}
            onChange={setAccount}
            onResolved={handleResolvedBank}
            placeholder="e.g. DE77202208000056457149"
          />
        </div>

        {/* Received-into account — attributes an incoming payment to one of the
            client's registered banks so they see a per-bank sub-balance. Only
            relevant for credits and only when the client has registered banks. */}
        {isIncoming && registeredAccounts.length > 0 && (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
            <Label htmlFor="bm-received-account">Received into account</Label>
            <Select
              value={receivedAccount || "none"}
              onValueChange={(value) => {
                if (value === "none") {
                  setReceivedAccount("")
                  return
                }
                const acct = registeredAccounts.find((a) => a.iban === value)
                if (acct) {
                  setReceivedAccount(acct.iban)
                  setCurrency(acct.currency)
                }
              }}
            >
              <SelectTrigger id="bm-received-account">
                <SelectValue placeholder="Master Settlement Account (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Master Settlement Account (default)</SelectItem>
                {registeredAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.iban}>
                    {a.bankName} — {a.iban} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Optional. Attributes this payment to one of the client&apos;s registered banks so it shows as a per-bank
              balance. The funds still settle into the master {currency} balance.
            </p>
          </div>
        )}

        {/* Bank details — auto-resolved from the IBAN above, each overridable. */}
        <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Bank details{" "}
            <span className="font-normal">
              — auto-filled from the IBAN when recognised. Edit any field to override.
            </span>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bm-bank-name">Bank name</Label>
              <Input
                id="bm-bank-name"
                placeholder="e.g. Deutsche Bank AG"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bm-swift">SWIFT / BIC</Label>
              <Input
                id="bm-swift"
                className="font-mono uppercase"
                placeholder="e.g. DEUTDEFF"
                value={swift}
                onChange={(e) => setSwift(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bm-bank-address">Bank address</Label>
            <Input
              id="bm-bank-address"
              placeholder="Street, postal code city, country"
              value={bankAddress}
              onChange={(e) => setBankAddress(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="bm-reference">Reference / receipt no. (optional)</Label>
          <Input
            id="bm-reference"
            placeholder="Auto-generated if left blank"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bm-description">Description</Label>
          <Textarea
            id="bm-description"
            placeholder="e.g. Investment"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        <Button onClick={handleSubmit} disabled={saving || loading || !hasTarget} className="w-full sm:w-auto">
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          {isIncoming ? "Credit incoming payment" : "Debit outgoing payment"}
        </Button>
        {!hasTarget && (
          <p className="text-xs text-amber-500">
            Select a client account above before posting a payment. No account is selected by default
            to prevent funds being posted to the wrong client.
          </p>
        )}

        {/* Recent entries with delete */}
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium text-foreground">
            Recent transactions — {targetUser.fullName}
          </p>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions on record.</p>
          ) : (
            <div className="space-y-2">
              {entries.slice(0, 8).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        e.direction === "credit"
                          ? "bg-green-500/10 text-green-400"
                          : "bg-red-500/10 text-red-400",
                      )}
                    >
                      {e.direction === "credit" ? (
                        <ArrowDownLeft className="h-4 w-4" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {e.counterparty || e.category || e.id}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {e.id} · {fmtDate(e.date)} ·{" "}
                        {e.status === "completed" ? "Completed" : "On Hold"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <span
                      className={cn(
                        "whitespace-nowrap text-sm font-semibold",
                        e.direction === "credit" ? "text-green-400" : "text-red-400",
                      )}
                    >
                      {e.direction === "credit" ? "+" : "−"}
                      {fmt(e.amount, e.currency)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => openEdit(e)}
                      aria-label={`Edit transaction ${e.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-amber-500"
                      onClick={() => handleReverse(e.id)}
                      disabled={reversingId === e.id}
                      aria-label={`Reverse transaction ${e.id}`}
                    >
                      {reversingId === e.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Undo2 className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-400"
                      onClick={() => handleDelete(e.id)}
                      aria-label={`Remove transaction ${e.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      {/* Edit existing transaction dialog */}
      <Dialog open={!!editEntry} onOpenChange={(open) => !open && setEditEntry(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit transaction</DialogTitle>
            <DialogDescription>
              {editEntry ? `${editEntry.id} · ${targetUser.fullName}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-amount">Amount ({editEntry?.currency})</Label>
                <MoneyInput
                  id="edit-amount"
                  value={editAmount}
                  onValueChange={setEditAmount}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editStatus} onValueChange={(v) => setEditStatus(v as LedgerStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="hold">On Hold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-counterparty">Counterparty</Label>
              <Input
                id="edit-counterparty"
                value={editCounterparty}
                onChange={(ev) => setEditCounterparty(ev.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-comment">Description</Label>
              <Textarea
                id="edit-comment"
                rows={2}
                value={editComment}
                onChange={(ev) => setEditComment(ev.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditEntry(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={editBusy}>
              {editBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
