"use client"

import { useMemo } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  ArrowLeft,
  Building2,
  User,
  Globe,
  CheckCircle2,
  Send,
  Copy,
  Users,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { useBeneficiaries, type Beneficiary, type BeneficiaryType } from "@/lib/beneficiaries-store"

function statusBadge(status: Beneficiary["status"]) {
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

function riskBadge(risk: Beneficiary["riskLevel"]) {
  switch (risk) {
    case "low":
      return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Low Risk</Badge>
    case "medium":
      return <Badge variant="outline" className="text-amber-400 border-amber-500/30">Medium Risk</Badge>
    case "high":
      return <Badge variant="outline" className="text-red-400 border-red-500/30">High Risk</Badge>
  }
}

function typeIcon(type: BeneficiaryType) {
  switch (type) {
    case "individual":
      return <User className="h-5 w-5" />
    case "corporate":
      return <Building2 className="h-5 w-5" />
    case "financial_institution":
      return <Globe className="h-5 w-5" />
  }
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function Field({ label, value, mono }: { label: string; value?: string | number; mono?: boolean }) {
  if (value === undefined || value === null || value === "") return null
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-medium text-foreground break-all ${mono ? "font-mono text-sm" : ""}`}>{value}</p>
    </div>
  )
}

export default function BeneficiaryDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { beneficiaries } = useBeneficiaries()

  const id = decodeURIComponent(params.id)
  const ben = useMemo(() => beneficiaries.find((b) => b.id === id), [beneficiaries, id])

  if (!ben) {
    return (
      <div className="mx-auto max-w-3xl">
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href="/dashboard/beneficiaries">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Beneficiaries
          </Link>
        </Button>
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Beneficiary not found</p>
            <p className="text-xs text-muted-foreground mt-1">
              No beneficiary matches <code className="text-foreground">{id}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const copy = (value: string, label: string) =>
    navigator.clipboard?.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Could not copy"),
    )

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={() => router.push("/dashboard/payments")}>
          <Send className="mr-2 h-4 w-4" />
          Send Payment
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {typeIcon(ben.type)}
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-xl font-bold text-foreground break-words">{ben.name}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {ben.alias ? `${ben.alias} · ` : ""}
                {ben.id}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {statusBadge(ben.status)}
                {riskBadge(ben.riskLevel)}
                {ben.kycVerified && (
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    KYC Verified
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 pt-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <h3 className="border-b border-border pb-2 font-semibold text-foreground">
                Beneficiary Information
              </h3>
              <Field label="Type" value={ben.type.replace("_", " ")} />
              <div>
                <p className="text-xs text-muted-foreground">Address</p>
                <p className="font-medium text-foreground">{ben.beneficiaryAddress}</p>
                <p className="text-sm text-muted-foreground">
                  {ben.beneficiaryCity}
                  {ben.beneficiaryPostalCode ? `, ${ben.beneficiaryPostalCode}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">{ben.beneficiaryCountry}</p>
              </div>
              <Field label="Registration Number" value={ben.registrationNumber} />
              <Field label="VAT Number" value={ben.vatNumber} />
              <Field label="Date of Birth" value={ben.dateOfBirth} />
              <Field label="Nationality" value={ben.nationality} />
            </div>

            <div className="space-y-3">
              <h3 className="border-b border-border pb-2 font-semibold text-foreground">
                Bank Account Details
              </h3>
              <Field label="Bank Name" value={ben.bankName} />
              <div className="flex items-end justify-between gap-2">
                <Field label="SWIFT/BIC" value={ben.swiftBic} mono />
                <button
                  type="button"
                  onClick={() => copy(ben.swiftBic, "SWIFT/BIC")}
                  className="text-muted-foreground transition-colors hover:text-primary"
                  aria-label="Copy SWIFT/BIC"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              {ben.iban && (
                <div className="flex items-end justify-between gap-2">
                  <Field label="IBAN" value={ben.iban} mono />
                  <button
                    type="button"
                    onClick={() => copy(ben.iban as string, "IBAN")}
                    className="text-muted-foreground transition-colors hover:text-primary"
                    aria-label="Copy IBAN"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <Field label="Account Number" value={ben.accountNumber} mono />
              <Field label="Currency" value={ben.currency} />
              <div>
                <p className="text-xs text-muted-foreground">Bank Address</p>
                <p className="text-sm text-foreground">{ben.bankAddress}</p>
                <p className="text-sm text-muted-foreground">{ben.bankCountry}</p>
              </div>
            </div>
          </div>

          {(ben.correspondentBank || ben.intermediaryBank) && (
            <div className="space-y-3">
              <h3 className="border-b border-border pb-2 font-semibold text-foreground">
                Correspondent / Intermediary Bank
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {ben.correspondentBank && (
                  <div>
                    <p className="text-xs text-muted-foreground">Correspondent Bank</p>
                    <p className="font-medium text-foreground">{ben.correspondentBank}</p>
                    <p className="font-mono text-sm text-muted-foreground">{ben.correspondentSwift}</p>
                  </div>
                )}
                {ben.intermediaryBank && (
                  <div>
                    <p className="text-xs text-muted-foreground">Intermediary Bank</p>
                    <p className="font-medium text-foreground">{ben.intermediaryBank}</p>
                    <p className="font-mono text-sm text-muted-foreground">{ben.intermediarySwift}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <h3 className="border-b border-border pb-2 font-semibold text-foreground">
              Transaction Summary
            </h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg bg-secondary/40 p-4">
                <p className="text-xs text-muted-foreground">Total Transactions</p>
                <p className="text-2xl font-bold text-foreground">{ben.totalTransactions}</p>
              </div>
              <div className="rounded-lg bg-secondary/40 p-4">
                <p className="text-xs text-muted-foreground">Total Volume</p>
                <p className="text-2xl font-bold text-foreground">
                  {formatCurrency(ben.totalVolume, ben.currency)}
                </p>
              </div>
              <div className="rounded-lg bg-secondary/40 p-4">
                <p className="text-xs text-muted-foreground">Last Used</p>
                <p className="text-xl font-bold text-foreground">{ben.lastUsed || "Never"}</p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="border-b border-border pb-2 font-semibold text-foreground">
              Compliance &amp; Risk
            </h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="KYC Status" value={ben.kycVerified ? "Verified" : "Pending"} />
              <Field label="AML Screening Date" value={ben.amlScreeningDate || "Not screened"} />
              <Field label="Created" value={ben.createdAt} />
            </div>
          </div>

          {ben.notes && (
            <div className="space-y-2">
              <h3 className="border-b border-border pb-2 font-semibold text-foreground">Notes</h3>
              <p className="text-sm text-muted-foreground">{ben.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
