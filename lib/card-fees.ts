// One-time ("una tantum") card issuance fee charged to the client's Master
// Account each time a customer requests a new card through the Cards page.
// Denominated in EUR. Kept in this plain, dependency-free module so BOTH the
// client dialog (to show the fee) and the server approval gate (to enforce and
// charge it) can import it — a "use server" file may only export async
// functions, so these constants cannot live in the approvals action.

export type CardFeeFormat = "physical" | "virtual"

/** Fee per card format, in EUR. */
export const CARD_FEES: Record<CardFeeFormat, number> = {
  virtual: 300,
  physical: 1000,
}

export const CARD_FEE_CURRENCY = "EUR"

/** The one-time issuance fee (EUR) for a given card format. Unknown/missing
 *  formats default to the physical fee (the more conservative charge). */
export function cardFeeFor(format: string | undefined | null): number {
  return format === "virtual" ? CARD_FEES.virtual : CARD_FEES.physical
}

/** Format an EUR amount as `€1,000.00`. */
export function formatCardFee(amount: number): string {
  return `€${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
