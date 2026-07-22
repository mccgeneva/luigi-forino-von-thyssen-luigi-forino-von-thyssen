"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Award,
  BadgeCheck,
  ShieldCheck,
  Wallet,
  Landmark,
  Download,
  Eye,
  Clock,
  Check,
  X,
  FileText,
  History,
  Plus,
  Trash2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
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
import { useCurrentUser } from "@/lib/use-current-user"
import { useLedger, convertCurrency } from "@/lib/ledger-store"
import { useActivityLog } from "@/components/activity-tracker"
import {
  useCertificateRequests,
  CERTIFICATE_TYPE_LABELS,
  CERTIFICATE_TYPE_DESCRIPTIONS,
  type CertificateType,
  type CertificateRequest,
  type CertificateBalance,
} from "@/lib/certificates-store"
import { generateAccountCertificate } from "@/lib/certificate-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { CertificateDocument } from "@/components/dashboard/certificate-document"

const TYPE_ICONS: Record<CertificateType, typeof Award> = {
  "good-standing": BadgeCheck,
  endorsement: Award,
  "proof-of-funds": Wallet,
  ownership: ShieldCheck,
}

const TYPE_ORDER: CertificateType[] = ["good-standing", "endorsement", "proof-of-funds", "ownership"]

const statusStyles: Record<CertificateRequest["status"], string> = {
  pending: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  approved: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  rejected: "border-red-500/20 bg-red-500/10 text-red-400",
}

const statusLabel: Record<CertificateRequest["status"], string> = {
  pending: "Pending approval",
  approved: "Issued",
  rejected: "Declined",
}

function bankingValue(banking: { label: string; value: string }[], label: string): string | undefined {
  return banking.find((b) => b.label.toLowerCase() === label.toLowerCase())?.value
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

export default function CertificatesPage() {
  const user = useCurrentUser()
  const { balanceFor, totalIn, currencies } = useLedger()
  const { requests, hydrated, addRequest, recordDownload, deleteRequest } = useCertificateRequests()
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const router = useRouter()

  // ---- Account holder + banking snapshot fields ----------------------------
  const banking = (user.banking ?? []) as { label: string; value: string }[]
  const holderName = user.company || user.fullName
  const bankName = bankingValue(banking, "Bank Name")
  const bankAddress = bankingValue(banking, "Bank Address")
  const beneficiaryAddress = bankingValue(banking, "Beneficiary Address")
  const iban = bankingValue(banking, "IBAN")
  const bic = bankingValue(banking, "BIC / SWIFT")

  // ---- Request dialog state ------------------------------------------------
  const [dialogOpen, setDialogOpen] = useState(false)
  const [type, setType] = useState<CertificateType>("good-standing")
  const [accountScope, setAccountScope] = useState("master")
  const [purpose, setPurpose] = useState("")
  const [addressee, setAddressee] = useState("")

  // ---- Preview / audit dialogs ---------------------------------------------
  const [previewReq, setPreviewReq] = useState<CertificateRequest | null>(null)
  const [auditReq, setAuditReq] = useState<CertificateRequest | null>(null)
  const [deleteReq, setDeleteReq] = useState<CertificateRequest | null>(null)
  const [deleting, setDeleting] = useState(false)

  const accountOptions = useMemo(() => {
    const opts = [{ id: "master", label: "Master Account — All Currencies" }]
    for (const cur of [...currencies].sort()) {
      opts.push({ id: `cur:${cur}`, label: `${cur} Settlement Account` })
    }
    return opts
  }, [currencies])

  const accountLabel = accountOptions.find((o) => o.id === accountScope)?.label ?? "Master Account"

  // Build the verified balance snapshot for the chosen scope.
  const buildSnapshot = (scope: string): { balances: CertificateBalance[]; totalEur: number; displayCurrency: string } => {
    if (scope.startsWith("cur:")) {
      const cur = scope.slice(4)
      const amount = balanceFor(cur)
      return {
        balances: [{ currency: cur, amount }],
        totalEur: convertCurrency(amount, cur, "EUR"),
        displayCurrency: cur,
      }
    }
    const balances = [...currencies]
      .sort()
      .map((cur) => ({ currency: cur, amount: balanceFor(cur) }))
      .filter((b) => Math.abs(b.amount) > 0.005)
    const totalEur = totalIn("EUR")
    // Headline currency = the one with the largest EUR-converted value, else EUR.
    const displayCurrency =
      balances
        .slice()
        .sort((a, b) => convertCurrency(b.amount, b.currency, "EUR") - convertCurrency(a.amount, a.currency, "EUR"))[0]
        ?.currency ?? "EUR"
    return { balances: balances.length ? balances : [{ currency: "EUR", amount: 0 }], totalEur, displayCurrency }
  }

  // Live preview reflecting the in-progress request form.
  const draftPreview = useMemo(() => {
    const snap = buildSnapshot(accountScope)
    return {
      type,
      reference: "MCC-XXX-PREVIEW",
      verificationCode: "XXXX-XXXX-XXXX",
      version: 1,
      status: "pending" as const,
      accountLabel,
      purpose,
      addressee: addressee.trim() || undefined,
      holderName,
      holderCompany: user.company,
      bankName,
      bankAddress,
      iban,
      bic,
      ...snap,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, accountScope, purpose, addressee, holderName, bankName, bankAddress, iban, bic, currencies])

  const openRequest = (t: CertificateType) => {
    setType(t)
    setAccountScope("master")
    setPurpose("")
    setAddressee("")
    setDialogOpen(true)
  }

  const submitRequest = () => {
    if (!purpose.trim()) {
      toast.error("Please describe the purpose of the certificate.")
      return
    }
    const snap = buildSnapshot(accountScope)
    const created = addRequest({
      type,
      accountScope,
      accountLabel,
      purpose: purpose.trim(),
      addressee: addressee.trim() || undefined,
      holderName,
      holderCompany: user.company,
      bankName,
      bankAddress,
      beneficiaryAddress,
      iban,
      bic,
      accountEmail: user.accountEmail,
      ...snap,
    })
    logActivity({
      action: `Requested ${CERTIFICATE_TYPE_LABELS[type]}`,
      category: "Certificates",
      details: {
        summary: `Client requested a ${CERTIFICATE_TYPE_LABELS[type]} for "${accountLabel}". Awaiting compliance approval before issuance.`,
        reference: created.reference,
        account: accountLabel,
        purpose: purpose.trim(),
        status: "Pending approval",
      },
    })
    toast.success("Certificate requested", {
      description: "Your request has been sent to the Compliance Office for approval.",
    })
    setDialogOpen(false)
  }

  const download = (req: CertificateRequest) => {
    if (req.status !== "approved") {
      toast.info("Awaiting approval", {
        description: "This certificate must be approved by the Compliance Office before it can be downloaded.",
      })
      return
    }
    show(generateAccountCertificate({
      type: req.type,
      reference: req.reference,
      verificationCode: req.verificationCode,
      issuedDate: req.issuedAt ?? req.decidedAt ?? new Date().toISOString(),
      version: req.version,
      accountLabel: req.accountLabel,
      purpose: req.purpose,
      addressee: req.addressee,
      holderName: req.holderName,
      holderCompany: req.holderCompany,
      bankName: req.bankName,
      bankAddress: req.bankAddress,
      beneficiaryAddress: req.beneficiaryAddress,
      iban: req.iban,
      bic: req.bic,
      accountEmail: req.accountEmail,
      balances: req.balances,
      totalEur: req.totalEur,
      displayCurrency: req.displayCurrency,
    }))
    recordDownload(req.id)
    logActivity({
      action: `Downloaded ${CERTIFICATE_TYPE_LABELS[req.type]}`,
      category: "Certificates",
      details: {
        summary: `Client downloaded the issued ${CERTIFICATE_TYPE_LABELS[req.type]} (${req.reference}).`,
        reference: req.reference,
        version: `Revision ${req.version}`,
      },
    })
  }

  const confirmDelete = async () => {
    if (!deleteReq) return
    setDeleting(true)
    const ok = await deleteRequest(deleteReq.id)
    setDeleting(false)
    if (!ok) {
      toast.error("Could not delete certificate", {
        description: "Please try again in a moment.",
      })
      return
    }
    logActivity({
      action: `Deleted ${CERTIFICATE_TYPE_LABELS[deleteReq.type]}`,
      category: "Certificates",
      details: {
        summary: `Client removed the ${CERTIFICATE_TYPE_LABELS[deleteReq.type]} (${deleteReq.reference}) from their certificates.`,
        reference: deleteReq.reference,
        status: statusLabel[deleteReq.status],
      },
    })
    toast.success("Certificate deleted", {
      description: `${CERTIFICATE_TYPE_LABELS[deleteReq.type]} (${deleteReq.reference}) has been removed.`,
    })
    setDeleteReq(null)
  }

  const pendingCount = requests.filter((r) => r.status === "pending").length
  const issuedCount = requests.filter((r) => r.status === "approved").length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <Award className="h-6 w-6 text-primary" />
            Bank Certificates
          </h1>
          <p className="text-sm text-muted-foreground">
            Request official, compliance-approved certificates for {user.company}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <Badge variant="secondary" className={statusStyles.pending}>
              <Clock className="mr-1 h-3 w-3" />
              {pendingCount} pending
            </Badge>
          )}
          {issuedCount > 0 && (
            <Badge variant="secondary" className={statusStyles.approved}>
              <BadgeCheck className="mr-1 h-3 w-3" />
              {issuedCount} issued
            </Badge>
          )}
        </div>
      </div>

      {/* Certificate types */}
      <div className="grid gap-4 sm:grid-cols-2">
        {TYPE_ORDER.map((t) => {
          const Icon = TYPE_ICONS[t]
          return (
            <Card key={t} className="flex flex-col border-border bg-card">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2.5">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-foreground">{CERTIFICATE_TYPE_LABELS[t]}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {CERTIFICATE_TYPE_DESCRIPTIONS[t]}
                    </p>
                  </div>
                </div>
                <div className="mt-auto pt-2">
                  <Button size="sm" className="w-full" onClick={() => openRequest(t)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Request Certificate
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Compliance note */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-4">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Every certificate is generated from your verified account data and must be approved by the MCC Capital
          Compliance Office before it can be downloaded. Each issued document carries a unique reference, verification
          code, watermark and official seal, and a full audit trail is retained.
        </p>
      </div>

      {/* Your requests */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <FileText className="h-4 w-4 text-primary" />
            Your Certificates
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hydrated ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : requests.length === 0 ? (
            <p className="py-8 text-center text-sm italic text-muted-foreground">
              You have not requested any certificates yet. Choose a certificate type above to get started.
            </p>
          ) : (
            <div className="space-y-3">
              {requests.map((req) => {
                const Icon = TYPE_ICONS[req.type]
                return (
                  <div
                    key={req.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/dashboard/certificates/${encodeURIComponent(req.id)}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        router.push(`/dashboard/certificates/${encodeURIComponent(req.id)}`)
                      }
                    }}
                    className="flex cursor-pointer flex-col gap-3 rounded-lg border border-border bg-secondary/30 p-4 transition-colors hover:border-primary/40 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-primary/10 p-2">
                        <Icon className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {CERTIFICATE_TYPE_LABELS[req.type]}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {req.reference} · {req.accountLabel}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Requested {formatTimestamp(req.submittedAt)}
                          {req.status === "rejected" && req.decisionNote ? ` · ${req.decisionNote}` : ""}
                          {req.status === "approved" ? ` · Issued ${formatTimestamp(req.issuedAt)}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Badge variant="secondary" className={cn("shrink-0", statusStyles[req.status])}>
                        {req.status === "pending" && <Clock className="mr-1 h-3 w-3" />}
                        {req.status === "approved" && <Check className="mr-1 h-3 w-3" />}
                        {req.status === "rejected" && <X className="mr-1 h-3 w-3" />}
                        {statusLabel[req.status]}
                      </Badge>
                      <Button variant="ghost" size="sm" onClick={() => setAuditReq(req)} title="Audit trail">
                        <History className="h-4 w-4" />
                        <span className="sr-only">Audit trail</span>
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPreviewReq(req)}>
                        <Eye className="mr-1.5 h-4 w-4" />
                        Preview
                      </Button>
                      <Button
                        size="sm"
                        disabled={req.status !== "approved"}
                        onClick={() => download(req)}
                        className="bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50"
                      >
                        <Download className="mr-1.5 h-4 w-4" />
                        PDF
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteReq(req)}
                        title="Delete certificate"
                        className="text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">Delete certificate</span>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Request dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Request {CERTIFICATE_TYPE_LABELS[type]}</DialogTitle>
            <DialogDescription>
              The certificate is generated from your verified account data and sent to the Compliance Office for
              approval before it can be downloaded.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Form */}
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Certificate Type</Label>
                <Select value={type} onValueChange={(v) => setType(v as CertificateType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_ORDER.map((t) => (
                      <SelectItem key={t} value={t}>
                        {CERTIFICATE_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Account</Label>
                <Select value={accountScope} onValueChange={setAccountScope}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accountOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {(type === "endorsement" || type === "proof-of-funds") && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Addressee <span className="text-muted-foreground/60">(optional)</span>
                  </Label>
                  <Input
                    value={addressee}
                    onChange={(e) => setAddressee(e.target.value)}
                    placeholder="e.g. The Manager, Correspondent Bank Ltd."
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Purpose</Label>
                <Textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="Describe why you need this certificate (e.g. account opening, tender participation, proof of funds for a transaction)."
                  rows={4}
                />
              </div>

              <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3">
                <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Settlement bank: <span className="text-foreground">{bankName || "MCC Capital"}</span>
                  {iban ? (
                    <>
                      {" "}
                      · IBAN <span className="text-foreground">{iban}</span>
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            {/* Live preview */}
            <div className="rounded-lg border border-border bg-background p-2">
              <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Live preview
              </p>
              <div className="max-h-[60vh] overflow-y-auto">
                <CertificateDocument {...draftPreview} />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitRequest}>
              <Plus className="mr-2 h-4 w-4" />
              Submit for Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!previewReq} onOpenChange={(o) => !o && setPreviewReq(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{previewReq ? CERTIFICATE_TYPE_LABELS[previewReq.type] : "Certificate"}</DialogTitle>
            <DialogDescription>
              {previewReq?.status === "approved"
                ? "Issued certificate preview. Download the PDF for the official, signed and sealed document."
                : "Draft preview. This certificate has not yet been approved for issuance."}
            </DialogDescription>
          </DialogHeader>
          {previewReq && (
            <>
              <CertificateDocument
                type={previewReq.type}
                reference={previewReq.reference}
                verificationCode={previewReq.verificationCode}
                issuedDate={previewReq.issuedAt}
                version={previewReq.version}
                status={previewReq.status}
                accountLabel={previewReq.accountLabel}
                purpose={previewReq.purpose}
                addressee={previewReq.addressee}
                holderName={previewReq.holderName}
                holderCompany={previewReq.holderCompany}
                bankName={previewReq.bankName}
                bankAddress={previewReq.bankAddress}
                iban={previewReq.iban}
                bic={previewReq.bic}
                balances={previewReq.balances}
                totalEur={previewReq.totalEur}
                displayCurrency={previewReq.displayCurrency}
              />
              <DialogFooter>
                <Button
                  disabled={previewReq.status !== "approved"}
                  onClick={() => download(previewReq)}
                  className="bg-amber-500 text-zinc-900 hover:bg-amber-600 disabled:opacity-50"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download PDF
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Audit trail dialog */}
      <Dialog open={!!auditReq} onOpenChange={(o) => !o && setAuditReq(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Audit Trail</DialogTitle>
            <DialogDescription>{auditReq?.reference}</DialogDescription>
          </DialogHeader>
          {auditReq && (
            <ol className="space-y-3">
              {auditReq.events.map((ev, i) => (
                <li key={i} className="flex gap-3">
                  <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {ev.action} <span className="text-xs text-muted-foreground">· {ev.actor}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{formatTimestamp(ev.at)}</p>
                    {ev.note && <p className="mt-0.5 text-xs text-muted-foreground">“{ev.note}”</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteReq} onOpenChange={(o) => !o && !deleting && setDeleteReq(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete certificate?</DialogTitle>
            <DialogDescription>
              {deleteReq
                ? `This permanently removes the ${CERTIFICATE_TYPE_LABELS[deleteReq.type]} (${deleteReq.reference}) from your certificates. This action cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteReq(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleting}
              className="bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
