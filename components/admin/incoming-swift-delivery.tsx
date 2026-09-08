"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowDownToLine,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Send,
  UserPlus,
  Inbox,
  Banknote,
  ShieldCheck,
  Lock,
  Upload,
  FileText,
  XCircle,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { applyCashback, formatCashbackPct } from "@/lib/fee-cashback"
import { instrumentTypesByCategory } from "@/lib/instrument-marketplace"
import { parseSwiftMessage } from "@/lib/swift-mt"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { blobFileUrl } from "@/lib/kyc-types"
import { downloadFile } from "@/lib/download-file"
import {
  ingestIncomingSwiftAdmin,
  listUnmatchedIncomingSwiftAdmin,
  assignIncomingSwiftAdmin,
  listCreditableIncomingSwiftAdmin,
  creditIncomingSwiftAdmin,
  recordGuaranteeInstrumentAdmin,
  rejectIncomingSwiftAdmin,
  type IngestResult,
} from "@/app/actions/incoming-swift"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import type { IncomingSwiftMessage } from "@/lib/incoming-swift-db"
import { toast } from "sonner"

const SAMPLE = `{1:F01DEUTDEFFAXXX0000000000}
{2:I103CHASUS33XXXXN}
{3:{121:eb6305c9-1f7f-49de-aed0-16487c27b42d}}
{4:
:20:REF-INC-55021
:23B:CRED
:32A:240617EUR15000,00
:50K:/DE89370400440532013000
ACME COMMODITIES GMBH
FRANKFURT
:57A:CHASUS33
:59:/CH9300762011623852957
ANDRE KOLLER
GENEVA
:70:INVOICE 8842
:71A:SHA
-}
{5:{CHK:123456789ABC}}`

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

// MT760 blocked-funds guarantee receipt fee (display preview only — the server
// re-parses the face value and is authoritative on the charge).
const RECEIPT_FEE_RATE = 0.002

// Parse the currency + numeric value out of a formatted amount like
// "EUR 4,500,000,000" for the admin fee preview.
function parseAmount(amountStr?: string | null): { currency: string; value: number } {
  if (!amountStr) return { currency: "", value: 0 }
  const currency = amountStr.match(/[A-Z]{3}/)?.[0] ?? ""
  const value = Number(amountStr.replace(/[^0-9.,]/g, "").replace(/,/g, "")) || 0
  return { currency, value: Number.isFinite(value) ? value : 0 }
}

function fmtMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Derive the default instrument type from the printout. An MT760 is NOT always
// a BG — it carries the form in :22D: (STBY = Standby LC = SBLC, DGAR = Demand
// Guarantee = BG), so an SBLC must default to SBLC, never silently to BG. The
// admin can still override the type in the picker.
function defaultTypeFor(m: IncomingSwiftMessage): string {
  if (m.messageType !== "MT760") return ""
  try {
    const form = parseSwiftMessage(m.raw).guarantee?.form?.toUpperCase()
    if (form === "STBY") return "SBLC"
    if (form === "DGAR") return "BG"
  } catch {
    // fall through to the guarantee default
  }
  return "BG"
}

export function IncomingSwiftDelivery() {
  const [raw, setRaw] = useState("")
  const [ingesting, setIngesting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<IngestResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleUpload = async (file: File | undefined) => {
    if (!file) return
    const name = file.name.toLowerCase()
    const isDocument =
      file.type === "application/pdf" ||
      file.type.startsWith("image/") ||
      /\.(pdf|png|jpe?g|webp|heic)$/.test(name)

    try {
      if (isDocument) {
        // PDF or image bank receipt / SWIFT printout → OCR, understand & analyze
        // into recoverable FIN text via the shared extraction endpoint.
        setScanning(true)
        const form = new FormData()
        form.append("file", file)
        const res = await fetch("/api/swift/extract", { method: "POST", body: form })
        const json = (await res.json().catch(() => null)) as
          | { ok: true; data: { finMessage?: string; messageType?: string; currency?: string; amount?: string } }
          | { ok: false; error?: string }
          | null
        if (!res.ok || !json?.ok || !json.data?.finMessage?.trim()) {
          toast.error(
            (json && "error" in json && json.error) ||
              "Could not read that receipt automatically. Paste the SWIFT FIN text manually.",
          )
          return
        }
        setRaw(json.data.finMessage.trim())
        setResult(null)
        const d = json.data
        const detail = [d.messageType, d.amount && d.currency ? `${d.currency} ${d.amount}` : ""]
          .filter(Boolean)
          .join(" · ")
        toast.success(`Scanned ${file.name}${detail ? ` — ${detail}` : ""}. Review then receive & match.`)
      } else {
        // Plain-text FIN printout (.txt/.fin/.swift/.dat) → read directly.
        const text = await file.text()
        setRaw(text)
        setResult(null)
        toast.success(`Loaded ${file.name}. Review then receive & match.`)
      }
    } catch {
      toast.error("Could not read that file. Upload a PDF, an image, or a plain-text SWIFT printout.")
    } finally {
      setScanning(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const [unmatched, setUnmatched] = useState<IncomingSwiftMessage[]>([])
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [assignSel, setAssignSel] = useState<Record<string, string>>({})
  const [assigning, setAssigning] = useState<string | null>(null)

  const [creditable, setCreditable] = useState<IncomingSwiftMessage[]>([])
  const [loadingCreditable, setLoadingCreditable] = useState(false)
  const [crediting, setCrediting] = useState<string | null>(null)
  const [booking, setBooking] = useState<string | null>(null)
  const [bookOpen, setBookOpen] = useState<string | null>(null)
  const [bookCashback, setBookCashback] = useState<Record<string, string>>({})
  // Per-message booking overrides: the type the admin recognised + editable
  // face value / currency (prefilled from the parse when the panel is opened).
  const [bookType, setBookType] = useState<Record<string, string>>({})
  const [bookFace, setBookFace] = useState<Record<string, string>>({})
  const [bookCurrency, setBookCurrency] = useState<Record<string, string>>({})
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({})
  const [reassignOpen, setReassignOpen] = useState<string | null>(null)

  const loadQueue = async () => {
    setLoadingQueue(true)
    const res = await listUnmatchedIncomingSwiftAdmin(ADMIN_PASSCODE)
    setLoadingQueue(false)
    if (res.ok) setUnmatched(res.messages)
  }

  const loadCreditable = async () => {
    setLoadingCreditable(true)
    const res = await listCreditableIncomingSwiftAdmin(ADMIN_PASSCODE)
    setLoadingCreditable(false)
    if (res.ok) setCreditable(res.messages)
  }

  useEffect(() => {
    void loadQueue()
    void loadCreditable()
    void listSelectableClients(ADMIN_PASSCODE).then(setClients)
  }, [])

  const handleCredit = async (m: IncomingSwiftMessage) => {
    setCrediting(m.id)
    try {
      const res = await creditIncomingSwiftAdmin(ADMIN_PASSCODE, m.id)
      if (res.ok) {
        toast.success(`Credited ${res.creditedLabel}${res.creditedTo ? ` to ${res.creditedTo}` : ""}.`)
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
      } else if (res.alreadyCredited) {
        toast.warning("This message was already credited.")
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
      } else {
        toast.error(res.error ?? "Could not execute the credit.")
      }
    } catch {
      toast.error("Could not reach the credit engine.")
    } finally {
      setCrediting(null)
    }
  }

  // Open the booking panel, prefilling the amount/currency parsed from the
  // message and defaulting the type from the printout's :22D: form (SBLC vs BG
  // for an MT760); the admin can still override it in the picker.
  const openBookPanel = (m: IncomingSwiftMessage) => {
    const { currency, value } = parseAmount(m.amount)
    setBookFace((p) => ({ ...p, [m.id]: p[m.id] ?? (value > 0 ? String(value) : "") }))
    setBookCurrency((p) => ({ ...p, [m.id]: p[m.id] ?? currency }))
    setBookType((p) => ({ ...p, [m.id]: p[m.id] ?? defaultTypeFor(m) }))
    setBookOpen(bookOpen === m.id ? null : m.id)
  }

  const handleBookGuarantee = async (m: IncomingSwiftMessage, cashbackRate?: number) => {
    setBooking(m.id)
    try {
      const faceRaw = Number((bookFace[m.id] ?? "").replace(/,/g, ""))
      const overrides = {
        instrumentTypeCode: bookType[m.id] || undefined,
        faceValue: Number.isFinite(faceRaw) && faceRaw > 0 ? faceRaw : undefined,
        currency: (bookCurrency[m.id] || "").trim().toUpperCase() || undefined,
      }
      const res = await recordGuaranteeInstrumentAdmin(ADMIN_PASSCODE, m.id, cashbackRate, overrides)
      if (res.ok) {
        toast.success(
          `Booked ${res.instrumentLabel} bank instrument${res.bookedTo ? ` for ${res.bookedTo}` : ""}. Receipt fee ${res.feeLabel} charged.`,
        )
        setBookOpen(null)
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
      } else if (res.alreadyBooked) {
        toast.warning("This message was already processed.")
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
      } else {
        toast.error(res.error ?? "Could not book the guarantee.")
      }
    } catch {
      toast.error("Could not reach the guarantee engine.")
    } finally {
      setBooking(null)
    }
  }

  const handleReject = async (m: IncomingSwiftMessage) => {
    setRejecting(m.id)
    try {
      const res = await rejectIncomingSwiftAdmin(ADMIN_PASSCODE, m.id, rejectReason[m.id] ?? "")
      if (res.ok) {
        toast.success("Message rejected. It has been removed from the queue.")
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
        setRejectOpen(null)
      } else if (res.alreadyResolved) {
        toast.warning(res.error ?? "This message was already resolved.")
        setCreditable((prev) => prev.filter((x) => x.id !== m.id))
        setRejectOpen(null)
      } else {
        toast.error(res.error ?? "Could not reject the message.")
      }
    } catch {
      toast.error("Could not reach the delivery engine.")
    } finally {
      setRejecting(null)
    }
  }

  const handleIngest = async () => {
    if (!raw.trim()) return
    setIngesting(true)
    setResult(null)
    try {
      const res = await ingestIncomingSwiftAdmin(ADMIN_PASSCODE, raw)
      setResult(res)
      if (!res.ok) {
        toast.error(res.error ?? "Could not ingest the message.")
      } else if (res.status === "matched") {
        toast.success(`Delivered to ${res.matchedTo}. Review it below to execute the credit.`)
        setRaw("")
        void loadCreditable()
      } else {
        toast.warning("No matching account — added to the review queue.")
        setRaw("")
        void loadQueue()
      }
    } catch {
      toast.error("Could not reach the delivery engine.")
    } finally {
      setIngesting(false)
    }
  }

  const handleAssign = async (id: string) => {
    const userId = assignSel[id]
    if (!userId) {
      toast.error("Select a customer to assign this message to.")
      return
    }
    setAssigning(id)
    const res = await assignIncomingSwiftAdmin(ADMIN_PASSCODE, id, userId)
    setAssigning(null)
    if (res.ok) {
      toast.success("Message assigned and delivered. Execute the credit below.")
      setUnmatched((prev) => prev.filter((m) => m.id !== id))
      void loadCreditable()
    } else {
      toast.error(res.error ?? "Could not assign the message.")
    }
  }

  // Switch a matched (awaiting-credit) message to a DIFFERENT customer before the
  // credit is executed. Reuses the same admin assign action; the message stays
  // in the Awaiting-credit queue under the newly selected owner.
  const handleReassignCredit = async (id: string) => {
    const userId = assignSel[id]
    if (!userId) {
      toast.error("Select the customer to switch this payment to.")
      return
    }
    setAssigning(id)
    const res = await assignIncomingSwiftAdmin(ADMIN_PASSCODE, id, userId)
    setAssigning(null)
    if (res.ok) {
      toast.success("Payment switched to the selected customer. Review and execute the credit below.")
      setReassignOpen(null)
      setAssignSel((prev) => ({ ...prev, [id]: "" }))
      void loadCreditable()
    } else {
      toast.error(res.error ?? "Could not switch the payment.")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Ingest + auto-match */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Analyze, verify &amp; credit an incoming SWIFT message</CardTitle>
          <CardDescription>
            Paste the FIN text, or upload an inbound SWIFT printout / PDF bank receipt (PDF or image) received from a
            customer — it is scanned, understood and analyzed into the SWIFT FIN message. It is then cross-checked
            against every active bank account by beneficiary IBAN (:59:) and receiving bank BIC (:57a:). On a confident
            match it is delivered to that customer&apos;s SWIFT Messages inbox and they are notified; otherwise it goes
            to the review queue. Matched messages then appear under <strong>Awaiting credit</strong>, where you verify
            the details and execute the credit to the customer&apos;s Master Account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="{1:F01...}{2:I103...}{4:&#10;:20:...&#10;:59:/IBAN&#10;-}"
            className="min-h-[240px] font-mono text-xs leading-relaxed"
            aria-label="Incoming SWIFT message"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleIngest} disabled={ingesting || !raw.trim()} className="gap-2">
              {ingesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
              Receive &amp; match
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.fin,.swift,.dat,text/plain,application/pdf,.pdf,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
              className="hidden"
              onChange={(e) => handleUpload(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={scanning}
              className="gap-2 bg-transparent"
            >
              {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
              {scanning ? "Scanning…" : "Upload printout (PDF / image)"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRaw(SAMPLE)} className="bg-transparent">
              Load sample
            </Button>
            {raw && (
              <Button variant="outline" size="sm" onClick={() => setRaw("")} className="bg-transparent">
                Clear
              </Button>
            )}
          </div>

          {result?.ok && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-sm ${
                result.status === "matched"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              }`}
            >
              {result.status === "matched" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>
                {result.status === "matched" ? (
                  <>
                    Delivered to <strong>{result.matchedTo}</strong>. {result.reason}
                  </>
                ) : (
                  <>Not matched. {result.reason} Review it in the queue below.</>
                )}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Matched — awaiting credit execution */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Banknote className="h-4 w-4" /> Awaiting credit
                {creditable.length > 0 && <Badge variant="secondary">{creditable.length}</Badge>}
              </CardTitle>
              <CardDescription>
                Verified messages matched to a platform bank account. Nothing is credited automatically — the
                administrator must review each one and approve the credit, switch the payment to a different customer,
                or reject it. Crediting is idempotent — a message can only be credited once.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={loadCreditable}
              disabled={loadingCreditable}
              className="gap-2 bg-transparent"
            >
              {loadingCreditable ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {creditable.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loadingCreditable ? "Loading…" : "No matched messages awaiting a credit."}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {creditable.map((m) => (
                <div key={m.id} className="rounded-lg border border-border p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge className="bg-primary/15 text-primary">{m.messageType}</Badge>
                    {m.amount && <span className="text-sm font-semibold text-foreground">{m.amount}</span>}
                    {m.customerSubmitted && (
                      <Badge variant="outline" className="gap-1 border-blue-500/30 text-blue-600 dark:text-blue-400">
                        <Upload className="h-3.5 w-3.5" /> Customer-uploaded
                      </Badge>
                    )}
                    {m.bicConfirmed ? (
                      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="h-3.5 w-3.5" /> IBAN + BIC verified
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5" /> IBAN only
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDate(m.createdAt)}</span>
                  </div>
                  <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Detail label="Credit to" value={m.matchedAccountHolder || "—"} />
                    <Detail label="Beneficiary IBAN" value={m.beneficiaryIban || "—"} mono />
                    <Detail label="Ordering customer" value={m.orderingCustomer || "—"} />
                    <Detail label="Receiving bank (:57a:)" value={m.receiverBic || "—"} mono />
                    {m.reference && <Detail label="Reference" value={m.reference} />}
                    {m.uetr && <Detail label="UETR" value={m.uetr} mono />}
                  </div>
                  {m.sourceDocPathname && (
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 bg-transparent"
                        onClick={() =>
                          void downloadFile(
                            blobFileUrl(m.sourceDocPathname as string, ADMIN_PASSCODE),
                            m.sourceDocName || `swift-${m.id}`,
                          )
                        }
                      >
                        <FileText className="h-4 w-4" /> View uploaded printout
                      </Button>
                    </div>
                  )}
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {m.messageType === "MT760"
                      ? "An MT760 is a bank guarantee (blocked funds), not a cash transfer. Book it as a pledgeable bank instrument, or recognise it as a specific type below."
                      : "Recognise this printout as a bank instrument (BG / SBLC / DLC / MTN / Bond) and book it into the customer's Bank Instruments — or, if it is a cash transfer, credit the Master Account."}{" "}
                    A 0.2% receipt fee applies to the Master Account. The instrument can then be pledged for a treasury
                    leverage / PPP line.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => openBookPanel(m)} disabled={booking === m.id} className="gap-1.5">
                      <Lock className="h-4 w-4" />
                      Book as bank instrument
                    </Button>
                    {m.messageType !== "MT760" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCredit(m)}
                        disabled={crediting === m.id}
                        className="gap-1.5 bg-transparent"
                      >
                        {crediting === m.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Banknote className="h-4 w-4" />
                        )}
                        Credit as cash to Master Account
                      </Button>
                    )}
                    <SwitchCustomerButton id={m.id} open={reassignOpen === m.id} onToggle={setReassignOpen} />
                    <RejectButton id={m.id} open={rejectOpen === m.id} onToggle={setRejectOpen} />
                  </div>
                  {bookOpen === m.id &&
                    (() => {
                      const currency = (bookCurrency[m.id] || "").toUpperCase()
                      const value = Number((bookFace[m.id] ?? "").replace(/,/g, "")) || 0
                      const pct = Number(bookCashback[m.id] ?? "")
                      const rateFraction = Number.isFinite(pct) && pct > 0 ? Math.min(1, pct / 100) : 0
                      const cb = applyCashback(value * RECEIPT_FEE_RATE, rateFraction)
                      const canBook = value > 0 && currency.length === 3 && Boolean(bookType[m.id])
                      return (
                        <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                          <p className="text-xs font-medium text-foreground">Recognise &amp; book this instrument</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Pick the instrument type and confirm the face value + currency (prefilled from the
                            printout). Nothing is debited until you confirm.
                          </p>

                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <div className="flex flex-col gap-1 sm:col-span-1">
                              <label className="text-xs text-muted-foreground">Instrument type</label>
                              <Select
                                value={bookType[m.id] ?? ""}
                                onValueChange={(v) => setBookType((p) => ({ ...p, [m.id]: v }))}
                              >
                                <SelectTrigger className="h-10 text-base">
                                  <SelectValue placeholder="Choose type…" />
                                </SelectTrigger>
                                <SelectContent>
                                  {instrumentTypesByCategory().map((group) => (
                                    <SelectGroup key={group.category}>
                                      <SelectLabel>{group.category}</SelectLabel>
                                      {group.types.map((t) => (
                                        <SelectItem key={t.code} value={t.code}>
                                          {t.full} ({t.code})
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex flex-col gap-1 sm:col-span-1">
                              <label htmlFor={`face-${m.id}`} className="text-xs text-muted-foreground">
                                Face value
                              </label>
                              <Input
                                id={`face-${m.id}`}
                                inputMode="decimal"
                                value={bookFace[m.id] ?? ""}
                                onChange={(e) =>
                                  setBookFace((p) => ({ ...p, [m.id]: e.target.value.replace(/[^0-9.,]/g, "") }))
                                }
                                placeholder="0"
                                className="h-10 text-base"
                              />
                            </div>
                            <div className="flex flex-col gap-1 sm:col-span-1">
                              <label htmlFor={`ccy-${m.id}`} className="text-xs text-muted-foreground">
                                Currency
                              </label>
                              <Input
                                id={`ccy-${m.id}`}
                                value={bookCurrency[m.id] ?? ""}
                                onChange={(e) =>
                                  setBookCurrency((p) => ({
                                    ...p,
                                    [m.id]: e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3),
                                  }))
                                }
                                placeholder="EUR"
                                className="h-10 text-base uppercase"
                              />
                            </div>
                          </div>

                          <div className="mt-3 flex flex-col gap-1">
                            <label htmlFor={`cb-${m.id}`} className="text-xs text-muted-foreground">
                              Cashback % on the 0.2% receipt fee (optional)
                            </label>
                            <div className="relative w-32">
                              <Input
                                id={`cb-${m.id}`}
                                inputMode="decimal"
                                value={bookCashback[m.id] ?? ""}
                                onChange={(e) =>
                                  setBookCashback((prev) => ({
                                    ...prev,
                                    [m.id]: e.target.value.replace(/[^0-9.]/g, ""),
                                  }))
                                }
                                placeholder="0"
                                className="h-10 pr-7 text-base"
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                %
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 space-y-1 rounded-md bg-background/60 p-2.5 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Standard receipt fee (0.2%)</span>
                              <span
                                className={rateFraction > 0 ? "text-muted-foreground line-through" : "text-foreground"}
                              >
                                {fmtMoney(cb.originalFee, currency || "—")}
                              </span>
                            </div>
                            {rateFraction > 0 && (
                              <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
                                <span>Cashback ({formatCashbackPct(cb.cashbackRate)})</span>
                                <span>−{fmtMoney(cb.cashbackAmount, currency || "—")}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between font-semibold text-foreground">
                              <span>Charged to customer</span>
                              <span>{fmtMoney(cb.netFee, currency || "—")}</span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleBookGuarantee(m, rateFraction > 0 ? rateFraction : undefined)}
                              disabled={booking === m.id || !canBook}
                              className="gap-1.5"
                            >
                              {booking === m.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Lock className="h-4 w-4" />
                              )}
                              Confirm &amp; book — charge {fmtMoney(cb.netFee, currency || "—")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setBookOpen(null)}
                              disabled={booking === m.id}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )
                    })()}

                  {reassignOpen === m.id && (
                    <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="text-xs font-medium text-foreground">Switch this payment to another customer</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Reassign this inbound message to a different Master Account before crediting. The funds are then
                        credited to the customer you select here — not the auto-matched one.
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Select
                          value={assignSel[m.id] ?? ""}
                          onValueChange={(v) => setAssignSel((prev) => ({ ...prev, [m.id]: v }))}
                        >
                          <SelectTrigger className="h-9 w-full sm:w-[320px]">
                            <SelectValue placeholder="Switch to customer…" />
                          </SelectTrigger>
                          <SelectContent>
                            {clients.length === 0 ? (
                              <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                                No active accounts
                              </div>
                            ) : (
                              clients.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.fullName} · {c.company} — {c.email}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          onClick={() => handleReassignCredit(m.id)}
                          disabled={assigning === m.id || !assignSel[m.id]}
                          className="gap-1.5"
                        >
                          {assigning === m.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <UserPlus className="h-4 w-4" />
                          )}
                          Switch &amp; deliver
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setReassignOpen(null)}
                          disabled={assigning === m.id}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {rejectOpen === m.id && (
                    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                      <p className="text-xs font-medium text-foreground">Reject this message?</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        It will be removed from the queue and the customer&apos;s inbox, and they will be notified. This
                        does not move any funds. Crediting is not mandatory.
                      </p>
                      <Textarea
                        value={rejectReason[m.id] ?? ""}
                        onChange={(e) => setRejectReason((prev) => ({ ...prev, [m.id]: e.target.value }))}
                        placeholder="Optional reason shared with the customer (e.g. unverifiable / duplicate / wrong beneficiary)"
                        className="mt-2 min-h-[64px] text-xs"
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleReject(m)}
                          disabled={rejecting === m.id}
                          className="gap-1.5"
                        >
                          {rejecting === m.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <XCircle className="h-4 w-4" />
                          )}
                          Confirm rejection
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRejectOpen(null)}
                          disabled={rejecting === m.id}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Unmatched review queue */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Inbox className="h-4 w-4" /> Review queue
                {unmatched.length > 0 && (
                  <Badge variant="secondary">{unmatched.length}</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Messages that could not be matched to a single active account. Assign each to the correct customer to
                deliver it.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={loadQueue} disabled={loadingQueue} className="gap-2 bg-transparent">
              {loadingQueue ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {unmatched.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loadingQueue ? "Loading…" : "No messages awaiting review."}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {unmatched.map((m) => (
                <div key={m.id} className="rounded-lg border border-border p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge className="bg-primary/15 text-primary">{m.messageType}</Badge>
                    {m.amount && <span className="text-sm font-semibold text-foreground">{m.amount}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDate(m.createdAt)}</span>
                  </div>
                  <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Detail label="Beneficiary" value={m.beneficiaryName || "—"} />
                    <Detail label="Beneficiary IBAN" value={m.beneficiaryIban || "—"} mono />
                    <Detail label="Receiving bank (:57a:)" value={m.receiverBic || "—"} mono />
                    <Detail label="Ordering customer" value={m.orderingCustomer || "—"} />
                    {m.reference && <Detail label="Reference" value={m.reference} />}
                    {m.uetr && <Detail label="UETR" value={m.uetr} mono />}
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {m.matchReason}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Select
                      value={assignSel[m.id] ?? ""}
                      onValueChange={(v) => setAssignSel((prev) => ({ ...prev, [m.id]: v }))}
                    >
                      <SelectTrigger className="h-9 w-full sm:w-[320px]">
                        <SelectValue placeholder="Assign to customer…" />
                      </SelectTrigger>
                      <SelectContent>
                        {clients.length === 0 ? (
                          <div className="px-2 py-3 text-center text-sm text-muted-foreground">No active accounts</div>
                        ) : (
                          clients.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.fullName} · {c.company} — {c.email}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => handleAssign(m.id)}
                      disabled={assigning === m.id || !assignSel[m.id]}
                      className="gap-1.5"
                    >
                      {assigning === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                      Assign &amp; deliver
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RejectButton({
  id,
  open,
  onToggle,
}: {
  id: string
  open: boolean
  onToggle: (id: string | null) => void
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onToggle(open ? null : id)}
      className="gap-1.5 border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <XCircle className="h-4 w-4" />
      Reject
    </Button>
  )
}

function SwitchCustomerButton({
  id,
  open,
  onToggle,
}: {
  id: string
  open: boolean
  onToggle: (id: string | null) => void
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onToggle(open ? null : id)}
      className="gap-1.5 bg-transparent"
    >
      <UserPlus className="h-4 w-4" />
      Switch customer
    </Button>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`break-all text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  )
}
