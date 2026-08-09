import "server-only"

import { parseSwiftMessage } from "@/lib/swift-mt"
import { insertIncomingSwift, type IncomingSwiftMessage } from "@/lib/incoming-swift-db"
import { insertNotification } from "@/lib/notifications-db"

/**
 * Deliver a routed SWIFT message directly into a platform beneficiary's
 * "SWIFT Messages" inbox and raise an in-app notification.
 *
 * This is the in-app counterpart to the emailed transmission copy: when an
 * administrator approves & routes a message to an existing platform user, the
 * beneficiary must receive the SWIFT copy AND an alert inside the platform,
 * independent of whether the email actually reaches them (Resend config, spam,
 * etc.). External (non-customer) recipients have no inbox and get email only.
 */
export interface RoutedSwiftDelivery {
  userId: string
  beneficiaryName: string
  messageType: string
  senderBic: string
  receiverBic: string
  amount: string | null
  currency: string | null
  reference: string | null
  uetr: string | null
  raw: string
}

export async function deliverRoutedSwiftToInbox(
  d: RoutedSwiftDelivery,
): Promise<IncomingSwiftMessage> {
  const msg = parseSwiftMessage(d.raw)
  const beneficiaryIban = msg.beneficiary?.account ?? msg.beneficiaryInstitution?.account ?? ""
  const beneficiaryName =
    d.beneficiaryName || (msg.beneficiary?.nameAndAddress ?? []).find(Boolean) || ""
  const orderingCustomer =
    (msg.orderingCustomer?.nameAndAddress ?? []).find(Boolean) || d.senderBic || ""

  // Store amount prefixed with its currency (e.g. "EUR 75,000.00") to match the
  // inbox reader, which strips the leading currency code and shows it alongside.
  const amountLabel =
    d.amount && d.currency ? `${d.currency} ${d.amount}` : (d.amount ?? null)

  const stored = await insertIncomingSwift({
    userId: d.userId,
    status: "assigned",
    messageType: d.messageType,
    senderBic: d.senderBic,
    receiverBic: d.receiverBic,
    beneficiaryIban,
    beneficiaryName,
    orderingCustomer,
    amount: amountLabel,
    currency: d.currency,
    reference: d.reference,
    valueDate: msg.valueDate ?? null,
    uetr: d.uetr,
    raw: d.raw,
    matchedAccountId: null,
    matchedAccountHolder: beneficiaryName || null,
    bicConfirmed: false,
    matchReason: "Delivered to beneficiary inbox on administrator routing.",
  })

  await insertNotification({
    userId: d.userId,
    tone: "info",
    title: `SWIFT ${d.messageType} received`,
    body: `A ${d.messageType} message${amountLabel ? ` for ${amountLabel}` : ""} has been routed to you. View it in your SWIFT Messages.`,
    href: "/dashboard/swift",
  })

  return stored
}
