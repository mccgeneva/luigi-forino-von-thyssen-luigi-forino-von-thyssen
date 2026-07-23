// ---------------------------------------------------------------------------
// Spot Deals & Marine Vessels — Neon Postgres persistence layer (server-only).
//
// Two tables:
//  - `vessels`     — the marine vessel catalogue (IMO-keyed). Seeded on first
//                    run from lib/vessel-seed.ts so the desk has data without a
//                    paid MarineTraffic key. Each row keeps the full Vessel as
//                    jsonb plus the columns we filter/sort on.
//  - `spot_deals`  — admin-published limited-time spot offers. Full SpotDeal in
//                    jsonb, with status / currency / expiry / vessel promoted to
//                    columns for efficient listing.
//
// Imports `pg`, therefore server-only. Consumed exclusively by the Server Action
// layer (app/actions/spot-deals.ts).
// ---------------------------------------------------------------------------

import "server-only"
import { query } from "@/lib/db"
import type { Vessel, SpotDeal, SpotDealInterest } from "@/lib/spot-deals-shared"
import { VESSEL_SEED } from "@/lib/vessel-seed"

let ensured = false

async function ensureTables(): Promise<void> {
  if (ensured) return
  await query(
    `CREATE TABLE IF NOT EXISTS vessels (
       imo         text PRIMARY KEY,
       name        text NOT NULL,
       type        text NOT NULL,
       status      text NOT NULL DEFAULT 'idle',
       location    text,
       cargo       text,
       source      text NOT NULL DEFAULT 'manual',
       payload     jsonb NOT NULL,
       updated_at  timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS vessels_type_idx ON vessels (type)`)

  await query(
    `CREATE TABLE IF NOT EXISTS spot_deals (
       id          text PRIMARY KEY,
       vessel_imo  text,
       status      text NOT NULL DEFAULT 'published',
       currency    text NOT NULL,
       expires_at  timestamptz,
       payload     jsonb NOT NULL,
       created_at  timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await query(`CREATE INDEX IF NOT EXISTS spot_deals_status_idx ON spot_deals (status, expires_at)`)

  // Seed the vessel catalogue exactly once, only when empty, so we never clobber
  // admin edits on subsequent boots.
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM vessels`)
  if ((rows[0]?.n ?? 0) === 0) {
    const now = new Date().toISOString()
    for (const v of VESSEL_SEED) {
      const vessel: Vessel = { ...v, source: "seed", updatedAt: now }
      await query(
        `INSERT INTO vessels (imo, name, type, status, location, cargo, source, payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (imo) DO NOTHING`,
        [vessel.imo, vessel.name, vessel.type, vessel.status, vessel.location, vessel.cargo ?? null, vessel.source, JSON.stringify(vessel), now],
      )
    }
  }

  // One-time migration for EXISTING databases that were seeded with the earlier
  // fabricated fleet (whose IMO numbers don't resolve on MarineTraffic). Runs
  // exactly once per database, guarded by a schema_migrations marker, and only
  // touches seed-sourced rows so manually-added or API-imported vessels and any
  // admin edits are preserved.
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name        text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  )
  const marker = await query<{ name: string }>(
    `INSERT INTO schema_migrations (name) VALUES ('vessels_real_imo_v1')
     ON CONFLICT (name) DO NOTHING
     RETURNING name`,
  )
  if (marker.rows.length > 0) {
    const realImos = VESSEL_SEED.map((v) => v.imo)
    // Remove every previously-seeded (fabricated) vessel that isn't part of the
    // new real fleet.
    await query(`DELETE FROM vessels WHERE source = 'seed' AND imo <> ALL($1::text[])`, [realImos])
    // Insert the real fleet, leaving any vessel an admin already added untouched.
    const now = new Date().toISOString()
    for (const v of VESSEL_SEED) {
      const vessel: Vessel = { ...v, source: "seed", updatedAt: now }
      await query(
        `INSERT INTO vessels (imo, name, type, status, location, cargo, source, payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (imo) DO NOTHING`,
        [vessel.imo, vessel.name, vessel.type, vessel.status, vessel.location, vessel.cargo ?? null, vessel.source, JSON.stringify(vessel), now],
      )
    }
    // Drop any spot deals that pointed at a now-removed fabricated vessel, so the
    // board only ever shows offers against real, verifiable ships.
    await query(
      `DELETE FROM spot_deals
        WHERE vessel_imo IS NOT NULL
          AND vessel_imo NOT IN (SELECT imo FROM vessels)`,
    )
  }

  // One-time correction for two seed rows whose IMO was valid but pointed at the
  // WRONG vessel identity (verified against Datadocked's live AIS records):
  //   9793753  →  "Folegandros"   (was mislabelled "Nissos Rhenia")
  //   9666077  →  "CS Imperative" (was mislabelled "Stena Impulse")
  // The IMOs are unchanged, so the earlier `DO NOTHING` seed never refreshed
  // them. We update in place, scoped to source='seed' so admin edits survive.
  const correctionMarker = await query<{ name: string }>(
    `INSERT INTO schema_migrations (name) VALUES ('vessels_real_imo_v2_identity_fix')
     ON CONFLICT (name) DO NOTHING
     RETURNING name`,
  )
  if (correctionMarker.rows.length > 0) {
    const now = new Date().toISOString()
    for (const imo of ["9793753", "9666077"]) {
      const seed = VESSEL_SEED.find((v) => v.imo === imo)
      if (!seed) continue
      const vessel: Vessel = { ...seed, source: "seed", updatedAt: now }
      await query(
        `UPDATE vessels
            SET name = $2, type = $3, status = $4, location = $5, cargo = $6, payload = $7, updated_at = $8
          WHERE imo = $1 AND source = 'seed'`,
        [vessel.imo, vessel.name, vessel.type, vessel.status, vessel.location, vessel.cargo ?? null, JSON.stringify(vessel), now],
      )
    }
  }

  ensured = true
}

function iso(v: unknown): string {
  if (!v) return new Date().toISOString()
  return (v as Date)?.toISOString?.() ?? String(v)
}

// --- Vessels ----------------------------------------------------------------

function rowToVessel(row: Record<string, unknown>): Vessel {
  const payload = (row.payload ?? {}) as Vessel
  return { ...payload, updatedAt: iso(row.updated_at) }
}

/** Full catalogue (optionally filtered by a free-text query on name/imo/cargo). */
export async function listVessels(search?: string): Promise<Vessel[]> {
  await ensureTables()
  const term = (search ?? "").trim()
  if (term) {
    const like = `%${term.toLowerCase()}%`
    const { rows } = await query(
      `SELECT * FROM vessels
        WHERE lower(name) LIKE $1 OR lower(imo) LIKE $1 OR lower(coalesce(cargo,'')) LIKE $1
        ORDER BY name ASC`,
      [like],
    )
    return rows.map(rowToVessel)
  }
  const { rows } = await query(`SELECT * FROM vessels ORDER BY name ASC`)
  return rows.map(rowToVessel)
}

export async function getVessel(imo: string): Promise<Vessel | null> {
  await ensureTables()
  const { rows } = await query(`SELECT * FROM vessels WHERE imo = $1`, [imo])
  return rows[0] ? rowToVessel(rows[0]) : null
}

/** Insert or update a vessel (IMO is the natural key). */
export async function upsertVessel(vessel: Vessel): Promise<Vessel> {
  await ensureTables()
  const updated = { ...vessel, updatedAt: new Date().toISOString() }
  await query(
    `INSERT INTO vessels (imo, name, type, status, location, cargo, source, payload, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (imo) DO UPDATE SET
       name = EXCLUDED.name,
       type = EXCLUDED.type,
       status = EXCLUDED.status,
       location = EXCLUDED.location,
       cargo = EXCLUDED.cargo,
       source = EXCLUDED.source,
       payload = EXCLUDED.payload,
       updated_at = EXCLUDED.updated_at`,
    [
      updated.imo,
      updated.name,
      updated.type,
      updated.status,
      updated.location,
      updated.cargo ?? null,
      updated.source,
      JSON.stringify(updated),
      updated.updatedAt,
    ],
  )
  return updated
}

export async function deleteVessel(imo: string): Promise<void> {
  await ensureTables()
  await query(`DELETE FROM vessels WHERE imo = $1`, [imo])
}

// --- Spot deals -------------------------------------------------------------

function rowToDeal(row: Record<string, unknown>): SpotDeal {
  const payload = (row.payload ?? {}) as SpotDeal
  // Trust the column for the live status (it may have been lazily expired).
  return { ...payload, status: (row.status as SpotDeal["status"]) ?? payload.status }
}

/** Flip any published-but-past-expiry deals to "expired" (idempotent, cheap). */
async function sweepExpired(): Promise<void> {
  await query(
    `UPDATE spot_deals
        SET status = 'expired',
            payload = jsonb_set(payload, '{status}', '"expired"')
      WHERE status = 'published' AND expires_at IS NOT NULL AND expires_at <= now()`,
  )
}

/** Admin: every deal, newest first. */
export async function listAllDeals(): Promise<SpotDeal[]> {
  await ensureTables()
  await sweepExpired()
  const { rows } = await query(`SELECT * FROM spot_deals ORDER BY created_at DESC`)
  return rows.map(rowToDeal)
}

/** Public: only live (published & not expired) deals, soonest expiry first. */
export async function listPublishedDeals(): Promise<SpotDeal[]> {
  await ensureTables()
  await sweepExpired()
  const { rows } = await query(
    `SELECT * FROM spot_deals
      WHERE status = 'published' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY expires_at ASC NULLS LAST`,
  )
  return rows.map(rowToDeal)
}

export async function getDeal(id: string): Promise<SpotDeal | null> {
  await ensureTables()
  const { rows } = await query(`SELECT * FROM spot_deals WHERE id = $1`, [id])
  return rows[0] ? rowToDeal(rows[0]) : null
}

/** Insert or update a spot deal (full upsert by id). */
export async function saveDeal(deal: SpotDeal): Promise<SpotDeal> {
  await ensureTables()
  await query(
    `INSERT INTO spot_deals (id, vessel_imo, status, currency, expires_at, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       vessel_imo = EXCLUDED.vessel_imo,
       status = EXCLUDED.status,
       currency = EXCLUDED.currency,
       expires_at = EXCLUDED.expires_at,
       payload = EXCLUDED.payload`,
    [deal.id, deal.vesselImo, deal.status, deal.currency, deal.expiresAt, JSON.stringify(deal), deal.createdAt],
  )
  return deal
}

/** Append an engagement record (viewed / engaged / accepted) to a deal. */
export async function appendInterest(id: string, interest: SpotDealInterest): Promise<SpotDeal | null> {
  const deal = await getDeal(id)
  if (!deal) return null
  const interests = [...(deal.interests ?? []), interest]
  const updated: SpotDeal = { ...deal, interests }
  return saveDeal(updated)
}

/**
 * Atomically claim a live deal for a client: flips status published → engaged
 * and appends the acceptance interest, but ONLY if the deal is still published
 * and unexpired. The guarded UPDATE makes this race-safe — if two clients accept
 * the same cargo at once, exactly one wins and the loser gets `null` (already
 * taken / expired). An engaged deal drops off the public board immediately
 * because `listPublishedDeals` only returns `status = 'published'`.
 */
export async function claimDeal(id: string, interest: SpotDealInterest): Promise<SpotDeal | null> {
  await ensureTables()
  await sweepExpired()
  const existing = await getDeal(id)
  if (!existing) return null
  const interests = [...(existing.interests ?? []), interest]
  const payload: SpotDeal = { ...existing, status: "engaged", interests }
  const { rows } = await query(
    `UPDATE spot_deals
        SET status = 'engaged', payload = $2
      WHERE id = $1 AND status = 'published' AND (expires_at IS NULL OR expires_at > now())
      RETURNING *`,
    [id, JSON.stringify(payload)],
  )
  return rows[0] ? rowToDeal(rows[0]) : null
}

/**
 * Deals a specific client has RESERVED (accepted). Once a client accepts a deal
 * it flips to `engaged` and leaves the public board for everyone — but the client
 * who claimed it must keep seeing it (their reserved cargo) until delivery. A
 * deal "belongs" to the user if its interests contain an `accepted` action by
 * them. Scoped by userId via JSONB containment; newest reservation first.
 */
export async function listReservedDealsForUser(userId: string): Promise<SpotDeal[]> {
  await ensureTables()
  const { rows } = await query(
    `SELECT * FROM spot_deals
      WHERE status = 'engaged'
        AND payload->'interests' @> $1::jsonb
      ORDER BY created_at DESC`,
    [JSON.stringify([{ userId, action: "accepted" }])],
  )
  return rows.map(rowToDeal)
}
