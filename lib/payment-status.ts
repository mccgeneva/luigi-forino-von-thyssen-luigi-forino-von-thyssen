/**
 * Canonical THREE-STAGE lifecycle for every bank wire transfer / outgoing
 * payment on the platform. This is the single source of truth for the labels,
 * short labels, and badge styling used across the client Payments view, Bank
 * Statements, Transactions, the Administrator panel, and notifications.
 *
 * Stage progression (strict):
 *   1. review     — "Payment in Review — Awaiting Approval"
 *                   Submitted by the client, awaiting the administrator (and any
 *                   required Master/referral) approval. No funds have moved.
 *   2. initiated  — "Payment Approved & Initiated"
 *                   Administrator approved; the transfer has been authorized and
 *                   the debit posted to the sender. The funds are on their way to
 *                   the banking partner / beneficiary bank.
 *   3. delivered  — "Payment Completed — Funds Delivered"
 *                   Administrator has confirmed the funds reached the beneficiary
 *                   account. Terminal, successful state.
 *
 * Two non-progression terminal states are kept for completeness:
 *   - rejected    — declined by the administrator or Master.
 *   - cancelled   — withdrawn by the client before a decision.
 *
 * This module has NO server-only imports so it can be used from both client
 * components and server actions.
 */

export type PaymentStage = "review" | "initiated" | "delivered" | "rejected" | "cancelled"

/**
 * Minimal shape needed to derive a payment's stage. Any record that carries an
 * approval `status` plus an optional delivery confirmation satisfies it — the
 * client `PaymentRequest` view-model and a raw DB approval record both do.
 */
export interface PaymentStageInput {
  /** Approval lifecycle status. Accepts the DB vocabulary as well as the
   *  client store's own ("pending" | "approved" | "rejected"). */
  status?: string | null
  /** Set once the administrator confirms funds reached the beneficiary. */
  deliveryStatus?: string | null
  /** Alternative delivery flag mirrored from `payload.delivered`. */
  delivered?: boolean | null
}

/** Full, human-facing stage label used for badges and detail rows. */
export const PAYMENT_STAGE_LABEL: Record<PaymentStage, string> = {
  review: "Payment in Review — Awaiting Approval",
  initiated: "Payment Approved & Initiated",
  delivered: "Payment Completed — Funds Delivered",
  rejected: "Payment Rejected",
  cancelled: "Payment Cancelled",
}

/** Compact label for dense tables / chips. */
export const PAYMENT_STAGE_SHORT: Record<PaymentStage, string> = {
  review: "In Review",
  initiated: "Approved & Initiated",
  delivered: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
}

/** One-line description of what each stage means, for tooltips / detail views. */
export const PAYMENT_STAGE_DESCRIPTION: Record<PaymentStage, string> = {
  review:
    "Submitted and awaiting administrator approval. No funds have left the account yet.",
  initiated:
    "Approved and initiated with the banking partner. Funds have been debited and are on their way to the beneficiary.",
  delivered:
    "Confirmed delivered — the funds have reached the beneficiary account. This payment is complete.",
  rejected: "This payment request was declined. No funds were moved.",
  cancelled: "This payment request was withdrawn before a decision was made.",
}

/**
 * Tailwind badge classes per stage, themed to the platform tokens. Review is a
 * cautionary amber, initiated a "processing" blue, delivered a success green,
 * rejected a destructive red, cancelled a muted grey.
 */
export const PAYMENT_STAGE_BADGE_CLASS: Record<PaymentStage, string> = {
  review: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  initiated: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  delivered: "bg-green-500/10 text-green-500 border-green-500/20",
  rejected: "bg-red-500/10 text-red-500 border-red-500/20",
  cancelled: "bg-muted text-muted-foreground border-border",
}

/** The ordered progression stages (excludes the terminal failure states). */
export const PAYMENT_PROGRESSION: PaymentStage[] = ["review", "initiated", "delivered"]

/** True once the administrator has confirmed delivery for this record. */
export function isDelivered(input: PaymentStageInput | null | undefined): boolean {
  if (!input) return false
  return input.delivered === true || input.deliveryStatus === "delivered"
}

/**
 * Derive the canonical three-stage status for a payment record. Handles both
 * the DB lifecycle vocabulary (`pending`/`awaiting_master`/`approved`/
 * `rejected`/`cancelled`) and the client store vocabulary (`pending`/
 * `approved`/`rejected`). An approved payment is `initiated` until the admin
 * confirms delivery, at which point it becomes `delivered`.
 */
export function getPaymentStage(input: PaymentStageInput | null | undefined): PaymentStage {
  const status = (input?.status ?? "pending").toLowerCase()
  if (status === "rejected") return "rejected"
  if (status === "cancelled") return "cancelled"
  if (status === "approved") {
    return isDelivered(input) ? "delivered" : "initiated"
  }
  // pending, awaiting_master, or anything unrecognized ⇒ still in review.
  return "review"
}

/** Convenience: the full label for a record in one call. */
export function paymentStageLabel(input: PaymentStageInput | null | undefined): string {
  return PAYMENT_STAGE_LABEL[getPaymentStage(input)]
}

/**
 * Map a three-stage payment status onto the SWIFT gpi tracker's payment status
 * vocabulary (`completed` / `processing` / `pending` / `failed`) so the gpi
 * timeline advances in lockstep with the lifecycle:
 *   review     → pending    (awaiting authorization)
 *   initiated  → processing (in transit — ACSP)
 *   delivered  → completed  (credited — ACSC, all steps done)
 *   rejected   → failed     (RJCT)
 */
export function paymentStageToGpiStatus(
  stage: PaymentStage,
): "completed" | "processing" | "pending" | "failed" {
  switch (stage) {
    case "delivered":
      return "completed"
    case "initiated":
      return "processing"
    case "rejected":
    case "cancelled":
      return "failed"
    default:
      return "pending"
  }
}
