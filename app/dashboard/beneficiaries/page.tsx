"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Search,
  Plus,
  Filter,
  MoreHorizontal,
  Building2,
  User,
  Globe,
  CheckCircle2,
  Clock,
  XCircle,
  Edit,
  Trash2,
  Copy,
  Star,
  StarOff,
  FileText,
  Download,
  Upload,
  Ban,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { useActivityLog } from "@/components/activity-tracker"
import {
  useBeneficiaries,
  type Beneficiary,
  type BeneficiaryType,
  type BeneficiaryStatus,
} from "@/lib/beneficiaries-store"
import { upsertMyBeneficiary } from "@/app/actions/beneficiaries"
import { exportToCsv, importCsvFile } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { VerifiedBankField } from "@/components/verified-bank-field"
import { CountryCombobox } from "@/components/country-combobox"
import { countryName, validateIban, validateBic } from "@/lib/iban-swift"

const emptyForm = {
  name: "",
  alias: "",
  dateOfBirth: "",
  nationality: "",
  registrationNumber: "",
  vatNumber: "",
  beneficiaryAddress: "",
  beneficiaryCity: "",
  beneficiaryPostalCode: "",
  beneficiaryCountry: "",
  iban: "",
  accountNumber: "",
  swiftBic: "",
  currency: "",
  bankName: "",
  bankAddress: "",
  bankCountry: "",
  correspondentBank: "",
  correspondentSwift: "",
  intermediaryBank: "",
  intermediarySwift: "",
  notes: "",
}

const currencies = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "SGD", "HKD", "AED"]

function getStatusBadge(status: BeneficiaryStatus) {
  switch (status) {
    case "active":
      return <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Active</Badge>
    case "pending":
      return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20">Pending</Badge>
    case "suspended":
      return <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/20">Suspended</Badge>
    case "blocked":
      return <Badge className="bg-red-500/10 text-red-400 border-red-500/20">Blocked</Badge>
    case "cancelled":
      return <Badge className="bg-muted text-muted-foreground border-border">Cancelled</Badge>
  }
}

function getRiskBadge(risk: "low" | "medium" | "high") {
  switch (risk) {
    case "low":
      return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Low Risk</Badge>
    case "medium":
      return <Badge variant="outline" className="text-amber-400 border-amber-500/30">Medium Risk</Badge>
    case "high":
      return <Badge variant="outline" className="text-red-400 border-red-500/30">High Risk</Badge>
  }
}

function getTypeIcon(type: BeneficiaryType) {
  switch (type) {
    case "individual":
      return <User className="h-4 w-4" />
    case "corporate":
      return <Building2 className="h-4 w-4" />
    case "financial_institution":
      return <Globe className="h-4 w-4" />
  }
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export default function BeneficiariesPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [selectedBeneficiary, setSelectedBeneficiary] = useState<Beneficiary | null>(null)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false)
  // When set, the dialog is editing an existing payee rather than adding one.
  const [editingBeneficiary, setEditingBeneficiary] = useState<Beneficiary | null>(null)
  const [newBeneficiaryType, setNewBeneficiaryType] = useState<BeneficiaryType>("corporate")
  const [activeTab, setActiveTab] = useState("all")
  const { beneficiaries, setBeneficiaries } = useBeneficiaries()
  const [form, setForm] = useState(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [savingBeneficiary, setSavingBeneficiary] = useState(false)
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress, holderRepresentative } = useHolderIdentity()
  const router = useRouter()

  const viewBeneficiary = (ben: Beneficiary) => {
    router.push(`/dashboard/beneficiaries/${encodeURIComponent(ben.id)}`)
  }

  const duplicateBeneficiary = (ben: Beneficiary) => {
    const copy: Beneficiary = {
      ...ben,
      id: `BEN-COPY-${Date.now().toString().slice(-5)}`,
      name: `${ben.name} (Copy)`,
      status: "pending",
      isFavorite: false,
      createdAt: new Date().toISOString().split("T")[0],
      totalTransactions: 0,
      totalVolume: 0,
      kycVerified: false,
    }
    setBeneficiaries((prev) => [copy, ...prev])
    logActivity({
      action: `Duplicated beneficiary ${ben.name}`,
      category: "Beneficiary Management",
      details: {
        summary: `Client duplicated the beneficiary "${ben.name}" as a new pending record.`,
        source: ben.name,
        newId: copy.id,
      },
    })
    toast.success("Beneficiary duplicated", {
      description: `${copy.name} added as a pending record.`,
    })
  }

  const deleteBeneficiary = (ben: Beneficiary) => {
    setBeneficiaries((prev) => prev.filter((b) => b.id !== ben.id))
    logActivity({
      action: `Deleted beneficiary ${ben.name}`,
      category: "Beneficiary Management",
      details: {
        summary: `Client deleted the beneficiary "${ben.name}" (${ben.id}).`,
        beneficiaryId: ben.id,
        name: ben.name,
      },
    })
    toast.success("Beneficiary deleted", {
      description: `${ben.name} was removed from your list.`,
    })
  }

  // Open the shared dialog pre-filled with this payee's details for editing.
  const editBeneficiary = (ben: Beneficiary) => {
    setEditingBeneficiary(ben)
    setNewBeneficiaryType(ben.type)
    setForm({
      name: ben.name ?? "",
      alias: ben.alias ?? "",
      dateOfBirth: ben.dateOfBirth ?? "",
      nationality: ben.nationality ?? "",
      registrationNumber: ben.registrationNumber ?? "",
      vatNumber: ben.vatNumber ?? "",
      beneficiaryAddress: ben.beneficiaryAddress ?? "",
      beneficiaryCity: ben.beneficiaryCity ?? "",
      beneficiaryPostalCode: ben.beneficiaryPostalCode ?? "",
      beneficiaryCountry: ben.beneficiaryCountry ?? "",
      iban: ben.iban ?? "",
      accountNumber: ben.accountNumber ?? "",
      swiftBic: ben.swiftBic ?? "",
      currency: ben.currency ?? "",
      bankName: ben.bankName ?? "",
      bankAddress: ben.bankAddress ?? "",
      bankCountry: ben.bankCountry ?? "",
      correspondentBank: ben.correspondentBank ?? "",
      correspondentSwift: ben.correspondentSwift ?? "",
      intermediaryBank: ben.intermediaryBank ?? "",
      intermediarySwift: ben.intermediarySwift ?? "",
      notes: ben.notes ?? "",
    })
    setFormError(null)
    setIsAddDialogOpen(true)
  }

  // Cancel = deactivate but KEEP the record (audit history), so it can no longer
  // be paid and can be reactivated later. Persist to the server first.
  const cancelBeneficiary = async (ben: Beneficiary) => {
    if (ben.status === "cancelled") return
    const updated: Beneficiary = { ...ben, status: "cancelled", isFavorite: false }
    const saved = await upsertMyBeneficiary(
      updated.id,
      updated as unknown as Record<string, unknown>,
      updated.status,
    )
    if (!saved.ok) {
      toast.error("Could not cancel beneficiary", { description: saved.error })
      return
    }
    setBeneficiaries((prev) => prev.map((b) => (b.id === ben.id ? updated : b)))
    logActivity({
      action: `Cancelled beneficiary ${ben.name}`,
      category: "Beneficiary Management",
      details: {
        summary: `Client cancelled the beneficiary "${ben.name}" (${ben.id}). The record is retained for audit and can be reactivated.`,
        beneficiaryId: ben.id,
        name: ben.name,
        previousStatus: ben.status,
      },
    })
    toast.success("Beneficiary cancelled", {
      description: `${ben.name} is deactivated. You can reactivate it anytime.`,
    })
  }

  // Reactivate a cancelled payee. Because reactivation re-enables payments, it
  // returns to Pending for admin re-approval (never silently back to Active).
  const reactivateBeneficiary = async (ben: Beneficiary) => {
    const updated: Beneficiary = { ...ben, status: "pending", kycVerified: false }
    const saved = await upsertMyBeneficiary(
      updated.id,
      updated as unknown as Record<string, unknown>,
      updated.status,
    )
    if (!saved.ok) {
      toast.error("Could not reactivate beneficiary", { description: saved.error })
      return
    }
    setBeneficiaries((prev) => prev.map((b) => (b.id === ben.id ? updated : b)))
    logActivity({
      action: `Reactivated beneficiary ${ben.name}`,
      category: "Beneficiary Management",
      details: {
        summary: `Client reactivated the cancelled beneficiary "${ben.name}" (${ben.id}). It is pending admin re-approval before payments can resume.`,
        beneficiaryId: ben.id,
        name: ben.name,
      },
    })
    toast.success("Beneficiary reactivated", {
      description: `${ben.name} is pending re-approval.`,
    })
  }

  const sendPaymentTo = (ben: Beneficiary) => {
    logActivity({
      action: `Started a payment to ${ben.name}`,
      category: "Payments",
      details: {
        summary: `Client initiated a payment to the beneficiary "${ben.name}" (${ben.id}).`,
        beneficiaryId: ben.id,
        name: ben.name,
      },
    })
    setIsViewDialogOpen(false)
    router.push("/dashboard/payments")
  }

  const updateForm = (field: keyof typeof emptyForm, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }))

  const handleAddBeneficiary = async () => {
    if (savingBeneficiary) return
    const required: [keyof typeof emptyForm, string][] = [
      ["name", newBeneficiaryType === "individual" ? "Full Name" : "Company Name"],
      ["beneficiaryAddress", "Address"],
      ["beneficiaryCity", "City"],
      ["beneficiaryCountry", "Country"],
      ["iban", "IBAN"],
      ["swiftBic", "SWIFT/BIC Code"],
      ["currency", "Currency"],
      ["bankName", "Bank Name"],
      ["bankAddress", "Bank Address"],
      ["bankCountry", "Bank Country"],
    ]
    const missing = required.filter(([key]) => !form[key].trim()).map(([, label]) => label)
    if (missing.length > 0) {
      setFormError(`Please fill in the required field(s): ${missing.join(", ")}`)
      return
    }

    const ibanCheck = validateIban(form.iban)
    if (!ibanCheck.valid) {
      setFormError(`IBAN: ${ibanCheck.error}`)
      return
    }
    const bicCheck = validateBic(form.swiftBic)
    if (!bicCheck.valid) {
      setFormError(`SWIFT/BIC: ${bicCheck.error}`)
      return
    }
    if (form.correspondentSwift.trim() && !validateBic(form.correspondentSwift).valid) {
      setFormError("Correspondent SWIFT/BIC is invalid.")
      return
    }
    if (form.intermediarySwift.trim() && !validateBic(form.intermediarySwift).valid) {
      setFormError("Intermediary SWIFT/BIC is invalid.")
      return
    }

    const editing = editingBeneficiary
    const nextAccountNumber = form.accountNumber.trim() || form.iban.trim()
    const nextSwift = form.swiftBic.trim().toUpperCase()

    // Re-approval rule: editing an already-approved payee only forces a return
    // to Pending when BANK ROUTING details change. Cosmetic edits (alias, notes,
    // address, tax IDs) keep the payee Active — full self-service, no re-check.
    const bankRoutingChanged =
      !!editing &&
      ((form.iban.trim() || undefined) !== (editing.iban || undefined) ||
        nextAccountNumber !== editing.accountNumber ||
        nextSwift !== editing.swiftBic ||
        form.bankName.trim() !== editing.bankName ||
        form.bankAddress.trim() !== editing.bankAddress ||
        form.bankCountry !== editing.bankCountry ||
        (form.correspondentSwift.trim().toUpperCase() || undefined) !== (editing.correspondentSwift || undefined) ||
        (form.intermediarySwift.trim().toUpperCase() || undefined) !== (editing.intermediarySwift || undefined))

    const nextStatus: BeneficiaryStatus = editing
      ? editing.status === "active" && bankRoutingChanged
        ? "pending"
        : editing.status
      : "pending"

    const newBeneficiary: Beneficiary = {
      // Editing keeps the existing id (so the server upsert updates in place);
      // adding mints a globally-unique id. A length-based id (e.g. BEN-003)
      // collides after any deletion and the upsert (ON CONFLICT (id) DO UPDATE)
      // would then overwrite that record — so the "new" one appears to vanish.
      id: editing ? editing.id : `BEN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase(),
      type: newBeneficiaryType,
      name: form.name.trim(),
      alias: form.alias.trim() || undefined,
      accountNumber: nextAccountNumber,
      iban: form.iban.trim() || undefined,
      swiftBic: nextSwift,
      bankName: form.bankName.trim(),
      bankAddress: form.bankAddress.trim(),
      bankCountry: form.bankCountry,
      beneficiaryAddress: form.beneficiaryAddress.trim(),
      beneficiaryCity: form.beneficiaryCity.trim(),
      beneficiaryCountry: form.beneficiaryCountry,
      beneficiaryPostalCode: form.beneficiaryPostalCode.trim() || undefined,
      currency: form.currency,
      status: nextStatus,
      isFavorite: editing ? editing.isFavorite : false,
      createdAt: editing ? editing.createdAt : new Date().toISOString().split("T")[0],
      lastUsed: editing?.lastUsed,
      totalTransactions: editing ? editing.totalTransactions : 0,
      totalVolume: editing ? editing.totalVolume : 0,
      // Bank-routing changes reset KYC; cosmetic edits keep prior verification.
      kycVerified: editing ? (bankRoutingChanged ? false : editing.kycVerified) : false,
      riskLevel: editing ? editing.riskLevel : "low",
      amlScreeningDate: editing?.amlScreeningDate,
      registrationNumber: form.registrationNumber.trim() || undefined,
      vatNumber: form.vatNumber.trim() || undefined,
      dateOfBirth: form.dateOfBirth || undefined,
      nationality: form.nationality || undefined,
      correspondentBank: form.correspondentBank.trim() || undefined,
      correspondentSwift: form.correspondentSwift.trim().toUpperCase() || undefined,
      intermediaryBank: form.intermediaryBank.trim() || undefined,
      intermediarySwift: form.intermediarySwift.trim().toUpperCase() || undefined,
      notes: form.notes.trim() || undefined,
    }

    // Commit to the server FIRST and wait for confirmation, so we never tell the
    // user it was added while it silently failed to persist. Only on success do
    // we update local state (which the store also mirrors) and close the dialog.
    setSavingBeneficiary(true)
    setFormError(null)
    const saved = await upsertMyBeneficiary(
      newBeneficiary.id,
      newBeneficiary as unknown as Record<string, unknown>,
      newBeneficiary.status,
    )
    setSavingBeneficiary(false)
    if (!saved.ok) {
      setFormError(saved.error || "Could not save the beneficiary. Please try again.")
      toast.error("Beneficiary not saved", { description: saved.error })
      return
    }

    if (editing) {
      setBeneficiaries((prev) => prev.map((b) => (b.id === newBeneficiary.id ? newBeneficiary : b)))
      logActivity({
        action: `Modified beneficiary: ${newBeneficiary.name}`,
        category: "Beneficiary Management",
        details: {
          summary: bankRoutingChanged
            ? `Client modified bank details of "${newBeneficiary.name}" (${newBeneficiary.id}). Because routing details changed, the payee returned to Pending for re-approval.`
            : `Client updated non-banking details of "${newBeneficiary.name}" (${newBeneficiary.id}). Bank routing unchanged, so the payee remains ${newBeneficiary.status}.`,
          name: newBeneficiary.name,
          beneficiaryId: newBeneficiary.id,
          bankRoutingChanged: bankRoutingChanged ? "yes" : "no",
          resultingStatus: newBeneficiary.status,
        },
      })
      toast.success("Beneficiary updated", {
        description: bankRoutingChanged
          ? `${newBeneficiary.name} was updated and is pending re-approval (bank details changed).`
          : `${newBeneficiary.name} was updated.`,
      })
    } else {
      setBeneficiaries((prev) => [newBeneficiary, ...prev])
      logActivity({
        action: `Added ${newBeneficiary.type} beneficiary: ${newBeneficiary.name}`,
        category: "Beneficiary Management",
        details: {
          summary: `Client added a new ${newBeneficiary.type} beneficiary "${newBeneficiary.name}" with account ${newBeneficiary.iban ?? newBeneficiary.accountNumber} at ${newBeneficiary.bankName} (${newBeneficiary.bankCountry}), SWIFT/BIC ${newBeneficiary.swiftBic}, currency ${newBeneficiary.currency}. KYC pending.`,
          name: newBeneficiary.name,
          alias: newBeneficiary.alias ?? "(none)",
          type: newBeneficiary.type,
          iban: newBeneficiary.iban ?? "(none)",
          accountNumber: newBeneficiary.accountNumber,
          swiftBic: newBeneficiary.swiftBic,
          bankName: newBeneficiary.bankName,
          bankCountry: newBeneficiary.bankCountry,
          beneficiaryCountry: newBeneficiary.beneficiaryCountry,
          currency: newBeneficiary.currency,
          correspondentBank: newBeneficiary.correspondentBank ?? "(none)",
          intermediaryBank: newBeneficiary.intermediaryBank ?? "(none)",
          status: "Pending KYC verification",
        },
      })
      toast.success("Beneficiary added", {
        description: `${newBeneficiary.name} was saved and is pending KYC verification.`,
      })
    }
    setForm(emptyForm)
    setFormError(null)
    setEditingBeneficiary(null)
    setIsAddDialogOpen(false)
  }

  const handleExportCsv = () => {
    const count = exportToCsv("beneficiaries", beneficiaries, [
      { key: "id", label: "ID" },
      { key: "type", label: "Type" },
      { key: "name", label: "Name" },
      { key: "alias", label: "Alias" },
      { key: "iban", label: "IBAN" },
      { key: "accountNumber", label: "Account Number" },
      { key: "swiftBic", label: "SWIFT/BIC" },
      { key: "bankName", label: "Bank Name" },
      { key: "bankCountry", label: "Bank Country" },
      { key: "beneficiaryCountry", label: "Beneficiary Country" },
      { key: "currency", label: "Currency" },
      { key: "status", label: "Status" },
    ])
    logActivity({
      action: `Exported ${count} beneficiar${count === 1 ? "y" : "ies"} to CSV`,
      category: "Beneficiary Management",
      details: {
        summary: `Client exported ${count} beneficiar${count === 1 ? "y" : "ies"} to a CSV file.`,
        recordCount: `${count}`,
        format: "CSV",
      },
    })
  }

  const handleExportPdf = () => {
    if (beneficiaries.length === 0) {
      toast.info("No beneficiaries to export", { description: "Add a beneficiary first." })
      return
    }
    const doc = generateTablePdf({
      title: "Beneficiary Register",
      refPrefix: "BEN",
      holderName,
      holderCompany,
      holderAddress,
      holderRepresentative,
      meta: [{ label: "Records", value: `${beneficiaries.length}` }],
      columns: [
        { key: "name", header: "Name" },
        { key: "type", header: "Type" },
        { key: "bankName", header: "Bank" },
        { key: "iban", header: "IBAN / Account" },
        { key: "swiftBic", header: "SWIFT/BIC" },
        { key: "currency", header: "Ccy" },
        { key: "status", header: "Status" },
      ],
      rows: beneficiaries as unknown as Record<string, unknown>[],
      footNote: "Beneficiary register exported from the MCC Capital platform.",
    })
    show({ doc, filename: tablePdfFilename("Beneficiary-Register"), title: "Beneficiary Register" })
    logActivity({
      action: `Exported ${beneficiaries.length} beneficiar${beneficiaries.length === 1 ? "y" : "ies"} to PDF`,
      category: "Beneficiary Management",
      details: {
        summary: `Client previewed/exported ${beneficiaries.length} beneficiary record(s) as a professional PDF.`,
        recordCount: `${beneficiaries.length}`,
        format: "PDF",
      },
    })
  }

  const handleImport = async () => {
    try {
      const rows = await importCsvFile()
      if (rows.length === 0) return
      const imported: Beneficiary[] = rows.map((row, idx) => {
        const get = (k: string) => String(row[k] ?? "").trim()
        const rawType = get("type").toLowerCase()
        const type: BeneficiaryType =
          rawType === "individual" || rawType === "financial_institution"
            ? (rawType as BeneficiaryType)
            : "corporate"
        return {
          id: `BEN-IMP-${Date.now().toString().slice(-5)}-${idx + 1}`,
          type,
          name: get("name") || get("Name") || `Imported beneficiary ${idx + 1}`,
          alias: get("alias") || undefined,
          accountNumber: get("accountNumber") || get("iban"),
          iban: get("iban") || undefined,
          swiftBic: (get("swiftBic") || get("swift")).toUpperCase(),
          bankName: get("bankName") || "—",
          bankAddress: get("bankAddress") || "—",
          bankCountry: get("bankCountry") || "—",
          beneficiaryAddress: get("beneficiaryAddress") || "—",
          beneficiaryCity: get("beneficiaryCity") || "—",
          beneficiaryCountry: get("beneficiaryCountry") || "—",
          currency: (get("currency") || "EUR").toUpperCase(),
          status: "pending",
          isFavorite: false,
          createdAt: new Date().toISOString().split("T")[0],
          totalTransactions: 0,
          totalVolume: 0,
          kycVerified: false,
          riskLevel: "low",
        }
      })
      setBeneficiaries((prev) => [...imported, ...prev])
      logActivity({
        action: `Imported ${imported.length} beneficiar${imported.length === 1 ? "y" : "ies"} from CSV`,
        category: "Beneficiary Management",
        details: {
          summary: `Client imported ${imported.length} beneficiar${imported.length === 1 ? "y" : "ies"} from a CSV file. All imported records are set to pending KYC.`,
          recordCount: `${imported.length}`,
          names: imported.map((b) => b.name).join(", "),
        },
      })
    } catch {
      setFormError("Could not read the CSV file. Please check the format and try again.")
    }
  }

  const filteredBeneficiaries = beneficiaries.filter((ben) => {
    const matchesSearch =
      ben.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ben.swiftBic.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ben.iban?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ben.bankName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ben.alias?.toLowerCase().includes(searchQuery.toLowerCase())
    
    const matchesStatus = statusFilter === "all" || ben.status === statusFilter
    const matchesType = typeFilter === "all" || ben.type === typeFilter
    
    const matchesTab = 
      activeTab === "all" ||
      (activeTab === "favorites" && ben.isFavorite) ||
      (activeTab === "individual" && ben.type === "individual") ||
      (activeTab === "corporate" && ben.type === "corporate") ||
      (activeTab === "financial" && ben.type === "financial_institution")
    
    return matchesSearch && matchesStatus && matchesType && matchesTab
  })

  const stats = {
    total: beneficiaries.length,
    active: beneficiaries.filter((b) => b.status === "active").length,
    pending: beneficiaries.filter((b) => b.status === "pending").length,
    favorites: beneficiaries.filter((b) => b.isFavorite).length,
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Beneficiary Management</h1>
          <p className="text-muted-foreground">Manage payment recipients and counterparties</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={handleImport}>
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportPdf}>
                <FileText className="mr-2 h-4 w-4" />
                Export as PDF
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportCsv}>
                <Download className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog
            open={isAddDialogOpen}
            onOpenChange={(open) => {
              setIsAddDialogOpen(open)
              if (!open) {
                setEditingBeneficiary(null)
                setForm(emptyForm)
                setFormError(null)
              }
            }}
          >
            <DialogTrigger asChild>
              <Button
                size="sm"
                className="gap-2 bg-primary"
                onClick={() => {
                  setEditingBeneficiary(null)
                  setForm(emptyForm)
                  setFormError(null)
                }}
              >
                <Plus className="h-4 w-4" />
                Add Beneficiary
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingBeneficiary ? "Modify Beneficiary" : "Add New Beneficiary"}</DialogTitle>
                <DialogDescription>
                  {editingBeneficiary
                    ? "Update this payee. Changing bank routing details will send it back for re-approval."
                    : "Enter beneficiary details for payment processing"}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6 py-4">
                {/* Beneficiary Type Selection */}
                <div className="space-y-2">
                  <Label>Beneficiary Type</Label>
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => setNewBeneficiaryType("individual")}
                      className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                        newBeneficiaryType === "individual"
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <User className="h-6 w-6" />
                      <span className="text-sm font-medium">Individual</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewBeneficiaryType("corporate")}
                      className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                        newBeneficiaryType === "corporate"
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <Building2 className="h-6 w-6" />
                      <span className="text-sm font-medium">Corporate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewBeneficiaryType("financial_institution")}
                      className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                        newBeneficiaryType === "financial_institution"
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <Globe className="h-6 w-6" />
                      <span className="text-sm font-medium">Financial Institution</span>
                    </button>
                  </div>
                </div>

                {/* Beneficiary Information */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground">Beneficiary Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">
                        {newBeneficiaryType === "individual" ? "Full Name" : "Company Name"} *
                      </Label>
                      <Input id="name" placeholder={newBeneficiaryType === "individual" ? "John Smith" : "Company Ltd."} value={form.name} onChange={(e) => updateForm("name", e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="alias">Alias / Short Name</Label>
                      <Input id="alias" placeholder="Short reference name" value={form.alias} onChange={(e) => updateForm("alias", e.target.value)} />
                    </div>
                  </div>

                  {newBeneficiaryType === "individual" && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="dob">Date of Birth</Label>
                        <Input id="dob" type="date" value={form.dateOfBirth} onChange={(e) => updateForm("dateOfBirth", e.target.value)} />
                      </div>
                      <div className="space-y-2">
                      <Label htmlFor="nationality">Nationality</Label>
                      <CountryCombobox
                        id="nationality"
                        valueMode="name"
                        value={form.nationality}
                        onChange={(v) => updateForm("nationality", v)}
                        placeholder="Search and select country"
                      />
                      </div>
                    </div>
                  )}

                  {(newBeneficiaryType === "corporate" || newBeneficiaryType === "financial_institution") && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="regNumber">Registration Number</Label>
                        <Input id="regNumber" placeholder="Company registration number" value={form.registrationNumber} onChange={(e) => updateForm("registrationNumber", e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="vatNumber">VAT / Tax Number</Label>
                        <Input id="vatNumber" placeholder="VAT identification number" value={form.vatNumber} onChange={(e) => updateForm("vatNumber", e.target.value)} />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="address">Address *</Label>
                      <Input id="address" placeholder="Street address" value={form.beneficiaryAddress} onChange={(e) => updateForm("beneficiaryAddress", e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="city">City *</Label>
                      <Input id="city" placeholder="City" value={form.beneficiaryCity} onChange={(e) => updateForm("beneficiaryCity", e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="postalCode">Postal Code</Label>
                      <Input id="postalCode" placeholder="Postal code" value={form.beneficiaryPostalCode} onChange={(e) => updateForm("beneficiaryPostalCode", e.target.value)} />
                    </div>
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="country">Country *</Label>
                      <CountryCombobox
                        id="country"
                        valueMode="name"
                        value={form.beneficiaryCountry}
                        onChange={(v) => updateForm("beneficiaryCountry", v)}
                        placeholder="Search and select country"
                      />
                    </div>
                  </div>
                </div>

                {/* Bank Account Information */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground">Bank Account Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <VerifiedBankField
                      id="iban"
                      label="IBAN"
                      kind="iban"
                      required
                      placeholder="XX00 0000 0000 0000 0000 00"
                      value={form.iban}
                      onChange={(v) => updateForm("iban", v)}
                      onResolved={(info) => {
                        if (info && !form.bankName) updateForm("bankName", info.name)
                        if (info?.country) updateForm("bankCountry", info.country.toLowerCase())
                        // Auto-fill the SWIFT/BIC field from the resolved IBAN.
                        if (info?.bic && !form.swiftBic.trim()) updateForm("swiftBic", info.bic)
                      }}
                    />
                    <div className="space-y-2">
                      <Label htmlFor="accountNumber">Account Number</Label>
                      <Input id="accountNumber" placeholder="Account number (if no IBAN)" className="font-mono" value={form.accountNumber} onChange={(e) => updateForm("accountNumber", e.target.value)} />
                    </div>
                    <VerifiedBankField
                      id="swiftBic"
                      label="SWIFT/BIC Code"
                      kind="bic"
                      required
                      maxLength={11}
                      placeholder="XXXXXXXX"
                      value={form.swiftBic}
                      onChange={(v) => updateForm("swiftBic", v)}
                      onResolved={(info) => {
                        if (info) {
                          updateForm("bankName", info.name)
                          if (info.country) updateForm("bankCountry", info.country.toLowerCase())
                        }
                      }}
                    />
                    <div className="space-y-2">
                      <Label htmlFor="currency">Currency *</Label>
                      <Select value={form.currency} onValueChange={(v) => updateForm("currency", v)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select currency" />
                        </SelectTrigger>
                        <SelectContent>
                          {currencies.map((curr) => (
                            <SelectItem key={curr} value={curr}>
                              {curr}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* Bank Information */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground">Bank Information</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="bankName">Bank Name *</Label>
                      <Input id="bankName" placeholder="Beneficiary bank name" value={form.bankName} onChange={(e) => updateForm("bankName", e.target.value)} />
                    </div>
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="bankAddress">Bank Address *</Label>
                      <Input id="bankAddress" placeholder="Bank address" value={form.bankAddress} onChange={(e) => updateForm("bankAddress", e.target.value)} />
                    </div>
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="bankCountry">Bank Country *</Label>
                      <CountryCombobox
                        id="bankCountry"
                        valueMode="name"
                        value={form.bankCountry}
                        onChange={(v) => updateForm("bankCountry", v)}
                        placeholder="Search and select country"
                      />
                    </div>
                  </div>
                </div>

                {/* Correspondent Bank (Optional) */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground">Correspondent / Intermediary Bank (Optional)</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="corrBank">Correspondent Bank</Label>
                      <Input id="corrBank" placeholder="Correspondent bank name" value={form.correspondentBank} onChange={(e) => updateForm("correspondentBank", e.target.value)} />
                    </div>
                    <VerifiedBankField
                      id="corrSwift"
                      label="Correspondent SWIFT"
                      kind="bic"
                      maxLength={11}
                      placeholder="SWIFT/BIC"
                      value={form.correspondentSwift}
                      onChange={(v) => updateForm("correspondentSwift", v)}
                      onResolved={(info) => {
                        if (info && !form.correspondentBank) updateForm("correspondentBank", info.name)
                      }}
                    />
                    <div className="space-y-2">
                      <Label htmlFor="intBank">Intermediary Bank</Label>
                      <Input id="intBank" placeholder="Intermediary bank name" value={form.intermediaryBank} onChange={(e) => updateForm("intermediaryBank", e.target.value)} />
                    </div>
                    <VerifiedBankField
                      id="intSwift"
                      label="Intermediary SWIFT"
                      kind="bic"
                      maxLength={11}
                      placeholder="SWIFT/BIC"
                      value={form.intermediarySwift}
                      onChange={(v) => updateForm("intermediarySwift", v)}
                      onResolved={(info) => {
                        if (info && !form.intermediaryBank) updateForm("intermediaryBank", info.name)
                      }}
                    />
                  </div>
                </div>

                {/* Notes */}
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea id="notes" placeholder="Additional notes or payment instructions" rows={3} value={form.notes} onChange={(e) => updateForm("notes", e.target.value)} />
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center">
                {formError && (
                  <p className="text-sm text-red-400 sm:mr-auto sm:text-left">{formError}</p>
                )}
                <Button
                  variant="outline"
                  disabled={savingBeneficiary}
                  onClick={() => { setIsAddDialogOpen(false); setFormError(null) }}
                >
                  Cancel
                </Button>
                <Button onClick={handleAddBeneficiary} disabled={savingBeneficiary}>
                  {savingBeneficiary ? "Saving…" : editingBeneficiary ? "Save Changes" : "Add Beneficiary"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Beneficiaries</p>
                <p className="text-2xl font-bold text-foreground">{stats.total}</p>
              </div>
              <div className="rounded-full bg-primary/10 p-3">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active</p>
                <p className="text-2xl font-bold text-emerald-400">{stats.active}</p>
              </div>
              <div className="rounded-full bg-emerald-500/10 p-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending Verification</p>
                <p className="text-2xl font-bold text-amber-400">{stats.pending}</p>
              </div>
              <div className="rounded-full bg-amber-500/10 p-3">
                <Clock className="h-5 w-5 text-amber-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Favorites</p>
                <p className="text-2xl font-bold text-primary">{stats.favorites}</p>
              </div>
              <div className="rounded-full bg-primary/10 p-3">
                <Star className="h-5 w-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, IBAN, SWIFT, bank..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="corporate">Corporate</SelectItem>
                  <SelectItem value="financial_institution">Financial Institution</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs and Table */}
      <Card className="bg-card border-border">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <CardHeader className="pb-0">
            <TabsList className="w-full justify-start bg-muted/30">
              <TabsTrigger value="all" className="data-[state=active]:bg-background">
                All ({beneficiaries.length})
              </TabsTrigger>
              <TabsTrigger value="favorites" className="data-[state=active]:bg-background">
                Favorites ({stats.favorites})
              </TabsTrigger>
              <TabsTrigger value="corporate" className="data-[state=active]:bg-background">
                Corporate
              </TabsTrigger>
              <TabsTrigger value="financial" className="data-[state=active]:bg-background">
                Financial Inst.
              </TabsTrigger>
              <TabsTrigger value="individual" className="data-[state=active]:bg-background">
                Individual
              </TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead className="w-[30px]"></TableHead>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Bank Details</TableHead>
                    <TableHead>IBAN / Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Risk</TableHead>
                    <TableHead className="text-right">Volume</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBeneficiaries.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={8}>
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                            <User className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <p className="text-sm font-medium text-foreground">No beneficiaries yet</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Add a beneficiary to start sending payments
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredBeneficiaries.map((ben) => (
                    <TableRow
                      key={ben.id}
                      className="cursor-pointer hover:bg-muted/20"
                      onClick={() => router.push(`/dashboard/beneficiaries/${encodeURIComponent(ben.id)}`)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <button className="text-muted-foreground hover:text-primary transition-colors">
                          {ben.isFavorite ? (
                            <Star className="h-4 w-4 fill-primary text-primary" />
                          ) : (
                            <StarOff className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                            {getTypeIcon(ben.type)}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{ben.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {ben.alias || ben.beneficiaryCity}, {ben.beneficiaryCountry}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium text-foreground">{ben.bankName}</p>
                          <p className="text-xs font-mono text-muted-foreground">{ben.swiftBic}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="font-mono text-sm text-foreground">
                          {ben.iban ? ben.iban.substring(0, 20) + "..." : ben.accountNumber}
                        </p>
                        <p className="text-xs text-muted-foreground">{ben.currency}</p>
                      </TableCell>
                      <TableCell>{getStatusBadge(ben.status)}</TableCell>
                      <TableCell>{getRiskBadge(ben.riskLevel)}</TableCell>
                      <TableCell className="text-right">
                        <p className="font-medium text-foreground">
                          {formatCurrency(ben.totalVolume, ben.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {ben.totalTransactions} transactions
                        </p>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Actions</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => viewBeneficiary(ben)}>
                              <FileText className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => editBeneficiary(ben)}>
                              <Edit className="mr-2 h-4 w-4" />
                              Modify
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => duplicateBeneficiary(ben)}>
                              <Copy className="mr-2 h-4 w-4" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {ben.status === "cancelled" ? (
                              <DropdownMenuItem onClick={() => reactivateBeneficiary(ben)}>
                                <RotateCcw className="mr-2 h-4 w-4" />
                                Reactivate
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => cancelBeneficiary(ben)}>
                                <Ban className="mr-2 h-4 w-4" />
                                Cancel
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-red-400"
                              onClick={() => deleteBeneficiary(ben)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Tabs>
      </Card>

      {/* View Beneficiary Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {selectedBeneficiary && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    {getTypeIcon(selectedBeneficiary.type)}
                  </div>
                  <div>
                    <DialogTitle className="text-xl">{selectedBeneficiary.name}</DialogTitle>
                    <DialogDescription className="flex items-center gap-2">
                      {selectedBeneficiary.alias && <span>{selectedBeneficiary.alias}</span>}
                      <span>-</span>
                      <span>{selectedBeneficiary.id}</span>
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="space-y-6 py-4">
                {/* Status Row */}
                <div className="flex items-center gap-4">
                  {getStatusBadge(selectedBeneficiary.status)}
                  {getRiskBadge(selectedBeneficiary.riskLevel)}
                  {selectedBeneficiary.kycVerified && (
                    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      KYC Verified
                    </Badge>
                  )}
                </div>

                {/* Beneficiary Details */}
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <h3 className="font-semibold text-foreground border-b border-border pb-2">
                      Beneficiary Information
                    </h3>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Type</p>
                        <p className="font-medium text-foreground capitalize">
                          {selectedBeneficiary.type.replace("_", " ")}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Address</p>
                        <p className="font-medium text-foreground">{selectedBeneficiary.beneficiaryAddress}</p>
                        <p className="text-sm text-muted-foreground">
                          {selectedBeneficiary.beneficiaryCity}, {selectedBeneficiary.beneficiaryPostalCode}
                        </p>
                        <p className="text-sm text-muted-foreground">{selectedBeneficiary.beneficiaryCountry}</p>
                      </div>
                      {selectedBeneficiary.registrationNumber && (
                        <div>
                          <p className="text-xs text-muted-foreground">Registration Number</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.registrationNumber}</p>
                        </div>
                      )}
                      {selectedBeneficiary.vatNumber && (
                        <div>
                          <p className="text-xs text-muted-foreground">VAT Number</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.vatNumber}</p>
                        </div>
                      )}
                      {selectedBeneficiary.dateOfBirth && (
                        <div>
                          <p className="text-xs text-muted-foreground">Date of Birth</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.dateOfBirth}</p>
                        </div>
                      )}
                      {selectedBeneficiary.nationality && (
                        <div>
                          <p className="text-xs text-muted-foreground">Nationality</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.nationality}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h3 className="font-semibold text-foreground border-b border-border pb-2">
                      Bank Account Details
                    </h3>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Bank Name</p>
                        <p className="font-medium text-foreground">{selectedBeneficiary.bankName}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">SWIFT/BIC</p>
                        <p className="font-mono font-medium text-foreground">{selectedBeneficiary.swiftBic}</p>
                      </div>
                      {selectedBeneficiary.iban && (
                        <div>
                          <p className="text-xs text-muted-foreground">IBAN</p>
                          <p className="font-mono text-sm font-medium text-foreground break-all">
                            {selectedBeneficiary.iban}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-xs text-muted-foreground">Account Number</p>
                        <p className="font-mono font-medium text-foreground">{selectedBeneficiary.accountNumber}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Currency</p>
                        <p className="font-medium text-foreground">{selectedBeneficiary.currency}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Bank Address</p>
                        <p className="text-sm text-foreground">{selectedBeneficiary.bankAddress}</p>
                        <p className="text-sm text-muted-foreground">{selectedBeneficiary.bankCountry}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Correspondent Bank */}
                {(selectedBeneficiary.correspondentBank || selectedBeneficiary.intermediaryBank) && (
                  <div className="space-y-4">
                    <h3 className="font-semibold text-foreground border-b border-border pb-2">
                      Correspondent / Intermediary Bank
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      {selectedBeneficiary.correspondentBank && (
                        <div>
                          <p className="text-xs text-muted-foreground">Correspondent Bank</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.correspondentBank}</p>
                          <p className="font-mono text-sm text-muted-foreground">
                            {selectedBeneficiary.correspondentSwift}
                          </p>
                        </div>
                      )}
                      {selectedBeneficiary.intermediaryBank && (
                        <div>
                          <p className="text-xs text-muted-foreground">Intermediary Bank</p>
                          <p className="font-medium text-foreground">{selectedBeneficiary.intermediaryBank}</p>
                          <p className="font-mono text-sm text-muted-foreground">
                            {selectedBeneficiary.intermediarySwift}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Transaction History */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground border-b border-border pb-2">
                    Transaction Summary
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="rounded-lg bg-muted/30 p-4">
                      <p className="text-xs text-muted-foreground">Total Transactions</p>
                      <p className="text-2xl font-bold text-foreground">{selectedBeneficiary.totalTransactions}</p>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-4">
                      <p className="text-xs text-muted-foreground">Total Volume</p>
                      <p className="text-2xl font-bold text-foreground">
                        {formatCurrency(selectedBeneficiary.totalVolume, selectedBeneficiary.currency)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-muted/30 p-4">
                      <p className="text-xs text-muted-foreground">Last Used</p>
                      <p className="text-xl font-bold text-foreground">
                        {selectedBeneficiary.lastUsed || "Never"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Compliance */}
                <div className="space-y-4">
                  <h3 className="font-semibold text-foreground border-b border-border pb-2">
                    Compliance & Risk
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">KYC Status</p>
                      <p className="font-medium text-foreground">
                        {selectedBeneficiary.kycVerified ? "Verified" : "Pending"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">AML Screening Date</p>
                      <p className="font-medium text-foreground">
                        {selectedBeneficiary.amlScreeningDate || "Not screened"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Created</p>
                      <p className="font-medium text-foreground">{selectedBeneficiary.createdAt}</p>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                {selectedBeneficiary.notes && (
                  <div className="space-y-2">
                    <h3 className="font-semibold text-foreground border-b border-border pb-2">Notes</h3>
                    <p className="text-sm text-muted-foreground">{selectedBeneficiary.notes}</p>
                  </div>
                )}
              </div>

              <DialogFooter>
              <Button variant="outline" onClick={() => setIsViewDialogOpen(false)}>
                Close
              </Button>
              <Button
                variant="outline"
                onClick={() => selectedBeneficiary && editBeneficiary(selectedBeneficiary)}
              >
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
              <Button onClick={() => selectedBeneficiary && sendPaymentTo(selectedBeneficiary)}>
                Send Payment
              </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
