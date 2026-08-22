"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  Layers,
  Plus,
  ArrowLeftRight,
  Landmark,
  Clock,
  CheckCircle2,
  XCircle,
  Wallet,
  Copy,
  Check,
  User,
  Pencil,
  UploadCloud,
  ShieldCheck,
  ShieldAlert,
  FileText,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { upload } from "@vercel/blob/client"
import { useLedger } from "@/lib/ledger-store"
import { GATEWAY_CURRENCIES } from "@/lib/gateway-catalog"
import {
  listMySubAccounts,
  requestSubAccount,
  transferToSubAccount,
  updateMySubAccountBeneficiary,
} from "@/app/actions/sub-accounts"
import { MAIN_ACCOUNT_ID, SUB_ACCOUNT_STATUS_LABEL, type SubAccount, type SubAccountDoc } from "@/lib/sub-account-types"
import {
  SUB_ACCOUNT_SERVICE_FEE,
  SUB_ACCOUNT_ANNUAL_FEE,
  SUB_ACCOUNT_CLOSING_FEE,
  formatSubAccountFee,
} from "@/lib/sub-account-fees"

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

const STATUS_STYLE: Record<SubAccount["status"], string> = {
  pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  closed: "bg-muted text-muted-foreground border-border",
}

const STATUS_ICON: Record<SubAccount["status"], typeof Clock> = {
  pending: Clock,
  active: CheckCircle2,
  rejected: XCircle,
  closed: XCircle,
}

export default function SubAccountsPage() {
  const { balanceFor, subAccountBalanceFor, refresh, hydrated } = useLedger()
  const [subs, setSubs] = useState<SubAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [purpose, setPurpose] = useState("")
  const [beneficiaryName, setBeneficiaryName] = useState("")
  const [beneficiaryDetails, setBeneficiaryDetails] = useState("")
  const [creating, setCreating] = useState(false)
  // UBO identity documents (passport + KYC). Both present ⇒ declared; otherwise
  // the sub-account is an alias requiring the legal-responsibility acknowledgment.
  const [passportDoc, setPassportDoc] = useState<SubAccountDoc | null>(null)
  const [kycDoc, setKycDoc] = useState<SubAccountDoc | null>(null)
  const [uploading, setUploading] = useState<null | "passport" | "kyc">(null)
  const [aliasAccepted, setAliasAccepted] = useState(false)

  // Edit-beneficiary dialog
  const [benOpen, setBenOpen] = useState(false)
  const [benTarget, setBenTarget] = useState<SubAccount | null>(null)
  const [benName, setBenName] = useState("")
  const [benDetails, setBenDetails] = useState("")
  const [benSaving, setBenSaving] = useState(false)

  // Transfer dialog
  const [transferOpen, setTransferOpen] = useState(false)
  const [fromId, setFromId] = useState(MAIN_ACCOUNT_ID)
  const [toId, setToId] = useState("")
  const [transferAmount, setTransferAmount] = useState("")
  const [transferNote, setTransferNote] = useState("")
  const [transferCurrency, setTransferCurrency] = useState("EUR")
  const [transferring, setTransferring] = useState(false)

  const loadSubs = async () => {
    const rows = await listMySubAccounts()
    setSubs(rows)
    setLoading(false)
  }

  useEffect(() => {
    void loadSubs()
  }, [])

  const activeSubs = useMemo(() => subs.filter((s) => s.status === "active"), [subs])

  // Compartments available as transfer endpoints for the chosen currency: Main +
  // every active sub-account in that currency.
  const transferLegs = useMemo(() => {
    const legs: { id: string; label: string; balance: number }[] = [
      { id: MAIN_ACCOUNT_ID, label: "Main account", balance: balanceFor(transferCurrency) },
    ]
    for (const s of activeSubs) {
      if (s.currency === transferCurrency) {
        legs.push({ id: s.id, label: s.label, balance: subAccountBalanceFor(s.id, transferCurrency) })
      }
    }
    return legs
  }, [activeSubs, transferCurrency, balanceFor, subAccountBalanceFor])

  const fromBalance = useMemo(() => {
    const leg = transferLegs.find((l) => l.id === fromId)
    return leg ? leg.balance : 0
  }, [transferLegs, fromId])

  const amountNum = Number.parseFloat(transferAmount)
  const transferInvalid =
    !transferAmount ||
    Number.isNaN(amountNum) ||
    amountNum <= 0 ||
    fromId === toId ||
    !toId ||
    amountNum > fromBalance + 0.001

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
  }

  // Both identity documents present ⇒ the UBO is declared (no alias liability).
  const isDeclared = !!passportDoc && !!kycDoc
  // When not declared, the holder must accept legal responsibility for the alias.
  const createBlocked =
    label.trim().length < 2 || creating || uploading !== null || (!isDeclared && !aliasAccepted)

  const handleUpload = async (kind: "passport" | "kyc", file: File | undefined) => {
    if (!file) return
    setUploading(kind)
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
      const result = await upload(`sub-accounts/${kind}/${Date.now()}-${safe}`, file, {
        access: "public",
        handleUploadUrl: "/api/sub-accounts/blob-upload",
      })
      const doc: SubAccountDoc = {
        kind,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        pathname: result.pathname,
        url: result.url,
        contentType: file.type || "application/octet-stream",
        size: file.size,
      }
      if (kind === "passport") setPassportDoc(doc)
      else setKycDoc(doc)
    } catch {
      toast.error("Upload failed", { description: `Could not upload "${file.name}". Please try again.` })
    } finally {
      setUploading(null)
    }
  }

  const resetCreateForm = () => {
    setLabel("")
    setPurpose("")
    setCurrency("EUR")
    setBeneficiaryName("")
    setBeneficiaryDetails("")
    setPassportDoc(null)
    setKycDoc(null)
    setAliasAccepted(false)
  }

  const handleCreate = async () => {
    setCreating(true)
    const kycDocuments = [passportDoc, kycDoc].filter(Boolean) as SubAccountDoc[]
    const res = await requestSubAccount({
      label,
      currency,
      purpose,
      beneficiaryName,
      beneficiaryDetails,
      kycDocuments,
      legalResponsibilityAccepted: !isDeclared ? aliasAccepted : undefined,
    })
    setCreating(false)
    if (!res.ok) {
      toast.error("Could not open sub-account", { description: res.error })
      return
    }
    toast.success("Sub-account requested", {
      description: isDeclared
        ? "UBO declared. An administrator will assign its IBAN and activate it shortly."
        : "Alias sub-account requested. An administrator will assign its IBAN shortly.",
    })
    setCreateOpen(false)
    resetCreateForm()
    await loadSubs()
  }

  const openBeneficiary = (sub: SubAccount) => {
    setBenTarget(sub)
    setBenName(sub.beneficiaryName || "")
    setBenDetails(sub.beneficiaryDetails || "")
    setBenOpen(true)
  }

  const handleSaveBeneficiary = async () => {
    if (!benTarget) return
    setBenSaving(true)
    const res = await updateMySubAccountBeneficiary({
      id: benTarget.id,
      beneficiaryName: benName,
      beneficiaryDetails: benDetails,
    })
    setBenSaving(false)
    if (!res.ok) {
      toast.error("Could not update beneficiary", { description: res.error })
      return
    }
    toast.success("Beneficiary updated")
    setBenOpen(false)
    setBenTarget(null)
    await loadSubs()
  }

  const openTransfer = (currencyHint?: string, toHint?: string) => {
    const cur = currencyHint || "EUR"
    setTransferCurrency(cur)
    setFromId(MAIN_ACCOUNT_ID)
    setToId(toHint || "")
    setTransferAmount("")
    setTransferNote("")
    setTransferOpen(true)
  }

  const handleTransfer = async () => {
    setTransferring(true)
    const res = await transferToSubAccount({
      fromId,
      toId,
      amount: amountNum,
      currency: transferCurrency,
      note: transferNote,
    })
    setTransferring(false)
    if (!res.ok) {
      toast.error("Transfer failed", { description: res.error })
      return
    }
    toast.success("Transfer completed", { description: `Reference ${res.data.reference}` })
    setTransferOpen(false)
    refresh()
    await loadSubs()
  }

  // Currencies the user can transfer in: any active sub-account currency (Main
  // holds every currency, so we key the picker off the sub-accounts that exist).
  const transferCurrencies = useMemo(() => {
    const set = new Set<string>(["EUR"])
    for (const s of activeSubs) set.add(s.currency)
    return Array.from(set)
  }, [activeSubs])

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Layers className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">Sub-Accounts</h1>
            <p className="mt-1 max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground">
              Open isolated money compartments under your own account. Each keeps its own balance and
              its own IBAN, and you move funds in and out instantly from your main balance.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            className="gap-2"
            disabled={activeSubs.length === 0}
            onClick={() => openTransfer(activeSubs[0]?.currency, activeSubs[0]?.id)}
          >
            <ArrowLeftRight className="h-4 w-4" />
            Transfer
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                New sub-account
              </Button>
            </DialogTrigger>
            <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Open a sub-account</DialogTitle>
                <DialogDescription>
                  Give it a name and currency. An administrator assigns its IBAN/BIC and activates it,
                  then you can move funds into it.
                </DialogDescription>
              </DialogHeader>
              <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto py-1 pr-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sub-label">Account name</Label>
                  <Input
                    id="sub-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Operations, Escrow — Project A"
                    maxLength={60}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sub-currency">Currency</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger id="sub-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GATEWAY_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sub-purpose">Purpose (optional)</Label>
                  <Textarea
                    id="sub-purpose"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="What this compartment is for"
                    rows={2}
                    maxLength={280}
                  />
                </div>
                <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <Label htmlFor="sub-beneficiary" className="flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    Beneficiary (optional)
                  </Label>
                  <Input
                    id="sub-beneficiary"
                    value={beneficiaryName}
                    onChange={(e) => setBeneficiaryName(e.target.value)}
                    placeholder="Who this account is held for, e.g. Project A Ltd."
                    maxLength={120}
                  />
                  <Textarea
                    id="sub-beneficiary-details"
                    value={beneficiaryDetails}
                    onChange={(e) => setBeneficiaryDetails(e.target.value)}
                    placeholder="Address, bank or reference for the beneficiary (optional)"
                    rows={2}
                    maxLength={280}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Each sub-account can name its own beneficiary, separate from your main account.
                  </p>
                </div>

                {/* UBO identity verification — declared (KYC + passport) vs alias */}
                <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <div className="flex items-center gap-1.5">
                    {isDeclared ? (
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                    )}
                    <Label className="text-sm">Beneficiary identity (UBO)</Label>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Upload the beneficiary&apos;s passport and a KYC document to declare the ultimate
                    beneficial owner. Without them the sub-account is flagged as an alias.
                  </p>

                  {(
                    [
                      { kind: "passport", label: "Passport", doc: passportDoc },
                      { kind: "kyc", label: "KYC document", doc: kycDoc },
                    ] as const
                  ).map((slot) => (
                    <div
                      key={slot.kind}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-foreground">{slot.label}</p>
                          {slot.doc ? (
                            <p className="truncate text-[11px] text-emerald-600">{slot.doc.fileName}</p>
                          ) : (
                            <p className="text-[11px] text-muted-foreground">Not uploaded</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {slot.doc && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => (slot.kind === "passport" ? setPassportDoc(null) : setKycDoc(null))}
                            aria-label={`Remove ${slot.label}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <input
                          id={`sub-upload-${slot.kind}`}
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png,.webp"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            void handleUpload(slot.kind, f)
                            e.target.value = ""
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={uploading === slot.kind}
                          onClick={() => document.getElementById(`sub-upload-${slot.kind}`)?.click()}
                        >
                          <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                          {uploading === slot.kind ? "Uploading…" : slot.doc ? "Replace" : "Upload"}
                        </Button>
                      </div>
                    </div>
                  ))}

                  {isDeclared ? (
                    <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-700">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                      UBO declared — full KYC on file. No personal-liability flag applies.
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
                      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Without KYC + passport this sub-account is an <strong>alias</strong>. It can be
                          used, but all transactions and usage under it are your own legal responsibility.
                          This flag is removed once you declare the UBO with KYC and passport.
                        </span>
                      </p>
                      <label className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground">
                        <Checkbox
                          checked={aliasAccepted}
                          onCheckedChange={(v) => setAliasAccepted(v === true)}
                          className="mt-0.5"
                        />
                        <span>
                          I understand and accept full legal responsibility for all activity under this
                          alias sub-account.
                        </span>
                      </label>
                    </div>
                  )}
                </div>

                {/* Applicable tariffs (charged to the Master Account on activation) */}
                <div className="space-y-1 rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] leading-relaxed">
                  <p className="font-medium text-foreground">Tariffs (applied to your Master Account)</p>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Service fee {isDeclared ? "(declared UBO)" : "(alias)"}</span>
                    <span className="font-medium text-foreground">
                      {formatSubAccountFee(isDeclared ? SUB_ACCOUNT_SERVICE_FEE.declared : SUB_ACCOUNT_SERVICE_FEE.alias)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Annual fee</span>
                    <span className="font-medium text-foreground">{formatSubAccountFee(SUB_ACCOUNT_ANNUAL_FEE)}</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Closing fee (on closure)</span>
                    <span className="font-medium text-foreground">{formatSubAccountFee(SUB_ACCOUNT_CLOSING_FEE)}</span>
                  </div>
                  <p className="pt-1 text-muted-foreground">
                    The service and first annual fee are charged when an administrator activates the
                    sub-account.
                  </p>
                </div>
              </div>
              <DialogFooter className="shrink-0 border-t border-border/60 pt-3">
                <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={createBlocked}>
                  {creating ? "Submitting…" : uploading ? "Uploading…" : "Submit request"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Body */}
      <div className="mt-8">
        {loading || !hydrated ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl border border-border bg-muted/40" />
            ))}
          </div>
        ) : subs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Layers className="h-7 w-7" />
              </div>
              <div>
                <p className="text-base font-semibold text-foreground">No sub-accounts yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Open your first sub-account to keep funds separated — one for operations, one for
                  escrow, one per project. It stays entirely inside your own account.
                </p>
              </div>
              <Button className="mt-1 gap-2" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                New sub-account
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {subs.map((sub) => {
              const StatusIcon = STATUS_ICON[sub.status]
              const balance = subAccountBalanceFor(sub.id, sub.currency)
              return (
                <Card key={sub.id} className="overflow-hidden">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-base">{sub.label}</CardTitle>
                          <CardDescription className="mt-0.5">{sub.currency} compartment</CardDescription>
                          {sub.verification === "alias" ? (
                            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">
                              <ShieldAlert className="h-3 w-3" />
                              Alias · your legal responsibility
                            </span>
                          ) : (
                            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                              <ShieldCheck className="h-3 w-3" />
                              UBO declared
                            </span>
                          )}
                        </div>
                      <Badge variant="outline" className={`gap-1 ${STATUS_STYLE[sub.status]}`}>
                        <StatusIcon className="h-3 w-3" />
                        {SUB_ACCOUNT_STATUS_LABEL[sub.status]}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {sub.status === "active" ? (
                      <>
                        <div className="rounded-lg bg-muted/50 p-3">
                          <p className="text-xs text-muted-foreground">Balance</p>
                          <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">
                            {formatMoney(balance, sub.currency)}
                          </p>
                        </div>
                        {sub.iban && (
                          <button
                            type="button"
                            onClick={() => copy(sub.iban!, `${sub.id}-iban`)}
                            className="flex w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-primary/50"
                          >
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                                <Landmark className="h-3 w-3" /> IBAN
                              </span>
                              <span className="mt-0.5 block truncate font-mono text-xs text-foreground">
                                {sub.iban}
                              </span>
                            </span>
                            {copied === `${sub.id}-iban` ? (
                              <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                            ) : (
                              <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                          </button>
                        )}
                        {sub.bic && (
                          <p className="text-xs text-muted-foreground">
                            BIC <span className="font-mono text-foreground">{sub.bic}</span>
                          </p>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full gap-2"
                          onClick={() => openTransfer(sub.currency, sub.id)}
                        >
                          <Wallet className="h-4 w-4" />
                          Add / move funds
                        </Button>
                      </>
                    ) : sub.status === "pending" ? (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-muted-foreground">
                        Awaiting administrator activation. You will be notified once its IBAN is
                        assigned and the compartment goes live.
                      </div>
                    ) : (
                      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                        {sub.status === "rejected" ? "This request was declined." : "This sub-account is closed."}
                        {sub.adminNote && <span className="mt-1 block text-foreground">Note: {sub.adminNote}</span>}
                      </div>
                    )}
                    {(sub.status === "active" || sub.status === "pending") && (
                      <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                              <User className="h-3 w-3" /> Beneficiary
                            </p>
                            {sub.beneficiaryName ? (
                              <p className="mt-0.5 truncate text-sm font-medium text-foreground">
                                {sub.beneficiaryName}
                              </p>
                            ) : (
                              <p className="mt-0.5 text-sm italic text-muted-foreground">Not set</p>
                            )}
                            {sub.beneficiaryDetails && (
                              <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">
                                {sub.beneficiaryDetails}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            onClick={() => openBeneficiary(sub)}
                            aria-label="Edit beneficiary"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                    {sub.purpose && sub.status !== "closed" && (
                      <p className="text-xs text-muted-foreground">{sub.purpose}</p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Transfer dialog */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Internal transfer</DialogTitle>
            <DialogDescription>
              Move funds instantly between your main account and your sub-accounts. Same currency,
              zero fees.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            {transferCurrencies.length > 1 && (
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select
                  value={transferCurrency}
                  onValueChange={(v) => {
                    setTransferCurrency(v)
                    setFromId(MAIN_ACCOUNT_ID)
                    setToId("")
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {transferCurrencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>From</Label>
              <Select value={fromId} onValueChange={setFromId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {transferLegs.map((leg) => (
                    <SelectItem key={leg.id} value={leg.id}>
                      {leg.label} — {formatMoney(leg.balance, transferCurrency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Available: {formatMoney(fromBalance, transferCurrency)}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>To</Label>
              <Select value={toId} onValueChange={setToId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose destination" />
                </SelectTrigger>
                <SelectContent>
                  {transferLegs
                    .filter((leg) => leg.id !== fromId)
                    .map((leg) => (
                      <SelectItem key={leg.id} value={leg.id}>
                        {leg.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-amount">Amount</Label>
              <Input
                id="transfer-amount"
                inputMode="decimal"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder="0.00"
              />
              {transferAmount && amountNum > fromBalance + 0.001 && (
                <p className="text-xs text-destructive">
                  Exceeds available balance of {formatMoney(fromBalance, transferCurrency)}.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transfer-note">Note (optional)</Label>
              <Input
                id="transfer-note"
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                placeholder="Reference for this movement"
                maxLength={140}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferOpen(false)} disabled={transferring}>
              Cancel
            </Button>
            <Button onClick={handleTransfer} disabled={transferring || transferInvalid}>
              {transferring ? "Transferring…" : "Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit-beneficiary dialog */}
      <Dialog open={benOpen} onOpenChange={setBenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sub-account beneficiary</DialogTitle>
            <DialogDescription>
              Name the party this sub-account is held for. It is managed separately from your main
              account beneficiary.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="ben-name">Beneficiary name</Label>
              <Input
                id="ben-name"
                value={benName}
                onChange={(e) => setBenName(e.target.value)}
                placeholder="e.g. Project A Ltd."
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ben-details">Details (optional)</Label>
              <Textarea
                id="ben-details"
                value={benDetails}
                onChange={(e) => setBenDetails(e.target.value)}
                placeholder="Address, bank or reference for the beneficiary"
                rows={3}
                maxLength={280}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBenOpen(false)} disabled={benSaving}>
              Cancel
            </Button>
            <Button onClick={handleSaveBeneficiary} disabled={benSaving}>
              {benSaving ? "Saving…" : "Save beneficiary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
