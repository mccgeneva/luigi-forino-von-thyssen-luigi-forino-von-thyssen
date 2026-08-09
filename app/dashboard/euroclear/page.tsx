"use client"

import { useMemo, useState } from "react"
import {
  Landmark,
  Clock,
  CheckCircle2,
  XCircle,
  Info,
  ArrowRight,
  Copy,
  ShieldCheck,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import {
  useEuroclearRequests,
  type EuroclearRequest,
  type EuroclearDirection,
  type EuroclearSettlementBasis,
} from "@/lib/euroclear-requests-store"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { validateBic } from "@/lib/iban-swift"
import { generateSecuritiesSettlement } from "@/lib/swift-mt"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "SGD", "JPY"]
const SECURITY_TYPES = ["Eurobond", "Bond", "MTN", "Treasury Note", "Corporate Note", "Equity", "Fund Unit"]

const DIRECTIONS: { value: EuroclearDirection; label: string; hint: string }[] = [
  {
    value: "deliver",
    label: "Deliver securities (receive cash)",
    hint: "You deliver the security out of your Euroclear account; for DVP the cash leg is credited to your MCC account.",
  },
  {
    value: "receive",
    label: "Receive securities (pay cash)",
    hint: "You receive the security into your Euroclear account; for DVP the cash leg is debited from your MCC account.",
  },
]

const BASES: { value: EuroclearSettlementBasis; label: string; hint: string }[] = [
  { value: "DVP", label: "DVP — Delivery vs Payment", hint: "Securities move against a cash leg." },
  { value: "FOP", label: "FOP — Free of Payment", hint: "Book-entry transfer only; no cash moves." },
]

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

type FormState = {
  direction: EuroclearDirection
  settlementBasis: EuroclearSettlementBasis
  securityName: string
  securityType: string
  isin: string
  quantity: string
  pricePercent: string
  cashAmount: string
  currency: string
  euroclearAccount: string
  custodianBank: string
  custodianBic: string
  counterpartyName: string
  counterpartyAccount: string
  counterpartyBic: string
  tradeDate: string
  valueDate: string
  mt54xRef: string
  safekeepingRef: string
  notes: string
}

const EMPTY_FORM: FormState = {
  direction: "deliver",
  settlementBasis: "DVP",
  securityName: "",
  securityType: "Eurobond",
  isin: "",
  quantity: "",
  pricePercent: "",
  cashAmount: "",
  currency: "EUR",
  euroclearAccount: "",
  custodianBank: "",
  custodianBic: "",
  counterpartyName: "",
  counterpartyAccount: "",
  counterpartyBic: "",
  tradeDate: "",
  valueDate: "",
  mt54xRef: "",
  safekeepingRef: "",
  notes: "",
}

function StatusBadge({ status }: { status: EuroclearRequest["status"] }) {
  if (status === "approved") {
    return (
      <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500 text-[10px]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Settled
      </Badge>
    )
  }
  if (status === "rejected") {
    return (
      <Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-500 text-[10px]">
        <XCircle className="mr-1 h-3 w-3" />
        Rejected
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]">
      <Clock className="mr-1 h-3 w-3" />
      Pending Authorization
    </Badge>
  )
}

const MCC_BIC = "MCCBCHZZ"

export default function EuroclearSettlementPage() {
  const { requests, addRequest } = useEuroclearRequests()
  const logActivity = useActivityLog()

  const [activeTab, setActiveTab] = useState("new")
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const myRequests = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
      ),
    [requests],
  )
  const pendingCount = myRequests.filter((r) => r.status === "pending").length

  const isDVP = form.settlementBasis === "DVP"
  // Delivering = MT542 (deliver free) / MT543 (deliver vs payment).
  // Receiving  = MT540 (receive free) / MT541 (receive vs payment).
  const mtType = form.direction === "deliver" ? (isDVP ? "543" : "542") : isDVP ? "541" : "540"

  const quantityNumber = Number.parseFloat(form.quantity.replace(/,/g, ""))
  const cashNumber = Number.parseFloat(form.cashAmount.replace(/,/g, ""))

  const custodianBicCheck = validateBic(form.custodianBic)
  const counterpartyBicCheck = validateBic(form.counterpartyBic)
  const custodianBicInvalid = form.custodianBic.trim().length > 0 && !custodianBicCheck.valid
  const counterpartyBicInvalid =
    form.counterpartyBic.trim().length > 0 && !counterpartyBicCheck.valid

  const canSubmit =
    form.securityName.trim().length > 0 &&
    form.isin.trim().length > 0 &&
    Number.isFinite(quantityNumber) &&
    quantityNumber > 0 &&
    form.counterpartyName.trim().length > 0 &&
    form.euroclearAccount.trim().length > 0 &&
    !custodianBicInvalid &&
    !counterpartyBicInvalid &&
    (!isDVP || (Number.isFinite(cashNumber) && cashNumber > 0))

  // Live MT54x FIN preview built from the current form values.
  const previewFin = useMemo(() => {
    if (!form.securityName.trim() || !form.isin.trim()) return null
    try {
      const { raw, uetr } = generateSecuritiesSettlement({
        mt: mtType,
        senderBic: MCC_BIC,
        receiverBic: form.custodianBic.trim().toUpperCase() || "MGTCBEBE",
        senderReference: form.mt54xRef.trim() || `EOC${Date.now().toString().slice(-10)}`,
        func: "NEWM",
        tradeDate: form.tradeDate || undefined,
        settlementDate: form.valueDate || undefined,
        isin: form.isin.trim().toUpperCase(),
        securityDescription: form.securityName.trim(),
        quantity: Number.isFinite(quantityNumber) ? quantityNumber : undefined,
        currency: isDVP ? form.currency : undefined,
        settlementAmount: isDVP && Number.isFinite(cashNumber) ? cashNumber : undefined,
        agentBic: form.counterpartyBic.trim().toUpperCase() || undefined,
        safekeepingAccount: form.euroclearAccount.trim() || undefined,
        includeGpi: true,
      })
      return { raw, uetr }
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.securityName,
    form.isin,
    form.custodianBic,
    form.counterpartyBic,
    form.mt54xRef,
    form.tradeDate,
    form.valueDate,
    form.currency,
    form.euroclearAccount,
    mtType,
    isDVP,
    quantityNumber,
    cashNumber,
  ])

  const handleSubmit = () => {
    if (!canSubmit) {
      if (custodianBicInvalid || counterpartyBicInvalid) {
        toast.error("Invalid SWIFT/BIC", {
          description: `${(custodianBicInvalid ? custodianBicCheck.error : counterpartyBicCheck.error) || "Check the SWIFT/BIC code"}.`,
        })
        return
      }
      toast.error("Missing required details", {
        description: isDVP
          ? "Provide the security (name, ISIN, quantity), the cash amount, your Euroclear account, and the counterparty."
          : "Provide the security (name, ISIN, quantity), your Euroclear account, and the counterparty.",
      })
      return
    }

    // Generate the MT54x securities settlement FIN to attach to the instruction.
    let mt54xRaw: string | undefined
    try {
      mt54xRaw = generateSecuritiesSettlement({
        mt: mtType,
        senderBic: MCC_BIC,
        receiverBic: form.custodianBic.trim().toUpperCase() || "MGTCBEBE",
        senderReference: form.mt54xRef.trim() || `EOC${Date.now().toString().slice(-10)}`,
        func: "NEWM",
        tradeDate: form.tradeDate || undefined,
        settlementDate: form.valueDate || undefined,
        isin: form.isin.trim().toUpperCase(),
        securityDescription: form.securityName.trim(),
        quantity: quantityNumber,
        currency: isDVP ? form.currency : undefined,
        settlementAmount: isDVP ? cashNumber : undefined,
        agentBic: form.counterpartyBic.trim().toUpperCase() || undefined,
        safekeepingAccount: form.euroclearAccount.trim() || undefined,
        includeGpi: true,
      }).raw
    } catch {
      mt54xRaw = undefined
    }

    const created = addRequest({
      direction: form.direction,
      settlementBasis: form.settlementBasis,
      securityName: form.securityName.trim(),
      securityType: form.securityType,
      isin: form.isin.trim().toUpperCase(),
      quantity: quantityNumber,
      pricePercent: form.pricePercent.trim(),
      cashAmount: isDVP ? cashNumber : 0,
      currency: form.currency,
      euroclearAccount: form.euroclearAccount.trim(),
      custodianBank: form.custodianBank.trim(),
      custodianBic: form.custodianBic.trim().toUpperCase(),
      counterpartyName: form.counterpartyName.trim(),
      counterpartyAccount: form.counterpartyAccount.trim(),
      counterpartyBic: form.counterpartyBic.trim().toUpperCase(),
      tradeDate: form.tradeDate || new Date().toISOString().split("T")[0],
      valueDate: form.valueDate || new Date().toISOString().split("T")[0],
      mt54xRef: form.mt54xRef.trim(),
      mt54xRaw,
      safekeepingRef: form.safekeepingRef.trim(),
      notes: form.notes.trim(),
    })

    const cashLabel = isDVP ? formatCurrency(cashNumber, form.currency) : "Free of Payment"
    toast.success("Euroclear settlement submitted", {
      description: `Instruction ${created.id} (MT${mtType}) is now pending Administrator authorization.`,
    })
    logActivity({
      action: `Submitted Euroclear settlement ${created.id} (${cashLabel})`,
      category: "Institutional",
      details: {
        summary: `Client submitted a Euroclear ${form.settlementBasis} securities settlement ${created.id} (MT${mtType}) to ${form.direction === "deliver" ? "deliver" : "receive"} ${quantityNumber.toLocaleString()} of ${form.securityName.trim()} (ISIN ${form.isin.trim().toUpperCase()}) against ${cashLabel}. Counterparty ${form.counterpartyName.trim()}. UETR ${created.uetr}.`,
        referenceId: created.id,
        uetr: created.uetr,
        depository: "Euroclear",
        messageType: `MT${mtType}`,
        settlementBasis: form.settlementBasis,
        direction: form.direction,
        security: `${form.securityName.trim()} (${form.isin.trim().toUpperCase()})`,
        cashLeg: cashLabel,
        counterparty: form.counterpartyName.trim(),
        decision: "Submitted",
      },
    })

    setForm(EMPTY_FORM)
    setActiveTab("requests")
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10">
            <Landmark className="h-6 w-6 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground text-balance">
                Euroclear Settlement
              </h1>
              <Badge variant="outline" className="border-primary/30 text-primary">
                ICSD
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground text-pretty">
              Cross-border book-entry delivery and receipt of securities through Euroclear, with
              delivery-vs-payment cash legs, ISO 15022 MT54x instructions, UETR tracking, and
              Administrator authorization.
            </p>
          </div>
        </div>
      </div>

      {/* Terminology / explainer */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Info className="h-4 w-4 text-primary" />
            How Euroclear settlement works
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            Euroclear is an International Central Securities Depository (ICSD). A settlement
            instruction moves a security between Euroclear participant accounts by book entry. When
            matched against a cash leg (Delivery vs Payment), the cash is credited or debited on your
            MCC Capital master account at settlement. MCC sends the matching ISO 15022 securities
            message (MT540–543) on your behalf, and each instruction is authorized by the
            Administrator before it settles.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                term: "ICSD / Euroclear",
                desc: "International central securities depository for cross-border book-entry settlement.",
              },
              {
                term: "ISIN",
                desc: "International Securities Identification Number used to match the settling instrument.",
              },
              {
                term: "DVP / FOP",
                desc: "Delivery vs Payment (cash leg moves) or Free of Payment (book-entry only).",
              },
              {
                term: "MT540 / MT541",
                desc: "Receive free / receive against payment — securities coming into your account.",
              },
              {
                term: "MT542 / MT543",
                desc: "Deliver free / deliver against payment — securities leaving your account.",
              },
              {
                term: "UETR",
                desc: "Unique End-to-End Transaction Reference for SWIFT gpi settlement tracking.",
              },
            ].map((item) => (
              <div key={item.term} className="rounded-lg border border-border bg-secondary/30 p-3">
                <p className="text-sm font-semibold text-foreground">{item.term}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-secondary/50">
          <TabsTrigger value="new">New Instruction</TabsTrigger>
          <TabsTrigger value="requests">
            My Instructions
            {pendingCount > 0 && (
              <Badge variant="outline" className="ml-2 border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* New Instruction */}
        <TabsContent value="new" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="bg-card border-border lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Settlement instruction</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Direction + basis */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Direction</Label>
                    <Select value={form.direction} onValueChange={(v) => set("direction", v as EuroclearDirection)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DIRECTIONS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {DIRECTIONS.find((d) => d.value === form.direction)?.hint}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Settlement basis</Label>
                    <Select
                      value={form.settlementBasis}
                      onValueChange={(v) => set("settlementBasis", v as EuroclearSettlementBasis)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BASES.map((b) => (
                          <SelectItem key={b.value} value={b.value}>
                            {b.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {BASES.find((b) => b.value === form.settlementBasis)?.hint}
                    </p>
                  </div>
                </div>

                {/* Security */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="securityName">Security name / issuer</Label>
                    <Input
                      id="securityName"
                      placeholder="e.g. Republic of Italy 3.85% 2030"
                      value={form.securityName}
                      onChange={(e) => set("securityName", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Security type</Label>
                    <Select value={form.securityType} onValueChange={(v) => set("securityType", v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SECURITY_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="isin">ISIN</Label>
                    <Input
                      id="isin"
                      placeholder="e.g. XS1234567890"
                      value={form.isin}
                      onChange={(e) => set("isin", e.target.value.toUpperCase())}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quantity">Quantity / nominal</Label>
                    <Input
                      id="quantity"
                      inputMode="decimal"
                      placeholder="e.g. 5,000,000"
                      value={form.quantity}
                      onChange={(e) => set("quantity", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pricePercent">Price (% of par)</Label>
                    <Input
                      id="pricePercent"
                      placeholder="e.g. 99.250"
                      value={form.pricePercent}
                      onChange={(e) => set("pricePercent", e.target.value)}
                    />
                  </div>
                </div>

                {/* Cash leg (DVP only) */}
                {isDVP && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="cashAmount">Cash amount (settlement)</Label>
                      <Input
                        id="cashAmount"
                        inputMode="decimal"
                        placeholder="e.g. 4,962,500.00"
                        value={form.cashAmount}
                        onChange={(e) => set("cashAmount", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Currency</Label>
                      <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                        <SelectTrigger>
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
                )}

                {/* Euroclear account + custodian */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="euroclearAccount">Your Euroclear account</Label>
                    <Input
                      id="euroclearAccount"
                      placeholder="e.g. 12345"
                      value={form.euroclearAccount}
                      onChange={(e) => set("euroclearAccount", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="custodianBank">Custodian / settlement agent</Label>
                    <Input
                      id="custodianBank"
                      placeholder="e.g. Euroclear Bank SA/NV"
                      value={form.custodianBank}
                      onChange={(e) => set("custodianBank", e.target.value)}
                    />
                  </div>
                </div>

                <VerifiedBankField
                  id="custodianBic"
                  label="Custodian SWIFT / BIC (optional)"
                  kind="bic"
                  maxLength={11}
                  placeholder="e.g. MGTCBEBE"
                  value={form.custodianBic}
                  onChange={(v) => set("custodianBic", v.toUpperCase())}
                />

                {/* Counterparty */}
                <div className="space-y-2">
                  <Label htmlFor="counterpartyName">Counterparty name</Label>
                  <Input
                    id="counterpartyName"
                    placeholder="e.g. Goldman Sachs International"
                    value={form.counterpartyName}
                    onChange={(e) => set("counterpartyName", e.target.value)}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="counterpartyAccount">Counterparty Euroclear account</Label>
                    <Input
                      id="counterpartyAccount"
                      placeholder="e.g. 67890"
                      value={form.counterpartyAccount}
                      onChange={(e) => set("counterpartyAccount", e.target.value)}
                    />
                  </div>
                  <VerifiedBankField
                    id="counterpartyBic"
                    label="Counterparty SWIFT / BIC (optional)"
                    kind="bic"
                    maxLength={11}
                    placeholder="e.g. GOLDGB22"
                    value={form.counterpartyBic}
                    onChange={(v) => set("counterpartyBic", v.toUpperCase())}
                  />
                </div>

                {/* Dates */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="tradeDate">Trade date</Label>
                    <Input
                      id="tradeDate"
                      type="date"
                      value={form.tradeDate}
                      onChange={(e) => set("tradeDate", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="valueDate">Settlement date</Label>
                    <Input
                      id="valueDate"
                      type="date"
                      value={form.valueDate}
                      onChange={(e) => set("valueDate", e.target.value)}
                    />
                  </div>
                </div>

                {/* References */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="mt54xRef">MT54x reference (optional)</Label>
                    <Input
                      id="mt54xRef"
                      placeholder="Sender's settlement reference"
                      value={form.mt54xRef}
                      onChange={(e) => set("mt54xRef", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="safekeepingRef">Safekeeping / authorization ref (optional)</Label>
                    <Input
                      id="safekeepingRef"
                      placeholder="e.g. POA / mandate reference"
                      value={form.safekeepingRef}
                      onChange={(e) => set("safekeepingRef", e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notes">Notes (optional)</Label>
                  <Textarea
                    id="notes"
                    rows={2}
                    placeholder="Any additional settlement instructions for the Administrator."
                    value={form.notes}
                    onChange={(e) => set("notes", e.target.value)}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <p className="text-xs text-muted-foreground">
                    This instruction will be sent as{" "}
                    <span className="font-medium text-foreground">MT{mtType}</span> and held for
                    Administrator authorization.
                  </p>
                  <Button onClick={handleSubmit} disabled={!canSubmit}>
                    Submit for authorization
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Live preview */}
            <div className="space-y-4">
              <Card className="bg-card border-border">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Instruction summary
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Message</span>
                    <span className="font-medium text-foreground">MT{mtType}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Direction</span>
                    <span className="font-medium text-foreground">
                      {form.direction === "deliver" ? "Deliver" : "Receive"} · {form.settlementBasis}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Security</span>
                    <span className="font-medium text-foreground text-right">
                      {form.securityName.trim() || "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">ISIN</span>
                    <span className="font-mono text-xs text-foreground">
                      {form.isin.trim().toUpperCase() || "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Quantity</span>
                    <span className="font-medium text-foreground">
                      {Number.isFinite(quantityNumber) ? quantityNumber.toLocaleString() : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Cash leg</span>
                    <span className="font-medium text-foreground">
                      {isDVP && Number.isFinite(cashNumber)
                        ? formatCurrency(cashNumber, form.currency)
                        : isDVP
                          ? "—"
                          : "Free of Payment"}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {previewFin && (
                <Card className="bg-card border-border">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2 text-base font-semibold">
                      <span>MT{mtType} preview</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={() => {
                          navigator.clipboard?.writeText(previewFin.raw)
                          toast.success("FIN message copied")
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="max-h-72 overflow-auto rounded-lg bg-secondary/40 p-3 text-[11px] leading-relaxed font-mono text-foreground whitespace-pre-wrap break-all">
                      {previewFin.raw}
                    </pre>
                    <p className="mt-3 text-xs text-muted-foreground">
                      UETR (gpi): <code className="text-primary">{previewFin.uetr}</code>
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>

        {/* My Instructions */}
        <TabsContent value="requests" className="space-y-4">
          {myRequests.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Landmark className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No instructions yet</p>
                <p className="text-sm text-muted-foreground">
                  Submit a Euroclear settlement instruction to see it here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Accordion type="single" collapsible className="space-y-3">
              {myRequests.map((r) => (
                <AccordionItem
                  key={r.id}
                  value={r.id}
                  className="rounded-lg border border-border bg-card px-4"
                >
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex flex-1 flex-wrap items-center justify-between gap-3 pr-3 text-left">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                          <Landmark className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {r.securityName}{" "}
                            <span className="font-normal text-muted-foreground">· {r.isin}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {r.id} · {r.direction === "deliver" ? "Deliver" : "Receive"} ·{" "}
                            {r.settlementBasis} · {r.quantity.toLocaleString()} units
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-foreground">
                          {r.settlementBasis === "DVP"
                            ? formatCurrency(r.cashAmount, r.currency)
                            : "FOP"}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pb-4">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <Detail label="Counterparty" value={r.counterpartyName || "—"} />
                      <Detail label="Counterparty account" value={r.counterpartyAccount || "—"} />
                      <Detail label="Counterparty BIC / SWIFT" value={r.counterpartyBic || "—"} mono />
                      <Detail label="Your Euroclear account" value={r.euroclearAccount || "—"} />
                      <Detail label="Custodian" value={r.custodianBank || "—"} />
                      <Detail label="Custodian BIC / SWIFT" value={r.custodianBic || "—"} mono />
                      <Detail label="Security type" value={r.securityType} />
                      <Detail
                        label="Price"
                        value={r.pricePercent ? `${r.pricePercent}%` : "—"}
                      />
                      <Detail label="Trade date" value={r.tradeDate || "—"} />
                      <Detail label="Settlement date" value={r.valueDate || "—"} />
                      <Detail label="MT54x ref" value={r.mt54xRef || "—"} mono />
                      <Detail label="Submitted" value={formatTimestamp(r.submittedAt)} />
                    </div>

                    {r.notes && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground">Notes</p>
                        <p className="mt-1 text-sm text-foreground">{r.notes}</p>
                      </div>
                    )}

                    {r.status === "rejected" && r.decisionNote && (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                        <p className="text-xs font-medium text-red-500">Rejection reason</p>
                        <p className="mt-1 text-sm text-foreground">{r.decisionNote}</p>
                      </div>
                    )}

                    <SwiftGpiTracker
                      payment={{
                        uetr: r.uetr,
                        status:
                          r.status === "approved"
                            ? "completed"
                            : r.status === "rejected"
                              ? "failed"
                              : "pending",
                        currency: r.currency,
                        beneficiaryBic: r.custodianBic || r.counterpartyBic,
                        beneficiaryName: r.counterpartyName,
                        beneficiaryCountry: "",
                        baseDate: r.decidedAt || r.submittedAt,
                        direction: r.direction === "deliver" ? "incoming" : "outgoing",
                      }}
                    />

                    {r.mt54xRaw && (
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-medium text-muted-foreground">
                            MT{r.direction === "deliver" ? (r.settlementBasis === "DVP" ? "543" : "542") : r.settlementBasis === "DVP" ? "541" : "540"}{" "}
                            settlement message
                          </p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => {
                              navigator.clipboard?.writeText(r.mt54xRaw || "")
                              toast.success("FIN message copied")
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Copy
                          </Button>
                        </div>
                        <pre className="max-h-72 overflow-auto rounded-lg bg-secondary/40 p-3 text-[11px] leading-relaxed font-mono text-foreground whitespace-pre-wrap break-all">
                          {r.mt54xRaw}
                        </pre>
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-sm text-foreground break-words", mono && "font-mono text-xs")}>
        {value}
      </p>
    </div>
  )
}
