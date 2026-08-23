"use client"

import { useMemo } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, Download, FileText, CheckCircle2, Clock, XCircle, AlertCircle, Ban, ShieldCheck } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useInstrumentRequests, type Instrument } from "@/lib/instrument-requests-store"
import { generateInstrumentCertificate } from "@/lib/certificate-pdf"
import { riskScoreTone } from "@/lib/instrument-audit"

const typeColors: Record<string, string> = {
  SBLC: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  MTN: "bg-green-500/10 text-green-400 border-green-500/20",
  BG: "bg-orange-500/10 text-orange-400 border-orange-500/20",
}

const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  active: { icon: CheckCircle2, color: "text-green-500", bg: "bg-green-500/10" },
  pending: { icon: Clock, color: "text-yellow-500", bg: "bg-yellow-500/10" },
  rejected: { icon: XCircle, color: "text-red-500", bg: "bg-red-500/10" },
  expired: { icon: AlertCircle, color: "text-red-500", bg: "bg-red-500/10" },
  cancelled: { icon: Ban, color: "text-muted-foreground", bg: "bg-muted" },
}

const formatCurrency = (value: number, currency: string) => {
  const symbols: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF " }
  return `${symbols[currency] ?? `${currency} `}${value.toLocaleString()}`
}

export default function InstrumentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { instruments, hydrated } = useInstrumentRequests()

  const id = decodeURIComponent(params.id)
  const instrument = useMemo(() => instruments.find((i) => i.id === id), [instruments, id])

  if (hydrated && !instrument) {
    return (
      <div className="mx-auto max-w-2xl">
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href="/dashboard/instruments">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Instruments
          </Link>
        </Button>
        <Card className="bg-card border-border">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary mb-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Instrument not found</p>
            <p className="text-xs text-muted-foreground mt-1">
              No instrument matches <code className="text-foreground">{id}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!instrument) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="h-9 w-40 animate-pulse rounded-md bg-secondary" />
        <div className="mt-4 h-64 animate-pulse rounded-xl bg-secondary" />
      </div>
    )
  }

  const downloadCertificate = (inst: Instrument) => {
    generateInstrumentCertificate({
      id: inst.id,
      type: inst.type,
      typeFull: inst.typeFull,
      issuer: inst.issuer,
      faceValue: formatCurrency(inst.faceValue, inst.currency),
      currency: inst.currency,
      status: inst.status,
      rating: inst.rating,
      purpose: inst.purpose,
      issuedDate: inst.issuedDate,
      expiryDate: inst.expiryDate,
      assignable: inst.assignable,
      monetizable: inst.monetizable,
      isin: inst.isin,
      commonCode: inst.commonCode,
      cusip: inst.cusip,
      serialNumber: inst.serialNumber,
      issuerBic: inst.issuerBic,
      issuerAddress: inst.issuerAddress,
      issuerCountry: inst.issuerCountry,
      placeOfIssue: inst.placeOfIssue,
      governingLaw: inst.governingLaw,
      deliveryMethod: inst.deliveryMethod,
      form: inst.form,
    })
    toast.success("Certificate downloaded", {
      description: `The certificate for ${inst.id} has been generated as a PDF.`,
    })
  }

  const status = statusConfig[instrument.status] ?? statusConfig.pending
  const StatusIcon = status.icon

  // Securities / settlement identifiers (ISIN, Common Code, serial, etc.).
  const identifierFields: [string, string][] = []
  if (instrument.isin) identifierFields.push(["ISIN", instrument.isin])
  if (instrument.commonCode) identifierFields.push(["Common Code", instrument.commonCode])
  if (instrument.cusip) identifierFields.push(["CUSIP", instrument.cusip])
  if (instrument.serialNumber) identifierFields.push(["Serial / Reference", instrument.serialNumber])
  if (instrument.form) identifierFields.push(["Form", instrument.form])
  if (instrument.governingLaw) identifierFields.push(["Governing Rules", instrument.governingLaw])
  if (instrument.deliveryMethod) identifierFields.push(["Delivery", instrument.deliveryMethod])
  if (instrument.placeOfIssue) identifierFields.push(["Place of Issue", instrument.placeOfIssue])

  // Issuing-bank particulars (verified BIC + registered address).
  const bankFields: [string, string][] = [["Issuing Bank", instrument.issuer]]
  if (instrument.issuerBic) bankFields.push(["SWIFT / BIC", instrument.issuerBic])
  if (instrument.issuerAddress) bankFields.push(["Registered Office", instrument.issuerAddress])
  if (instrument.issuerCountry) bankFields.push(["Country", instrument.issuerCountry])

  const fields: [string, string][] = [
    ["Credit Rating", instrument.rating],
    ["Purpose", instrument.purpose],
    ["Status", instrument.status.charAt(0).toUpperCase() + instrument.status.slice(1)],
    ["Issued Date", instrument.issuedDate],
    ["Expiry Date", instrument.expiryDate],
    ["Days Remaining", `${instrument.daysRemaining} days`],
    ["Assignable", instrument.assignable ? "Yes" : "No"],
    ["Monetizable", instrument.monetizable ? "Yes" : "No"],
  ]
  if (instrument.decisionNote) fields.push(["Administrator Note", instrument.decisionNote])

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button variant="outline" size="sm" onClick={() => downloadCertificate(instrument)}>
          <Download className="mr-2 h-4 w-4" />
          Certificate
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="border-b border-border">
          <div className="flex items-center gap-3">
            <div className={cn("flex h-10 w-10 items-center justify-center rounded-full", status.bg)}>
              <StatusIcon className={cn("h-5 w-5", status.color)} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("text-[10px]", typeColors[instrument.type] ?? "")}
                >
                  {instrument.type}
                </Badge>
                <CardTitle className="text-lg font-bold text-foreground break-all">
                  {instrument.id}
                </CardTitle>
              </div>
              <p className="text-xs text-muted-foreground">{instrument.typeFull}</p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-6">
          <div className="rounded-lg border border-border bg-secondary/30 p-4 text-center">
            <p className="text-xs text-muted-foreground">Face Value</p>
            <p className="mt-1 text-3xl font-bold text-foreground">
              {formatCurrency(instrument.faceValue, instrument.currency)}
            </p>
            {instrument.isin && (
              <p className="mt-1 font-mono text-xs tracking-wider text-muted-foreground">
                ISIN {instrument.isin}
              </p>
            )}
          </div>

          {identifierFields.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Securities Identifiers
              </p>
              <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                {identifierFields.map(([label, value]) => (
                  <div key={label} className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-0.5 font-mono text-sm font-medium text-foreground break-words">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Issuing Bank
            </p>
            <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {bankFields.map(([label, value]) => (
                <div key={label} className="bg-card p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Instrument Terms
            </p>
            <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {fields.map(([label, value]) => (
                <div key={label} className="bg-card p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground break-words">{value}</p>
                </div>
              ))}
            </div>
          </div>

          {instrument.audit && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                Independent Audit &amp; Valuation
              </p>
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                {/* Realistic assessed value clearly distinguished from face value */}
                <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">Stated face value</p>
                    <p className="mt-0.5 text-sm font-medium text-muted-foreground line-through decoration-muted-foreground/40">
                      {formatCurrency(instrument.audit.faceValue, instrument.audit.currency)}
                    </p>
                  </div>
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">Realistic assessed value</p>
                    <p className="mt-0.5 text-sm font-bold text-foreground">
                      {formatCurrency(instrument.audit.realisticValue, instrument.audit.currency)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {(instrument.audit.realisticPct * 100).toFixed(1)}% of stated face
                    </p>
                  </div>
                </div>

                <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">Risk score</p>
                    <p
                      className={cn(
                        "mt-0.5 text-sm font-bold",
                        riskScoreTone(instrument.audit.riskScore) === "positive"
                          ? "text-green-600 dark:text-green-500"
                          : riskScoreTone(instrument.audit.riskScore) === "neutral"
                            ? "text-amber-600 dark:text-amber-500"
                            : "text-red-600 dark:text-red-500",
                      )}
                    >
                      {instrument.audit.riskScore}/100
                    </p>
                  </div>
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">Classification rating</p>
                    <p className="mt-0.5 text-sm font-bold text-foreground">{instrument.audit.rating}</p>
                  </div>
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">Valid for monetization</p>
                    <p className="mt-0.5 text-sm font-medium text-foreground">
                      {instrument.audit.monetizationEligible
                        ? `Up to ${(instrument.audit.allowedMonetizationPct * 100).toFixed(0)}% LTV`
                        : "Not eligible"}
                    </p>
                  </div>
                  <div className="bg-card p-3">
                    <p className="text-xs text-muted-foreground">PPI insurance for trade</p>
                    <p className="mt-0.5 text-sm font-medium text-foreground">
                      {instrument.audit.ppiRequired ? "Required" : "Not required"}
                    </p>
                  </div>
                </div>

                {instrument.audit.summary && (
                  <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{instrument.audit.summary}</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Independent assessment · engine {instrument.audit.engineVersion}
                  {instrument.audit.publishedAt
                    ? ` · published ${new Date(instrument.audit.publishedAt).toLocaleDateString()}`
                    : ""}
                  . Assessed value is an independent estimate and may differ from the stated face value.
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="w-full" onClick={() => downloadCertificate(instrument)}>
              <Download className="mr-2 h-4 w-4" />
              Download Certificate
            </Button>
            <Button variant="outline" className="w-full bg-transparent" asChild>
              <Link href={`/dashboard/instruments/${encodeURIComponent(instrument.id)}/document`}>
                <FileText className="mr-2 h-4 w-4" />
                View Hard Copy
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
