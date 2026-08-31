"use client"

import { useMemo, useState } from "react"
import {
  Layers,
  Building2,
  Clock,
  CheckCircle2,
  XCircle,
  FileText,
  ShieldCheck,
  ArrowRight,
  Info,
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
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
  useDTCRequests,
  type DTCRequest,
  type DTCDepository,
  type DTCDirection,
  type DTCSettlementBasis,
} from "@/lib/dtc-requests-store"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { validateBic } from "@/lib/iban-swift"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "SGD"]
const SECURITY_TYPES = ["Bond", "Equity", "MTN", "Treasury Note", "Corporate Note", "Fund Unit"]

const DEPOSITORIES: { value: DTCDepository; label: string; hint: string }[] = [
  {
    value: "DTC",
    label: "DTC (Depository Trust Company)",
    hint: "US book-entry settlement · participant # · CUSIP",
  },
  {
    value: "Euroclear",
    label: "Euroclear",
    hint: "International book-entry settlement · Euroclear account · ISIN",
  },
]

const DIRECTIONS: { value: DTCDirection; label: string; hint: string }[] = [
  {
    value: "deliver",
    label: "Deliver securities (receive cash)",
    hint: "You deliver the security out; for DVP the cash leg is credited to your account.",
  },
  {
    value: "receive",
    label: "Receive securities (pay cash)",
    hint: "You receive the security in; for DVP the cash leg is debited from your account.",
  },
]

const BASES: { value: DTCSettlementBasis; label: string; hint: string }[] = [
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
  depository: DTCDepository
  direction: DTCDirection
  settlementBasis: DTCSettlementBasis
  securityName: string
  securityType: string
  isin: string
  cusip: string
  quantity: string
  pricePercent: string
  cashAmount: string
  currency: string
  participantNumber: string
  agentBank: string
  agentBankBic: string
  counterpartyName: string
  counterpartyParticipant: string
  counterpartyBic: string
  tradeDate: string
  valueDate: string
  mt54xRef: string
  poaReference: string
  notes: string
}

const EMPTY_FORM: FormState = {
  depository: "DTC",
  direction: "deliver",
  settlementBasis: "DVP",
  securityName: "",
  securityType: "Bond",
  isin: "",
  cusip: "",
  quantity: "",
  pricePercent: "",
  cashAmount: "",
  currency: "USD",
  participantNumber: "",
  agentBank: "",
  agentBankBic: "",
  counterpartyName: "",
  counterpartyParticipant: "",
  counterpartyBic: "",
  tradeDate: "",
  valueDate: "",
  mt54xRef: "",
  poaReference: "",
  notes: "",
}

function StatusBadge({ status }: { status: DTCRequest["status"] }) {
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

export default function SecuritiesSettlementPage() {
  const { requests, addRequest } = useDTCRequests()
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
  const isDTC = form.depository === "DTC"

  const quantityNumber = Number.parseFloat(form.quantity.replace(/,/g, ""))
  const cashNumber = Number.parseFloat(form.cashAmount.replace(/,/g, ""))

  // BIC fields are optional here, but if supplied they must be a valid ISO 9362 code.
  const agentBicCheck = validateBic(form.agentBankBic)
  const counterpartyBicCheck = validateBic(form.counterpartyBic)
  const agentBicInvalid = form.agentBankBic.trim().length > 0 && !agentBicCheck.valid
  const counterpartyBicInvalid =
    form.counterpartyBic.trim().length > 0 && !counterpartyBicCheck.valid

  const canSubmit =
    form.securityName.trim().length > 0 &&
    form.isin.trim().length > 0 &&
    Number.isFinite(quantityNumber) &&
    quantityNumber > 0 &&
    form.counterpartyName.trim().length > 0 &&
    form.participantNumber.trim().length > 0 &&
    !agentBicInvalid &&
    !counterpartyBicInvalid &&
    (!isDVP || (Number.isFinite(cashNumber) && cashNumber > 0))

  const handleSubmit = () => {
    if (!canSubmit) {
      if (agentBicInvalid || counterpartyBicInvalid) {
        toast.error("Invalid SWIFT/BIC", {
          description: `${(agentBicInvalid ? agentBicCheck.error : counterpartyBicCheck.error) || "Check the SWIFT/BIC code"}.`,
        })
        return
      }
      toast.error("Missing required details", {
        description: isDVP
          ? "Provide the security (name, ISIN, quantity), the cash amount, your participant number, and the counterparty."
          : "Provide the security (name, ISIN, quantity), your participant number, and the counterparty.",
      })
      return
    }

    const created = addRequest({
      depository: form.depository,
      direction: form.direction,
      settlementBasis: form.settlementBasis,
      securityName: form.securityName.trim(),
      securityType: form.securityType,
      isin: form.isin.trim().toUpperCase(),
      cusip: isDTC ? form.cusip.trim().toUpperCase() : "",
      quantity: quantityNumber,
      pricePercent: form.pricePercent.trim(),
      cashAmount: isDVP ? cashNumber : 0,
      currency: form.currency,
      participantNumber: form.participantNumber.trim(),
      agentBank: form.agentBank.trim(),
      agentBankBic: form.agentBankBic.trim().toUpperCase(),
      counterpartyName: form.counterpartyName.trim(),
      counterpartyParticipant: form.counterpartyParticipant.trim(),
      counterpartyBic: form.counterpartyBic.trim().toUpperCase(),
      tradeDate: form.tradeDate || new Date().toISOString().split("T")[0],
      valueDate: form.valueDate || new Date().toISOString().split("T")[0],
      mt54xRef: form.mt54xRef.trim(),
      poaReference: form.poaReference.trim(),
      notes: form.notes.trim(),
    })

    const cashLabel = isDVP ? formatCurrency(cashNumber, form.currency) : "Free of Payment"
    toast.success("Securities settlement submitted", {
      description: `Instruction ${created.id} (${form.depository}) is now pending Administrator authorization.`,
    })
    logActivity({
      action: `Submitted ${form.depository} settlement ${created.id} (${cashLabel})`,
      category: "Institutional",
      details: {
        summary: `Client submitted a ${form.depository} ${form.settlementBasis} securities settlement ${created.id} to ${form.direction === "deliver" ? "deliver" : "receive"} ${quantityNumber.toLocaleString()} of ${form.securityName.trim()} (ISIN ${form.isin.trim().toUpperCase()}) against ${cashLabel}. Counterparty ${form.counterpartyName.trim()}. UETR ${created.uetr}.`,
        referenceId: created.id,
        uetr: created.uetr,
        depository: form.depository,
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
            <Layers className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground text-balance">
              Securities Settlement (DTC / Euroclear)
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              Book-entry delivery and receipt of securities via DTC and Euroclear, with
              delivery-vs-payment cash legs, UETR tracking, and Administrator authorization.
            </p>
          </div>
        </div>
      </div>

      {/* Terminology / explainer */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Info className="h-4 w-4 text-primary" />
            How securities settlement works
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            A securities settlement instruction moves a financial instrument between depository
            participants by book entry. When matched against a cash leg (Delivery vs Payment), the
            cash is credited or debited on your MCC Capital master account at settlement. Each
            instruction is verified against its settlement messaging and authorized by the
            Administrator before it settles.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                term: "DTC",
                desc: "Depository Trust Company — US central securities depository for book-entry settlement.",
              },
              {
                term: "Euroclear",
                desc: "International central securities depository for cross-border book-entry settlement.",
              },
              {
                term: "DVP / FOP",
                desc: "Delivery vs Payment (cash leg moves) or Free of Payment (book-entry only).",
              },
              {
                term: "ISIN / CUSIP",
                desc: "International / US security identifiers used to match the settling instrument.",
              },
              {
                term: "Participant #",
                desc: "Your DTC participant number or Euroclear account used to receive/deliver.",
              },
              {
                term: "MT540–543",
                desc: "SWIFT securities settlement instructions (receive/deliver, free/against payment).",
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
        <TabsList>
          <TabsTrigger value="new">New Settlement Instruction</TabsTrigger>
          <TabsTrigger value="requests">
            My Settlements
            {myRequests.length > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2",
                  pendingCount > 0
                    ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    : "bg-primary/10 text-primary border-primary/20",
                )}
              >
                {myRequests.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* New instruction form */}
        <TabsContent value="new" className="space-y-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Landmark className="h-4 w-4 text-primary" />
                Settlement Venue &amp; Direction
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="depository">Depository *</Label>
                <Select
                  value={form.depository}
                  onValueChange={(v) => set("depository", v as DTCDepository)}
                >
                  <SelectTrigger id="depository">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPOSITORIES.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {DEPOSITORIES.find((d) => d.value === form.depository)?.hint}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="direction">Direction *</Label>
                <Select
                  value={form.direction}
                  onValueChange={(v) => set("direction", v as DTCDirection)}
                >
                  <SelectTrigger id="direction">
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
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="basis">Settlement Basis *</Label>
                <Select
                  value={form.settlementBasis}
                  onValueChange={(v) => set("settlementBasis", v as DTCSettlementBasis)}
                >
                  <SelectTrigger id="basis">
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
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <FileText className="h-4 w-4 text-primary" />
                Security &amp; Cash Leg
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="securityName">Security / Issuer *</Label>
                <Input
                  id="securityName"
                  value={form.securityName}
                  onChange={(e) => set("securityName", e.target.value)}
                  placeholder="e.g. US Treasury 4.25% 2034"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="securityType">Security Type</Label>
                <Select value={form.securityType} onValueChange={(v) => set("securityType", v)}>
                  <SelectTrigger id="securityType">
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
              <div className="space-y-2">
                <Label htmlFor="isin">ISIN *</Label>
                <Input
                  id="isin"
                  value={form.isin}
                  onChange={(e) => set("isin", e.target.value)}
                  placeholder="e.g. US91282CJL45"
                />
              </div>
              {isDTC && (
                <div className="space-y-2">
                  <Label htmlFor="cusip">CUSIP</Label>
                  <Input
                    id="cusip"
                    value={form.cusip}
                    onChange={(e) => set("cusip", e.target.value)}
                    placeholder="e.g. 91282CJL4"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="quantity">Quantity / Nominal *</Label>
                <Input
                  id="quantity"
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(e) => set("quantity", e.target.value)}
                  placeholder="e.g. 25,000,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pricePercent">Price (% of par)</Label>
                <Input
                  id="pricePercent"
                  value={form.pricePercent}
                  onChange={(e) => set("pricePercent", e.target.value)}
                  placeholder="e.g. 99.250"
                />
              </div>
              {isDVP && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="cashAmount">Cash Settlement Amount *</Label>
                    <MoneyInput
                      id="cashAmount"
                      value={form.cashAmount}
                      onValueChange={(v) => set("cashAmount", v)}
                      placeholder="e.g. 24,812,500"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="currency">Cash Currency *</Label>
                    <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
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
                </>
              )}
              {isDVP && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm sm:col-span-2">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    {form.direction === "deliver" ? (
                      <ArrowDownLeft className="h-4 w-4 text-green-500" />
                    ) : (
                      <ArrowUpRight className="h-4 w-4 text-foreground" />
                    )}
                    <span>
                      On settlement the cash leg will be{" "}
                      <span className="font-medium text-foreground">
                        {form.direction === "deliver" ? "credited to" : "debited from"}
                      </span>{" "}
                      your master account.
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="h-4 w-4 text-primary" />
                Participant &amp; Counterparty
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="participantNumber">
                  {isDTC ? "Your DTC Participant #" : "Your Euroclear Account"} *
                </Label>
                <Input
                  id="participantNumber"
                  value={form.participantNumber}
                  onChange={(e) => set("participantNumber", e.target.value)}
                  placeholder={isDTC ? "e.g. 2599" : "e.g. 12345"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agentBank">Settlement / Custodian Agent</Label>
                <Input
                  id="agentBank"
                  value={form.agentBank}
                  onChange={(e) => set("agentBank", e.target.value)}
                  placeholder="e.g. Citibank N.A. (custody)"
                />
              </div>
              <VerifiedBankField
                id="agentBankBic"
                label="Agent BIC / SWIFT"
                kind="bic"
                maxLength={11}
                placeholder="e.g. CITIUS33"
                value={form.agentBankBic}
                onChange={(v) => set("agentBankBic", v)}
              />
              <div className="space-y-2">
                <Label htmlFor="counterpartyName">Counterparty *</Label>
                <Input
                  id="counterpartyName"
                  value={form.counterpartyName}
                  onChange={(e) => set("counterpartyName", e.target.value)}
                  placeholder="Delivering / receiving counterparty"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="counterpartyParticipant">
                  Counterparty {isDTC ? "Participant #" : "Account"}
                </Label>
                <Input
                  id="counterpartyParticipant"
                  value={form.counterpartyParticipant}
                  onChange={(e) => set("counterpartyParticipant", e.target.value)}
                  placeholder={isDTC ? "Counterparty DTC #" : "Counterparty Euroclear acct"}
                />
              </div>
              <VerifiedBankField
                id="counterpartyBic"
                label="Counterparty BIC / SWIFT"
                kind="bic"
                maxLength={11}
                placeholder="e.g. MGTCBEBE"
                value={form.counterpartyBic}
                onChange={(v) => set("counterpartyBic", v)}
              />
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <FileText className="h-4 w-4 text-primary" />
                Dates &amp; Settlement Messaging
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="tradeDate">Trade Date</Label>
                <Input
                  id="tradeDate"
                  type="date"
                  value={form.tradeDate}
                  onChange={(e) => set("tradeDate", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="valueDate">Settlement (Value) Date</Label>
                <Input
                  id="valueDate"
                  type="date"
                  value={form.valueDate}
                  onChange={(e) => set("valueDate", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mt54xRef">MT540–543 Reference</Label>
                <Input
                  id="mt54xRef"
                  value={form.mt54xRef}
                  onChange={(e) => set("mt54xRef", e.target.value)}
                  placeholder="Securities settlement instruction ref"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="poaReference">Safekeeping / Authorization Ref</Label>
                <Input
                  id="poaReference"
                  value={form.poaReference}
                  onChange={(e) => set("poaReference", e.target.value)}
                  placeholder="Safekeeping account / authorization ref"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="notes">Additional Notes</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder="Any coordination details for the settlement desk."
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-4">
            <p className="text-xs text-muted-foreground text-pretty">
              A UETR is generated automatically on submission. Securities settle and any cash leg
              moves only after Administrator authorization.
            </p>
            <Button onClick={handleSubmit} disabled={!canSubmit} className="shrink-0">
              <ShieldCheck className="mr-2 h-4 w-4" />
              Submit for Authorization
            </Button>
          </div>
        </TabsContent>

        {/* Instruction list */}
        <TabsContent value="requests" className="space-y-4">
          {myRequests.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                  <Layers className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium text-foreground">No Settlement Instructions Yet</p>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    Submit a DTC or Euroclear settlement instruction to deliver or receive
                    securities.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setActiveTab("new")}>
                  Start an Instruction
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ) : (
            myRequests.map((r) => (
              <Card key={r.id} className="bg-card border-border">
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-lg font-semibold text-foreground">
                        {r.settlementBasis === "DVP"
                          ? formatCurrency(r.cashAmount, r.currency)
                          : "Free of Payment"}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {r.depository}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {r.direction === "deliver" ? "Deliver" : "Receive"} · {r.settlementBasis}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{r.id}</p>
                      <p className="text-xs text-muted-foreground">
                        Submitted {formatTimestamp(r.submittedAt)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <Detail label="Security" value={`${r.securityName} (${r.securityType})`} />
                    <Detail label="ISIN" value={r.isin} />
                    {r.cusip && <Detail label="CUSIP" value={r.cusip} />}
                    <Detail label="Quantity / Nominal" value={r.quantity.toLocaleString()} />
                    {r.pricePercent && <Detail label="Price" value={`${r.pricePercent}%`} />}
                    <Detail
                      label={r.depository === "DTC" ? "Your Participant #" : "Your Euroclear Acct"}
                      value={r.participantNumber}
                    />
                    <Detail label="Counterparty" value={r.counterpartyName} />
                    {r.counterpartyParticipant && (
                      <Detail label="Counterparty Acct" value={r.counterpartyParticipant} />
                    )}
                    {r.agentBank && (
                      <Detail
                        label="Agent"
                        value={`${r.agentBank}${r.agentBankBic ? ` (${r.agentBankBic})` : ""}`}
                      />
                    )}
                    <Detail label="Trade Date" value={r.tradeDate} />
                    <Detail label="Settlement Date" value={r.valueDate} />
                    {r.mt54xRef && <Detail label="MT540–543" value={r.mt54xRef} />}
                    {r.poaReference && <Detail label="Safekeeping Ref" value={r.poaReference} />}
                  </div>

                  {r.notes && (
                    <p className="rounded-lg border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">
                      {r.notes}
                    </p>
                  )}

                  {r.status === "rejected" && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      <p className="text-sm text-muted-foreground text-pretty">
                        This instruction was declined by the Administrator. No securities settled and
                        no cash moved.
                        {r.decisionNote ? ` Reason: ${r.decisionNote}` : ""}
                      </p>
                    </div>
                  )}

                  {r.status === "pending" && (
                    <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                      <p className="text-sm text-muted-foreground text-pretty">
                        Awaiting Administrator authorization. UETR{" "}
                        <span className="font-mono text-foreground">{r.uetr}</span> has been assigned
                        for tracking.
                      </p>
                    </div>
                  )}

                  {/* gpi-style tracker — shown once settled, for the cash leg of DVP trades */}
                  {r.status === "approved" && r.settlementBasis === "DVP" && (
                    <Accordion type="single" collapsible>
                      <AccordionItem value="tracker" className="border-border">
                        <AccordionTrigger className="text-sm">
                          SWIFT gpi Tracker &amp; cash-leg settlement timeline
                        </AccordionTrigger>
                        <AccordionContent>
                          <SwiftGpiTracker
                            payment={{
                              uetr: r.uetr,
                              status: "completed",
                              currency: r.currency,
                              beneficiaryBic: r.counterpartyBic || r.agentBankBic,
                              beneficiaryName: r.counterpartyName,
                              beneficiaryCountry: "",
                              baseDate: r.decidedAt || r.submittedAt,
                              direction: r.direction === "deliver" ? "incoming" : "outgoing",
                            }}
                          />
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}

                  {r.status === "approved" && r.settlementBasis === "FOP" && (
                    <div className="flex items-start gap-2 rounded-lg border border-green-500/20 bg-green-500/5 p-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                      <p className="text-sm text-muted-foreground text-pretty">
                        Free-of-payment book-entry transfer settled. No cash leg moved. UETR{" "}
                        <span className="font-mono text-foreground">{r.uetr}</span>.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground break-all">{value || "—"}</span>
    </div>
  )
}
