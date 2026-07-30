// ---------------------------------------------------------------------------
// POST /api/v1/charge
//
// Charges a subscription cost against a customer's mcc-btp.app balance. Used by
// NQAi.cloud to autonomically bill a customer: the debit is applied immediately
// (no human approval step) and reflected on the account the customer holds here.
//
// Auth: Authorization: Bearer <api key> with the "charge" scope.
//
// Body (JSON):
//   email       string  (required)  — the customer to charge
//   amount      number  (required)  — positive amount to debit
//   currency    string  (optional)  — ISO code, defaults to EUR
//   description    string (optional) — appears on the customer's statement
//   idempotencyKey string (optional) — idempotency key (alias: `reference`);
//                                       a repeated key returns the original
//                                       charge instead of double-charging
//
// Behavior:
//   - Insufficient balance  -> 402 and nothing is posted.
//   - Duplicate reference   -> 200 with the original charge (idempotent).
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server"
import { randomUUID } from "node:crypto"
import { authenticateApiRequest } from "@/lib/api-request-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { resolveDataOwnerIdFor, resolveAccountProfileById } from "@/lib/session-user"
import {
  readLedgerEntries,
  availableByCurrency,
  upsertLedgerEntry,
  deleteLedgerEntry,
  assertOwnerSolvent,
} from "@/lib/ledger-db"
import { persistActivityEvent } from "@/lib/activity-persist"
import type { LedgerEntry } from "@/lib/ledger-store"

export const dynamic = "force-dynamic"

function jsonError(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: { code, message }, ...extra }, { status })
}

export async function POST(req: Request) {
  const auth = await authenticateApiRequest(req, "charge")
  if (!auth.ok) return auth.response

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.")
  }

  const email = typeof body.email === "string" ? body.email.trim() : ""
  const amount = Number(body.amount)
  const currency = (typeof body.currency === "string" && body.currency.trim().toUpperCase()) || "EUR"
  const description = typeof body.description === "string" ? body.description.trim() : "NQAi subscription"
  // Idempotency key: accept either `idempotencyKey` (common convention) or
  // `reference`. Whichever is supplied makes a retried charge return the
  // original entry instead of double-charging.
  const idempotencyRaw =
    (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()) ||
    (typeof body.reference === "string" && body.reference.trim()) ||
    ""
  const reference = idempotencyRaw ? idempotencyRaw : null

  if (!email) return jsonError(400, "missing_email", "A customer email is required.")
  if (!Number.isFinite(amount) || amount <= 0) return jsonError(400, "invalid_amount", "Provide a positive amount.")

  try {
    const user = await getDynamicUserByEmail(email)
    if (!user) return jsonError(404, "customer_not_found", `No customer found for ${email}.`)

    // Post to the data-owner ledger so a Sub/Joint account is billed against the
    // shared Master balance the customer actually holds.
    const ownerId = await resolveDataOwnerIdFor(user.id)

    // Idempotency: a stable entry id derived from the caller's reference means a
    // retried request with the same reference never double-charges.
    const entryId = reference ? `SUBSCR-${reference}` : `SUBSCR-${randomUUID()}`

    const existingEntries = await readLedgerEntries(ownerId)
    if (reference) {
      const dup = existingEntries.find((e) => e.id === entryId)
      if (dup) {
        const balances = availableByCurrency(await readLedgerEntries(ownerId))
        return NextResponse.json({
          ok: true,
          idempotent: true,
          charge: { reference, entryId: dup.id, amount: dup.amount, currency: dup.currency, status: dup.status },
          balanceAfter: balances,
        })
      }
    }

    // Reject up-front when the customer cannot cover the charge in that currency.
    const available = availableByCurrency(existingEntries)[currency] ?? 0
    if (available + 1e-9 < amount) {
      return jsonError(402, "insufficient_funds", `Customer balance is insufficient to charge ${currency} ${amount}.`, {
        available: { [currency]: available },
      })
    }

    const entry: LedgerEntry = {
      id: entryId,
      direction: "debit",
      amount,
      currency,
      status: "completed",
      date: new Date().toISOString(),
      counterparty: "NQAi.cloud",
      reference: reference ?? entryId,
      comment: description,
      category: "Subscription",
    }

    // Post, then hard-guard solvency. If the concurrent state made this overdraw
    // the account, roll the entry back and reject — a negative balance is never
    // left committed.
    await upsertLedgerEntry(ownerId, entry)
    try {
      await assertOwnerSolvent(ownerId)
    } catch (solvencyErr) {
      await deleteLedgerEntry(ownerId, entryId).catch(() => {})
      if ((solvencyErr as Error).message?.startsWith("INSUFFICIENT_FUNDS")) {
        return jsonError(402, "insufficient_funds", `Customer balance is insufficient to charge ${currency} ${amount}.`)
      }
      throw solvencyErr
    }

    const balanceAfter = availableByCurrency(await readLedgerEntries(ownerId))

    // Audit trail (persisted; no email to keep autonomic billing fast).
    const target = await resolveAccountProfileById(user.id).catch(() => null)
    await persistActivityEvent(
      {
        action: `NQAi charged ${currency} ${amount.toLocaleString("en-US")} to ${target?.fullName ?? email}`,
        category: "Subscription Billing",
        user: `API key ${auth.key.name} (${auth.key.keyPrefix})`,
        userId: user.id,
        details: {
          apiKeyId: auth.key.id,
          customer: `${target?.fullName ?? "—"} — ${email}`,
          amount: `${currency} ${amount.toLocaleString("en-US")}`,
          reference: reference ?? entryId,
          description,
        },
      },
      { ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent") },
    ).catch(() => {})

    return NextResponse.json({
      ok: true,
      charge: { reference: reference ?? entryId, entryId, amount, currency, status: "completed" },
      balanceAfter,
    })
  } catch (err) {
    console.log("[v0] POST /api/v1/charge failed:", (err as Error).message)
    return jsonError(500, "server_error", "The charge could not be processed.")
  }
}
