"use client"

// On-screen, print-friendly rendering of an official account certificate. The
// layout and wording mirror lib/certificate-pdf.ts (generateAccountCertificate)
// so the preview a client sees matches the PDF they download. All data is passed
// in from the request's verified snapshot — this component never fetches.

import { Card } from "@/components/ui/card"
import {
  CERTIFICATE_TYPE_LABELS,
  CERTIFICATE_TYPE_SUBTITLES,
  type CertificateType,
} from "@/lib/certificates-store"

const currencySymbols: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  CHF: "CHF ",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  AED: "AED ",
}

function money(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || `${currency} `
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

export interface CertificateDocProps {
  type: CertificateType
  reference: string
  verificationCode: string
  issuedDate?: string // ISO; falls back to today for previews
  version: number
  status: "pending" | "approved" | "rejected"
  accountLabel: string
  purpose?: string
  addressee?: string
  holderName: string
  holderCompany?: string
  bankName?: string
  bankAddress?: string
  iban?: string
  bic?: string
  balances: { currency: string; amount: number }[]
  totalEur: number
  displayCurrency: string
}

function bodyParagraphs(p: CertificateDocProps): string[] {
  const who = p.holderName + (p.holderCompany && p.holderCompany !== p.holderName ? ` (${p.holderCompany})` : "")
  const acct = p.iban ? `account IBAN ${p.iban}` : "the account held with us"
  const bank = p.bankName ? `${p.bankName}${p.bankAddress ? `, ${p.bankAddress}` : ""}` : "our institution"
  const purpose = p.purpose || "their general business requirements"

  switch (p.type) {
    case "good-standing":
      return [
        `This is to certify that ${who} maintains a banking relationship with MCC Capital, settled through ${bank}.`,
        `The above-named account holder operates ${acct}${p.bic ? ` (SWIFT/BIC ${p.bic})` : ""} which is active and in good standing as of the date of issuance.`,
        `The relationship has been conducted in a satisfactory manner and, to the best of our knowledge, the account holder has met all obligations to this institution. The account is not subject to any liens, encumbrances, blocks or adverse findings, and the holder remains fully compliant with our KYC and AML requirements.`,
        `This certificate is issued at the request of the account holder for the purpose of ${purpose} and without any responsibility or liability on the part of MCC Capital or its correspondent banks.`,
      ]
    case "endorsement":
      return [
        `We are pleased to provide this banking reference in respect of ${who}, who maintains ${acct} with MCC Capital, settled through ${bank}.`,
        `The account holder has maintained their banking relationship with us in a manner that is entirely satisfactory. Their account has been operated within agreed arrangements and we have found the relationship to be sound, reliable and conducted in good faith.`,
        `We consider the account holder to be a reputable and trustworthy party, suitable to be entered into normal business and banking engagements of the size and nature consistent with their established activity.`,
        `This reference is furnished in confidence, at the request of the account holder, for the purpose of ${purpose}, and is given without any responsibility or liability whatsoever on the part of MCC Capital or its officers.`,
      ]
    case "proof-of-funds":
      return [
        `This is to certify that ${who} is the holder of ${acct}${p.bic ? ` (SWIFT/BIC ${p.bic})` : ""} maintained with MCC Capital and settled through ${bank}.`,
        `As of the date of issuance, the above account holds the cleared and unencumbered funds set out below, which are good, clean, of non-criminal origin and freely available to the account holder.`,
        `The funds are held free of any lien, encumbrance or third-party interest and are immediately available subject to the holder's lawful instructions. This confirmation is issued for the purpose of ${purpose}.`,
        `This certificate is issued at the request of the account holder, reflects the verified balance recorded on our books, and is given without any responsibility or liability on the part of MCC Capital or its correspondent banks.`,
      ]
    case "ownership":
      return [
        `This is to certify that ${who} is the sole legal and beneficial owner of ${acct}${p.bic ? ` (SWIFT/BIC ${p.bic})` : ""} maintained with MCC Capital and settled through ${bank}.`,
        `All funds and assets held within the said account belong exclusively to the named account holder. No other person or entity holds any legal or beneficial interest, lien, charge or claim over the account or its contents.`,
        `The account holder has full and unrestricted authority to operate, instruct and dispose of the account and the assets therein, subject only to applicable law and our standard terms.`,
        `This certificate is issued at the request of the account holder for the purpose of ${purpose} and without any responsibility or liability on the part of MCC Capital.`,
      ]
  }
}

export function CertificateDocument(props: CertificateDocProps) {
  const issued = props.issuedDate ? new Date(props.issuedDate) : new Date()
  const paragraphs = bodyParagraphs(props)
  const isDraft = props.status !== "approved"

  const rows: [string, string][] = [
    ["Account Holder", props.holderName || "—"],
    ...(props.holderCompany && props.holderCompany !== props.holderName
      ? ([["Entity", props.holderCompany]] as [string, string][])
      : []),
    ["Settlement Bank", props.bankName || "MCC Capital"],
    ...(props.bankAddress ? ([["Bank Address", props.bankAddress]] as [string, string][]) : []),
    ...(props.iban ? ([["IBAN", props.iban]] as [string, string][]) : []),
    ...(props.bic ? ([["BIC / SWIFT", props.bic]] as [string, string][]) : []),
    ["Account", props.accountLabel],
  ]

  return (
    <Card className="relative overflow-hidden border-2 border-primary/40 bg-card p-6 sm:p-8">
      {/* Draft watermark for non-approved previews */}
      {isDraft && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="rotate-[-24deg] text-6xl font-black uppercase tracking-widest text-primary/10 sm:text-7xl">
            Draft Preview
          </span>
        </div>
      )}

      <div className="relative">
        {/* Letterhead */}
        <div className="text-center">
          <p className="text-xl font-bold text-foreground">MCC Capital</p>
          <p className="text-xs text-muted-foreground">MCC Banking &amp; Trade Platform</p>
          <p className="text-[11px] text-muted-foreground">Rue du Rhone 14, 1204 Geneva, Switzerland</p>
          <div className="mx-auto mt-3 h-px w-2/3 bg-primary" />
        </div>

        {/* Title */}
        <div className="mt-5 text-center">
          <h2 className="text-lg font-bold uppercase tracking-wide text-primary">
            {CERTIFICATE_TYPE_LABELS[props.type]}
          </h2>
          <p className="mt-1 text-xs italic text-muted-foreground">{CERTIFICATE_TYPE_SUBTITLES[props.type]}</p>
          <p className="mt-2 text-xs font-medium text-foreground">Reference: {props.reference}</p>
          <p className="text-[11px] text-muted-foreground">
            Date of Issuance: {formatDate(issued)}
            {props.version > 1 ? ` · Revision ${props.version}` : ""}
          </p>
        </div>

        {/* Addressee */}
        <div className="mt-5 text-sm text-foreground">
          {props.addressee && (props.type === "endorsement" || props.type === "proof-of-funds") ? (
            <p>
              <span className="font-semibold">To:</span> {props.addressee}
            </p>
          ) : (
            <p className="italic text-muted-foreground">To Whom It May Concern,</p>
          )}
        </div>

        {/* Body */}
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground">
          {paragraphs.map((para, i) => (
            <p key={i} className="text-pretty">
              {para}
            </p>
          ))}
        </div>

        {/* Proof of Funds box */}
        {props.type === "proof-of-funds" && (
          <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Available Cleared Funds
            </p>
            <div className="mt-2 space-y-1.5">
              {props.balances.length === 0 ? (
                <p className="text-sm italic text-muted-foreground">No cleared balance recorded.</p>
              ) : (
                props.balances.map((b) => (
                  <div key={b.currency} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{b.currency} Account</span>
                    <span className="font-semibold text-foreground">{money(b.amount, b.currency)}</span>
                  </div>
                ))
              )}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">Aggregate value (converted)</span>
              <span className="text-base font-bold text-primary">{money(props.totalEur, "EUR")}</span>
            </div>
          </div>
        )}

        {/* Account particulars */}
        <div className="mt-5 overflow-hidden rounded-md border border-border">
          <table className="w-full text-xs">
            <tbody>
              {rows.map((r, i) => (
                <tr key={r[0]} className={i % 2 === 0 ? "bg-secondary/40" : ""}>
                  <td className="px-3 py-2 text-muted-foreground">{r[0]}</td>
                  <td className="px-3 py-2 text-right font-medium text-foreground">{r[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Authorised signatory block + seal. Issued certificates carry the real
            MCC signatory block (transparent PNG, blends on the dark card); draft
            previews keep the empty signature line. */}
        <div className="mt-6 flex items-end justify-between gap-4">
          {isDraft ? (
            <div>
              <div className="h-8 w-44 border-b border-foreground" />
              <p className="mt-1 text-xs font-semibold text-foreground">Authorised Signatory</p>
              <p className="text-[11px] text-muted-foreground">MCC Capital — Compliance Office</p>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/certificates/mcc-signature-light.png"
              alt="Authorised signatory: MCC Holding S.A., Geneva, Switzerland — official signature"
              className="h-auto w-72 max-w-[68%] select-none"
              draggable={false}
            />
          )}
          <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-full border-2 border-primary text-center">
            <span className="text-[10px] font-bold text-primary">MCC CAPITAL</span>
            <span className="text-[7px] text-muted-foreground">GENEVA · SWITZERLAND</span>
            <span className="mt-0.5 text-[7px] text-muted-foreground">OFFICIAL SEAL</span>
          </div>
        </div>

        {/* Security footer */}
        <div className="mt-5 border-t border-border pt-3">
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Security features: unique reference {props.reference} · verification code {props.verificationCode}. This
            document is electronically generated and watermarked; verify authenticity by quoting the reference and
            verification code to your MCC Capital relationship manager.
          </p>
          <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">
            Platform owned &amp; operated by NAFTAhub plc. MCC Capital is the settlement institution; this certificate is
            issued in respect of the named account holder and does not confer any ownership of the platform.
          </p>
        </div>
      </div>
    </Card>
  )
}
