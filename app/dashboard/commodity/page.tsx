"use client"

import Link from "next/link"
import { useMemo, useRef, useState } from "react"
import { DealVesselDocsView } from "@/components/commodity/deal-vessel-docs-view"
import {
  Ship,
  Building2,
  Clock,
  CheckCircle2,
  XCircle,
  FileText,
  ShieldCheck,
  ArrowRight,
  ArrowLeftRight,
  Info,
  Package,
  Banknote,
  Globe,
  Layers,
  History,
  Plus,
  Ban,
  PackageCheck,
  Loader2,
  Scale,
  Tag,
  Handshake,
  MessageSquare,
  Send,
  Share2,
  Eye,
  Trash2,
  Pencil,
  PauseCircle,
  PlayCircle,
  Lock,
  LockOpen,
  Upload,
  Sparkles,
  FileSignature,
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
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
import { useActivityLog } from "@/components/activity-tracker"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { CommodityQuotations } from "@/components/dashboard/commodity-quotations"
import { SpotDealsBoard } from "@/components/dashboard/spot-deals-board"
import { type SpotDeal } from "@/lib/spot-deals-shared"
import { useCurrentUser } from "@/lib/use-current-user"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generateFcoPdf, type FcoInput } from "@/lib/fco-pdf"
import {
  useCommodityDeals,
  DEAL_STAGES,
  POP_DOC_TYPES,
  POF_DOC_TYPES,
  type CommodityDeal,
  type DealCategory,
  type DealStage,
  type DocModule,
  type InstrumentType,
  type TradeStructure,
  type DealTerms,
  type DealHold,
} from "@/lib/commodity-deals-store"
import type { EditableDealTerms } from "@/app/actions/approvals"
import {
  PETROLEUM_PRODUCTS,
  COMMODITY_CATEGORIES,
  CUSTOM_COMMODITY_ID,
  getCatalogProduct,
  convertQuantity,
  bblPerMtFor,
  formatQuantityWithEquivalent,
  formatUnitPriceFor,
  parseQuantityString,
  type CommodityUnit,
} from "@/lib/petroleum-products"

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD"]

const CATEGORIES: { value: DealCategory; hint: string }[] = [
  { value: "Commodity Trade", hint: "Physical commodity purchase / sale (oil, metals, grain, etc.)" },
  { value: "Download of Funds", hint: "Institutional cash settlement via SWIFT" },
  { value: "DTC/IP Transfer", hint: "Securities / book-entry transfer" },
  { value: "Bank Instrument Monetization", hint: "SBLC / BG monetization" },
]

const TRADE_STRUCTURES: { value: TradeStructure; hint: string }[] = [
  { value: "FOB", hint: "Free On Board" },
  { value: "CIF", hint: "Cost, Insurance & Freight" },
  { value: "Spot", hint: "Single spot lift" },
  { value: "Long-term", hint: "Long-term supply contract" },
]

const INSTRUMENT_TYPES: InstrumentType[] = ["Cash", "SBLC", "BG", "Securities", "Commodity", "DLC"]

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

// Compact old → new diff for an amendment. Only the rows that actually changed
// show the arrow + new value, so the buyer/admin see exactly what is being
// renegotiated.
function AmendmentDiff({
  previous,
  proposed,
  currency,
}: {
  previous: DealTerms
  proposed: DealTerms
  currency: string
}) {
  const rows = [
    {
      label: "Value",
      from: formatCurrency(previous.approxValue, currency),
      to: formatCurrency(proposed.approxValue, currency),
      changed: Math.round(previous.approxValue * 100) !== Math.round(proposed.approxValue * 100),
    },
    {
      label: "Quantity",
      from: previous.quantity || "—",
      to: proposed.quantity || "—",
      changed: (previous.quantity || "") !== (proposed.quantity || ""),
    },
    {
      label: "Terms",
      from: previous.tradeStructure,
      to: proposed.tradeStructure,
      changed: previous.tradeStructure !== proposed.tradeStructure,
    },
  ]
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">{r.label}:</span>
          <span className={r.changed ? "text-muted-foreground line-through" : "text-foreground"}>{r.from}</span>
          {r.changed && (
            <>
              <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="font-medium text-foreground">{r.to}</span>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

const emptyDeal = {
  title: "",
  category: "Commodity Trade" as DealCategory,
  tradeStructure: "FOB" as TradeStructure,
  // Catalog selection drives the unit; commodity holds the resolved name.
  commodityId: "",
  commodity: "",
  quantityAmount: "",
  quantityUnit: "MT" as CommodityUnit,
  approxValue: "",
  currency: "USD",
  buyerName: "",
  sellerName: "",
  sendingBank: "",
  sendingBankBic: "",
  receivingBank: "",
  receivingBankBic: "",
  instrumentType: "Cash" as InstrumentType,
  originCountry: "",
  destinationCountry: "",
  mt103Ref: "",
  mt202Ref: "",
  mt799Ref: "",
  notes: "",
}

// Editable Full Corporate Offer draft. Only the commercial/party fields are
// editable — the transaction procedure and key conditions (incl. "no upfront
// fee to trade") are enforced by the PDF generator and never editable here.
const emptyFco: FcoInput = {
  sellerName: "",
  sellerAddress: "",
  sellerEmail: "",
  sellerAttn: "",
  buyerName: "",
  buyerAddress: "",
  buyerRegNo: "",
  buyerAttn: "",
  buyerEmail: "",
  transmittedVia: "",
  inResponseTo: "",
  product: "",
  specificationStandard: "",
  keyParameters: "",
  inspectionAgency: "",
  certification: "",
  trialQuantity: "",
  contractQuantity: "",
  contractDuration: "",
  deliveryTerm: "",
  loadPort: "",
  originsAvailable: "",
  paymentInstrument: "",
  incotermsVersion: "Incoterms 2020",
  offerValidityDays: 7,
  currency: "USD",
  unitPrice: "",
  trialCargoValue: "",
  contractPeriodValue: "",
  annualContractValue: "",
  originCountry: "",
  destinationCountry: "",
  governingLaw: "",
}

// Pull the leading numeric magnitude out of a quantity/value string like
// "50,000 MT" → "50,000" or "USD 24,250,000.00" → "24,250,000.00".
function leadingNumber(raw: string): string {
  const m = raw.replace(/[^\d.,]/g, " ").trim().match(/[\d][\d.,]*/)
  return m ? m[0].replace(/,+$/, "") : ""
}

function StatusBadge({ status }: { status: CommodityDeal["status"] }) {
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
  if (status === "cancelled") {
    return (
      <Badge variant="outline" className="border-muted-foreground/30 bg-muted text-muted-foreground text-[10px]">
        <Ban className="mr-1 h-3 w-3" />
        Revoked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-500 text-[10px]">
      <Clock className="mr-1 h-3 w-3" />
      Pending Review
    </Badge>
  )
}

function DocStatusBadge({ status }: { status: "submitted" | "verified" | "rejected" }) {
  if (status === "verified") {
    return (
      <Badge variant="outline" className="border-green-500/20 bg-green-500/10 text-green-500 text-[10px]">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Verified
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
    <Badge variant="outline" className="border-blue-500/20 bg-blue-500/10 text-blue-500 text-[10px]">
      <Clock className="mr-1 h-3 w-3" />
      Submitted
    </Badge>
  )
}

// Horizontal workflow stepper showing the standard commodity-trading sequence.
function WorkflowStepper({ deal }: { deal: CommodityDeal }) {
  const currentIndex = DEAL_STAGES.findIndex((s) => s.key === deal.stage)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {DEAL_STAGES.map((stage, i) => {
        const done = i < currentIndex || deal.status === "approved"
        const current = i === currentIndex && deal.status !== "approved"
        return (
          <div key={stage.key} className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                done && "border-green-500/30 bg-green-500/10 text-green-500",
                current && "border-blue-500/30 bg-blue-500/10 text-blue-500",
                !done && !current && "border-border bg-muted text-muted-foreground",
              )}
            >
              {done && <CheckCircle2 className="h-3 w-3" />}
              {stage.label}
            </span>
            {i < DEAL_STAGES.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        )
      })}
    </div>
  )
}

export default function CommodityTradingPage() {
  const logActivity = useActivityLog()
  const {
    deals,
    addDeal,
    addDocument,
    addDocumentVersion,
    setStage,
    revokeDeal,
    requestAmendment,
    addNegotiationNote,
    setDealHold,
    editDealTerms,
    deleteDeal,
    hydrated,
  } = useCommodityDeals()
  const user = useCurrentUser()
  const pdf = usePdfViewer()

  // Switch to the workflow tab and scroll a specific tracked deal into view.
  const openTrackedDeal = (dealId: string) => {
    setTab("workflow")
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        const el = document.getElementById(`deal-${dealId}`)
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
        else window.scrollTo({ top: 0, behavior: "smooth" })
      })
    }
  }

  // Allow deep-linking to a specific tab, e.g. the dashboard spot-deal tile
  // links to /dashboard/commodity?tab=spot. Read from the URL in the lazy
  // initializer (client component) to avoid a useSearchParams Suspense bail-out.
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "quotations"
    const requested = new URLSearchParams(window.location.search).get("tab")
    const valid = ["quotations", "spot", "workflow", "pop", "pof"]
    return requested && valid.includes(requested) ? requested : "quotations"
  })
  const [form, setForm] = useState({ ...emptyDeal })
  const [sendingBicValid, setSendingBicValid] = useState(false)
  const [receivingBicValid, setReceivingBicValid] = useState(false)
  // Revoke-confirmation dialog state.
  const [revokeTarget, setRevokeTarget] = useState<CommodityDeal | null>(null)
  const [revoking, setRevoking] = useState(false)
  // Negotiate / amend dialog state.
  const [amendTarget, setAmendTarget] = useState<CommodityDeal | null>(null)
  const [amendForm, setAmendForm] = useState({ value: "", quantity: "", tradeStructure: "FOB" as TradeStructure, reason: "" })
  const [amending, setAmending] = useState(false)
  // Negotiation-notes dialog state.
  const [notesTarget, setNotesTarget] = useState<CommodityDeal | null>(null)
  const [noteText, setNoteText] = useState("")
  const [counterpartyText, setCounterpartyText] = useState("")
  const [savingNote, setSavingNote] = useState(false)
  // Delete-confirmation dialog state.
  const [deleteTarget, setDeleteTarget] = useState<CommodityDeal | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Suspend/freeze/resume ("hold") dialog state.
  const [holdTarget, setHoldTarget] = useState<{ deal: CommodityDeal; next: DealHold["state"] | null } | null>(null)
  const [holdNote, setHoldNote] = useState("")
  const [holdWorking, setHoldWorking] = useState(false)
  // Edit-terms dialog state.
  const [editTarget, setEditTarget] = useState<CommodityDeal | null>(null)
  const [editForm, setEditForm] = useState({
    value: "",
    quantity: "",
    unitPrice: "",
    buyerName: "",
    sellerName: "",
    notes: "",
  })
  const [editing, setEditing] = useState(false)
  // LOI/ICPO import + FCO issuance state.
  const loiInputRef = useRef<HTMLInputElement>(null)
  const [extracting, setExtracting] = useState(false)
  const [loiSummary, setLoiSummary] = useState<string | null>(null)
  const [fco, setFco] = useState<FcoInput>({ ...emptyFco })
  const [showFco, setShowFco] = useState(false)
  const setFcoField = <K extends keyof FcoInput>(key: K, value: FcoInput[K]) =>
    setFco((prev) => ({ ...prev, [key]: value }))

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  // Selecting a catalog commodity auto-applies its canonical trading unit
  // (bbl for crude, MT for refined products) so the quantity is always quoted
  // in the correct unit. "Other" lets the user name a non-petroleum commodity
  // and pick the unit manually.
  const selectedCatalog =
    form.commodityId && form.commodityId !== CUSTOM_COMMODITY_ID
      ? getCatalogProduct(form.commodityId)
      : undefined
  const isCustomCommodity = form.commodityId === CUSTOM_COMMODITY_ID
  // The unit is locked to the catalog default unless the grade is dual-unit
  // (e.g. fuel oil / naphtha / condensate cargoes) or a custom commodity.
  const unitEditable = isCustomCommodity || !!selectedCatalog?.dualUnit

  const handleCommoditySelect = (id: string) => {
    if (id === CUSTOM_COMMODITY_ID) {
      setForm((prev) => ({ ...prev, commodityId: id, commodity: "", quantityUnit: "MT" }))
      return
    }
    const product = getCatalogProduct(id)
    if (!product) return
    setForm((prev) => ({
      ...prev,
      commodityId: id,
      commodity: product.name,
      quantityUnit: product.unit,
    }))
  }

  // Parsed numeric quantity (commas/spaces stripped) and the live bbl↔MT
  // converter. Conversion is density-driven, so the factor comes from the
  // selected grade (or its category default for custom commodities).
  const parsedQty = Number.parseFloat(form.quantityAmount.replace(/[, ]/g, ""))
  const hasQty = Number.isFinite(parsedQty) && parsedQty > 0
  const otherUnit: CommodityUnit = form.quantityUnit === "MT" ? "bbl" : "MT"
  const conversionFactor = bblPerMtFor(selectedCatalog)
  const convertedPreview = hasQty
    ? convertQuantity(parsedQty, form.quantityUnit, otherUnit, selectedCatalog)
    : 0

  const handleConvertUnit = () => {
    if (!hasQty) return
    const converted = convertQuantity(parsedQty, form.quantityUnit, otherUnit, selectedCatalog)
    // Round to a sensible precision: whole barrels, 3 decimals for tonnes.
    const rounded = otherUnit === "bbl" ? Math.round(converted) : Math.round(converted * 1000) / 1000
    setForm((prev) => ({
      ...prev,
      quantityAmount: rounded.toLocaleString("en-US"),
      quantityUnit: otherUnit,
    }))
  }

  // Deals shared with this client by an admin for visibility are READ-ONLY and
  // must not mix into the owner's own deals: they are excluded from the active
  // count, the workflow list, and document uploads, and shown in their own
  // section instead.
  const ownedDeals = useMemo(() => deals.filter((d) => !d.readOnly && !d.shared), [deals])
  const sharedDeals = useMemo(
    () =>
      deals
        .filter((d) => d.readOnly || d.shared)
        .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [deals],
  )

  const sortedDeals = useMemo(
    () => [...ownedDeals].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()),
    [ownedDeals],
  )

  // The Deals tab counter reflects only OPEN deals. A deal is deducted once it is
  // finalized — delivered (settled), revoked (cancelled), or rejected — leaving
  // only live deals in the count.
  const activeDealsCount = useMemo(
    () => sortedDeals.filter((d) => !d.delivered && d.status !== "cancelled" && d.status !== "rejected").length,
    [sortedDeals],
  )

  const resetForm = () => {
    setForm({ ...emptyDeal })
    setSendingBicValid(false)
    setReceivingBicValid(false)
  }

  // Engaging a published spot offer pre-fills the New Deal form from the offer
  // snapshot, switches to the Deal Workflow tab and scrolls it into view. The
  // user still reviews and submits — it then runs through the normal admin
  // approval + reserved-funds workflow. Nothing executes automatically.
  const handleEngageSpotDeal = (deal: SpotDeal, mode: "accepted" | "negotiate" = "negotiate") => {
    const dealNotes = [
      `${mode === "accepted" ? "Accepted (reserved)" : "Engaged"} limited-time spot deal ${deal.id} aboard ${deal.vesselName} (IMO ${deal.vesselImo}).`,
      deal.loadPort ? `Route: ${deal.loadPort}${deal.dischargePort ? ` → ${deal.dischargePort}` : ""}.` : "",
      deal.terms || "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim()

    // ACCEPTED �� auto-create a tracked commodity deal so the full workflow
    // (payment / instruments, POF, POP, reserved-funds hold on approval, delivery)
    // is immediately available. Idempotent: if a tracked deal already exists for
    // this cargo, just jump to it instead of creating a duplicate.
    if (mode === "accepted") {
      const existing = ownedDeals.find((d) => d.spotDealId === deal.id)
      if (existing) {
        openTrackedDeal(existing.id)
        return
      }
      const buyer = user.company?.trim() || user.fullName?.trim() || "Client account"
      const created = addDeal({
        spotDealId: deal.id,
        title: `${deal.product} — ${deal.quantity.toLocaleString("en-US")} ${deal.unit} ${deal.incoterm} (Spot ${deal.id})`,
        category: "Commodity Trade",
        tradeStructure: "Spot",
        commodity: deal.product,
        quantity: `${deal.quantity.toLocaleString("en-US")} ${deal.unit.toUpperCase()}`,
        approxValue: Math.round(deal.totalValue * 100) / 100,
        currency: deal.currency,
        buyerName: buyer,
        sellerName: "MCC Capital — Spot Desk",
        sendingBank: "",
        sendingBankBic: "",
        receivingBank: "",
        receivingBankBic: "",
        instrumentType: "Commodity",
        originCountry: deal.loadPort,
        destinationCountry: deal.dischargePort ?? "",
        mt103Ref: "",
        mt202Ref: "",
        mt799Ref: "",
        notes: dealNotes,
      })
      toast.success("Spot deal reserved — tracked deal created", {
        description: `${created.id} is now in your workflow. Register payment, upload POF/POP and track it through to delivery. It is pending Administrator review — nothing executes automatically.`,
      })
      logActivity({
        action: `Client accepted spot deal ${deal.id} → tracked commodity deal ${created.id}`,
        category: "Commodity Trading",
        details: {
          summary: `Client accepted limited-time spot deal ${deal.id} (${deal.product}, ${deal.quantity.toLocaleString("en-US")} ${deal.unit} aboard ${deal.vesselName} IMO ${deal.vesselImo}) and a tracked commodity deal ${created.id} valued ~${formatCurrency(created.approxValue, created.currency)} was created for Administrator review. UETR ${created.uetr}.`,
          referenceId: created.id,
          uetr: created.uetr,
          decision: "Pending",
        },
      })
      openTrackedDeal(created.id)
      return
    }

    // NEGOTIATE → pre-fill the deal form for the client to adjust terms and submit.
    const matched = deal.productId ? getCatalogProduct(deal.productId) : undefined
    setForm({
      ...emptyDeal,
      title: `${deal.product} — ${deal.quantity.toLocaleString("en-US")} ${deal.unit} ${deal.incoterm} (Spot ${deal.id})`,
      category: "Commodity Trade",
      tradeStructure: "Spot",
      commodityId: matched ? matched.id : CUSTOM_COMMODITY_ID,
      commodity: deal.product,
      quantityAmount: deal.quantity.toLocaleString("en-US"),
      quantityUnit: deal.unit,
      approxValue: deal.totalValue.toLocaleString("en-US"),
      currency: deal.currency,
      instrumentType: "Commodity",
      originCountry: deal.loadPort,
      destinationCountry: deal.dischargePort ?? "",
      notes: dealNotes,
    })
    setSendingBicValid(false)
    setReceivingBicValid(false)
    setTab("workflow")
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }))
    }
  }

  // Upload a buyer's LOI/ICPO, extract its data server-side, and pre-fill the
  // (fully editable) deal form + FCO draft. Nothing is executed automatically.
  const handleExtractLoi = async (file: File) => {
    setExtracting(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/commodity/extract-loi", { method: "POST", body: fd })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        data?: Record<string, string>
      }
      if (!res.ok || !json.ok || !json.data) {
        toast.error(json.error ?? "The document could not be read. Enter the deal details manually.")
        return
      }
      const d = json.data
      const g = (k: string) => (d[k] ?? "").trim()

      const dt = g("deliveryTerm").toUpperCase()
      const structure: TradeStructure = dt.includes("CIF")
        ? "CIF"
        : dt.includes("FOB")
          ? "FOB"
          : form.tradeStructure
      const unit: CommodityUnit = g("quantityUnit").toLowerCase() === "bbl" ? "bbl" : "MT"
      const qtyAmount = leadingNumber(g("trialQuantity")) || leadingNumber(g("contractQuantity"))
      const titleBits = [g("product"), g("trialQuantity"), g("deliveryTerm"), g("loadPort")].filter(Boolean)
      const sellerDefault = g("sellerName") || user.company?.trim() || user.fullName?.trim() || ""

      setForm((prev) => ({
        ...prev,
        title: titleBits.length ? titleBits.join(" — ") : prev.title,
        category: "Commodity Trade",
        tradeStructure: structure,
        commodityId: g("product") ? CUSTOM_COMMODITY_ID : prev.commodityId,
        commodity: g("product") || prev.commodity,
        quantityAmount: qtyAmount || prev.quantityAmount,
        quantityUnit: unit,
        approxValue: leadingNumber(g("totalValue")) || prev.approxValue,
        currency: g("currency") || prev.currency,
        buyerName: g("buyerName") || prev.buyerName,
        sellerName: sellerDefault || prev.sellerName,
        originCountry: g("originCountry") || g("loadPort") || prev.originCountry,
        destinationCountry: g("destinationCountry") || g("dischargePort") || prev.destinationCountry,
        notes: g("notes") || prev.notes,
      }))

      setFco((prev) => ({
        ...prev,
        sellerName: sellerDefault || prev.sellerName,
        buyerName: g("buyerName") || prev.buyerName,
        buyerAddress: g("buyerAddress") || prev.buyerAddress,
        buyerRegNo: g("buyerRegNo") || prev.buyerRegNo,
        buyerAttn: g("buyerAttn") || prev.buyerAttn,
        buyerEmail: g("buyerEmail") || prev.buyerEmail,
        inResponseTo: [g("documentType"), g("referenceNo"), g("referenceDate")].filter(Boolean).join(" ") || prev.inResponseTo,
        product: g("product") || prev.product,
        specificationStandard: g("specificationStandard") || prev.specificationStandard,
        keyParameters: g("keyParameters") || prev.keyParameters,
        inspectionAgency: g("inspectionAgency") || prev.inspectionAgency,
        trialQuantity: g("trialQuantity") || prev.trialQuantity,
        contractQuantity: g("contractQuantity") || prev.contractQuantity,
        contractDuration: g("contractDuration") || prev.contractDuration,
        deliveryTerm: g("deliveryTerm") || prev.deliveryTerm,
        loadPort: g("loadPort") || prev.loadPort,
        originsAvailable: g("originsAvailable") || prev.originsAvailable,
        paymentInstrument: g("paymentInstrument") || prev.paymentInstrument,
        currency: g("currency") || prev.currency,
        unitPrice: leadingNumber(g("unitPrice")) || prev.unitPrice,
        trialCargoValue: leadingNumber(g("totalValue")) || prev.trialCargoValue,
        originCountry: g("originCountry") || g("loadPort") || prev.originCountry,
        destinationCountry: g("destinationCountry") || g("dischargePort") || prev.destinationCountry,
      }))

      const kind = g("documentType") || "document"
      setLoiSummary(
        `Imported ${kind}${g("product") ? ` · ${g("product")}` : ""}${g("trialQuantity") ? ` · ${g("trialQuantity")}` : ""}. Review and adjust every field before submitting or issuing an FCO.`,
      )
      toast.success("Document imported", {
        description: "The deal fields were pre-filled from the LOI/ICPO. All fields remain editable.",
      })
      logActivity({
        action: `Client imported an ${kind} into the commodity desk`,
        category: "Commodity Trading",
        details: {
          summary: `Client uploaded a counterparty ${kind} and auto-extracted deal terms (${g("product") || "product n/a"}, ${g("trialQuantity") || "qty n/a"}). Fields pre-filled for review; nothing executed.`,
          decision: "Imported",
        },
      })
    } catch (err) {
      toast.error("The document could not be processed. Please try again.")
      console.log("[v0] LOI import error:", err instanceof Error ? err.message : String(err))
    } finally {
      setExtracting(false)
    }
  }

  // Open the FCO draft dialog, syncing the current deal-form values into the
  // offer so the latest edits carry through, while keeping FCO-only fields.
  const openFco = () => {
    const quantityStr = form.quantityAmount.trim()
      ? `${form.quantityAmount.trim()} ${form.quantityUnit.toUpperCase()}`
      : ""
    setFco((prev) => ({
      ...prev,
      sellerName: prev.sellerName || form.sellerName.trim() || user.company?.trim() || user.fullName?.trim() || "",
      buyerName: prev.buyerName || form.buyerName.trim(),
      product: prev.product || form.commodity.trim(),
      currency: form.currency,
      deliveryTerm: prev.deliveryTerm || form.tradeStructure,
      trialQuantity: prev.trialQuantity || quantityStr,
      trialCargoValue: prev.trialCargoValue || leadingNumber(form.approxValue),
      originCountry: prev.originCountry || form.originCountry.trim(),
      destinationCountry: prev.destinationCountry || form.destinationCountry.trim(),
    }))
    setShowFco(true)
  }

  const handleGenerateFco = () => {
    if (!fco.sellerName.trim() || !fco.buyerName.trim()) {
      toast.error("Seller and Buyer names are required to issue the FCO.")
      return
    }
    if (!fco.product.trim()) {
      toast.error("A product / grade is required to issue the FCO.")
      return
    }
    try {
      const generated = generateFcoPdf(fco)
      pdf.show(generated)
      toast.success("Full Corporate Offer generated", {
        description: "Preview, print or download the FCO. It follows the standard template — no upfront fee is charged to the buyer.",
      })
      logActivity({
        action: `Client issued a Full Corporate Offer for ${fco.product || "a commodity"}`,
        category: "Commodity Trading",
        details: {
          summary: `Client generated an FCO PDF — Seller ${fco.sellerName}, Buyer ${fco.buyerName}, ${fco.product || "product n/a"} ${fco.trialQuantity ? `(${fco.trialQuantity} trial)` : ""}. Standard template: inspection & title transfer precede payment; no buyer upfront fee.`,
          decision: "FCO issued",
        },
      })
      setShowFco(false)
    } catch (err) {
      toast.error("The FCO could not be generated.")
      console.log("[v0] FCO generation error:", err instanceof Error ? err.message : String(err))
    }
  }

  const handleSubmitDeal = () => {
    if (!form.title.trim()) {
      toast.error("Deal title is required")
      return
    }
    if (!form.buyerName.trim() || !form.sellerName.trim()) {
      toast.error("Both buyer and seller are required")
      return
    }
    const rawValue = Number.parseFloat(form.approxValue.replace(/,/g, ""))
    if (!Number.isFinite(rawValue) || rawValue <= 0) {
      toast.error("Enter a valid approximate value")
      return
    }
    // Money is settled in whole cents. Quantity × unit-price (often via a
    // BBL⇄MT conversion) can yield sub-cent fractions, so round to 2 decimals
    // before the value is reserved/blocked and emailed — never store raw floats.
    const value = Math.round(rawValue * 100) / 100
    if (form.sendingBankBic && !sendingBicValid) {
      toast.error("Sending bank BIC/SWIFT is invalid")
      return
    }
    if (form.receivingBankBic && !receivingBicValid) {
      toast.error("Receiving bank BIC/SWIFT is invalid")
      return
    }

    // Compose the stored quantity as "<amount> <unit>" using the unit resolved
    // from the selected commodity (e.g. "100,000 MT", "2,000,000 bbl").
    const commodityName = form.commodity.trim()
    const qtyAmount = form.quantityAmount.trim()
    const quantityStr = qtyAmount ? `${qtyAmount} ${form.quantityUnit.toUpperCase()}` : ""

    const deal = addDeal({
      title: form.title.trim(),
      category: form.category,
      tradeStructure: form.tradeStructure,
      commodity: commodityName,
      quantity: quantityStr,
      approxValue: value,
      currency: form.currency,
      buyerName: form.buyerName.trim(),
      sellerName: form.sellerName.trim(),
      sendingBank: form.sendingBank.trim(),
      sendingBankBic: form.sendingBankBic.trim().toUpperCase(),
      receivingBank: form.receivingBank.trim(),
      receivingBankBic: form.receivingBankBic.trim().toUpperCase(),
      instrumentType: form.instrumentType,
      originCountry: form.originCountry.trim(),
      destinationCountry: form.destinationCountry.trim(),
      mt103Ref: form.mt103Ref.trim(),
      mt202Ref: form.mt202Ref.trim(),
      mt799Ref: form.mt799Ref.trim(),
      notes: form.notes.trim(),
    })

    toast.success("Deal submitted for authorization", {
      description: `${deal.id} created. It is pending Administrator review — nothing executes automatically.`,
    })
    logActivity({
      action: `Client submitted commodity deal ${deal.id} (${formatCurrency(value, form.currency)})`,
      category: "Commodity Trading",
      details: {
        summary: `Client submitted ${form.category} deal ${deal.id} "${form.title}": ${commodityName || "—"} ${quantityStr ? `(${quantityStr})` : ""} valued ~${formatCurrency(value, form.currency)}. Buyer ${form.buyerName}, Seller ${form.sellerName}. Sending bank ${form.sendingBank || "—"} ${form.sendingBankBic ? `(${form.sendingBankBic})` : ""} → receiving bank ${form.receivingBank || "—"} ${form.receivingBankBic ? `(${form.receivingBankBic})` : ""}. Instrument ${form.instrumentType}. UETR ${deal.uetr}.`,
        referenceId: deal.id,
        uetr: deal.uetr,
        category: form.category,
        instrument: form.instrumentType,
        value: formatCurrency(value, form.currency),
        decision: "Pending",
      },
    })
    resetForm()
    setTab("workflow")
  }

  const handleAdvanceStage = (deal: CommodityDeal, stage: DealStage) => {
    const updated = setStage(deal.id, stage)
    if (!updated) return
    toast.success("Deal stage updated", {
      description: `${deal.id} moved to ${DEAL_STAGES.find((s) => s.key === stage)?.label}.`,
    })
    logActivity({
      action: `Client advanced commodity deal ${deal.id} to ${DEAL_STAGES.find((s) => s.key === stage)?.label}`,
      category: "Commodity Trading",
      details: {
        summary: `Client advanced deal ${deal.id} workflow to stage "${DEAL_STAGES.find((s) => s.key === stage)?.label}".`,
        referenceId: deal.id,
        uetr: deal.uetr,
      },
    })
  }

  const handleConfirmRevoke = async () => {
    const deal = revokeTarget
    if (!deal) return
    setRevoking(true)
    const res = await revokeDeal(deal.id)
    setRevoking(false)
    if (!res.ok) {
      toast.error(res.error ?? "The deal could not be revoked.")
      setRevokeTarget(null)
      return
    }
    toast.success("Deal revoked", {
      description: `${deal.id} was revoked and the reserved ${formatCurrency(deal.approxValue, deal.currency)} has been released back to your available balance.`,
    })
    logActivity({
      action: `Client revoked commodity deal ${deal.id} and released reserved funds`,
      category: "Commodity Trading",
      details: {
        summary: `Client revoked approved deal ${deal.id} "${deal.title}". Reserved funds (${formatCurrency(deal.approxValue, deal.currency)}) released back to the available balance.`,
        referenceId: deal.id,
        uetr: deal.uetr,
        decision: "Revoked",
      },
    })
    setRevokeTarget(null)
  }

  // Open the negotiate/amend dialog pre-filled with the deal's current terms.
  // The price field holds the UNIT price (per MT/BBL) — what traders renegotiate —
  // and the new total deal value is derived from unit price × quantity on submit.
  const openAmend = (deal: CommodityDeal) => {
    const parsedQty = parseQuantityString(deal.quantity)
    const currentUnitPrice =
      parsedQty && deal.approxValue ? Math.round((deal.approxValue / parsedQty.amount) * 100) / 100 : 0
    setAmendForm({
      value: currentUnitPrice > 0 ? String(currentUnitPrice) : "",
      quantity: deal.quantity ?? "",
      tradeStructure: deal.tradeStructure,
      reason: "",
    })
    setAmendTarget(deal)
  }

  const handleSubmitAmendment = async () => {
    const deal = amendTarget
    if (!deal) return
    const unitPrice = Number.parseFloat(amendForm.value.replace(/,/g, ""))
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      toast.error("Enter a valid unit price.")
      return
    }
    const parsedQty = parseQuantityString(amendForm.quantity)
    if (!parsedQty) {
      toast.error("Enter a valid quantity, e.g. 200,000 MT.")
      return
    }
    if (!amendForm.reason.trim()) {
      toast.error("Add a short reason for the amendment.")
      return
    }
    // Total deal value = unit price × quantity. This is what gets reserved.
    const value = Math.round(unitPrice * parsedQty.amount * 100) / 100
    const proposed: DealTerms = {
      approxValue: value,
      quantity: amendForm.quantity.trim(),
      tradeStructure: amendForm.tradeStructure,
      unitPrice,
    }
    setAmending(true)
    const res = await requestAmendment(deal.id, proposed, amendForm.reason.trim())
    setAmending(false)
    if (!res.ok) {
      toast.error(res.error ?? "The amendment could not be submitted.")
      return
    }
    toast.success("Amendment submitted", {
      description: `Your renegotiated terms for ${deal.id} are pending Administrator approval. Reserved funds adjust only once approved.`,
    })
    logActivity({
      action: `Client requested amendment of commodity deal ${deal.id}`,
      category: "Commodity Trading",
      details: {
        summary: `Client renegotiated deal ${deal.id} "${deal.title}": value ${formatCurrency(deal.approxValue, deal.currency)} → ${formatCurrency(value, deal.currency)}, quantity ${deal.quantity} → ${proposed.quantity}, terms ${deal.tradeStructure} → ${proposed.tradeStructure}. Pending admin approval. Reason: ${amendForm.reason.trim()}.`,
        referenceId: deal.id,
        uetr: deal.uetr,
        decision: "Amendment requested",
      },
    })
    setAmendTarget(null)
  }

  const openNotes = (deal: CommodityDeal) => {
    setNoteText("")
    setCounterpartyText(deal.counterpartyPosition ?? "")
    setNotesTarget(deal)
  }

  const handleSaveNote = async () => {
    const deal = notesTarget
    if (!deal) return
    if (!noteText.trim() && (counterpartyText.trim() === (deal.counterpartyPosition ?? "").trim())) {
      toast.error("Add a note or update the counterparty position.")
      return
    }
    setSavingNote(true)
    const res = await addNegotiationNote(deal.id, noteText.trim(), counterpartyText.trim())
    setSavingNote(false)
    if (!res.ok) {
      toast.error(res.error ?? "The note could not be saved.")
      return
    }
    toast.success("Negotiation log updated")
    setNoteText("")
    // Keep the dialog open with the (now persisted) latest data on next render.
    setNotesTarget((prev) => (prev ? { ...prev } : prev))
  }

  // --- Deal tools: delete / suspend / freeze / edit ------------------------

  const handleDelete = async () => {
    const deal = deleteTarget
    if (!deal) return
    setDeleting(true)
    const res = await deleteDeal(deal.id)
    setDeleting(false)
    if (!res.ok) {
      toast.error(res.error ?? "The deal could not be deleted.")
      return
    }
    toast.success("Deal deleted", {
      description:
        deal.status === "approved"
          ? `${deal.id} was deleted and the reserved ${formatCurrency(deal.approxValue, deal.currency)} released back to your available balance.`
          : `${deal.id} was permanently removed.`,
    })
    logActivity({
      action: `Client deleted commodity deal ${deal.id}`,
      category: "Commodity Trading",
      details: {
        summary: `Client deleted deal ${deal.id} "${deal.title}". Any reserved funds released back to the available balance.`,
        referenceId: deal.id,
        uetr: deal.uetr,
        decision: "Deleted",
      },
    })
    setDeleteTarget(null)
  }

  // Open the hold dialog for a suspend, freeze, or resume action.
  const openHold = (deal: CommodityDeal, next: DealHold["state"] | null) => {
    setHoldNote("")
    setHoldTarget({ deal, next })
  }

  const handleHold = async () => {
    if (!holdTarget) return
    const { deal, next } = holdTarget
    setHoldWorking(true)
    const res = await setDealHold(deal.id, next, holdNote.trim() || undefined)
    setHoldWorking(false)
    if (!res.ok) {
      toast.error(res.error ?? "The change could not be saved.")
      return
    }
    const verb = next === "frozen" ? "frozen" : next === "suspended" ? "suspended" : "resumed"
    toast.success(`Deal ${verb}`, {
      description:
        next === "frozen"
          ? `${deal.id} is locked — edits, revocation and deletion are blocked until you unfreeze it.`
          : next === "suspended"
            ? `${deal.id} is paused — the workflow and uploads are on hold until you resume it.`
            : `${deal.id} is active again.`,
    })
    logActivity({
      action: `Client ${verb} commodity deal ${deal.id}`,
      category: "Commodity Trading",
      details: { summary: `Client ${verb} deal ${deal.id} "${deal.title}".`, referenceId: deal.id, decision: verb },
    })
    setHoldTarget(null)
  }

  // Open the edit-terms dialog pre-filled with the deal's current terms. The
  // price field is the UNIT price (per MT/BBL); the total value is recomputed
  // server-side from unit price × quantity.
  const openEdit = (deal: CommodityDeal) => {
    const parsedQty = parseQuantityString(deal.quantity)
    const currentUnitPrice =
      parsedQty && deal.approxValue ? Math.round((deal.approxValue / parsedQty.amount) * 100) / 100 : 0
    setEditForm({
      value: deal.approxValue ? String(deal.approxValue) : "",
      quantity: deal.quantity ?? "",
      unitPrice: currentUnitPrice > 0 ? String(currentUnitPrice) : "",
      buyerName: deal.buyerName ?? "",
      sellerName: deal.sellerName ?? "",
      notes: deal.notes ?? "",
    })
    setEditTarget(deal)
  }

  const handleSubmitEdit = async () => {
    const deal = editTarget
    if (!deal) return
    const patch: EditableDealTerms = {
      quantity: editForm.quantity.trim() || undefined,
      buyerName: editForm.buyerName.trim() || undefined,
      sellerName: editForm.sellerName.trim() || undefined,
      notes: editForm.notes.trim() || undefined,
    }
    const unitPrice = Number.parseFloat(editForm.unitPrice.replace(/,/g, ""))
    if (Number.isFinite(unitPrice) && unitPrice > 0) patch.unitPrice = unitPrice
    const rawValue = Number.parseFloat(editForm.value.replace(/,/g, ""))
    if (Number.isFinite(rawValue) && rawValue > 0) patch.approxValue = rawValue
    if (!patch.unitPrice && !patch.approxValue) {
      toast.error("Enter a valid unit price or total value.")
      return
    }
    setEditing(true)
    const res = await editDealTerms(deal.id, patch)
    setEditing(false)
    if (!res.ok) {
      toast.error(res.error ?? "The change could not be saved.")
      return
    }
    toast.success("Deal terms updated")
    logActivity({
      action: `Client edited commodity deal ${deal.id} terms`,
      category: "Commodity Trading",
      details: { summary: `Client edited terms of deal ${deal.id} "${deal.title}".`, referenceId: deal.id, decision: "Edited" },
    })
    setEditTarget(null)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Ship className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold text-foreground">Commodity Trading Desk</h1>
        </div>
        <p className="max-w-3xl text-pretty text-sm text-muted-foreground">
          Structure high-value commodity and institutional transactions with full SWIFT/BIC routing,
          Proof of Product (seller) and Proof of Funds (buyer) document management, and a controlled
          deal workflow. Every deal is reviewed and authorized by the Administrator — nothing executes
          automatically.
        </p>
      </div>

      {/* Workflow explainer */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Info className="h-4 w-4 text-primary" />
            Standard transaction sequence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DEAL_STAGES.map((stage, i) => (
              <div key={stage.key} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{stage.label}</p>
                  <p className="text-xs text-muted-foreground text-pretty">{stage.description}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5">
          <TabsTrigger value="quotations" className="gap-1.5">
            <Globe className="h-4 w-4" />
            <span className="hidden sm:inline">Quotations</span>
            <span className="sm:hidden">Prices</span>
          </TabsTrigger>
          <TabsTrigger value="spot" className="gap-1.5">
            <Tag className="h-4 w-4" />
            <span className="hidden sm:inline">Spot Deals</span>
            <span className="sm:hidden">Spot</span>
          </TabsTrigger>
          <TabsTrigger value="workflow" className="gap-1.5">
            <Layers className="h-4 w-4" />
            <span className="hidden sm:inline">Deal Workflow</span>
            <span className="sm:hidden">Deals</span>
            {activeDealsCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {activeDealsCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pop" className="gap-1.5">
            <Package className="h-4 w-4" />
            <span className="hidden sm:inline">Proof of Product</span>
            <span className="sm:hidden">POP</span>
          </TabsTrigger>
          <TabsTrigger value="pof" className="gap-1.5">
            <Banknote className="h-4 w-4" />
            <span className="hidden sm:inline">Proof of Funds</span>
            <span className="sm:hidden">POF</span>
          </TabsTrigger>
        </TabsList>

        {/* QUOTATIONS TAB */}
        <TabsContent value="quotations">
          <CommodityQuotations />
        </TabsContent>

        {/* SPOT DEALS TAB */}
        <TabsContent value="spot">
          <SpotDealsBoard onEngage={handleEngageSpotDeal} onOpenTrackedDeal={openTrackedDeal} />
        </TabsContent>

        {/* DEAL WORKFLOW TAB */}
        <TabsContent value="workflow" className="space-y-6">
          {/* New deal form */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-semibold">New deal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Import a buyer LOI / ICPO and auto-fill the deal from it. */}
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Import from LOI / ICPO
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Upload the buyer&apos;s Letter of Intent or Purchase Order (PDF or image). The desk auto-extracts
                      the terms and pre-fills every field below — all remain editable.
                    </p>
                  </div>
                  <input
                    ref={loiInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ""
                      if (file) void handleExtractLoi(file)
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full shrink-0 gap-2 sm:w-auto"
                    disabled={extracting}
                    onClick={() => loiInputRef.current?.click()}
                  >
                    {extracting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Reading document…
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4" />
                        Upload LOI / ICPO
                      </>
                    )}
                  </Button>
                </div>
                {loiSummary && (
                  <p className="mt-3 flex items-start gap-2 rounded-md border border-primary/20 bg-background/60 p-2 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    {loiSummary}
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="title">Deal title *</Label>
                  <Input
                    id="title"
                    value={form.title}
                    onChange={(e) => set("title", e.target.value)}
                    placeholder="e.g. EN590 10ppm Diesel — 100,000 MT CIF Rotterdam"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={form.category} onValueChange={(v) => set("category", v as DealCategory)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {CATEGORIES.find((c) => c.value === form.category)?.hint}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Trade structure</Label>
                  <Select
                    value={form.tradeStructure}
                    onValueChange={(v) => set("tradeStructure", v as TradeStructure)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TRADE_STRUCTURES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.value} — {t.hint}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Commodity / asset</Label>
                  <Select value={form.commodityId} onValueChange={handleCommoditySelect}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a commodity" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {COMMODITY_CATEGORIES.map((cat) => (
                        <SelectGroup key={cat}>
                          <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {cat}
                          </SelectLabel>
                          {PETROLEUM_PRODUCTS.filter((p) => p.category === cat).map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name} · {p.unit.toUpperCase()}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                      <SelectGroup>
                        <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Other
                        </SelectLabel>
                        <SelectItem value={CUSTOM_COMMODITY_ID}>Other / custom commodity…</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {isCustomCommodity && (
                    <Input
                      id="commodity-custom"
                      value={form.commodity}
                      onChange={(e) => set("commodity", e.target.value)}
                      placeholder="e.g. Gold Bullion, Urea, Iron Ore"
                    />
                  )}
                  {selectedCatalog && (
                    <p className="text-xs text-muted-foreground">
                      Priced in{" "}
                      <span className="font-medium text-foreground">
                        {selectedCatalog.unit === "bbl" ? "barrels (BBL)" : "metric tonnes (MT)"}
                      </span>
                      {selectedCatalog.dualUnit ? " — may also trade in the alternate unit." : "."}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity / nominal</Label>
                  <div className="flex gap-2">
                    <Input
                      id="quantity"
                      className="flex-1"
                      inputMode="decimal"
                      value={form.quantityAmount}
                      onChange={(e) => set("quantityAmount", e.target.value)}
                      placeholder={form.quantityUnit === "bbl" ? "e.g. 2,000,000" : "e.g. 100,000"}
                    />
                    {unitEditable ? (
                      <Select
                        value={form.quantityUnit}
                        onValueChange={(v) => set("quantityUnit", v as CommodityUnit)}
                      >
                        <SelectTrigger className="w-28 shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="MT">MT</SelectItem>
                          <SelectItem value="bbl">BBL</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="flex w-28 shrink-0 items-center justify-center rounded-md border border-input bg-muted text-sm font-medium text-muted-foreground">
                        {form.quantityUnit.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleConvertUnit}
                      disabled={!hasQty}
                      className="h-8 gap-1.5"
                    >
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                      Convert to {otherUnit.toUpperCase()}
                    </Button>
                    {hasQty && (
                      <span className="text-xs text-muted-foreground">
                        ≈ {convertedPreview.toLocaleString("en-US", { maximumFractionDigits: otherUnit === "bbl" ? 0 : 3 })} {otherUnit.toUpperCase()}
                        <span className="ml-1 opacity-70">({conversionFactor} BBL/MT)</span>
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    BBL↔MT is approximate and density (API gravity) dependent; the factor shown is
                    typical for this grade.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="value">Approx. value *</Label>
                  <Input
                    id="value"
                    value={form.approxValue}
                    onChange={(e) => set("approxValue", e.target.value)}
                    placeholder="e.g. 75,000,000"
                    inputMode="decimal"
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

                <div className="space-y-2">
                  <Label htmlFor="buyer">Buyer *</Label>
                  <Input
                    id="buyer"
                    value={form.buyerName}
                    onChange={(e) => set("buyerName", e.target.value)}
                    placeholder="Buying entity / mandate"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="seller">Seller *</Label>
                  <Input
                    id="seller"
                    value={form.sellerName}
                    onChange={(e) => set("sellerName", e.target.value)}
                    placeholder="Selling entity / refinery"
                  />
                </div>
              </div>

              {/* Banking context */}
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                  <Building2 className="h-4 w-4 text-primary" />
                  Banking &amp; SWIFT context
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="sendingBank">Sending bank</Label>
                    <Input
                      id="sendingBank"
                      value={form.sendingBank}
                      onChange={(e) => set("sendingBank", e.target.value)}
                      placeholder="Buyer's bank"
                    />
                  </div>
                  <VerifiedBankField
                    id="sendingBic"
                    label="Sending bank BIC/SWIFT"
                    kind="bic"
                    value={form.sendingBankBic}
                    onChange={(v) => set("sendingBankBic", v)}
                    onValidChange={setSendingBicValid}
                    placeholder="e.g. CHASUS33 or CHASUS33XXX"
                    maxLength={11}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="receivingBank">Receiving bank</Label>
                    <Input
                      id="receivingBank"
                      value={form.receivingBank}
                      onChange={(e) => set("receivingBank", e.target.value)}
                      placeholder="Seller's bank"
                    />
                  </div>
                  <VerifiedBankField
                    id="receivingBic"
                    label="Receiving bank BIC/SWIFT"
                    kind="bic"
                    value={form.receivingBankBic}
                    onChange={(v) => set("receivingBankBic", v)}
                    onValidChange={setReceivingBicValid}
                    placeholder="e.g. DEUTDEFF or DEUTDEFFXXX"
                    maxLength={11}
                  />
                  <div className="space-y-2">
                    <Label>Instrument type</Label>
                    <Select
                      value={form.instrumentType}
                      onValueChange={(v) => set("instrumentType", v as InstrumentType)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INSTRUMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="origin">Origin country</Label>
                      <Input
                        id="origin"
                        value={form.originCountry}
                        onChange={(e) => set("originCountry", e.target.value)}
                        placeholder="e.g. UAE"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="destination">Destination</Label>
                      <Input
                        id="destination"
                        value={form.destinationCountry}
                        onChange={(e) => set("destinationCountry", e.target.value)}
                        placeholder="e.g. Netherlands"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="mt103">MT103 reference</Label>
                    <Input
                      id="mt103"
                      value={form.mt103Ref}
                      onChange={(e) => set("mt103Ref", e.target.value)}
                      placeholder="Single customer credit transfer"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mt202">MT202 / COV reference</Label>
                    <Input
                      id="mt202"
                      value={form.mt202Ref}
                      onChange={(e) => set("mt202Ref", e.target.value)}
                      placeholder="FI transfer / cover"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mt799">MT799 reference</Label>
                    <Input
                      id="mt799"
                      value={form.mt799Ref}
                      onChange={(e) => set("mt799Ref", e.target.value)}
                      placeholder="Free format / pre-advice"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder="Deal terms, inspection regime, delivery window, special conditions…"
                  rows={3}
                />
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                  Submitting creates a pending deal. The Administrator must authorize execution.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="outline" className="w-full sm:w-auto" onClick={resetForm}>
                    Clear
                  </Button>
                  <Button variant="secondary" className="w-full gap-2 sm:w-auto" onClick={openFco}>
                    <FileSignature className="h-4 w-4" />
                    Issue FCO
                  </Button>
                  <Button className="w-full sm:w-auto" onClick={handleSubmitDeal}>
                    Submit for Authorization
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Issue FCO dialog — editable draft, then generate the branded PDF */}
          <Dialog open={showFco} onOpenChange={setShowFco}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FileSignature className="h-5 w-5 text-primary" />
                  Issue Full Corporate Offer
                </DialogTitle>
                <DialogDescription>
                  Review and adapt the offer to your marketplace terms, then generate the FCO PDF. It follows the
                  standard template: inspection and title transfer precede payment, and no upfront fee is charged to the
                  buyer — those clauses are fixed and cannot be edited.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-5 py-1">
                {/* Seller */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">Seller</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-seller">Legal name *</Label>
                      <Input id="fco-seller" value={fco.sellerName} onChange={(e) => setFcoField("sellerName", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-seller-attn">Attn (name, title)</Label>
                      <Input id="fco-seller-attn" value={fco.sellerAttn} onChange={(e) => setFcoField("sellerAttn", e.target.value)} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="fco-seller-addr">Registered address</Label>
                      <Input id="fco-seller-addr" value={fco.sellerAddress} onChange={(e) => setFcoField("sellerAddress", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-seller-email">Email</Label>
                      <Input id="fco-seller-email" value={fco.sellerEmail} onChange={(e) => setFcoField("sellerEmail", e.target.value)} />
                    </div>
                  </div>
                </div>

                {/* Buyer */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">Buyer</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-buyer">Legal name *</Label>
                      <Input id="fco-buyer" value={fco.buyerName} onChange={(e) => setFcoField("buyerName", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-buyer-reg">Registration number</Label>
                      <Input id="fco-buyer-reg" value={fco.buyerRegNo} onChange={(e) => setFcoField("buyerRegNo", e.target.value)} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="fco-buyer-addr">Registered address</Label>
                      <Input id="fco-buyer-addr" value={fco.buyerAddress} onChange={(e) => setFcoField("buyerAddress", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-buyer-attn">Attn (name, title)</Label>
                      <Input id="fco-buyer-attn" value={fco.buyerAttn} onChange={(e) => setFcoField("buyerAttn", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-buyer-email">Email</Label>
                      <Input id="fco-buyer-email" value={fco.buyerEmail} onChange={(e) => setFcoField("buyerEmail", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-transmitted">Transmitted via</Label>
                      <Input id="fco-transmitted" value={fco.transmittedVia} onChange={(e) => setFcoField("transmittedVia", e.target.value)} placeholder="Intermediary, if any" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-inresponse">In response to</Label>
                      <Input id="fco-inresponse" value={fco.inResponseTo} onChange={(e) => setFcoField("inResponseTo", e.target.value)} placeholder="Buyer ICPO/LOI ref & date" />
                    </div>
                  </div>
                </div>

                {/* Product */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">Product specification</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-product">Product / grade *</Label>
                      <Input id="fco-product" value={fco.product} onChange={(e) => setFcoField("product", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-spec">Specification standard</Label>
                      <Input id="fco-spec" value={fco.specificationStandard} onChange={(e) => setFcoField("specificationStandard", e.target.value)} placeholder="e.g. ISO 8217" />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="fco-params">Key parameters</Label>
                      <Input id="fco-params" value={fco.keyParameters} onChange={(e) => setFcoField("keyParameters", e.target.value)} placeholder="Sulphur, density, flash point…" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-inspection">Inspection agency</Label>
                      <Input id="fco-inspection" value={fco.inspectionAgency} onChange={(e) => setFcoField("inspectionAgency", e.target.value)} placeholder="e.g. SGS" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-cert">Certification</Label>
                      <Input id="fco-cert" value={fco.certification} onChange={(e) => setFcoField("certification", e.target.value)} placeholder="Certificate of Origin…" />
                    </div>
                  </div>
                </div>

                {/* Commercial */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">Commercial terms</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-trialqty">Trial quantity</Label>
                      <Input id="fco-trialqty" value={fco.trialQuantity} onChange={(e) => setFcoField("trialQuantity", e.target.value)} placeholder="e.g. 50,000 MT" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-contractqty">Contract quantity</Label>
                      <Input id="fco-contractqty" value={fco.contractQuantity} onChange={(e) => setFcoField("contractQuantity", e.target.value)} placeholder="e.g. 100,000 MT x 12" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-duration">Contract duration</Label>
                      <Input id="fco-duration" value={fco.contractDuration} onChange={(e) => setFcoField("contractDuration", e.target.value)} placeholder="e.g. 12 months" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-delivery">Delivery term</Label>
                      <Input id="fco-delivery" value={fco.deliveryTerm} onChange={(e) => setFcoField("deliveryTerm", e.target.value)} placeholder="e.g. CIF" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-loadport">Load port</Label>
                      <Input id="fco-loadport" value={fco.loadPort} onChange={(e) => setFcoField("loadPort", e.target.value)} placeholder="e.g. Rotterdam" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-origins">Origins available</Label>
                      <Input id="fco-origins" value={fco.originsAvailable} onChange={(e) => setFcoField("originsAvailable", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-origin-country">Origin country</Label>
                      <Input id="fco-origin-country" value={fco.originCountry} onChange={(e) => setFcoField("originCountry", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-dest-country">Destination country</Label>
                      <Input id="fco-dest-country" value={fco.destinationCountry} onChange={(e) => setFcoField("destinationCountry", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-payment">Payment instrument</Label>
                      <Input id="fco-payment" value={fco.paymentInstrument} onChange={(e) => setFcoField("paymentInstrument", e.target.value)} placeholder="e.g. MT103 TT / SBLC / DLC" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-incoterms">Incoterms version</Label>
                      <Input id="fco-incoterms" value={fco.incotermsVersion} onChange={(e) => setFcoField("incotermsVersion", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Currency</Label>
                      <Select value={fco.currency} onValueChange={(v) => setFcoField("currency", v)}>
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
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-validity">Offer validity (days)</Label>
                      <Input
                        id="fco-validity"
                        inputMode="numeric"
                        value={String(fco.offerValidityDays)}
                        onChange={(e) => setFcoField("offerValidityDays", Math.max(1, Number.parseInt(e.target.value.replace(/\D/g, ""), 10) || 0))}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-unitprice">Unit price ({fco.currency})</Label>
                      <Input id="fco-unitprice" inputMode="decimal" value={fco.unitPrice} onChange={(e) => setFcoField("unitPrice", e.target.value)} placeholder="per MT / bbl" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-trialval">Trial cargo value ({fco.currency})</Label>
                      <Input id="fco-trialval" inputMode="decimal" value={fco.trialCargoValue} onChange={(e) => setFcoField("trialCargoValue", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-periodval">Contract period value ({fco.currency})</Label>
                      <Input id="fco-periodval" inputMode="decimal" value={fco.contractPeriodValue} onChange={(e) => setFcoField("contractPeriodValue", e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fco-annualval">Annual contract value ({fco.currency})</Label>
                      <Input id="fco-annualval" inputMode="decimal" value={fco.annualContractValue} onChange={(e) => setFcoField("annualContractValue", e.target.value)} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="fco-law">Governing law &amp; jurisdiction</Label>
                      <Input id="fco-law" value={fco.governingLaw} onChange={(e) => setFcoField("governingLaw", e.target.value)} placeholder="e.g. English law, courts of London" />
                    </div>
                  </div>
                </div>

                <p className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  Sections 4 (Transaction Procedure) and 6 (Key Commercial Conditions) are fixed by the standard template.
                  The offer explicitly requires no fee from the buyer before inspection, title transfer, or delivery.
                </p>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowFco(false)}>
                  Cancel
                </Button>
                <Button className="gap-2" onClick={handleGenerateFco}>
                  <FileText className="h-4 w-4" />
                  Generate FCO PDF
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Deal list */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base font-semibold">My deals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!hydrated ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              ) : sortedDeals.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <Ship className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No deals yet. Submit a deal above to begin the workflow.
                  </p>
                </div>
              ) : (
                sortedDeals.map((deal) => {
                  const nextStageIndex = DEAL_STAGES.findIndex((s) => s.key === deal.stage) + 1
                  const nextStage = DEAL_STAGES[nextStageIndex]
                  // A held (suspended/frozen) deal's workflow is paused.
                  const held = deal.hold?.state ?? null
                  const canAdvance =
                    deal.status === "pending" && nextStage && nextStage.key !== "execution" && !held
                  const popCount = deal.documents.filter((d) => d.module === "POP").length
                  const pofCount = deal.documents.filter((d) => d.module === "POF").length
                  // Deal-management tools apply to a client's own editable deals
                  // (never a read-only / shared-for-reference copy).
                  const canManage = !deal.readOnly && !deal.shared
                  // Terms are directly editable while the deal is NOT approved
                  // (approved deals hold reserved funds → use amendment instead),
                  // not delivered, and not frozen.
                  const canEditTerms =
                    canManage && !deal.delivered && held !== "frozen" && deal.status !== "approved"
                  return (
                    <div key={deal.id} id={`deal-${deal.id}`} className="scroll-mt-24 rounded-lg border border-border p-4">
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={deal.status} />
                          {held === "suspended" && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px]"
                            >
                              <PauseCircle className="mr-1 h-3 w-3" />
                              Suspended
                            </Badge>
                          )}
                          {held === "frozen" && (
                            <Badge
                              variant="outline"
                              className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px]"
                            >
                              <Lock className="mr-1 h-3 w-3" />
                              Frozen
                            </Badge>
                          )}
                          {deal.delivered && (
                            <Badge
                              variant="outline"
                              className="border-green-500/30 bg-green-500/10 text-green-500 text-[10px]"
                            >
                              <PackageCheck className="mr-1 h-3 w-3" />
                              Delivered
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px]">
                            {deal.category}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {deal.tradeStructure}
                          </Badge>
                          <span className="font-medium text-foreground">{deal.title}</span>
                          <span className="text-xs text-muted-foreground">{deal.id}</span>
                        </div>

                        <WorkflowStepper deal={deal} />

                        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                          <div className="flex items-center gap-2">
                            <Banknote className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Value:</span>
                            <span className="text-foreground">
                              {formatCurrency(deal.approxValue, deal.currency)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Commodity:</span>
                            <span className="text-foreground">{deal.commodity || "—"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Scale className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Quantity:</span>
                            <span className="text-foreground">
                              {formatQuantityWithEquivalent(deal.quantity, deal.commodity)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Tag className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Unit price:</span>
                            <span className="text-foreground">
                              {formatUnitPriceFor(deal.approxValue, deal.quantity, deal.currency) || "—"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Ship className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Terms:</span>
                            <span className="text-foreground">
                              {deal.tradeStructure}
                              {deal.originCountry ? ` · ${deal.originCountry}` : ""}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Layers className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Instrument:</span>
                            <span className="text-foreground">{deal.instrumentType}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Buyer:</span>
                            <span className="text-foreground">{deal.buyerName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Seller:</span>
                            <span className="text-foreground">{deal.sellerName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Route:</span>
                            <span className="text-foreground">
                              {deal.originCountry || "—"} → {deal.destinationCountry || "—"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">POP docs:</span>
                            <span className="text-foreground">{popCount}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Banknote className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">POF docs:</span>
                            <span className="text-foreground">{pofCount}</span>
                          </div>
                        </div>

                        {deal.status === "rejected" && deal.decisionNote && (
                          <p className="rounded-md border border-red-500/20 bg-red-500/5 p-2 text-xs text-red-500">
                            Rejection reason: {deal.decisionNote}
                          </p>
                        )}
                        {deal.status === "approved" && (
                          <p className="rounded-md border border-green-500/20 bg-green-500/5 p-2 text-xs text-green-500">
                            Authorized for execution{deal.decisionNote ? ` — ${deal.decisionNote}` : ""}. The deal
                            value is reserved (blocked) on your balance to settle the supplier. Cash settlement
                            proceeds via the Institutional Desk / Payments rails.
                          </p>
                        )}
                        {deal.status === "cancelled" && (
                          <p className="rounded-md border border-muted-foreground/20 bg-muted/40 p-2 text-xs text-muted-foreground">
                            This deal was revoked. The reserved funds were released back to your available balance.
                          </p>
                        )}

                        {/* Active hold banner — explains the paused / locked state. */}
                        {held && (
                          <div
                            className={cn(
                              "flex items-start gap-2 rounded-md border p-2 text-xs",
                              held === "frozen"
                                ? "border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400"
                                : "border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {held === "frozen" ? (
                              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            )}
                            <span>
                              {held === "frozen"
                                ? "This deal is frozen — edits, revocation and deletion are locked, and any reserved funds stay blocked until it is unfrozen."
                                : "This deal is suspended — its workflow and document uploads are paused until it is resumed."}
                              {deal.hold?.by === "admin" ? " (Placed by the Administrator.)" : ""}
                              {deal.hold?.note ? ` Note: ${deal.hold.note}` : ""}
                            </span>
                          </div>
                        )}

                        {/* Deal-management tools: edit / suspend / freeze / delete. */}
                        {canManage && (
                          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Deal tools
                            </span>
                            {canEditTerms && (
                              <Button size="sm" variant="outline" onClick={() => openEdit(deal)}>
                                <Pencil className="mr-1 h-3.5 w-3.5" />
                                Edit terms
                              </Button>
                            )}
                            {/* Suspend / Resume */}
                            {held === "suspended" ? (
                              <Button size="sm" variant="outline" onClick={() => openHold(deal, null)}>
                                <PlayCircle className="mr-1 h-3.5 w-3.5" />
                                Resume
                              </Button>
                            ) : held !== "frozen" && !deal.delivered ? (
                              <Button size="sm" variant="outline" onClick={() => openHold(deal, "suspended")}>
                                <PauseCircle className="mr-1 h-3.5 w-3.5" />
                                Suspend
                              </Button>
                            ) : null}
                            {/* Freeze / Unfreeze */}
                            {held === "frozen" ? (
                              <Button size="sm" variant="outline" onClick={() => openHold(deal, null)}>
                                <LockOpen className="mr-1 h-3.5 w-3.5" />
                                Unfreeze
                              </Button>
                            ) : held !== "suspended" && !deal.delivered ? (
                              <Button size="sm" variant="outline" onClick={() => openHold(deal, "frozen")}>
                                <Lock className="mr-1 h-3.5 w-3.5" />
                                Freeze
                              </Button>
                            ) : null}
                            {/* Delete — blocked while frozen. */}
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive"
                              onClick={() => setDeleteTarget(deal)}
                              disabled={held === "frozen"}
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" />
                              Delete
                            </Button>
                          </div>
                        )}

                        {deal.status === "approved" && (
                          <div className="flex flex-wrap items-center gap-2">
                            {deal.delivered ? (
                              <div className="flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/5 p-2 text-xs text-green-500">
                                <PackageCheck className="h-3.5 w-3.5" />
                                Delivered &amp; finalized — this deal is locked and can no longer be revoked.
                              </div>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openAmend(deal)}
                                  disabled={deal.pendingAmendment?.status === "pending" || !!held}
                                >
                                  <Handshake className="mr-1 h-3.5 w-3.5" />
                                  Negotiate / Amend
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => openNotes(deal)}>
                                  <MessageSquare className="mr-1 h-3.5 w-3.5" />
                                  Negotiation log
                                  {deal.negotiationNotes?.length ? (
                                    <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">
                                      {deal.negotiationNotes.length}
                                    </Badge>
                                  ) : null}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-destructive"
                                  onClick={() => setRevokeTarget(deal)}
                                  disabled={held === "frozen"}
                                >
                                  <Ban className="mr-1 h-3.5 w-3.5" />
                                  Cancel / Revoke deal
                                </Button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Pending amendment — old → new diff awaiting admin sign-off. */}
                        {deal.pendingAmendment?.status === "pending" && (
                          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                            <div className="mb-2 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                              <Handshake className="h-3.5 w-3.5" />
                              Amendment pending Administrator approval
                            </div>
                            <AmendmentDiff
                              previous={deal.pendingAmendment.previous}
                              proposed={deal.pendingAmendment.proposed}
                              currency={deal.currency}
                            />
                            <p className="mt-2 text-muted-foreground">
                              <span className="font-medium text-foreground">Reason:</span>{" "}
                              {deal.pendingAmendment.reason}
                            </p>
                            <p className="mt-1 text-muted-foreground">
                              Reserved funds will adjust to the new value once the amendment is approved.
                            </p>
                          </div>
                        )}

                        {canAdvance && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleAdvanceStage(deal, nextStage.key)}
                            >
                              <ArrowRight className="mr-1 h-3.5 w-3.5" />
                              Advance to {nextStage.label}
                            </Button>
                            <span className="text-xs text-muted-foreground">{nextStage.description}</span>
                          </div>
                        )}

                        {/* Vessel + administrator-issued deal documents (read-only). */}
                        <DealVesselDocsView vessel={deal.vessel} documents={deal.documents} />

                        <Accordion type="single" collapsible className="w-full">
                          <AccordionItem value="gpi" className="border-b-0">
                            <AccordionTrigger className="py-2 text-sm">
                              <span className="flex items-center gap-2">
                                <Globe className="h-4 w-4 text-primary" />
                                SWIFT gpi Tracker &amp; routing
                              </span>
                            </AccordionTrigger>
                            <AccordionContent>
                              <SwiftGpiTracker
                                payment={{
                                  uetr: deal.uetr,
                                  // Funds are only credited/delivered once the
                                  // deal is marked delivered. An approved-but-
                                  // not-delivered deal shows funds blocked on
                                  // behalf of the beneficiary, not credited.
                                  status:
                                    deal.status === "rejected"
                                      ? "failed"
                                      : deal.status !== "approved"
                                        ? "pending"
                                        : deal.delivered
                                          ? "completed"
                                          : "blocked",
                                  currency: deal.currency,
                                  beneficiaryBic: deal.receivingBankBic || undefined,
                                  beneficiaryName: deal.receivingBank || deal.sellerName,
                                  beneficiaryCountry: deal.destinationCountry || undefined,
                                  baseDate: deal.submittedAt,
                                  direction: "outgoing",
                                }}
                              />
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      </div>
                    </div>
                  )
                })
              )}
            </CardContent>
          </Card>

          {/* Read-only deals an administrator shared with this client for
              visibility. These are NOT actionable — no advance, revoke,
              amend, notes or document uploads — and never affect the balance. */}
          {hydrated && sharedDeals.length > 0 && (
            <Card className="border-primary/30 bg-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Share2 className="h-4 w-4 text-primary" />
                  Shared with you
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                    {sharedDeals.length}
                  </Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Deals shared by MCC Capital for your visibility. Read-only — for reference only, with no
                  effect on your balance.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {sharedDeals.map((deal) => (
                  <Link
                    key={deal.approvalId ?? deal.id}
                    href={
                      deal.approvalId
                        ? `/dashboard/commodity/shared/${encodeURIComponent(deal.approvalId)}`
                        : "#"
                    }
                    className="block rounded-lg border border-border bg-muted/30 p-4 transition-colors hover:border-primary/40 hover:bg-muted/50"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{deal.title}</p>
                          <StatusBadge status={deal.status} />
                          <Badge
                            variant="outline"
                            className="gap-1 border-primary/30 text-[10px] text-primary"
                          >
                            <Eye className="h-3 w-3" /> Read-only
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Shared by {deal.sharedFromName || "MCC Capital"}
                          {deal.sellerName ? ` · Seller: ${deal.sellerName}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-foreground">
                          {formatCurrency(deal.approxValue, deal.currency)}
                        </p>
                        {deal.quantity ? (
                          <p className="text-xs text-muted-foreground">{deal.quantity}</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                      {deal.commodity ? (
                        <div>
                          <span className="text-muted-foreground">Commodity</span>
                          <p className="truncate font-medium text-foreground">{deal.commodity}</p>
                        </div>
                      ) : null}
                      {deal.tradeStructure ? (
                        <div>
                          <span className="text-muted-foreground">Structure</span>
                          <p className="font-medium text-foreground">{deal.tradeStructure}</p>
                        </div>
                      ) : null}
                      {deal.originCountry || deal.destinationCountry ? (
                        <div>
                          <span className="text-muted-foreground">Route</span>
                          <p className="truncate font-medium text-foreground">
                            {deal.originCountry || "—"}
                            {deal.destinationCountry ? ` → ${deal.destinationCountry}` : ""}
                          </p>
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-1 text-xs font-medium text-primary">
                      View full deal, documents &amp; status
                      <ArrowRight className="h-3.5 w-3.5" />
                    </div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* PROOF OF PRODUCT TAB */}
        <TabsContent value="pop">
          <DocumentModule
            module="POP"
            title="Proof of Product"
            subtitle="Seller-provided evidence that the commodity exists and is available for sale."
            docTypes={POP_DOC_TYPES}
            deals={sortedDeals}
            hydrated={hydrated}
            addDocument={addDocument}
            addDocumentVersion={addDocumentVersion}
            logActivity={logActivity}
          />
        </TabsContent>

        {/* PROOF OF FUNDS TAB */}
        <TabsContent value="pof">
          <DocumentModule
            module="POF"
            title="Proof of Funds"
            subtitle="Buyer-provided evidence of funds or a banking instrument to settle the deal."
            docTypes={POF_DOC_TYPES}
            deals={sortedDeals}
            hydrated={hydrated}
            addDocument={addDocument}
            addDocumentVersion={addDocumentVersion}
            logActivity={logActivity}
            withSwiftRef
          />
        </TabsContent>
      </Tabs>

      {/* Revoke confirmation */}
      <Dialog open={revokeTarget !== null} onOpenChange={(o) => !o && !revoking && setRevokeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive" />
              Revoke commodity deal
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {revokeTarget ? (
                <>
                  This will cancel deal <span className="font-medium text-foreground">{revokeTarget.id}</span> (
                  {revokeTarget.title}) and release the reserved{" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(revokeTarget.approxValue, revokeTarget.currency)}
                  </span>{" "}
                  back to your available balance. This cannot be undone — you would need to submit a new deal to
                  proceed again.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              Keep deal
            </Button>
            <Button variant="destructive" onClick={handleConfirmRevoke} disabled={revoking}>
              {revoking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Ban className="mr-1 h-4 w-4" />}
              Revoke &amp; release funds
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete commodity deal
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {deleteTarget ? (
                <>
                  This permanently removes deal{" "}
                  <span className="font-medium text-foreground">{deleteTarget.id}</span> ({deleteTarget.title}).
                  {deleteTarget.status === "approved" ? (
                    <>
                      {" "}
                      The reserved{" "}
                      <span className="font-medium text-foreground">
                        {formatCurrency(deleteTarget.approxValue, deleteTarget.currency)}
                      </span>{" "}
                      will be released back to your available balance first.
                    </>
                  ) : null}{" "}
                  This cannot be undone.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Keep deal
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suspend / freeze / resume confirmation */}
      <Dialog open={holdTarget !== null} onOpenChange={(o) => !o && !holdWorking && setHoldTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {holdTarget?.next === "frozen" ? (
                <Lock className="h-4 w-4 text-sky-500" />
              ) : holdTarget?.next === "suspended" ? (
                <PauseCircle className="h-4 w-4 text-amber-500" />
              ) : (
                <PlayCircle className="h-4 w-4 text-primary" />
              )}
              {holdTarget?.next === "frozen"
                ? "Freeze deal"
                : holdTarget?.next === "suspended"
                  ? "Suspend deal"
                  : "Resume deal"}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {holdTarget?.next === "frozen"
                ? "Freezing locks all edits, revocation and deletion, and keeps any reserved funds blocked until you unfreeze it."
                : holdTarget?.next === "suspended"
                  ? "Suspending pauses the deal workflow and document uploads. You can resume it at any time."
                  : "This reactivates the deal and lifts the current hold."}
            </DialogDescription>
          </DialogHeader>
          {holdTarget?.next ? (
            <div className="space-y-1.5">
              <Label htmlFor="hold-note">Note (optional)</Label>
              <Textarea
                id="hold-note"
                value={holdNote}
                onChange={(e) => setHoldNote(e.target.value)}
                placeholder="Reason for placing this deal on hold…"
                rows={2}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHoldTarget(null)} disabled={holdWorking}>
              Cancel
            </Button>
            <Button onClick={handleHold} disabled={holdWorking}>
              {holdWorking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {holdTarget?.next === "frozen"
                ? "Freeze deal"
                : holdTarget?.next === "suspended"
                  ? "Suspend deal"
                  : "Resume deal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit deal terms (direct edit for non-approved deals) */}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && !editing && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-4 w-4 text-primary" />
              Edit deal terms
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Update the commercial terms for{" "}
              <span className="font-medium text-foreground">{editTarget?.id}</span>. The total value is recomputed
              from unit price × quantity.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-unit">
                    Unit price ({editTarget.currency} /{" "}
                    {parseQuantityString(editForm.quantity || editTarget.quantity)?.unit === "bbl" ? "BBL" : "MT"})
                  </Label>
                  <Input
                    id="edit-unit"
                    inputMode="decimal"
                    value={editForm.unitPrice}
                    onChange={(e) => setEditForm((p) => ({ ...p, unitPrice: e.target.value }))}
                    placeholder="e.g. 92.51"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-qty">Quantity</Label>
                  <Input
                    id="edit-qty"
                    value={editForm.quantity}
                    onChange={(e) => setEditForm((p) => ({ ...p, quantity: e.target.value }))}
                    placeholder="e.g. 500,000 BBL"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-buyer">Buyer</Label>
                  <Input
                    id="edit-buyer"
                    value={editForm.buyerName}
                    onChange={(e) => setEditForm((p) => ({ ...p, buyerName: e.target.value }))}
                    placeholder="Buyer name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-seller">Seller</Label>
                  <Input
                    id="edit-seller"
                    value={editForm.sellerName}
                    onChange={(e) => setEditForm((p) => ({ ...p, sellerName: e.target.value }))}
                    placeholder="Seller name"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-notes">Notes</Label>
                <Textarea
                  id="edit-notes"
                  value={editForm.notes}
                  onChange={(e) => setEditForm((p) => ({ ...p, notes: e.target.value }))}
                  placeholder="Optional notes"
                  rows={2}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Leave the unit price blank to keep the total value as entered. Approved deals can&apos;t be edited
                here — use Negotiate / Amend so reserved funds adjust with sign-off.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTarget(null)} disabled={editing}>
              Cancel
            </Button>
            <Button onClick={handleSubmitEdit} disabled={editing}>
              {editing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Pencil className="mr-1 h-4 w-4" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Negotiate / amend deal terms */}
      <Dialog open={amendTarget !== null} onOpenChange={(o) => !o && !amending && setAmendTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Handshake className="h-4 w-4 text-primary" />
              Negotiate / amend deal
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Propose revised commercial terms for{" "}
              <span className="font-medium text-foreground">{amendTarget?.id}</span>. The amendment is submitted to
              the Administrator for approval — the reserved funds only adjust once it is approved.
            </DialogDescription>
          </DialogHeader>
          {amendTarget ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="amend-value">
                    Unit price ({amendTarget.currency} /{" "}
                    {parseQuantityString(amendForm.quantity || amendTarget.quantity)?.unit === "bbl" ? "BBL" : "MT"})
                  </Label>
                  <Input
                    id="amend-value"
                    inputMode="decimal"
                    value={amendForm.value}
                    onChange={(e) => setAmendForm((p) => ({ ...p, value: e.target.value }))}
                    placeholder="e.g. 685.00"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="amend-qty">Quantity</Label>
                  <Input
                    id="amend-qty"
                    value={amendForm.quantity}
                    onChange={(e) => setAmendForm((p) => ({ ...p, quantity: e.target.value }))}
                    placeholder="e.g. 200,000 MT"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="amend-terms">Incoterms / trade structure</Label>
                <Select
                  value={amendForm.tradeStructure}
                  onValueChange={(v) => setAmendForm((p) => ({ ...p, tradeStructure: v as TradeStructure }))}
                >
                  <SelectTrigger id="amend-terms">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FOB">FOB — Free On Board</SelectItem>
                    <SelectItem value="CIF">CIF — Cost, Insurance &amp; Freight</SelectItem>
                    <SelectItem value="Spot">Spot</SelectItem>
                    <SelectItem value="Long-term">Long-term contract</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="amend-reason">Reason for amendment</Label>
                <Textarea
                  id="amend-reason"
                  value={amendForm.reason}
                  onChange={(e) => setAmendForm((p) => ({ ...p, reason: e.target.value }))}
                  placeholder="e.g. Renegotiated unit price after counterparty review of freight costs."
                  rows={3}
                />
              </div>
              {/* Live preview of the change. Total = unit price × quantity. */}
              {(() => {
                const proposedQty = amendForm.quantity || amendTarget.quantity
                const parsed = parseQuantityString(proposedQty)
                const unitPrice = Number.parseFloat(amendForm.value.replace(/,/g, "")) || 0
                const proposedTotal = parsed ? Math.round(unitPrice * parsed.amount * 100) / 100 : 0
                const unit = parsed?.unit === "bbl" ? "BBL" : "MT"
                return (
                  <div className="rounded-md border border-border bg-muted/40 p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Proposed change</p>
                    <AmendmentDiff
                      previous={{
                        approxValue: amendTarget.approxValue,
                        quantity: amendTarget.quantity,
                        tradeStructure: amendTarget.tradeStructure,
                      }}
                      proposed={{
                        approxValue: proposedTotal,
                        quantity: proposedQty,
                        tradeStructure: amendForm.tradeStructure,
                      }}
                      currency={amendTarget.currency}
                    />
                    <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
                      <span className="text-muted-foreground">
                        New total deal value ({formatCurrency(unitPrice, amendTarget.currency)} / {unit} ×{" "}
                        {parsed ? parsed.amount.toLocaleString("en-US") : "��"} {unit})
                      </span>
                      <span className="font-semibold text-foreground">
                        {formatCurrency(proposedTotal, amendTarget.currency)}
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAmendTarget(null)} disabled={amending}>
              Cancel
            </Button>
            <Button onClick={handleSubmitAmendment} disabled={amending}>
              {amending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
              Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Negotiation log */}
      <Dialog open={notesTarget !== null} onOpenChange={(o) => !o && !savingNote && setNotesTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              Negotiation log
            </DialogTitle>
            <DialogDescription className="text-pretty">
              Record the back-and-forth with the counterparty for{" "}
              <span className="font-medium text-foreground">{notesTarget?.id}</span>. Visible to you and the
              Administrator.
            </DialogDescription>
          </DialogHeader>
          {notesTarget ? (
            <div className="space-y-4">
              {/* Existing thread */}
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
                {notesTarget.negotiationNotes?.length ? (
                  notesTarget.negotiationNotes.map((n) => (
                    <div key={n.id} className="rounded-md bg-background p-2 text-xs">
                      <div className="mb-0.5 flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {n.author}
                          <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] capitalize">
                            {n.authorRole}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground">{formatTimestamp(n.createdAt)}</span>
                      </div>
                      <p className="text-muted-foreground">{n.message}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-xs text-muted-foreground">No notes yet — add the first below.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cp-position">Counterparty position</Label>
                <Textarea
                  id="cp-position"
                  value={counterpartyText}
                  onChange={(e) => setCounterpartyText(e.target.value)}
                  placeholder="e.g. Buyer agreed to CIF terms pending revised unit price of USD 690 / MT."
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="note-text">Add a note</Label>
                <Textarea
                  id="note-text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Log the latest call, email or agreement…"
                  rows={2}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNotesTarget(null)} disabled={savingNote}>
              Close
            </Button>
            <Button onClick={handleSaveNote} disabled={savingNote}>
              {savingNote ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              Save to log
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Shared module used for both Proof of Product and Proof of Funds. Documents are
// structured metadata records (type, reference, issuing bank, value/SWIFT ref,
// version history, status) — consistent with the rest of the platform.
function DocumentModule({
  module,
  title,
  subtitle,
  docTypes,
  deals,
  hydrated,
  addDocument,
  addDocumentVersion,
  logActivity,
  withSwiftRef,
}: {
  module: DocModule
  title: string
  subtitle: string
  docTypes: string[]
  deals: CommodityDeal[]
  hydrated: boolean
  addDocument: ReturnType<typeof useCommodityDeals>["addDocument"]
  addDocumentVersion: ReturnType<typeof useCommodityDeals>["addDocumentVersion"]
  logActivity: ReturnType<typeof useActivityLog>
  withSwiftRef?: boolean
}) {
  const [dealId, setDealId] = useState<string>("")
  const [docType, setDocType] = useState<string>(docTypes[0])
  const [reference, setReference] = useState("")
  const [issuedBy, setIssuedBy] = useState("")
  const [issueDate, setIssueDate] = useState("")
  const [fileName, setFileName] = useState("")
  const [swiftRef, setSwiftRef] = useState("")
  const [notes, setNotes] = useState("")

  const selectedDeal = deals.find((d) => d.id === dealId) || null
  const moduleDocs = selectedDeal?.documents.filter((d) => d.module === module) || []

  const resetDocForm = () => {
    setReference("")
    setIssuedBy("")
    setIssueDate("")
    setFileName("")
    setSwiftRef("")
    setNotes("")
  }

  const handleAddDoc = () => {
    if (!dealId) {
      toast.error("Select a deal first")
      return
    }
    if (!fileName.trim()) {
      toast.error("Document name is required")
      return
    }
    const deal = deals.find((d) => d.id === dealId)
    addDocument(dealId, {
      module,
      docType,
      reference: reference.trim(),
      issuedBy: issuedBy.trim(),
      issueDate: issueDate.trim(),
      fileName: fileName.trim(),
      notes: notes.trim(),
      swiftRef: withSwiftRef ? swiftRef.trim() : undefined,
    })
    toast.success(`${module} document submitted`, {
      description: `${docType} added to ${dealId}. Pending Administrator verification.`,
    })
    logActivity({
      action: `Client submitted ${module} document (${docType}) for deal ${dealId}`,
      category: "Commodity Trading",
      details: {
        summary: `Client submitted a ${title} document "${docType}" (${fileName.trim()}${reference.trim() ? `, ref ${reference.trim()}` : ""}) for deal ${dealId}${deal ? ` "${deal.title}"` : ""}. Issued by ${issuedBy.trim() || "—"}.${withSwiftRef && swiftRef.trim() ? ` SWIFT ref ${swiftRef.trim()}.` : ""} Pending verification.`,
        referenceId: dealId,
        module,
        docType,
        decision: "Pending",
      },
    })
    resetDocForm()
  }

  const handleAddVersion = (docId: string, currentType: string) => {
    const name = window.prompt(`New version file name for "${currentType}":`)
    if (!name || !name.trim()) return
    addDocumentVersion(dealId, docId, {
      reference: "",
      issuedBy: "",
      issueDate: new Date().toISOString().slice(0, 10),
      fileName: name.trim(),
      notes: "Revised version uploaded by client.",
    })
    toast.success("New version added", {
      description: `A revised version of ${currentType} was recorded. Pending re-verification.`,
    })
    logActivity({
      action: `Client uploaded a new version of ${module} document (${currentType}) for deal ${dealId}`,
      category: "Commodity Trading",
      details: {
        summary: `Client uploaded a revised version "${name.trim()}" of ${title} document "${currentType}" for deal ${dealId}. Document reset to submitted, pending re-verification.`,
        referenceId: dealId,
        module,
        docType: currentType,
        decision: "Pending",
      },
    })
  }

  const Icon = module === "POP" ? Package : Banknote

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Icon className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Deal *</Label>
              <Select value={dealId} onValueChange={setDealId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a deal" />
                </SelectTrigger>
                <SelectContent>
                  {deals.length === 0 ? (
                    <SelectItem value="none" disabled>
                      No deals — create one in Deal Workflow
                    </SelectItem>
                  ) : (
                    deals.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.id} — {d.title}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Document type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {docTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${module}-file`}>Document name *</Label>
              <Input
                id={`${module}-file`}
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="e.g. BL-2024-0042.pdf"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${module}-ref`}>Document reference</Label>
              <Input
                id={`${module}-ref`}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Document / certificate number"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${module}-issuer`}>Issued by</Label>
              <Input
                id={`${module}-issuer`}
                value={issuedBy}
                onChange={(e) => setIssuedBy(e.target.value)}
                placeholder={module === "POP" ? "Inspector / authority / refinery" : "Issuing bank"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${module}-date`}>Issue date</Label>
              <Input
                id={`${module}-date`}
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
            </div>
            {withSwiftRef && (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor={`${module}-swift`}>SWIFT reference (e.g. MT799 pre-advice)</Label>
                <Input
                  id={`${module}-swift`}
                  value={swiftRef}
                  onChange={(e) => setSwiftRef(e.target.value)}
                  placeholder="MT799 / MT760 message reference"
                />
              </div>
            )}
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${module}-notes`}>Notes</Label>
              <Textarea
                id={`${module}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Additional context for the reviewer…"
                rows={2}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Documents are stored as versioned records and verified by the Administrator.
            </p>
            <Button onClick={handleAddDoc}>
              <Plus className="mr-1 h-4 w-4" />
              Submit document
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Document list for the selected deal */}
      {selectedDeal && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              {title} documents — {selectedDeal.id}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {moduleDocs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No {module} documents for this deal yet.
              </p>
            ) : (
              moduleDocs.map((doc) => (
                <div key={doc.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <DocStatusBadge status={doc.status} />
                    <span className="font-medium text-foreground">{doc.docType}</span>
                    <Badge variant="outline" className="text-[10px]">
                      v{doc.currentVersion}
                    </Badge>
                    {doc.swiftRef && (
                      <Badge variant="outline" className="text-[10px]">
                        SWIFT {doc.swiftRef}
                      </Badge>
                    )}
                  </div>
                  {doc.status === "rejected" && doc.decisionNote && (
                    <p className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 p-2 text-xs text-red-500">
                      Reviewer note: {doc.decisionNote}
                    </p>
                  )}
                  <Accordion type="single" collapsible className="mt-1 w-full">
                    <AccordionItem value="versions" className="border-b-0">
                      <AccordionTrigger className="py-2 text-xs">
                        <span className="flex items-center gap-1.5">
                          <History className="h-3.5 w-3.5" />
                          Version history ({doc.versions.length})
                        </span>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2">
                          {[...doc.versions].reverse().map((v) => (
                            <div
                              key={v.version}
                              className="flex flex-col gap-1 rounded-md border border-border bg-secondary/20 p-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="flex items-center gap-2">
                                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-foreground">{v.fileName}</span>
                                <Badge variant="outline" className="text-[10px]">
                                  v{v.version}
                                </Badge>
                              </div>
                              <span className="text-muted-foreground">
                                {v.reference ? `${v.reference} · ` : ""}
                                {v.issuedBy ? `${v.issuedBy} · ` : ""}
                                {v.issueDate || formatTimestamp(v.uploadedAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                  <div className="mt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => handleAddVersion(doc.id, doc.docType)}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Add new version
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
