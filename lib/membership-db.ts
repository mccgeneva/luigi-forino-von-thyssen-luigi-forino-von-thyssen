import "server-only"

import { query } from "@/lib/db"
import type { MembershipRecord, MembershipTierId, MembershipStatus, DepositBasis } from "@/lib/membership"

// ---------------------------------------------------------------------------
// Server-only read of a client's membership upgrade grant by account id.
//
// The authoritative write path lives in `app/actions/membership.ts` (a
// "use server" module whose exports become browser-callable actions). We read
// the grant here in a plain server-only module so the external account API can
// resolve a user's EFFECTIVE tier WITHOUT exposing a membership-by-arbitrary-id
// action to the browser.
//
// The table is created lazily by the membership actions; if it does not exist
// yet (or any read fails) we return null and the caller falls back to the
// stored account badge.
// ---------------------------------------------------------------------------

/** Read a user's membership grant by id. Returns null when none / unavailable. */
export async function readMembershipRecordById(userId: string): Promise<MembershipRecord | null> {
  if (!userId) return null
  try {
    const { rows } = await query(`SELECT * FROM membership_upgrades WHERE user_id = $1`, [userId])
    const row = rows[0]
    if (!row) return null
    return {
      tier: (row.tier as MembershipTierId) ?? "avantgarde",
      status: (row.status as MembershipStatus) ?? "pending",
      depositBasis: (row.deposit_basis as DepositBasis) ?? undefined,
      requestedAt: row.requested_at ? new Date(row.requested_at as string).toISOString() : undefined,
      approvedAt: row.approved_at ? new Date(row.approved_at as string).toISOString() : undefined,
      validatedAt: row.validated_at ? new Date(row.validated_at as string).toISOString() : undefined,
      note: (row.note as string) ?? undefined,
    }
  } catch {
    return null
  }
}
