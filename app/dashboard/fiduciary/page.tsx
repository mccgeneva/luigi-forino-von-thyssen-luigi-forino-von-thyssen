"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  Landmark,
  ShieldCheck,
  Lock,
  Eye,
  Building,
  FileText,
  Vault,
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  Clock,
  Check,
  X,
  ChevronRight,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { useActivityLog } from "@/components/activity-tracker"
import {
  useFiduciaryRequests,
  FIDUCIARY_SERVICE_LABELS,
  type FiduciaryServiceType,
} from "@/lib/fiduciary-requests-store"

const principles = [
  {
    icon: Lock,
    title: "Asset Protection",
    description:
      "Assets are held in the name of the fiduciary, shielding the beneficial owner from direct exposure.",
  },
  {
    icon: Eye,
    title: "Confidentiality",
    description:
      "Swiss banking secrecy and fiduciary duty keep your holdings private and discreet at all times.",
  },
  {
    icon: ShieldCheck,
    title: "Regulated Custody",
    description:
      "All fiduciary mandates are governed under FINMA supervision and segregated custody rules.",
  },
]

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"] as const

// Asset classes that place value under custody, vs. those that remove it.
const DEPOSIT_TYPES: FiduciaryServiceType[] = ["open_mandate", "deposit_asset"]

// The interactive service catalogue. Each tile opens the request dialog and
// raises a tracked service job for the custody desk to action.
const services: {
  type: FiduciaryServiceType
  icon: typeof Vault
  title: string
  description: string
  needsAsset: boolean
  needsValue: boolean
}[] = [
  {
    type: "open_mandate",
    icon: Vault,
    title: "Open Fiduciary Mandate",
    description: "Establish a new segregated custody mandate held in the fiduciary's name.",
    needsAsset: true,
    needsValue: true,
  },
  {
    type: "deposit_asset",
    icon: ArrowDownToLine,
    title: "Deposit Asset into Custody",
    description: "Place cash, bullion, securities, or instruments under fiduciary custody.",
    needsAsset: true,
    needsValue: true,
  },
  {
    type: "release_asset",
    icon: ArrowUpFromLine,
    title: "Release / Withdraw Asset",
    description: "Instruct the custody desk to release or transfer a held asset.",
    needsAsset: true,
    needsValue: true,
  },
  {
    type: "custody_review",
    icon: CalendarClock,
    title: "Schedule Custody Review",
    description: "Book a confidential portfolio and mandate review with your fiduciary officer.",
    needsAsset: false,
    needsValue: false,
  },
]

const statusStyles: Record<string, string> = {
  pending: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  approved: "border-green-500/20 bg-green-500/10 text-green-500",
  rejected: "border-red-500/20 bg-red-500/10 text-red-500",
}

const statusIcon = {
  pending: Clock,
  approved: Check,
  rejected: X,
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function FiduciaryPage() {
  const log = useActivityLog()
  const { requests, addRequest } = useFiduciaryRequests()

  // The active service being requested (drives the dialog), plus form state.
  const [activeService, setActiveService] = useState<(typeof services)[number] | null>(null)
  const [assetType, setAssetType] = useState("")
  const [estimatedValue, setEstimatedValue] = useState("")
  const [currency, setCurrency] = useState<string>("EUR")
  const [notes, setNotes] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  const myRequests = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
      ),
    [requests],
  )

  // Live custody is derived from real service jobs — never placeholder figures.
  // An asset counts toward custody once the desk APPROVES the deposit/mandate;
  // approved releases reduce it. Pending deposits are shown separately so the
  // client immediately sees a just-registered asset acknowledged.
  const approvedDeposits = useMemo(
    () =>
      myRequests.filter(
        (r) =>
          DEPOSIT_TYPES.includes(r.serviceType) &&
          r.status === "approved" &&
          r.estimatedValue > 0,
      ),
    [myRequests],
  )
  const approvedReleases = useMemo(
    () =>
      myRequests.filter(
        (r) => r.serviceType === "release_asset" && r.status === "approved" && r.estimatedValue > 0,
      ),
    [myRequests],
  )
  const pendingDeposits = useMemo(
    () =>
      myRequests.filter(
        (r) =>
          DEPOSIT_TYPES.includes(r.serviceType) &&
          r.status === "pending" &&
          r.estimatedValue > 0,
      ),
    [myRequests],
  )

  // Net custody, grouped by currency (deposits minus releases).
  const custodyByCurrency = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of approvedDeposits) {
      totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.estimatedValue)
    }
    for (const r of approvedReleases) {
      totals.set(r.currency, (totals.get(r.currency) ?? 0) - r.estimatedValue)
    }
    return [...totals.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .filter((x) => x.amount > 0.005)
      .sort((a, b) => b.amount - a.amount)
  }, [approvedDeposits, approvedReleases])

  const pendingByCurrency = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of pendingDeposits) {
      totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.estimatedValue)
    }
    return [...totals.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)
  }, [pendingDeposits])

  // Active holdings under custody (one row per approved deposit / mandate).
  const holdings = useMemo(
    () =>
      approvedDeposits.map((r) => ({
        id: r.id,
        icon: r.serviceType === "open_mandate" ? Vault : Building,
        name: r.assetType || r.serviceLabel,
        detail: `${r.serviceLabel} · Approved ${new Date(r.decidedAt || r.submittedAt).toLocaleDateString("en-GB")}`,
        value: formatMoney(r.estimatedValue, r.currency),
      })),
    [approvedDeposits],
  )

  const primaryCustody = custodyByCurrency[0] ?? null

  const openService = (service: (typeof services)[number]) => {
    setActiveService(service)
    setAssetType("")
    setEstimatedValue("")
    setCurrency("EUR")
    setNotes("")
    setFormError(null)
  }

  const submitService = () => {
    if (!activeService) return
    const numericValue = Number.parseFloat(estimatedValue.replace(/,/g, "")) || 0

    if (activeService.needsAsset && !assetType.trim()) {
      setFormError("Please describe the asset or instrument involved.")
      return
    }
    if (activeService.needsValue && numericValue <= 0) {
      setFormError("Please enter an indicative value greater than zero.")
      return
    }

    const request = addRequest({
      serviceType: activeService.type,
      serviceLabel: activeService.title,
      assetType: assetType.trim(),
      estimatedValue: numericValue,
      currency,
      notes: notes.trim(),
    })

    const valueText =
      activeService.needsValue && numericValue > 0 ? ` valued at ${formatMoney(numericValue, currency)}` : ""
    log({
      action: `Raised fiduciary service job ${request.id} — ${activeService.title}`,
      category: "Fiduciary & Assets",
      details: {
        summary: `Client raised a fiduciary service job (${request.id}): ${activeService.title}.${assetType.trim() ? ` Asset: ${assetType.trim()}.` : ""}${valueText ? `${valueText}.` : ""}${notes.trim() ? ` Instructions: ${notes.trim()}.` : ""} Awaiting custody desk action.`,
        referenceId: request.id,
        service: activeService.title,
        asset: assetType.trim() || "(not applicable)",
        estimatedValue: activeService.needsValue && numericValue > 0 ? formatMoney(numericValue, currency) : "(not applicable)",
        status: "Pending custody desk action",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })

    toast.success("Service job submitted", {
      description: `${activeService.title} (${request.id}) has been sent to the custody desk for action.`,
    })
    setActiveService(null)
  }

  const requestStatement = () => {
    const request = addRequest({
      serviceType: "statement",
      serviceLabel: FIDUCIARY_SERVICE_LABELS.statement,
      assetType: "",
      estimatedValue: 0,
      currency: "EUR",
      notes: "Official fiduciary asset statement requested.",
    })
    log({
      action: `Raised fiduciary service job ${request.id} — Asset Statement`,
      category: "Fiduciary & Assets",
      details: {
        summary: `Client requested an official fiduciary asset statement (service job ${request.id}). Awaiting custody desk action.`,
        referenceId: request.id,
        service: "Request Asset Statement",
        status: "Pending custody desk action",
        requestedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Statement requested", {
      description: `Service job ${request.id} sent to the custody desk. Your statement will be delivered to your secure inbox.`,
    })
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Fiduciary &amp; Assets</h1>
          <p className="text-sm text-muted-foreground">
            Confidential asset management and fiduciary custody services
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={requestStatement}>
          <FileText className="mr-2 h-4 w-4" />
          Request Statement
        </Button>
      </div>

      {/* Total holdings banner */}
      <Card className="bg-gradient-to-r from-primary/15 to-primary/5 border-primary/20">
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/20">
              <Landmark className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Total Assets Under Custody
              </p>
              <p className="text-3xl font-bold text-foreground">
                {primaryCustody
                  ? formatMoney(primaryCustody.amount, primaryCustody.currency)
                  : "EUR 0.00"}
              </p>
              {custodyByCurrency.length > 1 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {custodyByCurrency
                    .slice(1)
                    .map((c) => formatMoney(c.amount, c.currency))
                    .join("  ·  ")}
                </p>
              )}
              {pendingByCurrency.length > 0 && (
                <p className="mt-1 flex items-center gap-1 text-xs text-yellow-500">
                  <Clock className="h-3 w-3" />
                  Pending custody review:{" "}
                  {pendingByCurrency.map((c) => formatMoney(c.amount, c.currency)).join("  ·  ")}
                </p>
              )}
            </div>
          </div>
          <Badge variant="outline" className="w-fit bg-secondary text-muted-foreground border-border">
            <ShieldCheck className="mr-1 h-3 w-3" />
            {holdings.length > 0
              ? `${holdings.length} ${holdings.length === 1 ? "holding" : "holdings"}`
              : "No assets under custody"}
          </Badge>
        </CardContent>
      </Card>

      {/* Fiduciary services — interactive */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Fiduciary Services</CardTitle>
          <p className="text-xs text-muted-foreground">
            Raise a confidential service job for the custody desk to action.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {services.map((s) => (
            <button
              key={s.type}
              type="button"
              onClick={() => openService(s)}
              className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-4 text-left transition-colors hover:border-primary/40 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <s.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {s.description}
                </p>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </CardContent>
      </Card>

      {/* Privacy principles */}
      <div className="grid gap-4 md:grid-cols-3">
        {principles.map((p) => (
          <Card key={p.title} className="bg-card border-border">
            <CardContent className="p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <p.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">{p.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Service jobs tracker */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">My Service Jobs</CardTitle>
          <p className="text-xs text-muted-foreground">
            Track the status of fiduciary requests raised with the custody desk.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {myRequests.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                <FileText className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No service jobs yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Use the services above to raise a confidential request for the custody desk.
              </p>
            </div>
          )}
          {myRequests.map((r) => {
            const StatusIcon = statusIcon[r.status]
            return (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{r.serviceLabel}</span>
                    <span className="text-xs text-muted-foreground">{r.id}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.assetType ? `${r.assetType} · ` : ""}
                    {r.estimatedValue > 0 ? `${formatMoney(r.estimatedValue, r.currency)} · ` : ""}
                    {new Date(r.submittedAt).toLocaleString("en-GB")}
                  </p>
                  {r.decisionNote && (
                    <p className="text-xs text-muted-foreground">Note: {r.decisionNote}</p>
                  )}
                </div>
                <Badge variant="outline" className={statusStyles[r.status]}>
                  <StatusIcon className="mr-1 h-3 w-3" />
                  {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                </Badge>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Holdings */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Asset Holdings</CardTitle>
          <p className="text-xs text-muted-foreground">
            Assets held under fiduciary custody (approved deposits &amp; mandates)
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {holdings.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                <Landmark className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No assets under custody</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {pendingDeposits.length > 0
                  ? "Your deposit is awaiting custody desk approval and will appear here once confirmed."
                  : "Register an asset above. Once the custody desk approves it, it will appear here."}
              </p>
            </div>
          )}
          {holdings.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-4"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <h.icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{h.detail}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-base font-bold text-foreground">{h.value}</p>
                <span className="flex items-center justify-end gap-1 text-xs font-medium text-green-500">
                  <ShieldCheck className="h-3 w-3" />
                  Under custody
                </span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Service request dialog */}
      <Dialog open={!!activeService} onOpenChange={(open) => !open && setActiveService(null)}>
        <DialogContent className="sm:max-w-md">
          {activeService && (
            <>
              <DialogHeader>
                <DialogTitle>{activeService.title}</DialogTitle>
                <DialogDescription>{activeService.description}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {activeService.needsAsset && (
                  <div className="space-y-2">
                    <Label htmlFor="fid-asset">Asset / Instrument</Label>
                    <Input
                      id="fid-asset"
                      placeholder="e.g. Gold bullion, SBLC, Listed equities"
                      value={assetType}
                      onChange={(e) => setAssetType(e.target.value)}
                    />
                  </div>
                )}
                {activeService.needsValue && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="fid-value">Indicative Value</Label>
                      <MoneyInput
                        id="fid-value"
                        placeholder="e.g. 1,000,000"
                        value={estimatedValue}
                        onValueChange={setEstimatedValue}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Currency</Label>
                      <Select value={currency} onValueChange={setCurrency}>
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
                <div className="space-y-2">
                  <Label htmlFor="fid-notes">Instructions (optional)</Label>
                  <Textarea
                    id="fid-notes"
                    placeholder="Any specific instructions for the custody desk."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                  />
                </div>
                {formError && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400">
                    <X className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setActiveService(null)}>
                  Cancel
                </Button>
                <Button onClick={submitService}>Submit Service Job</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
