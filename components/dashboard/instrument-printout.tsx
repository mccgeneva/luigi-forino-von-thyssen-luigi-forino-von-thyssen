"use client"

import { Printer, ShieldCheck, ExternalLink, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import type { MarketplaceInstrument, VerifiedSource } from "@/app/actions/marketplace-instruments"

const SOURCE_LABEL: Record<VerifiedSource, string> = {
  bloomberg: "Bloomberg (live-verified)",
  euroclear: "Euroclear",
  clearstream: "Clearstream",
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString("en-US")}`
  }
}

function fmtDate(v: string | null): string {
  if (!v) return "—"
  const d = new Date(v)
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2 sm:flex-row sm:items-baseline sm:justify-between">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-sm text-foreground ${mono ? "font-mono" : ""} sm:text-right`}>{value}</span>
    </div>
  )
}

export function InstrumentPrintout({
  instrument,
  open,
  onOpenChange,
}: {
  instrument: MarketplaceInstrument | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!instrument) return null
  const i = instrument

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="print:hidden">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Instrument printout
          </DialogTitle>
          <DialogDescription>
            Official tearsheet for this bank instrument. Print or save a copy for your records.
          </DialogDescription>
        </DialogHeader>

        {/* Printable sheet */}
        <div id="instrument-tearsheet" className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3 border-b-2 border-primary/60 pb-3">
            <div>
              <p
                className="text-xl leading-none tracking-tight text-foreground"
                style={{ fontFamily: "var(--font-instrument-serif), Georgia, serif" }}
              >
                {i.typeFull}
              </p>
              <p className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                {i.type} · Bank Instrument Tearsheet
              </p>
            </div>
            <Badge variant="outline" className="gap-1 rounded-sm border-primary/30 bg-primary/5 font-mono text-[10px] text-primary">
              <ShieldCheck className="h-3 w-3" />
              {SOURCE_LABEL[i.verifiedSource]}
            </Badge>
          </div>

          <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
            <div>
              <Row label="ISIN" value={i.isin} mono />
              <Row label="Common Code" value={i.commonCode ?? "Pending ICSD admission"} mono />
              <Row label="Instrument type" value={`${i.type} — ${i.typeFull}`} />
              <Row label="Face value" value={money(i.faceValue, i.currency)} mono />
              <Row label="Currency" value={i.currency} />
              <Row label="Issuer rating" value={i.rating || "—"} />
            </div>
            <div>
              <Row label="Issuing bank" value={i.bankName} />
              <Row label="Bank BIC / SWIFT" value={i.bankBic || "—"} mono />
              <Row label="Country" value={i.bankCountry || "—"} />
              <Row label="Issue date" value={fmtDate(i.issueDate)} />
              <Row label="Maturity date" value={fmtDate(i.maturityDate)} />
              <Row label="Delivery method" value={i.deliveryMethod || "—"} />
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {i.governingLaw ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Governing law / rules</p>
                <p className="text-sm text-foreground text-pretty">{i.governingLaw}</p>
              </div>
            ) : null}
            {i.issuerDetails ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Issuer details</p>
                <p className="text-sm text-foreground text-pretty whitespace-pre-line">{i.issuerDetails}</p>
              </div>
            ) : null}
            {i.beneficiaryTerms ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Beneficiary / transfer terms</p>
                <p className="text-sm text-foreground text-pretty whitespace-pre-line">{i.beneficiaryTerms}</p>
              </div>
            ) : null}
            {i.notes ? (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Notes</p>
                <p className="text-sm text-foreground text-pretty whitespace-pre-line">{i.notes}</p>
              </div>
            ) : null}
          </div>

          <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground text-pretty">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
              Verified via <span className="font-medium text-foreground">{SOURCE_LABEL[i.verifiedSource]}</span>
              {i.verifiedFigi ? <> · Bloomberg ID <span className="font-mono text-foreground">{i.verifiedFigi}</span></> : null}
              {i.verifiedName ? <> · {i.verifiedName}</> : null}
              {i.verifiedAt ? <> · as of {new Date(i.verifiedAt).toLocaleDateString("en-GB")}</> : null}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
          {i.printoutUrl ? (
            <Button asChild variant="outline" className="gap-1.5 bg-transparent">
              <a href={i.printoutUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Source document
              </a>
            </Button>
          ) : null}
          <Button onClick={() => window.print()} className="gap-1.5">
            <Printer className="h-4 w-4" />
            Print / download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
