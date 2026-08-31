"use client"

import { useEffect, useMemo, useState } from "react"
import { Landmark, Loader2, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import { adminIssueInstrument } from "@/app/actions/approvals"
import { buildInstrumentIdentifiers } from "@/lib/instrument-identifiers"
import { IsinTools } from "@/components/instruments/isin-tools"
import { partnerBankByKey } from "@/lib/partner-banks"
import { BankCombobox } from "@/components/admin/bank-combobox"
import { useActivityLog } from "@/components/activity-tracker"

const TYPE_META: Record<string, { short: string; full: string }> = {
  sblc: { short: "SBLC", full: "Stand-by Letter of Credit" },
  mtn: { short: "MTN", full: "Medium Term Note" },
  bg: { short: "BG", full: "Bank Guarantee" },
}

const PURPOSE_NAMES: Record<string, string> = {
  trade: "Trade Finance",
  investment: "Investment",
  commodity: "Commodity Trading",
  performance: "Performance Guarantee",
  ppp: "PPP/Yield Program",
}

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"]

export function InstrumentIssuer() {
  const logActivity = useActivityLog()
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [targetUserId, setTargetUserId] = useState("")

  const [instrumentType, setInstrumentType] = useState("")
  const [faceValue, setFaceValue] = useState("")
  const [currency, setCurrency] = useState("EUR")
  const [issuingBank, setIssuingBank] = useState("")
  const [purpose, setPurpose] = useState("trade")
  const [rating, setRating] = useState("AAA+")
  const [submitting, setSubmitting] = useState(false)

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

  const selectedClient = clients.find((c) => c.id === targetUserId)

  // Generate the identifier set (incl. a valid ISIN) as soon as a bank + type are
  // chosen, so the admin can verify the EXACT ISIN that will be issued before
  // committing. Memoised on [bank, type] so the ISIN is stable while the admin
  // reviews it — and the very same object is used at issue time.
  const previewIdentifiers = useMemo(() => {
    const meta = TYPE_META[instrumentType]
    if (!issuingBank || !meta) return null
    return buildInstrumentIdentifiers(issuingBank, meta.short)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuingBank, instrumentType])

  const reset = () => {
    setInstrumentType("")
    setFaceValue("")
    setCurrency("EUR")
    setIssuingBank("")
    setPurpose("trade")
    setRating("AAA+")
  }

  const handleIssue = async () => {
    if (!targetUserId || !selectedClient) {
      toast.error("Select a client to issue to.")
      return
    }
    const meta = TYPE_META[instrumentType]
    if (!meta) {
      toast.error("Select an instrument type.")
      return
    }
    const numericValue = Number.parseFloat(faceValue.replace(/[^0-9.]/g, ""))
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      toast.error("Enter a valid face value greater than 0.")
      return
    }
    if (!issuingBank) {
      toast.error("Select an issuing bank.")
      return
    }

    const now = new Date()
    const expiry = new Date(now)
    expiry.setFullYear(expiry.getFullYear() + 1)
    const issuer = partnerBankByKey(issuingBank)?.name ?? "—"
    // Reuse the previewed/verified identifier set so the issued ISIN is exactly
    // the one the admin validated; fall back to a fresh set defensively.
    const identifiers = previewIdentifiers ?? buildInstrumentIdentifiers(issuingBank, meta.short, now)

    const instrument = {
      id: `${meta.short}-${now.getTime().toString().slice(-6)}`,
      type: meta.short,
      typeFull: meta.full,
      issuer,
      faceValue: numericValue,
      currency: currency.toUpperCase(),
      issuedDate: now.toISOString().split("T")[0],
      expiryDate: expiry.toISOString().split("T")[0],
      daysRemaining: 365,
      rating,
      purpose: PURPOSE_NAMES[purpose] ?? "Trade Finance",
      assignable: true,
      monetizable: true,
      ...identifiers,
    }

    setSubmitting(true)
    try {
      const res = await adminIssueInstrument(ADMIN_PASSCODE, targetUserId, instrument)
      if (!res.ok) {
        toast.error("Could not issue instrument", { description: res.error })
        return
      }
      const formattedFace = `${currency.toUpperCase()} ${numericValue.toLocaleString("en-US")}`
      toast.success("Instrument issued", {
        description: `${meta.short} ${instrument.id} (${formattedFace}) issued to ${selectedClient.fullName}.`,
      })
      logActivity({
        action: `Administrator issued ${meta.short} ${instrument.id} (${formattedFace}) to ${selectedClient.fullName}`,
        category: "Administration / Instruments",
        details: {
          summary: `Administrator issued a ${meta.full} (${meta.short}) with a face value of ${formattedFace}, issued by ${issuer}, directly into ${selectedClient.fullName}'s portfolio. The instrument is active.`,
          referenceId: instrument.id,
          instrumentType: `${meta.short} — ${meta.full}`,
          faceValue: formattedFace,
          issuingBank: issuer,
          targetAccount: `${selectedClient.fullName} — ${selectedClient.email}`,
        },
      })
      reset()
    } catch (err) {
      toast.error("Could not issue instrument", { description: (err as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Landmark className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-lg">Issue Bank Instrument</CardTitle>
            <p className="text-sm text-muted-foreground">
              Issue an instrument directly into a client&apos;s portfolio. Clients cannot create instruments themselves.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="issue-client">Client</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger id="issue-client">
              <SelectValue placeholder="Select a client account" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.fullName} {c.company ? `· ${c.company}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="issue-type">Instrument Type</Label>
            <Select value={instrumentType} onValueChange={setInstrumentType}>
              <SelectTrigger id="issue-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sblc">SBLC — Stand-by Letter of Credit</SelectItem>
                <SelectItem value="mtn">MTN — Medium Term Note</SelectItem>
                <SelectItem value="bg">BG — Bank Guarantee</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-bank">Issuing Bank</Label>
            <BankCombobox id="issue-bank" value={issuingBank} onChange={setIssuingBank} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-face">Face Value</Label>
            <MoneyInput
              id="issue-face"
              placeholder="0.00"
              value={faceValue}
              onValueChange={setFaceValue}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-currency">Currency</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="issue-currency">
                <SelectValue placeholder="EUR" />
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
          <div className="grid gap-2">
            <Label htmlFor="issue-purpose">Purpose</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger id="issue-purpose">
                <SelectValue placeholder="Trade Finance" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PURPOSE_NAMES).map(([key, name]) => (
                  <SelectItem key={key} value={key}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-rating">Credit Rating</Label>
            <Input
              id="issue-rating"
              placeholder="AAA+"
              value={rating}
              onChange={(e) => setRating(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-xs text-muted-foreground text-pretty">
            Issuance is recorded on the approvals backbone and delivered to the client&apos;s portfolio across devices. The client view is read-only.
          </p>
        </div>

        {/* Verify the exact ISIN that will be issued against live market data */}
        {previewIdentifiers ? (
          <IsinTools
            defaultIsin={previewIdentifiers.isin}
            title="Verify the ISIN to be issued"
            description="This is the ISIN that will be attached to the issued instrument. Its format and ISO 6166 check digit are valid; resolve it against Bloomberg to confirm market status. Private SBLC / BG / MTN instruments are delivered bank-to-bank via SWIFT MT760 and are not exchange-listed."
            onLog={logActivity}
            logCategory="Administration / Instruments"
          />
        ) : null}

        <Button onClick={handleIssue} disabled={submitting} className="w-full sm:w-auto">
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Issuing&hellip;
            </>
          ) : (
            <>
              <Landmark className="mr-2 h-4 w-4" />
              Issue Instrument
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
