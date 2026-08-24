"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Ship,
  Search,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Tag,
  Megaphone,
  Ban,
  Clock,
  Download,
  Anchor,
  Gauge,
  Satellite,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  RefreshCw,
  Sparkles,
  PackageSearch,
  ArrowRightLeft,
  ShoppingCart,
  Store,
  Waypoints,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  PETROLEUM_PRODUCTS,
  COMMODITY_CATEGORIES,
  getCatalogProduct,
  bblPerMtFor,
  type CommodityUnit,
} from "@/lib/petroleum-products"
import {
  compatibleVesselTypesForProduct,
  suggestQuantity,
  suggestSpotPrice,
  findPortByLocation,
  portsByRegion,
} from "@/lib/spot-deal-autofill"
import { PORTS } from "@/lib/commodity-quotations"
import {
  VESSEL_TYPE_LABELS,
  VESSEL_TYPES,
  VESSEL_STATUSES,
  VESSEL_STATUS_LABELS,
  SPOT_DEAL_STATUS_LABELS,
  SPOT_DEAL_SIDE_LABELS,
  SPOT_DEAL_SIDE_VERB,
  computeTotalValue,
  dealCountdown,
  type Vessel,
  type VesselType,
  type VesselStatus,
  type SpotDeal,
  type SpotDealSide,
} from "@/lib/spot-deals-shared"
import {
  listVesselsAdmin,
  upsertVesselAdmin,
  deleteVesselAdmin,
  importVesselFromProvider,
  rescreenVesselAdmin,
  lookupVesselDraftAdmin,
  getVesselProviderStatus,
  listSpotDealsAdmin,
  createSpotDealAdmin,
  publishSpotDealAdmin,
  withdrawSpotDealAdmin,
  type CreateSpotDealInput,
} from "@/app/actions/spot-deals"
import { VESSEL_PROVIDERS, type VesselCompliance } from "@/lib/spot-deals-shared"
import { AisFeedStatus, VesselLivePositionLine } from "@/components/dashboard/vessel-live-position"

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD"]
const INCOTERMS = ["FOB", "CIF", "CFR", "FCA", "DES", "DAP"]

/** Compact sanctions / IMO-validity badge shown on each vessel row. */
function ComplianceBadge({ compliance }: { compliance?: VesselCompliance }) {
  if (!compliance) return null
  const map = {
    clear: { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600", Icon: ShieldCheck, label: "Clear" },
    flagged: { cls: "border-red-500/40 bg-red-500/10 text-red-600", Icon: ShieldAlert, label: "Sanctions hit" },
    unverified: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", Icon: ShieldQuestion, label: "Unverified" },
  }[compliance.status]
  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px]", map.cls)} title={compliance.note}>
      <map.Icon className="h-3 w-3" />
      {map.label}
    </Badge>
  )
}

const TYPE_BADGE: Record<VesselType, string> = {
  crude: "border-amber-500/30 bg-amber-500/10 text-amber-600",
  product: "border-blue-500/30 bg-blue-500/10 text-blue-600",
  gas: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
}

function formatMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const emptyVessel: Vessel = {
  imo: "",
  name: "",
  type: "crude",
  vesselClass: "",
  capacity: 0,
  capacityUnit: "DWT",
  status: "idle",
  location: "",
  flag: "",
  builtYear: undefined,
  cargo: "",
  source: "manual",
  updatedAt: "",
}

// --- Vessel catalogue -------------------------------------------------------

function VesselCatalogue({ onVesselsChanged }: { onVesselsChanged: (v: Vessel[]) => void }) {
  const [vessels, setVessels] = useState<Vessel[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [editTarget, setEditTarget] = useState<Vessel | null>(null)
  const [form, setForm] = useState<Vessel>({ ...emptyVessel })
  const [saving, setSaving] = useState(false)
  const [prefilling, setPrefilling] = useState(false)
  const [importImo, setImportImo] = useState("")
  const [importing, setImporting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Vessel | null>(null)
  const [operateTarget, setOperateTarget] = useState<Vessel | null>(null)
  const [provider, setProvider] = useState<Awaited<ReturnType<typeof getVesselProviderStatus>> | null>(null)
  const [providersOpen, setProvidersOpen] = useState(false)

  useEffect(() => {
    getVesselProviderStatus()
      .then(setProvider)
      .catch(() => {})
  }, [])

  const providerLabel = provider?.active?.label ?? null
  const providerConnected = Boolean(provider?.connected)

  const load = useCallback(
    async (term?: string): Promise<Vessel[] | null> => {
      setLoading(true)
      try {
        const res = await listVesselsAdmin(ADMIN_PASSCODE, term)
        if (res.ok) {
          setVessels(res.vessels)
          onVesselsChanged(res.vessels)
          return res.vessels
        }
        return null
      } finally {
        setLoading(false)
      }
    },
    [onVesselsChanged],
  )

  useEffect(() => {
    load()
  }, [load])

  // Tracks which IMO we've already auto-filled to avoid duplicate lookups.
  const prefilledImoRef = useRef<string>("")

  // Resolve a vessel by IMO (free public registry + compliance) and merge the
  // result into the open form, without overwriting fields the admin has already
  // typed. Used by both "Add manually" and direct typing in the IMO field.
  const prefillFromImo = useCallback(async (rawImo: string) => {
    const imo = (rawImo ?? "").replace(/\D/g, "").trim()
    if (!/^\d{7}$/.test(imo)) return
    if (prefilledImoRef.current === imo) return
    prefilledImoRef.current = imo
    setPrefilling(true)
    try {
      const res = await lookupVesselDraftAdmin(ADMIN_PASSCODE, imo)
      if (res.ok && res.vessel) {
        // "IMO <n>" is the placeholder when no public record exists — don't
        // dump that into the editable name field.
        const resolvedName = res.vessel.name && res.vessel.name !== `IMO ${imo}` ? res.vessel.name : ""
        setForm((prev) =>
          prev.imo === imo
            ? {
                ...prev,
                name: prev.name?.trim() ? prev.name : resolvedName,
                type: res.vessel!.type ?? prev.type,
                vesselClass: prev.vesselClass?.trim() ? prev.vesselClass : res.vessel!.vesselClass ?? "",
                capacity: prev.capacity || res.vessel!.capacity || 0,
                capacityUnit: res.vessel!.capacityUnit ?? prev.capacityUnit,
                flag: prev.flag?.trim() ? prev.flag : res.vessel!.flag ?? "",
                builtYear: prev.builtYear ?? res.vessel!.builtYear,
                location: prev.location?.trim() ? prev.location : res.vessel!.location ?? "",
                compliance: res.vessel!.compliance ?? prev.compliance,
              }
            : prev,
        )
        if (resolvedName) {
          toast.success("Vessel details found", { description: `${resolvedName} (IMO ${imo})` })
        } else {
          toast.message("No public record found", {
            description: "Enter the vessel details manually; the IMO has been validated.",
          })
        }
      } else if (!res.ok) {
        // Reset so the admin can retry after correcting the IMO.
        prefilledImoRef.current = ""
        toast.error(res.error ?? "Lookup failed")
      }
    } catch {
      prefilledImoRef.current = ""
      toast.error("Lookup failed. Enter details manually.")
    } finally {
      setPrefilling(false)
    }
  }, [])

  const openCreate = (prefillImo?: string) => {
    const imo = (prefillImo ?? "").replace(/\D/g, "").trim()
    const valid = /^\d{7}$/.test(imo)
    const seed = valid ? { ...emptyVessel, imo } : { ...emptyVessel }
    prefilledImoRef.current = ""
    setForm(seed)
    setEditTarget(seed)
    // Auto-populate from the free public + compliance lookup so the manual form
    // isn't blank for a real IMO.
    if (valid) void prefillFromImo(imo)
  }

  // The IMO the admin is currently searching for, if the term contains a valid
  // 7-digit IMO number. We strip non-digits first so pasted values like
  // "IMO 9512331", "9512331 " or "IMO-9512331" (as copied from MarineTraffic)
  // are still recognised and offered as a direct "import / add this vessel".
  const searchDigits = search.replace(/\D/g, "")
  const searchedImo = searchDigits.length === 7 ? searchDigits : ""

  // Run a catalogue search. When the term resolves to a 7-digit IMO we query by
  // the bare digits so it matches the stored `imo` even if the admin typed an
  // "IMO " prefix or extra spacing. If that IMO isn't in the catalogue yet, we
  // don't dead-end on an empty result — we RESOLVE it live (Datadocked / free
  // public registry + compliance) and add it, so searching an IMO actually
  // surfaces the vessel the way the admin expects.
  const runSearch = async () => {
    const found = await load(searchedImo || search.trim())
    if (searchedImo && Array.isArray(found) && found.length === 0 && !importing) {
      await handleImport(searchedImo)
    }
  }
  const openEdit = (v: Vessel) => {
    setForm({ ...v, vesselClass: v.vesselClass ?? "", flag: v.flag ?? "", cargo: v.cargo ?? "" })
    setEditTarget(v)
  }

  const set = <K extends keyof Vessel>(key: K, value: Vessel[K]) => setForm((p) => ({ ...p, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await upsertVesselAdmin(ADMIN_PASSCODE, { ...form, capacity: Number(form.capacity) || 0 })
      if (res.ok) {
        toast.success("Vessel saved", { description: `${res.vessel?.name} (IMO ${res.vessel?.imo})` })
        setEditTarget(null)
        await load(search)
      } else {
        toast.error(res.error)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async (imoOverride?: string) => {
    const imo = (imoOverride ?? importImo).trim()
    if (!imo) return
    setImporting(true)
    try {
      const res = await importVesselFromProvider(ADMIN_PASSCODE, imo)
      if (res.ok) {
        const c = res.vessel?.compliance
        // A bare stub still has the IMO placeholder as its name (no data found).
        const bareStub = res.vessel?.name === `IMO ${res.vessel?.imo}`
        // Free public enrichment resolves name/type/flag but not tonnage.
        const needsCapacity = res.vessel?.source === "compliance" && !res.vessel?.capacity
        const hint = bareStub
          ? " — screened; add particulars manually"
          : needsCapacity
            ? " — add capacity to complete"
            : ""
        const desc = `${res.vessel?.name} (IMO ${res.vessel?.imo})${hint}`
        if (c?.status === "flagged") {
          toast.error("Sanctions match — do not transact", { description: c.note ?? desc })
        } else if (c?.status === "unverified") {
          toast.warning("Imported (compliance unverified)", { description: desc })
        } else {
          toast.success("Vessel imported · compliance clear", { description: desc })
        }
        setImportImo("")
        await load(search)
      } else {
        // No provider linked (or IMO not found upstream): guide the admin to
        // connect a provider, or add the vessel manually with the IMO pre-filled.
        toast.message("Live import unavailable", {
          description: res.error,
          action: providerConnected
            ? /^\d{7}$/.test(imo)
              ? { label: "Add manually", onClick: () => openCreate(imo) }
              : undefined
            : { label: "Connect provider", onClick: () => setProvidersOpen(true) },
        })
      }
    } finally {
      setImporting(false)
    }
  }

  const [rescreening, setRescreening] = useState<string | null>(null)
  const handleRescreen = async (v: Vessel) => {
    setRescreening(v.imo)
    try {
      const res = await rescreenVesselAdmin(ADMIN_PASSCODE, v.imo)
      if (res.ok) {
        const c = res.vessel?.compliance
        if (c?.status === "flagged") {
          toast.error(`${v.name}: sanctions match`, { description: c.note })
        } else if (c?.status === "unverified") {
          toast.warning(`${v.name}: compliance unverified`, { description: c?.note })
        } else {
          toast.success(`${v.name}: compliance clear`)
        }
        await load(search)
      } else {
        toast.error(res.error)
      }
    } finally {
      setRescreening(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const res = await deleteVesselAdmin(ADMIN_PASSCODE, deleteTarget.imo)
    if (res.ok) {
      toast.success("Vessel removed", { description: `${deleteTarget.name} (IMO ${deleteTarget.imo})` })
      setDeleteTarget(null)
      await load(search)
    } else {
      toast.error(res.error)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Ship className="h-4 w-4 text-muted-foreground" />
            Marine Vessel Catalogue
          </CardTitle>
          <CardDescription>
            Crude, refined-product and gas tankers. Search, add, edit, or import live data by IMO.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="vessel-search" className="text-xs">
                Search by name, IMO or cargo
              </Label>
              <div className="relative mt-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="vessel-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                  placeholder="e.g. Pacific Triton, 9512331, Jet A-1"
                  className="pl-8"
                />
              </div>
            </div>
            <Button variant="outline" onClick={runSearch} className="shrink-0">
              <Search className="mr-1.5 h-4 w-4" />
              Search
            </Button>
            <Button onClick={() => openCreate(searchedImo)} className="shrink-0">
              <Plus className="mr-1.5 h-4 w-4" />
              Add vessel
            </Button>
          </div>

          {/* Live data provider + free compliance status */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <Satellite className="h-4 w-4 text-muted-foreground" />
                {providerConnected ? (
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    Live master data: <span className="font-medium text-foreground">{providerLabel}</span> connected
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    No paid master-data provider — imports validate the IMO and run compliance only.
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setProvidersOpen(true)} className="shrink-0">
                <Satellite className="mr-1.5 h-3.5 w-3.5" />
                {providerConnected ? "Manage providers" : "Add master data"}
              </Button>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-emerald-600">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>
                Free compliance auto-check active — official IMO validation + OFAC sanctions screening, no token
                required.
              </span>
            </div>
            {/* Real-time AIS position feed status (same indicator clients see). */}
            <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
              <span className="text-xs text-muted-foreground">Real-time AIS position feed</span>
              <AisFeedStatus />
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="import-imo" className="text-xs">
                {providerConnected
                  ? `Import from ${providerLabel} + compliance (by IMO)`
                  : "Validate & compliance-check by IMO"}
              </Label>
              <Input
                id="import-imo"
                value={importImo}
                onChange={(e) => setImportImo(e.target.value)}
                placeholder="7-digit IMO number"
                className="mt-1"
                inputMode="numeric"
              />
            </div>
            <Button variant="secondary" onClick={() => handleImport()} disabled={importing || !importImo.trim()} className="shrink-0">
              {importing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
              Import
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading catalogue…
            </div>
          ) : vessels.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Ship className="h-8 w-8 text-muted-foreground/60" />
              {searchedImo ? (
                <>
                  <div>
                    <p className="text-sm font-medium">No catalogue match for IMO {searchedImo}</p>
                    <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                      This vessel isn&apos;t in the catalogue yet.{" "}
                      {providerConnected
                        ? `Import full particulars from ${providerLabel} (with compliance), or add it manually.`
                        : "Validate the IMO and run the free compliance check now, or add it manually."}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => handleImport(searchedImo)}
                      disabled={importing}
                    >
                      {importing ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-1.5 h-4 w-4" />
                      )}
                      {providerConnected ? `Import IMO ${searchedImo}` : `Validate & screen ${searchedImo}`}
                    </Button>
                    <Button onClick={() => openCreate(searchedImo)}>
                      <Plus className="mr-1.5 h-4 w-4" />
                      Add IMO {searchedImo} manually
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">No vessels found</p>
                  <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                    {search.trim()
                      ? "No catalogue entry matches that search. Search by exact 7-digit IMO to validate, screen and add a specific vessel."
                      : "The catalogue is empty. Add a vessel, or screen one by IMO."}
                  </p>
                  <Button onClick={() => openCreate()}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add vessel
                  </Button>
                </>
              )}
            </div>
          ) : (
            <ScrollArea className="h-[360px] pr-3">
              <div className="flex flex-col gap-2">
                {vessels.map((v) => (
                  <div
                    key={v.imo}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <button
                      type="button"
                      onClick={() => setOperateTarget(v)}
                      title={`Open trading operations for ${v.name}`}
                      className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{v.name}</span>
                        <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[v.type])}>
                          {VESSEL_TYPE_LABELS[v.type]}
                        </Badge>
                        <ComplianceBadge compliance={v.compliance} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        IMO {v.imo} · {v.vesselClass || "—"} · {v.capacity.toLocaleString("en-US")} {v.capacityUnit}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Anchor className="h-3 w-3" />
                          {v.location || "—"}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Gauge className="h-3 w-3" />
                          {VESSEL_STATUS_LABELS[v.status]}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Tag className="h-3 w-3" />
                          {v.cargo || "No cargo"}
                        </span>
                      </p>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => setOperateTarget(v)}
                        className="gap-1.5"
                        title={`Buy / sell ${v.name}'s cargo as a spot deal`}
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                        Operate
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRescreen(v)}
                        disabled={rescreening === v.imo}
                        title="Re-run compliance check"
                      >
                        {rescreening === v.imo ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        <span className="sr-only">Re-screen {v.name}</span>
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(v)}>
                        <Pencil className="h-3.5 w-3.5" />
                        <span className="sr-only">Edit {v.name}</span>
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDeleteTarget(v)}>
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        <span className="sr-only">Remove {v.name}</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Add / edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget?.updatedAt ? "Edit vessel" : "Add vessel"}</DialogTitle>
            <DialogDescription>Maintain accurate IMO, specifications, status and cargo.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-1">
              <Label htmlFor="f-imo" className="text-xs">
                IMO number
              </Label>
              <Input
                id="f-imo"
                value={form.imo}
                onChange={(e) => {
                  const next = e.target.value.replace(/\D/g, "").slice(0, 7)
                  set("imo", next)
                  // Auto-fill as soon as a full 7-digit IMO is entered for a new
                  // vessel (not when editing an existing record).
                  if (next.length === 7 && !editTarget?.updatedAt) void prefillFromImo(next)
                }}
                onBlur={(e) => {
                  const v = e.target.value.replace(/\D/g, "")
                  if (v.length === 7 && !editTarget?.updatedAt) void prefillFromImo(v)
                }}
                placeholder="7 digits"
                disabled={!!editTarget?.updatedAt}
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor="f-name" className="flex items-center gap-1.5 text-xs">
                Vessel name
                {prefilling && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    looking up…
                  </span>
                )}
              </Label>
              <Input
                id="f-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={prefilling ? "Retrieving from public registry…" : "Vessel name"}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={form.type} onValueChange={(v) => set("type", v as VesselType)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VESSEL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {VESSEL_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="f-class" className="text-xs">
                Class
              </Label>
              <Input
                id="f-class"
                value={form.vesselClass}
                onChange={(e) => set("vesselClass", e.target.value)}
                placeholder="VLCC, Suezmax, MR, LNG…"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="f-cap" className="text-xs">
                Capacity
              </Label>
              <Input
                id="f-cap"
                value={form.capacity ? String(form.capacity) : ""}
                onChange={(e) => set("capacity", Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
                inputMode="numeric"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Capacity unit</Label>
              <Select value={form.capacityUnit} onValueChange={(v) => set("capacityUnit", v as Vessel["capacityUnit"])}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DWT">DWT (deadweight tonnes)</SelectItem>
                  <SelectItem value="CBM">CBM (cubic metres)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v as VesselStatus)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VESSEL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {VESSEL_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="f-built" className="text-xs">
                Year built
              </Label>
              <Input
                id="f-built"
                value={form.builtYear ? String(form.builtYear) : ""}
                onChange={(e) => set("builtYear", Number(e.target.value.replace(/[^\d]/g, "")) || undefined)}
                inputMode="numeric"
                placeholder="e.g. 2016"
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="f-loc" className="text-xs">
                Last known location
              </Label>
              <Input
                id="f-loc"
                value={form.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder="Port or sea area"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="f-flag" className="text-xs">
                Flag
              </Label>
              <Input id="f-flag" value={form.flag} onChange={(e) => set("flag", e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="f-cargo" className="text-xs">
                Cargo (oil / gas)
              </Label>
              <Input
                id="f-cargo"
                value={form.cargo}
                onChange={(e) => set("cargo", e.target.value)}
                placeholder="e.g. Arab Light Crude"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Save vessel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove vessel?</DialogTitle>
            <DialogDescription>
              {deleteTarget ? `${deleteTarget.name} (IMO ${deleteTarget.imo}) will be removed from the catalogue.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live data provider management */}
      <Dialog open={providersOpen} onOpenChange={setProvidersOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Satellite className="h-4 w-4" />
              Live vessel-data providers
            </DialogTitle>
            <DialogDescription>
              The free compliance auto-check runs automatically with no token. Optionally link a paid AIS
              company for full master data (name, class, tonnage). No token is ever shown here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {/* Always-on, token-free compliance */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Compliance auto-check</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                    <ShieldCheck className="h-3 w-3" /> Active · free
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Official IMO check-digit validation + OFAC SDN &amp; Consolidated sanctions screening. Runs on
                  every import and vessel save — no API token required.
                </p>
              </div>
            </div>

            <p className="text-xs font-medium text-muted-foreground">Optional paid master-data providers</p>
            {(provider?.providers ?? VESSEL_PROVIDERS.map((p) => ({ ...p, configured: false }))).map((p) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.label}</span>
                    {p.configured ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                        <CheckCircle2 className="h-3 w-3" /> Connected
                      </span>
                    ) : (
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Not connected
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add token as{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{p.envVar}</code> in
                    project settings.
                  </p>
                </div>
                <a
                  href={p.signupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  Get token <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              In v0, add these tokens via the <span className="font-medium text-foreground">Vars</span> section
              of the project settings (top-right). Once a token is saved, return here and the provider will show
              as connected.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setProvidersOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full vessel trading operations workspace */}
      <VesselOperations vessel={operateTarget} onClose={() => setOperateTarget(null)} />
    </div>
  )
}

// --- Create spot deal -------------------------------------------------------

const emptyDealForm = {
  side: "sell" as SpotDealSide,
  vesselImo: "",
  productId: "",
  product: "",
  unit: "MT" as SpotDeal["unit"],
  quantity: "",
  spotPrice: "",
  currency: "USD",
  incoterm: "FOB",
  loadPortId: "",
  loadPort: "",
  dischargePort: "",
  terms: "",
  expiresAt: "",
  // Track which auto-filled fields the admin has manually overridden, so
  // re-running the suggestion engine never clobbers a deliberate edit.
  qtyTouched: false,
  priceTouched: false,
  loadPortTouched: false,
}

/** Small numbered step header for the guided create flow. */
function StepHeader({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {n}
      </span>
      <span className="text-sm font-medium">{title}</span>
      {hint ? <span className="min-w-0 text-xs text-muted-foreground">· {hint}</span> : null}
    </div>
  )
}

function CreateDeal({
  vessels,
  onCreated,
  lockedVesselImo,
  onManageVessels,
}: {
  vessels: Vessel[]
  onCreated: () => void
  /** When set, the deal is locked to this vessel (used by the vessel ops workspace). */
  lockedVesselImo?: string
  /** Jump to the Vessels tab so the admin can add/import a vessel to the catalogue. */
  onManageVessels?: () => void
}) {
  const locked = Boolean(lockedVesselImo)
  const [form, setForm] = useState(() => ({ ...emptyDealForm, vesselImo: lockedVesselImo ?? "" }))
  const [submitting, setSubmitting] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [key]: value }))

  const selectedVessel = useMemo(() => vessels.find((v) => v.imo === form.vesselImo), [vessels, form.vesselImo])
  const lockedVessel = useMemo(
    () => (lockedVesselImo ? vessels.find((v) => v.imo === lockedVesselImo) : undefined),
    [vessels, lockedVesselImo],
  )

  // Step 1 → Step 2 link: only tankers that can legally carry the chosen grade.
  const compatibleTypes = useMemo(
    () => (form.productId ? compatibleVesselTypesForProduct(form.productId) : VESSEL_TYPES),
    [form.productId],
  )
  const compatibleVessels = useMemo(
    () => vessels.filter((v) => compatibleTypes.includes(v.type)),
    [vessels, compatibleTypes],
  )

  // When locked to a specific vessel, only offer products that vessel can legally
  // carry, so Step 1 can never leave the deal pointing at an incompatible cargo.
  const productsForList = useMemo(
    () =>
      lockedVessel
        ? PETROLEUM_PRODUCTS.filter((p) => compatibleVesselTypesForProduct(p.id).includes(lockedVessel.type))
        : PETROLEUM_PRODUCTS,
    [lockedVessel],
  )

  // Live suggestion shown beneath the price field (recomputed as product / port
  // / incoterm change), so the admin always sees the desk's reference even after
  // a manual override.
  const suggestion = useMemo(
    () =>
      form.productId
        ? suggestSpotPrice({ productId: form.productId, portId: form.loadPortId, incoterm: form.incoterm })
        : null,
    [form.productId, form.loadPortId, form.incoterm],
  )

  // The desk suggestion is computed in the grade's native unit; re-express it in
  // the unit currently selected on the form so the reference, the "Use
  // suggested" action and the override check all match the price field.
  const suggestionInUnit = useMemo(() => {
    if (!suggestion) return null
    if (suggestion.unit === form.unit) return suggestion
    const factor = bblPerMtFor(form.productId ? getCatalogProduct(form.productId) : undefined)
    const price = suggestion.unit === "MT" ? suggestion.price / factor : suggestion.price * factor
    return { ...suggestion, unit: form.unit, price: Math.round(price * 100) / 100 }
  }, [suggestion, form.unit, form.productId])

  // Step 1: product drives the unit, filters vessels, and seeds a price.
  const handleProduct = (id: string) => {
    const product = getCatalogProduct(id)
    if (!product) return
    setForm((p) => {
      const types = compatibleVesselTypesForProduct(id)
      const keepVessel = vessels.some((v) => v.imo === p.vesselImo && types.includes(v.type))
      const next = {
        ...p,
        productId: id,
        product: product.name,
        unit: product.unit as SpotDeal["unit"],
        vesselImo: keepVessel ? p.vesselImo : "",
      }
      if (!p.priceTouched) {
        const s = suggestSpotPrice({ productId: id, portId: p.loadPortId, incoterm: p.incoterm })
        if (s) next.spotPrice = String(s.price)
      }
      if (!p.qtyTouched && keepVessel) {
        const q = suggestQuantity(selectedVessel, product.unit, id)
        if (q) next.quantity = String(q)
      } else if (!keepVessel) {
        next.quantity = p.qtyTouched ? p.quantity : ""
      }
      return next
    })
  }

  // Step 2: vessel seeds quantity available (from capacity) and the load port.
  const handleVessel = (imo: string) => {
    const v = vessels.find((x) => x.imo === imo)
    setForm((p) => {
      const next = { ...p, vesselImo: imo }
      if (v && !p.qtyTouched) {
        const q = suggestQuantity(v, p.unit as CommodityUnit, p.productId)
        if (q) next.quantity = String(q)
      }
      if (v && !p.loadPortTouched) {
        const port = findPortByLocation(v.location)
        if (port) {
          next.loadPortId = port.id
          next.loadPort = port.name
          if (!p.priceTouched) {
            const s = suggestSpotPrice({ productId: p.productId, portId: port.id, incoterm: p.incoterm })
            if (s) next.spotPrice = String(s.price)
          }
        }
      }
      return next
    })
  }

  const handlePort = (portId: string) => {
    const port = PORTS.find((x) => x.id === portId)
    setForm((p) => {
      const next = { ...p, loadPortId: portId, loadPort: port?.name ?? "", loadPortTouched: true }
      if (!p.priceTouched) {
        const s = suggestSpotPrice({ productId: p.productId, portId, incoterm: p.incoterm })
        if (s) next.spotPrice = String(s.price)
      }
      return next
    })
  }

  const handleIncoterm = (incoterm: string) => {
    setForm((p) => {
      const next = { ...p, incoterm }
      if (!p.priceTouched) {
        const s = suggestSpotPrice({ productId: p.productId, portId: p.loadPortId, incoterm })
        if (s) next.spotPrice = String(s.price)
      }
      return next
    })
  }

  const handleUnit = (unit: SpotDeal["unit"]) => {
    setForm((p) => {
      if (unit === p.unit) return p
      const next = { ...p, unit }
      // Re-express the SAME cargo and the SAME per-unit value in the newly
      // selected unit using the grade's density factor (MT × factor = bbl).
      // This runs whether or not the admin has edited the fields, so the price
      // never stays "stuck" at the previous unit's figure.
      const factor = bblPerMtFor(p.productId ? getCatalogProduct(p.productId) : undefined)
      const convert = (raw: string, mode: "price" | "qty"): string => {
        const n = Number.parseFloat((raw || "").replace(/[, ]/g, ""))
        if (!Number.isFinite(n) || n <= 0) return raw
        // Quantity: MT→bbl multiplies, bbl→MT divides.
        // Price (per unit): per-MT→per-bbl divides, per-bbl→per-MT multiplies.
        const out =
          mode === "qty"
            ? unit === "bbl"
              ? n * factor
              : n / factor
            : unit === "bbl"
              ? n / factor
              : n * factor
        return mode === "price" ? String(Math.round(out * 100) / 100) : String(Math.round(out))
      }
      next.spotPrice = convert(p.spotPrice, "price")
      next.quantity = convert(p.quantity, "qty")
      return next
    })
  }

  const applySuggestedPrice = () => {
    if (suggestionInUnit) setForm((p) => ({ ...p, spotPrice: String(suggestionInUnit.price), priceTouched: false }))
  }

  // Default the expiry to 48h ahead the first time the form opens.
  useEffect(() => {
    if (!form.expiresAt) {
      const d = new Date(Date.now() + 48 * 60 * 60 * 1000)
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
      set("expiresAt", d.toISOString().slice(0, 16))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const qty = Number.parseFloat(form.quantity.replace(/[, ]/g, ""))
  const price = Number.parseFloat(form.spotPrice.replace(/[, ]/g, ""))
  const total = computeTotalValue(Number.isFinite(qty) ? qty : 0, Number.isFinite(price) ? price : 0)
  const priceOverridden = Boolean(
    suggestionInUnit && form.priceTouched && Number(form.spotPrice) !== suggestionInUnit.price,
  )

  const submit = async (publish: boolean) => {
    if (!form.product.trim()) return toast.error("Select a product first.")
    if (!form.vesselImo) return toast.error("Select a compatible vessel.")
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("Enter a valid quantity.")
    if (!Number.isFinite(price) || price <= 0) return toast.error("Enter a valid spot price.")
    if (!form.loadPort.trim()) return toast.error("Select a load port.")
    if (!form.expiresAt) return toast.error("Set an expiry.")
    const expiresIso = new Date(form.expiresAt).toISOString()
    if (new Date(expiresIso).getTime() <= Date.now()) return toast.error("Expiry must be in the future.")

    const payload: CreateSpotDealInput = {
      vesselImo: form.vesselImo,
      side: form.side,
      product: form.product.trim(),
      productId: form.productId || undefined,
      quantity: qty,
      unit: form.unit,
      spotPrice: price,
      currency: form.currency,
      incoterm: form.incoterm,
      loadPort: form.loadPort.trim(),
      dischargePort: form.dischargePort.trim() || undefined,
      terms: form.terms.trim(),
      expiresAt: expiresIso,
      publish,
    }

    setSubmitting(true)
    try {
      const res = await createSpotDealAdmin(ADMIN_PASSCODE, payload)
      if (res.ok) {
        const sideLabel = SPOT_DEAL_SIDE_LABELS[form.side].toLowerCase()
        toast.success(publish ? `Spot ${sideLabel} published` : "Draft saved", {
          description: publish
            ? `${res.deal?.id} broadcast to ${res.delivered} active client${res.delivered === 1 ? "" : "s"} via Bankeka.`
            : `${res.deal?.id} saved as a draft.`,
        })
        // Preserve the side + locked vessel so the desk can raise back-to-back
        // offers on the same ship without re-selecting everything.
        setForm({ ...emptyDealForm, side: form.side, vesselImo: lockedVesselImo ?? "" })
        onCreated()
      } else {
        toast.error(res.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const regions = useMemo(() => portsByRegion(), [])
  const productChosen = Boolean(form.productId)

  const sideVerb = SPOT_DEAL_SIDE_VERB[form.side].toLowerCase()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4 text-muted-foreground" />
          {locked ? `Trade ${lockedVessel?.name ?? "this vessel"}` : "Create Spot Deal"}
        </CardTitle>
        <CardDescription>
          {locked
            ? `Raise a spot ${form.side === "buy" ? "bid to buy" : "offer to sell"} against this vessel's cargo, then review the auto-filled terms. Publishing broadcasts it to all active clients and lists it in Commodity Trading.`
            : "Pick the side, product and a compatible vessel, then review the auto-filled terms. Publishing broadcasts the deal to all active clients and lists it in Commodity Trading."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Market side — sell offer or buy bid */}
        <div className="flex flex-col gap-2">
          <StepHeader n={1} title="Side" hint="are you selling this cargo or bidding to buy it?" />
          <div className="grid grid-cols-2 gap-2">
            {(["sell", "buy"] as SpotDealSide[]).map((s) => {
              const active = form.side === s
              const Icon = s === "sell" ? Store : ShoppingCart
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => set("side", s)}
                  aria-pressed={active}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border p-3 text-sm font-medium transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-primary/40",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {SPOT_DEAL_SIDE_LABELS[s]}
                </button>
              )
            })}
          </div>
        </div>

        {/* Step 2 — Product */}
        <div className="flex flex-col gap-2">
          <StepHeader
            n={2}
            title="Product"
            hint={locked ? "grades this vessel can carry" : "sets the unit and filters compatible vessels"}
          />
          <Select value={form.productId} onValueChange={handleProduct}>
            <SelectTrigger>
              <SelectValue placeholder={`Select the product to ${form.side === "buy" ? "buy" : "offer"}`} />
            </SelectTrigger>
            <SelectContent>
              {COMMODITY_CATEGORIES.map((cat) => {
                const items = productsForList.filter((p) => p.category === cat)
                if (items.length === 0) return null
                return (
                  <SelectGroup key={cat}>
                    <SelectLabel>{cat}</SelectLabel>
                    {items.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )
              })}
            </SelectContent>
          </Select>
          {productChosen && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <PackageSearch className="h-3.5 w-3.5" />
              Priced in <span className="font-medium text-foreground">{form.unit}</span> · compatible with{" "}
              <span className="font-medium text-foreground">
                {compatibleTypes.map((t) => VESSEL_TYPE_LABELS[t]).join(" / ")}
              </span>
            </p>
          )}
        </div>

        {/* Step 3 — Vessel (filtered by product compatibility, or locked) */}
        <div className="flex flex-col gap-2">
          <StepHeader
            n={3}
            title="Vessel"
            hint={
              locked
                ? "locked to this vessel"
                : productChosen
                  ? `${compatibleVessels.length} compatible in catalogue`
                  : "select a product first"
            }
          />
          {locked ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2">
                <Ship className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{lockedVessel?.name ?? "—"}</span>
                {lockedVessel && (
                  <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[lockedVessel.type])}>
                    {VESSEL_TYPE_LABELS[lockedVessel.type]}
                  </Badge>
                )}
              </div>
              {lockedVessel && (
                <p className="mt-1 text-xs text-muted-foreground">
                  IMO {lockedVessel.imo} · {lockedVessel.vesselClass || "—"} ·{" "}
                  {lockedVessel.capacity.toLocaleString("en-US")} {lockedVessel.capacityUnit} ·{" "}
                  {VESSEL_STATUS_LABELS[lockedVessel.status]} · {lockedVessel.location || "—"}
                  {lockedVessel.cargo ? ` · carrying ${lockedVessel.cargo}` : ""}
                </p>
              )}
            </div>
          ) : (
            <>
              <Select value={form.vesselImo} onValueChange={handleVessel} disabled={!productChosen}>
                <SelectTrigger>
                  <SelectValue placeholder={productChosen ? "Select a compatible vessel" : "Choose a product to enable"} />
                </SelectTrigger>
                <SelectContent>
                  {compatibleVessels.length === 0 ? (
                    <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                      No compatible vessels in the catalogue for this product.
                    </div>
                  ) : (
                    compatibleVessels.map((v) => (
                      <SelectItem key={v.imo} value={v.imo}>
                        {v.name} — IMO {v.imo} ({VESSEL_TYPE_LABELS[v.type]})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedVessel && (
                <p className="text-xs text-muted-foreground">
                  {selectedVessel.vesselClass || "—"} · {selectedVessel.capacity.toLocaleString("en-US")}{" "}
                  {selectedVessel.capacityUnit} · {VESSEL_STATUS_LABELS[selectedVessel.status]} ·{" "}
                  {selectedVessel.location || "—"}
                  {selectedVessel.cargo ? ` · carrying ${selectedVessel.cargo}` : ""}
                </p>
              )}
              {/* Inline path to add a vessel without leaving the deal form — the
                  catalogue is managed on the Vessels tab, so surface it here
                  (this is where admins expect "add a new vessel"). */}
              {onManageVessels && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    {productChosen && compatibleVessels.length === 0
                      ? "No vessel here fits this product? Add or import one by IMO."
                      : "Vessel not in the list? Add or import it by IMO."}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={onManageVessels}
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add vessel
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Step 4 — Commercial terms (auto-filled, overridable) */}
        <div className="flex flex-col gap-3">
          <StepHeader n={4} title="Terms" hint="auto-filled — review and adjust" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="d-qty" className="text-xs">
                Quantity available
              </Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id="d-qty"
                  value={form.quantity}
                  onChange={(e) => setForm((p) => ({ ...p, quantity: e.target.value, qtyTouched: true }))}
                  placeholder="e.g. 1,000,000"
                  inputMode="decimal"
                />
                <Select value={form.unit} onValueChange={(v) => handleUnit(v as SpotDeal["unit"])}>
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bbl">bbl</SelectItem>
                    <SelectItem value="MT">MT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {selectedVessel && !form.qtyTouched && form.quantity && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="h-3 w-3" /> From vessel capacity (~95% laden)
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="d-price" className="text-xs">
                Spot price (per {form.unit})
              </Label>
              <div className="mt-1 flex gap-2">
                <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                  <SelectTrigger className="w-24">
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
                <Input
                  id="d-price"
                  value={form.spotPrice}
                  onChange={(e) => setForm((p) => ({ ...p, spotPrice: e.target.value, priceTouched: true }))}
                  placeholder="Special spot price"
                  inputMode="decimal"
                />
              </div>
              {suggestionInUnit && (
                <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="h-3 w-3" /> Suggested {suggestionInUnit.currency}{" "}
                  {suggestionInUnit.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
                  / {suggestionInUnit.unit} ({suggestionInUnit.basis} · market − desk discount)
                  {priceOverridden && (
                    <button
                      type="button"
                      onClick={applySuggestedPrice}
                      className="font-medium text-primary underline underline-offset-2"
                    >
                      Use suggested
                    </button>
                  )}
                </p>
              )}
            </div>

            <div>
              <Label className="text-xs">Incoterm</Label>
              <Select value={form.incoterm} onValueChange={handleIncoterm}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCOTERMS.map((i) => (
                    <SelectItem key={i} value={i}>
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs">Load port</Label>
              <Select value={form.loadPortId} onValueChange={handlePort}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a loading terminal" />
                </SelectTrigger>
                <SelectContent>
                  {regions.map((g) => (
                    <SelectGroup key={g.region}>
                      <SelectLabel>{g.region}</SelectLabel>
                      {g.ports.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} — {p.country}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {form.loadPortId && !form.loadPortTouched && selectedVessel && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Sparkles className="h-3 w-3" /> Matched from vessel location
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="d-expiry" className="text-xs">
                Offer expires (limited time)
              </Label>
              <Input
                id="d-expiry"
                type="datetime-local"
                value={form.expiresAt}
                onChange={(e) => set("expiresAt", e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="d-disch" className="text-xs">
                Discharge port (optional)
              </Label>
              <Input
                id="d-disch"
                value={form.dischargePort}
                onChange={(e) => set("dischargePort", e.target.value)}
                placeholder="e.g. Rotterdam"
                className="mt-1"
              />
            </div>

            <div className="sm:col-span-2">
              <Label htmlFor="d-terms" className="text-xs">
                Other relevant terms
              </Label>
              <Textarea
                id="d-terms"
                value={form.terms}
                onChange={(e) => set("terms", e.target.value)}
                placeholder="Payment terms, inspection, laycan, performance bond, etc."
                rows={3}
                className="mt-1"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs text-muted-foreground">
              Estimated {form.side === "buy" ? "bid" : "offer"} value
            </p>
            <p className="text-lg font-semibold tabular-nums">{formatMoney(total, form.currency)}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => submit(false)} disabled={submitting}>
              Save draft
            </Button>
            <Button onClick={() => submit(true)} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Megaphone className="mr-1.5 h-4 w-4" />}
              Publish {sideVerb}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// --- Published deals --------------------------------------------------------

function DealStatusBadge({ status }: { status: SpotDeal["status"] }) {
  const cls: Record<SpotDeal["status"], string> = {
    published: "border-green-500/30 bg-green-500/10 text-green-600",
    draft: "border-muted-foreground/30 bg-muted text-muted-foreground",
    withdrawn: "border-red-500/30 bg-red-500/10 text-red-600",
    expired: "border-amber-500/30 bg-amber-500/10 text-amber-600",
    engaged: "border-blue-500/30 bg-blue-500/10 text-blue-600",
  }
  return (
    <Badge variant="outline" className={cn("text-[10px]", cls[status])}>
      {SPOT_DEAL_STATUS_LABELS[status]}
    </Badge>
  )
}

function DealsList({
  refreshKey,
  onChanged,
  vesselImo,
  emptyLabel = "No spot deals yet.",
}: {
  refreshKey: number
  onChanged: () => void
  /** When set, only deals against this vessel are shown. */
  vesselImo?: string
  emptyLabel?: string
}) {
  const [allDeals, setAllDeals] = useState<SpotDeal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listSpotDealsAdmin(ADMIN_PASSCODE)
      if (res.ok) setAllDeals(res.deals)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const deals = useMemo(
    () => (vesselImo ? allDeals.filter((d) => d.vesselImo === vesselImo) : allDeals),
    [allDeals, vesselImo],
  )

  const act = async (fn: () => Promise<{ ok: boolean; error?: string; delivered?: number }>, id: string, ok: string) => {
    setBusy(id)
    try {
      const res = await fn()
      if (res.ok) {
        toast.success(ok)
        await load()
        onChanged()
      } else {
        toast.error(res.error)
      }
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading spot deals…
      </div>
    )
  }
  if (deals.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {deals.map((d) => {
        const cd = dealCountdown(d.expiresAt)
        return (
          <div key={d.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{d.product}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px]",
                    (d.side ?? "sell") === "buy"
                      ? "border-blue-500/30 bg-blue-500/10 text-blue-600"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
                  )}
                >
                  {SPOT_DEAL_SIDE_LABELS[d.side ?? "sell"]}
                </Badge>
                <DealStatusBadge status={d.status} />
                <span className="font-mono text-[10px] text-muted-foreground">{d.id}</span>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs",
                  cd.expired ? "text-muted-foreground" : cd.urgent ? "text-red-500" : "text-muted-foreground",
                )}
              >
                <Clock className="h-3 w-3" />
                {cd.expired ? "Expired" : `Ends in ${cd.label}`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {d.vesselName} (IMO {d.vesselImo}) · {d.quantity.toLocaleString("en-US")} {d.unit} ·{" "}
              {formatMoney(d.spotPrice, d.currency)}/{d.unit} · total {formatMoney(d.totalValue, d.currency)} · {d.incoterm}
              {d.loadPort ? ` ${d.loadPort}` : ""}
            </p>
            {(d.interests?.length ?? 0) > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {d.interests!.length} client interaction{d.interests!.length === 1 ? "" : "s"} recorded
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {(d.status === "draft" || d.status === "withdrawn" || d.status === "engaged") && !cd.expired && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === d.id}
                  onClick={() => act(() => publishSpotDealAdmin(ADMIN_PASSCODE, d.id), d.id, "Spot deal published")}
                >
                  <Megaphone className="mr-1.5 h-3.5 w-3.5" />
                  {d.status === "engaged" ? "Re-publish" : "Publish"}
                </Button>
              )}
              {d.status === "published" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === d.id}
                  onClick={() => act(() => withdrawSpotDealAdmin(ADMIN_PASSCODE, d.id), d.id, "Spot deal withdrawn")}
                >
                  <Ban className="mr-1.5 h-3.5 w-3.5 text-red-500" />
                  Withdraw
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- Vessel trading operations workspace ------------------------------------

/**
 * Full operative workspace for a single vessel: live position + particulars,
 * a spot-desk locked to this ship (buy OR sell its cargo), the deals already
 * running against it, and a jump-off to the client Commodity Trading section.
 * Opened by clicking a vessel in the catalogue.
 */
function VesselOperations({ vessel, onClose }: { vessel: Vessel | null; onClose: () => void }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])
  const router = useRouter()

  // Close the dialog first, then navigate. Leaving the modal mounted (its
  // overlay + body scroll-lock) over the destination is what made navigation
  // appear "stuck", so we always tear it down before routing away.
  const goToCommodityTrading = useCallback(() => {
    onClose()
    router.push("/dashboard/commodity")
  }, [onClose, router])

  return (
    <Dialog open={vessel !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {vessel && (
          <>
            <DialogHeader className="space-y-0 border-b border-border p-4 text-left">
              <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                <Ship className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{vessel.name}</span>
                <Badge variant="outline" className={cn("text-[10px]", TYPE_BADGE[vessel.type])}>
                  {VESSEL_TYPE_LABELS[vessel.type]}
                </Badge>
                <ComplianceBadge compliance={vessel.compliance} />
              </DialogTitle>
              <DialogDescription className="sr-only">
                Trading operations for {vessel.name}, IMO {vessel.imo}.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              <div className="flex min-w-0 flex-col gap-4 p-4">
                {/* Vessel particulars + live AIS position */}
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>IMO {vessel.imo}</span>
                    <span>{vessel.vesselClass || "—"}</span>
                    <span className="inline-flex items-center gap-1">
                      <Gauge className="h-3 w-3" />
                      {VESSEL_STATUS_LABELS[vessel.status]}
                    </span>
                    <span>
                      {vessel.capacity.toLocaleString("en-US")} {vessel.capacityUnit}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Anchor className="h-3 w-3" />
                      {vessel.location || "—"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Tag className="h-3 w-3" />
                      {vessel.cargo || "No cargo"}
                    </span>
                  </div>
                  <div className="border-t border-border/60 pt-2">
                    <VesselLivePositionLine imo={vessel.imo} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Waypoints className="h-3.5 w-3.5" />
                      Published deals broadcast to clients &amp; listed in Commodity Trading.
                    </span>
                    <Button variant="outline" size="sm" className="shrink-0" onClick={goToCommodityTrading}>
                      Open Commodity Trading
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Spot desk locked to this vessel (buy or sell) */}
                <CreateDeal vessels={[vessel]} lockedVesselImo={vessel.imo} onCreated={bump} />

                {/* Deals already running against this vessel */}
                <div className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Megaphone className="h-4 w-4 text-muted-foreground" />
                    Deals on this vessel
                  </h3>
                  <DealsList
                    refreshKey={refreshKey}
                    onChanged={bump}
                    vesselImo={vessel.imo}
                    emptyLabel="No spot deals on this vessel yet — raise a buy bid or sell offer above."
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// --- Top-level manager ------------------------------------------------------

export function SpotDealManager() {
  const [vessels, setVessels] = useState<Vessel[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  // Controlled tab so the Create form can jump the admin to the Vessels tab to
  // add/import a vessel to the catalogue.
  const [tab, setTab] = useState("deals")
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])

  // Load the catalogue at the top level so the Create tab has vessels to choose
  // from immediately, even before the Vessels tab is opened. The VesselCatalogue
  // tab keeps this in sync via the same onVesselsChanged callback.
  useEffect(() => {
    let cancelled = false
    listVesselsAdmin(ADMIN_PASSCODE)
      .then((res) => {
        if (!cancelled && res.ok) setVessels(res.vessels)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="deals" className="gap-1.5">
          <Tag className="h-4 w-4" />
          Create
        </TabsTrigger>
        <TabsTrigger value="published" className="gap-1.5">
          <Megaphone className="h-4 w-4" />
          Published
        </TabsTrigger>
        <TabsTrigger value="vessels" className="gap-1.5">
          <Ship className="h-4 w-4" />
          Vessels
        </TabsTrigger>
      </TabsList>

      <TabsContent value="deals" className="mt-4">
        <CreateDeal vessels={vessels} onCreated={bump} onManageVessels={() => setTab("vessels")} />
      </TabsContent>

      <TabsContent value="published" className="mt-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spot Deals</CardTitle>
            <CardDescription>
            Published, draft, engaged (accepted), withdrawn and expired offers with their countdowns.
          </CardDescription>
          </CardHeader>
          <CardContent>
            <DealsList refreshKey={refreshKey} onChanged={bump} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="vessels" className="mt-4">
        <VesselCatalogue onVesselsChanged={setVessels} />
      </TabsContent>
    </Tabs>
  )
}
