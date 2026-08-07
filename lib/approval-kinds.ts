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
  | "dof"
  | "dtc"
  | "euroclear"
  | "commodity"
  | "bank_account"
  | "card"

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
  "dof",
  "dtc",
  "euroclear",
  "commodity",
  "bank_account",
  "card",
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
  dof: "Download of Funds",
  dtc: "DTC Settlement",
  euroclear: "Euroclear Settlement",
  commodity: "Commodity Deal",
  bank_account: "Bank Account Registration",
  card: "Payment Card",
}

/** Best-effort deep link to the section where a client reviews this kind. */
export const KIND_HREF: Partial<Record<ApprovalKind, string>> = {
  payment: "/dashboard/payments",
  payment_recall: "/dashboard/payments",
  commodity_amendment: "/dashboard/commodity",
  leverage: "/dashboard/leverage",
  ppp: "/dashboard/yield",
  instrument: "/dashboard/instruments",
  monetization: "/dashboard/monetization",
  project_funding: "/dashboard/funding",
  fiduciary: "/dashboard/fiduciary",
  trading_fund: "/dashboard/trading",
  dof: "/dashboard/download-of-funds",
  commodity: "/dashboard/commodities",
  bank_account: "/dashboard/accounts",
  card: "/dashboard/cards",
}

export function kindLabel(kind: ApprovalKind): string {
  return KIND_LABELS[kind] ?? kind
}
