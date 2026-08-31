// Platform fee on OUTGOING internal P2P transfers (/dashboard/send). The sender
// pays the amount PLUS this fee; the recipient still receives the full amount.
// Mirrors the 2% platform fee already charged on outgoing SWIFT payments.
//
// Plain module (NOT "use server") so it can be imported by both the client send
// page and the server ledger action.

export const INTERNAL_TRANSFER_FEE_RATE = 0.02
export const INTERNAL_TRANSFER_FEE_LABEL = "2%"

/** Round to 2 decimals. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * 2% platform fee on an outgoing internal transfer, in the transfer currency.
 * Returns 0 for a non-positive / non-finite amount.
 */
export function internalTransferFee(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return round2(amount * INTERNAL_TRANSFER_FEE_RATE)
}
