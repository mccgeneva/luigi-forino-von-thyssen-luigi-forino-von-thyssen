"use client"

import { useEffect, useMemo, useState } from "react"
import { Banknote, Building2, Loader2, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CountryCombobox } from "@/components/country-combobox"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  adminCreateProjectFinanceForUser,
  adminTreasuryFinancing,
  type TreasuryFinancingTier,
} from "@/app/actions/admin-finance"
import {
  calculateAesEquity,
  calculateCashCommitment,
  AES_MIN_FACILITY,
  AES_EQUITY_COMPONENTS,
  type AesEquityComponent,
} from "@/lib/aes"
import { TREASURY_PROFILES } from "@/lib/treasury-store"
import { TREASURY_FINANCING_ANNUAL_RATE, monthlyTreasuryInterest } from "@/lib/treasury-financing"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

const fmt = (value: number, currency = "EUR") =>
  `${currency} ${Math.round(value).toLocaleString("en-US")}`

function ClientSelect({
  clients,
  value,
  onChange,
  placeholder,
}: {
  clients: SelectableClient[]
  value: string
  onChange: (id: string) => void
  placeholder: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-11 w-full min-w-0 [&>span]:truncate">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {clients.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.fullName} · {c.company || c.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ProjectFinanceAdmin({ onDone }: { onDone?: () => void }) {
  const [clients, setClients] = useState<SelectableClient[]>([])

  useEffect(() => {
    let active = true
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        if (active && list.length) setClients(list)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // --- Project finance on behalf --------------------------------------------
  const [pfClient, setPfClient] = useState("")
  const [projectName, setProjectName] = useState("")
  const [sector, setSector] = useState("")
  const [jurisdiction, setJurisdiction] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [facility, setFacility] = useState("")
  const [riskScore, setRiskScore] = useState("")
  const [components, setComponents] = useState<AesEquityComponent[]>(["cash"])
  const [description, setDescription] = useState("")
  const [pfSaving, setPfSaving] = useState(false)

  const facilityNum = Number(facility) || 0
  const riskNum = riskScore === "" ? undefined : Math.min(10, Math.max(0, Number(riskScore) || 0))

  const preview = useMemo(() => {
    if (facilityNum < AES_MIN_FACILITY) return null
    const equity = calculateAesEquity(facilityNum)
    const commitment = calculateCashCommitment(facilityNum, equity.totalEquity, riskNum)
    return { equity, commitment }
  }, [facilityNum, riskNum])

  function toggleComponent(id: AesEquityComponent) {
    setComponents((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))
  }

  async function submitProjectFinance() {
    if (!pfClient) return toast.error("Select a client to fund.")
    if (facilityNum < AES_MIN_FACILITY) {
      return toast.error(`The facility must be at least ${fmt(AES_MIN_FACILITY, currency)}.`)
    }
    setPfSaving(true)
    try {
      const res = await adminCreateProjectFinanceForUser(ADMIN_PASSCODE, pfClient, {
        projectName,
        sector,
        jurisdiction,
        description,
        currency,
        facility: facilityNum,
        equityComponents: components,
        riskScore: riskNum,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(`Funded ${fmt(facilityNum, currency)} for ${projectName}.`)
      setProjectName("")
      setSector("")
      setJurisdiction("")
      setFacility("")
      setRiskScore("")
      setDescription("")
      setComponents(["cash"])
      onDone?.()
    } finally {
      setPfSaving(false)
    }
  }

  // --- Treasury financing (admin only) --------------------------------------
  const [tryClient, setTryClient] = useState("")
  const [tier, setTier] = useState<TreasuryFinancingTier>("pro")
  const [tryNote, setTryNote] = useState("")
  const [armed, setArmed] = useState(false)
  const [trySaving, setTrySaving] = useState(false)

  const tierProfile = TREASURY_PROFILES.find((p) => p.key === tier) ?? TREASURY_PROFILES[0]

  async function executeTreasuryFinancing() {
    if (!tryClient) return toast.error("Select a client to finance.")
    if (!armed) {
      setArmed(true)
      return
    }
    setTrySaving(true)
    try {
      const res = await adminTreasuryFinancing(ADMIN_PASSCODE, tryClient, tier, tryNote)
      if (!res.ok) {
        toast.error(res.error || "Treasury financing failed.")
        return
      }
      toast.success(`Treasury financing of ${fmt(res.amount ?? tierProfile.requiredDeposit)} executed.`)
      setArmed(false)
      setTryNote("")
      onDone?.()
    } finally {
      setTrySaving(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Project finance on behalf of a client */}
      <Card className="min-w-0 bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg font-semibold">Submit Project Finance (on behalf)</CardTitle>
          </div>
          <CardDescription>
            Create and fund an AES project finance facility for a client. The application is approved
            immediately and the facility capital is credited to the client&apos;s balance at once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Client</Label>
            <ClientSelect
              clients={clients}
              value={pfClient}
              onChange={setPfClient}
              placeholder="Select a client to fund"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-project">Project name</Label>
            <Input
              id="pf-project"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. Solar Plant Phase II"
              className="h-11"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pf-sector">Sector</Label>
              <Input
                id="pf-sector"
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                placeholder="e.g. Energy"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pf-jurisdiction">Jurisdiction</Label>
              <CountryCombobox
                id="pf-jurisdiction"
                valueMode="name"
                value={jurisdiction}
                onChange={setJurisdiction}
                placeholder="Select country"
                triggerClassName="h-11"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="h-11">
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
            <div className="col-span-2 space-y-2">
              <Label htmlFor="pf-facility">Facility amount</Label>
              <MoneyInput
                id="pf-facility"
                value={facility}
                onValueChange={setFacility}
                placeholder={`Min ${AES_MIN_FACILITY.toLocaleString("en-US")}`}
                className="h-11"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-risk">Risk score (0–10, optional)</Label>
            <Input
              id="pf-risk"
              inputMode="numeric"
              value={riskScore}
              onChange={(e) => setRiskScore(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="Sets the upfront cash commitment"
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label>Equity composition</Label>
            <div className="flex flex-wrap gap-2">
              {AES_EQUITY_COMPONENTS.map((c) => {
                const active = components.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleComponent(c.id)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-xs font-medium transition-colors min-h-11",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-desc">Purpose / notes (optional)</Label>
            <Textarea
              id="pf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use of proceeds, structuring notes, etc."
              rows={2}
            />
          </div>

          {preview && (
            <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Total equity obligation</span>
                <span className="font-medium">
                  {fmt(preview.equity.totalEquity, currency)} @{" "}
                  {(preview.equity.effectiveRate * 100).toFixed(2)}%
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Upfront cash commitment</span>
                <span className="font-medium">
                  {riskNum === undefined
                    ? `${fmt(preview.commitment.min, currency)} – ${fmt(preview.commitment.max, currency)}`
                    : fmt(preview.commitment.applicable, currency)}
                </span>
              </div>
            </div>
          )}

          <Button onClick={submitProjectFinance} disabled={pfSaving} className="w-full min-h-11">
            {pfSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Funding…
              </>
            ) : (
              <>
                <Banknote className="mr-2 h-4 w-4" /> Submit &amp; fund facility
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Treasury financing exception (admin only) */}
      <Card className="min-w-0 bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg font-semibold">Treasury Financing</CardTitle>
            <Badge variant="outline" className="border-primary/20 bg-primary/10 text-primary text-[10px]">
              Admin only
            </Badge>
          </div>
          <CardDescription>
            Directly finance a client&apos;s treasury security deposit. Credits the balance and
            regularizes the deposit to Fully Secured in one step. The financed principal carries a{" "}
            {(TREASURY_FINANCING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest, charged monthly
            from the financing date.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Client</Label>
            <ClientSelect
              clients={clients}
              value={tryClient}
              onChange={(id) => {
                setTryClient(id)
                setArmed(false)
              }}
              placeholder="Select a client to finance"
            />
          </div>

          <div className="space-y-2">
            <Label>Financing facility</Label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {TREASURY_PROFILES.map((p) => {
                const active = tier === p.key
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      setTier(p.key)
                      setArmed(false)
                    }}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/10"
                        : "border-border bg-secondary/30 hover:border-primary/40",
                    )}
                  >
                    <p className={cn("text-sm font-semibold", active ? "text-primary" : "text-foreground")}>
                      {fmt(p.requiredDeposit)}
                    </p>
                    <p className="text-xs text-muted-foreground">{p.label}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {fmt(monthlyTreasuryInterest(p.requiredDeposit))}/mo interest
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="try-note">Note (optional)</Label>
            <Textarea
              id="try-note"
              value={tryNote}
              onChange={(e) => setTryNote(e.target.value)}
              placeholder="Reason / reference for the financing"
              rows={2}
            />
          </div>

          <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
            <p className="text-muted-foreground">
              On execution: credit{" "}
              <span className="font-medium text-foreground">{fmt(tierProfile.requiredDeposit)}</span> to the
              client&apos;s EUR balance, regularize the treasury deposit to{" "}
              <span className="font-medium text-foreground">Fully Secured</span>, and log a treasury
              transaction. A {(TREASURY_FINANCING_ANNUAL_RATE * 100).toFixed(0)}% p.a. debit interest
              (≈ <span className="font-medium text-foreground">{fmt(monthlyTreasuryInterest(tierProfile.requiredDeposit))}</span>/month)
              then accrues automatically from today.
            </p>
          </div>

          <Button
            onClick={executeTreasuryFinancing}
            disabled={trySaving}
            variant={armed ? "destructive" : "default"}
            className="w-full min-h-11"
          >
            {trySaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Executing…
              </>
            ) : armed ? (
              `Confirm — finance ${fmt(tierProfile.requiredDeposit)}`
            ) : (
              <>
                <ShieldCheck className="mr-2 h-4 w-4" /> Execute treasury financing
              </>
            )}
          </Button>
          {armed && !trySaving && (
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
