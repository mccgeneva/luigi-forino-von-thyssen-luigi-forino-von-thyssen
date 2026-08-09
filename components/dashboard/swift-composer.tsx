"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  generateMt101,
  generateMt202Cov,
  generateSwiftMessage,
  generateFreeFormatMessage,
  generateDocumentaryCredit,
  generateMt760,
  generateGuaranteeAmendment,
  generateSecuritiesSettlement,
  parseSwiftMessage,
} from "@/lib/swift-mt"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { VerifiedBankField } from "@/components/verified-bank-field"
import {
  Banknote,
  SendHorizontal,
  Repeat2,
  MessageSquare,
  ScrollText,
  Shield,
  FileCode,
  FileText,
  Send,
  Copy,
  CheckCircle2,
  AlertTriangle,
  Layers,
} from "lucide-react"

// ---------------------------------------------------------------------------
// Message catalogue — EuroSwift 7.0 (SR 2025)
// ---------------------------------------------------------------------------

type MessageFamily =
  | "payment"
  | "freeformat"
  | "doccredit"
  | "guarantee"
  | "guarantee-amend"
  | "securities"

export interface MessageTypeDef {
  code: string
  name: string
  description: string
  category: string
  family: MessageFamily
}

export const SWIFT_MESSAGE_TYPES: MessageTypeDef[] = [
  // --- Category 1 — Customer Payments ---
  { code: "MT101", name: "Request for Transfer", description: "Request the receiver to execute one or more transfers debiting the ordering customer's account(s).", category: "Payments", family: "payment" },
  { code: "MT103", name: "Single Customer Credit Transfer", description: "Standard cross-border single customer credit transfer.", category: "Payments", family: "payment" },
  { code: "MT199", name: "Free Format (Customer)", description: "Free-format message for customer-related matters between financial institutions.", category: "Payments", family: "freeformat" },
  // --- Category 2 — Financial Institution Transfers ---
  { code: "MT202", name: "General FI Transfer", description: "General financial institution transfer (bank-to-bank).", category: "FI Transfers", family: "payment" },
  { code: "MT202COV", name: "Cover Payment", description: "Cover for an underlying customer credit transfer (sequence B).", category: "FI Transfers", family: "payment" },
  { code: "MT299", name: "Free Format (FI)", description: "Free-format message for financial-institution treasury matters.", category: "FI Transfers", family: "freeformat" },
  // --- Category 7 — Documentary Credits & Guarantees ---
  { code: "MT700", name: "Issue of a Documentary Credit", description: "Issuance of an irrevocable documentary letter of credit.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT707", name: "Amendment to a Documentary Credit", description: "Amend the terms and conditions of an issued documentary credit.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT710", name: "Advice of a Third Bank's DC", description: "Advise a documentary credit issued by a third bank.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT720", name: "Transfer of a Documentary Credit", description: "Transfer a documentary credit to a second beneficiary.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT730", name: "Acknowledgement", description: "Acknowledge receipt of a documentary credit message.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT740", name: "Authorisation to Reimburse", description: "Authorise a reimbursing bank to honour claims.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT742", name: "Reimbursement Claim", description: "Claim reimbursement under a documentary credit.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT747", name: "Amendment to Authorisation to Reimburse", description: "Amend an authorisation to reimburse.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT750", name: "Advice of Discrepancy", description: "Advise discrepancies in documents presented.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT752", name: "Authorisation to Pay/Accept", description: "Authorise payment, acceptance or negotiation under a DC.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT754", name: "Advice of Payment/Acceptance", description: "Advise payment, acceptance or negotiation of documents.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT756", name: "Advice of Reimbursement/Payment", description: "Advise reimbursement or payment of a drawing.", category: "Documentary Credits", family: "doccredit" },
  { code: "MT760", name: "Guarantee / SBLC", description: "Issuance of a demand guarantee or standby letter of credit.", category: "Guarantees", family: "guarantee" },
  { code: "MT767", name: "Guarantee / SBLC Amendment", description: "Amend an issued guarantee or standby letter of credit.", category: "Guarantees", family: "guarantee-amend" },
  { code: "MT768", name: "Ack. of Guarantee Amendment", description: "Acknowledge a guarantee or SBLC amendment.", category: "Guarantees", family: "guarantee-amend" },
  { code: "MT769", name: "Reduction or Release", description: "Advise reduction or release of liability under a guarantee.", category: "Guarantees", family: "guarantee-amend" },
  { code: "MT799", name: "Free Format (Bank)", description: "Free-format bank-to-bank message (RWA, POF, pre-advice).", category: "Guarantees", family: "freeformat" },
  // --- Category 5 — Securities Settlement ---
  { code: "MT540", name: "Receive Free", description: "Receive securities free of payment.", category: "Securities", family: "securities" },
  { code: "MT541", name: "Receive Against Payment", description: "Receive securities against payment (RVP).", category: "Securities", family: "securities" },
  { code: "MT542", name: "Deliver Free", description: "Deliver securities free of payment.", category: "Securities", family: "securities" },
  { code: "MT543", name: "Deliver Against Payment", description: "Deliver securities against payment (DVP).", category: "Securities", family: "securities" },
  { code: "MT544", name: "Receive Free Confirmation", description: "Confirm a receive-free settlement.", category: "Securities", family: "securities" },
  { code: "MT545", name: "Receive Against Payment Confirmation", description: "Confirm a receive-against-payment settlement.", category: "Securities", family: "securities" },
  { code: "MT546", name: "Deliver Free Confirmation", description: "Confirm a deliver-free settlement.", category: "Securities", family: "securities" },
  { code: "MT547", name: "Deliver Against Payment Confirmation", description: "Confirm a deliver-against-payment settlement.", category: "Securities", family: "securities" },
]

const CATEGORIES = ["Payments", "FI Transfers", "Documentary Credits", "Guarantees", "Securities"] as const

const familyIcon: Record<MessageFamily, typeof Banknote> = {
  payment: Banknote,
  freeformat: MessageSquare,
  doccredit: ScrollText,
  guarantee: Shield,
  "guarantee-amend": Shield,
  securities: Layers,
}

const familyAccent: Record<MessageFamily, { color: string; bg: string }> = {
  payment: { color: "text-emerald-400", bg: "bg-emerald-500/10" },
  freeformat: { color: "text-rose-400", bg: "bg-rose-500/10" },
  doccredit: { color: "text-amber-400", bg: "bg-amber-500/10" },
  guarantee: { color: "text-cyan-400", bg: "bg-cyan-500/10" },
  "guarantee-amend": { color: "text-cyan-400", bg: "bg-cyan-500/10" },
  securities: { color: "text-blue-400", bg: "bg-blue-500/10" },
}

const codeIcon: Partial<Record<string, typeof Banknote>> = {
  MT101: SendHorizontal,
  MT202COV: Repeat2,
  MT799: FileCode,
}

const CORRESPONDENT_BANKS = [
  { bic: "NWBKGB2L", name: "NatWest Bank" },
  { bic: "CHASUS33", name: "JP Morgan Chase" },
  { bic: "UBSWCHZH", name: "UBS Switzerland" },
  { bic: "DEUTDEFF", name: "Deutsche Bank" },
  { bic: "BNPAFRPP", name: "BNP Paribas" },
  { bic: "CITIUS33", name: "Citibank" },
  { bic: "MGTCBEBE", name: "Euroclear Bank" },
  { bic: "HSBCGB2L", name: "HSBC Bank" },
]

const SENDER_BIC = "MCCBCHZZ"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "AED", "JPY"]

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  receiverBic: string
  reference: string
  relatedReference: string
  valueDate: string
  currency: string
  amount: string
  orderingName: string
  orderingAccount: string
  beneficiaryName: string
  beneficiaryAccount: string
  beneficiaryBic: string
  remittance: string
  charges: "OUR" | "BEN" | "SHA"
  narrative: string
  // doc credit
  formOfCredit: string
  issueDate: string
  expiryDate: string
  expiryPlace: string
  goodsDescription: string
  documentsRequired: string
  // guarantee
  guaranteeForm: "DGAR" | "STBY"
  terms: string
  purpose: string
  // securities
  isin: string
  securityDescription: string
  quantity: string
  settlementDate: string
  tradeDate: string
  agentBic: string
  safekeepingAccount: string
}

const EMPTY_FORM: FormState = {
  receiverBic: "",
  reference: "",
  relatedReference: "",
  valueDate: "",
  currency: "EUR",
  amount: "",
  orderingName: "",
  orderingAccount: "",
  beneficiaryName: "",
  beneficiaryAccount: "",
  beneficiaryBic: "",
  remittance: "",
  charges: "SHA",
  narrative: "",
  formOfCredit: "IRREVOCABLE",
  issueDate: "",
  expiryDate: "",
  expiryPlace: "",
  goodsDescription: "",
  documentsRequired: "",
  guaranteeForm: "STBY",
  terms: "",
  purpose: "ISSU",
  isin: "",
  securityDescription: "",
  quantity: "",
  settlementDate: "",
  tradeDate: "",
  agentBic: "",
  safekeepingAccount: "",
}

function bareMt(code: string): string {
  // "MT202COV" → "202", "MT700" → "700"
  if (code === "MT202COV") return "202"
  return code.replace(/^MT/, "")
}

/** Build a FIN string from the form for the selected message type. */
function buildFin(def: MessageTypeDef, f: FormState): { raw: string; uetr: string } {
  const amount = Number.parseFloat(f.amount.replace(/,/g, "")) || 0
  const ordering = { account: f.orderingAccount || undefined, nameAndAddress: f.orderingName ? f.orderingName.split("\n") : undefined }
  const beneficiary = {
    account: f.beneficiaryAccount || undefined,
    bic: f.beneficiaryBic || undefined,
    nameAndAddress: f.beneficiaryName ? f.beneficiaryName.split("\n") : undefined,
  }
  const common = { senderBic: SENDER_BIC, receiverBic: f.receiverBic || "XXXXXXXX", senderReference: f.reference || "REF" }

  switch (def.code) {
    case "MT101":
      return generateMt101({ ...common, executionDate: f.valueDate || isoToday(), currency: f.currency, amount, ordering, beneficiary, remittanceInfo: f.remittance || undefined, chargesDetail: f.charges })
    case "MT103":
      return generateSwiftMessage({ type: "MT103", ...common, valueDate: f.valueDate || isoToday(), currency: f.currency, amount, ordering, beneficiary, remittanceInfo: f.remittance || undefined, chargesDetail: f.charges })
    case "MT202":
      return generateSwiftMessage({ type: "MT202", ...common, relatedReference: f.relatedReference || undefined, valueDate: f.valueDate || isoToday(), currency: f.currency, amount, ordering: { bic: f.beneficiaryBic || SENDER_BIC }, beneficiary, remittanceInfo: f.remittance || undefined })
    case "MT202COV":
      return generateMt202Cov({ ...common, relatedReference: f.relatedReference || "RELATED", valueDate: f.valueDate || isoToday(), currency: f.currency, amount, beneficiaryInstitution: { bic: f.beneficiaryBic || undefined }, orderingCustomer: ordering, beneficiaryCustomer: beneficiary, remittanceInfo: f.remittance || undefined })
  }

  if (def.family === "freeformat") {
    return generateFreeFormatMessage({ mt: bareMt(def.code), ...common, relatedReference: f.relatedReference || undefined, narrative: f.narrative || "" })
  }

  if (def.family === "doccredit") {
    return generateDocumentaryCredit({
      mt: bareMt(def.code),
      ...common,
      relatedReference: f.relatedReference || undefined,
      formOfCredit: f.formOfCredit || undefined,
      issueDate: f.issueDate || undefined,
      expiryDate: f.expiryDate || undefined,
      expiryPlace: f.expiryPlace || undefined,
      currency: f.currency,
      amount: amount || undefined,
      applicant: ordering,
      beneficiary,
      goodsDescription: f.goodsDescription || undefined,
      documentsRequired: f.documentsRequired || undefined,
      narrative: f.narrative || undefined,
    })
  }

  if (def.code === "MT760") {
    return generateMt760({
      ...common,
      purpose: f.purpose || undefined,
      form: f.guaranteeForm,
      issueDate: f.issueDate || undefined,
      expiryDate: f.expiryDate || undefined,
      currency: f.currency,
      amount,
      applicant: ordering,
      beneficiary,
      terms: f.terms || undefined,
    })
  }

  if (def.family === "guarantee-amend") {
    return generateGuaranteeAmendment({
      mt: bareMt(def.code),
      ...common,
      relatedReference: f.relatedReference || "ORIGINAL",
      purpose: f.purpose || undefined,
      date: f.issueDate || undefined,
      currency: f.currency,
      amount: amount || undefined,
      narrative: f.narrative || undefined,
    })
  }

  // securities
  return generateSecuritiesSettlement({
    mt: bareMt(def.code),
    ...common,
    tradeDate: f.tradeDate || undefined,
    settlementDate: f.settlementDate || undefined,
    isin: f.isin || undefined,
    securityDescription: f.securityDescription || undefined,
    quantity: f.quantity ? Number.parseFloat(f.quantity.replace(/,/g, "")) : undefined,
    currency: f.currency,
    settlementAmount: amount || undefined,
    agentBic: f.agentBic || undefined,
    safekeepingAccount: f.safekeepingAccount || undefined,
  })
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SwiftSentSummary {
  code: string
  name: string
  category: string
  uetr: string
  raw: string
  senderBic: string
  receiverBic: string
  amount: string | null
  currency: string | null
  reference: string | null
}

export interface SwiftComposerProps {
  /** Called when a message is generated and "sent". Receives a summary. */
  onSent?: (summary: SwiftSentSummary) => void
  /** Called when a draft is saved. */
  onSaveDraft?: (summary: { code: string; name: string }) => void
}

export function SwiftComposer({ onSent, onSaveDraft }: SwiftComposerProps) {
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [open, setOpen] = useState(false)
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const visibleTypes = useMemo(
    () => (categoryFilter === "all" ? SWIFT_MESSAGE_TYPES : SWIFT_MESSAGE_TYPES.filter((t) => t.category === categoryFilter)),
    [categoryFilter],
  )

  const activeDef = SWIFT_MESSAGE_TYPES.find((t) => t.code === activeCode) ?? null

  const generated = useMemo(() => {
    if (!activeDef) return null
    try {
      const { raw, uetr } = buildFin(activeDef, form)
      const parsed = parseSwiftMessage(raw)
      return { raw, uetr, parsed }
    } catch (err) {
      return { raw: "", uetr: "", parsed: null, error: (err as Error).message }
    }
  }, [activeDef, form])

  const set = (key: keyof FormState) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }))

  // Bank reality: the beneficiary's bank (:57a: Account With Institution) IS the
  // receiving institution. Selecting the Receiver BIC therefore also sets the
  // beneficiary BIC — they cannot legitimately differ in this direct flow.
  const setReceiver = (value: string) => setForm((prev) => ({ ...prev, receiverBic: value, beneficiaryBic: value }))

  // Warning when the entered beneficiary IBAN is held at a DIFFERENT bank than
  // the selected receiving institution (i.e. the account is not at the receiver).
  const [bicMismatch, setBicMismatch] = useState<string | null>(null)

  const beneficiaryBankName = CORRESPONDENT_BANKS.find((b) => b.bic === form.receiverBic)?.name ?? null

  const openCompose = (code: string) => {
    setActiveCode(code)
    setForm(EMPTY_FORM)
    setBicMismatch(null)
    setOpen(true)
  }

  const handleSend = () => {
    if (!activeDef || !generated?.parsed) return
    if (!generated.parsed.valid) {
      toast.error("Message has validation errors", {
        description: generated.parsed.errors[0] ?? "Review the generated FIN before sending.",
      })
      return
    }
    onSent?.({
      code: activeDef.code,
      name: activeDef.name,
      category: activeDef.category,
      uetr: generated.uetr,
      raw: generated.raw,
      senderBic: SENDER_BIC,
      receiverBic: form.receiverBic || "",
      amount: form.amount ? form.amount.replace(/,/g, "") : null,
      currency: form.currency || null,
      reference: form.reference || null,
    })
    setOpen(false)
  }

  const handleDraft = () => {
    if (!activeDef) return
    onSaveDraft?.({ code: activeDef.code, name: activeDef.name })
    toast.success("Draft saved", { description: "You can finish and send this message later." })
    setOpen(false)
  }

  const copyFin = () => {
    if (generated?.raw) {
      navigator.clipboard?.writeText(generated.raw)
      toast.success("FIN copied to clipboard")
    }
  }

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-foreground text-lg">Compose New Message</CardTitle>
              <CardDescription>Select a SWIFT MT message type to compose and generate FIN</CardDescription>
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-full sm:w-[200px] bg-background border-border text-foreground">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleTypes.map((type) => {
              const Icon = codeIcon[type.code] ?? familyIcon[type.family]
              const accent = familyAccent[type.family]
              return (
                <button
                  key={type.code}
                  onClick={() => openCompose(type.code)}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background p-3 text-left transition-all hover:border-primary/50 hover:bg-primary/5 min-h-[64px]"
                >
                  <div className={`rounded-lg ${accent.bg} p-2.5 shrink-0`}>
                    <Icon className={`h-5 w-5 ${accent.color}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{type.code}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">{type.name}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              Compose {activeDef?.code} — {activeDef?.name}
            </DialogTitle>
            <DialogDescription>{activeDef?.description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 py-2 lg:grid-cols-2">
            {/* Form */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-foreground">Sender BIC</Label>
                  <Input value={SENDER_BIC} disabled className="bg-muted border-border text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label className="text-foreground">Receiver BIC</Label>
                  <Select value={form.receiverBic} onValueChange={setReceiver}>
                    <SelectTrigger className="bg-background border-border text-foreground">
                      <SelectValue placeholder="Select bank" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      {CORRESPONDENT_BANKS.map((b) => (
                        <SelectItem key={b.bic} value={b.bic}>
                          {b.bic} — {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-foreground">Reference (:20:)</Label>
                  <Input value={form.reference} onChange={(e) => set("reference")(e.target.value)} placeholder="Your reference" maxLength={16} className="bg-background border-border text-foreground" />
                </div>
                {activeDef?.code !== "MT101" && activeDef?.code !== "MT103" && (
                  <div className="space-y-2">
                    <Label className="text-foreground">Related Ref (:21:)</Label>
                    <Input value={form.relatedReference} onChange={(e) => set("relatedReference")(e.target.value)} placeholder="Related reference" maxLength={16} className="bg-background border-border text-foreground" />
                  </div>
                )}
              </div>

              {/* Payment fields */}
              {activeDef?.family === "payment" && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Value Date</Label>
                      <Input type="date" value={form.valueDate} onChange={(e) => set("valueDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Currency</Label>
                      <Select value={form.currency} onValueChange={set("currency")}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Amount</Label>
                      <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Ordering Customer (:50:)</Label>
                    <Textarea value={form.orderingName} onChange={(e) => set("orderingName")(e.target.value)} placeholder="Name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <VerifiedBankField
                      id="beneficiary-account"
                      label="Beneficiary Account"
                      kind="iban"
                      lenient
                      value={form.beneficiaryAccount}
                      onChange={set("beneficiaryAccount")}
                      placeholder="IBAN / account"
                      inputClassName="bg-background border-border text-foreground"
                      onResolved={(info) => {
                        // The beneficiary's bank is the Receiver (:57a:). Verify the
                        // entered IBAN is actually held there; warn on a mismatch.
                        const ibanBic = info?.bic?.toUpperCase()
                        const receiver = form.receiverBic?.toUpperCase()
                        if (ibanBic && receiver && ibanBic.slice(0, 6) !== receiver.slice(0, 6)) {
                          setBicMismatch(
                            `This IBAN is held at ${info?.name ? `${info.name} (${ibanBic})` : ibanBic}, not the selected receiving bank (${receiver}). Confirm the receiver.`,
                          )
                        } else {
                          setBicMismatch(null)
                        }
                      }}
                    />
                    {bicMismatch && (
                      <p className="flex items-start gap-1.5 text-xs text-amber-500">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{bicMismatch}</span>
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-foreground">Beneficiary Bank (:57a:)</Label>
                    <Input
                      value={
                        form.receiverBic ? `${form.receiverBic}${beneficiaryBankName ? ` — ${beneficiaryBankName}` : ""}` : ""
                      }
                      disabled
                      placeholder="Set by the Receiver BIC above"
                      className="bg-muted border-border text-foreground"
                    />
                    <p className="text-xs text-muted-foreground">
                      The beneficiary&apos;s bank is the receiving institution (Receiver BIC). It always matches and is not
                      entered separately.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Beneficiary (:59:)</Label>
                    <Textarea value={form.beneficiaryName} onChange={(e) => set("beneficiaryName")(e.target.value)} placeholder="Name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Charges (:71A:)</Label>
                      <Select value={form.charges} onValueChange={(v) => set("charges")(v)}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          <SelectItem value="OUR">OUR</SelectItem>
                          <SelectItem value="BEN">BEN</SelectItem>
                          <SelectItem value="SHA">SHA</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Remittance (:70:)</Label>
                      <Input value={form.remittance} onChange={(e) => set("remittance")(e.target.value)} placeholder="Invoice / details" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                </>
              )}

              {/* Free-format fields */}
              {activeDef?.family === "freeformat" && (
                <div className="space-y-2">
                  <Label className="text-foreground">Narrative (:79:)</Label>
                  <Textarea value={form.narrative} onChange={(e) => set("narrative")(e.target.value)} placeholder="Free-format message content…" rows={8} className="bg-background border-border font-mono text-sm text-foreground resize-none" />
                </div>
              )}

              {/* Documentary credit fields */}
              {activeDef?.family === "doccredit" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Form of Credit (:40A:)</Label>
                      <Input value={form.formOfCredit} onChange={(e) => set("formOfCredit")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Issue Date (:31C:)</Label>
                      <Input type="date" value={form.issueDate} onChange={(e) => set("issueDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Expiry Date</Label>
                      <Input type="date" value={form.expiryDate} onChange={(e) => set("expiryDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Expiry Place</Label>
                      <Input value={form.expiryPlace} onChange={(e) => set("expiryPlace")(e.target.value)} placeholder="GENEVA" className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Currency</Label>
                      <Select value={form.currency} onValueChange={set("currency")}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Amount (:32B:)</Label>
                    <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" className="bg-background border-border text-foreground" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Applicant (:50:)</Label>
                    <Textarea value={form.orderingName} onChange={(e) => set("orderingName")(e.target.value)} placeholder="Applicant name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Beneficiary (:59:)</Label>
                    <Textarea value={form.beneficiaryName} onChange={(e) => set("beneficiaryName")(e.target.value)} placeholder="Beneficiary name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Goods Description (:45A:)</Label>
                    <Textarea value={form.goodsDescription} onChange={(e) => set("goodsDescription")(e.target.value)} placeholder="Description of goods / services" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Documents Required (:46A:)</Label>
                    <Textarea value={form.documentsRequired} onChange={(e) => set("documentsRequired")(e.target.value)} placeholder="Documents to be presented" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                </>
              )}

              {/* Guarantee issuance (MT760) */}
              {activeDef?.family === "guarantee" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Form (:22D:)</Label>
                      <Select value={form.guaranteeForm} onValueChange={(v) => set("guaranteeForm")(v)}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          <SelectItem value="DGAR">DGAR — Demand Guarantee</SelectItem>
                          <SelectItem value="STBY">STBY — Standby LC</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Purpose (:22A:)</Label>
                      <Input value={form.purpose} onChange={(e) => set("purpose")(e.target.value)} placeholder="ISSU" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Issue Date</Label>
                      <Input type="date" value={form.issueDate} onChange={(e) => set("issueDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Currency</Label>
                      <Select value={form.currency} onValueChange={set("currency")}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Amount (:32B:)</Label>
                      <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Expiry Date (:31E:)</Label>
                    <Input type="date" value={form.expiryDate} onChange={(e) => set("expiryDate")(e.target.value)} className="bg-background border-border text-foreground" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Applicant (:50:)</Label>
                    <Textarea value={form.orderingName} onChange={(e) => set("orderingName")(e.target.value)} placeholder="Applicant name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Beneficiary (:59:)</Label>
                    <Textarea value={form.beneficiaryName} onChange={(e) => set("beneficiaryName")(e.target.value)} placeholder="Beneficiary name and address" rows={2} className="bg-background border-border text-foreground resize-none" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Terms & Conditions (:77C:)</Label>
                    <Textarea value={form.terms} onChange={(e) => set("terms")(e.target.value)} placeholder="Undertaking terms" rows={3} className="bg-background border-border font-mono text-sm text-foreground resize-none" />
                  </div>
                </>
              )}

              {/* Guarantee amendment family */}
              {activeDef?.family === "guarantee-amend" && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Date (:30:)</Label>
                      <Input type="date" value={form.issueDate} onChange={(e) => set("issueDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Currency</Label>
                      <Select value={form.currency} onValueChange={set("currency")}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Amount (:32B:)</Label>
                      <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Narrative (:77U:)</Label>
                    <Textarea value={form.narrative} onChange={(e) => set("narrative")(e.target.value)} placeholder="Amendment / acknowledgement text" rows={5} className="bg-background border-border font-mono text-sm text-foreground resize-none" />
                  </div>
                </>
              )}

              {/* Securities settlement */}
              {activeDef?.family === "securities" && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Trade Date (:98A::TRAD:)</Label>
                      <Input type="date" value={form.tradeDate} onChange={(e) => set("tradeDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Settlement Date (:98A::SETT:)</Label>
                      <Input type="date" value={form.settlementDate} onChange={(e) => set("settlementDate")(e.target.value)} className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">ISIN (:35B:)</Label>
                      <Input value={form.isin} onChange={(e) => set("isin")(e.target.value)} placeholder="US0378331005" className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Quantity (:36B:)</Label>
                      <Input value={form.quantity} onChange={(e) => set("quantity")(e.target.value)} placeholder="Units" className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Security Description</Label>
                    <Input value={form.securityDescription} onChange={(e) => set("securityDescription")(e.target.value)} placeholder="Security name" className="bg-background border-border text-foreground" />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label className="text-foreground">Currency</Label>
                      <Select value={form.currency} onValueChange={set("currency")}>
                        <SelectTrigger className="bg-background border-border text-foreground">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {CURRENCIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Settle Amount (:19A:)</Label>
                      <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="0.00" className="bg-background border-border text-foreground" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground">Agent BIC (:95P:)</Label>
                      <Input value={form.agentBic} onChange={(e) => set("agentBic")(e.target.value)} placeholder="BIC" maxLength={11} className="bg-background border-border text-foreground" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground">Safekeeping Account (:97A:)</Label>
                    <Input value={form.safekeepingAccount} onChange={(e) => set("safekeepingAccount")(e.target.value)} placeholder="Account number" className="bg-background border-border text-foreground" />
                  </div>
                </>
              )}
            </div>

            {/* Live FIN preview */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-foreground flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-primary" />
                  Generated FIN
                </Label>
                <div className="flex items-center gap-2">
                  {generated?.parsed && (
                    <Badge
                      variant="outline"
                      className={
                        generated.parsed.valid
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      }
                    >
                      {generated.parsed.valid ? (
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                      ) : (
                        <AlertTriangle className="mr-1 h-3 w-3" />
                      )}
                      {generated.parsed.valid ? "Valid" : `${generated.parsed.errors.length} error(s)`}
                    </Badge>
                  )}
                  <Button variant="outline" size="sm" onClick={copyFin}>
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </Button>
                </div>
              </div>
              <pre className="rounded-lg border border-border bg-background p-3 text-xs font-mono text-foreground whitespace-pre-wrap break-all min-h-[280px] max-h-[420px] overflow-auto">
                {generated?.raw || "Fill in the form to generate FIN…"}
              </pre>
              {generated?.uetr && (
                <p className="text-xs text-muted-foreground">
                  UETR (gpi): <code className="text-primary">{generated.uetr}</code>
                </p>
              )}
              {generated?.parsed && !generated.parsed.valid && (
                <ul className="space-y-1 text-xs text-amber-400">
                  {generated.parsed.errors.map((e, i) => (
                    <li key={i}>• {e}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={handleDraft}>
              <FileText className="mr-2 h-4 w-4" />
              Save Draft
            </Button>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleSend}>
              <Send className="mr-2 h-4 w-4" />
              Send Message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
