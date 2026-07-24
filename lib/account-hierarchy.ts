// ---------------------------------------------------------------------------
// Referral hierarchy — client-safe metadata & helpers.
//
// Pure types/labels with NO server-only imports, so both the admin UI and the
// server may import it. The actual data-owner resolution (which is server-only,
// because it reads the session + the user DB) lives in lib/session-user.ts.
// ---------------------------------------------------------------------------

import type { AccountRelationship } from "@/lib/profile-types"

export type { AccountRelationship }

/** Outgoing approval kinds a Sub-account must route through its Master for
 *  consent (in ADDITION to administrator approval) before they execute. Kept
 *  deliberately narrow: only value-leaving payments require the Master gate. */
export const MASTER_CONSENT_KINDS = new Set<string>(["payment"])

export interface RelationshipOption {
  value: AccountRelationship
  /** Short code shown in the admin UI (M / S / C). */
  code: string
  label: string
  description: string
}

export const RELATIONSHIP_OPTIONS: RelationshipOption[] = [
  {
    value: "master",
    code: "M",
    label: "Master / Standalone",
    description: "A standalone account. Others can be linked under it as Sub or Child accounts.",
  },
  {
    value: "sub",
    code: "S",
    label: "Sub-account (S)",
    description:
      "Independent login that shares the Master's balance and bank instruments. Outgoing payments require Admin + Master approval.",
  },
  {
    value: "child",
    code: "C",
    label: "Child-account (C)",
    description:
      "Fully independent account linked to the Master for referral attribution and network visibility only.",
  },
  {
    value: "joint",
    code: "J",
    label: "Linked / Joint account (J)",
    description:
      "Independent login and its own Face ID that operates fully inside the Master's environment — shared balance, instruments, transactions, deals and documents — with unrestricted rights.",
  },
]

/** Normalise a possibly-absent relationship to its effective value. Absent ⇒
 *  "master" so legacy accounts (created before the hierarchy existed) behave
 *  exactly as standalone accounts. */
export function effectiveRelationship(rel: AccountRelationship | undefined | null): AccountRelationship {
  return rel === "sub" || rel === "child" || rel === "joint" ? rel : "master"
}

const LABELS: Record<AccountRelationship, string> = {
  master: "Master",
  sub: "Sub-account",
  child: "Child-account",
  joint: "Linked / Joint account",
}

const CODES: Record<AccountRelationship, string> = {
  master: "M",
  sub: "S",
  child: "C",
  joint: "J",
}

export function relationshipLabel(rel: AccountRelationship | undefined | null): string {
  return LABELS[effectiveRelationship(rel)]
}

export function relationshipCode(rel: AccountRelationship | undefined | null): string {
  return CODES[effectiveRelationship(rel)]
}

/**
 * True when this relationship shares the Master's balance & instruments.
 * Both Sub (S) and Joint (J) accounts operate on the Master's shared financial
 * pool; the difference is the consent gate (see `requiresMasterConsent`).
 */
export function sharesMasterFinances(rel: AccountRelationship | undefined | null): boolean {
  const r = effectiveRelationship(rel)
  return r === "sub" || r === "joint"
}

/**
 * True when this relationship shares the Master's ENTIRE environment — not only
 * finances but also otherwise per-account domains (certificates, beneficiaries,
 * cards, SKR, reserved deals). Only Joint (J) accounts do; Sub (S) keeps those
 * domains isolated. This is the single lever for "operates inside the Master's
 * full data set".
 */
export function sharesMasterEnvironment(rel: AccountRelationship | undefined | null): boolean {
  return effectiveRelationship(rel) === "joint"
}

/**
 * True when this relationship must route value-leaving payments through the
 * Master for consent. Only Sub (S) accounts are gated; Joint (J) accounts have
 * unrestricted rights and act with the same authority as the Master.
 */
export function requiresMasterConsent(rel: AccountRelationship | undefined | null): boolean {
  return effectiveRelationship(rel) === "sub"
}
