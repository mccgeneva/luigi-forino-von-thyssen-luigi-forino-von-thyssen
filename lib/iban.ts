// ---------------------------------------------------------------------------
// IBAN generation & validation
// ---------------------------------------------------------------------------
//
// Produces and validates IBANs that conform to the official ISO 13616 country
// structures and the ISO 7064 MOD-97-10 checksum. Every IBAN generated here is
// guaranteed to pass `isValidIban`, so the gateway never issues a malformed or
// fake account number.
//
// Note: the IBAN system does not cover every country. The United States and
// Singapore (and others) settle domestically (ABA routing / local clearing) and
// have no IBAN. For those jurisdictions we issue domestic coordinates instead of
// an IBAN — see `countrySupportsIban`.

// BBAN segment: a run of characters of a given kind.
//  - "n" = digits 0-9
//  - "a" = uppercase letters A-Z
//  - "c" = alphanumeric (digits + uppercase letters)
import { generateValidUkAccount } from "./uk-modulus"

type SegmentKind = "n" | "a" | "c"

interface BbanSegment {
  kind: SegmentKind
  length: number
  // When set, the generator seeds this segment from the bank's BIC stem
  // (institution identifier) instead of random data, for realism.
  fromBankStem?: boolean
}

interface IbanSpec {
  /** Total IBAN length including the 2-letter country code + 2 check digits. */
  length: number
  /** BBAN structure (everything after the 4-char prefix). */
  bban: BbanSegment[]
}

// Structures for the IBAN countries relevant to the partner-bank network, plus a
// handful of common ones for robustness. Lengths/structures follow the official
// IBAN registry.
export const IBAN_SPECS: Record<string, IbanSpec> = {
  GB: { length: 22, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 6 }, { kind: "n", length: 8 }] },
  IE: { length: 22, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 6 }, { kind: "n", length: 8 }] },
  CH: { length: 21, bban: [{ kind: "n", length: 5 }, { kind: "c", length: 12 }] },
  LU: { length: 20, bban: [{ kind: "n", length: 3 }, { kind: "c", length: 13 }] },
  FR: { length: 27, bban: [{ kind: "n", length: 5 }, { kind: "n", length: 5 }, { kind: "c", length: 11 }, { kind: "n", length: 2 }] },
  DE: { length: 22, bban: [{ kind: "n", length: 8 }, { kind: "n", length: 10 }] },
  NL: { length: 18, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 10 }] },
  ES: { length: 24, bban: [{ kind: "n", length: 4 }, { kind: "n", length: 4 }, { kind: "n", length: 1 }, { kind: "n", length: 1 }, { kind: "n", length: 10 }] },
  IT: { length: 27, bban: [{ kind: "a", length: 1 }, { kind: "n", length: 5 }, { kind: "n", length: 5 }, { kind: "c", length: 12 }] },
  BE: { length: 16, bban: [{ kind: "n", length: 3 }, { kind: "n", length: 7 }, { kind: "n", length: 2 }] },
  AT: { length: 20, bban: [{ kind: "n", length: 5 }, { kind: "n", length: 11 }] },
  PT: { length: 25, bban: [{ kind: "n", length: 4 }, { kind: "n", length: 4 }, { kind: "n", length: 11 }, { kind: "n", length: 2 }] },
  FI: { length: 18, bban: [{ kind: "n", length: 14 }] },
  SE: { length: 24, bban: [{ kind: "n", length: 20 }] },
  NO: { length: 15, bban: [{ kind: "n", length: 11 }] },
  DK: { length: 18, bban: [{ kind: "n", length: 14 }] },
  AE: { length: 23, bban: [{ kind: "n", length: 3 }, { kind: "n", length: 16 }] },
  SA: { length: 24, bban: [{ kind: "n", length: 2 }, { kind: "c", length: 18 }] },
  QA: { length: 29, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "c", length: 21 }] },
  // --- Additional IBAN jurisdictions (official ISO 13616 lengths) ---
  // Central & Eastern Europe
  PL: { length: 28, bban: [{ kind: "n", length: 24 }] },
  CZ: { length: 24, bban: [{ kind: "n", length: 20 }] },
  SK: { length: 24, bban: [{ kind: "n", length: 20 }] },
  HU: { length: 28, bban: [{ kind: "n", length: 24 }] },
  RO: { length: 24, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "c", length: 16 }] },
  HR: { length: 21, bban: [{ kind: "n", length: 17 }] },
  SI: { length: 19, bban: [{ kind: "n", length: 15 }] },
  BG: { length: 22, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 6 }, { kind: "c", length: 8 }] },
  LT: { length: 20, bban: [{ kind: "n", length: 16 }] },
  LV: { length: 21, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "c", length: 13 }] },
  EE: { length: 20, bban: [{ kind: "n", length: 16 }] },
  GR: { length: 27, bban: [{ kind: "n", length: 7 }, { kind: "c", length: 16 }] },
  CY: { length: 28, bban: [{ kind: "n", length: 8 }, { kind: "c", length: 16 }] },
  MT: { length: 31, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 5 }, { kind: "c", length: 18 }] },
  IS: { length: 26, bban: [{ kind: "n", length: 22 }] },
  LI: { length: 21, bban: [{ kind: "n", length: 5 }, { kind: "c", length: 12 }] },
  TR: { length: 26, bban: [{ kind: "n", length: 6 }, { kind: "c", length: 16 }] },
  UA: { length: 29, bban: [{ kind: "n", length: 6 }, { kind: "c", length: 19 }] },
  // Middle East & North Africa
  IL: { length: 23, bban: [{ kind: "n", length: 19 }] },
  BH: { length: 22, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "c", length: 14 }] },
  KW: { length: 30, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "c", length: 22 }] },
  JO: { length: 30, bban: [{ kind: "a", length: 4, fromBankStem: true }, { kind: "n", length: 4 }, { kind: "c", length: 18 }] },
  LB: { length: 28, bban: [{ kind: "n", length: 4 }, { kind: "c", length: 20 }] },
  EG: { length: 29, bban: [{ kind: "n", length: 25 }] },
}

const DIGITS = "0123456789"
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const ALNUM = DIGITS + LETTERS

export function countrySupportsIban(countryCode?: string): boolean {
  return !!countryCode && countryCode.toUpperCase() in IBAN_SPECS
}

function randomChars(kind: SegmentKind, length: number): string {
  const alphabet = kind === "n" ? DIGITS : kind === "a" ? LETTERS : ALNUM
  let out = ""
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

// Convert a string to its numeric form for MOD-97: letters map A=10 … Z=35.
function toNumericString(input: string): string {
  let out = ""
  for (const ch of input.toUpperCase()) {
    if (ch >= "0" && ch <= "9") out += ch
    else if (ch >= "A" && ch <= "Z") out += (ch.charCodeAt(0) - 55).toString()
    else throw new Error(`Invalid IBAN character: ${ch}`)
  }
  return out
}

// MOD-97 over an arbitrarily long numeric string (avoids BigInt overflow).
function mod97(numeric: string): number {
  let remainder = 0
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + (numeric.charCodeAt(i) - 48)) % 97
  }
  return remainder
}

// Compute the 2 check digits for a country + BBAN per ISO 7064 MOD-97-10.
function computeCheckDigits(countryCode: string, bban: string): string {
  const rearranged = bban + countryCode + "00"
  const remainder = mod97(toNumericString(rearranged))
  const check = 98 - remainder
  return check.toString().padStart(2, "0")
}

/** Normalize an IBAN: strip spaces, uppercase. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase()
}

/** Format an IBAN in groups of four for display. */
export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, "$1 ").trim()
}

/**
 * Validate an IBAN's country structure (known country, exact length, allowed
 * characters per segment) AND its MOD-97 checksum. Returns true only for a
 * fully valid IBAN.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value)
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false
  const country = iban.slice(0, 2)
  const spec = IBAN_SPECS[country]
  if (!spec) return false
  if (iban.length !== spec.length) return false

  // Validate each BBAN segment against its allowed character class.
  const bban = iban.slice(4)
  let pos = 0
  for (const seg of spec.bban) {
    const chunk = bban.slice(pos, pos + seg.length)
    if (chunk.length !== seg.length) return false
    const pattern = seg.kind === "n" ? /^[0-9]+$/ : seg.kind === "a" ? /^[A-Z]+$/ : /^[A-Z0-9]+$/
    if (!pattern.test(chunk)) return false
    pos += seg.length
  }
  if (pos !== bban.length) return false

  // MOD-97 checksum: rearrange (BBAN + country + check) and confirm remainder 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  return mod97(toNumericString(rearranged)) === 1
}

// ---------------------------------------------------------------------------
// National (in-BBAN) check digits
// ---------------------------------------------------------------------------
//
// Several countries embed their own check digit(s) inside the BBAN, computed
// over the bank/branch/account before the IBAN's own MOD-97 check. A generated
// IBAN is only accepted by real validators if these are correct too, so we
// compute them rather than emitting random digits.

const onlyDigits = (s: string) => s.replace(/\D/g, "")

/** France RIB key: 97 - ((89·banque + 15·guichet + 3·compte) mod 97). */
function frenchRibKey(banque: string, guichet: string, compteNumeric: string): string {
  // Each component reduced mod 97 first to keep the arithmetic exact.
  const b = mod97(banque)
  const g = mod97(guichet)
  const c = mod97(compteNumeric)
  const key = 97 - ((89 * b + 15 * g + 3 * c) % 97)
  return String(key).padStart(2, "0")
}

/** Spanish single control digit (mod 11) over a 10-char digit string. */
function spanishControlDigit(tenDigits: string): string {
  const weights = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(tenDigits[i]) * weights[i]
  let dc = 11 - (sum % 11)
  if (dc === 10) dc = 1
  else if (dc === 11) dc = 0
  return String(dc)
}

/** Italian CIN: a check letter over ABI+CAB+account (22 chars). */
function italianCin(abiCabAccount: string): string {
  const odd: Record<string, number> = {
    "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
    A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
    N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
  }
  const even: Record<string, number> = {
    "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12,
    N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19, U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
  }
  let sum = 0
  for (let i = 0; i < abiCabAccount.length; i++) {
    // Position 1 (i=0) is odd.
    sum += i % 2 === 0 ? odd[abiCabAccount[i]] : even[abiCabAccount[i]]
  }
  return String.fromCharCode(65 + (sum % 26))
}

/** Belgian national check: last 2 digits = (bank+account) mod 97, 0→97. */
function belgianCheck(elevenDigits: string): string {
  let r = mod97(elevenDigits)
  if (r === 0) r = 97
  return String(r).padStart(2, "0")
}

/** Portuguese NIB check: 98 - ((bank+branch+account)·100 mod 97), ISO 7064. */
function portugueseCheck(nineteenDigits: string): string {
  const r = mod97(nineteenDigits + "00")
  return String(98 - r).padStart(2, "0")
}

/** Norwegian mod-11 check digit over the first 10 digits; null if unusable. */
function norwegianCheck(tenDigits: string): string | null {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i++) sum += Number(tenDigits[i]) * weights[i]
  const rem = sum % 11
  if (rem === 0) return "0"
  const dc = 11 - rem
  if (dc === 10) return null // not representable — caller retries
  return String(dc)
}

/** Finnish check digit (Luhn over the first 13 digits). */
function finnishCheck(thirteenDigits: string): string {
  let sum = 0
  let weightTwo = true
  for (let i = thirteenDigits.length - 1; i >= 0; i--) {
    let v = Number(thirteenDigits[i]) * (weightTwo ? 2 : 1)
    if (v > 9) v -= 9
    sum += v
    weightTwo = !weightTwo
  }
  return String((10 - (sum % 10)) % 10)
}

// ---------------------------------------------------------------------------
// Per-country BBAN builders
// ---------------------------------------------------------------------------
//
// Each builder lays down the bank/branch identifier from `nbc` (the partner
// bank's real national clearing code), fills the account portion with random
// digits, and computes any national check digit so the BBAN is fully valid.

type BbanBuilder = (bicStem: string, nbc: string | undefined) => string

const pad = (s: string | undefined, len: number) => onlyDigits(s ?? "").padEnd(len, "0").slice(0, len)
const stem4 = (bicStem?: string) =>
  ((bicStem ?? "").toUpperCase().replace(/[^A-Z]/g, "") + "AAAA").slice(0, 4)

const BBAN_BUILDERS: Record<string, BbanBuilder> = {
  // 4-letter bank code (BIC stem) + 6-digit sort code + 8-digit account.
  // The 8-digit account must satisfy the VocaLink modulus check for its sort
  // code (the domestic check UK banks and IBAN validators apply on top of the
  // IBAN mod-97 checksum), so we generate it from the sort code rather than at
  // random — otherwise the IBAN is mod-97-valid but flagged "account number
  // checksum incorrect" by external checkers.
  GB: (s, n) => {
    const sort = onlyDigits(n ?? "") ? pad(n, 6) : randomChars("n", 6)
    return stem4(s) + sort + generateValidUkAccount(sort)
  },
  IE: (s, n) => stem4(s) + (onlyDigits(n ?? "") ? pad(n, 6) : randomChars("n", 6)) + randomChars("n", 8),
  // 8-digit BLZ + 10-digit account.
  DE: (_s, n) => pad(n, 8) + randomChars("n", 10),
  // 4-letter bank code (BIC stem) + 10-digit account.
  NL: (s) => stem4(s) + randomChars("n", 10),
  // 5-digit clearing + 12-char account.
  CH: (_s, n) => pad(n, 5) + randomChars("c", 12),
  // 3-digit bank + 13-char account.
  LU: (_s, n) => pad(n, 3) + randomChars("c", 13),
  // 5-digit bank + 11-digit account.
  AT: (_s, n) => pad(n, 5) + randomChars("n", 11),
  // banque(5) + guichet(5) + compte(11) + RIB key(2).
  FR: (_s, n) => {
    const banque = pad(n, 5)
    const guichet = pad((n ?? "").slice(5), 5)
    // Compte is alphanumeric in spec; use digits so the RIB key (numeric) holds.
    const compte = randomChars("n", 11)
    return banque + guichet + compte + frenchRibKey(banque, guichet, compte)
  },
  // entidad(4) + oficina(4) + 2 control digits + account(10).
  ES: (_s, n) => {
    const entidad = pad(n, 4)
    const oficina = pad((n ?? "").slice(4), 4)
    const account = randomChars("n", 10)
    const dc1 = spanishControlDigit("00" + entidad + oficina)
    const dc2 = spanishControlDigit(account)
    return entidad + oficina + dc1 + dc2 + account
  },
  // CIN(1 letter) + ABI(5) + CAB(5) + account(12).
  IT: (_s, n) => {
    const abi = pad(n, 5)
    const cab = pad((n ?? "").slice(5), 5)
    const account = randomChars("n", 12)
    return italianCin(abi + cab + account) + abi + cab + account
  },
  // bank(3) + account(7) + national check(2).
  BE: (_s, n) => {
    const bank = pad(n, 3)
    const account = randomChars("n", 7)
    return bank + account + belgianCheck(bank + account)
  },
  // bank(4) + branch(4) + account(11) + NIB check(2).
  PT: (_s, n) => {
    const bank = pad(n, 4)
    const branch = pad((n ?? "").slice(4), 4)
    const account = randomChars("n", 11)
    return bank + branch + account + portugueseCheck(bank + branch + account)
  },
  // 6-digit bank/office + 7-digit account + Finnish check digit.
  FI: (_s, n) => {
    const bank = pad(n, 6)
    const account = randomChars("n", 7)
    return bank + account + finnishCheck(bank + account)
  },
  // 3-digit clearing + 17-digit account.
  SE: (_s, n) => pad(n, 3) + randomChars("n", 17),
  // 4-digit bank + 6-digit account + mod-11 check (retry if unusable).
  NO: (_s, n) => {
    const bank = pad(n, 4)
    for (let i = 0; i < 50; i++) {
      const account = randomChars("n", 6)
      const check = norwegianCheck(bank + account)
      if (check) return bank + account + check
    }
    return bank + "000000" + "0"
  },
  // 4-digit registration + 10-digit account.
  DK: (_s, n) => pad(n, 4) + randomChars("n", 10),
  // 3-digit bank + 16-digit account.
  AE: (_s, n) => pad(n, 3) + randomChars("n", 16),
  // 2-digit bank + 18-char account.
  SA: (_s, n) => pad(n, 2) + randomChars("c", 18),
  // 4-letter bank code (BIC stem) + 21-char account.
  QA: (s) => stem4(s) + randomChars("c", 21),
}

/**
 * Generate a fully valid IBAN for a country. When `nationalBankCode` is given
 * (the partner bank's real domestic clearing code) it seeds the bank-code
 * portion so the IBAN resolves to a genuine institution; any country-specific
 * national check digits are computed too. `bankStem` (first 4 chars of the BIC)
 * is used where the bank code is the institution's letter code (GB/IE/NL/QA).
 * Throws if the country has no IBAN structure.
 */
export function generateIban(countryCode: string, bankStem?: string, nationalBankCode?: string): string {
  const country = countryCode.toUpperCase()
  const spec = IBAN_SPECS[country]
  if (!spec) throw new Error(`No IBAN structure for country ${country}`)

  const builder = BBAN_BUILDERS[country]
  let bban: string
  if (builder) {
    bban = builder(bankStem ?? "", nationalBankCode)
  } else {
    // Fallback for any IBAN country without a dedicated builder.
    bban = ""
    let stemUsed = false
    for (const seg of spec.bban) {
      if (seg.fromBankStem && bankStem && !stemUsed) {
        const cleaned = bankStem.toUpperCase().replace(/[^A-Z]/g, "")
        bban += (cleaned + randomChars("a", seg.length)).slice(0, seg.length)
        stemUsed = true
      } else {
        bban += randomChars(seg.kind, seg.length)
      }
    }
  }

  const check = computeCheckDigits(country, bban)
  const iban = `${country}${check}${bban}`
  // Defensive: a generation bug would be caught here rather than shipped.
  if (!isValidIban(iban)) {
    throw new Error(`Generated IBAN failed validation for ${country}`)
  }
  return iban
}
