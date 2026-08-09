"use server"

import { adminActionAuthorized } from "@/lib/admin-auth"
import { resolveCurrentSession } from "@/lib/session-user"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import {
  insertSwiftRoutingRequest,
  listAllSwiftRoutingRequests,
  listSwiftRoutingRequestsForUser,
  getSwiftRoutingRequest,
  approveSwiftRoutingRequest,
  declineSwiftRoutingRequest,
  type SwiftRoutingRequest,
} from "@/lib/swift-routing-db"
import {
  sendSwiftSubmittedEmail,
  sendSwiftRoutedEmail,
  type SwiftEmailInfo,
} from "@/lib/swift-routing-email"

function emailInfo(r: SwiftRoutingRequest): SwiftEmailInfo {
  return {
    messageType: r.messageType,
    messageName: r.messageName,
    uetr: r.uetr,
    reference: r.reference,
    amount: r.amount,
    currency: r.currency,
    senderBic: r.senderBic,
    receiverBic: r.receiverBic,
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export interface SubmitSwiftInput {
  messageType: string
  messageName: string
  category: string
  uetr: string
  raw: string
  senderBic: string
  receiverBic: string
  amount?: string | null
  currency?: string | null
  reference?: string | null
}

/**
 * Client submits a generated SWIFT message for routing. Persists a `pending`
 * request scoped to the signed-in user and emails them an immediate
 * confirmation. The full message is NOT delivered to any counterparty until an
 * administrator approves and routes it.
 */
export async function submitSwiftForRouting(
  input: SubmitSwiftInput,
): Promise<{ ok: true; id: string; emailed: boolean } | { ok: false; error: string }> {
  const session = await resolveCurrentSession()
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." }

  const customerEmail = session.profile.accountEmail || session.profile.email || ""
  const customerName = session.profile.fullName || session.profile.company || "Client"

  try {
    const req = await insertSwiftRoutingRequest({
      userId: session.id,
      customerEmail,
      customerName,
      messageType: input.messageType,
      messageName: input.messageName,
      category: input.category,
      uetr: input.uetr,
      raw: input.raw,
      senderBic: input.senderBic,
      receiverBic: input.receiverBic,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      reference: input.reference ?? null,
    })

    // Immediate customer confirmation (best-effort: never block the submission
    // if email delivery fails or is not configured).
    let emailed = false
    if (customerEmail) {
      const res = await sendSwiftSubmittedEmail(customerEmail, emailInfo(req))
      emailed = res.ok
    }

    return { ok: true, id: req.id, emailed }
  } catch (err) {
    console.log("[v0] submitSwiftForRouting failed:", err instanceof Error ? err.message : String(err))
    return { ok: false, error: "Could not submit the message for routing. Please try again." }
  }
}

/** Client: the signed-in user's own routing requests (for status display). */
export async function listMySwiftRoutingRequests(): Promise<SwiftRoutingRequest[]> {
  const session = await resolveCurrentSession()
  if (!session) return []
  try {
    return await listSwiftRoutingRequestsForUser(session.id)
  } catch {
    return []
  }
}

/** Admin: every client's routing requests. Passcode-gated. */
export async function listAllSwiftRoutingRequestsAdmin(
  passcode: string,
): Promise<{ ok: true; requests: SwiftRoutingRequest[] } | { ok: false; error: string }> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    return { ok: true, requests: await listAllSwiftRoutingRequests() }
  } catch (err) {
    console.log("[v0] listAllSwiftRoutingRequestsAdmin failed:", err instanceof Error ? err.message : String(err))
    return { ok: false, error: "Could not load routing requests." }
  }
}

/** Admin: the platform-users list that powers the beneficiary picker. */
export async function listSwiftBeneficiaries(
  passcode: string,
): Promise<{ ok: true; clients: SelectableClient[] } | { ok: false; error: string }> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: "Administrator authorization failed." }
  try {
    const clients = await listSelectableClients(passcode)
    return { ok: true, clients }
  } catch (err) {
    console.log("[v0] listSwiftBeneficiaries failed:", err instanceof Error ? err.message : String(err))
    return { ok: false, error: "Could not load beneficiaries." }
  }
}

/**
 * Admin approves a routing request and routes it to the chosen beneficiary.
 * The full SWIFT FIN text is emailed to the beneficiary on success.
 */
export async function approveSwiftRoutingAdmin(
  passcode: string,
  id: string,
  beneficiary: { userId: string | null; email: string; name: string },
): Promise<{ ok: true; request: SwiftRoutingRequest; emailed: boolean } | { ok: false; error: string }> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: "Administrator authorization failed." }
  const email = beneficiary.email.trim()
  const name = beneficiary.name.trim()
  if (!email) return { ok: false, error: "Enter a recipient email before routing." }
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid recipient email address." }
  // External (non-customer) recipients have no platform user id but must be
  // identified by name so the transmission advice is properly addressed.
  if (!beneficiary.userId && !name) return { ok: false, error: "Enter the external recipient's name." }

  const session = await resolveCurrentSession()
  const decidedBy = session?.profile.fullName || "Administrator"

  try {
    const existing = await getSwiftRoutingRequest(id)
    if (!existing) return { ok: false, error: "Routing request not found." }
    if (existing.status !== "pending") return { ok: false, error: "This request has already been decided." }

    const request = await approveSwiftRoutingRequest(
      id,
      { userId: beneficiary.userId, email, name: name || email },
      decidedBy,
    )
    if (!request) return { ok: false, error: "This request has already been decided." }

    const res = await sendSwiftRoutedEmail(
      request.beneficiaryEmail || email,
      request.beneficiaryName || name || email,
      emailInfo(request),
      request.raw,
    )
    return { ok: true, request, emailed: res.ok }
  } catch (err) {
    console.log("[v0] approveSwiftRoutingAdmin failed:", err instanceof Error ? err.message : String(err))
    return { ok: false, error: "Could not route the message. Please try again." }
  }
}

/** Admin declines a routing request. */
export async function declineSwiftRoutingAdmin(
  passcode: string,
  id: string,
  reason: string,
): Promise<{ ok: true; request: SwiftRoutingRequest } | { ok: false; error: string }> {
  if (!(await adminActionAuthorized(passcode))) return { ok: false, error: "Administrator authorization failed." }

  const session = await resolveCurrentSession()
  const decidedBy = session?.profile.fullName || "Administrator"

  try {
    const request = await declineSwiftRoutingRequest(id, reason || "Declined by administrator.", decidedBy)
    if (!request) return { ok: false, error: "This request has already been decided or does not exist." }
    return { ok: true, request }
  } catch (err) {
    console.log("[v0] declineSwiftRoutingAdmin failed:", err instanceof Error ? err.message : String(err))
    return { ok: false, error: "Could not decline the request. Please try again." }
  }
}
