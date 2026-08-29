/**
 * Client-safe approval kind metadata.
 *
 * This module has NO server-only imports so it can be used from both server
 * actions and client components (the DB layer and the admin dashboard alike).
 * Keep the type and its labels here as the single source of truth.
 */

export type ApprovalKind =
  | "payment"
  | "payment_recall"
  | "commodity_amendment"
  | "leverage"
  | "leverage_switchoff"
  | "ppp"
  | "instrument"
  | "monetization"
  | "project_funding"
  | "fiduciary"
  | "trading_fund"
  | "treasury_lending"
  | "internal_loan"
  | "dof"
  | "dtc"
  | "euroclear"
  | "commodity"
  | "bank_account"
  | "card"
  | "debit_termination"

export const APPROVAL_KINDS: ApprovalKind[] = [
  "payment",
  "payment_recall",
  "commodity_amendment",
  "leverage",
  "leverage_switchoff",
  "ppp",
  "instrument",
  "monetization",
  "project_funding",
  "fiduciary",
  "trading_fund",
  "treasury_lending",
  "internal_loan",
  "dof",
  "dtc",
  "euroclear",
  "commodity",
  "bank_account",
  "card",
  "debit_termination",
]

export const KIND_LABELS: Record<ApprovalKind, string> = {
  payment: "Outgoing Payment",
  payment_recall: "Payment Recall",
  commodity_amendment: "Deal Amendment",
  leverage: "Leverage Line",
  leverage_switchoff: "Leverage Switch-Off",
  ppp: "Yield / PPP",
  instrument: "Bank Instrument",
  monetization: "Instrument Monetization",
  project_funding: "Project Funding",
  fiduciary: "Fiduciary & Assets",
  trading_fund: "Treuhand Trading Fund",
  treasury_lending: "Treasury Capital Lending",
  internal_loan: "Internal Loan",
  dof: "Download of Funds",
  dtc: "DTC Settlement",
  euroclear: "Euroclear Settlement",
  commodity: "Commodity Deal",
  bank_account: "Bank Account Registration",
  card: "Payment Card",
  debit_termination: "Debit Termination (overdraft)",
}

/** Best-effort deep link to the section where a client reviews this kind. */
export const KIND_HREF: Partial<Record<ApprovalKind, string>> = {
  payment: "/dashboard/payments",
  payment_recall: "/dashboard/payments",
  commodity_amendment: "/dashboard/commodity",
  leverage: "/dashboard/leverage",
  ppp: "/dashboard/ppp",
  instrument: "/dashboard/instruments",
  monetization: "/dashboard/instruments",
  project_funding: "/dashboard/funding",
  fiduciary: "/dashboard/fiduciary",
  trading_fund: "/dashboard/trading",
  treasury_lending: "/dashboard/treasury",
  internal_loan: "/dashboard/treasury",
  dof: "/dashboard/institutional",
  commodity: "/dashboard/commodity",
  bank_account: "/dashboard/accounts",
  card: "/dashboard/cards",
  debit_termination: "/dashboard/debits",
}

export function kindLabel(kind: ApprovalKind): string {
  return KIND_LABELS[kind] ?? kind
}
