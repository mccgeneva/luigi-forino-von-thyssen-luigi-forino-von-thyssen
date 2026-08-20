// Required documentation package for an MCC Capital AES project funding
// application. Used by the Project Funding "Documentation" tab and the
// application acknowledgment gate.

export interface FundingDocument {
  id: string
  title: string
  description: string
  /** Public path to a downloadable template, when MCC provides one. */
  template?: string
  /** Whether the document must follow the MCC template exactly. */
  templated?: boolean
}

export const REQUIRED_FUNDING_DOCUMENTS: FundingDocument[] = [
  {
    id: "loi",
    title: "LOI — Letter of Intent",
    description:
      "Non-binding Letter of Interest addressed to MCC Capital, on your company letterhead, following the MCC template.",
    template: "/templates/MCC-Capital-LOI-Template.pdf",
    templated: true,
  },
  {
    id: "cis",
    title: "CIS — Client Information Sheet",
    description:
      "Complete project, company, principal, and banking information sheet, following the MCC template.",
    template: "/templates/MCC-Capital-CIS-Template.pdf",
    templated: true,
  },
  {
    id: "registry",
    title: "Registry Certificate & Memorandum of Articles",
    description:
      "Certificate of incorporation/registry extract and the Memorandum & Articles of Association of the applicant company.",
  },
  {
    id: "passport",
    title: "Passport Copy of the Legal Representative",
    description:
      "Colour copy of the passport of the statutory legal representative / authorised signatory.",
  },
  {
    id: "business-plan",
    title: "Business Plan",
    description:
      "Project business plan setting out the purpose, structure, and intended use of the requested funds.",
  },
  {
    id: "bank-statement",
    title: "Bank Statement",
    description:
      "Company bank statement not older than 1 month, showing at least 3 months of transactions and the current balance.",
  },
]

// Optional supporting template MCC provides for bank signature verification.
export const SUPPORTING_DOCUMENTS: FundingDocument[] = [
  {
    id: "specimen",
    title: "Specimen of Signature",
    description:
      "Sample signature form used to authorise client instructions to the Investor (replaces official signature verification).",
    template: "/templates/MCC-Capital-Specimen-of-Signature.pdf",
    templated: true,
  },
]

// Upfront fee required where no bank statement is provided.
export const BANK_STATEMENT_WAIVER_FEE = 20_000
export const BANK_STATEMENT_WAIVER_CURRENCY = "EUR"

export const COMPLIANCE_NOTICES = {
  bankStatement:
    `If the Bank Statement is not provided, an upfront fee of ${BANK_STATEMENT_WAIVER_CURRENCY} ${BANK_STATEMENT_WAIVER_FEE.toLocaleString()} may be required prior to any evaluation or engagement. ` +
    "Clients unwilling or unable to provide either of these will not be considered, and all submitted documents will be permanently deleted for compliance and data security purposes.",
  standing:
    'Customers deemed "not in economically good standing" will be automatically rejected by our compliance team. This strict filter is applied to protect our institution and to avoid high-risk exposures.',
  review:
    "Once the complete documentation package is received, MCC Capital will proceed with the review and provide further instructions. Please ensure the LOI and CIS follow the MCC templates.",
  assurance: "All investments are fully secured, and funds are guaranteed.",
} as const
