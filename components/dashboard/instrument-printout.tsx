"use client"

import { Printer, ExternalLink, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useState } from "react"
import type { MarketplaceInstrument, Verifications } from "@/app/actions/marketplace-instruments"
import { resolveBankLogo } from "@/lib/bank-logo"

/* ---------------------------------------------------------------------------
 * Formatting helpers (shared by the preview and the standalone print doc)
 * ------------------------------------------------------------------------- */

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
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()
}

function fmtDateTime(d: Date): string {
  return d
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    })
    .toUpperCase()
}

const REGISTRY_LABELS: Record<keyof Verifications, string> = {
  bloomberg: "BLOOMBERG",
  euroclear: "EUROCLEAR",
  clearstream: "CLEARSTREAM",
  swift: "SWIFT",
}

function verifiedCount(v: Verifications): number {
  return (Object.keys(REGISTRY_LABELS) as (keyof Verifications)[]).filter((k) => v[k]).length
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/* ---------------------------------------------------------------------------
 * Standalone Bloomberg-terminal (DES) style HTML document for printing.
 * Rendered into its own window so the print/PDF contains ONLY the report,
 * with the terminal colours forced on via print-color-adjust: exact.
 * ------------------------------------------------------------------------- */

function buildReportHtml(i: MarketplaceInstrument): string {
  const now = new Date()
  const ticker = `${i.bankBic || i.isin.slice(0, 4)} ${i.type}`.toUpperCase()
  const logo = resolveBankLogo(i.bankName, i.bankBic, 128)

  // Real issuer logo with a two-step CDN fallback, then a monogram crest.
  const crest = logo.logoUrl
    ? `<div class="crest"><img class="crestimg" src="${esc(logo.logoUrl)}" alt="${esc(i.bankName)} logo"
        onerror="if(!this.dataset.alt){this.dataset.alt=1;this.src='${esc(logo.altLogoUrl || "")}';}else{this.style.display='none';this.parentNode.querySelector('.mono').style.display='flex';}"/>
        <span class="mono">${esc(logo.monogram)}</span></div>`
    : `<div class="crest"><span class="mono" style="display:flex">${esc(logo.monogram)}</span></div>`

  const row = (label: string, value: string, mono = true) =>
    `<div class="row"><span class="lbl">${esc(label)}</span><span class="dots"></span><span class="val ${
      mono ? "mono" : ""
    }">${esc(value || "—")}</span></div>`

  const block = (title: string, body: string) =>
    body.trim()
      ? `<div class="block"><div class="blk-h">${esc(title)}</div><div class="blk-b">${body}</div></div>`
      : ""

  const verifRows = (Object.keys(REGISTRY_LABELS) as (keyof Verifications)[])
    .map((k) => {
      const at = i.verifications[k]
      const ok = Boolean(at)
      const when = at ? fmtDate(at) : "NOT ON FILE"
      return `<div class="vrow"><span class="vdot ${ok ? "on" : "off"}"></span><span class="vname">${
        REGISTRY_LABELS[k]
      }</span><span class="vstat ${ok ? "on" : "off"}">${ok ? "VERIFIED" : "—"}</span><span class="vwhen">${esc(
        when,
      )}</span></div>`
    })
    .join("")

  const secId = block(
    "1) IDENTIFIERS",
    row("ISIN", i.isin) +
      (i.cusip ? row("CUSIP", i.cusip) : "") +
      row("COMMON CODE", i.commonCode ?? "PENDING ICSD ADMISSION") +
      (i.verifiedFigi ? row("FIGI (BBG)", i.verifiedFigi) : "") +
      row("INSTRUMENT", `${i.type} — ${i.typeFull}`, false),
  )

  const secTerms = block(
    "2) TERMS",
    row("FACE VALUE", money(i.faceValue, i.currency)) +
      row("CURRENCY", i.currency) +
      row("ISSUER RATING", i.rating || "NR") +
      row("ISSUE DATE", fmtDate(i.issueDate)) +
      row("MATURITY", fmtDate(i.maturityDate)) +
      row("ASSIGNABLE", i.assignable ? "YES" : "NO") +
      row("MONETIZABLE", i.monetizable ? "YES" : "NO"),
  )

  const secIssuer = block(
    "3) ISSUER / OBLIGOR",
    row("ISSUING BANK", i.bankName, false) +
      row("BIC / SWIFT", i.bankBic || "—") +
      row("COUNTRY", i.bankCountry || "—", false) +
      row("DELIVERY", i.deliveryMethod || "—", false) +
      row("GOVERNING LAW", i.governingLaw || "—", false),
  )

  const notesBody = [
    i.issuerDetails ? `<p><span class="ntag">REGISTERED OFFICE</span>${esc(i.issuerDetails)}</p>` : "",
    i.beneficiaryTerms ? `<p><span class="ntag">BENEFICIARY / TRANSFER</span>${esc(i.beneficiaryTerms)}</p>` : "",
    i.notes ? `<p><span class="ntag">NOTES</span>${esc(i.notes)}</p>` : "",
  ].join("")
  const secNotes = block("4) DISCLOSURES", notesBody)

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(i.type)} ${esc(i.isin)} — Security Description</title>
<style>
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  html,body{margin:0;padding:0;background:#0a0a0a;color:#e8e6e1;
    font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:12px;line-height:1.45;}
  .page{max-width:800px;margin:0 auto;background:#0a0a0a;padding:0 0 24px;}
  /* command bar */
  .cmd{display:flex;align-items:center;gap:10px;background:#000;border-bottom:2px solid #ff8a00;padding:6px 14px;}
  .cmd .go{color:#ff8a00;font-weight:700;letter-spacing:1px;}
  .cmd .fn{color:#e8e6e1;}
  .cmd .rt{margin-left:auto;color:#7f8794;font-size:10px;}
  /* masthead */
  .mast{display:flex;justify-content:space-between;align-items:flex-start;padding:14px;background:#000;border-bottom:1px solid #1f1f1f;}
  .mleft{display:flex;gap:12px;align-items:flex-start;}
  .crest{width:46px;height:46px;flex:none;border:1px solid #2a2a2a;border-radius:5px;background:#fff;
    display:flex;align-items:center;justify-content:center;overflow:hidden;}
  .crest .crestimg{max-width:82%;max-height:82%;object-fit:contain;}
  .crest .mono{display:none;width:100%;height:100%;align-items:center;justify-content:center;
    background:#111;color:#ff8a00;font-weight:700;font-size:16px;letter-spacing:1px;}
  .mast .tkr{color:#ff8a00;font-size:20px;font-weight:700;letter-spacing:1px;}
  .mast .nm{color:#e8e6e1;font-size:13px;margin-top:2px;}
  .mast .sub{color:#7f8794;font-size:10px;margin-top:4px;text-transform:uppercase;letter-spacing:1px;}
  .mast .brand{text-align:right;}
  .mast .brand .b1{color:#ff8a00;font-weight:700;letter-spacing:2px;}
  .mast .brand .b2{color:#7f8794;font-size:9px;letter-spacing:1px;margin-top:2px;}
  .vbadge{display:inline-block;margin-top:6px;border:1px solid #1f5c3a;background:#0c1f14;color:#3ad07a;
    font-size:9px;padding:2px 6px;letter-spacing:1px;}
  /* grid */
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 22px;padding:12px 14px 0;}
  @media print{.grid{gap:0 18px;}}
  .block{margin-bottom:12px;break-inside:avoid;}
  .blk-h{color:#ff8a00;font-size:10px;font-weight:700;letter-spacing:1.5px;border-bottom:1px solid #2a2a2a;
    padding-bottom:3px;margin-bottom:5px;}
  .row{display:flex;align-items:baseline;gap:6px;padding:2px 0;}
  .row .lbl{color:#7f8794;font-size:10px;letter-spacing:.5px;white-space:nowrap;}
  .row .dots{flex:1;border-bottom:1px dotted #2a2a2a;transform:translateY(-2px);}
  .row .val{color:#e8e6e1;font-size:11px;text-align:right;white-space:nowrap;}
  .row .val.mono{color:#ffd08a;}
  /* full width sections */
  .full{padding:0 14px;}
  .full .block{break-inside:avoid;}
  .blk-b p{margin:0 0 6px;color:#c9c7c1;font-size:11px;line-height:1.5;}
  .ntag{display:block;color:#7f8794;font-size:9px;letter-spacing:1px;margin-bottom:1px;}
  /* verification */
  .verif{margin:4px 14px 0;border:1px solid #2a2a2a;background:#0f0f0f;padding:8px 10px;break-inside:avoid;}
  .verif .vh{color:#ff8a00;font-size:10px;font-weight:700;letter-spacing:1.5px;margin-bottom:6px;}
  .vrow{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:10px;}
  .vdot{width:7px;height:7px;border-radius:50%;flex:none;}
  .vdot.on{background:#3ad07a;box-shadow:0 0 4px #3ad07a;} .vdot.off{background:#3a3a3a;}
  .vname{color:#e8e6e1;letter-spacing:1px;width:110px;}
  .vstat{width:70px;letter-spacing:1px;} .vstat.on{color:#3ad07a;} .vstat.off{color:#5a5a5a;}
  .vwhen{color:#7f8794;margin-left:auto;}
  /* footer */
  .foot{margin:14px 14px 0;border-top:1px solid #2a2a2a;padding-top:8px;color:#6a6a6a;font-size:8.5px;line-height:1.5;}
  .foot .disc{margin-bottom:4px;}
  .foot .meta{display:flex;justify-content:space-between;color:#7f8794;letter-spacing:.5px;}
  @page{size:A4;margin:12mm;}
</style></head>
<body><div class="page">
  <div class="cmd"><span class="go">DES</span><span class="fn">&lt;GO&gt;</span>
    <span class="fn" style="color:#7f8794">SECURITY DESCRIPTION</span>
    <span class="rt">PAGE 1/1 &nbsp;·&nbsp; ${esc(fmtDateTime(now))} UTC</span></div>

  <div class="mast">
    <div class="mleft">
      ${crest}
      <div>
        <div class="tkr">${esc(ticker)}</div>
        <div class="nm">${esc(i.verifiedName || i.bankName)}</div>
        <div class="sub">${esc(i.typeFull)} · ${esc(i.currency)} ${esc(money(i.faceValue, i.currency))}</div>
        <span class="vbadge">${verifiedCount(i.verifications)} REGISTRY SOURCE${
          verifiedCount(i.verifications) === 1 ? "" : "S"
        } VERIFIED</span>
      </div>
    </div>
    <div class="brand"><div class="b1">MCC · BTP</div><div class="b2">INSTITUTIONAL DESK</div></div>
  </div>

  <div class="grid">${secId}${secTerms}</div>
  <div class="full">${secIssuer}${secNotes}</div>

  <div class="verif"><div class="vh">TRUSTED-SOURCE VERIFICATION</div>${verifRows}</div>

  <div class="foot">
    <div class="disc">This security description is generated from registry-verified reference data. Identifiers are
      confirmed against the sources marked VERIFIED above as of the date shown. This document is provided for
      information purposes only and does not constitute an offer, solicitation, or investment advice.</div>
    <div class="meta"><span>DOC REF: ${esc(i.id)}</span><span>MCC-BTP INSTITUTIONAL · ${esc(
      fmtDateTime(now),
    )} UTC</span></div>
  </div>
</div>
<script>window.onload=function(){setTimeout(function(){window.focus();window.print();},250);};</script>
</body></html>`
}

function printReport(i: MarketplaceInstrument) {
  const html = buildReportHtml(i)
  const w = window.open("", "_blank", "width=880,height=1000")
  if (!w) return
  w.document.open()
  w.document.write(html)
  w.document.close()
}

/* ---------------------------------------------------------------------------
 * On-screen preview (matches the printed report)
 * ------------------------------------------------------------------------- */

function PreviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="whitespace-nowrap text-[10px] tracking-wide text-[#7f8794]">{label}</span>
      <span className="min-w-0 flex-1 translate-y-[-2px] border-b border-dotted border-[#2a2a2a]" />
      <span className={`whitespace-nowrap text-right text-[11px] ${mono ? "text-[#ffd08a]" : "text-[#e8e6e1]"}`}>
        {value || "—"}
      </span>
    </div>
  )
}

/** Real issuer logo for the on-screen preview, with monogram crest fallback. */
function BankCrest({ bankName, bic }: { bankName: string; bic: string | null }) {
  const logo = resolveBankLogo(bankName, bic, 128)
  // step 0 = primary CDN, 1 = alternate CDN, 2 = monogram fallback
  const [step, setStep] = useState(logo.logoUrl ? 0 : 2)
  const src = step === 0 ? logo.logoUrl : step === 1 ? logo.altLogoUrl : null

  return (
    <div className="flex h-[46px] w-[46px] flex-none items-center justify-center overflow-hidden rounded-[5px] border border-[#2a2a2a] bg-white">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src || "/placeholder.svg"}
          alt={`${bankName} logo`}
          className="max-h-[82%] max-w-[82%] object-contain"
          onError={() => setStep((s) => s + 1)}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-[#111] text-base font-bold tracking-wide text-[#ff8a00]">
          {logo.monogram}
        </span>
      )}
    </div>
  )
}

function PreviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 break-inside-avoid">
      <div className="mb-1.5 border-b border-[#2a2a2a] pb-1 text-[10px] font-bold tracking-widest text-[#ff8a00]">
        {title}
      </div>
      {children}
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
  const vCount = verifiedCount(i.verifications)
  const ticker = `${i.bankBic || i.isin.slice(0, 4)} ${i.type}`.toUpperCase()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            Security description (DES)
          </DialogTitle>
          <DialogDescription>
            Bloomberg-style institutional report for this instrument. Print or save it as a PDF for your records.
          </DialogDescription>
        </DialogHeader>

        {/* Terminal-style preview */}
        <div className="overflow-hidden rounded-md border border-[#1f1f1f] bg-[#0a0a0a] font-mono text-[#e8e6e1]">
          {/* command bar */}
          <div className="flex items-center gap-2 border-b-2 border-[#ff8a00] bg-black px-3 py-1.5 text-[11px]">
            <span className="font-bold tracking-wider text-[#ff8a00]">DES</span>
            <span>{"<GO>"}</span>
            <span className="text-[#7f8794]">SECURITY DESCRIPTION</span>
          </div>
          {/* masthead */}
          <div className="flex items-start justify-between gap-3 border-b border-[#1f1f1f] bg-black px-3 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <BankCrest bankName={i.bankName} bic={i.bankBic} />
              <div className="min-w-0">
              <p className="truncate text-lg font-bold tracking-wider text-[#ff8a00]">{ticker}</p>
              <p className="truncate text-[13px] text-[#e8e6e1]">{i.verifiedName || i.bankName}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-[#7f8794]">
                {i.typeFull} · {money(i.faceValue, i.currency)}
              </p>
              <span className="mt-1.5 inline-block border border-[#1f5c3a] bg-[#0c1f14] px-1.5 py-0.5 text-[9px] tracking-wider text-[#3ad07a]">
                {vCount} REGISTRY SOURCE{vCount === 1 ? "" : "S"} VERIFIED
              </span>
              </div>
            </div>
            <div className="text-right">
              <p className="font-bold tracking-widest text-[#ff8a00]">MCC · BTP</p>
              <p className="mt-0.5 text-[9px] tracking-wider text-[#7f8794]">INSTITUTIONAL DESK</p>
            </div>
          </div>

          <div className="grid gap-x-5 px-3 pt-3 sm:grid-cols-2">
            <PreviewBlock title="1) IDENTIFIERS">
              <PreviewRow label="ISIN" value={i.isin} mono />
              {i.cusip ? <PreviewRow label="CUSIP" value={i.cusip} mono /> : null}
              <PreviewRow label="COMMON CODE" value={i.commonCode ?? "PENDING ICSD ADMISSION"} mono />
              {i.verifiedFigi ? <PreviewRow label="FIGI (BBG)" value={i.verifiedFigi} mono /> : null}
              <PreviewRow label="INSTRUMENT" value={`${i.type} — ${i.typeFull}`} />
            </PreviewBlock>
            <PreviewBlock title="2) TERMS">
              <PreviewRow label="FACE VALUE" value={money(i.faceValue, i.currency)} mono />
              <PreviewRow label="CURRENCY" value={i.currency} />
              <PreviewRow label="ISSUER RATING" value={i.rating || "NR"} />
              <PreviewRow label="ISSUE DATE" value={fmtDate(i.issueDate)} />
              <PreviewRow label="MATURITY" value={fmtDate(i.maturityDate)} />
              <PreviewRow label="ASSIGNABLE" value={i.assignable ? "YES" : "NO"} />
              <PreviewRow label="MONETIZABLE" value={i.monetizable ? "YES" : "NO"} />
            </PreviewBlock>
          </div>

          <div className="px-3">
            <PreviewBlock title="3) ISSUER / OBLIGOR">
              <PreviewRow label="ISSUING BANK" value={i.bankName} />
              <PreviewRow label="BIC / SWIFT" value={i.bankBic || "—"} mono />
              <PreviewRow label="COUNTRY" value={i.bankCountry || "—"} />
              <PreviewRow label="DELIVERY" value={i.deliveryMethod || "—"} />
              <PreviewRow label="GOVERNING LAW" value={i.governingLaw || "—"} />
            </PreviewBlock>

            {i.issuerDetails || i.beneficiaryTerms || i.notes ? (
              <PreviewBlock title="4) DISCLOSURES">
                {i.issuerDetails ? (
                  <p className="mb-2 text-[11px] leading-relaxed text-[#c9c7c1]">
                    <span className="block text-[9px] tracking-wider text-[#7f8794]">REGISTERED OFFICE</span>
                    {i.issuerDetails}
                  </p>
                ) : null}
                {i.beneficiaryTerms ? (
                  <p className="mb-2 text-[11px] leading-relaxed text-[#c9c7c1]">
                    <span className="block text-[9px] tracking-wider text-[#7f8794]">BENEFICIARY / TRANSFER</span>
                    {i.beneficiaryTerms}
                  </p>
                ) : null}
                {i.notes ? (
                  <p className="mb-2 text-[11px] leading-relaxed text-[#c9c7c1]">
                    <span className="block text-[9px] tracking-wider text-[#7f8794]">NOTES</span>
                    {i.notes}
                  </p>
                ) : null}
              </PreviewBlock>
            ) : null}
          </div>

          {/* verification */}
          <div className="mx-3 mb-3 border border-[#2a2a2a] bg-[#0f0f0f] px-2.5 py-2">
            <p className="mb-1.5 text-[10px] font-bold tracking-widest text-[#ff8a00]">TRUSTED-SOURCE VERIFICATION</p>
            {(Object.keys(REGISTRY_LABELS) as (keyof Verifications)[]).map((k) => {
              const at = i.verifications[k]
              const ok = Boolean(at)
              return (
                <div key={k} className="flex items-center gap-2 py-0.5 text-[10px]">
                  <span
                    className={`h-[7px] w-[7px] flex-none rounded-full ${ok ? "bg-[#3ad07a]" : "bg-[#3a3a3a]"}`}
                    style={ok ? { boxShadow: "0 0 4px #3ad07a" } : undefined}
                  />
                  <span className="w-[110px] tracking-wider text-[#e8e6e1]">{REGISTRY_LABELS[k]}</span>
                  <span className={`w-[70px] tracking-wider ${ok ? "text-[#3ad07a]" : "text-[#5a5a5a]"}`}>
                    {ok ? "VERIFIED" : "—"}
                  </span>
                  <span className="ml-auto text-[#7f8794]">{ok ? fmtDate(at) : "NOT ON FILE"}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {i.printoutUrl ? (
            <Button asChild variant="outline" className="gap-1.5 bg-transparent">
              <a href={i.printoutUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Source document
              </a>
            </Button>
          ) : null}
          <Button onClick={() => printReport(i)} className="gap-1.5">
            <Printer className="h-4 w-4" />
            Print / download PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
