"use client"

import { useEffect, useMemo, useState } from "react"
import {
  FileSearch,
  ArrowDownToLine,
  FileOutput,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Braces,
  FileText,
  Inbox,
  Send,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  parseSwiftMessage,
  generateSwiftMessage,
  generateMt760,
  generateMt799,
  toReconciliationInput,
  type ParsedSwiftMessage,
  type SwiftParty,
} from "@/lib/swift-mt"
import { submitSwiftMessageAdmin } from "@/app/actions/reconciliation"
import { listCreditableIncomingSwiftAdmin } from "@/app/actions/incoming-swift"
import { SwiftRoutingQueue } from "@/components/admin/swift-routing-queue"
import { IncomingSwiftDelivery } from "@/components/admin/incoming-swift-delivery"
import { toast } from "sonner"

const SAMPLE_MT103 = `{1:F01DEUTDEFFAXXX0000000000}
{2:I103BNPAFRPPXXXN}
{3:{121:eb6305c9-1f7f-49de-aed0-16487c27b42d}{111:001}}
{4:
:20:REF-103-99001
:23B:CRED
:32A:240617EUR15000,00
:33B:EUR15000,00
:50K:/DE89370400440532013000
ACME COMMODITIES GMBH
FRANKFURT
:59:/FR7630006000011234567890189
NAFTA HUB SA
:70:INVOICE 8842 MCC-RCN-7788
:71A:OUR
-}
{5:{CHK:123456789ABC}}`

const TYPE_BADGE: Record<string, string> = {
  MT103: "bg-primary/15 text-primary",
  MT202: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  MT202COV: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  MT799: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  MT760: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
}

function partyToString(p?: SwiftParty): string {
  if (!p) return "—"
  return [p.account && `/${p.account}`, p.bic, ...p.nameAndAddress].filter(Boolean).join(" · ")
}

function FieldRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === "") return null
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="break-all text-sm text-foreground sm:max-w-[60%] sm:text-right">{value}</span>
    </div>
  )
}

function copy(text: string, label = "Copied to clipboard") {
  navigator.clipboard?.writeText(text).then(
    () => toast.success(label),
    () => toast.error("Could not copy"),
  )
}

export function AdminSwiftInspector() {
  // --- Awaiting-credit count (drives the "Receive & deliver" tab badge so a
  // customer-submitted SWIFT is visible without opening the tab first) ---
  const [awaitingCount, setAwaitingCount] = useState(0)
  const [tab, setTab] = useState("routing")
  useEffect(() => {
    let cancelled = false
    listCreditableIncomingSwiftAdmin(ADMIN_PASSCODE)
      .then((res) => {
        if (cancelled || !res.ok) return
        setAwaitingCount(res.messages.length)
        // On first load, if something is awaiting action, land the admin on the
        // delivery queue instead of the default routing tab. Guarded so it only
        // runs while still on the default tab (never overrides a manual switch).
        if (res.messages.length > 0) {
          setTab((cur) => (cur === "routing" ? "deliver" : cur))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // --- Inspect tab ---
  const [raw, setRaw] = useState("")
  const parsed: ParsedSwiftMessage | null = useMemo(
    () => (raw.trim() ? parseSwiftMessage(raw) : null),
    [raw],
  )
  const extract = useMemo(() => (parsed && parsed.valid ? toReconciliationInput(parsed) : null), [parsed])
  const [ingesting, setIngesting] = useState(false)

  const handleIngest = async () => {
    if (!raw.trim()) return
    setIngesting(true)
    try {
      const res = await submitSwiftMessageAdmin(ADMIN_PASSCODE, raw)
      if (res.ok) {
        const last = res.records.find((r) => r.id === res.lastId)
        toast.success(
          last
            ? `Ingested ${last.payment.swiftType ?? "message"} — status: ${last.status.replace("_", " ")}`
            : "SWIFT message ingested into reconciliation.",
        )
      } else {
        toast.error(res.error)
      }
    } catch {
      toast.error("Could not reach the reconciliation engine.")
    } finally {
      setIngesting(false)
    }
  }

  // --- Generate tab ---
  const [gen, setGen] = useState({
    type: "MT103" as "MT103" | "MT202" | "MT760" | "MT799",
    senderBic: "DEUTDEFF",
    receiverBic: "BNPAFRPP",
    senderReference: "OUT-103-001",
    relatedReference: "",
    valueDate: new Date().toISOString().slice(0, 10),
    currency: "EUR",
    amount: "15000.00",
    orderingAccount: "DE89370400440532013000",
    orderingName: "ACME COMMODITIES GMBH",
    beneficiaryAccount: "FR7630006000011234567890189",
    beneficiaryName: "NAFTA HUB SA",
    remittanceInfo: "MCC-RCN-7788",
    chargesDetail: "OUR" as "OUR" | "BEN" | "SHA",
    includeGpi: true,
    // MT760 (guarantee / SBLC) specifics
    purpose: "ISSU",
    form: "STBY" as "STBY" | "DGAR",
    applicableRules: "ISPR",
    expiryDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1))
      .toISOString()
      .slice(0, 10),
    terms: "PAYABLE ON FIRST WRITTEN DEMAND",
    // MT799 (free format / RWA) specifics
    narrative:
      "WE HEREBY CONFIRM THAT WE ARE READY, WILLING AND ABLE TO PROCEED WITH THE ABOVE-REFERENCED TRANSACTION.",
  })
  const [generated, setGenerated] = useState<{ raw: string; uetr: string } | null>(null)

  const handleGenerate = () => {
    const sender = gen.senderBic.trim().toUpperCase()
    const receiver = gen.receiverBic.trim().toUpperCase()
    const reference = gen.senderReference.trim()

    if (gen.type === "MT799") {
      if (!gen.narrative.trim()) {
        toast.error("Enter the free-format narrative for the MT799.")
        return
      }
      const out = generateMt799({
        senderBic: sender,
        receiverBic: receiver,
        senderReference: reference,
        relatedReference: gen.relatedReference.trim() || undefined,
        narrative: gen.narrative.trim(),
        includeGpi: gen.includeGpi,
      })
      setGenerated(out)
      toast.success(`MT799 generated with UETR ${out.uetr.slice(0, 8)}…`)
      return
    }

    if (gen.type === "MT760") {
      const amount = Number(gen.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("Enter a valid undertaking amount greater than zero.")
        return
      }
      const out = generateMt760({
        senderBic: sender,
        receiverBic: receiver,
        senderReference: reference,
        relatedReference: gen.relatedReference.trim() || undefined,
        purpose: gen.purpose.trim() || undefined,
        form: gen.form,
        applicableRules: gen.applicableRules.trim() || undefined,
        issueDate: gen.valueDate,
        expiryDate: gen.expiryDate || undefined,
        currency: gen.currency.trim().toUpperCase(),
        amount,
        applicant: {
          account: gen.orderingAccount.trim() || undefined,
          nameAndAddress: gen.orderingName.trim() ? [gen.orderingName.trim()] : undefined,
        },
        beneficiary: {
          account: gen.beneficiaryAccount.trim() || undefined,
          nameAndAddress: gen.beneficiaryName.trim() ? [gen.beneficiaryName.trim()] : undefined,
        },
        terms: gen.terms.trim() || undefined,
        includeGpi: gen.includeGpi,
      })
      setGenerated(out)
      toast.success(`MT760 generated with UETR ${out.uetr.slice(0, 8)}…`)
      return
    }

    const amount = Number(gen.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount greater than zero.")
      return
    }
    const out = generateSwiftMessage({
      type: gen.type,
      senderBic: sender,
      receiverBic: receiver,
      senderReference: reference,
      relatedReference: gen.relatedReference.trim() || undefined,
      valueDate: gen.valueDate,
      currency: gen.currency.trim().toUpperCase(),
      amount,
      ordering: {
        account: gen.orderingAccount.trim() || undefined,
        nameAndAddress: gen.orderingName.trim() ? [gen.orderingName.trim()] : undefined,
      },
      beneficiary: {
        account: gen.beneficiaryAccount.trim() || undefined,
        nameAndAddress: gen.beneficiaryName.trim() ? [gen.beneficiaryName.trim()] : undefined,
      },
      remittanceInfo: gen.remittanceInfo.trim() || undefined,
      chargesDetail: gen.type === "MT103" ? gen.chargesDetail : undefined,
      includeGpi: gen.includeGpi,
    })
    setGenerated(out)
    toast.success(`${gen.type} generated with UETR ${out.uetr.slice(0, 8)}…`)
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-6">
      <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <TabsTrigger value="routing" className="gap-2">
          <Inbox className="h-4 w-4" /> Routing
        </TabsTrigger>
        <TabsTrigger value="deliver" className="gap-2">
          <Send className="h-4 w-4" /> Receive &amp; deliver
          {awaitingCount > 0 && (
            <Badge className="ml-1 bg-emerald-500/15 px-1.5 text-emerald-600 dark:text-emerald-400">
              {awaitingCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="inspect" className="gap-2">
          <FileSearch className="h-4 w-4" /> Inspect &amp; parse
        </TabsTrigger>
        <TabsTrigger value="ingest" className="gap-2">
          <ArrowDownToLine className="h-4 w-4" /> Reconcile
        </TabsTrigger>
        <TabsTrigger value="generate" className="gap-2">
          <FileOutput className="h-4 w-4" /> Generate
        </TabsTrigger>
      </TabsList>

      {/* ---------------- Routing approvals ---------------- */}
      <TabsContent value="routing" className="flex flex-col gap-6">
        <SwiftRoutingQueue />
      </TabsContent>

      {/* ---------------- Receive & deliver (inbound auto-match) ---------------- */}
      <TabsContent value="deliver" className="flex flex-col gap-6">
        <IncomingSwiftDelivery />
      </TabsContent>

      {/* ---------------- Inspect ---------------- */}
      <TabsContent value="inspect" className="flex flex-col gap-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Raw SWIFT message</CardTitle>
                  <CardDescription>Paste an MT103, MT202, MT202 COV, MT760 or MT799 message.</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => setRaw(SAMPLE_MT103)} className="bg-transparent">
                  Load sample
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                placeholder="{1:F01...}{2:I103...}{4:&#10;:20:...&#10;-}"
                className="min-h-[320px] font-mono text-xs leading-relaxed"
                aria-label="Raw SWIFT message"
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setRaw("")} className="bg-transparent">
                  Clear
                </Button>
                {parsed && (
                  <Button variant="outline" size="sm" onClick={() => copy(raw)} className="gap-2 bg-transparent">
                    <Copy className="h-3.5 w-3.5" /> Copy raw
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">Parsed result</CardTitle>
                {parsed && (
                  <>
                    <Badge className={TYPE_BADGE[parsed.type] ?? "bg-muted text-muted-foreground"}>
                      {parsed.type}
                    </Badge>
                    {parsed.valid ? (
                      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> Valid
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1">
                        <AlertTriangle className="h-3 w-3" /> Invalid
                      </Badge>
                    )}
                    {parsed.gpiEnabled && <Badge variant="outline">gpi</Badge>}
                  </>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!parsed && (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Paste a message to see the structured breakdown.
                </p>
              )}

              {parsed && (
                <Tabs defaultValue="fields" className="flex flex-col gap-4">
                  <TabsList>
                    <TabsTrigger value="fields" className="gap-1.5">
                      <FileText className="h-3.5 w-3.5" /> Fields
                    </TabsTrigger>
                    <TabsTrigger value="json" className="gap-1.5">
                      <Braces className="h-3.5 w-3.5" /> JSON
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="fields" className="flex flex-col">
                    {(parsed.errors.length > 0 || parsed.warnings.length > 0) && (
                      <div className="mb-3 flex flex-col gap-2">
                        {parsed.errors.map((e, i) => (
                          <p
                            key={`e-${i}`}
                            className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {e}
                          </p>
                        ))}
                        {parsed.warnings.map((w, i) => (
                          <p
                            key={`w-${i}`}
                            className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
                          </p>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-col">
                      <FieldRow label="Message type" value={parsed.type} />
                      <FieldRow label="Sender ref (:20:)" value={parsed.senderReference} />
                      <FieldRow label="Related ref (:21:)" value={parsed.relatedReference} />
                      <FieldRow label="UETR (121)" value={parsed.uetr} />
                      <FieldRow label="Service type (111)" value={parsed.serviceTypeId} />
                      <FieldRow label="Value date" value={parsed.valueDate} />
                      <FieldRow
                        label="Amount"
                        value={
                          parsed.amount !== undefined
                            ? `${parsed.currency ?? ""} ${parsed.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                            : undefined
                        }
                      />
                      <FieldRow
                        label="Instructed amount (:33B:)"
                        value={
                          parsed.instructedAmount !== undefined
                            ? `${parsed.instructedCurrency ?? ""} ${parsed.instructedAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                            : undefined
                        }
                      />
                      <FieldRow label="Sender BIC (block 1)" value={parsed.basicHeader?.senderBic} />
                      <FieldRow label="Ordering customer (:50a:)" value={partyToString(parsed.orderingCustomer)} />
                      <FieldRow label="Ordering institution (:52a:)" value={partyToString(parsed.orderingInstitution)} />
                      <FieldRow label="Account with inst. (:57a:)" value={partyToString(parsed.accountWithInstitution)} />
                      <FieldRow label="Beneficiary inst. (:58a:)" value={partyToString(parsed.beneficiaryInstitution)} />
                      <FieldRow label="Beneficiary (:59a:)" value={partyToString(parsed.beneficiary)} />
                      <FieldRow label="Remittance (:70:)" value={parsed.remittanceInfo} />
                      <FieldRow label="Charges (:71A:)" value={parsed.chargesDetail} />
                      <FieldRow label="Sender→receiver (:72:)" value={parsed.senderToReceiverInfo} />
                      <FieldRow label="Free format (:79:)" value={parsed.freeFormatText} />
                      {parsed.guarantee && (
                        <>
                          <FieldRow label="Undertaking form (:22D:)" value={parsed.guarantee.form} />
                          <FieldRow label="Purpose (:22A:)" value={parsed.guarantee.purpose} />
                          <FieldRow label="Applicable rules (:40C:)" value={parsed.guarantee.applicableRules} />
                          <FieldRow label="Issue date (:30:)" value={parsed.guarantee.issueDate} />
                          <FieldRow label="Expiry date (:31E:)" value={parsed.guarantee.expiryDate} />
                          <FieldRow
                            label="Undertaking amount (:32B:)"
                            value={
                              parsed.guarantee.amount !== undefined
                                ? `${parsed.guarantee.currency ?? ""} ${parsed.guarantee.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                                : undefined
                            }
                          />
                          <FieldRow label="Applicant (:50:)" value={partyToString(parsed.guarantee.applicant)} />
                          <FieldRow label="Undertaking beneficiary (:59:)" value={partyToString(parsed.guarantee.beneficiary)} />
                          <FieldRow label="Terms (:77C:)" value={parsed.guarantee.terms} />
                        </>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="json">
                    <div className="relative">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copy(JSON.stringify(parsed, null, 2), "Parsed JSON copied")}
                        className="absolute right-2 top-2 gap-1.5 bg-transparent"
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </Button>
                      <pre className="max-h-[420px] overflow-auto rounded-md bg-muted/50 p-4 text-xs leading-relaxed">
                        {JSON.stringify(parsed, null, 2)}
                      </pre>
                    </div>
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>

      {/* ---------------- Reconcile ---------------- */}
      <TabsContent value="ingest" className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ingest into reconciliation</CardTitle>
            <CardDescription>
              Parse the message in the Inspect tab, then push the extracted payment to the reconciliation engine. It is
              matched against active gateway accounts and auto-credited on a confident match.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!parsed && (
              <p className="rounded-md bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
                Paste a message in the Inspect tab first.
              </p>
            )}
            {parsed && !parsed.valid && (
              <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> This message failed validation and cannot be
                ingested. Fix the errors shown in the Inspect tab.
              </p>
            )}
            {parsed && parsed.valid && parsed.type === "MT799" && (
              <p className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> MT799 is free-format and has no settlement amount,
                so it cannot be reconciled — use it for correspondence / audit only.
              </p>
            )}
            {extract && parsed?.type !== "MT799" && (
              <div className="flex flex-col rounded-lg border border-border bg-muted/30 p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Extracted payment to be reconciled
                </p>
                <FieldRow
                  label="Amount"
                  value={
                    extract.amount !== undefined
                      ? `${extract.currency ?? ""} ${extract.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                      : undefined
                  }
                />
                <FieldRow label="Payer" value={extract.payer} />
                <FieldRow label="Matching reference" value={extract.reference} />
                <FieldRow label="Sender IBAN" value={extract.senderIban} />
                <FieldRow label="Sender BIC" value={extract.senderBic} />
                <FieldRow label="UETR" value={extract.uetr} />
              </div>
            )}
            <div>
              <Button
                onClick={handleIngest}
                disabled={ingesting || !parsed?.valid || parsed?.type === "MT799"}
                className="gap-2"
              >
                {ingesting && <Loader2 className="h-4 w-4 animate-spin" />}
                <ArrowDownToLine className="h-4 w-4" /> Ingest &amp; reconcile
              </Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* ---------------- Generate ---------------- */}
      <TabsContent value="generate" className="flex flex-col gap-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compose outbound message</CardTitle>
              <CardDescription>
                Generate a well-formed payment (MT103/MT202) or instrument message (MT760/MT799) with a gpi UETR.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label>Message type</Label>
                  <Select
                    value={gen.type}
                    onValueChange={(v) =>
                      setGen((g) => ({ ...g, type: v as "MT103" | "MT202" | "MT760" | "MT799" }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MT103">MT103 — Customer transfer</SelectItem>
                      <SelectItem value="MT202">MT202 — Institution transfer</SelectItem>
                      <SelectItem value="MT760">MT760 — Guarantee / SBLC</SelectItem>
                      <SelectItem value="MT799">MT799 — Free format / RWA</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="g-ref">Sender reference (:20:)</Label>
                  <Input
                    id="g-ref"
                    value={gen.senderReference}
                    onChange={(e) => setGen((g) => ({ ...g, senderReference: e.target.value }))}
                    maxLength={16}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="g-sbic">Sender BIC</Label>
                  <Input
                    id="g-sbic"
                    value={gen.senderBic}
                    onChange={(e) => setGen((g) => ({ ...g, senderBic: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="g-rbic">Receiver BIC</Label>
                  <Input
                    id="g-rbic"
                    value={gen.receiverBic}
                    onChange={(e) => setGen((g) => ({ ...g, receiverBic: e.target.value }))}
                  />
                </div>
                {(gen.type === "MT202" || gen.type === "MT760" || gen.type === "MT799") && (
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="g-rel">Related reference ({gen.type === "MT760" ? ":23:" : ":21:"})</Label>
                    <Input
                      id="g-rel"
                      value={gen.relatedReference}
                      onChange={(e) => setGen((g) => ({ ...g, relatedReference: e.target.value }))}
                      maxLength={16}
                    />
                  </div>
                )}

                {/* MT799 — free-format narrative only */}
                {gen.type === "MT799" && (
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="g-narr">Free-format narrative (:79:)</Label>
                    <Textarea
                      id="g-narr"
                      rows={5}
                      value={gen.narrative}
                      onChange={(e) => setGen((g) => ({ ...g, narrative: e.target.value }))}
                    />
                  </div>
                )}

                {/* MT760 — undertaking form / purpose / rules */}
                {gen.type === "MT760" && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label>Form of undertaking (:22D:)</Label>
                      <Select
                        value={gen.form}
                        onValueChange={(v) => setGen((g) => ({ ...g, form: v as "STBY" | "DGAR" }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="STBY">STBY — Standby Letter of Credit</SelectItem>
                          <SelectItem value="DGAR">DGAR — Demand Guarantee</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="g-purpose">Purpose (:22A:)</Label>
                        <Input
                          id="g-purpose"
                          value={gen.purpose}
                          onChange={(e) => setGen((g) => ({ ...g, purpose: e.target.value }))}
                          maxLength={4}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="g-rules">Rules (:40C:)</Label>
                        <Input
                          id="g-rules"
                          value={gen.applicableRules}
                          onChange={(e) => setGen((g) => ({ ...g, applicableRules: e.target.value }))}
                        />
                      </div>
                    </div>
                  </>
                )}

                {/* Dates: payments use value date; MT760 uses issue + expiry */}
                {gen.type !== "MT799" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="g-date">{gen.type === "MT760" ? "Issue date (:30:)" : "Value date"}</Label>
                    <Input
                      id="g-date"
                      type="date"
                      value={gen.valueDate}
                      onChange={(e) => setGen((g) => ({ ...g, valueDate: e.target.value }))}
                    />
                  </div>
                )}
                {gen.type === "MT760" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="g-exp">Expiry date (:31E:)</Label>
                    <Input
                      id="g-exp"
                      type="date"
                      value={gen.expiryDate}
                      onChange={(e) => setGen((g) => ({ ...g, expiryDate: e.target.value }))}
                    />
                  </div>
                )}

                {/* Currency + amount for payments and the MT760 undertaking */}
                {gen.type !== "MT799" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="g-ccy">Currency</Label>
                      <Input
                        id="g-ccy"
                        value={gen.currency}
                        onChange={(e) => setGen((g) => ({ ...g, currency: e.target.value }))}
                        maxLength={3}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="g-amt">{gen.type === "MT760" ? "Undertaking amount (:32B:)" : "Amount"}</Label>
                      <Input
                        id="g-amt"
                        inputMode="decimal"
                        value={gen.amount}
                        onChange={(e) => setGen((g) => ({ ...g, amount: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                {/* Ordering / applicant + beneficiary for payments and MT760 */}
                {gen.type !== "MT799" && (
                  <>
                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <Label htmlFor="g-oacct">
                        {gen.type === "MT103"
                          ? "Ordering customer"
                          : gen.type === "MT760"
                            ? "Applicant (:50:)"
                            : "Ordering institution"}
                      </Label>
                      <Input
                        id="g-oacct"
                        placeholder="Account / IBAN"
                        value={gen.orderingAccount}
                        onChange={(e) => setGen((g) => ({ ...g, orderingAccount: e.target.value }))}
                      />
                      <Input
                        placeholder="Name"
                        value={gen.orderingName}
                        onChange={(e) => setGen((g) => ({ ...g, orderingName: e.target.value }))}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <Label htmlFor="g-bacct">
                        {gen.type === "MT103"
                          ? "Beneficiary customer"
                          : gen.type === "MT760"
                            ? "Beneficiary of undertaking (:59:)"
                            : "Beneficiary institution"}
                      </Label>
                      <Input
                        id="g-bacct"
                        placeholder="Account / IBAN"
                        value={gen.beneficiaryAccount}
                        onChange={(e) => setGen((g) => ({ ...g, beneficiaryAccount: e.target.value }))}
                      />
                      <Input
                        placeholder="Name"
                        value={gen.beneficiaryName}
                        onChange={(e) => setGen((g) => ({ ...g, beneficiaryName: e.target.value }))}
                      />
                    </div>
                  </>
                )}

                {/* Remittance info for payments only */}
                {(gen.type === "MT103" || gen.type === "MT202") && (
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="g-rem">Remittance info</Label>
                    <Input
                      id="g-rem"
                      value={gen.remittanceInfo}
                      onChange={(e) => setGen((g) => ({ ...g, remittanceInfo: e.target.value }))}
                    />
                  </div>
                )}

                {/* MT760 terms & conditions */}
                {gen.type === "MT760" && (
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="g-terms">Terms &amp; conditions (:77C:)</Label>
                    <Textarea
                      id="g-terms"
                      rows={3}
                      value={gen.terms}
                      onChange={(e) => setGen((g) => ({ ...g, terms: e.target.value }))}
                    />
                  </div>
                )}

                {gen.type === "MT103" && (
                  <div className="flex flex-col gap-1.5">
                    <Label>Charges (:71A:)</Label>
                    <Select
                      value={gen.chargesDetail}
                      onValueChange={(v) => setGen((g) => ({ ...g, chargesDetail: v as "OUR" | "BEN" | "SHA" }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OUR">OUR</SelectItem>
                        <SelectItem value="BEN">BEN</SelectItem>
                        <SelectItem value="SHA">SHA</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <Button onClick={handleGenerate} className="gap-2">
                <FileOutput className="h-4 w-4" /> Generate message
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Generated FIN</CardTitle>
                {generated && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copy(generated.raw, "SWIFT message copied")}
                      className="gap-1.5 bg-transparent"
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setRaw(generated.raw)} className="bg-transparent">
                      Send to Inspect
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!generated ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Compose a message to generate its FIN text.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">UETR</span>
                    <code className="break-all text-xs text-foreground">{generated.uetr}</code>
                  </div>
                  <pre className="max-h-[420px] overflow-auto rounded-md bg-muted/50 p-4 font-mono text-xs leading-relaxed">
                    {generated.raw}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  )
}
