"use client"

import { useMemo, useState } from "react"
import {
  Landmark,
  Building2,
  Clock,
  CheckCircle2,
  XCircle,
  FileText,
  ShieldCheck,
  Banknote,
  ArrowRight,
  Info,
  Globe,
  Layers,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { CountryCombobox } from "@/components/country-combobox"
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
  useDOFRequests,
  type DOFRequest,
  type DOFSettlementMethod,
} from "@/lib/dof-requests-store"
import { getCorrespondentBank } from "@/lib/swift-gpi"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { validateBic } from "@/lib/iban-swift"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "SGD"]
const SETTLEMENT_METHODS: { value: DOFSettlementMethod; label: string; hint: string }[] = [
  { value: "SWIFT", label: "SWIFT (cash settlement)", hint: "MT103 / MT202 cash credit transfer" },
  { value: "DTC", label: "DTC (securities)", hint: "Depository Trust Company book-entry delivery" },
  {
    value: "Euroclear",
    label: "Euroclear (securities)",
    hint: "Euroclear screen delivery vs. payment",
  },
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
  amount: string
  currency: string
  valueDate: string
  purpose: string
  originatorName: string
  originatorBank: string
  originatorBankBic: string
  originatorAccount: string
  originatorCountry: string
  mt103Ref: string
  mt202Ref: string
  pofReference: string
  bclReference: string
  settlementMethod: DOFSettlementMethod
  isin: string
  cusip: string
  notes: string
}

const EMPTY_FORM: FormState = {
  amount: "",
  currency: "EUR",
  valueDate: "",
  purpose: "",
  originatorName: "",
  originatorBank: "",
  originatorBankBic: "",
  originatorAccount: "",
  originatorCountry: "",
  mt103Ref: "",
  mt202Ref: "",
  pofReference: "",
  bclReference: "",
  settlementMethod: "SWIFT",
  isin: "",
  cusip: "",
  notes: "",
}

function StatusBadge({ status }: { status: DOFRequest["status"] }) {
  if (status === "approved") {
    return (
      <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500 text-[10px]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Approved
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

export default function InstitutionalPage() {
  const { requests, addRequest } = useDOFRequests()
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

  const correspondent = getCorrespondentBank(form.currency)
  const isSecurities = form.settlementMethod !== "SWIFT"

  const amountNumber = Number.parseFloat(form.amount.replace(/,/g, ""))
  const bicCheck = validateBic(form.originatorBankBic)
  const canSubmit =
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    form.purpose.trim().length > 0 &&
    form.originatorName.trim().length > 0 &&
    form.originatorBank.trim().length > 0 &&
    bicCheck.valid

  const handleSubmit = () => {
    if (!canSubmit) {
      const bicProblem =
        form.originatorBankBic.trim().length > 0 && !bicCheck.valid
          ? ` ${bicCheck.error}.`
          : ""
      toast.error("Missing or invalid details", {
        description:
          `Please provide the amount, purpose, and originating institution (name, bank, and a valid SWIFT/BIC).${bicProblem}`,
      })
      return
    }

    const created = addRequest({
      amount: amountNumber,
      currency: form.currency,
      valueDate: form.valueDate || new Date().toISOString().split("T")[0],
      purpose: form.purpose.trim(),
      originatorName: form.originatorName.trim(),
      originatorBank: form.originatorBank.trim(),
      originatorBankBic: form.originatorBankBic.trim().toUpperCase(),
      originatorAccount: form.originatorAccount.trim(),
      originatorCountry: form.originatorCountry.trim(),
      correspondentBank: correspondent.name,
      correspondentBic: correspondent.bic,
      mt103Ref: form.mt103Ref.trim(),
      mt202Ref: form.mt202Ref.trim(),
      pofReference: form.pofReference.trim(),
      bclReference: form.bclReference.trim(),
      settlementMethod: form.settlementMethod,
      isin: isSecurities ? form.isin.trim().toUpperCase() : "",
      cusip: isSecurities ? form.cusip.trim().toUpperCase() : "",
      notes: form.notes.trim(),
    })

    toast.success("Download of Funds submitted", {
      description: `Request ${created.id} for ${formatCurrency(amountNumber, form.currency)} is now pending Administrator authorization.`,
    })
    logActivity({
      action: `Submitted Download of Funds ${created.id} for ${formatCurrency(amountNumber, form.currency)}`,
      category: "Institutional",
      details: {
        summary: `Client submitted an institutional Download of Funds request ${created.id} for ${formatCurrency(amountNumber, form.currency)} from ${form.originatorName.trim()} via ${form.originatorBank.trim()} (${form.originatorBankBic.trim().toUpperCase()}). Settlement: ${form.settlementMethod}. UETR ${created.uetr}.`,
        referenceId: created.id,
        uetr: created.uetr,
        amount: formatCurrency(amountNumber, form.currency),
        originator: form.originatorName.trim(),
        sendingBank: `${form.originatorBank.trim()} (${form.originatorBankBic.trim().toUpperCase()})`,
        settlementMethod: form.settlementMethod,
        mt103: form.mt103Ref.trim() || "(pending)",
        mt202: form.mt202Ref.trim() || "(pending)",
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
            <h1 className="text-2xl font-semibold text-foreground text-balance">
              Institutional Desk
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              High-value Download of Funds (DOF) with SWIFT MT103/MT202, UETR tracking, and DTC /
              Euroclear settlement coordination.
            </p>
          </div>
        </div>
      </div>

      {/* Terminology / explainer */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Info className="h-4 w-4 text-primary" />
            How institutional Download of Funds works
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
            A Download of Funds (DOF) is the controlled receipt and crediting of large institutional
            funds into your MCC Capital master account. Each request is verified against its
            supporting SWIFT messaging and documentation, then authorized by the Administrator before
            the funds are credited and made available.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                term: "SWIFT MT103",
                desc: "Single customer credit transfer carrying the underlying payment.",
              },
              {
                term: "SWIFT MT202",
                desc: "Financial-institution (cover) transfer between correspondent banks.",
              },
              {
                term: "UETR",
                desc: "Unique End-to-End Transaction Reference (UUID) for gpi tracking.",
              },
              {
                term: "POF",
                desc: "Proof of Funds confirming the originator holds the stated amount.",
              },
              {
                term: "BCL",
                desc: "Bank Comfort Letter issued by the sending bank as assurance.",
              },
              {
                term: "DTC / Euroclear",
                desc: "Securities settlement rails for book-entry delivery of instruments.",
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
          <TabsTrigger value="new">New Download of Funds</TabsTrigger>
          <TabsTrigger value="requests">
            My Download Requests
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

        {/* New request form */}
        <TabsContent value="new" className="space-y-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Banknote className="h-4 w-4 text-primary" />
                Transaction Details
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount *</Label>
                <MoneyInput
                  id="amount"
                  value={form.amount}
                  onValueChange={(v) => set("amount", v)}
                  placeholder="e.g. 50,000,000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">Currency *</Label>
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
              <div className="space-y-2">
                <Label htmlFor="valueDate">Requested Value Date</Label>
                <Input
                  id="valueDate"
                  type="date"
                  value={form.valueDate}
                  onChange={(e) => set("valueDate", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settlement">Settlement Method *</Label>
                <Select
                  value={form.settlementMethod}
                  onValueChange={(v) => set("settlementMethod", v as DOFSettlementMethod)}
                >
                  <SelectTrigger id="settlement">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SETTLEMENT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="purpose">Purpose / Transaction Description *</Label>
                <Textarea
                  id="purpose"
                  value={form.purpose}
                  onChange={(e) => set("purpose", e.target.value)}
                  placeholder="e.g. Settlement of cross-border institutional facility, project funding tranche 1 of 4."
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="h-4 w-4 text-primary" />
                Originating Institution
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="originatorName">Originator (Sender) *</Label>
                <Input
                  id="originatorName"
                  value={form.originatorName}
                  onChange={(e) => set("originatorName", e.target.value)}
                  placeholder="Ultimate originator of the funds"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="originatorCountry">Originator Country</Label>
                <CountryCombobox
                  id="originatorCountry"
                  valueMode="name"
                  value={form.originatorCountry}
                  onChange={(v) => set("originatorCountry", v)}
                  placeholder="Search and select country"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="originatorBank">Sending Bank *</Label>
                <Input
                  id="originatorBank"
                  value={form.originatorBank}
                  onChange={(e) => set("originatorBank", e.target.value)}
                  placeholder="e.g. Emirates NBD"
                />
              </div>
              <VerifiedBankField
                id="originatorBankBic"
                label="Sending Bank BIC / SWIFT"
                kind="bic"
                required
                maxLength={11}
                placeholder="e.g. EBILAEAD"
                value={form.originatorBankBic}
                onChange={(v) => set("originatorBankBic", v)}
                onResolved={(info) => {
                  if (info?.country && !form.originatorCountry.trim()) {
                    set("originatorCountry", info.country)
                  }
                }}
              />
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="originatorAccount">Sending Account / IBAN</Label>
                <Input
                  id="originatorAccount"
                  value={form.originatorAccount}
                  onChange={(e) => set("originatorAccount", e.target.value)}
                  placeholder="Originating account number or IBAN"
                />
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm sm:col-span-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Globe className="h-4 w-4" />
                  <span>
                    Correspondent / intermediary bank (auto-selected for {form.currency}):
                  </span>
                </div>
                <p className="mt-1 font-medium text-foreground">
                  {correspondent.name}{" "}
                  <span className="text-muted-foreground">
                    · {correspondent.bic} · {correspondent.location}
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <FileText className="h-4 w-4 text-primary" />
                SWIFT Messaging &amp; Documentation
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mt103Ref">MT103 Reference</Label>
                <Input
                  id="mt103Ref"
                  value={form.mt103Ref}
                  onChange={(e) => set("mt103Ref", e.target.value)}
                  placeholder="Single customer credit transfer ref"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mt202Ref">MT202 Reference</Label>
                <Input
                  id="mt202Ref"
                  value={form.mt202Ref}
                  onChange={(e) => set("mt202Ref", e.target.value)}
                  placeholder="Cover / FI transfer ref"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pofReference">Proof of Funds (POF) Reference</Label>
                <Input
                  id="pofReference"
                  value={form.pofReference}
                  onChange={(e) => set("pofReference", e.target.value)}
                  placeholder="POF document reference"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bclReference">Bank Comfort Letter (BCL) Reference</Label>
                <Input
                  id="bclReference"
                  value={form.bclReference}
                  onChange={(e) => set("bclReference", e.target.value)}
                  placeholder="BCL document reference"
                />
              </div>

              {isSecurities && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="isin">ISIN ({form.settlementMethod})</Label>
                    <Input
                      id="isin"
                      value={form.isin}
                      onChange={(e) => set("isin", e.target.value)}
                      placeholder="e.g. XS1234567890"
                    />
                  </div>
                  {form.settlementMethod === "DTC" && (
                    <div className="space-y-2">
                      <Label htmlFor="cusip">CUSIP (DTC)</Label>
                      <Input
                        id="cusip"
                        value={form.cusip}
                        onChange={(e) => set("cusip", e.target.value)}
                        placeholder="e.g. 037833100"
                      />
                    </div>
                  )}
                </>
              )}

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="notes">Additional Notes</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder="Any coordination details for the receiving desk."
                  rows={2}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-4">
            <p className="text-xs text-muted-foreground text-pretty">
              A UETR is generated automatically on submission. Funds are credited only after
              Administrator authorization.
            </p>
            <Button onClick={handleSubmit} disabled={!canSubmit} className="shrink-0">
              <ShieldCheck className="mr-2 h-4 w-4" />
              Submit for Authorization
            </Button>
          </div>
        </TabsContent>

        {/* Request list */}
        <TabsContent value="requests" className="space-y-4">
          {myRequests.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                  <Layers className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium text-foreground">No Download Requests Yet</p>
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">
                    Submit a Download of Funds request to coordinate a high-value institutional
                    transaction.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setActiveTab("new")}>
                  Start a Request
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
                        {formatCurrency(r.amount, r.currency)}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {r.settlementMethod}
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
                    <Detail label="Originator" value={r.originatorName} />
                    <Detail
                      label="Sending Bank"
                      value={`${r.originatorBank}${r.originatorBankBic ? ` (${r.originatorBankBic})` : ""}`}
                    />
                    <Detail label="Correspondent" value={`${r.correspondentBank} (${r.correspondentBic})`} />
                    <Detail label="Value Date" value={r.valueDate} />
                    {r.mt103Ref && <Detail label="MT103" value={r.mt103Ref} />}
                    {r.mt202Ref && <Detail label="MT202" value={r.mt202Ref} />}
                    {r.pofReference && <Detail label="POF" value={r.pofReference} />}
                    {r.bclReference && <Detail label="BCL" value={r.bclReference} />}
                    {r.isin && <Detail label="ISIN" value={r.isin} />}
                    {r.cusip && <Detail label="CUSIP" value={r.cusip} />}
                  </div>

                  {r.purpose && (
                    <p className="rounded-lg border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">
                      {r.purpose}
                    </p>
                  )}

                  {r.status === "rejected" && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      <p className="text-sm text-muted-foreground text-pretty">
                        This request was declined by the Administrator. No funds were credited.
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
                        for SWIFT gpi tracking.
                      </p>
                    </div>
                  )}

                  {/* SWIFT gpi tracker — shown once funds are authorized & credited */}
                  {r.status === "approved" && (
                    <Accordion type="single" collapsible>
                      <AccordionItem value="tracker" className="border-border">
                        <AccordionTrigger className="text-sm">
                          SWIFT gpi Tracker &amp; settlement timeline
                        </AccordionTrigger>
                        <AccordionContent>
                          <SwiftGpiTracker
                            payment={{
                              uetr: r.uetr,
                              status: "completed",
                              currency: r.currency,
                              beneficiaryBic: r.originatorBankBic,
                              beneficiaryName: r.originatorName,
                              beneficiaryCountry: r.originatorCountry,
                              baseDate: r.decidedAt || r.submittedAt,
                              direction: "incoming",
                            }}
                          />
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
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
