import { NextResponse } from "next/server"
import { adminActionAuthorized } from "@/lib/admin-auth"
import {
  listDynamicUsers,
  getDynamicUserById,
  updateDynamicUserProfile,
  type SerializableProfileItem,
} from "@/lib/admin-users-db"
import {
  listAllSubAccounts,
  activateSubAccount,
  rejectSubAccount,
  closeSubAccount,
  getSubAccountById,
} from "@/lib/sub-account-db"
import { insertNotification } from "@/lib/notifications-db"
import { upsertLedgerEntry } from "@/lib/ledger-db"
import { buildSubAccountFeeEntries } from "@/lib/sub-account-fees"
import type { SubAccount } from "@/lib/sub-account-types"
import { getVisitorLink, setVisitorLink, removeVisitorLink, listAllVisitorLinks } from "@/lib/visitor-link-db"
import { resolvePlatformTier } from "@/lib/platform-tier"
import { validateIban, validateBic } from "@/lib/iban-swift"
import { normalizeAccountBadge } from "@/lib/account-tier"

/** In-place upsert of a labelled banking coordinate row (mirrors the admin
 *  master-bank editor). Empty value removes the row. */
function upsertBank(
  rows: SerializableProfileItem[],
  match: (label: string) => boolean,
  canonicalLabel: string,
  value: string,
): void {
  const idx = rows.findIndex((r) => match(r.label.toLowerCase()))
  const v = value.trim()
  if (v) {
    if (idx >= 0) rows[idx] = { ...rows[idx], value: v }
    else rows.push({ label: canonicalLabel, value: v })
  } else if (idx >= 0) {
    rows.splice(idx, 1)
  }
}

/**
 * Post a sub-account's accrued tariffs to its owner's MASTER ledger immediately
 * (deterministic SUBA-* ids ⇒ idempotent, so the ledger-read reconciler never
 * double-charges). Best-effort: a fee-posting hiccup must not fail the admin
 * authorization itself. Sub-accounts are stored under the master owner id, so
 * `sub.userId` is already the master ledger owner.
 */
async function chargeSubAccountFees(sub: SubAccount): Promise<void> {
  try {
    for (const post of buildSubAccountFeeEntries(sub, new Date().toISOString())) {
      await upsertLedgerEntry(sub.userId, post)
    }
  } catch (err) {
    console.log("[v0] chargeSubAccountFees failed:", (err as Error).message)
  }
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Administrator surface for client sub-accounts. Implemented as an /api route
 * (NOT a Server Action) so it is never silently 401'd by the dashboard proxy on
 * a stale meta cookie inside the preview iframe, and it imports the lib/* data
 * modules DIRECTLY rather than the "use server" wrappers (importing a
 * "use server" module into an API route can 500 at load time). Every op is
 * gated once by the admin passcode.
 */

interface ClientLite {
  id: string
  label: string
  email: string
}

function holderFor(sub: SubAccount, clients: ClientLite[]): { holderName: string; holderEmail: string } {
  const c = clients.find((x) => x.id === sub.userId)
  return { holderName: c ? c.label : sub.userId, holderEmail: c ? c.email : "" }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 })
  }

  const pin = typeof body.pin === "string" ? body.pin : ""
  if (!(await adminActionAuthorized(pin))) {
    return NextResponse.json({ ok: false, reason: "unauthorized", subAccounts: [], clients: [] }, { status: 200 })
  }

  const op = typeof body.op === "string" ? body.op : "list"

  try {
    const users = await listDynamicUsers()
    const clients: ClientLite[] = users.map((u) => ({
      id: u.id,
      label: u.profile.fullName || u.profile.company || u.email,
      email: u.email,
    }))

    if (op === "list") {
      const subAccounts = await listAllSubAccounts()
      const enriched = subAccounts.map((s) => ({ ...s, ...holderFor(s, clients) }))
      // Visitor-tier candidates that may be linked to a sub-account, plus every
      // existing link so the manager can show the current assignment per row.
      const visitors = users
        .filter((u) => u.status === "active" && resolvePlatformTier(u.profile.accountBadge).id === "visitor")
        .map((u) => ({ id: u.id, label: u.profile.fullName || u.profile.company || u.email, email: u.email }))
      const links = await listAllVisitorLinks()
      return NextResponse.json({ ok: true, subAccounts: enriched, clients, visitors, links })
    }

    // Link a VISITOR user to an ACTIVE sub-account (exactly one per visitor).
    if (op === "link") {
      const subId = typeof body.subId === "string" ? body.subId : ""
      const visitorId = typeof body.visitorId === "string" ? body.visitorId : ""
      if (!subId || !visitorId) return NextResponse.json({ ok: false, error: "Missing sub-account or visitor." })

      const sub = await getSubAccountById(subId)
      if (!sub) return NextResponse.json({ ok: false, error: "That sub-account no longer exists." })
      if (sub.status !== "active") {
        return NextResponse.json({ ok: false, error: "Only an ACTIVE sub-account can be linked to a visitor." })
      }
      const visitor = users.find((u) => u.id === visitorId)
      if (!visitor) return NextResponse.json({ ok: false, error: "That visitor account was not found." })
      if (visitor.id === sub.userId) {
        return NextResponse.json({ ok: false, error: "A user cannot be linked to their own sub-account." })
      }

      await setVisitorLink({ visitorUserId: visitorId, subAccountId: subId, ownerId: sub.userId, linkedBy: "admin" })
      await insertNotification({
        userId: visitorId,
        tone: "success",
        title: "A sub-account was shared with you",
        body: `An administrator linked you to the "${sub.label}" ${sub.currency} sub-account. Sign in to view its balance, move funds and request payments.`,
        href: "/dashboard",
      })
      const links = await listAllVisitorLinks()
      return NextResponse.json({ ok: true, links })
    }

    // Remove a visitor's link.
    if (op === "unlink") {
      const visitorId = typeof body.visitorId === "string" ? body.visitorId : ""
      if (!visitorId) return NextResponse.json({ ok: false, error: "Missing visitor." })
      const existing = await getVisitorLink(visitorId)
      await removeVisitorLink(visitorId)
      if (existing) {
        await insertNotification({
          userId: visitorId,
          tone: "info",
          title: "Sub-account access removed",
          body: "An administrator removed your access to the linked sub-account.",
          href: "/dashboard",
        })
      }
      const links = await listAllVisitorLinks()
      return NextResponse.json({ ok: true, links })
    }

    // Convert a CLOSED sub-account's holder into a STANDALONE Visitor customer:
    // promote the linked (or chosen) Visitor login into their OWN master account
    // (relationship = master, no masterId ⇒ their own data owner), keep Visitor
    // tier so they still see the whole platform with visitor access, and assign a
    // dedicated master IBAN / BIC. The (now decommissioned) sub-account link is
    // removed so they stand alone.
    if (op === "convert") {
      const subId = typeof body.subId === "string" ? body.subId : ""
      const visitorId = typeof body.visitorId === "string" ? body.visitorId : ""
      const ibanRaw = (typeof body.iban === "string" ? body.iban : "").trim()
      const bicRaw = (typeof body.bic === "string" ? body.bic : "").trim().toUpperCase()
      const bankName = typeof body.bankName === "string" ? body.bankName.trim() : ""
      const note = typeof body.note === "string" ? body.note.trim() : ""

      if (!subId || !visitorId) {
        return NextResponse.json({ ok: false, error: "Choose the sub-account and the client login to convert." })
      }
      const sub = await getSubAccountById(subId)
      if (!sub) return NextResponse.json({ ok: false, error: "That sub-account no longer exists." })
      if (sub.status !== "closed") {
        return NextResponse.json({
          ok: false,
          error: "Only a CLOSED sub-account can be converted to a standalone customer.",
        })
      }
      if (visitorId === sub.userId) {
        return NextResponse.json({ ok: false, error: "The Master owner cannot be converted into a standalone customer here." })
      }

      // A dedicated master account requires a valid IBAN; a supplied SWIFT/BIC
      // must belong to the SAME country (a cross-country pair is a corrupt account).
      const ic = validateIban(ibanRaw)
      if (!ic.valid) {
        return NextResponse.json({ ok: false, error: `Enter a valid IBAN for the new master account: ${ic.error}` })
      }
      let normalizedBic = ""
      if (bicRaw) {
        const bc = validateBic(bicRaw)
        if (!bc.valid) return NextResponse.json({ ok: false, error: `SWIFT / BIC is not valid: ${bc.error}` })
        if (bc.countryCode !== ic.countryCode) {
          return NextResponse.json({
            ok: false,
            error: `The SWIFT/BIC country (${bc.countryCode}) does not match the IBAN country (${ic.countryCode}).`,
          })
        }
        normalizedBic = bc.normalized
      }

      const target = await getDynamicUserById(visitorId)
      if (!target) return NextResponse.json({ ok: false, error: "That client login was not found." })

      const profile = { ...target.profile }
      // Promote to a standalone master account (their own data owner).
      profile.relationship = "master"
      profile.masterId = undefined
      profile.masterName = undefined
      profile.masterEmail = undefined
      // Keep Visitor tier — they see the whole platform with visitor access.
      profile.accountBadge = normalizeAccountBadge("Visitor Account")
      // Assign the dedicated master banking coordinates.
      const rows: SerializableProfileItem[] = Array.isArray(profile.banking) ? [...profile.banking] : []
      upsertBank(rows, (l) => l.includes("iban"), "IBAN", ic.formatted)
      upsertBank(rows, (l) => l.includes("swift") || l.includes("bic"), "SWIFT / BIC", normalizedBic)
      if (bankName) {
        upsertBank(
          rows,
          (l) => l.includes("bank") && !l.includes("iban") && !l.includes("swift") && !l.includes("bic"),
          "Bank",
          bankName,
        )
      }
      upsertBank(rows, (l) => l.includes("currency"), "Account Currency", sub.currency)
      profile.banking = rows

      const updated = await updateDynamicUserProfile(visitorId, { status: "active", profile })
      if (!updated) return NextResponse.json({ ok: false, error: "Could not convert the account." })

      // Decouple them from the (closed) sub-account — they now stand alone.
      await removeVisitorLink(visitorId)

      await insertNotification({
        userId: visitorId,
        tone: "success",
        title: "Your standalone account is ready",
        body: `You now have your own dedicated master account (IBAN ${ic.formatted}) with full visitor access to the platform. Sign in to continue.${note ? ` Note: ${note}` : ""}`,
        href: "/dashboard",
      })

      const links = await listAllVisitorLinks()
      return NextResponse.json({ ok: true, links, converted: { id: visitorId } })
    }

    if (op === "activate") {
      const id = typeof body.id === "string" ? body.id : ""
      const iban = (typeof body.iban === "string" ? body.iban : "").trim().replace(/\s+/g, "").toUpperCase()
      const bic = (typeof body.bic === "string" ? body.bic : "").trim().toUpperCase()
      const adminNote =
        typeof body.note === "string" ? body.note.trim() : typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      if (iban.length < 8) return NextResponse.json({ ok: false, error: "Enter a valid IBAN." })

      const updated = await activateSubAccount(id, { iban, bic: bic || undefined, adminNote: adminNote || undefined })
      if (!updated) return NextResponse.json({ ok: false, error: "That request could not be activated." })

      // Apply the administrator authorization immediately: the service fee
      // (€800 alias / €1,500 declared) and the first annual fee (€1,000) are
      // charged to the Master Account the moment the sub-account is activated.
      await chargeSubAccountFees(updated)

      await insertNotification({
        userId: updated.userId,
        tone: "success",
        title: "Sub-account activated",
        body: `Your ${updated.currency} sub-account "${updated.label}" is active. IBAN ${iban}. The service and annual fees have been applied to your Master Account. You can now move funds into it.`,
        href: "/dashboard/sub-accounts",
      })
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    if (op === "reject") {
      const id = typeof body.id === "string" ? body.id : ""
      const adminNote =
        typeof body.note === "string" ? body.note.trim() : typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      const existing = await getSubAccountById(id)
      const updated = await rejectSubAccount(id, adminNote || undefined)
      if (!updated) return NextResponse.json({ ok: false, error: "That request could not be declined." })
      if (existing) {
        await insertNotification({
          userId: updated.userId,
          tone: "warning",
          title: "Sub-account request declined",
          body: `Your request for the "${updated.label}" sub-account was declined.${adminNote ? ` Note: ${adminNote}` : ""}`,
          href: "/dashboard/sub-accounts",
        })
      }
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    if (op === "close") {
      const id = typeof body.id === "string" ? body.id : ""
      const adminNote = typeof body.adminNote === "string" ? body.adminNote.trim() : ""
      if (!id) return NextResponse.json({ ok: false, error: "Missing sub-account id." })
      const updated = await closeSubAccount(id, adminNote || undefined)
      if (!updated) return NextResponse.json({ ok: false, error: "That sub-account could not be closed." })

      // Apply the €350 closing fee to the Master Account immediately.
      await chargeSubAccountFees(updated)

      await insertNotification({
        userId: updated.userId,
        tone: "info",
        title: "Sub-account closed",
        body: `Your sub-account "${updated.label}" has been closed by an administrator. A €350.00 closing fee has been applied to your Master Account.`,
        href: "/dashboard/sub-accounts",
      })
      return NextResponse.json({ ok: true, subAccount: updated })
    }

    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 })
  } catch (err) {
    console.log("[v0] /api/admin/sub-accounts failed:", (err as Error).message)
    return NextResponse.json({ ok: false, error: "The request could not be processed." }, { status: 200 })
  }
}
