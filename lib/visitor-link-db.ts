import "server-only"
import { query } from "@/lib/db"
import type { VisitorSubLink } from "@/lib/sub-account-types"

/**
 * Server-only persistence for VISITOR ⇄ sub-account links (see
 * lib/sub-account-types.ts `VisitorSubLink`). One row per visitor — the
 * visitor's own user id is the primary key — so a visitor is linked to at most
 * ONE sub-account at a time. The link only records WHICH compartment the
 * visitor may operate; the money itself stays on the owner's `ledger_entries`
 * tagged with `sub_account_id = <subAccountId>`.
 */

let ensured = false

async function ensureTable(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS visitor_sub_links (
       visitor_user_id text        PRIMARY KEY,
       sub_account_id  text        NOT NULL,
       owner_id        text        NOT NULL,
       linked_by       text,
       linked_at       timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS visitor_sub_links_sub_idx ON visitor_sub_links (sub_account_id)`)
  ensured = true
}

function rowToLink(r: Record<string, unknown>): VisitorSubLink {
  return {
    visitorUserId: String(r.visitor_user_id),
    subAccountId: String(r.sub_account_id),
    ownerId: String(r.owner_id),
    linkedBy: (r.linked_by as string) ?? undefined,
    linkedAt: r.linked_at ? new Date(r.linked_at as string).toISOString() : new Date().toISOString(),
  }
}

/** The single link for a visitor, or null if they aren't linked to anything. */
export async function getVisitorLink(visitorUserId: string): Promise<VisitorSubLink | null> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM visitor_sub_links WHERE visitor_user_id = $1`, [visitorUserId])
  return rows[0] ? rowToLink(rows[0]) : null
}

/**
 * Create or replace a visitor's link (upsert on the visitor pk, so re-linking
 * a visitor to a different sub-account overwrites the previous one — enforcing
 * the "exactly one" rule).
 */
export async function setVisitorLink(input: {
  visitorUserId: string
  subAccountId: string
  ownerId: string
  linkedBy?: string
}): Promise<VisitorSubLink> {
  await ensureTable()
  const { rows } = await query(
    `INSERT INTO visitor_sub_links (visitor_user_id, sub_account_id, owner_id, linked_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (visitor_user_id)
       DO UPDATE SET sub_account_id = EXCLUDED.sub_account_id,
                     owner_id = EXCLUDED.owner_id,
                     linked_by = EXCLUDED.linked_by,
                     linked_at = now()
     RETURNING *`,
    [input.visitorUserId, input.subAccountId, input.ownerId, input.linkedBy ?? null],
  )
  return rowToLink(rows[0])
}

/** Remove a visitor's link (unlink). */
export async function removeVisitorLink(visitorUserId: string): Promise<void> {
  await ensureTable()
  await query(`DELETE FROM visitor_sub_links WHERE visitor_user_id = $1`, [visitorUserId])
}

/** Every visitor linked to a given sub-account (usually 0 or 1). Admin use. */
export async function listVisitorLinksForSub(subAccountId: string): Promise<VisitorSubLink[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM visitor_sub_links WHERE sub_account_id = $1`, [subAccountId])
  return rows.map(rowToLink)
}

/** All links (admin overview). */
export async function listAllVisitorLinks(): Promise<VisitorSubLink[]> {
  await ensureTable()
  const { rows } = await query(`SELECT * FROM visitor_sub_links ORDER BY linked_at DESC`)
  return rows.map(rowToLink)
}
