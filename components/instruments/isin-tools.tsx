"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Globe,
  Copy,
  Building2,
  Landmark,
  Wallet,
  Plus,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { isValidIsin } from "@/lib/instrument-identifiers"
import {
  MARKET_INSTRUMENT_TYPES,
  ACQUISITION_ACTION_LABELS,
  ACQUISITION_ACTION_DESCRIPTIONS,
  ACQUISITION_FEE_RATES,
  computeAcquisitionFee,
  tenorLabel,
  type AcquisitionAction,
} from "@/lib/instrument-marketplace"
import type { ActivityLog } from "@/lib/activity-email"

/** Subset of the OpenFIGI record surfaced by /api/openfigi. */
interface FigiMatch {
  figi: string
  name?: string
  ticker?: string
  exchCode?: string
  securityType?: string
  securityType2?: string
  marketSector?: string
  securityDescription?: string
}

/** 2 letters + 9 alphanumerics + 1 check digit. */
const ISIN_RE = /^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/

/** Settlement currencies offered when acquiring an instrument by ISIN. */
const ACQUIRE_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD", "HKD", "JPY"]

/** Validity terms offered when acquiring an instrument by ISIN. */
const ACQUIRE_TENORS = [12, 13, 24, 36]

const ACQUIRE_ACTIONS: AcquisitionAction[] = ["lease", "assign", "purchase"]

/**
 * Details the parent needs to file an acquisition/portfolio request after a
 * client verifies an ISIN and chooses to trade it. The ISIN carries the country
 * prefix, but the instrument's economics (type, issuer, face value, currency)
 * are supplied by the client since a private bilateral ISIN is not distributed
 * with those terms — the request still routes through Administrator approval.
 */
export interface IsinAcquisitionRequest {
  isin: string
  /** Short type code (SBLC / BG / MTN / DLC). */
  type: string
  typeFull: string
  issuer: string
  faceValue: number
  currency: string
  tenorMonths: number
  action: AcquisitionAction
  /** Indicative fee computed for the chosen action. */
  fee: number
  /** Whether the ISIN resolved to an exchange-listed security on Bloomberg. */
  listed: boolean
  /** Bloomberg FIGI when exchange-listed. */
  figi?: string
}

type LogFn = (entry: ActivityLog) => void

interface IsinToolsProps {
  /** Pre-fill the input (e.g. the ISIN an admin is about to issue). */
  defaultIsin?: string
  /** Heading shown at the top of the card. */
  title?: string
  /** Supporting copy under the heading. */
  description?: string
  /** Optional audit-trail logger. */
  onLog?: LogFn
  /** Where the log entry is filed. */
  logCategory?: string
  /**
   * When set, a verified (format-valid) ISIN reveals an "Add to your portfolio"
   * panel so the client can trade the instrument. The handler files the
   * acquisition request (e.g. via the approvals backbone) and may resolve to
   * `{ ok: false }` to keep the form open on failure.
   */
  onAcquire?: (req: IsinAcquisitionRequest) => Promise<{ ok?: boolean } | void> | void
  className?: string
}

interface IsinResolution {
  isin: string
  formatValid: boolean
  listed?: boolean
  matches: FigiMatch[]
  note?: string
}

/**
 * Reusable ISIN toolkit used both in the client Bank Instruments workflow and
 * the Admin issuance panel. Provides three capabilities behind one smart input:
 *   1. Instant, offline ISIN validation (format + ISO 6166 Luhn check digit).
 *   2. Market resolution via OpenFIGI (issuer, FIGI, ticker, exchange, type).
 *   3. Free-text securities search (issuer / ticker / name → FIGI records).
 *
 * The OpenFIGI API key stays server-side (all calls go through /api/openfigi),
 * so nothing sensitive reaches the browser and per-user data isolation is
 * unaffected — this only reads public reference data.
 */
export function IsinTools({
  defaultIsin = "",
  title = "ISIN Tools",
  description = "Validate an ISIN, resolve it to live market reference data, or search issuers and tickers.",
  onLog,
  logCategory = "Bank Instruments",
  onAcquire,
  className,
}: IsinToolsProps) {
  const [value, setValue] = useState(defaultIsin)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isinResult, setIsinResult] = useState<IsinResolution | null>(null)
  const [searchResult, setSearchResult] = useState<{ query: string; matches: FigiMatch[] } | null>(null)

  // --- Acquisition (add-to-portfolio) form, only shown when `onAcquire` is set.
  const [acqType, setAcqType] = useState<string>(MARKET_INSTRUMENT_TYPES[0].code)
  const [acqIssuer, setAcqIssuer] = useState<string>("")
  const [acqFace, setAcqFace] = useState<string>("")
  const [acqCurrency, setAcqCurrency] = useState<string>("USD")
  const [acqTenor, setAcqTenor] = useState<number>(12)
  const [acqAction, setAcqAction] = useState<AcquisitionAction>("lease")
  const [acquiring, setAcquiring] = useState(false)

  // Keep the input in sync when the parent supplies a new subject ISIN (e.g. the
  // admin changes the issuing bank / type and a fresh ISIN is generated).
  useEffect(() => {
    setValue(defaultIsin)
    setIsinResult(null)
    setSearchResult(null)
    setError(null)
  }, [defaultIsin])

  // Prefill the acquisition issuer from the resolved market name when an ISIN
  // verifies as exchange-listed, so the client doesn't retype a known issuer.
  useEffect(() => {
    if (isinResult?.listed && isinResult.matches[0]?.name) {
      setAcqIssuer((prev) => prev || isinResult.matches[0].name || "")
    }
  }, [isinResult])

  const trimmed = value.trim().toUpperCase()
  const looksIsin = ISIN_RE.test(trimmed)

  // Instant, offline validity for anything shaped like an ISIN.
  const localValid = useMemo(() => (looksIsin ? isValidIsin(trimmed) : null), [looksIsin, trimmed])

  const run = useCallback(async () => {
    const q = value.trim()
    if (!q) return
    const isIsin = ISIN_RE.test(q)
    setLoading(true)
    setError(null)
    setIsinResult(null)
    setSearchResult(null)
    try {
      const res = await fetch("/api/openfigi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isIsin ? { isin: q } : { query: q }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error ?? "Lookup failed.")
        return
      }
      if (isIsin) {
        const upper = q.toUpperCase()
        const formatValid = isValidIsin(upper)
        const matches = (data.matches ?? []) as FigiMatch[]
        const resolution: IsinResolution = {
          isin: upper,
          formatValid,
          listed: Boolean(data.listed && matches.length),
          matches,
          note:
            data.listed && matches.length
              ? undefined
              : "Valid ISIN — private bilateral instrument (not exchange-listed on Bloomberg). SBLC / BG / most private MTNs are delivered bank-to-bank via SWIFT MT760 and carry an ISIN without an exchange listing.",
        }
        setIsinResult(resolution)
        onLog?.({
          action: `Verified ISIN ${upper}`,
          category: logCategory,
          details: {
            summary: `ISIN ${upper} checked — format ${formatValid ? "valid" : "invalid"}, market status: ${
              resolution.listed
                ? `exchange-listed (${matches[0]?.figi ?? "Bloomberg ID"})`
                : "valid, not exchange-listed"
            }.`,
            isin: upper,
            formatValid,
            exchangeListed: resolution.listed,
            figi: matches[0]?.figi,
          },
        })
      } else {
        const matches = (data.matches ?? []) as FigiMatch[]
        setSearchResult({ query: q, matches })
        onLog?.({
          action: `Searched securities reference for "${q}"`,
          category: logCategory,
          details: {
            summary: `Bloomberg securities search for "${q}" returned ${matches.length} match(es).`,
            query: q,
            resultCount: matches.length,
          },
        })
      }
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [value, onLog, logCategory])

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text)
    toast.success(`${label} copied`, { description: text })
  }

  // Indicative fee for the current acquisition selection.
  const acqFaceValue = Number.parseFloat(acqFace.replace(/,/g, ""))
  const acqFaceValid = Number.isFinite(acqFaceValue) && acqFaceValue > 0
  const acqFee = acqFaceValid ? computeAcquisitionFee(acqAction, acqFaceValue) : 0
  const canAcquire = Boolean(isinResult?.formatValid) && acqIssuer.trim().length > 1 && acqFaceValid

  const submitAcquire = async () => {
    if (!isinResult || !onAcquire || !canAcquire) return
    const typeMeta = MARKET_INSTRUMENT_TYPES.find((t) => t.code === acqType) ?? MARKET_INSTRUMENT_TYPES[0]
    setAcquiring(true)
    try {
      const res = await onAcquire({
        isin: isinResult.isin,
        type: typeMeta.code,
        typeFull: typeMeta.full,
        issuer: acqIssuer.trim(),
        faceValue: acqFaceValue,
        currency: acqCurrency,
        tenorMonths: acqTenor,
        action: acqAction,
        fee: acqFee,
        listed: Boolean(isinResult.listed),
        figi: isinResult.matches[0]?.figi,
      })
      // Reset the form on success (handler returns void or { ok: true }).
      if (!res || res.ok !== false) {
        setAcqIssuer("")
        setAcqFace("")
      }
    } finally {
      setAcquiring(false)
    }
  }

  return (
    <Card className={cn("border-border bg-card", className)}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground text-pretty">{description}</p>
          </div>
        </div>

        {/* Smart input — auto-detects ISIN vs free-text query */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) run()
              }}
              placeholder="ISIN (e.g. US0378331005) or issuer / ticker"
              className="pl-9 font-mono"
              aria-label="ISIN or securities search"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </div>
          <Button onClick={run} disabled={loading || !value.trim()} className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {looksIsin ? "Verify" : "Search"}
          </Button>
        </div>

        {/* Instant offline check-digit badge */}
        {looksIsin ? (
          <div className="flex items-center gap-2 text-xs">
            {localValid ? (
              <Badge className="gap-1 border-green-500/20 bg-green-500/10 text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                Valid ISIN format &amp; check digit
              </Badge>
            ) : (
              <Badge className="gap-1 border-red-500/20 bg-red-500/10 text-red-400">
                <XCircle className="h-3 w-3" />
                Invalid check digit — not a genuine ISIN
              </Badge>
            )}
            <span className="text-muted-foreground">Offline ISO 6166 validation</span>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {/* ISIN market resolution */}
        {isinResult ? (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">{isinResult.isin}</span>
              <button
                type="button"
                onClick={() => copy(isinResult.isin, "ISIN")}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Copy ISIN"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              {isinResult.formatValid ? (
                <Badge className="gap-1 border-green-500/20 bg-green-500/10 text-green-400">
                  <ShieldCheck className="h-3 w-3" />
                  Format valid
                </Badge>
              ) : (
                <Badge className="gap-1 border-red-500/20 bg-red-500/10 text-red-400">
                  <XCircle className="h-3 w-3" />
                  Invalid format
                </Badge>
              )}
              {isinResult.listed ? (
                <Badge className="gap-1 border-primary/30 bg-primary/10 text-primary">
                  <CheckCircle2 className="h-3 w-3" />
                  Exchange-listed
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <Building2 className="h-3 w-3" />
                  Private / bilateral
                </Badge>
              )}
            </div>

            {isinResult.listed && isinResult.matches.length ? (
              <div className="space-y-2">
                {isinResult.matches.map((m, idx) => (
                  <div
                    key={`${m.figi}-${idx}`}
                    className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border bg-background p-3 text-xs"
                  >
                    <Detail label="Instrument" value={m.name ?? m.securityDescription} span />
                    <Detail label="Bloomberg ID" value={m.figi} mono />
                    <Detail label="Ticker" value={m.ticker} mono />
                    <Detail label="Exchange" value={m.exchCode} />
                    <Detail label="Type" value={m.securityType2 ?? m.securityType} />
                    <Detail label="Market sector" value={m.marketSector} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-pretty">{isinResult.note}</p>
            )}
          </div>
        ) : null}

        {/* Trade & add to portfolio — only when acquisition is enabled and the
            ISIN's format/check digit is valid. */}
        {onAcquire && isinResult?.formatValid ? (
          <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Wallet className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground">Trade &amp; add to your portfolio</h4>
                <p className="text-xs text-muted-foreground text-pretty">
                  Confirm the instrument&apos;s terms for{" "}
                  <span className="font-mono text-foreground">{isinResult.isin}</span> and submit it to your portfolio.
                  Acquisitions route through Administrator approval — nothing executes automatically.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {/* Instrument type */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Instrument type</Label>
                <Select value={acqType} onValueChange={setAcqType}>
                  <SelectTrigger aria-label="Instrument type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKET_INSTRUMENT_TYPES.map((t) => (
                      <SelectItem key={t.code} value={t.code}>
                        {t.code} — {t.full}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Issuing bank */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Issuing bank</Label>
                <div className="relative">
                  <Landmark className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={acqIssuer}
                    onChange={(e) => setAcqIssuer(e.target.value)}
                    placeholder="e.g. HSBC Bank PLC"
                    className="pl-9"
                    aria-label="Issuing bank"
                  />
                </div>
              </div>

              {/* Face value */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Face value</Label>
                <Input
                  value={acqFace}
                  onChange={(e) => setAcqFace(e.target.value.replace(/[^\d,.]/g, ""))}
                  inputMode="decimal"
                  placeholder="e.g. 50,000,000"
                  className="font-mono"
                  aria-label="Face value"
                />
              </div>

              {/* Currency */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Currency</Label>
                <Select value={acqCurrency} onValueChange={setAcqCurrency}>
                  <SelectTrigger aria-label="Currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACQUIRE_CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Validity / tenor */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Validity</Label>
                <Select value={String(acqTenor)} onValueChange={(v) => setAcqTenor(Number(v))}>
                  <SelectTrigger aria-label="Validity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACQUIRE_TENORS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {tenorLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Acquisition action */}
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Acquisition</Label>
                <Select value={acqAction} onValueChange={(v) => setAcqAction(v as AcquisitionAction)}>
                  <SelectTrigger aria-label="Acquisition action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACQUIRE_ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {ACQUISITION_ACTION_LABELS[a]} — {(ACQUISITION_FEE_RATES[a] * 100).toFixed(a === "assign" ? 1 : 0)}%
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground text-pretty">
              {ACQUISITION_ACTION_DESCRIPTIONS[acqAction]}
            </p>

            <div className="flex flex-col gap-3 border-t border-primary/20 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs">
                <span className="text-muted-foreground">Indicative {ACQUISITION_ACTION_LABELS[acqAction].toLowerCase()} fee</span>
                <p className="font-mono text-base font-semibold text-foreground">
                  {acqFaceValid
                    ? new Intl.NumberFormat("en-US", { style: "currency", currency: acqCurrency, maximumFractionDigits: 0 }).format(acqFee)
                    : "—"}
                </p>
              </div>
              <Button onClick={submitAcquire} disabled={!canAcquire || acquiring} className="gap-1.5">
                {acquiring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add to portfolio
              </Button>
            </div>
          </div>
        ) : null}

        {/* Free-text search results */}
        {searchResult ? (
          searchResult.matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">No securities matched &ldquo;{searchResult.query}&rdquo;.</p>
          ) : (
            <div className="max-h-72 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Ticker</th>
                    <th className="px-3 py-2 font-medium">Bloomberg ID</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResult.matches.map((m, idx) => (
                    <tr key={`${m.figi}-${idx}`} className="border-t border-border">
                      <td className="px-3 py-2 text-foreground">{m.name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{m.ticker ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{m.figi}</td>
                      <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                        {m.securityType2 ?? m.securityType ?? m.marketSector ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  )
}

function Detail({
  label,
  value,
  mono,
  span,
}: {
  label: string
  value?: string
  mono?: boolean
  span?: boolean
}) {
  return (
    <div className={cn(span && "col-span-2")}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-foreground", mono && "font-mono")}>{value || "—"}</p>
    </div>
  )
}
