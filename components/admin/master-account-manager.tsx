"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Network,
  Loader2,
  Search,
  Link2,
  Link2Off,
  UserPlus,
  ArrowRight,
  Building2,
  ShieldCheck,
  Copy,
  Check,
  AlertTriangle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { useActivityLog } from "@/components/activity-tracker"
import type { AdminUserView, AdminUsersResult, SelectableClient, MasterChangeResult } from "@/app/actions/admin-users"
import { relationshipLabel, relationshipCode } from "@/lib/account-hierarchy"

type Mode = "existing" | "new" | "detach"
type LinkType = "sub" | "joint"

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

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

async function fetchMasterCandidates(excludeId?: string): Promise<SelectableClient[]> {
  try {
    const url = new URL("/api/admin/users", window.location.origin)
    url.searchParams.set("candidates", "1")
    url.searchParams.set("p", ADMIN_PASSCODE)
    if (excludeId) url.searchParams.set("excludeId", excludeId)
    const res = await fetch(url.toString(), { cache: "no-store" })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; masters?: SelectableClient[] } | null
    return data?.ok && data.masters ? data.masters : []
  } catch {
    return []
  }
}

async function postChangeMaster(input: Record<string, unknown>): Promise<MasterChangeResult> {
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
      body: JSON.stringify({ action: "changeMaster", input }),
    })
    const data = (await res.json().catch(() => null)) as MasterChangeResult | null
    return data ?? { ok: false, error: "The request could not be completed. Please try again." }
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." }
  }
}

export function MasterAccountManager() {
  const logActivity = useActivityLog()

  const [users, setUsers] = useState<AdminUserView[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string>("")

  const [masters, setMasters] = useState<SelectableClient[]>([])
  const [mode, setMode] = useState<Mode>("existing")
  const [linkType, setLinkType] = useState<LinkType>("sub")
  const [newMasterId, setNewMasterId] = useState<string>("")

  // Inline "create new Master" fields
  const [nmName, setNmName] = useState("")
  const [nmCompany, setNmCompany] = useState("")
  const [nmEmail, setNmEmail] = useState("")

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Credentials of a newly-created Master account, revealed after success.
  const [reveal, setReveal] = useState<{ email: string; password: string } | null>(null)
  const [copied, setCopied] = useState<"email" | "password" | null>(null)

  const load = () => {
    setLoading(true)
    fetchUsers()
      .then(setUsers)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const selected = useMemo(() => users.find((u) => u.id === selectedId) ?? null, [users, selectedId])

  // Refresh Master candidates whenever the selected customer changes so we can
  // exclude the customer itself from the pick list.
  useEffect(() => {
    if (!selectedId) {
      setMasters([])
      return
    }
    fetchMasterCandidates(selectedId).then(setMasters)
  }, [selectedId])

  const selectCustomer = (u: AdminUserView) => {
    setSelectedId(u.id)
    // Sensible defaults: keep the existing link type when the account already
    // shares a Master; otherwise default to Sub-account.
    setLinkType(u.relationship === "joint" ? "joint" : "sub")
    setMode(u.relationship === "master" ? "existing" : "existing")
    setNewMasterId("")
    setNmName("")
    setNmCompany("")
    setNmEmail("")
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.fullName.toLowerCase().includes(q) ||
        u.company.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    )
  }, [users, query])

  // The chosen new Master, for the summary preview.
  const chosenMaster = useMemo(() => masters.find((m) => m.id === newMasterId) ?? null, [masters, newMasterId])

  const canSubmit = (() => {
    if (!selected) return false
    if (mode === "existing") return !!newMasterId
    if (mode === "new") return !!(nmName.trim() || nmCompany.trim())
    return true // detach
  })()

  const handleSubmit = async () => {
    if (!selected) return
    setSubmitting(true)
    const input: Record<string, unknown> = {
      userId: selected.id,
      mode,
      linkType,
      adminName: "Administrator",
    }
    if (mode === "existing") input.newMasterId = newMasterId
    if (mode === "new") input.newMaster = { fullName: nmName.trim(), company: nmCompany.trim(), email: nmEmail.trim() || undefined }

    const res = await postChangeMaster(input)
    setSubmitting(false)
    setConfirmOpen(false)

    if (!res.ok) {
      toast.error(res.error)
      return
    }

    setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)))
    const newLabel = res.newMaster ? `${res.newMaster.name} <${res.newMaster.email}>` : "Standalone (own Master)"
    toast.success("Master Account updated", {
      description: `${res.user.fullName} is now ${
        res.newMaster ? `linked to ${res.newMaster.name}` : "a standalone Master"
      }.`,
    })
    logActivity({
      action: `Administrator changed the Master Account of ${res.user.fullName}`,
      category: "Administration / Master Account",
      details: {
        summary: `Master Account for ${res.user.fullName} (${res.user.company}) changed to ${newLabel}.`,
        account: `${res.user.fullName} — ${res.user.email}`,
        previousMaster: res.previousMaster
          ? `${res.previousMaster.name} <${res.previousMaster.email}>`
          : "Standalone (own Master)",
        newMaster: newLabel,
      },
    })
    if (res.createdMasterCredentials) setReveal(res.createdMasterCredentials)
    // Refresh candidates (a newly-created Master should now be pickable).
    fetchMasterCandidates(selected.id).then(setMasters)
  }

  const copy = async (kind: "email" | "password", value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error("Copy failed — select and copy manually.")
    }
  }

  const previousMasterLabel = selected
    ? selected.relationship !== "master" && selected.masterId
      ? `${selected.masterName ?? "—"}`
      : "Standalone (own Master)"
    : "—"

  const newMasterPreview =
    mode === "detach"
      ? "Standalone (own Master)"
      : mode === "new"
        ? nmName.trim() || nmCompany.trim() || "New Master account"
        : chosenMaster
          ? chosenMaster.fullName || chosenMaster.company
          : "—"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-primary" /> Master Account Management
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Fully update, modify or replace the Master Account any customer operates under. Re-linking repoints the
            customer&apos;s balances, bank instruments and transactions to the new Master — existing and future — while
            the previous Master account stays active but unlinked from this customer.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search customers by name, company or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading customer accounts…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No customer accounts match your search.</p>
          ) : (
            <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {filtered.map((u) => {
                const active = u.id === selectedId
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => selectCustomer(u)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors",
                      active ? "border-primary bg-primary/5" : "border-border bg-secondary/20 hover:border-primary/50",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{u.fullName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {u.company} · {u.email}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 gap-1.5",
                        u.relationship === "master"
                          ? "border-muted-foreground/30 text-muted-foreground"
                          : "border-primary/30 text-primary",
                      )}
                    >
                      {u.relationship === "master" ? (
                        "Standalone"
                      ) : (
                        <>
                          {relationshipCode(u.relationship)} · {u.masterName ?? "linked"}
                        </>
                      )}
                    </Badge>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change Master Account — {selected.fullName}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {selected.company} · {selected.email}
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Current master */}
            <div className="rounded-lg border border-border bg-secondary/20 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Current Master</p>
              <div className="mt-1 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{previousMasterLabel}</span>
                <Badge variant="outline" className="ml-auto text-muted-foreground">
                  {relationshipLabel(selected.relationship)}
                </Badge>
              </div>
              {selected.relationship !== "master" && selected.masterEmail && (
                <p className="mt-1 text-xs text-muted-foreground">{selected.masterEmail}</p>
              )}
            </div>

            {/* Mode selector */}
            <div className="space-y-2">
              <Label>Action</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    { value: "existing", label: "Link to existing", icon: Link2 },
                    { value: "new", label: "Create new Master", icon: UserPlus },
                    { value: "detach", label: "Detach (standalone)", icon: Link2Off },
                  ] as { value: Mode; label: string; icon: typeof Link2 }[]
                ).map((opt) => {
                  const active = mode === opt.value
                  const Icon = opt.icon
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setMode(opt.value)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors",
                        active ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:border-primary/50",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{opt.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Mode-specific controls */}
            {mode === "existing" && (
              <div className="space-y-2">
                <Label htmlFor="ma-master">New Master account</Label>
                <Select value={newMasterId} onValueChange={setNewMasterId}>
                  <SelectTrigger id="ma-master">
                    <SelectValue placeholder={masters.length ? "Select a Master account" : "No other Master accounts available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {masters.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.fullName} — {m.company} ({m.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {mode === "new" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ma-nm-name">Full name</Label>
                  <Input id="ma-nm-name" value={nmName} onChange={(e) => setNmName(e.target.value)} placeholder="e.g. Khalil Ahmed" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ma-nm-company">Company</Label>
                  <Input id="ma-nm-company" value={nmCompany} onChange={(e) => setNmCompany(e.target.value)} placeholder="e.g. Platinum House Global" />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ma-nm-email">Login email (optional — auto-generated if blank)</Label>
                  <Input id="ma-nm-email" type="email" value={nmEmail} onChange={(e) => setNmEmail(e.target.value)} placeholder="name@mccgva.ch" />
                </div>
              </div>
            )}

            {mode === "detach" && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <p className="text-xs text-amber-300">
                  The customer becomes its own standalone Master. Their balances and instruments will resolve to their
                  own account instead of the current Master.
                </p>
              </div>
            )}

            {/* Link type (not for detach) */}
            {mode !== "detach" && (
              <div className="space-y-2">
                <Label htmlFor="ma-linktype">Link type</Label>
                <Select value={linkType} onValueChange={(v) => setLinkType(v as LinkType)}>
                  <SelectTrigger id="ma-linktype">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sub">Sub-account (S) — shares balance & instruments; payments need Master consent</SelectItem>
                    <SelectItem value="joint">Linked / Joint (J) — shares the Master&apos;s full environment, unrestricted</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Old → New summary */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background p-3">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">From</p>
                <p className="truncate text-sm font-medium text-foreground">{previousMasterLabel}</p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">To</p>
                <p className="truncate text-sm font-medium text-foreground">{newMasterPreview}</p>
              </div>
            </div>

            <Button onClick={() => setConfirmOpen(true)} disabled={!canSubmit || submitting} className="w-full sm:w-auto">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              Update Master Account
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Confirmation */}
      <Dialog open={confirmOpen} onOpenChange={(o) => !submitting && setConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Master Account change</DialogTitle>
            <DialogDescription>
              This repoints {selected?.fullName}&apos;s balances, instruments and transactions. The change is atomic and
              fully audit-logged. The previous Master account stays active but is unlinked from this customer.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3 text-sm">
            <span className="font-medium text-foreground">{previousMasterLabel}</span>
            <ArrowRight className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">
              {newMasterPreview}
              {mode !== "detach" ? ` (${linkType === "joint" ? "Joint" : "Sub"})` : ""}
            </span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirm change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Master credentials reveal */}
      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Master account created</DialogTitle>
            <DialogDescription>
              Hand these credentials to the account holder. They can sign in immediately.
            </DialogDescription>
          </DialogHeader>
          {reveal && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Login email</Label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={reveal.email} className="font-mono text-sm" />
                  <Button size="icon" variant="outline" onClick={() => copy("email", reveal.email)}>
                    {copied === "email" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Temporary password</Label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={reveal.password} className="font-mono text-sm" />
                  <Button size="icon" variant="outline" onClick={() => copy("password", reveal.password)}>
                    {copied === "password" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setReveal(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
