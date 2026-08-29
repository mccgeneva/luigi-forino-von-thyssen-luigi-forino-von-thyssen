// Management / settlement fee charged to the client's Master Account when they
// DELETE ("settle out") a bank instrument they hold. Denominated in the
// instrument's own currency and computed as a percentage of its face value.
//
// Kept in this plain, dependency-free module so BOTH the client dialog (to show
// the fee up-front) and the server delete action (to charge it) can import it —
// a "use server" file may only export async functions, so this constant cannot
// live in the approvals action.

/** 0.035% of the instrument face value. */
export const INSTRUMENT_MANAGEMENT_FEE_RATE = 0.00035

/** Human label for the rate, e.g. shown in dialogs and ledger comments. */
export const INSTRUMENT_MANAGEMENT_FEE_LABEL = "0.035%"

/**
 * The management / settlement fee for deleting an instrument of the given face
 * value. Returns 0 for a non-finite or non-positive face value. Rounded to 2dp.
 */
export function instrumentManagementFee(faceValue: number): number {
  if (!Number.isFinite(faceValue) || faceValue <= 0) return 0
  return Math.round(faceValue * INSTRUMENT_MANAGEMENT_FEE_RATE * 100) / 100
}

/** Format a fee amount as `EUR 8,750.00`. */
export function formatInstrumentFee(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
