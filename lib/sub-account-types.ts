/**
 * Client-safe types for client-managed SUB-ACCOUNTS.
 *
 * A sub-account is an isolated money compartment that belongs to the SAME user
 * (no separate login, no other person involved). The user opens one from the
 * dashboard; an administrator then assigns it an IBAN/BIC and activates it.
 * Once active it holds funds independently of the main balance, and the user
 * moves money between their Main account and any sub-account via instant,
 * zero-sum internal transfers.
 *
 * No server-only imports here so both server actions and client components can
 * share the shape.
 */

export type SubAccountStatus =
  | "pending" // requested by the client, awaiting administrator IBAN assignment
  | "active" // administrator assigned an IBAN/BIC — usable, can hold funds
  | "rejected" // administrator declined the request
  | "closed" // closed by an administrator (kept for the audit trail)

export interface SubAccount {
  /** Stable id, also used as the ledger `sub_account_id` tag. */
  id: string
  /** The owning user id (the requester / data owner). */
  userId: string
  /** Friendly name the client chose, e.g. "Operations", "Escrow — Project A". */
  label: string
  /** ISO 4217 currency this compartment operates in. */
  currency: string
  /** Why the client opened it (free text, optional). */
  purpose?: string
  /** The sub-account's OWN beneficiary — the party this compartment is held for
   *  / pays out to. Distinct from the user's main-account holder, so the
   *  sub-account is managed as a separate account. Set by the client, editable. */
  beneficiaryName?: string
  /** Optional free-text beneficiary details (address, bank, reference…). */
  beneficiaryDetails?: string
  status: SubAccountStatus
  /** Assigned by the administrator on activation. */
  iban?: string
  bic?: string
  /** Administrator note attached on activation / rejection. */
  adminNote?: string
  createdAt: string
  /** When the administrator activated (assigned the IBAN) or rejected it. */
  decidedAt?: string
}

export const SUB_ACCOUNT_STATUS_LABEL: Record<SubAccountStatus, string> = {
  pending: "Awaiting activation",
  active: "Active",
  rejected: "Declined",
  closed: "Closed",
}

/** Ledger tag used for the user's MAIN (default) account. Ledger rows with no
 *  `sub_account_id` are treated as main, so this is only used conceptually in
 *  the UI/transfer layer as the "from/to = main" sentinel. */
export const MAIN_ACCOUNT_ID = "main"
