"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Layers, Check, X, Loader2, RefreshCw, Search } from "lucide-react"
import type { SubAccount } from "@/lib/sub-account-types"

type AdminRow = SubAccount & { holderName: string; holderEmail: string }

const STATUS_VARIANT: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-600",
  active: "border-emerald-500/40 text-emerald-600",
  rejected: "border-red-500/40 text-red-600",
  closed: "border-muted-foreground/30 text-muted-foreground",
}

export function SubAccountsManager({ passcode }: { passcode: string }) {
  const [rows, setRows] = useState<AdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)
  // Per-row editable IBAN/BIC/note inputs for activation.
  const [drafts, setDrafts] = useState<Record<string, { iban: string; bic: string; note: string }>>({})

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
    } catch {
      setError("Network error while loading sub-accounts.")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [passcode])

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
                      <p className="mt-1 text-xs text-muted-foreground">
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
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`bic-${row.id}`}>SWIFT / BIC (optional)</Label>
                          <Input
                            id={`bic-${row.id}`}
                            className="font-mono"
                            placeholder="XXXXXXXX"
                            value={draft.bic}
                            onChange={(e) => setDraft(row.id, { bic: e.target.value })}
                          />
                        </div>
                      </div>
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
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void activate(row)} disabled={busy}>
                          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                          Assign IBAN &amp; activate
                        </Button>
                        <Button variant="outline" onClick={() => void reject(row)} disabled={busy}>
                          <X className="mr-2 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
