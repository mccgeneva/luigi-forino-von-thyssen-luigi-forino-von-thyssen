// Plain (non-"use server") module for card-transaction fee constants.
// These MUST NOT live in app/actions/cards.ts — a "use server" file may only
// export async functions; exporting plain values there breaks the whole module
// at build time.

/** The platform fee applied to every recorded card transaction. */
export const CARD_TRANSACTION_FEE_RATE = 0.02
export const CARD_TRANSACTION_FEE_LABEL = "2%"
