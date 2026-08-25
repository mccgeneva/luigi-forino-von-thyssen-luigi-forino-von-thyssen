"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Network, Loader2, Search, Building2, Landmark, Save, Mail, User2, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import type {
  AdminUserView,
  AdminUsersResult,
  MasterBankProfile,
  MasterBankProfileResult,
  CurrencyBankAccount,
} from "@/app/actions/admin-users"
import { MANAGED_BANK_CURRENCIES } from "@/lib/managed-bank-currencies"
import { relationshipLabel } from "@/lib/account-hierarchy"
import { validateIban, validateBic, lookupBankByIban, isGenericBankInfo } from "@/lib/iban-swift"
import { resolveIbanExternal } from "@/app/actions/bank-resolve"

// Default account currency for an IBAN's country code (ISO 3166 → ISO 4217).
// Eurozone members all map to EUR; non-euro markets map to their own currency.
const IBAN_COUNTRY_CURRENCY: Record<string, string> = {
  AD: "EUR", AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR",
  FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR",
  LU: "EUR", LV: "EUR", MC: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR",
  SK: "EUR", CH: "CHF", LI: "CHF", GB: "GBP", US: "USD", DK: "DKK", NO: "NOK",
  SE: "SEK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", HK: "HKD",
  SG: "SGD", JP: "JPY", CN: "CNY", AU: "AUD", IL: "ILS", AE: "AED", SA: "SAR",
  QA: "QAR", KW: "KWD", BH: "BHD",
}
const currencyForIbanCountry = (cc: string): string | undefined => IBAN_COUNTRY_CURRENCY[cc?.toUpperCase()]

// Fixed, selectable account-currency list for the primary master account.
const CURRENCY_OPTIONS = ["EUR", "USD", "GBP", "CHF"] as const

async function fetchUsers(): Promise<AdminUserView[]> {
  try {
    const res = await fetch(`/api/admin/users?p=${encodeURIComponent(ADMIN_PASSCODE)}`, {
      headers: { "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => null)) as AdminUsersResult | null
    return data?.ok ? data.users : []
  } catch {
    return []
  }
}

async function postAction(action: string, payload: Record<string, unknown>): Promise<MasterBankProfileResult> {
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
      body: JSON.stringify(payload.__isSave ? { action, input: payload.input } : { action, id: payload.id }),
    })
    const data = (await res.json().catch(() => null)) as MasterBankProfileResult | null
    return data ?? { ok: false, error: "The request could not be completed. Please try again." }
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." }
  }
}

export function MasterAccountManager() {
  const [users, setUsers] = useState<AdminUserView[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [query, setQuery] = useState("")

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [profile, setProfile] = useState<MasterBankProfile | null>(null)
  const [loadingProfile, setLoadingProfile] = useState(false)

  // Editable form fields (pre-filled from the resolved master account).
  const [email, setEmail] = useState("")
  const [iban, setIban] = useState("")
  const [swift, setSwift] = useState("")
  const [bankName, setBankName] = useState("")
  const [currency, setCurrency] = useState("")
  // Per-currency settlement accounts (USD / GBP / CHF …), keyed by currency.
  const [currencyAccounts, setCurrencyAccounts] = useState<Record<string, CurrencyBankAccount>>({})
  // Per-currency "resolving bank from IBAN…" spinners, keyed by currency.
  const [currencyLookup, setCurrencyLookup] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [bankLookingUp, setBankLookingUp] = useState(false)

  useEffect(() => {
    let active = true
    setLoadingUsers(true)
    fetchUsers()
      .then((u) => active && setUsers(u))
      .finally(() => active && setLoadingUsers(false))
    return () => {
      active = false
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) =>
      [u.fullName, u.company, u.email].filter(Boolean).some((v) => v!.toLowerCase().includes(q)),
    )
  }, [users, query])

  const applyProfile = (p: MasterBankProfile) => {
    setProfile(p)
    setEmail(p.masterEmail || "")
    setIban(p.iban || "")
    setSwift(p.swift || "")
    setBankName(p.bankName || "")
    setCurrency(p.accountCurrency || "")
    // Seed an editable field set for each managed currency (USD/GBP/CHF …),
    // pre-filled from anything already on file.
    const seeded: Record<string, CurrencyBankAccount> = {}
    for (const cur of MANAGED_BANK_CURRENCIES) seeded[cur] = { currency: cur }
    for (const acct of p.currencyAccounts ?? []) {
      seeded[acct.currency] = { currency: acct.currency, iban: acct.iban, swift: acct.swift, bankName: acct.bankName }
    }
    setCurrencyAccounts(seeded)
  }

  // Update one field of a per-currency settlement account.
  const updateCurrencyField = (cur: string, field: "iban" | "swift" | "bankName", value: string) => {
    setCurrencyAccounts((prev) => ({
      ...prev,
      [cur]: { ...(prev[cur] ?? { currency: cur }), currency: cur, [field]: value },
    }))
  }

  const selectCustomer = async (u: AdminUserView) => {
    setSelectedId(u.id)
    setProfile(null)
    setLoadingProfile(true)
    const res = await postAction("loadMasterBank", { id: u.id })
    setLoadingProfile(false)
    if (res.ok) applyProfile(res.profile)
    else toast.error("Could not load bank details", { description: res.error })
  }

  // Live IBAN / SWIFT validation.
  const ibanCheck = useMemo(() => (iban.trim() ? validateIban(iban) : null), [iban])
  const bicCheck = useMemo(() => (swift.trim() ? validateBic(swift) : null), [swift])
  const ibanInvalid = !!ibanCheck && !ibanCheck.valid
  const bicInvalid = !!bicCheck && !bicCheck.valid

  const validIban = ibanCheck?.valid ? ibanCheck.formatted.replace(/\s/g, "") : ""

  // Keep the latest SWIFT readable inside the async resolver without making it
  // a dependency (which would re-run the resolver on every keystroke).
  const swiftRef = useRef("")
  swiftRef.current = swift

  // Resolve the bank a given IBAN actually belongs to: the curated directory
  // first, then the external resolver as a fallback. Returns a clean bank name
  // (structural placeholders stripped) and the BIC.
  const resolveBankForIban = async (ibanClean: string): Promise<{ bic?: string; name?: string }> => {
    let info = await lookupBankByIban(ibanClean)
    if (isGenericBankInfo(info)) {
      try {
        const ext = await resolveIbanExternal(ibanClean)
        if (ext && (ext.name || ext.bic)) {
          info = {
            name: ext.name || info?.name || "",
            bic: ext.bic || info?.bic,
            city: ext.city,
            country: info?.country || "",
            countryCode: info?.countryCode || ibanClean.slice(0, 2),
          }
        }
      } catch {
        /* best-effort — keep the structural fallback */
      }
    }
    const cleanName =
      info?.name && !/^Bank code /.test(info.name) && info.name !== "Registered institution" ? info.name : undefined
    return { bic: info?.bic, name: cleanName }
  }

  // Per-currency IBAN handler: sets the IBAN and, when it becomes VALID,
  // auto-fills that currency's SWIFT/BIC + bank name from the IBAN (same source-
  // of-truth behaviour as the primary EUR account) — overwriting a stale
  // wrong-country SWIFT, otherwise only filling empty fields.
  const handleCurrencyIban = (cur: string, raw: string) => {
    const value = raw.toUpperCase()
    updateCurrencyField(cur, "iban", value)
    const check = value.trim() ? validateIban(value) : null
    if (!check?.valid) return
    const clean = check.formatted.replace(/\s/g, "")
    const ibanCountry = clean.slice(0, 2)
    setCurrencyLookup((p) => ({ ...p, [cur]: true }))
    ;(async () => {
      const bank = await resolveBankForIban(clean)
      setCurrencyAccounts((prev) => {
        const cur0 = prev[cur] ?? { currency: cur }
        // Only reconcile if the IBAN hasn't changed again while resolving.
        if ((cur0.iban ?? "").replace(/\s/g, "").toUpperCase() !== clean) return prev
        const curSwift = (cur0.swift ?? "").trim()
        const curSwiftCheck = curSwift ? validateBic(curSwift) : null
        const overwrite = !!(curSwiftCheck?.valid && curSwiftCheck.countryCode !== ibanCountry)
        const next: CurrencyBankAccount = { ...cur0, currency: cur }
        if (bank.bic) {
          next.swift = overwrite ? bank.bic : curSwift || bank.bic
          if (bank.name) next.bankName = overwrite ? bank.name : (cur0.bankName ?? "").trim() || bank.name
          else if (overwrite) next.bankName = ""
        } else if (overwrite) {
          next.swift = ""
          next.bankName = ""
        } else if (bank.name) {
          next.bankName = (cur0.bankName ?? "").trim() || bank.name
        }
        return { ...prev, [cur]: next }
      })
    })().finally(() => setCurrencyLookup((p) => ({ ...p, [cur]: false })))
  }

  // Whenever a VALID IBAN is present, reconcile the SWIFT/BIC, bank name and
  // currency to it. The IBAN is the source of truth: if the current SWIFT/BIC
  // belongs to a DIFFERENT country (a stale value left over from a previous
  // IBAN), it is OVERWRITTEN with the bank this IBAN really belongs to; empty
  // fields are simply filled. This runs on load and on every IBAN edit.
  useEffect(() => {
    if (!validIban) return
    let active = true
    const ibanCountry = validIban.slice(0, 2)
    const curSwift = swiftRef.current.trim()
    const curSwiftCheck = curSwift ? validateBic(curSwift) : null
    // Overwrite when the existing SWIFT is a valid BIC from another country.
    const overwrite = !!(curSwiftCheck?.valid && curSwiftCheck.countryCode !== ibanCountry)

    const ccy = currencyForIbanCountry(ibanCountry)
    if (ccy) setCurrency((prev) => (overwrite ? ccy : prev.trim() || ccy))

    setBankLookingUp(true)
    ;(async () => {
      const bank = await resolveBankForIban(validIban)
      if (!active) return
      if (bank.bic) {
        setSwift((prev) => (overwrite ? bank.bic! : prev.trim() || bank.bic!))
        if (bank.name) setBankName((prev) => (overwrite ? bank.name! : prev.trim() || bank.name!))
        else if (overwrite) setBankName("")
      } else if (overwrite) {
        // Could not resolve a bank in the IBAN's country — clear the stale
        // wrong-country SWIFT/bank so no impossible pair is ever saved.
        setSwift("")
        setBankName("")
        toast.info("Enter the SWIFT/BIC for this IBAN", {
          description: `The previous SWIFT/BIC was from another country and was cleared. Add the correct ${ibanCountry} bank details.`,
        })
      } else if (bank.name) {
        setBankName((prev) => prev.trim() || bank.name!)
      }
    })().finally(() => active && setBankLookingUp(false))
    return () => {
      active = false
    }
  }, [validIban])

  // Safety net for a manually mistyped SWIFT (same IBAN, wrong-country BIC): the
  // resolver above only runs when the IBAN changes, so still flag a live
  // cross-country pair and let the admin snap it back to the IBAN's bank.
  const countryMismatch = !!(
    ibanCheck?.valid &&
    bicCheck?.valid &&
    ibanCheck.countryCode !== bicCheck.countryCode
  )

  const fixFromIban = async () => {
    if (!validIban) return
    setBankLookingUp(true)
    try {
      const bank = await resolveBankForIban(validIban)
      const ccy = currencyForIbanCountry(validIban.slice(0, 2))
      if (ccy) setCurrency(ccy)
      if (bank.bic) {
        setSwift(bank.bic)
        setBankName(bank.name ?? "")
      } else {
        setSwift("")
        setBankName("")
        toast.info("Couldn't resolve a bank for this IBAN", {
          description: "Enter the correct SWIFT/BIC and bank name manually.",
        })
      }
    } finally {
      setBankLookingUp(false)
    }
  }

  // Validate each per-currency account: IBAN & SWIFT well-formed, and same
  // country when both are present. `invalidCurrencies` blocks saving.
  const currencyIssues = useMemo(() => {
    const issues: Record<string, string> = {}
    for (const cur of Object.keys(currencyAccounts)) {
      const acct = currencyAccounts[cur]
      const ib = acct.iban?.trim()
      const sw = acct.swift?.trim()
      const ibc = ib ? validateIban(ib) : null
      const swc = sw ? validateBic(sw) : null
      if (ibc && !ibc.valid) issues[cur] = ibc.error || "Invalid IBAN"
      else if (swc && !swc.valid) issues[cur] = swc.error || "Invalid SWIFT/BIC"
      else if (ibc?.valid && swc?.valid && ibc.countryCode !== swc.countryCode)
        issues[cur] = `IBAN country (${ibc.countryCode}) and SWIFT/BIC country (${swc.countryCode}) don't match.`
    }
    return issues
  }, [currencyAccounts])
  const hasCurrencyIssues = Object.keys(currencyIssues).length > 0

  const currencyAccountsDirty = useMemo(() => {
    if (!profile) return false
    const original: Record<string, CurrencyBankAccount> = {}
    for (const a of profile.currencyAccounts ?? []) original[a.currency] = a
    return Object.keys(currencyAccounts).some((cur) => {
      const a = currencyAccounts[cur]
      const o = original[cur]
      return (
        (a.iban ?? "").trim() !== (o?.iban ?? "") ||
        (a.swift ?? "").trim() !== (o?.swift ?? "") ||
        (a.bankName ?? "").trim() !== (o?.bankName ?? "")
      )
    })
  }, [profile, currencyAccounts])

  const dirty = useMemo(() => {
    if (!profile) return false
    return (
      email.trim() !== (profile.masterEmail || "") ||
      iban.trim() !== (profile.iban || "") ||
      swift.trim() !== (profile.swift || "") ||
      bankName.trim() !== (profile.bankName || "") ||
      currency.trim() !== (profile.accountCurrency || "") ||
      currencyAccountsDirty
    )
  }, [profile, email, iban, swift, bankName, currency, currencyAccountsDirty])

  const canSave =
    !!profile && dirty && !ibanInvalid && !bicInvalid && !countryMismatch && !hasCurrencyIssues && !saving

  const handleSave = async () => {
    if (!profile || !selectedId) return
    setSaving(true)
    const res = await postAction("saveMasterBank", {
      __isSave: true,
      input: {
        userId: selectedId,
        email: email.trim(),
        iban: iban.trim(),
        swift: swift.trim(),
        bankName: bankName.trim(),
        accountCurrency: currency.trim(),
        currencyAccounts: Object.values(currencyAccounts).map((a) => ({
          currency: a.currency,
          iban: (a.iban ?? "").trim(),
          swift: (a.swift ?? "").trim(),
          bankName: (a.bankName ?? "").trim(),
        })),
        adminName: "Administrator",
      },
    })
    setSaving(false)
    if (!res.ok) {
      toast.error("Could not save bank details", { description: res.error })
      return
    }
    applyProfile(res.profile)
    // Reflect any login-email change in the cached client list.
    setUsers((prev) => prev.map((u) => (u.id === res.profile.masterId ? { ...u, email: res.profile.masterEmail } : u)))
    toast.success("Bank details updated", {
      description: `${res.profile.masterName}'s master account bank information was saved.`,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4 text-primary" /> Master Account · Bank Details
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Pick a client to load and edit his master account&apos;s bank information in place — login email, IBAN,
          SWIFT/BIC, bank name and account currency. Changes save back to the same account.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Client picker */}
        <div className="space-y-2">
          <Label htmlFor="ma-search">Client account</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="ma-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, company or email"
              className="pl-9"
            />
          </div>
          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border p-1.5">
            {loadingUsers ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No matching accounts.</p>
            ) : (
              filtered.map((u) => {
                const active = u.id === selectedId
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => selectCustomer(u)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors min-h-11",
                      active ? "border-primary bg-primary/10" : "border-transparent hover:bg-secondary/50",
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {u.fullName || u.company || u.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {u.company ? `${u.company} · ` : ""}
                        {u.email}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                      {relationshipLabel(u.relationship)}
                    </Badge>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Editor */}
        {selectedId && (
          <div className="space-y-4 rounded-lg border border-border bg-secondary/10 p-4">
            {loadingProfile ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading bank details…
              </div>
            ) : profile ? (
              <>
                {/* Which record is being edited */}
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs">
                  <User2 className="h-3.5 w-3.5 text-primary" />
                  <span className="text-muted-foreground">Editing master account:</span>
                  <span className="font-medium text-foreground">{profile.masterName}</span>
                  {profile.masterCompany && <span className="text-muted-foreground">· {profile.masterCompany}</span>}
                  {!profile.isSelf && (
                    <Badge variant="outline" className="ml-auto text-[10px] text-amber-400">
                      Resolved from {relationshipLabel(profile.relationship)} “{profile.selectedName}”
                    </Badge>
                  )}
                </div>

                {/* Login email */}
                <div className="space-y-1.5">
                  <Label htmlFor="ma-email" className="flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5" /> Login email
                  </Label>
                  <Input
                    id="ma-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@mccgva.ch"
                  />
                </div>

                {/* Bank details */}
                <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Bank account details</p>
                    <Badge variant="outline" className="ml-auto text-[10px] text-muted-foreground">
                      Validated
                    </Badge>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ma-iban">IBAN</Label>
                      <Input
                        id="ma-iban"
                        value={iban}
                        onChange={(e) => setIban(e.target.value.toUpperCase())}
                        placeholder="CH93 0076 2011 6238 5295 7"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={ibanInvalid}
                        className={cn(
                          "font-mono",
                          ibanInvalid && "border-red-500/60 focus-visible:ring-red-500/30",
                          ibanCheck?.valid && "border-emerald-500/50",
                        )}
                      />
                      {ibanCheck && (
                        <p className={cn("text-[11px]", ibanCheck.valid ? "text-emerald-400" : "text-red-400")}>
                          {ibanCheck.valid ? `Valid ${ibanCheck.countryName ?? ibanCheck.countryCode} IBAN` : ibanCheck.error}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ma-swift">SWIFT / BIC</Label>
                      <Input
                        id="ma-swift"
                        value={swift}
                        onChange={(e) => setSwift(e.target.value.toUpperCase())}
                        placeholder="MCCBCHGG"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={bicInvalid}
                        className={cn(
                          "font-mono",
                          bicInvalid && "border-red-500/60 focus-visible:ring-red-500/30",
                          bicCheck?.valid && "border-emerald-500/50",
                        )}
                      />
                      {bicCheck && (
                        <p className={cn("text-[11px]", bicCheck.valid ? "text-emerald-400" : "text-red-400")}>
                          {bicCheck.valid ? `Valid BIC · ${bicCheck.countryName ?? bicCheck.countryCode}` : bicCheck.error}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ma-bank">Bank name</Label>
                      <div className="relative">
                        <Input
                          id="ma-bank"
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          placeholder="e.g. MCC Capital Bank"
                        />
                        {bankLookingUp && (
                          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ma-ccy">Account currency</Label>
                      <Select value={currency || undefined} onValueChange={(v) => setCurrency(v)}>
                        <SelectTrigger id="ma-ccy" className="font-mono">
                          <SelectValue placeholder="Select currency" />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCY_OPTIONS.map((c) => (
                            <SelectItem key={c} value={c} className="font-mono">
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {countryMismatch && (
                    <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-[12px] font-medium text-amber-300">
                          IBAN and SWIFT/BIC are from different countries
                        </p>
                        <p className="text-[11px] text-amber-200/80">
                          This IBAN is {ibanCheck?.countryName ?? ibanCheck?.countryCode} ({ibanCheck?.countryCode}) but
                          the SWIFT/BIC is {bicCheck?.countryName ?? bicCheck?.countryCode} ({bicCheck?.countryCode}). A{" "}
                          {ibanCheck?.countryCode} IBAN can&apos;t be held at a {bicCheck?.countryCode} bank. Saving is
                          blocked until they match.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={fixFromIban}
                        disabled={bankLookingUp}
                        className="shrink-0 border-amber-500/50 text-amber-200 hover:bg-amber-500/15"
                      >
                        {bankLookingUp ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                        Use the IBAN&apos;s bank
                      </Button>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Fields are pre-filled with the account&apos;s current details. Enter an IBAN to auto-fill any empty
                    SWIFT/BIC, bank name and currency; anything you type yourself is kept. Clearing a field removes it.
                    This is the primary <span className="font-medium text-foreground">EUR</span> master account.
                  </p>
                </div>

                {/* Additional per-currency settlement accounts (USD / GBP / CHF …) */}
                <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
                  <div className="flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium text-foreground">Currency settlement accounts</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Insert the bank account coordinates for each additional currency. Enter an IBAN — it is validated and
                    the SWIFT/BIC and bank name are auto-filled from it. Each one reflects into the client&apos;s
                    dedicated {MANAGED_BANK_CURRENCIES.join(" / ")} account in their accounts overview. Leave a currency
                    blank to omit it.
                  </p>
                  {MANAGED_BANK_CURRENCIES.map((cur) => {
                    const acct = currencyAccounts[cur] ?? { currency: cur }
                    const issue = currencyIssues[cur]
                    const ibanCk = acct.iban?.trim() ? validateIban(acct.iban) : null
                    const looking = !!currencyLookup[cur]
                    return (
                      <div key={cur} className="space-y-2 rounded-md border border-border/70 bg-background/40 p-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono text-[11px]">
                            {cur}
                          </Badge>
                          <span className="text-xs text-muted-foreground">settlement account</span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`ma-${cur}-iban`}>IBAN</Label>
                            <div className="relative">
                              <Input
                                id={`ma-${cur}-iban`}
                                value={acct.iban ?? ""}
                                onChange={(e) => handleCurrencyIban(cur, e.target.value)}
                                placeholder={`${cur} account IBAN`}
                                autoComplete="off"
                                spellCheck={false}
                                className={cn(
                                  "font-mono pr-9",
                                  issue && "border-red-500/60 focus-visible:ring-red-500/30",
                                )}
                              />
                              {looking && (
                                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                              )}
                            </div>
                            {ibanCk?.valid && !issue && (
                              <p className="text-[11px] text-emerald-400">
                                Valid IBAN · {ibanCk.countryName ?? ibanCk.countryCode}
                                {looking ? " · resolving bank…" : " · bank details auto-filled below"}
                              </p>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`ma-${cur}-swift`}>SWIFT / BIC</Label>
                            <Input
                              id={`ma-${cur}-swift`}
                              value={acct.swift ?? ""}
                              onChange={(e) => updateCurrencyField(cur, "swift", e.target.value.toUpperCase())}
                              placeholder={`${cur} bank SWIFT/BIC`}
                              autoComplete="off"
                              spellCheck={false}
                              className={cn("font-mono", issue && "border-red-500/60 focus-visible:ring-red-500/30")}
                            />
                          </div>
                          <div className="space-y-1.5 sm:col-span-2">
                            <Label htmlFor={`ma-${cur}-bank`}>Bank name</Label>
                            <Input
                              id={`ma-${cur}-bank`}
                              value={acct.bankName ?? ""}
                              onChange={(e) => updateCurrencyField(cur, "bankName", e.target.value)}
                              placeholder={`e.g. ${cur} settlement bank`}
                            />
                          </div>
                        </div>
                        {issue && <p className="text-[11px] text-red-400">{issue}</p>}
                      </div>
                    )
                  })}
                </div>

                <Button onClick={handleSave} disabled={!canSave} className="w-full sm:w-auto">
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {saving ? "Saving…" : "Save bank details"}
                </Button>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Could not load this account&apos;s details.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
