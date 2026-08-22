"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Layers, Check, X, Loader2, RefreshCw, Search, ShieldCheck, ShieldAlert, FileText, ArrowLeft, Download } from "lucide-react"
import type { SubAccount, SubAccountDoc } from "@/lib/sub-account-types"
import { blobFileUrl } from "@/lib/kyc-types"
import { serviceFeeFor, formatSubAccountFee, SUB_ACCOUNT_ANNUAL_FEE, SUB_ACCOUNT_CLOSING_FEE } from "@/lib/sub-account-fees"
import { validateIban, validateBic, lookupBankByIban, isGenericBankInfo } from "@/lib/iban-swift"
import { resolveIbanExternal } from "@/app/actions/bank-resolve"

type AdminRow = SubAccount & { holderName: string; holderEmail: string }
type VisitorCandidate = { id: string; label: string; email: string }
type VisitorLink = { visitorUserId: string; subAccountId: string; ownerId: string; linkedAt: string }

const STATUS_VARIANT: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-600",
  active: "border-emerald-500/40 text-emerald-600",
  rejected: "border-red-500/40 text-red-600",
  closed: "border-muted-foreground/30 text-muted-foreground",
}

const DOC_LABEL: Record<SubAccountDoc["kind"], string> = { passport: "Passport", kyc: "KYC document" }

/**
 * In-app overlay for viewing an uploaded UBO document. NEVER use target="_blank"
 * in the installed PWA (dead links) — render an iframe preview with an explicit
 * Back + Download toolbar, and download via the share-sheet / object-URL path.
 */
function DocViewer({ doc, passcode, onClose }: { doc: SubAccountDoc; passcode: string; onClose: () => void }) {
  const [downloading, setDownloading] = useState(false)
  const url = doc.pathname ? blobFileUrl(doc.pathname, passcode) : doc.url || ""

  const handleDownload = async () => {
    if (!url) return
    setDownloading(true)
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const file = new File([blob], doc.fileName || "document", { type: blob.type || "application/octet-stream" })
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
      if (typeof navigator.share === "function" && nav.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] })
          return
        } catch (err) {
          if ((err as Error).name === "AbortError") return
        }
      }
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = objectUrl
      a.download = doc.fileName || "document"
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
    } catch {
      /* best effort */
    } finally {
      setDownloading(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back
          </Button>
          <span className="truncate text-sm font-medium text-foreground">
            {DOC_LABEL[doc.kind]} — {doc.fileName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => void handleDownload()} disabled={downloading}>
            {downloading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
            Download
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {url ? (
        <iframe src={url} title={`${DOC_LABEL[doc.kind]} preview`} className="min-h-0 flex-1 bg-muted" />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          This document was not stored (metadata only).
        </div>
      )}
    </div>,
    document.body,
  )
}

type ActivateDraft = { iban: string; bic: string; note: string }

/**
 * Pending-request activation form for ONE sub-account. Owns the live IBAN
 * check + SWIFT/BIC auto-fill (hooks can't run inside the parent's row map).
 * Mirrors the master-account editor: the IBAN is the source of truth — a valid
 * IBAN auto-resolves the bank's SWIFT/BIC (curated directory first, then the
 * external resolver) and OVERWRITES a stale wrong-country BIC; a live
 * cross-country pair shows a fix button.
 */
function ActivatePanel({
  row,
  draft,
  setDraft,
  busy,
  onActivate,
  onReject,
}: {
  row: AdminRow
  draft: ActivateDraft
  setDraft: (id: string, patch: Partial<ActivateDraft>) => void
  busy: boolean
  onActivate: () => void
  onReject: () => void
}) {
  const [bankLookingUp, setBankLookingUp] = useState(false)

  const ibanCheck = useMemo(() => (draft.iban.trim() ? validateIban(draft.iban) : null), [draft.iban])
  const bicCheck = useMemo(() => (draft.bic.trim() ? validateBic(draft.bic) : null), [draft.bic])
  const ibanInvalid = !!ibanCheck && !ibanCheck.valid
  const bicInvalid = !!bicCheck && !bicCheck.valid
  const validIban = ibanCheck?.valid ? ibanCheck.formatted.replace(/\s/g, "") : ""

  // Read the latest BIC inside the resolver without re-running it per keystroke.
  const bicRef = useRef("")
  bicRef.current = draft.bic

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
    return { bic: info?.bic }
  }

  // On a valid IBAN, fill an empty SWIFT/BIC or overwrite one that belongs to a
  // different country (a leftover from a previous IBAN). Runs on every IBAN edit.
  useEffect(() => {
    if (!validIban) return
    let active = true
    const ibanCountry = validIban.slice(0, 2)
    const curBic = bicRef.current.trim()
    const curBicCheck = curBic ? validateBic(curBic) : null
    const overwrite = !!(curBicCheck?.valid && curBicCheck.countryCode !== ibanCountry)
    if (curBic && !overwrite) return // already has a compatible BIC — don't clobber

    setBankLookingUp(true)
    ;(async () => {
      const bank = await resolveBankForIban(validIban)
      if (!active) return
      if (bank.bic) setDraft(row.id, { bic: bank.bic })
      else if (overwrite) setDraft(row.id, { bic: "" })
    })().finally(() => {
      if (active) setBankLookingUp(false)
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validIban])

  // Safety net: a manually mistyped SWIFT (same IBAN, wrong-country BIC).
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
      setDraft(row.id, { bic: bank.bic ?? "" })
    } finally {
      setBankLookingUp(false)
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`iban-${row.id}`}>IBAN / Account reference *</Label>
          <Input
            id={`iban-${row.id}`}
            className="font-mono"
            placeholder="CH00 0000 0000 0000 0000 0"
            value={draft.iban}
            onChange={(e) => setDraft(row.id, { iban: e.target.value })}
            aria-invalid={ibanInvalid}
          />
          {ibanInvalid ? (
            <p className="text-[11px] text-red-600">{ibanCheck?.error}</p>
          ) : ibanCheck?.valid ? (
            <p className="text-[11px] text-emerald-600">
              Valid {ibanCheck.countryName} IBAN{bankLookingUp ? " — looking up bank…" : ""}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`bic-${row.id}`}>SWIFT / BIC (optional)</Label>
          <Input
            id={`bic-${row.id}`}
            className="font-mono"
            placeholder="XXXXXXXX"
            value={draft.bic}
            onChange={(e) => setDraft(row.id, { bic: e.target.value.toUpperCase() })}
            aria-invalid={bicInvalid}
          />
          {bicInvalid ? (
            <p className="text-[11px] text-red-600">{bicCheck?.error}</p>
          ) : draft.bic.trim() && !countryMismatch ? (
            <p className="text-[11px] text-emerald-600">Auto-filled from IBAN — verify before activating.</p>
          ) : null}
        </div>
      </div>

      {countryMismatch && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            The SWIFT/BIC country ({bicCheck?.countryCode}) does not match the IBAN country (
            {ibanCheck?.countryCode}).
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void fixFromIban()} disabled={bankLookingUp}>
            {bankLookingUp ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Use the IBAN&apos;s bank
          </Button>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`note-${row.id}`}>Note to client (optional)</Label>
        <Textarea
          id={`note-${row.id}`}
          rows={2}
          placeholder="Shown to the client with the decision…"
          value={draft.note}
          onChange={(e) => setDraft(row.id, { note: e.target.value })}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Activating charges the Master Account a {formatSubAccountFee(serviceFeeFor(row.verification))} service fee (
        {row.verification === "declared" ? "declared UBO" : "alias"}) plus the{" "}
        {formatSubAccountFee(SUB_ACCOUNT_ANNUAL_FEE)} annual fee, immediately.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onActivate} disabled={busy || ibanInvalid || bicInvalid}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          Assign IBAN &amp; activate
        </Button>
        <Button variant="outline" onClick={onReject} disabled={busy}>
          <X className="mr-2 h-4 w-4" />
          Reject
        </Button>
      </div>
    </div>
  )
}

export function SubAccountsManager({ passcode }: { passcode: string }) {
  const [rows, setRows] = useState<AdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)
  // Per-row editable IBAN/BIC/note inputs for activation.
  const [drafts, setDrafts] = useState<Record<string, { iban: string; bic: string; note: string }>>({})
  // Currently-open UBO document in the in-app viewer.
  const [viewerDoc, setViewerDoc] = useState<SubAccountDoc | null>(null)
  // Visitor linking: candidates + existing links, and a per-row selected visitor.
  const [visitors, setVisitors] = useState<VisitorCandidate[]>([])
  const [links, setLinks] = useState<VisitorLink[]>([])
  const [linkChoice, setLinkChoice] = useState<Record<string, string>>({})
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "list", pin: passcode }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.reason === "unauthorized" ? "Administrator authorization failed." : "Could not load sub-accounts.")
        setRows([])
        return
      }
      setRows(data.subAccounts as AdminRow[])
      setVisitors((data.visitors as VisitorCandidate[]) || [])
      setLinks((data.links as VisitorLink[]) || [])
    } catch {
      setError("Network error while loading sub-accounts.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [passcode])

  const linkVisitor = async (row: AdminRow) => {
    const visitorId = linkChoice[row.id] || ""
    if (!visitorId) {
      setError("Choose a visitor to link.")
      return
    }
    setLinkBusyId(row.id)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "link", pin: passcode, subId: row.id, visitorId }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.error || "Could not link the visitor.")
        return
      }
      setLinks((data.links as VisitorLink[]) || [])
      setLinkChoice((prev) => ({ ...prev, [row.id]: "" }))
    } catch {
      setError("Network error while linking.")
    } finally {
      setLinkBusyId(null)
    }
  }

  const unlinkVisitor = async (row: AdminRow, visitorId: string) => {
    setLinkBusyId(row.id)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "unlink", pin: passcode, visitorId }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.error || "Could not remove the link.")
        return
      }
      setLinks((data.links as VisitorLink[]) || [])
    } catch {
      setError("Network error while unlinking.")
    } finally {
      setLinkBusyId(null)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const setDraft = (id: string, patch: Partial<{ iban: string; bic: string; note: string }>) =>
    setDrafts((prev) => {
      const current = prev[id] || { iban: "", bic: "", note: "" }
      return { ...prev, [id]: { ...current, ...patch } }
    })

  const activate = async (row: AdminRow) => {
    const draft = drafts[row.id] || { iban: "", bic: "", note: "" }
    if (!draft.iban.trim()) {
      setError("Enter an IBAN / account reference before activating.")
      return
    }
    setBusyId(row.id)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "activate",
          pin: passcode,
          id: row.id,
          iban: draft.iban.trim(),
          bic: draft.bic.trim(),
          note: draft.note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.error || "Could not activate the sub-account.")
        return
      }
      await load()
    } catch {
      setError("Network error while activating.")
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (row: AdminRow) => {
    const draft = drafts[row.id] || { iban: "", bic: "", note: "" }
    setBusyId(row.id)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "reject", pin: passcode, id: row.id, note: draft.note.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.error || "Could not reject the request.")
        return
      }
      await load()
    } catch {
      setError("Network error while rejecting.")
    } finally {
      setBusyId(null)
    }
  }

  const closeAccount = async (row: AdminRow) => {
    if (
      !window.confirm(
        `Close the sub-account "${row.label}"? A ${formatSubAccountFee(SUB_ACCOUNT_CLOSING_FEE)} closing fee will be charged to the Master Account.`,
      )
    ) {
      return
    }
    const draft = drafts[row.id] || { iban: "", bic: "", note: "" }
    setBusyId(row.id)
    setError("")
    try {
      const res = await fetch("/api/admin/sub-accounts", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "close", pin: passcode, id: row.id, adminNote: draft.note.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data?.error || "Could not close the sub-account.")
        return
      }
      await load()
    } catch {
      setError("Network error while closing.")
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.holderName, r.holderEmail, r.label, r.iban, r.currency, r.purpose].some((v) =>
        (v || "").toLowerCase().includes(q),
      ),
    )
  }, [rows, query])

  const pendingCount = rows.filter((r) => r.status === "pending").length

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Client Sub-Accounts</CardTitle>
              <CardDescription>
                Assign an IBAN / BIC to activate a client&apos;s sub-account request, or reject it.
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search by client, label, IBAN, currency…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Badge variant="outline" className="border-amber-500/40 text-amber-600">
            {pendingCount} pending
          </Badge>
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No sub-account requests found.</p>
        ) : (
          <div className="space-y-3">
            {filtered.map((row) => {
              const draft = drafts[row.id] || { iban: row.iban || "", bic: row.bic || "", note: "" }
              const busy = busyId === row.id
              return (
                <div key={row.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{row.label}</span>
                        <Badge variant="outline" className={STATUS_VARIANT[row.status] || ""}>
                          {row.status}
                        </Badge>
                        <Badge variant="outline">{row.currency}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {row.holderName} · {row.holderEmail}
                      </p>
                      {row.purpose && <p className="mt-1 text-sm text-foreground/80">Purpose: {row.purpose}</p>}
                      {row.beneficiaryName && (
                        <p className="mt-1 text-sm text-foreground/80">
                          Beneficiary: {row.beneficiaryName}
                          {row.beneficiaryDetails ? ` — ${row.beneficiaryDetails}` : ""}
                        </p>
                      )}

                      {/* UBO verification: declared (KYC + passport) vs alias liability */}
                      <div className="mt-2">
                        {row.verification === "declared" ? (
                          <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
                            <ShieldCheck className="mr-1 h-3 w-3" />
                            UBO declared · KYC + passport
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-500/50 text-amber-600">
                            <ShieldAlert className="mr-1 h-3 w-3" />
                            Alias · client legal responsibility
                          </Badge>
                        )}
                        {row.verification !== "declared" && row.legalResponsibilityAcceptedAt && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Holder accepted legal responsibility on{" "}
                            {new Date(row.legalResponsibilityAcceptedAt).toLocaleString()}.
                          </p>
                        )}
                        {row.kycDocuments && row.kycDocuments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {row.kycDocuments.map((doc, i) => (
                              <Button
                                key={`${row.id}-${doc.kind}-${i}`}
                                variant="outline"
                                size="sm"
                                className="h-8"
                                onClick={() => setViewerDoc(doc)}
                              >
                                <FileText className="mr-1.5 h-3.5 w-3.5" />
                                {DOC_LABEL[doc.kind]}
                              </Button>
                            ))}
                          </div>
                        )}
                      </div>

                      <p className="mt-2 text-xs text-muted-foreground">
                        Requested {new Date(row.createdAt).toLocaleString()}
                      </p>
                      {row.status === "active" && row.iban && (
                        <p className="mt-1 font-mono text-xs text-foreground">
                          {row.iban}
                          {row.bic ? ` · ${row.bic}` : ""}
                        </p>
                      )}
                    </div>
                  </div>

                  {row.status === "pending" && (
                    <ActivatePanel
                      row={row}
                      draft={draft}
                      setDraft={setDraft}
                      busy={busy}
                      onActivate={() => void activate(row)}
                      onReject={() => void reject(row)}
                    />
                  )}

                  {row.status === "active" && (
                    <>
                      {(() => {
                        const linked = links.filter((l) => l.subAccountId === row.id)
                        const linkBusy = linkBusyId === row.id
                        return (
                          <div className="mt-4 space-y-2 border-t border-border pt-3">
                            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                              <Layers className="h-3.5 w-3.5" />
                              Linked visitor access
                            </div>
                            {linked.length > 0 ? (
                              linked.map((l) => {
                                const v = visitors.find((x) => x.id === l.visitorUserId)
                                return (
                                  <div
                                    key={l.visitorUserId}
                                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
                                  >
                                    <span className="min-w-0 truncate text-sm">
                                      {v ? `${v.label} · ${v.email}` : l.visitorUserId}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="border-red-500/40 text-red-600 hover:bg-red-500/10"
                                      onClick={() => void unlinkVisitor(row, l.visitorUserId)}
                                      disabled={linkBusy}
                                    >
                                      {linkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Unlink"}
                                    </Button>
                                  </div>
                                )
                              })
                            ) : visitors.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                No Visitor-tier accounts available to link.
                              </p>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  className="h-9 min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 text-sm"
                                  value={linkChoice[row.id] || ""}
                                  onChange={(e) =>
                                    setLinkChoice((prev) => ({ ...prev, [row.id]: e.target.value }))
                                  }
                                  disabled={linkBusy}
                                >
                                  <option value="">Select a visitor…</option>
                                  {visitors
                                    .filter((v) => v.id !== row.userId)
                                    .map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.label} · {v.email}
                                      </option>
                                    ))}
                                </select>
                                <Button size="sm" onClick={() => void linkVisitor(row)} disabled={linkBusy}>
                                  {linkBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                  Link visitor
                                </Button>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-500/40 text-red-600 hover:bg-red-500/10"
                          onClick={() => void closeAccount(row)}
                          disabled={busy}
                        >
                          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}
                          Close sub-account ({formatSubAccountFee(SUB_ACCOUNT_CLOSING_FEE)} fee)
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
      {viewerDoc && <DocViewer doc={viewerDoc} passcode={passcode} onClose={() => setViewerDoc(null)} />}
    </Card>
  )
}
