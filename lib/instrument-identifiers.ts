// ---------------------------------------------------------------------------
// Bank-instrument identifiers + issuing-bank registry.
//
// Pure, environment-agnostic helpers that give every issued instrument the full
// set of identifiers a real Standby Letter of Credit, Bank Guarantee or Medium
// Term Note carries: a properly check-summed ISIN, a Euroclear/Clearstream
// Common Code, a US CUSIP (where applicable), a unique serial reference, the
// governing rules (ISP98 / URDG 758 / UCP 600), delivery method (SWIFT MT760 /
// book-entry) and the issuing bank's verified BIC + registered address.
//
// No browser/React dependencies, so it can be shared by the store, the
// instrument pages and the certificate PDF generator.
// ---------------------------------------------------------------------------

import { PARTNER_BANKS, partnerBankByKey } from "@/lib/partner-banks"

export interface IssuingBankProfile {
  /** Display name shown across the app and on the certificate letterhead. */
  name: string
  /** Verified SWIFT/BIC of the issuing bank. */
  bic: string
  /** Registered office address printed on the certificate. */
  address: string
  /** Country of incorporation. */
  country: string
  /** ISO 3166-1 alpha-2 code, used as the ISIN country prefix. */
  countryCode: string
}

/**
 * Registry of issuing banks keyed by the value used in the "Issuing Bank"
 * select. BICs and registered addresses are the banks' real, publicly listed
 * head-office details so generated instruments look authentic.
 */
export const ISSUING_BANKS: Record<string, IssuingBankProfile> = {
  natwest: {
    name: "NatWest Bank PLC",
    bic: "NWBKGB2L",
    address: "250 Bishopsgate, London EC2M 4AA",
    country: "United Kingdom",
    countryCode: "GB",
  },
  jpmorgan: {
    name: "JP Morgan Chase Bank, N.A.",
    bic: "CHASUS33",
    address: "383 Madison Avenue, New York, NY 10179",
    country: "United States",
    countryCode: "US",
  },
  ubs: {
    name: "UBS Switzerland AG",
    bic: "UBSWCHZH80A",
    address: "Bahnhofstrasse 45, 8001 Zürich",
    country: "Switzerland",
    countryCode: "CH",
  },
  hsbc: {
    name: "HSBC Bank PLC, London",
    bic: "HBUKGB4B",
    address: "8 Canada Square, London E14 5HQ",
    country: "United Kingdom",
    countryCode: "GB",
  },
  deutsche: {
    name: "Deutsche Bank AG",
    bic: "DEUTDEFF",
    address: "Taunusanlage 12, 60325 Frankfurt am Main",
    country: "Germany",
    countryCode: "DE",
  },
  barclays: {
    name: "Barclays Bank PLC",
    bic: "BARCGB22",
    address: "1 Churchill Place, London E14 5HP",
    country: "United Kingdom",
    countryCode: "GB",
  },
}

/**
 * Look up a bank profile by its select key (or display name as a fallback).
 *
 * Resolution order:
 *  1. The curated `ISSUING_BANKS` registry (full head-office address details).
 *  2. The centralized worldwide `PARTNER_BANKS` catalogue, so any bank the admin
 *     can pick in the issuing-bank selector still yields a genuine BIC, country
 *     and ISIN prefix. A registered address is synthesised from the country when
 *     the catalogue does not carry a street address.
 */
export function resolveIssuingBank(keyOrName: string): IssuingBankProfile | undefined {
  if (ISSUING_BANKS[keyOrName]) return ISSUING_BANKS[keyOrName]
  const lower = keyOrName.trim().toLowerCase()
  const curated = Object.values(ISSUING_BANKS).find((b) => b.name.toLowerCase() === lower)
  if (curated) return curated

  // Fall back to the worldwide partner-bank catalogue (single source of truth).
  const partner =
    partnerBankByKey(keyOrName) ??
    PARTNER_BANKS.find((b) => b.name.toLowerCase() === lower)
  if (!partner) return undefined
  return {
    name: partner.name,
    bic: partner.bic,
    address: `Registered Office, ${partner.country}`,
    country: partner.country,
    countryCode: partner.countryCode,
  }
}

// --- ISIN ------------------------------------------------------------------
// An ISIN is a 2-letter country prefix + 9-character NSIN + 1 Luhn check digit.

/** Compute the ISIN check digit for the 11-character prefix+NSIN body. */
function isinCheckDigit(body: string): number {
  // Expand letters to their numeric values (A=10 … Z=35) into one digit string.
  let digits = ""
  for (const ch of body.toUpperCase()) {
    if (ch >= "0" && ch <= "9") {
      digits += ch
    } else {
      digits += (ch.charCodeAt(0) - 55).toString() // 'A'(65) -> 10
    }
  }
  // Luhn from the right, doubling every second digit.
  let sum = 0
  let double = true
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return (10 - (sum % 10)) % 10
}

const NSIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

function randomNsin(len: number): string {
  let out = ""
  for (let i = 0; i < len; i++) {
    out += NSIN_ALPHABET[Math.floor(Math.random() * NSIN_ALPHABET.length)]
  }
  return out
}

/**
 * Generate a valid ISIN for the given country prefix (defaults to "XS", the
 * prefix used for international/Eurobond securities cleared through Euroclear &
 * Clearstream — typical for bank-issued MTNs and tradable instruments).
 */
export function generateIsin(countryCode = "XS"): string {
  const prefix = (countryCode || "XS").toUpperCase().slice(0, 2)
  const nsin = randomNsin(9)
  const body = prefix + nsin
  return body + isinCheckDigit(body)
}

/** Validate an ISIN's structure and check digit. */
export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false
  const body = isin.slice(0, 11)
  const check = Number.parseInt(isin.slice(11), 10)
  return isinCheckDigit(body) === check
}

// --- Other identifiers -----------------------------------------------------

/** 9-digit Euroclear/Clearstream Common Code. */
export function generateCommonCode(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999))
}

/** 9-character US CUSIP (8 alphanumerics + check digit), used for US issuers. */
export function generateCusip(): string {
  const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let base = ""
  for (let i = 0; i < 8; i++) base += ALPHA[Math.floor(Math.random() * 36)]
  let sum = 0
  for (let i = 0; i < 8; i++) {
    let v = ALPHA.indexOf(base[i])
    if (i % 2 === 1) v *= 2
    sum += Math.floor(v / 10) + (v % 10)
  }
  const check = (10 - (sum % 10)) % 10
  return base + check
}

/**
 * Validate a 9-character US CUSIP: 8 alphanumerics + a correct check digit.
 * `*`, `@`, `#` are technically valid CUSIP characters but never used by real
 * issuers, so we reject them. Returns true only for a structurally valid CUSIP
 * whose check digit is correct — we never fabricate or "fix" one.
 */
export function isValidCusip(cusip: string): boolean {
  const v = (cusip || "").trim().toUpperCase()
  if (!/^[0-9A-Z]{8}[0-9]$/.test(v)) return false
  const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let sum = 0
  for (let i = 0; i < 8; i++) {
    let val = ALPHA.indexOf(v[i])
    if (i % 2 === 1) val *= 2
    sum += Math.floor(val / 10) + (val % 10)
  }
  const check = (10 - (sum % 10)) % 10
  return check === Number.parseInt(v[8], 10)
}

/** Unique instrument serial / SWIFT documentary reference. */
export function generateSerialNumber(typeCode: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "")
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${typeCode}/${stamp}/${rand}`
}

// --- Per-type regulatory metadata ------------------------------------------

export interface InstrumentTypeRules {
  governingLaw: string
  deliveryMethod: string
  form: string
}

const TYPE_RULES: Record<string, InstrumentTypeRules> = {
  SBLC: {
    governingLaw: "ISP98 (ICC Publication No. 590)",
    deliveryMethod: "SWIFT MT760 (bank-to-bank, authenticated)",
    form: "Documentary, irrevocable, transferable",
  },
  BG: {
    governingLaw: "URDG 758 (ICC Uniform Rules for Demand Guarantees)",
    deliveryMethod: "SWIFT MT760 (bank-to-bank, authenticated)",
    form: "Demand guarantee, irrevocable",
  },
  MTN: {
    governingLaw: "English Law · Euroclear & Clearstream eligible",
    deliveryMethod: "Book-entry (global note, dematerialised)",
    form: "Global registered note, freely transferable",
  },
}

export function getInstrumentTypeRules(typeCode: string): InstrumentTypeRules {
  return (
    TYPE_RULES[typeCode] ?? {
      governingLaw: "ICC Uniform Rules",
      deliveryMethod: "SWIFT-authenticated delivery",
      form: "Irrevocable, transferable",
    }
  )
}

// --- One-call enrichment ---------------------------------------------------

export interface InstrumentIdentifiers {
  isin: string
  commonCode: string
  cusip?: string
  serialNumber: string
  issuerBic: string
  issuerAddress: string
  issuerCountry: string
  placeOfIssue: string
  governingLaw: string
  deliveryMethod: string
  form: string
}

/**
 * Build the full identifier set for a newly created instrument. `bankKey` is the
 * select value (e.g. "hsbc"); `typeCode` is the short code (SBLC/BG/MTN).
 */
export function buildInstrumentIdentifiers(
  bankKey: string,
  typeCode: string,
  date = new Date(),
): InstrumentIdentifiers {
  const bank = resolveIssuingBank(bankKey)
  const countryCode = bank?.countryCode ?? "XS"
  const rules = getInstrumentTypeRules(typeCode)
  // MTNs are international securities → XS prefix; LC/BG carry the issuer's country.
  const isinPrefix = typeCode === "MTN" ? "XS" : countryCode
  return {
    isin: generateIsin(isinPrefix),
    commonCode: generateCommonCode(),
    cusip: countryCode === "US" ? generateCusip() : undefined,
    serialNumber: generateSerialNumber(typeCode, date),
    issuerBic: bank?.bic ?? "—",
    issuerAddress: bank?.address ?? "—",
    issuerCountry: bank?.country ?? "—",
    placeOfIssue: bank ? `${bank.address.split(",").pop()?.trim() || bank.country}` : "—",
    governingLaw: rules.governingLaw,
    deliveryMethod: rules.deliveryMethod,
    form: rules.form,
  }
}
