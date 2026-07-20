"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Building2,
  Check,
  Eye,
  FileText,
  Globe,
  History,
  Layers,
  Package,
  PackageCheck,
  RefreshCw,
  Scale,
  Share2,
  Ship,
  Tag,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { SwiftGpiTracker } from "@/components/swift-gpi-tracker"
import { DEAL_STAGES, type CommodityDeal, type DealDocument, type DealStatus } from "@/lib/commodity-deals-store"
import { formatQuantityWithEquivalent, formatUnitPriceFor } from "@/lib/petroleum-products"
import type { SharedDealView } from "@/app/actions/approvals"
import { cn } from "@/lib/utils"

function formatCurrency(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(value || 0)
  } catch {
    return `${currency || "USD"} ${(value || 0).toLocaleString("en-US")}`
  }
}

function formatTimestamp(iso?: string) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const STATUS_STYLE: Record<DealStatus, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  approved: "border-green-500/30 bg-green-500/10 text-green-500",
  rejected: "border-red-500/30 bg-red-500/10 text-red-500",
  cancelled: "border-muted-foreground/30 bg-muted text-muted-foreground",
}

function StatusBadge({ status }: { status: DealStatus }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] capitalize", STATUS_STYLE[status])}>
      {status}
    </Badge>
  )
}

const DOC_STATUS_STYLE: Record<string, string> = {
  submitted: "border-blue-500/30 bg-blue-500/10 text-blue-500",
  verified: "border-green-500/30 bg-green-500/10 text-green-500",
  rejected: "border-red-500/30 bg-red-500/10 text-red-500",
}

function DocStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] capitalize", DOC_STATUS_STYLE[status])}>
      {status}
    </Badge>
  )
}

/** Read-only workflow stepper mirroring the owner's, without any controls. */
function ReadOnlyStepper({ stage }: { stage: string }) {
  const currentIndex = DEAL_STAGES.findIndex((s) => s.key === stage)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {DEAL_STAGES.map((s, i) => {
        const done = i < currentIndex
        const current = i === currentIndex
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                done && "border-green-500/40 bg-green-500/10 text-green-500",
                current && "border-primary/50 bg-primary/10 text-primary",
                !done && !current && "border-border bg-muted text-muted-foreground",
              )}
            >
              {done && <Check className="h-3 w-3" />}
              {s.label}
            </span>
            {i < DEAL_STAGES.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        )
      })}
    </div>
  )
}

function DocList({ docs, module, label }: { docs: DealDocument[]; module: "POP" | "POF"; label: string }) {
  const list = docs.filter((d) => d.module === module)
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {label} ({list.length})
      </p>
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
          No {module} documents shared yet.
        </p>
      ) : (
        list.map((doc) => (
          <div key={doc.id} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <DocStatusBadge status={doc.status} />
              <span className="text-sm font-medium text-foreground">{doc.docType}</span>
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
            {doc.versions?.length ? (
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
            ) : null}
          </div>
        ))
      )}
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: typeof Banknote; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  )
}

export function SharedDealDetail({ view }: { view: SharedDealView }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!view.ok || !view.live) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <Eye className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{view.error || "This deal could not be loaded."}</p>
        <Button asChild variant="outline">
          <Link href="/dashboard/commodity">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to Commodity Transactions
          </Link>
        </Button>
      </div>
    )
  }

  const deal = view.live.record as unknown as CommodityDeal
  const status = (view.live.status as DealStatus) ?? "pending"
  const delivered = view.live.delivered
  const popDocs = (deal.documents ?? []).filter((d) => d.module === "POP")
  const pofDocs = (deal.documents ?? []).filter((d) => d.module === "POF")

  const paymentStatus =
    status === "rejected"
      ? "failed"
      : status !== "approved"
        ? "pending"
        : delivered
          ? "completed"
          : "blocked"

  const refresh = () => startTransition(() => router.refresh())

  return (
    <div className="mx-auto max-w-4xl space-y-4 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="gap-1">
          <Link href="/dashboard/commodity">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isPending}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <Card className="border-primary/30">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            {delivered && (
              <Badge variant="outline" className="border-green-500/30 bg-green-500/10 text-[10px] text-green-500">
                <PackageCheck className="mr-1 h-3 w-3" /> Delivered
              </Badge>
            )}
            <Badge variant="outline" className="gap-1 border-primary/30 text-[10px] text-primary">
              <Eye className="h-3 w-3" /> Read-only
            </Badge>
            {view.sourceMissing && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                Snapshot
              </Badge>
            )}
          </div>
          <CardTitle className="text-pretty text-lg">{deal.title}</CardTitle>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Share2 className="h-3 w-3 text-primary" />
              Shared by {view.sharedFromName}
            </span>
            {deal.id ? <span>· {deal.id}</span> : null}
            {view.sharedAt ? <span>· {formatTimestamp(view.sharedAt)}</span> : null}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-md border border-primary/20 bg-primary/5 p-2 text-xs text-muted-foreground">
            This deal was shared with you by {view.sharedFromName} for visibility only. It reflects the
            owner&apos;s current deal status and is read-only — it has no effect on your balance and you
            cannot act on it.
          </p>

          <ReadOnlyStepper stage={deal.stage} />

          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <InfoRow icon={Banknote} label="Value" value={formatCurrency(deal.approxValue, deal.currency)} />
            <InfoRow icon={Package} label="Commodity" value={deal.commodity || "—"} />
            <InfoRow
              icon={Scale}
              label="Quantity"
              value={deal.quantity ? formatQuantityWithEquivalent(deal.quantity, deal.commodity) : "—"}
            />
            <InfoRow
              icon={Tag}
              label="Unit price"
              value={formatUnitPriceFor(deal.approxValue, deal.quantity, deal.currency) || "—"}
            />
            <InfoRow icon={Layers} label="Instrument" value={deal.instrumentType || "—"} />
            <InfoRow icon={Building2} label="Buyer" value={deal.buyerName || "—"} />
            <InfoRow icon={Building2} label="Seller" value={deal.sellerName || "—"} />
          </div>
        </CardContent>
      </Card>

      {/* Vessel & shipping */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ship className="h-4 w-4 text-primary" /> Vessel &amp; shipping
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <InfoRow icon={Ship} label="Structure" value={deal.tradeStructure || "—"} />
          <InfoRow
            icon={Globe}
            label="Route"
            value={`${deal.originCountry || "—"} → ${deal.destinationCountry || "—"}`}
          />
          <InfoRow
            icon={ArrowRight}
            label="Stage"
            value={DEAL_STAGES.find((s) => s.key === deal.stage)?.label || deal.stage || "—"}
          />
          <InfoRow
            icon={PackageCheck}
            label="Delivery"
            value={delivered ? `Delivered · ${formatTimestamp(view.live.deliveredAt)}` : "In progress"}
          />
        </CardContent>
      </Card>

      {/* Documents (POP / POF) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-primary" /> Documents
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Proof of Product and Proof of Funds documentation made available on this deal.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <DocList docs={popDocs} module="POP" label="Proof of Product (POP)" />
          <DocList docs={pofDocs} module="POF" label="Proof of Funds (POF)" />
        </CardContent>
      </Card>

      {/* SWIFT exchange & payment */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" /> SWIFT exchange &amp; payment
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <InfoRow icon={FileText} label="MT103" value={deal.mt103Ref || "—"} />
            <InfoRow icon={FileText} label="MT202" value={deal.mt202Ref || "—"} />
            <InfoRow icon={FileText} label="MT799" value={deal.mt799Ref || "—"} />
          </div>
          <div className="rounded-md border border-border p-2 text-xs">
            <span className="text-muted-foreground">Payment status: </span>
            <span
              className={cn(
                "font-medium",
                paymentStatus === "completed" && "text-green-500",
                paymentStatus === "blocked" && "text-amber-500",
                paymentStatus === "failed" && "text-red-500",
                paymentStatus === "pending" && "text-muted-foreground",
              )}
            >
              {paymentStatus === "completed"
                ? "Settled / paid"
                : paymentStatus === "blocked"
                  ? "Funds reserved — awaiting delivery"
                  : paymentStatus === "failed"
                    ? "Rejected"
                    : "Pending approval"}
            </span>
          </div>
          {deal.uetr ? (
            <SwiftGpiTracker
              payment={{
                uetr: deal.uetr,
                status: paymentStatus,
                currency: deal.currency,
                beneficiaryBic: deal.receivingBankBic || undefined,
                beneficiaryName: deal.receivingBank || deal.sellerName,
                beneficiaryCountry: deal.destinationCountry || undefined,
                baseDate: view.live.submittedAt || new Date().toISOString(),
                direction: "outgoing",
              }}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
