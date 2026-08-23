"use client"

import { FileText, Download, Ship, ShieldCheck, ShieldAlert, ShieldQuestion, Anchor } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { blobFileUrl } from "@/lib/kyc-types"
import { downloadFile } from "@/lib/download-file"
import { VESSEL_TYPE_LABELS, VESSEL_STATUS_LABELS, type Vessel } from "@/lib/spot-deals-shared"
import { VesselLivePositionLine } from "@/components/dashboard/vessel-live-position"

/** A single stored document version (matches the commodity store shape). */
interface DocVersion {
  version: number
  fileName: string
  reference?: string
  issuedBy?: string
  issueDate?: string
  notes?: string
  uploadedAt?: string
  blobPathname?: string
  fileSize?: number
  contentType?: string
}
interface DealDoc {
  id: string
  module: string
  docType: string
  status: "submitted" | "verified" | "rejected"
  currentVersion: number
  versions: DocVersion[]
  swiftRef?: string
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

const DOC_STATUS_STYLE: Record<DealDoc["status"], string> = {
  verified: "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400",
  rejected: "border-destructive/30 bg-destructive/10 text-destructive",
  submitted: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}
const DOC_STATUS_LABEL: Record<DealDoc["status"], string> = {
  verified: "Verified",
  rejected: "Rejected",
  submitted: "Received",
}

/**
 * Read-only presentation of the administrator-issued deal documents and the
 * assigned vessel. Shared by the deal owner's own page and the shared-deal
 * (visibility-only) page — neither can mutate anything here. PDFs are streamed
 * through the authorized /api/file proxy using the viewer's own session.
 */
export function DealVesselDocsView({
  vessel,
  documents,
}: {
  vessel?: Vessel | null
  documents?: DealDoc[] | null
}) {
  const dealDocs = (documents ?? []).filter((d) => d?.module === "DEAL")

  if (!vessel && dealDocs.length === 0) return null

  return (
    <div className="space-y-4">
      {vessel ? <VesselCard vessel={vessel} /> : null}
      {dealDocs.length > 0 ? <DocsCard docs={dealDocs} /> : null}
    </div>
  )
}

function VesselCard({ vessel }: { vessel: Vessel }) {
  const compliance = vessel.compliance
  const ComplianceIcon =
    compliance?.status === "clear"
      ? ShieldCheck
      : compliance?.status === "flagged"
        ? ShieldAlert
        : ShieldQuestion
  const complianceStyle =
    compliance?.status === "clear"
      ? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"
      : compliance?.status === "flagged"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
  const complianceLabel =
    compliance?.status === "clear"
      ? "Sanctions clear"
      : compliance?.status === "flagged"
        ? "Sanctions FLAGGED"
        : "Screening unverified"

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Ship className="h-4 w-4 text-primary" />
          Assigned vessel
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-foreground">{vessel.name}</p>
            <p className="text-xs text-muted-foreground">
              IMO {vessel.imo}
              {vessel.flag ? ` · Flag: ${vessel.flag}` : ""}
              {vessel.builtYear ? ` · Built ${vessel.builtYear}` : ""}
            </p>
          </div>
          {compliance ? (
            <Badge variant="outline" className={`gap-1 text-[10px] ${complianceStyle}`}>
              <ComplianceIcon className="h-3 w-3" />
              {complianceLabel}
            </Badge>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <Field label="Type" value={VESSEL_TYPE_LABELS[vessel.type]} />
          {vessel.vesselClass ? <Field label="Class" value={vessel.vesselClass} /> : null}
          <Field
            label="Capacity"
            value={`${vessel.capacity.toLocaleString()} ${vessel.capacityUnit}`}
          />
          <Field label="Status" value={VESSEL_STATUS_LABELS[vessel.status]} />
          <Field label="Location" value={vessel.location} icon={<Anchor className="h-3 w-3" />} />
          {vessel.cargo ? <Field label="Cargo" value={vessel.cargo} /> : null}
        </div>

        {/* Real-time AIS position (live provider only; honest state otherwise). */}
        <div className="rounded-md border border-border bg-muted/30 p-2">
          <VesselLivePositionLine imo={vessel.imo} />
        </div>

        {compliance?.status === "flagged" && compliance.matches.length > 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <p className="font-medium">Sanctions match — do not transact:</p>
            <ul className="mt-1 list-inside list-disc">
              {compliance.matches.map((m, i) => (
                <li key={i}>
                  {m.name}
                  {m.programs.length ? ` (${m.programs.join(", ")})` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {compliance ? (
          <p className="text-[11px] text-muted-foreground">
            Screened {formatDate(compliance.checkedAt)}
            {compliance.sources.length ? ` · ${compliance.sources.join(", ")}` : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Field({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <p className="flex items-center gap-1 font-medium text-foreground">
        {icon}
        {value}
      </p>
    </div>
  )
}

function DocsCard({ docs }: { docs: DealDoc[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileText className="h-4 w-4 text-primary" />
          Deal documents
          <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
            {docs.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {docs.map((doc) => {
          const current = doc.versions?.[doc.versions.length - 1]
          const pathname = current?.blobPathname
          return (
            <div
              key={doc.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">{doc.docType}</p>
                  <Badge variant="outline" className={`text-[10px] ${DOC_STATUS_STYLE[doc.status]}`}>
                    {DOC_STATUS_LABEL[doc.status]}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {current?.fileName || "Document"}
                  {current?.reference ? ` · Ref: ${current.reference}` : ""}
                  {current?.issuedBy ? ` · ${current.issuedBy}` : ""}
                  {doc.swiftRef ? ` · SWIFT: ${doc.swiftRef}` : ""}
                  {current?.fileSize ? ` · ${formatBytes(current.fileSize)}` : ""}
                </p>
                {current?.notes ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{current.notes}</p>
                ) : null}
              </div>
              {pathname ? (
                <button
                  type="button"
                  onClick={() => void downloadFile(blobFileUrl(pathname), current?.fileName || `${doc.docType}.pdf`)}
                  className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download PDF
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">Metadata only</span>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
