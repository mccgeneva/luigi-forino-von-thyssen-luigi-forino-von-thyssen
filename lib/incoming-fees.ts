// Platform-wide INCOMING-TRANSACTION FEE.
//
// A flat 2% fee is charged on every inbound credit to a customer's Master
// Account — SWIFT-uploaded credits, gateway (Collect-funds) deposits,
// registered-account deposits, master-IBAN matches and reconciled inbound
// payments. It is DEDUCTED FROM THE CREDIT (the customer receives the net),
// and it applies IN ADDITION TO the 0.5% FX fee when the payment is also a
// currency conversion.
//
// Pure + framework-free so it can be imported by "use server" modules (which
// may only export async functions) — the rate/label/helper live here, not in
// the server action files.

export const INCOMING_TRANSACTION_FEE_RATE = 0.02
export const INCOMING_TRANSACTION_FEE_LABEL = "2%"

/**
 * The 2% incoming-transaction fee, computed on the amount (already converted
 * into the account currency) that is being credited. Rounded to 2 decimals.
 * Returns 0 for a non-positive / non-finite base so it can never manufacture a
 * negative credit.
 */
export function incomingTransactionFee(grossInAccountCurrency: number): number {
  if (!Number.isFinite(grossInAccountCurrency) || grossInAccountCurrency <= 0) return 0
  return Math.round(grossInAccountCurrency * INCOMING_TRANSACTION_FEE_RATE * 100) / 100
}

// Platform-wide INTERNAL P2P TRANSFER FEE.
//
// A flat 2% fee is charged on internal account-to-account transfers between two
// MCC accounts (the /dashboard/send flow). It is DEDUCTED FROM THE RECIPIENT:
// the sender is debited the full amount and the recipient receives the net 98%.
// (Outgoing EXTERNAL/SWIFT payments carry their own separate 2% platform fee
// charged on top of the amount — that is unchanged and unrelated to this.)

export const INTERNAL_TRANSFER_FEE_RATE = 0.02
export const INTERNAL_TRANSFER_FEE_LABEL = "2%"

/**
 * The 2% internal-transfer fee, computed on the transfer amount, deducted from
 * the recipient's credit. Rounded to 2 decimals. Returns 0 for a non-positive /
 * non-finite base so it can never manufacture a negative credit.
 */
export function internalTransferFee(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * INTERNAL_TRANSFER_FEE_RATE * 100) / 100
}
