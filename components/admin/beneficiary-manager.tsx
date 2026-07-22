"use client"

import { useEffect, useMemo, useState } from "react"
import { Users, Check, Ban, Trash2, Plus, Loader2, Pencil, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  adminListBeneficiaries,
  adminListPendingKyc,
  adminUpsertBeneficiary,
  adminSetBeneficiaryStatus,
  adminDeleteBeneficiary,
  type BeneficiaryRecord,
} from "@/app/actions/beneficiaries"
import { useActivityLog } from "@/components/activity-tracker"
import type { Beneficiary, BeneficiaryStatus, BeneficiaryType } from "@/lib/beneficiaries-store"

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  pending: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  suspended: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  blocked: "bg-destructive/10 text-destructive border-destructive/20",
  cancelled: "bg-muted text-muted-foreground border-border",
}

const CURRENCIES = ["EUR", "GBP", "USD", "CHF"]

interface FormState {
  id: string
  type: BeneficiaryType
  name: string
  accountNumber: string
  iban: string
  swiftBic: string
  bankName: string
  bankCountry: string
  beneficiaryCountry: string
  currency: string
  status: BeneficiaryStatus
  notes: string
}

const emptyForm: FormState = {
  id: "",
  type: "individual",
  name: "",
  accountNumber: "",
  iban: "",
  swiftBic: "",
  bankName: "",
  bankCountry: "",
  beneficiaryCountry: "",
  currency: "EUR",
  status: "active",
  notes: "",
}

export function BeneficiaryManager() {
  const logActivity = useActivityLog()
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [targetUserId, setTargetUserId] = useState("")
  const [records, setRecords] = useState<BeneficiaryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // Cross-client KYC queue: every beneficiary still "pending", regardless of
  // which client owns it. This is what the admin command-center count reflects,
  // so it must be visible here even when the selected client has none.
  const [pendingAll, setPendingAll] = useState<BeneficiaryRecord[]>([])
  const [pendingLoading, setPendingLoading] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editing, setEditing] = useState(false)

  const targetClient = useMemo(() => clients.find((c) => c.id === targetUserId), [clients, targetUserId])

  // Load selectable clients once.
  useEffect(() => {
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        setClients(list)
        if (list.length && !targetUserId) setTargetUserId(list[0].id)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the selected client's beneficiaries.
  const refresh = (userId: string) => {
    if (!userId) return
    setLoading(true)
    adminListBeneficiaries(ADMIN_PASSCODE, userId)
      .then((res) => {
        if (!res.ok) {
          toast.error(res.error)
          setRecords([])
          return
        }
        setRecords(res.beneficiaries)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (targetUserId) refresh(targetUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId])

  // Load the cross-client KYC queue (every "pending" beneficiary, any client).
  const refreshPending = () => {
    setPendingLoading(true)
    adminListPendingKyc(ADMIN_PASSCODE)
      .then((res) => {
        if (!res.ok) {
          setPendingAll([])
          return
        }
        setPendingAll(res.beneficiaries.filter((r) => r.status === "pending"))
      })
      .finally(() => setPendingLoading(false))
  }

  useEffect(() => {
    refreshPending()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Friendly owner label for a pending record, resolved from the client list.
  const ownerLabel = (userId: string) => {
    const c = clients.find((x) => x.id === userId)
    return c ? `${c.fullName}${c.company ? ` · ${c.company}` : ""}` : userId
  }

  // Inline KYC decision from the cross-client queue, then refresh both lists.
  const decidePending = async (rec: BeneficiaryRecord, status: BeneficiaryStatus) => {
    setActingId(rec.id)
    const res = await adminSetBeneficiaryStatus(ADMIN_PASSCODE, rec.id, status, "Administrator")
    setActingId(null)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const name = (rec.data as unknown as Beneficiary).name
    toast.success(status === "active" ? `Approved ${name}.` : `Rejected ${name}.`)
    logActivity({
      action: `Administrator ${status === "active" ? "approved" : "rejected"} beneficiary ${name}`,
      category: "Administration / Beneficiaries",
      details: {
        summary: `Administrator ${status === "active" ? "approved" : "rejected"} KYC for beneficiary ${name} (owner: ${ownerLabel(rec.userId)}).`,
        targetAccount: ownerLabel(rec.userId),
      },
    })
    refreshPending()
    if (rec.userId === targetUserId) refresh(targetUserId)
  }

  const openCreate = () => {
    setForm(emptyForm)
    setEditing(false)
    setDialogOpen(true)
  }

  const openEdit = (rec: BeneficiaryRecord) => {
    const d = rec.data as unknown as Beneficiary
    setForm({
      id: rec.id,
      type: d.type ?? "individual",
      name: d.name ?? "",
      accountNumber: d.accountNumber ?? "",
      iban: d.iban ?? "",
      swiftBic: d.swiftBic ?? "",
      bankName: d.bankName ?? "",
      bankCountry: d.bankCountry ?? "",
      beneficiaryCountry: d.beneficiaryCountry ?? "",
      currency: d.currency ?? "EUR",
      status: d.status ?? "active",
      notes: d.notes ?? "",
    })
    setEditing(true)
    setDialogOpen(true)
  }

  const save = async () => {
    if (!targetUserId) return
    if (!form.name.trim() || !form.swiftBic.trim() || !form.bankName.trim()) {
      toast.error("Name, SWIFT/BIC and bank name are required.")
      return
    }
    setSaving(true)
    const id = form.id || `ben_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    // Merge onto any existing record so we never drop the rich KYC/AML fields.
    const existing = (records.find((r) => r.id === id)?.data as unknown as Beneficiary) ?? {}
    // The status the administrator picks IS the KYC decision: choosing "active"
    // verifies the beneficiary (and stamps today's AML screening date); any
    // other status leaves it unverified. This keeps the edit dialog consistent
    // with the row "Approve" button so KYC never stays stuck on "Pending".
    const isVerified = form.status === "active"
    const data: Beneficiary = {
      ...(existing as Beneficiary),
      id,
      type: form.type,
      name: form.name.trim(),
      accountNumber: form.accountNumber.trim(),
      iban: form.iban.trim() || undefined,
      swiftBic: form.swiftBic.trim(),
      bankName: form.bankName.trim(),
      bankAddress: existing.bankAddress ?? "",
      bankCountry: form.bankCountry.trim(),
      beneficiaryAddress: existing.beneficiaryAddress ?? "",
      beneficiaryCity: existing.beneficiaryCity ?? "",
      beneficiaryCountry: form.beneficiaryCountry.trim(),
      currency: form.currency,
      status: form.status,
      isFavorite: existing.isFavorite ?? false,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      totalTransactions: existing.totalTransactions ?? 0,
      totalVolume: existing.totalVolume ?? 0,
      notes: form.notes.trim() || undefined,
      kycVerified: isVerified,
      amlScreeningDate: isVerified
        ? new Date().toISOString().slice(0, 10)
        : existing.amlScreeningDate,
      riskLevel: existing.riskLevel ?? "low",
    }

    const res = await adminUpsertBeneficiary(
      ADMIN_PASSCODE,
      targetUserId,
      id,
      data as unknown as Record<string, unknown>,
      form.status,
      "Administrator",
    )
    setSaving(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(editing ? "Beneficiary updated." : "Beneficiary added.")
    logActivity({
      action: `Administrator ${editing ? "updated" : "added"} beneficiary ${data.name}`,
      category: "Administration / Beneficiaries",
      details: {
        summary: `Administrator ${editing ? "updated" : "added"} beneficiary ${data.name} (${data.swiftBic}) for ${targetClient?.fullName ?? targetUserId}. Status: ${form.status}.`,
        targetAccount: targetClient ? `${targetClient.fullName} — ${targetClient.email}` : targetUserId,
      },
    })
    setDialogOpen(false)
    refresh(targetUserId)
    refreshPending()
  }

  const changeStatus = async (rec: BeneficiaryRecord, status: BeneficiaryStatus) => {
    const res = await adminSetBeneficiaryStatus(ADMIN_PASSCODE, rec.id, status, "Administrator")
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    const name = (rec.data as unknown as Beneficiary).name
    toast.success(status === "active" ? `Approved ${name}.` : `Set ${name} to ${status}.`)
    logActivity({
      action: `Administrator set beneficiary ${name} to ${status}`,
      category: "Administration / Beneficiaries",
      details: {
        summary: `Administrator changed beneficiary ${name} to "${status}" for ${targetClient?.fullName ?? targetUserId}.`,
        targetAccount: targetClient ? `${targetClient.fullName} — ${targetClient.email}` : targetUserId,
      },
    })
    refresh(targetUserId)
    refreshPending()
  }

  const remove = async (rec: BeneficiaryRecord) => {
    const name = (rec.data as unknown as Beneficiary).name
    const res = await adminDeleteBeneficiary(ADMIN_PASSCODE, rec.id, "Administrator")
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(`Removed ${name}.`)
    logActivity({
      action: `Administrator removed beneficiary ${name}`,
      category: "Administration / Beneficiaries",
      details: {
        summary: `Administrator removed beneficiary ${name} from ${targetClient?.fullName ?? targetUserId}.`,
        targetAccount: targetClient ? `${targetClient.fullName} — ${targetClient.email}` : targetUserId,
      },
    })
    refresh(targetUserId)
    refreshPending()
  }

  const pendingCount = records.filter((r) => r.status === "pending").length

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <Users className="h-5 w-5 text-primary" />
              Beneficiary Management
            </CardTitle>
            <CardDescription className="text-pretty">
              Add, edit, remove and approve payment beneficiaries on behalf of any client.
            </CardDescription>
          </div>
          <Button onClick={openCreate} disabled={!targetUserId} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add beneficiary
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Cross-client KYC queue — the beneficiaries the admin command center
            counts as "awaiting a decision", regardless of which client owns
            them. Without this, a pending beneficiary belonging to a client
            other than the one selected below would be invisible. */}
        {pendingAll.length > 0 && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-semibold text-foreground">
                {pendingAll.length} beneficiar{pendingAll.length === 1 ? "y" : "ies"} awaiting KYC approval
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Across all clients. Approve or reject here, or jump to the owning client to review full details.
            </p>
            <ul className="divide-y divide-amber-500/15">
              {pendingAll.map((rec) => {
                const d = rec.data as unknown as Beneficiary
                const busy = actingId === rec.id
                return (
                  <li
                    key={rec.id}
                    className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{d.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {d.currency}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {d.bankName} · {d.swiftBic}
                      </p>
                      <button
                        type="button"
                        onClick={() => setTargetUserId(rec.userId)}
                        className="mt-0.5 truncate text-[11px] text-primary underline-offset-2 hover:underline"
                      >
                        Owner: {ownerLabel(rec.userId)}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-emerald-600"
                        disabled={busy}
                        onClick={() => decidePending(rec, "active")}
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-destructive"
                        disabled={busy}
                        onClick={() => decidePending(rec, "blocked")}
                      >
                        <Ban className="h-3.5 w-3.5" /> Reject
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Client picker */}
        <div className="space-y-2">
          <Label>Client account</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.fullName} — {c.company} ({c.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pendingCount > 0 && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-600">
              <ShieldCheck className="h-3 w-3" />
              {pendingCount} beneficiar{pendingCount === 1 ? "y" : "ies"} awaiting approval
            </p>
          )}
        </div>

        {/* Beneficiary list */}
        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading beneficiaries…
          </p>
        ) : records.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No beneficiaries for this client yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {records.map((rec) => {
              const d = rec.data as unknown as Beneficiary
              return (
                <li key={rec.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{d.name}</span>
                      <Badge variant="outline" className={cn("text-[10px]", STATUS_STYLES[d.status] ?? "")}>
                        {d.status}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {d.currency}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {d.bankName} · {d.swiftBic}
                      {d.iban ? ` · ${d.iban}` : d.accountNumber ? ` · ${d.accountNumber}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {d.status !== "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-emerald-600"
                        onClick={() => changeStatus(rec, "active")}
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                    )}
                    {d.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 text-orange-600"
                        onClick={() => changeStatus(rec, "suspended")}
                      >
                        <Ban className="h-3.5 w-3.5" /> Suspend
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => openEdit(rec)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1 text-destructive"
                      onClick={() => remove(rec)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* Add / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit beneficiary" : "Add beneficiary"}</DialogTitle>
            <DialogDescription>
              {targetClient ? `For ${targetClient.fullName} (${targetClient.company})` : "Select a client first"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 space-y-4 overflow-y-auto py-2 pr-1">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Beneficiary type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as BeneficiaryType }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">Individual</SelectItem>
                    <SelectItem value="corporate">Corporate</SelectItem>
                    <SelectItem value="financial_institution">Financial institution</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm((f) => ({ ...f, status: v as BeneficiaryStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                    <SelectItem value="blocked">Blocked</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Beneficiary name</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>IBAN</Label>
                <Input value={form.iban} onChange={(e) => setForm((f) => ({ ...f, iban: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Account number</Label>
                <Input
                  value={form.accountNumber}
                  onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>SWIFT / BIC</Label>
                <Input value={form.swiftBic} onChange={(e) => setForm((f) => ({ ...f, swiftBic: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}>
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
            <div className="space-y-2">
              <Label>Bank name</Label>
              <Input value={form.bankName} onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Bank country</Label>
                <Input
                  value={form.bankCountry}
                  onChange={(e) => setForm((f) => ({ ...f, bankCountry: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Beneficiary country</Label>
                <Input
                  value={form.beneficiaryCountry}
                  onChange={(e) => setForm((f) => ({ ...f, beneficiaryCountry: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter className="mt-2 border-t border-border pt-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {editing ? "Save changes" : "Add beneficiary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
