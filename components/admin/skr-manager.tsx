"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ShieldCheck,
  Plus,
  Pencil,
  Trash2,
  ArrowRightLeft,
  FileText,
  Paperclip,
  History,
  Download,
  Check,
  X,
  Clock,
  Loader2,
  Landmark,
  Wallet,
  RotateCcw,
  Upload,
  Award,
  ClipboardCheck,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { useActivityLog } from "@/components/activity-tracker"
import { exportToCsv } from "@/lib/export-utils"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"

// Neutral fallback used for labels before the client list has loaded or when an
// id no longer resolves to an account. Never a real account.
const FALLBACK_CLIENT: SelectableClient = { id: "", fullName: "—", company: "—", email: "", kind: "dynamic" }
import {
  generateSkrId,
  generateSkrRef,
  formatSkrValue,
  SKR_STATUS_LABELS,
  type SkrRecord,
  type SkrStatus,
  type SkrRequest,
  type SkrDocument,
} from "@/lib/skr-store"
import {
  adminListSkrRecords,
  adminReplaceSkrRecords,
  adminListSkrRequests,
  adminReplaceSkrRequests,
  adminSetSkrExpertise,
  adminListSkrExpertiseQueue,
  adminListSkrRequestQueue,
} from "@/app/actions/skr"
import type { SkrExpertiseQueueItem, SkrRequestQueueItem } from "@/lib/skr-db"
import {
  SKR_EXPERTISE_STATUS_LABELS,
  type SkrExpertiseStatus,
} from "@/lib/skr-expertise"
import { creditSkrCollateralAdmin, reverseSkrCollateralAdmin } from "@/app/actions/treasury"
import { upload } from "@vercel/blob/client"
import { blobFileUrl } from "@/lib/kyc-types"
import { downloadFile } from "@/lib/download-file"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { generateSkrCertificate } from "@/lib/certificate-pdf"

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "AED", "SGD"]
const STATUSES: SkrStatus[] = ["active", "pending", "matured", "transferred", "suspended", "cancelled"]

const statusStyles: Record<SkrStatus, string> = {
  active: "border-green-500/20 bg-green-500/10 text-green-500",
  pending: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  matured: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  transferred: "border-primary/20 bg-primary/10 text-primary",
  suspended: "border-orange-500/20 bg-orange-500/10 text-orange-400",
  cancelled: "border-muted bg-muted text-muted-foreground",
}

const expertiseBadgeStyles: Record<SkrExpertiseStatus, string> = {
  requested: "border-yellow-500/20 bg-yellow-500/10 text-yellow-500",
  assessed: "border-blue-500/20 bg-blue-500/10 text-blue-400",
  accepted: "border-green-500/20 bg-green-500/10 text-green-500",
  declined: "border-muted bg-muted text-muted-foreground",
  released: "border-muted bg-muted text-muted-foreground",
}

const todayISO = () => new Date().toISOString().slice(0, 10)
const nowISO = () => new Date().toISOString()
const fmtDate = (iso?: string) => {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB")
}

interface RecordForm {
  custodian: string
  beneficialOwner: string
  faceValue: string
  currency: string
  issueDate: string
  expiryDate: string
  custodyAccountRef: string
  status: SkrStatus
  assetDescription: string
  notes: string
}

const emptyForm = (ownerName = ""): RecordForm => ({
  custodian: "",
  beneficialOwner: ownerName,
  faceValue: "",
  currency: "USD",
  issueDate: todayISO(),
  expiryDate: "",
  custodyAccountRef: "",
  status: "active",
  assetDescription: "",
  notes: "",
})

export function SkrManager() {
  const logActivity = useActivityLog()
  const pdfViewer = usePdfViewer()

  const [clients, setClients] = useState<SelectableClient[]>([])
  const [targetUserId, setTargetUserId] = useState("")
  const [records, setRecords] = useState<SkrRecord[]>([])
  const [requests, setRequests] = useState<SkrRequest[]>([])
  const [loading, setLoading] = useState(false)

  // Create / edit dialog
  const [formOpen, setFormOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<RecordForm>(emptyForm())

  // Transaction / document / transfer dialogs
  const [txTarget, setTxTarget] = useState<SkrRecord | null>(null)
  const [txType, setTxType] = useState("Custody Update")
  const [txDescription, setTxDescription] = useState("")
  const [docTarget, setDocTarget] = useState<SkrRecord | null>(null)
  const [docName, setDocName] = useState("")
  const [docType, setDocType] = useState("SKR Certificate")
  // File chosen for upload in the document dialog, plus in-flight upload state.
  const [docFile, setDocFile] = useState<File | null>(null)
  const [docUploading, setDocUploading] = useState(false)
  const [transferTarget, setTransferTarget] = useState<SkrRecord | null>(null)
  const [transferToUserId, setTransferToUserId] = useState("")

  // Treasury credit dialog: pledge an SKR's value into the client's treasury
  // balance for trading. The amount is editable (defaulting to face value) so
  // the desk can enter the EUR-equivalent when the SKR is in another currency.
  const [creditTarget, setCreditTarget] = useState<SkrRecord | null>(null)
  const [creditAmount, setCreditAmount] = useState("")
  const [creditBusy, setCreditBusy] = useState(false)

  // Expertise / evaluation / audit valuation dialog
  const [expTarget, setExpTarget] = useState<SkrRecord | null>(null)
  const [expValue, setExpValue] = useState("")
  const [expCurrency, setExpCurrency] = useState("USD")
  const [expOutcome, setExpOutcome] = useState("")
  const [expBusy, setExpBusy] = useState(false)
  const [expResult, setExpResult] = useState<{ cost: number; tradeScore: number; currency: string } | null>(null)

  // Cross-client queue of expertise applications awaiting valuation — so the
  // admin arriving from the "SKR expertise requested" notification can jump
  // straight to the client that needs action (the desk is per-client).
  const [expertiseQueue, setExpertiseQueue] = useState<SkrExpertiseQueueItem[]>([])
  const loadExpertiseQueue = useCallback(() => {
    void adminListSkrExpertiseQueue(ADMIN_PASSCODE).then((res) => {
      if (res.ok) setExpertiseQueue(res.items)
    })
  }, [])

  // Cross-client queue of generic SKR service requests (Statement / Transfer /
  // etc.) awaiting action — so the admin arriving from the "SKR request"
  // notification can jump straight to the client that needs action.
  const [requestQueue, setRequestQueue] = useState<SkrRequestQueueItem[]>([])
  const loadRequestQueue = useCallback(() => {
    void adminListSkrRequestQueue(ADMIN_PASSCODE).then((res) => {
      if (res.ok) setRequestQueue(res.items)
    })
  }, [])

  const targetUser = clients.find((c) => c.id === targetUserId) ?? FALLBACK_CLIENT

  useEffect(() => {
    let active = true
    listSelectableClients(ADMIN_PASSCODE)
      .then((list) => {
        if (!active || !list.length) return
        setClients(list)
        // Default to the first client once the list loads.
        setTargetUserId((cur) => cur || list[0].id)
      })
      .catch(() => {})
    loadExpertiseQueue()
    loadRequestQueue()
    return () => {
      active = false
    }
  }, [loadExpertiseQueue, loadRequestQueue])

  // Load the selected client's SKR data from the server (durable, cross-device).
  const reload = (userId: string) => {
    if (!userId) {
      setRecords([])
      setRequests([])
      return
    }
    setLoading(true)
    Promise.all([
      adminListSkrRecords(ADMIN_PASSCODE, userId),
      adminListSkrRequests(ADMIN_PASSCODE, userId),
    ])
      .then(([rec, req]) => {
        // Ignore a stale response if the admin switched clients meanwhile.
        if (userId !== targetUserId) return
        if (rec.ok) setRecords(rec.items.map((r) => r.data as unknown as SkrRecord))
        else toast.error("Could not load SKR records", { description: rec.error })
        if (req.ok) setRequests(req.items.map((r) => r.data as unknown as SkrRequest))
      })
      .catch((err) => toast.error("Could not load SKR data", { description: (err as Error).message }))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload(targetUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId])

  const toRecordItems = (list: SkrRecord[]) =>
    list.map((r) => ({ id: r.id, data: r as unknown as Record<string, unknown>, status: r.status }))
  const toRequestItems = (list: SkrRequest[]) =>
    list.map((r) => ({ id: r.id, data: r as unknown as Record<string, unknown>, status: r.status }))

  // Records are administrator-owned: write the authoritative full set to the
  // client's server namespace, then reflect locally if it's the active view.
  const persistRecords = (userId: string, next: SkrRecord[]) => {
    if (userId === targetUserId) setRecords(next)
    void adminReplaceSkrRecords(ADMIN_PASSCODE, userId, toRecordItems(next)).then((res) => {
      if (!res.ok) toast.error("Could not save to the server", { description: res.error })
    })
  }
  const persistRequests = (next: SkrRequest[]) => {
    setRequests(next)
    void adminReplaceSkrRequests(ADMIN_PASSCODE, targetUserId, toRequestItems(next)).then((res) => {
      if (!res.ok) toast.error("Could not save to the server", { description: res.error })
    })
  }

  const totalByCurrency = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of records) map.set(r.currency, (map.get(r.currency) ?? 0) + r.faceValue)
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [records])

  // --- Create / Edit ---------------------------------------------------------

  const openCreate = () => {
    setEditId(null)
    setForm(emptyForm(targetUser.fullName))
    setFormOpen(true)
  }

  const openDoc = (record: SkrRecord) => {
    setDocName("")
    setDocType("SKR Certificate")
    setDocFile(null)
    setDocTarget(record)
  }

  const openEdit = (record: SkrRecord) => {
    setEditId(record.id)
    setForm({
      custodian: record.custodian,
      beneficialOwner: record.beneficialOwner,
      faceValue: String(record.faceValue),
      currency: record.currency,
      issueDate: record.issueDate?.slice(0, 10) || todayISO(),
      expiryDate: record.expiryDate?.slice(0, 10) || "",
      custodyAccountRef: record.custodyAccountRef,
      status: record.status,
      assetDescription: record.assetDescription ?? "",
      notes: record.notes ?? "",
    })
    setFormOpen(true)
  }

  const saveForm = () => {
    const faceValue = Number(form.faceValue)
    if (!form.custodian.trim()) {
      toast.error("Enter the issuing bank or custodian.")
      return
    }
    if (!form.beneficialOwner.trim()) {
      toast.error("Enter the beneficial owner.")
      return
    }
    if (!Number.isFinite(faceValue) || faceValue <= 0) {
      toast.error("Enter a valid face value greater than zero.")
      return
    }

    if (editId) {
      const next = records.map((r) =>
        r.id === editId
          ? {
              ...r,
              custodian: form.custodian.trim(),
              beneficialOwner: form.beneficialOwner.trim(),
              faceValue,
              currency: form.currency,
              issueDate: form.issueDate,
              expiryDate: form.expiryDate || undefined,
              custodyAccountRef: form.custodyAccountRef.trim() || r.custodyAccountRef,
              status: form.status,
              assetDescription: form.assetDescription.trim() || undefined,
              notes: form.notes.trim() || undefined,
              updatedAt: nowISO(),
              transactions: [
                {
                  id: generateSkrRef("TX"),
                  date: nowISO(),
                  type: "Record Updated",
                  description: `Administrator updated instrument details. Status: ${SKR_STATUS_LABELS[form.status]}.`,
                  reference: generateSkrRef("ADM"),
                },
                ...r.transactions,
              ],
            }
          : r,
      )
      persistRecords(targetUserId, next)
      toast.success("SKR record updated", { description: `${editId} has been updated.` })
      logActivity({
        action: `Administrator updated SKR ${editId} for ${targetUser.fullName}`,
        category: "Administration",
        details: {
          summary: `Administrator updated safe keeping receipt ${editId} on the account of ${targetUser.fullName} (${targetUser.company}). Face value ${formatSkrValue(faceValue, form.currency)}, status ${SKR_STATUS_LABELS[form.status]}.`,
          referenceId: editId,
          targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
          custodian: form.custodian.trim(),
          faceValue: formatSkrValue(faceValue, form.currency),
          status: SKR_STATUS_LABELS[form.status],
        },
      })
    } else {
      const id = generateSkrId()
      const custodyRef = form.custodyAccountRef.trim() || generateSkrRef("CUST")
      const record: SkrRecord = {
        id,
        custodian: form.custodian.trim(),
        beneficialOwner: form.beneficialOwner.trim(),
        faceValue,
        currency: form.currency,
        issueDate: form.issueDate,
        expiryDate: form.expiryDate || undefined,
        custodyAccountRef: custodyRef,
        status: form.status,
        assetDescription: form.assetDescription.trim() || undefined,
        notes: form.notes.trim() || undefined,
        documents: [],
        transactions: [
          {
            id: generateSkrRef("TX"),
            date: nowISO(),
            type: "Issuance",
            description: `SKR created and assigned to ${targetUser.fullName} by administrator. Custodian: ${form.custodian.trim()}.`,
            reference: generateSkrRef("ADM"),
          },
        ],
        assignedUserId: targetUserId,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      }
      persistRecords(targetUserId, [record, ...records])
      toast.success("SKR record created", {
        description: `${id} assigned to ${targetUser.fullName}.`,
      })
      logActivity({
        action: `Administrator created SKR ${id} for ${targetUser.fullName}`,
        category: "Administration",
        details: {
          summary: `Administrator created and assigned safe keeping receipt ${id} to the account of ${targetUser.fullName} (${targetUser.company}). Issuing bank/custodian ${form.custodian.trim()}, face value ${formatSkrValue(faceValue, form.currency)}, custody account ${custodyRef}, status ${SKR_STATUS_LABELS[form.status]}.`,
          referenceId: id,
          targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
          custodian: form.custodian.trim(),
          beneficialOwner: form.beneficialOwner.trim(),
          faceValue: formatSkrValue(faceValue, form.currency),
          custodyAccountRef: custodyRef,
          status: SKR_STATUS_LABELS[form.status],
        },
      })
    }
    setFormOpen(false)
  }

  const deleteRecord = async (record: SkrRecord) => {
    // If this receipt's value was credited to the treasury, reverse it first so
    // the client's trading balance never references a deleted instrument.
    if (record.creditedToTreasury) {
      const res = await reverseSkrCollateralAdmin(ADMIN_PASSCODE, targetUserId, { skrId: record.id })
      if (!res.ok) {
        toast.error("Could not reverse the treasury credit", { description: res.error })
        return
      }
    }
    const next = records.filter((r) => r.id !== record.id)
    persistRecords(targetUserId, next)
    toast.success("SKR record deleted", { description: `${record.id} has been removed.` })
    logActivity({
      action: `Administrator deleted SKR ${record.id} from ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator permanently deleted safe keeping receipt ${record.id} (${formatSkrValue(record.faceValue, record.currency)}, ${record.custodian}) from the account of ${targetUser.fullName} (${targetUser.company}).`,
        referenceId: record.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: "Deleted",
      },
    })
  }

  // --- Credit SKR value to the client's treasury balance ---------------------

  const openCredit = (record: SkrRecord) => {
    setCreditTarget(record)
    setCreditAmount(String(record.treasuryCreditAmount ?? record.faceValue))
  }

  const submitCredit = async () => {
    if (!creditTarget) return
    const amount = Number(creditAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid EUR amount to credit.")
      return
    }
    setCreditBusy(true)
    const res = await creditSkrCollateralAdmin(ADMIN_PASSCODE, targetUserId, {
      skrId: creditTarget.id,
      amount,
      currency: creditTarget.currency,
    })
    setCreditBusy(false)
    if (!res.ok) {
      toast.error("Could not credit to treasury", { description: res.error })
      return
    }
    const next = records.map((r) =>
      r.id === creditTarget.id
        ? {
            ...r,
            creditedToTreasury: true,
            treasuryCreditAmount: amount,
            treasuryCreditedAt: nowISO(),
            updatedAt: nowISO(),
            transactions: [
              {
                id: generateSkrRef("TX"),
                date: nowISO(),
                type: "Treasury Credit",
                description: `Value of EUR ${amount.toLocaleString("en-US")} credited to the client's treasury balance for trading uses by administrator.`,
                reference: generateSkrRef("TRY"),
              },
              ...r.transactions,
            ],
          }
        : r,
    )
    persistRecords(targetUserId, next)
    toast.success("Credited to treasury", {
      description: `EUR ${amount.toLocaleString("en-US")} added to ${targetUser.fullName}'s trading balance.`,
    })
    logActivity({
      action: `Administrator credited SKR ${creditTarget.id} to treasury for ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator credited the value of safe keeping receipt ${creditTarget.id} (EUR ${amount.toLocaleString("en-US")}) to the treasury balance of ${targetUser.fullName} (${targetUser.company}) for trading uses.`,
        referenceId: creditTarget.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        creditedValue: `EUR ${amount.toLocaleString("en-US")}`,
      },
    })
    setCreditTarget(null)
    setCreditAmount("")
  }

  const reverseCredit = async (record: SkrRecord) => {
    const res = await reverseSkrCollateralAdmin(ADMIN_PASSCODE, targetUserId, { skrId: record.id })
    if (!res.ok) {
      toast.error("Could not reverse the treasury credit", { description: res.error })
      return
    }
    const next = records.map((r) =>
      r.id === record.id
        ? {
            ...r,
            creditedToTreasury: false,
            treasuryCreditAmount: undefined,
            treasuryCreditedAt: undefined,
            updatedAt: nowISO(),
            transactions: [
              {
                id: generateSkrRef("TX"),
                date: nowISO(),
                type: "Treasury Credit Reversed",
                description: `Treasury credit reversed by administrator; value removed from the client's trading balance.`,
                reference: generateSkrRef("TRY"),
              },
              ...r.transactions,
            ],
          }
        : r,
    )
    persistRecords(targetUserId, next)
    toast.success("Treasury credit reversed", {
      description: `${record.id} value removed from ${targetUser.fullName}'s trading balance.`,
    })
    logActivity({
      action: `Administrator reversed the treasury credit for SKR ${record.id} (${targetUser.fullName})`,
      category: "Administration",
      details: {
        summary: `Administrator reversed the treasury credit of safe keeping receipt ${record.id} on the account of ${targetUser.fullName} (${targetUser.company}).`,
        referenceId: record.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: "Reversed",
      },
    })
  }

  // --- Expertise / evaluation / audit valuation ------------------------------

  const openExpertise = (record: SkrRecord) => {
    setExpTarget(record)
    setExpValue(String(record.expertise?.assessedValue ?? record.faceValue ?? ""))
    setExpCurrency(record.expertise?.assessedCurrency ?? record.currency)
    setExpOutcome(record.expertise?.outcomeNote ?? "")
    setExpResult(null)
  }

  const submitExpertise = async () => {
    if (!expTarget) return
    const assessedValue = Number(expValue)
    if (!Number.isFinite(assessedValue) || assessedValue <= 0) {
      toast.error("Enter a valid assessed value greater than zero.")
      return
    }
    if (!expOutcome.trim()) {
      toast.error("Enter the expertise outcome / findings.")
      return
    }
    setExpBusy(true)
    const res = await adminSetSkrExpertise(ADMIN_PASSCODE, targetUserId, expTarget.id, {
      assessedValue,
      assessedCurrency: expCurrency,
      outcomeNote: expOutcome.trim(),
    })
    setExpBusy(false)
    if (!res.ok) {
      toast.error("Could not return the valuation", { description: res.error })
      return
    }
    setExpResult({ cost: res.cost, tradeScore: res.tradeScore, currency: res.currency })
    toast.success("Valuation returned to the client", {
      description: `Service cost ${formatSkrValue(res.cost, res.currency)} (trade score ${res.tradeScore.toFixed(2)}). The client can now accept to unlock it as collateral.`,
    })
    reload(targetUserId)
    loadExpertiseQueue()
  }

  // --- Status quick-change ---------------------------------------------------

  const changeStatus = (record: SkrRecord, status: SkrStatus) => {
    if (status === record.status) return
    const next = records.map((r) =>
      r.id === record.id
        ? {
            ...r,
            status,
            updatedAt: nowISO(),
            transactions: [
              {
                id: generateSkrRef("TX"),
                date: nowISO(),
                type: "Status Update",
                description: `Status changed from ${SKR_STATUS_LABELS[r.status]} to ${SKR_STATUS_LABELS[status]} by administrator.`,
                reference: generateSkrRef("ADM"),
              },
              ...r.transactions,
            ],
          }
        : r,
    )
    persistRecords(targetUserId, next)
    toast.success("Status updated", {
      description: `${record.id} is now ${SKR_STATUS_LABELS[status]}.`,
    })
    logActivity({
      action: `Administrator set SKR ${record.id} to ${SKR_STATUS_LABELS[status]}`,
      category: "Administration",
      details: {
        summary: `Administrator changed the status of safe keeping receipt ${record.id} (${targetUser.fullName}) from ${SKR_STATUS_LABELS[record.status]} to ${SKR_STATUS_LABELS[status]}.`,
        referenceId: record.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        previousStatus: SKR_STATUS_LABELS[record.status],
        newStatus: SKR_STATUS_LABELS[status],
      },
    })
  }

  // --- Add transaction -------------------------------------------------------

  const submitTransaction = () => {
    if (!txTarget) return
    if (!txDescription.trim()) {
      toast.error("Enter a transaction description.")
      return
    }
    const ref = generateSkrRef("TX")
    const next = records.map((r) =>
      r.id === txTarget.id
        ? {
            ...r,
            updatedAt: nowISO(),
            transactions: [
              {
                id: ref,
                date: nowISO(),
                type: txType,
                description: txDescription.trim(),
                reference: generateSkrRef("REF"),
              },
              ...r.transactions,
            ],
          }
        : r,
    )
    persistRecords(targetUserId, next)
    toast.success("Transaction recorded", { description: `Added to ${txTarget.id}.` })
    logActivity({
      action: `Administrator added a ${txType} transaction to SKR ${txTarget.id}`,
      category: "Administration",
      details: {
        summary: `Administrator recorded a "${txType}" transaction on safe keeping receipt ${txTarget.id} (${targetUser.fullName}): ${txDescription.trim()}`,
        referenceId: txTarget.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        transactionType: txType,
      },
    })
    setTxTarget(null)
    setTxDescription("")
    setTxType("Custody Update")
  }

  // --- Add document ----------------------------------------------------------

  const submitDocument = async () => {
    if (!docTarget) return
    const fallbackName = docFile?.name ?? ""
    const finalName = docName.trim() || fallbackName.trim()
    if (!finalName) {
      toast.error("Enter a document name or choose a file.")
      return
    }

    // Upload the chosen picture/document to private Blob storage first; the
    // record only stores the resulting pathname (served via the gated proxy).
    let uploaded: { pathname: string; url: string; size: number; contentType: string } | null = null
    if (docFile) {
      setDocUploading(true)
      try {
        const safe = docFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")
        const result = await upload(`skr/${docTarget.id}/${Date.now()}-${safe}`, docFile, {
          access: "public",
          handleUploadUrl: "/api/skr/blob-upload",
          clientPayload: JSON.stringify({ passcode: ADMIN_PASSCODE }),
        })
        uploaded = {
          pathname: result.pathname,
          url: result.url,
          size: docFile.size,
          contentType: docFile.type || "application/octet-stream",
        }
      } catch (err) {
        setDocUploading(false)
        toast.error("Upload failed", { description: (err as Error).message })
        return
      }
      setDocUploading(false)
    }

    const newDoc: SkrDocument = {
      id: generateSkrRef("DOC"),
      name: finalName,
      docType,
      uploadedAt: nowISO(),
      ...(uploaded
        ? { pathname: uploaded.pathname, url: uploaded.url, size: uploaded.size, contentType: uploaded.contentType }
        : {}),
    }

    const next = records.map((r) =>
      r.id === docTarget.id
        ? {
            ...r,
            updatedAt: nowISO(),
            documents: [...r.documents, newDoc],
            transactions: [
              {
                id: generateSkrRef("TX"),
                date: nowISO(),
                type: "Document Added",
                description: `Supporting document "${finalName}" (${docType})${uploaded ? " uploaded" : " recorded"} by administrator.`,
                reference: generateSkrRef("ADM"),
              },
              ...r.transactions,
            ],
          }
        : r,
    )
    persistRecords(targetUserId, next)
    toast.success("Document attached", { description: `${finalName} added to ${docTarget.id}.` })
    logActivity({
      action: `Administrator attached document to SKR ${docTarget.id}`,
      category: "Administration",
      details: {
        summary: `Administrator attached supporting document "${finalName}" (${docType}) to safe keeping receipt ${docTarget.id} (${targetUser.fullName}).`,
        referenceId: docTarget.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        document: finalName,
        documentType: docType,
      },
    })
    setDocTarget(null)
    setDocName("")
    setDocType("SKR Certificate")
    setDocFile(null)
  }

  // --- Generate the SKR certificate (declares the asset held in custody) -----

  const generateCertificate = (record: SkrRecord) => {
    const generated = generateSkrCertificate({
      reference: record.id,
      custodian: record.custodian,
      beneficialOwner: record.beneficialOwner,
      ownerCompany: targetUser.company,
      faceValue: formatSkrValue(record.faceValue, record.currency),
      currency: record.currency,
      status: SKR_STATUS_LABELS[record.status],
      issueDate: record.issueDate,
      expiryDate: record.expiryDate,
      custodyAccountRef: record.custodyAccountRef,
      assetDescription: record.assetDescription,
      verificationCode: generateSkrRef("VRF"),
    })
    pdfViewer.show(generated)
    logActivity({
      action: `Administrator generated the SKR certificate for ${record.id}`,
      category: "Administration",
      details: {
        summary: `Administrator generated the safe keeping receipt certificate for ${record.id}, declaring custody of an asset worth ${formatSkrValue(record.faceValue, record.currency)} owned by ${record.beneficialOwner}.`,
        referenceId: record.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        declaredValue: formatSkrValue(record.faceValue, record.currency),
        beneficialOwner: record.beneficialOwner,
      },
    })
  }

  // --- Transfer between internal accounts ------------------------------------

  const submitTransfer = async () => {
    if (!transferTarget) return
    if (!transferToUserId || transferToUserId === targetUserId) {
      toast.error("Select a different destination account.")
      return
    }
    const destUser = clients.find((c) => c.id === transferToUserId) ?? FALLBACK_CLIENT

    // Fetch the destination owner's current portfolio from the server first, so
    // the transfer is atomic from the admin's perspective and never clobbers the
    // destination's existing receipts.
    const destRes = await adminListSkrRecords(ADMIN_PASSCODE, transferToUserId)
    if (!destRes.ok) {
      toast.error("Could not reach the destination account", { description: destRes.error })
      return
    }
    const destRecords = destRes.items.map((r) => r.data as unknown as SkrRecord)

    // Remove from current owner.
    const remaining = records.filter((r) => r.id !== transferTarget.id)
    persistRecords(targetUserId, remaining)

    // Append to destination owner's namespace with a transfer transaction.
    const moved: SkrRecord = {
      ...transferTarget,
      assignedUserId: transferToUserId,
      beneficialOwner: destUser.fullName,
      status: "active",
      updatedAt: nowISO(),
      transactions: [
        {
          id: generateSkrRef("TX"),
          date: nowISO(),
          type: "Transfer",
          description: `Transferred from ${targetUser.fullName} to ${destUser.fullName} by administrator.`,
          reference: generateSkrRef("TRF"),
        },
        ...transferTarget.transactions,
      ],
    }
    const destSave = await adminReplaceSkrRecords(
      ADMIN_PASSCODE,
      transferToUserId,
      toRecordItems([moved, ...destRecords]),
    )
    if (!destSave.ok) {
      toast.error("Transfer could not be completed", { description: destSave.error })
      // Roll the receipt back onto the source so nothing is lost.
      persistRecords(targetUserId, records)
      return
    }

    toast.success("SKR transferred", {
      description: `${transferTarget.id} moved to ${destUser.fullName}.`,
    })
    logActivity({
      action: `Administrator transferred SKR ${transferTarget.id} to ${destUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator transferred safe keeping receipt ${transferTarget.id} (${formatSkrValue(transferTarget.faceValue, transferTarget.currency)}) from ${targetUser.fullName} (${targetUser.company}) to ${destUser.fullName} (${destUser.company}).`,
        referenceId: transferTarget.id,
        from: `${targetUser.fullName} — ${targetUser.email}`,
        to: `${destUser.fullName} — ${destUser.email}`,
        faceValue: formatSkrValue(transferTarget.faceValue, transferTarget.currency),
      },
    })
    setTransferTarget(null)
    setTransferToUserId("")
  }

  // --- Client requests -------------------------------------------------------

  const decideRequest = (req: SkrRequest, status: "approved" | "rejected") => {
    const next = requests.map((r) =>
      r.id === req.id
        ? {
            ...r,
            status,
            decidedAt: nowISO(),
            decisionNote:
              status === "approved"
                ? "Actioned by the custody desk."
                : "Declined by the custody desk.",
          }
        : r,
    )
    persistRequests(next)
    loadRequestQueue()
    toast.success(`Request ${status}`, { description: `${req.type} request ${req.id} ${status}.` })
    logActivity({
      action: `Administrator ${status} SKR ${req.type} request ${req.id}`,
      category: "Administration",
      details: {
        summary: `Administrator ${status} the ${req.type} request ${req.id} from ${targetUser.fullName}${req.recordId ? ` concerning ${req.recordId}` : ""}. Message: ${req.message}`,
        referenceId: req.id,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        decision: status === "approved" ? "Approved" : "Rejected",
      },
    })
  }

  // --- Reports / audit -------------------------------------------------------

  const exportReport = () => {
    if (records.length === 0) {
      toast.error("No records to export for this client.")
      return
    }
    exportToCsv(
      `SKR-Report-${targetUser.fullName.replace(/\s+/g, "-")}`,
      records.map((r) => ({
        reference: r.id,
        custodian: r.custodian,
        beneficialOwner: r.beneficialOwner,
        faceValue: r.faceValue,
        currency: r.currency,
        issueDate: fmtDate(r.issueDate),
        expiryDate: fmtDate(r.expiryDate),
        custodyAccountRef: r.custodyAccountRef,
        status: SKR_STATUS_LABELS[r.status],
        transactions: r.transactions.length,
        documents: r.documents.length,
      })),
      [
        { key: "reference", label: "SKR Reference" },
        { key: "custodian", label: "Issuing Bank / Custodian" },
        { key: "beneficialOwner", label: "Beneficial Owner" },
        { key: "faceValue", label: "Face Value" },
        { key: "currency", label: "Currency" },
        { key: "issueDate", label: "Issue Date" },
        { key: "expiryDate", label: "Expiry Date" },
        { key: "custodyAccountRef", label: "Custody Account Ref" },
        { key: "status", label: "Status" },
        { key: "transactions", label: "Transactions" },
        { key: "documents", label: "Documents" },
      ],
    )
    toast.success("Report generated", {
      description: `SKR portfolio report for ${targetUser.fullName} exported.`,
    })
    logActivity({
      action: `Administrator generated an SKR portfolio report for ${targetUser.fullName}`,
      category: "Administration",
      details: {
        summary: `Administrator generated and exported the SKR portfolio report (${records.length} records) for ${targetUser.fullName} (${targetUser.company}).`,
        targetAccount: `${targetUser.fullName} — ${targetUser.email}`,
        recordCount: String(records.length),
      },
    })
  }

  const pendingRequests = requests.filter((r) => r.status === "pending")

  return (
    <Card id="section-skr" className="bg-card border-border">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg font-semibold">SKR Trading Platform</CardTitle>
              <p className="text-sm text-muted-foreground text-pretty">
                Create, assign, and administer Safe Keeping Receipts held under custody. Customers
                have read-only access to their own records.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportReport}>
              <Download className="mr-1.5 h-4 w-4" />
              Report
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1.5 h-4 w-4" />
              New SKR
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Cross-client expertise queue — surfaces applications awaiting a
            valuation so the desk can jump straight to the right client. */}
        {expertiseQueue.length > 0 && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
            <div className="mb-2 flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-primary" />
              <p className="text-sm font-semibold text-foreground">
                {expertiseQueue.length} expertise{" "}
                {expertiseQueue.length === 1 ? "application" : "applications"} awaiting valuation
              </p>
            </div>
            <div className="space-y-2">
              {expertiseQueue.map((q) => {
                const client = clients.find((c) => c.id === q.userId)
                return (
                  <button
                    key={`${q.userId}-${q.recordId}`}
                    type="button"
                    onClick={() => setTargetUserId(q.userId)}
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {q.beneficialOwner || client?.fullName || "Client"} — {q.kind}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {q.recordId} · {formatSkrValue(q.faceValue, q.currency)}
                        {client ? ` · ${client.company}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
                      {targetUserId === q.userId ? "Selected" : "Open"}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Select an application to load that client, then use &ldquo;Return valuation&rdquo; on the SKR below.
            </p>
          </div>
        )}

        {/* Cross-client service-request queue — surfaces Statement / Transfer /
            etc. requests awaiting action so the desk can jump to the client. */}
        {requestQueue.length > 0 && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
            <div className="mb-2 flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-primary" />
              <p className="text-sm font-semibold text-foreground">
                {requestQueue.length} SKR{" "}
                {requestQueue.length === 1 ? "request" : "requests"} awaiting action
              </p>
            </div>
            <div className="space-y-2">
              {requestQueue.map((q) => {
                const client = clients.find((c) => c.id === q.userId)
                return (
                  <button
                    key={`${q.userId}-${q.requestId}`}
                    type="button"
                    onClick={() => setTargetUserId(q.userId)}
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/60"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {client?.fullName || "Client"} — {q.type}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {q.recordId ? `${q.recordId} · ` : ""}
                        {q.message || "No message"}
                        {client ? ` · ${client.company}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
                      {targetUserId === q.userId ? "Selected" : "Open"}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Select a request to load that client, then action it under &ldquo;My Requests&rdquo; below.
            </p>
          </div>
        )}

        {/* Client selector */}
        <div className="space-y-2">
          <Label>Client account</Label>
          <Select value={targetUserId} onValueChange={setTargetUserId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.fullName} — {u.company} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading portfolio…
            </p>
          )}
        </div>

        {/* Portfolio summary */}
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Portfolio — {targetUser.fullName} ({records.length} records)
          </p>
          {totalByCurrency.length === 0 ? (
            <p className="text-sm text-muted-foreground">No SKR records for this client.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {totalByCurrency.map(([cur, val]) => (
                <Badge key={cur} variant="outline" className="text-sm font-semibold">
                  {formatSkrValue(val, cur)}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Pending client requests */}
        {pendingRequests.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Pending client requests ({pendingRequests.length})
            </p>
            {pendingRequests.map((req) => (
              <div
                key={req.id}
                className="flex flex-col gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-[10px] text-yellow-500">
                      <Clock className="mr-1 h-3 w-3" />
                      {req.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{req.id}</span>
                    {req.recordId && (
                      <span className="text-xs text-muted-foreground">· {req.recordId}</span>
                    )}
                  </div>
                  <p className="text-sm text-foreground text-pretty">{req.message}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decideRequest(req, "approved")}>
                    <Check className="mr-1 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => decideRequest(req, "rejected")}
                  >
                    <X className="mr-1 h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Records */}
        <div className="space-y-3">
          {records.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No SKR records. Use “New SKR” to create and assign one to this client.
            </p>
          ) : (
            records.map((record) => (
              <div key={record.id} className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{record.id}</span>
                      <Badge variant="outline" className={cn("text-[10px]", statusStyles[record.status])}>
                        {SKR_STATUS_LABELS[record.status]}
                      </Badge>
                      {record.creditedToTreasury && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-primary/20 bg-primary/10 text-[10px] text-primary"
                        >
                          <Wallet className="h-3 w-3" />
                          In Treasury
                        </Badge>
                      )}
                      {record.expertise && (
                        <Badge
                          variant="outline"
                          className={cn("gap-1 text-[10px]", expertiseBadgeStyles[record.expertise.status])}
                        >
                          <ClipboardCheck className="h-3 w-3" />
                          {record.expertise.kind}: {SKR_EXPERTISE_STATUS_LABELS[record.expertise.status]}
                        </Badge>
                      )}
                    </div>
                    <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      <div className="flex items-center gap-2">
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                        <span className="text-foreground">{record.custodian}</span>
                      </div>
                      <div className="text-foreground">
                        {formatSkrValue(record.faceValue, record.currency)}
                      </div>
                      <div className="text-muted-foreground">Owner: {record.beneficialOwner}</div>
                      <div className="text-muted-foreground">A/c: {record.custodyAccountRef}</div>
                      <div className="text-muted-foreground">Issued: {fmtDate(record.issueDate)}</div>
                      <div className="text-muted-foreground">Expiry: {fmtDate(record.expiryDate)}</div>
                    </div>
                    {record.assetDescription && (
                      <p className="text-xs text-muted-foreground text-pretty">
                        <span className="font-medium text-foreground">Asset:</span> {record.assetDescription}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {record.transactions.length} transactions · {record.documents.length} documents
                    </p>
                    {record.expertise && (
                      <div className="space-y-1 rounded-lg border border-border bg-background p-2.5 text-xs">
                        <p className="font-medium text-foreground">
                          {record.expertise.kind} — {SKR_EXPERTISE_STATUS_LABELS[record.expertise.status]}
                        </p>
                        {record.expertise.requestNote && (
                          <p className="text-muted-foreground text-pretty">&ldquo;{record.expertise.requestNote}&rdquo;</p>
                        )}
                        {record.expertise.status !== "requested" && record.expertise.assessedValue != null && (
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                            <span>
                              Assessed value:{" "}
                              <span className="text-foreground">
                                {formatSkrValue(
                                  record.expertise.assessedValue,
                                  record.expertise.assessedCurrency ?? record.currency,
                                )}
                              </span>
                            </span>
                            {record.expertise.tradeScore != null && (
                              <span>
                                Trade score: <span className="text-foreground">{record.expertise.tradeScore.toFixed(2)}</span>
                              </span>
                            )}
                            {record.expertise.cost != null && (
                              <span>
                                Service cost:{" "}
                                <span className="text-foreground">
                                  {formatSkrValue(record.expertise.cost, record.expertise.costCurrency ?? record.currency)}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                        {record.expertise.outcomeNote && (
                          <p className="text-muted-foreground text-pretty">
                            <span className="font-medium text-foreground">Outcome:</span> {record.expertise.outcomeNote}
                          </p>
                        )}
                        {record.expertise.status === "accepted" && (
                          <p className="text-green-600 dark:text-green-500 text-pretty">
                            Accepted — blocked as MT760-equivalent collateral
                            {record.expertise.instrumentId ? ` (instrument ${record.expertise.instrumentId})` : ""}.
                          </p>
                        )}
                      </div>
                    )}
                    {record.documents.length > 0 && (
                      <div className="flex flex-col gap-1.5 pt-1">
                        {record.documents.map((doc) => (
                          <div
                            key={doc.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate text-xs text-foreground">{doc.name}</span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{doc.docType}</span>
                            </div>
                            {doc.pathname ? (
                              <button
                                type="button"
                                onClick={() => void downloadFile(blobFileUrl(doc.pathname!), doc.name)}
                                className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <Download className="h-3.5 w-3.5" />
                                Download
                              </button>
                            ) : (
                              <span className="shrink-0 text-[10px] text-muted-foreground">Reference only</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 lg:w-52 lg:shrink-0">
                    <Select
                      value={record.status}
                      onValueChange={(v) => changeStatus(record, v as SkrStatus)}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {SKR_STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(record)}>
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setTxTarget(record)}>
                        <History className="mr-1 h-3.5 w-3.5" />
                        Txn
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openDoc(record)}>
                        <Paperclip className="mr-1 h-3.5 w-3.5" />
                        Doc
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setTransferToUserId("")
                          setTransferTarget(record)
                        }}
                      >
                        <ArrowRightLeft className="mr-1 h-3.5 w-3.5" />
                        Move
                      </Button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                      onClick={() => generateCertificate(record)}
                    >
                      <Award className="mr-1 h-3.5 w-3.5" />
                      Generate SKR Certificate
                    </Button>
                    {record.expertise &&
                      (record.expertise.status === "requested" || record.expertise.status === "assessed") && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400"
                          onClick={() => openExpertise(record)}
                        >
                          <ClipboardCheck className="mr-1 h-3.5 w-3.5" />
                          {record.expertise.status === "requested" ? "Return valuation" : "Revise valuation"}
                        </Button>
                      )}
                    {record.creditedToTreasury ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                        onClick={() => reverseCredit(record)}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Reverse Treasury Credit
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                        onClick={() => openCredit(record)}
                      >
                        <Wallet className="mr-1 h-3.5 w-3.5" />
                        Credit to Treasury
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => deleteRecord(record)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>

      {/* Create / Edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? `Edit ${editId}` : "Create SKR Record"}</DialogTitle>
            <DialogDescription>
              {editId
                ? "Update the safe keeping receipt details."
                : `Create and assign a new safe keeping receipt to ${targetUser.fullName}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="skr-custodian">Issuing bank / custodian</Label>
              <Input
                id="skr-custodian"
                value={form.custodian}
                onChange={(e) => setForm((f) => ({ ...f, custodian: e.target.value }))}
                placeholder="e.g. Barclays Bank PLC, London"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="skr-owner">Beneficial owner</Label>
              <Input
                id="skr-owner"
                value={form.beneficialOwner}
                onChange={(e) => setForm((f) => ({ ...f, beneficialOwner: e.target.value }))}
                placeholder="Legal name of the owner"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-face">Face value</Label>
              <MoneyInput
                id="skr-face"
                value={form.faceValue}
                onValueChange={(v) => setForm((f) => ({ ...f, faceValue: v }))}
                placeholder="0.00"
              />
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
            <div className="space-y-2">
              <Label htmlFor="skr-issue">Date of issuance</Label>
              <Input
                id="skr-issue"
                type="date"
                value={form.issueDate}
                onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-expiry">Expiry date (optional)</Label>
              <Input
                id="skr-expiry"
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="skr-acct">Custody account reference (optional)</Label>
              <Input
                id="skr-acct"
                value={form.custodyAccountRef}
                onChange={(e) => setForm((f) => ({ ...f, custodyAccountRef: e.target.value }))}
                placeholder="Auto-generated if left blank"
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as SkrStatus }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SKR_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="skr-asset">Asset under custody (object of this SKR)</Label>
              <Textarea
                id="skr-asset"
                value={form.assetDescription}
                onChange={(e) => setForm((f) => ({ ...f, assetDescription: e.target.value }))}
                rows={2}
                placeholder="Describe the asset held in custody — e.g. gold bullion, bonds, fine art, machinery — appears on the SKR certificate."
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="skr-notes">Custody notes (optional)</Label>
              <Textarea
                id="skr-notes"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                placeholder="Any custody or instrument notes visible to the client."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveForm}>{editId ? "Save changes" : "Create & assign"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add transaction dialog */}
      <Dialog open={!!txTarget} onOpenChange={(open) => !open && setTxTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add transaction</DialogTitle>
            <DialogDescription>
              Record a transaction on {txTarget?.id}. It will appear in the client&apos;s history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={txType} onValueChange={setTxType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Custody Update", "Verification", "Valuation", "Collateral", "Amendment", "Note"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-tx-desc">Description</Label>
              <Textarea
                id="skr-tx-desc"
                value={txDescription}
                onChange={(e) => setTxDescription(e.target.value)}
                rows={3}
                placeholder="Describe the transaction."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTxTarget(null)}>
              Cancel
            </Button>
            <Button onClick={submitTransaction}>Record transaction</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add document dialog */}
      <Dialog open={!!docTarget} onOpenChange={(open) => !open && !docUploading && setDocTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload document</DialogTitle>
            <DialogDescription>
              Upload a picture or document evidencing the asset held under {docTarget?.id} (e.g. photos,
              custodian confirmations, appraisals).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="skr-doc-file">File</Label>
              <Input
                id="skr-doc-file"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null
                  setDocFile(file)
                  if (file && !docName.trim()) setDocName(file.name)
                }}
              />
              {docFile && (
                <p className="text-[11px] text-muted-foreground">
                  {docFile.name} · {(docFile.size / 1024).toFixed(0)} KB
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-doc-name">Document name</Label>
              <Input
                id="skr-doc-name"
                value={docName}
                onChange={(e) => setDocName(e.target.value)}
                placeholder="e.g. SKR-Certificate-Barclays.pdf"
              />
            </div>
            <div className="space-y-2">
              <Label>Document type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["SKR Certificate", "Asset Photograph", "Custodian Confirmation", "Authentication", "Appraisal", "Amendment", "Other"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocTarget(null)} disabled={docUploading}>
              Cancel
            </Button>
            <Button onClick={submitDocument} disabled={docUploading}>
              {docUploading ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="mr-1 h-4 w-4" />
                  Upload document
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer dialog */}
      <Dialog open={!!transferTarget} onOpenChange={(open) => !open && setTransferTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer SKR</DialogTitle>
            <DialogDescription>
              Transfer {transferTarget?.id} to another internal client account. The record moves to
              the destination portfolio.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Destination account</Label>
            <Select value={transferToUserId} onValueChange={setTransferToUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select destination client" />
              </SelectTrigger>
              <SelectContent>
                {clients
                  .filter((c) => c.id !== targetUserId)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.fullName} ��� {u.company}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)}>
              Cancel
            </Button>
            <Button onClick={submitTransfer}>Transfer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit-to-treasury dialog */}
      {/* Expertise / evaluation / audit valuation */}
      <Dialog
        open={!!expTarget}
        onOpenChange={(open) => {
          if (!open && !expBusy) {
            setExpTarget(null)
            setExpResult(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {expTarget?.expertise?.kind ?? "Expertise"} valuation — {expTarget?.id}
            </DialogTitle>
            <DialogDescription>
              Set the assessed value of the goods and return a professional outcome. The service cost is
              calculated as{" "}
              <span className="font-medium text-foreground">
                (face value × 0.075% × (trade score + 1)) ÷ 1.50
              </span>{" "}
              using {targetUser.fullName}&apos;s live trade score.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">SKR face value</span>
                <span className="font-medium text-foreground">
                  {expTarget ? formatSkrValue(expTarget.faceValue, expTarget.currency) : "—"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Custodian</span>
                <span className="text-foreground">{expTarget?.custodian}</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="skr-exp-value">Assessed value of goods</Label>
                <MoneyInput id="skr-exp-value" value={expValue} onValueChange={setExpValue} placeholder="0.00" />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Select value={expCurrency} onValueChange={setExpCurrency}>
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
              <Label htmlFor="skr-exp-outcome">Expertise outcome / findings</Label>
              <Textarea
                id="skr-exp-outcome"
                value={expOutcome}
                onChange={(e) => setExpOutcome(e.target.value)}
                placeholder="Summarise the professional assessment, condition and valuation basis returned to the client."
                rows={4}
              />
            </div>
            {expResult && (
              <div className="space-y-1 rounded-lg border border-green-500/30 bg-green-500/5 p-3 text-sm">
                <p className="font-medium text-foreground">Valuation returned to the client</p>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Trade score</span>
                  <span className="text-foreground">{expResult.tradeScore.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Service cost (charged on acceptance)</span>
                  <span className="font-medium text-foreground">{formatSkrValue(expResult.cost, expResult.currency)}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setExpTarget(null)
                setExpResult(null)
              }}
              disabled={expBusy}
            >
              {expResult ? "Close" : "Cancel"}
            </Button>
            <Button onClick={submitExpertise} disabled={expBusy}>
              {expBusy ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Returning…
                </>
              ) : (
                <>
                  <ClipboardCheck className="mr-1 h-4 w-4" />
                  {expResult ? "Re-issue valuation" : "Return valuation & cost"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!creditTarget} onOpenChange={(open) => !open && setCreditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Credit SKR to Treasury</DialogTitle>
            <DialogDescription>
              Pledge the value of {creditTarget?.id} to {targetUser.fullName}&apos;s treasury balance.
              The amount is added as collateral to the security deposit and becomes available for trading.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Receipt face value</span>
                <span className="font-medium text-foreground">
                  {creditTarget ? formatSkrValue(creditTarget.faceValue, creditTarget.currency) : "—"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted-foreground">Custodian</span>
                <span className="text-foreground">{creditTarget?.custodian}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skr-credit-amount">Amount to credit (EUR)</Label>
              <MoneyInput
                id="skr-credit-amount"
                value={creditAmount}
                onValueChange={setCreditAmount}
                placeholder="0.00"
              />
              {creditTarget && creditTarget.currency !== "EUR" && (
                <p className="text-[11px] text-muted-foreground text-pretty">
                  This receipt is denominated in {creditTarget.currency}. The treasury balance is held in
                  EUR — enter the EUR-equivalent collateral value to credit.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreditTarget(null)} disabled={creditBusy}>
              Cancel
            </Button>
            <Button onClick={submitCredit} disabled={creditBusy}>
              {creditBusy ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Crediting…
                </>
              ) : (
                <>
                  <Wallet className="mr-1 h-4 w-4" />
                  Credit to Treasury
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
