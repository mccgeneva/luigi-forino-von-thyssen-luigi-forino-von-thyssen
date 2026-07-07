"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Users,
  UserPlus,
  Loader2,
  KeyRound,
  Copy,
  Check,
  Pencil,
  Trash2,
  ShieldCheck,
  ShieldOff,
  ScanFace,
  Ban,
  Search,
  FileUp,
  Sparkles,
  FileText,
  X,
  LogIn,
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
import { CountryCombobox } from "@/components/country-combobox"
import { useActivityLog } from "@/components/activity-tracker"
import type {
  AdminUserView,
  AdminUsersResult,
  AdminUserMutation,
  SelectableClient,
  CreateUserInput,
  EditUserInput,
} from "@/app/actions/admin-users"
import { KycDocumentManager } from "@/components/admin/kyc-document-manager"
import type { UserStatus, AccountRelationship } from "@/lib/profile-types"
import { RELATIONSHIP_OPTIONS, relationshipLabel, relationshipCode } from "@/lib/account-hierarchy"
import { upload } from "@vercel/blob/client"
import {
  type KycAnalysisResult,
  KYC_DOCUMENT_LABELS,
  blobFileUrl,
} from "@/lib/kyc-types"

const STATUS_META: Record<UserStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green-500/10 text-green-400 border-green-500/30" },
  suspended: { label: "Suspended", className: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  inactive: { label: "Inactive", className: "bg-red-500/10 text-red-400 border-red-500/30" },
}

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

interface CredentialReveal {
  email: string
  password: string
  title: string
}

// All admin user mutations + the Master-candidate list go through the
// `/api/admin/users` Route Handler instead of Server Actions. Server Action
// POSTs are silently rejected on this app's production domains + mobile in-app
// webviews, which left "Save changes" / create / reset / status / delete
// spinning forever and the Master dropdown empty. These helpers wrap the route
// and always resolve, so the callers can use try/catch/finally safely.
async function postUserAction(action: string, payload: Record<string, unknown>): Promise<AdminUserMutation> {
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
      body: JSON.stringify({ action, ...payload }),
    })
    const data = (await res.json().catch(() => null)) as AdminUserMutation | null
    if (data) return data
    return { ok: false, error: "The request could not be completed. Please try again." }
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." }
  }
}

async function postDeleteUser(id: string): Promise<AdminUsersResult> {
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
      body: JSON.stringify({ action: "delete", id }),
    })
    const data = (await res.json().catch(() => null)) as AdminUsersResult | null
    if (data) return data
    return { ok: false, error: "The request could not be completed. Please try again." }
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." }
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

export function UserManager() {
  const logActivity = useActivityLog()

  const [users, setUsers] = useState<AdminUserView[]>([])
  const [loading, setLoading] = useState(true)
  // Distinguishes "the server said there are zero accounts" from "we could not
  // load accounts at all" (e.g. a stale browser tab calling a Server Action
  // after a new deployment shipped, which rejects the promise). Without this the
  // load-failure and the genuinely-empty states look identical, which reads as
  // catastrophic "all users disappeared" data loss when the data is perfectly safe.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  // Create form
  const [createOpen, setCreateOpen] = useState(false)
  const [fullName, setFullName] = useState("")
  const [company, setCompany] = useState("")
  const [role, setRole] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [phone, setPhone] = useState("")
  const [nationality, setNationality] = useState("")
  const [address, setAddress] = useState("")
  const [website, setWebsite] = useState("")
  const [accountBadge, setAccountBadge] = useState("PRO Account")
  const [relationship, setRelationship] = useState<AccountRelationship>("master")
  const [masterId, setMasterId] = useState<string>("")
  const [creating, setCreating] = useState(false)

  // Master candidates for the relationship picker (top-level accounts only).
  const [masters, setMasters] = useState<SelectableClient[]>([])

  // KYC PDF auto-fill
  const [kycAnalyzing, setKycAnalyzing] = useState(false)
  const [kycResult, setKycResult] = useState<KycAnalysisResult | null>(null)
  const [kycFileName, setKycFileName] = useState("")
  const kycInputRef = useRef<HTMLInputElement | null>(null)

  // Edit form
  const [editTarget, setEditTarget] = useState<AdminUserView | null>(null)
  const [editFullName, setEditFullName] = useState("")
  const [editCompany, setEditCompany] = useState("")
  const [editRole, setEditRole] = useState("")
  const [editEmail, setEditEmail] = useState("")
  const [editBadge, setEditBadge] = useState("")
  const [editRelationship, setEditRelationship] = useState<AccountRelationship>("master")
  const [editMasterId, setEditMasterId] = useState<string>("")
  const [savingEdit, setSavingEdit] = useState(false)

  // Reset password dialog
  const [resetTarget, setResetTarget] = useState<AdminUserView | null>(null)
  const [resetPassword, setResetPassword] = useState("")
  const [resetting, setResetting] = useState(false)

  // Credential reveal dialog (shown after create / reset)
  const [reveal, setReveal] = useState<CredentialReveal | null>(null)
  const [copied, setCopied] = useState<"email" | "password" | "both" | null>(null)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<AdminUserView | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Face ID reset confirm
  const [faceResetTarget, setFaceResetTarget] = useState<AdminUserView | null>(null)
  const [docsTarget, setDocsTarget] = useState<AdminUserView | null>(null)
  const [faceResetting, setFaceResetting] = useState(false)

  // "Sign in as" (impersonation) — tracks the account currently being entered.
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setLoadError(null)
    // Load via a Route Handler (GET /api/admin/users) rather than the Server
    // Action. Next.js validates Server Action requests against the forwarded
    // Origin/Host, and on this app's production domains (apex -> www redirect,
    // custom domains, in-app webviews) that check can SILENTLY reject the call —
    // which made this list come back empty even though the accounts were safe on
    // the server. Route Handlers are exempt from that check and work identically
    // on every domain. (Same fix already applied to activity logging.)
    fetch(`/api/admin/users?p=${encodeURIComponent(ADMIN_PASSCODE)}`, {
      headers: { "x-admin-passcode": ADMIN_PASSCODE },
      cache: "no-store",
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as AdminUsersResult | null
        if (!res.ok || !data || !data.ok) {
          const message =
            (data && !data.ok && data.error) || "Couldn’t load client accounts. Please reload — your data is safe."
          setLoadError(message)
          toast.error(message)
          setUsers([])
          return
        }
        // Success: clear any prior error and show the accounts the server returned.
        setLoadError(null)
        setUsers(data.users)
      })
      .catch((err) => {
        const message =
          "Couldn’t load client accounts. This usually means the app was updated in another tab — reload to fetch the latest version. Your data is safe."
        console.log("[v0] /api/admin/users fetch failed:", err?.message ?? err)
        setLoadError(message)
        toast.error(message)
        setUsers([])
      })
      .finally(() => setLoading(false))
    // Refresh the Master candidate list alongside the user table.
    fetchMasterCandidates().then((m) => setMasters(m))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const resetCreateForm = () => {
    setFullName("")
    setCompany("")
    setRole("")
    setEmail("")
    setPassword("")
    setPhone("")
    setNationality("")
    setAddress("")
    setWebsite("")
    setAccountBadge("PRO Account")
    setRelationship("master")
    setMasterId("")
    setKycResult(null)
    setKycFileName("")
    setKycAnalyzing(false)
    if (kycInputRef.current) kycInputRef.current.value = ""
  }

  // Render the uploaded PDF to page images in the browser, upload them directly
  // to Blob (bypassing the serverless request-body limit), then ask the server
  // to analyse them and pre-fill the form.
  const handleKycUpload = async (file: File | null) => {
    if (!file) return
    if (file.type !== "application/pdf") {
      toast.error("Please upload a PDF file.")
      return
    }
    setKycAnalyzing(true)
    setKycResult(null)
    setKycFileName(file.name)
    try {
      // Upload the raw PDF straight to Blob from the browser. This keeps the
      // file out of our API function (which would reject anything over the
      // ~4.5 MB serverless body limit) and avoids any client-side PDF rendering,
      // which proved unreliable on mobile Safari.
      const prefix = `kyc/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const clientPayload = JSON.stringify({ passcode: ADMIN_PASSCODE })

      // Guard the upload so a stalled mobile connection can't spin forever.
      const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
        Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out. Check your connection and try again.`)), ms),
          ),
        ])

      const pdfUpload = await withTimeout(
        upload(`${prefix}/original.pdf`, file, {
          access: "public",
          handleUploadUrl: "/api/kyc/blob-upload",
          contentType: "application/pdf",
          clientPayload,
        }),
        60_000,
        "Uploading the PDF",
      )

      const controller = new AbortController()
      const analyzeTimer = setTimeout(() => controller.abort(), 110_000)
      let res: Response
      try {
        res = await fetch("/api/kyc/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            passcode: ADMIN_PASSCODE,
            pdfPathname: pdfUpload.pathname,
          }),
          signal: controller.signal,
        })
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          throw new Error("Analysis timed out. Please try again.")
        }
        throw e
      } finally {
        clearTimeout(analyzeTimer)
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || "Analysis failed.")
      }
      const result = (await res.json()) as KycAnalysisResult
      setKycResult(result)

      // Pre-fill any field the admin hasn't already typed into.
      const f = result.fields
      if (f.fullName) setFullName((v) => v || f.fullName)
      if (f.company) setCompany((v) => v || f.company)
      if (f.role) setRole((v) => v || f.role)
      if (f.email) setEmail((v) => v || f.email)
      if (f.phone) setPhone((v) => v || f.phone)
      if (f.nationality) setNationality((v) => v || f.nationality)
      if (f.address) setAddress((v) => v || f.address)
      if (f.website) setWebsite((v) => v || f.website)

      toast.success("KYC document analysed", {
        description: `${result.documents.length} document${
          result.documents.length === 1 ? "" : "s"
        } detected. Review the pre-filled details below.`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not analyse the document."
      toast.error(message)
      setKycFileName("")
    } finally {
      setKycAnalyzing(false)
    }
  }

  const handleCreate = async () => {
    if (!fullName.trim() && !company.trim()) {
      toast.error("Enter at least a full name or a company.")
      return
    }
    if (relationship !== "master" && !masterId) {
      toast.error("Select a Master account for a sub or child account.")
      return
    }
    setCreating(true)
    const input: Omit<CreateUserInput, "passcode"> = {
      fullName: fullName.trim(),
      company: company.trim(),
      role: role.trim() || undefined,
      email: email.trim() || undefined,
      password: password.trim() || undefined,
      phone: phone.trim() || undefined,
      nationality: nationality.trim() || undefined,
      address: address.trim() || undefined,
      website: website.trim() || undefined,
      accountBadge: accountBadge.trim() || undefined,
      relationship,
      masterId: relationship !== "master" ? masterId : undefined,
      passportImage: kycResult?.passportImagePathname
        ? blobFileUrl(kycResult.passportImagePathname)
        : undefined,
      passportMeta: kycResult?.passportMeta ?? undefined,
      kycDocuments: kycResult?.documents?.length ? kycResult.documents : undefined,
      kycPdfPathname: kycResult?.pdfPathname || undefined,
      adminName: "Administrator",
    }
    const res = await postUserAction("create", { input })
    setCreating(false)

    if (!res.ok) {
      toast.error(res.error)
      return
    }

    setUsers((prev) => [res.user, ...prev])
    setCreateOpen(false)
    setReveal({
      email: res.user.email,
      password: res.tempPassword ?? res.user.password,
      title: "Client account created",
    })
    toast.success("Client account created", {
      description: `${res.user.fullName} (${res.user.company}) can now sign in.`,
    })
    logActivity({
      action: `Administrator created client account for ${res.user.fullName}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator created a new client account for ${res.user.fullName} (${res.user.company}) with login ${res.user.email}.`,
        account: `${res.user.fullName} — ${res.user.email}`,
        company: res.user.company,
        status: res.user.status,
      },
    })
    resetCreateForm()
  }

  const openEdit = (u: AdminUserView) => {
    setEditTarget(u)
    setEditFullName(u.fullName)
    setEditCompany(u.company)
    setEditRole(u.role)
    setEditEmail(u.email)
    // Coerce any legacy/blank badge to one of the two valid tiers so the editor
    // always shows a real account type.
    setEditBadge(u.accountBadge?.toLowerCase().includes("avant") ? "Avant-garde Account" : "PRO Account")
    setEditRelationship(u.relationship)
    setEditMasterId(u.masterId ?? "")
  }

  const handleEdit = async () => {
    if (!editTarget) return
    if (editRelationship !== "master" && !editMasterId) {
      toast.error("Select a Master account for a sub or child account.")
      return
    }
    setSavingEdit(true)
    const input: Omit<EditUserInput, "passcode"> = {
      id: editTarget.id,
      fullName: editFullName.trim() || undefined,
      company: editCompany.trim() || undefined,
      role: editRole.trim() || undefined,
      email: editEmail.trim() || undefined,
      accountBadge: editBadge.trim() || undefined,
      relationship: editRelationship,
      masterId: editRelationship !== "master" ? editMasterId : undefined,
      adminName: "Administrator",
    }
    const res = await postUserAction("edit", { input })
    setSavingEdit(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)))
    setEditTarget(null)
    toast.success("Account updated", { description: `${res.user.fullName} was updated.` })
    logActivity({
      action: `Administrator edited client account ${res.user.fullName}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator updated the profile of ${res.user.fullName} (${res.user.company}).`,
        account: `${res.user.fullName} — ${res.user.email}`,
      },
    })
  }

  const openReset = (u: AdminUserView) => {
    setResetTarget(u)
    setResetPassword("")
  }

  const handleReset = async () => {
    const u = resetTarget
    if (!u) return
    const custom = resetPassword.trim()
    if (custom && custom.length < 6) {
      toast.error("Password must be at least 6 characters.")
      return
    }
    setResetting(true)
    // Pass the typed password to assign it directly; leave blank to auto-generate.
    const res = await postUserAction("resetPassword", { id: u.id, newPassword: custom || undefined })
    setResetting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setUsers((prev) => prev.map((x) => (x.id === res.user.id ? res.user : x)))
    setResetTarget(null)
    setReveal({
      email: res.user.email,
      password: res.tempPassword ?? res.user.password,
      title: "Credentials reset",
    })
    toast.success(custom ? "Password updated" : "Temporary password generated")
    logActivity({
      action: `Administrator reset credentials for ${u.fullName}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator ${custom ? "set a new password" : "generated a new temporary password"} for ${u.fullName} (${u.company}).`,
        account: `${u.fullName} — ${u.email}`,
      },
    })
  }

  const handleStatus = async (u: AdminUserView, status: UserStatus) => {
    const res = await postUserAction("status", { id: u.id, status })
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setUsers((prev) => prev.map((x) => (x.id === res.user.id ? res.user : x)))
    toast.success(`Account ${STATUS_META[status].label.toLowerCase()}`, {
      description: `${u.fullName} is now ${STATUS_META[status].label.toLowerCase()}.`,
    })
    logActivity({
      action: `Administrator set ${u.fullName} to ${status}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator changed the status of ${u.fullName} (${u.company}) to ${status}.`,
        account: `${u.fullName} — ${u.email}`,
        status,
      },
    })
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    const res = await postDeleteUser(deleteTarget.id)
    setDeleting(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setUsers(res.users)
    const removed = deleteTarget
    setDeleteTarget(null)
    toast.success("Account deleted", { description: `${removed.fullName} was permanently removed.` })
    logActivity({
      action: `Administrator deleted client account ${removed.fullName}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator permanently deleted the client account of ${removed.fullName} (${removed.company}).`,
        account: `${removed.fullName} — ${removed.email}`,
      },
    })
  }

  const handleFaceReset = async () => {
    const u = faceResetTarget
    if (!u) return
    setFaceResetting(true)
    const res = await postUserAction("resetFace", { id: u.id })
    setFaceResetting(false)
    if (!res.ok) {
      toast.error(res.error || "Could not reset Face ID.")
      return
    }
    setFaceResetTarget(null)
    toast.success("Face ID reset", {
      description: `${u.fullName} can sign in with their password and enroll a new face.`,
    })
    logActivity({
      action: `Administrator reset Face ID for ${u.fullName}`,
      category: "Administration / User Management",
      details: {
        summary: `Administrator cleared the biometric (Face ID) enrollment for ${u.fullName} (${u.company}).`,
        account: `${u.fullName} — ${u.email}`,
      },
    })
  }

  const handleSignInAs = async (u: AdminUserView) => {
    setImpersonatingId(u.id)
    logActivity({
      action: `Administrator opened a maintenance session for ${u.fullName}`,
      category: "Administration / Security",
      details: {
        summary: `Administrator signed in as ${u.fullName} (${u.company}) to perform account maintenance.`,
        account: `${u.fullName} — ${u.email}`,
        status: u.status,
      },
    })
    // Impersonation runs through a Route Handler (NOT a Server Action): Server
    // Action POSTs are silently rejected on this app's production domains +
    // mobile in-app webviews, which left this button spinning forever. On
    // success the handler returns a redirect target; we hard-navigate so the
    // freshly-set session cookie takes effect.
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-passcode": ADMIN_PASSCODE },
        cache: "no-store",
        body: JSON.stringify({ passcode: ADMIN_PASSCODE, targetUserId: u.id }),
      })
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; redirect?: string }
        | null
      if (res.ok && data?.ok && data.redirect) {
        window.location.href = data.redirect
        return // keep the spinner until the navigation happens
      }
      toast.error(data?.error || "Could not start the maintenance session. Please try again.")
      setImpersonatingId(null)
    } catch {
      toast.error("Could not reach the server. Check your connection and try again.")
      setImpersonatingId(null)
    }
  }

  const copy = async (text: string, which: "email" | "password" | "both") => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error("Unable to copy to clipboard")
    }
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg font-semibold">User Management</CardTitle>
              <p className="text-sm text-muted-foreground text-pretty">
                Create client accounts, generate credentials, and control access. New accounts can
                sign in immediately and receive their own fully isolated environment.
              </p>
            </div>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            New client
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, company, or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
          </p>
        ) : loadError && users.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-foreground text-balance">{loadError}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => load()}>
                Try again
              </Button>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {users.length === 0
                ? "No client accounts have been created yet. Use “New client” to add one."
                : "No accounts match your search."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((u) => {
              const meta = STATUS_META[u.status]
              return (
                <div
                  key={u.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium text-foreground">{u.fullName}</p>
                      <Badge variant="outline" className={cn("text-[10px]", meta.className)}>
                        {meta.label}
                      </Badge>
                      {u.relationship !== "master" && (
                        <Badge
                          variant="outline"
                          className="border-primary/30 bg-primary/10 text-[10px] text-primary"
                        >
                          {relationshipCode(u.relationship)} · {relationshipLabel(u.relationship)}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">{u.company}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.email} · {u.role} · created {fmtDate(u.createdAt)}
                    </p>
                    {u.relationship !== "master" && u.masterName && (
                      <p className="truncate text-xs text-primary/80">
                        Linked to {u.masterName}
                        {u.relationship === "sub" ? " · shares balance & instruments" : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSignInAs(u)}
                      disabled={impersonatingId === u.id}
                      className="text-primary hover:text-primary"
                      title="Sign in as this client to perform maintenance"
                    >
                      {impersonatingId === u.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LogIn className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Sign in as
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openReset(u)}>
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Reset
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFaceResetTarget(u)}
                      className="text-primary hover:text-primary"
                    >
                      <ScanFace className="mr-1.5 h-3.5 w-3.5" /> Reset Face ID
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openEdit(u)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDocsTarget(u)}>
                      <FileText className="mr-1.5 h-3.5 w-3.5" /> Documents
                    </Button>
                    {u.status === "active" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatus(u, "suspended")}
                        className="text-amber-500 hover:text-amber-400"
                      >
                        <ShieldOff className="mr-1.5 h-3.5 w-3.5" /> Suspend
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatus(u, "active")}
                        className="text-green-500 hover:text-green-400"
                      >
                        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Activate
                      </Button>
                    )}
                    {u.status !== "inactive" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleStatus(u, "inactive")}
                        className="text-red-500 hover:text-red-400"
                      >
                        <Ban className="mr-1.5 h-3.5 w-3.5" /> Deactivate
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-400"
                      onClick={() => setDeleteTarget(u)}
                      aria-label={`Delete ${u.fullName}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a client account</DialogTitle>
            <DialogDescription>
              Leave the login email or password blank to auto-generate them. You can hand the
              generated credentials to the client afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 space-y-4 overflow-y-auto py-2 pr-1">
            {/* KYC PDF auto-fill */}
            <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Auto-fill from KYC document</p>
                  <p className="text-xs text-muted-foreground">
                    Upload a client&apos;s KYC PDF and we&apos;ll read the identity details and attach the
                    documents automatically.
                  </p>

                  <input
                    ref={kycInputRef}
                    type="file"
                    accept="application/pdf"
                    className="sr-only"
                    onChange={(e) => handleKycUpload(e.target.files?.[0] ?? null)}
                  />

                  {!kycResult ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={kycAnalyzing}
                      onClick={() => kycInputRef.current?.click()}
                    >
                      {kycAnalyzing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileUp className="mr-2 h-4 w-4" />
                      )}
                      {kycAnalyzing ? "Analysing document…" : "Upload KYC PDF"}
                    </Button>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-medium text-foreground">{kycFileName}</span>
                        </div>
                        <button
                          type="button"
                          className="text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => {
                            setKycResult(null)
                            setKycFileName("")
                            if (kycInputRef.current) kycInputRef.current.value = ""
                          }}
                          aria-label="Remove uploaded document"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      {kycResult.documents.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {kycResult.documents.map((doc) => (
                            <a
                              key={`${doc.type}-${doc.pageNumber}`}
                              href={`${blobFileUrl(doc.pathname)}#page=${doc.pageNumber}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 transition-colors hover:border-primary"
                            >
                              <FileText className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                              <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
                                {KYC_DOCUMENT_LABELS[doc.type]}
                                <span className="ml-1 text-muted-foreground/70">p.{doc.pageNumber}</span>
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Details below were pre-filled from the document. Review and edit before creating
                        the account.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="um-fullname">Full name</Label>
                <Input
                  id="um-fullname"
                  placeholder="e.g. Louis Thyssen"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="um-company">Company</Label>
                <Input
                  id="um-company"
                  placeholder="e.g. MCC Capital Group Inc."
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="um-role">Role / title</Label>
                <Input
                  id="um-role"
                  placeholder="e.g. Director & Authorised Signatory"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="um-badge">Account tier</Label>
                <Select value={accountBadge} onValueChange={setAccountBadge}>
                  <SelectTrigger id="um-badge" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRO Account">PRO Account</SelectItem>
                    <SelectItem value="Avant-garde Account">Avant-garde Account</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Referral hierarchy placement */}
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">Account hierarchy & linking</p>
                <p className="text-xs text-muted-foreground">
                  To link this client under a Master account, set the type to Sub or Child and choose the
                  Master below. Leave as Master / Standalone for an independent account.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="um-relationship">Account type</Label>
                <Select value={relationship} onValueChange={(v) => setRelationship(v as AccountRelationship)}>
                  <SelectTrigger id="um-relationship" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELATIONSHIP_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {RELATIONSHIP_OPTIONS.find((o) => o.value === relationship)?.description}
                </p>
              </div>
              {relationship !== "master" && (
                <div className="space-y-2">
                  <Label htmlFor="um-master">Master account</Label>
                  <Select value={masterId} onValueChange={setMasterId}>
                    <SelectTrigger id="um-master" className="w-full">
                      <SelectValue placeholder="Select a Master account" />
                    </SelectTrigger>
                    <SelectContent>
                      {masters.length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          No Master accounts available
                        </SelectItem>
                      ) : (
                        masters.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.fullName} {m.company ? `— ${m.company}` : ""}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {relationship === "sub"
                      ? "Shares this Master's balance and bank instruments."
                      : "Linked to this Master for referral attribution only."}
                  </p>
                </div>
              )}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="um-email">Login email (optional)</Label>
                <Input
                  id="um-email"
                  placeholder="Auto-generated if blank"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="um-password">Temporary password (optional)</Label>
                <Input
                  id="um-password"
                  placeholder="Auto-generated if blank"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="um-phone">Phone (optional)</Label>
                <Input id="um-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="um-nat">Nationality (optional)</Label>
                <CountryCombobox
                  id="um-nat"
                  valueMode="name"
                  value={nationality}
                  onChange={setNationality}
                  placeholder="Search and select country"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="um-address">Address (optional)</Label>
              <Input id="um-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="um-website">Website (optional)</Label>
              <Input id="um-website" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="mt-2 border-t border-border pt-4">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              Create account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit client account</DialogTitle>
            <DialogDescription>Update the displayed identity and login email.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ue-fullname">Full name</Label>
                <Input
                  id="ue-fullname"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ue-company">Company</Label>
                <Input
                  id="ue-company"
                  value={editCompany}
                  onChange={(e) => setEditCompany(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ue-role">Role / title</Label>
                <Input id="ue-role" value={editRole} onChange={(e) => setEditRole(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ue-badge">Account tier</Label>
                <Select value={editBadge} onValueChange={setEditBadge}>
                  <SelectTrigger id="ue-badge" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRO Account">PRO Account</SelectItem>
                    <SelectItem value="Avant-garde Account">Avant-garde Account</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ue-email">Login email</Label>
              <Input id="ue-email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
            </div>
            {/* Referral hierarchy placement */}
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">Account hierarchy & linking</p>
                <p className="text-xs text-muted-foreground">
                  Set the type to Sub or Child and choose a Master to link this account, or Master /
                  Standalone to keep it independent.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ue-relationship">Account type</Label>
                <Select
                  value={editRelationship}
                  onValueChange={(v) => setEditRelationship(v as AccountRelationship)}
                >
                  <SelectTrigger id="ue-relationship" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELATIONSHIP_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editRelationship !== "master" && (
                <div className="space-y-2">
                  <Label htmlFor="ue-master">Master account</Label>
                  <Select value={editMasterId} onValueChange={setEditMasterId}>
                    <SelectTrigger id="ue-master" className="w-full">
                      <SelectValue placeholder="Select a Master account" />
                    </SelectTrigger>
                    <SelectContent>
                      {masters.filter((m) => m.id !== editTarget?.id).length === 0 ? (
                        <SelectItem value="__none__" disabled>
                          No Master accounts available
                        </SelectItem>
                      ) : (
                        masters
                          .filter((m) => m.id !== editTarget?.id)
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.fullName} {m.company ? `— ${m.company}` : ""}
                            </SelectItem>
                          ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for{" "}
              <span className="font-medium text-foreground">{resetTarget?.fullName}</span> (
              {resetTarget?.email}). Type the exact password you want to assign, or leave it blank to
              auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              type="text"
              autoComplete="off"
              inputMode="text"
              placeholder="Leave blank to auto-generate"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="font-mono text-base"
            />
            <p className="text-xs text-muted-foreground">
              Minimum 6 characters. The client will use this password to sign in immediately.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleReset} disabled={resetting}>
              {resetting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="mr-2 h-4 w-4" />
              )}
              {resetPassword.trim() ? "Set password" : "Generate password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credential reveal dialog */}
      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{reveal?.title}</DialogTitle>
            <DialogDescription>
              Share these credentials with the client securely. The password is shown only here —
              you can always generate a new one with “Reset”.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Login email</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={reveal?.email ?? ""} className="font-mono text-sm" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => reveal && copy(reveal.email, "email")}
                  aria-label="Copy email"
                >
                  {copied === "email" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Temporary password</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={reveal?.password ?? ""} className="font-mono text-sm" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => reveal && copy(reveal.password, "password")}
                  aria-label="Copy password"
                >
                  {copied === "password" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                reveal && copy(`Email: ${reveal.email}\nPassword: ${reveal.password}`, "both")
              }
            >
              {copied === "both" ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              Copy both
            </Button>
            <Button onClick={() => setReveal(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Face ID reset confirm dialog */}
      <Dialog open={!!faceResetTarget} onOpenChange={(o) => !o && setFaceResetTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Face ID?</DialogTitle>
            <DialogDescription>
              This clears the biometric (Face ID) enrollment for{" "}
              <span className="font-medium text-foreground">{faceResetTarget?.fullName}</span> (
              {faceResetTarget?.email}). Use this when a client is locked out of face login. They will
              sign in with their password only and can enroll a new face afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFaceResetTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleFaceReset} disabled={faceResetting}>
              {faceResetting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ScanFace className="mr-2 h-4 w-4" />
              )}
              Reset Face ID
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      {/* KYC documents dialog */}
      <Dialog open={!!docsTarget} onOpenChange={(o) => !o && setDocsTarget(null)}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>KYC documents</DialogTitle>
            <DialogDescription>
              View, upload and remove identity &amp; compliance documents for {docsTarget?.fullName || "this client"}.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex-1 overflow-y-auto pr-1">
            {docsTarget ? (
              <KycDocumentManager userId={docsTarget.id} account={docsTarget.fullName || docsTarget.email} />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete client account?</DialogTitle>
            <DialogDescription>
              This permanently removes{" "}
              <span className="font-medium text-foreground">{deleteTarget?.fullName}</span> (
              {deleteTarget?.email}). They will no longer be able to sign in. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
