import "server-only"

import { resolveCurrentSession, resolveDataOwnerIdFor } from "@/lib/session-user"
import { getDynamicUserById } from "@/lib/admin-users-db"
import { readLedgerEntries, availableByCurrency } from "@/lib/ledger-db"
import { listCertificateRequestsForUser } from "@/lib/certificates-db"
import { listSkrRecordsForUser, listSkrRequestsForUser } from "@/lib/skr-db"
import { listBeneficiariesForUser } from "@/lib/beneficiaries-db"
import { listNotificationsForUser, countUnreadForUser } from "@/lib/notifications-db"

/**
 * Structured, server-only snapshot of the signed-in user used both to (a) inject
 * a private context block into NQAi's system prompt and (b) compose a
 * personalized greeting. Everything here is resolved on the server from the
 * session cookie and the per-user Neon tables — it is NEVER sent to the client
 * except as NQAi's natural-language replies to that same authenticated user.
 *
 * Financial reads are scoped to `dataOwnerId` (a sub-account shares its master's
 * pool); everything else (KYC, beneficiaries, certificates, notifications) is
 * scoped to the account's own id, matching the rest of the platform.
 */
export interface NqaiUserSnapshot {
  userId: string
  firstName: string
  fullName: string
  company: string
  role: string
  accountBadge: string
  relationship: string
  kycOnFile: number
  kycComplete: boolean
  balances: Record<string, number>
  recentTransactions: {
    date: string
    direction: string
    amount: number
    currency: string
    status: string
    counterparty: string
    category?: string
  }[]
  certificates: { status: string; kind: string }[]
  skrCount: number
  skrPendingCount: number
  beneficiaries: { status: string; name: string }[]
  unreadNotifications: number
  latestNotifications: { tone: string; title: string }[]
}

function fmtAmount(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

/** The minimal profile shape the snapshot reads — satisfied by both the
 *  session's `UserProfile` and the stored `SerializableUserProfile`. */
type SnapshotProfile = {
  firstName?: string
  fullName?: string
  shortName?: string
  company?: string
  role?: string
  accountBadge?: string
  kycDocuments?: unknown[]
  passportMeta?: unknown
}

/** Best-effort: returns null when there is no authenticated session. */
export async function getNqaiUserSnapshot(): Promise<NqaiUserSnapshot | null> {
  const session = await resolveCurrentSession()
  if (!session) return null

  const { id: ownId, dataOwnerId, profile, relationship } = session
  return buildSnapshotForAccount(ownId, dataOwnerId, profile, relationship)
}

/**
 * The same snapshot, resolved for an ARBITRARY account id rather than the
 * current session. Powers the external customer API (app/api/v1/customer) so a
 * trusted integration (NQAi.cloud) can read a specific customer's position.
 * Returns null when the account does not exist.
 */
export async function getNqaiSnapshotForUserId(userId: string): Promise<NqaiUserSnapshot | null> {
  if (!userId) return null
  const rec = await getDynamicUserById(userId).catch(() => undefined)
  if (!rec) return null
  const dataOwnerId = await resolveDataOwnerIdFor(userId)
  const relationship = rec.profile.relationship || "master"
  return buildSnapshotForAccount(userId, dataOwnerId, rec.profile as SnapshotProfile, relationship)
}

async function buildSnapshotForAccount(
  ownId: string,
  dataOwnerId: string,
  profile: SnapshotProfile,
  relationship: string,
): Promise<NqaiUserSnapshot> {
  // Fetch every category in parallel; a failure in any one degrades that
  // section to empty rather than breaking the whole snapshot.
  const [ledger, certs, skrRecords, skrRequests, beneficiaries, notifications, unread] = await Promise.all([
    readLedgerEntries(dataOwnerId).catch(() => []),
    listCertificateRequestsForUser(ownId).catch(() => []),
    listSkrRecordsForUser(ownId).catch(() => []),
    listSkrRequestsForUser(ownId).catch(() => []),
    listBeneficiariesForUser(ownId).catch(() => []),
    listNotificationsForUser(ownId, 5).catch(() => []),
    countUnreadForUser(ownId).catch(() => 0),
  ])

  const balances = availableByCurrency(ledger)
  const kycDocs = profile.kycDocuments ?? []

  const allSkr = [...skrRecords, ...skrRequests]
  const skrPending = allSkr.filter((s) => /pending|review|submitted/i.test(s.status)).length

  return {
    userId: ownId,
    firstName: profile.firstName || "there",
    fullName: profile.fullName || profile.shortName || "Account holder",
    company: profile.company || "—",
    role: profile.role || "—",
    accountBadge: profile.accountBadge || "Account",
    relationship,
    kycOnFile: kycDocs.length,
    kycComplete: kycDocs.length > 0 || Boolean(profile.passportMeta),
    balances,
    recentTransactions: ledger.slice(0, 6).map((e) => ({
      date: e.date.slice(0, 10),
      direction: e.direction,
      amount: e.amount,
      currency: e.currency,
      status: e.status,
      counterparty: e.counterparty || "—",
      category: e.category,
    })),
    certificates: certs.slice(0, 6).map((c) => ({
      status: c.status,
      kind: String(c.request?.type ?? "certificate"),
    })),
    skrCount: allSkr.length,
    skrPendingCount: skrPending,
    beneficiaries: beneficiaries.slice(0, 8).map((b) => ({
      status: b.status,
      name: String((b.data as Record<string, unknown>)?.name ?? (b.data as Record<string, unknown>)?.beneficiaryName ?? "Beneficiary"),
    })),
    unreadNotifications: unread,
    latestNotifications: notifications.slice(0, 4).map((n) => ({ tone: n.tone, title: n.title })),
  }
}

/**
 * Render a compact, token-efficient context block for NQAi's system prompt from
 * a snapshot. Returns "" when there is no snapshot.
 */
export function renderUserContextBlock(snap: NqaiUserSnapshot | null): string {
  if (!snap) return ""

  const lines: string[] = []
  lines.push("## SIGNED-IN CLIENT (PRIVATE — only discuss with THIS authenticated user)")
  lines.push(
    `Name: ${snap.fullName} (first name: ${snap.firstName}). Company: ${snap.company}. Role: ${snap.role}. Tier: ${snap.accountBadge}. Account type: ${snap.relationship}.`,
  )
  lines.push(
    `KYC: ${snap.kycComplete ? `complete (${snap.kycOnFile} document(s) on file)` : "INCOMPLETE — no verified identity documents on file"}.`,
  )

  const balKeys = Object.keys(snap.balances)
  if (balKeys.length) {
    lines.push(
      `Available balances: ${balKeys.map((c) => `${fmtAmount(snap.balances[c])} ${c}`).join(", ")}.`,
    )
  } else {
    lines.push("Available balances: none recorded.")
  }

  if (snap.recentTransactions.length) {
    lines.push("Recent transactions (newest first):")
    for (const t of snap.recentTransactions) {
      lines.push(
        `  - ${t.date} ${t.direction.toUpperCase()} ${fmtAmount(t.amount)} ${t.currency} [${t.status}] ${t.counterparty}${t.category ? ` (${t.category})` : ""}`,
      )
    }
  }

  if (snap.certificates.length) {
    lines.push(
      `Certificates: ${snap.certificates.map((c) => `${c.kind} [${c.status}]`).join(", ")}.`,
    )
  }
  if (snap.skrCount) {
    lines.push(`SKR instruments: ${snap.skrCount} total${snap.skrPendingCount ? `, ${snap.skrPendingCount} pending` : ""}.`)
  }
  if (snap.beneficiaries.length) {
    lines.push(
      `Beneficiaries: ${snap.beneficiaries.map((b) => `${b.name} [${b.status}]`).join(", ")}.`,
    )
  }
  if (snap.unreadNotifications) {
    lines.push(`Unread notifications: ${snap.unreadNotifications}.`)
  }
  if (snap.latestNotifications.length) {
    lines.push(
      `Latest alerts: ${snap.latestNotifications.map((n) => `${n.title} [${n.tone}]`).join("; ")}.`,
    )
  }

  lines.push(
    "Use this to personalize and pre-empt needs (greet by first name, flag incomplete KYC, reference real balances/instruments). Never reveal another client's data. Quote figures as the client's own records, and direct firm financial actions to the desk.",
  )

  return lines.join("\n")
}
