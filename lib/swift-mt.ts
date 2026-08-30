// ---------------------------------------------------------------------------
// SWIFT MT message parser & generator — dependency-free, pure & unit-testable
// ---------------------------------------------------------------------------
//
// This module parses raw SWIFT FIN (MT) messages into structured objects and
// can generate well-formed MT text for outbound messages. It is intentionally
// free of "use server" and of any I/O so the logic stays pure and testable.
// The server / UI layers consume the typed output.
//
// Supported inbound parsing: MT103, MT202, MT202 COV, MT760, MT799 (and a
// generic fallback for any other MT type, exposing parsed blocks + fields).
//
// Supported generation (all round-trip through `parseSwiftMessage`):
//   - Payments:        MT101, MT103, MT202, MT202 COV
//   - Free-format:     MT199 / MT299 / MT799 / MT999
//   - Guarantees:      MT760 (issuance), MT767 / MT768 / MT769 (amendment family)
//   - Documentary LC:  MT700 / 707 / 710 / 720 / 730 / 740 / 742 / 747 / 750 / 752 / 754 / 756
//   - Securities:      MT540 / 541 / 542 / 543 / 544 / 545 / 546 / 547 (ISO 15022, Euroclear/DTC)
//
// MT760 (Guarantee / Standby Letter of Credit) and MT799 (free-format) are the
// instrument-messaging types used by the bank-instrument monetization desk for
// SBLC/BG issuance, collateral transfer and ready-willing-able (RWA) advice.
//
// References: SWIFT FIN block structure (Block 1 Basic Header, Block 2
// Application Header, Block 3 User Header incl. UETR field 121, Block 4
// Message Text, Block 5 Trailer) and the MT field catalogue (:20:, :32A:,
// :50K:, :59:, :71A:, etc.).

import { validateIban, validateBic } from "@/lib/iban-swift"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwiftMessageType = "MT103" | "MT202" | "MT202COV" | "MT760" | "MT799" | string

/** A single tag/value pair from Block 4 (e.g. tag "32A", value "240617EUR1500,00"). */
export interface SwiftField {
  /** Field tag without colons, e.g. "32A", "50K", "59". */
  tag: string
  /** Raw multi-line value as it appears in the message (newlines preserved). */
  value: string
}

/** The five SWIFT blocks in their raw (string) form. */
export interface SwiftBlocks {
  /** Block 1 — Basic Header (application id, service id, LT address, session, sequence). */
  basicHeader?: string
  /** Block 2 — Application Header (I/O, message type, recipient/sender, priority). */
  applicationHeader?: string
  /** Block 3 — User Header (tags incl. 121 = UETR, 108 = MUR, 111 = service type id). */
  userHeader?: Record<string, string>
  /** Block 4 — Message Text fields (ordered). */
  text: SwiftField[]
  /** Block 5 — Trailer (CHK, MAC, etc.). */
  trailer?: Record<string, string>
}

/** Parsed Basic Header (Block 1). */
export interface BasicHeader {
  applicationId?: string
  serviceId?: string
  /** Logical terminal address (12 chars: BIC + LT + branch). */
  ltAddress?: string
  /** Sender BIC derived from the LT address (first 8 chars). */
  senderBic?: string
  sessionNumber?: string
  sequenceNumber?: string
}

/** Parsed Application Header (Block 2). */
export interface ApplicationHeader {
  direction: "input" | "output" | "unknown"
  messageType?: string
  /** Recipient (input) or sender (output) address. */
  counterpartyAddress?: string
  counterpartyBic?: string
  priority?: string
  inputTime?: string
  outputDate?: string
  outputTime?: string
}

/** A party (ordering/beneficiary/institution) extracted from a party field. */
export interface SwiftParty {
  /** Option letter the party was carried under (A, K, F, etc.). */
  option?: string
  /** Account / IBAN line if present. */
  account?: string
  /** BIC if the option carried one (option A). */
  bic?: string
  /** Free-form name & address lines. */
  nameAndAddress: string[]
}

/** A normalized, business-level view of a parsed payment message. */
export interface ParsedSwiftMessage {
  /** Detected message type. */
  type: SwiftMessageType
  /** True when no structural / business validation errors were found. */
  valid: boolean
  /** Raw blocks. */
  blocks: SwiftBlocks
  basicHeader?: BasicHeader
  applicationHeader?: ApplicationHeader

  // --- Common enriched fields -------------------------------------------------
  /** :20: Sender's reference. */
  senderReference?: string
  /** :21: Related reference (202/COV). */
  relatedReference?: string
  /** UETR (Block 3 field 121) — gpi end-to-end reference. */
  uetr?: string
  /** Service type identifier (Block 3 field 111) — "001" indicates gpi. */
  serviceTypeId?: string
  /** True when the message carries gpi tracking data (UETR present). */
  gpiEnabled: boolean

  /** Value date (ISO yyyy-mm-dd) from :32A: / :32B:. */
  valueDate?: string
  /** ISO currency from :32A: / :32B:. */
  currency?: string
  /** Settlement / interbank amount. */
  amount?: number
  /** :33B: instructed (original) currency, when different. */
  instructedCurrency?: string
  instructedAmount?: number

  /** :50a: Ordering customer (MT103). */
  orderingCustomer?: SwiftParty
  /** :52a: Ordering institution. */
  orderingInstitution?: SwiftParty
  /** :57a: Account-with institution. */
  accountWithInstitution?: SwiftParty
  /** :58a: Beneficiary institution (202). */
  beneficiaryInstitution?: SwiftParty
  /** :59a: Beneficiary customer (103). */
  beneficiary?: SwiftParty
  /** :70: Remittance information. */
  remittanceInfo?: string
  /** :71A: Details of charges (OUR / BEN / SHA). */
  chargesDetail?: string
  /** :72: Sender to receiver information. */
  senderToReceiverInfo?: string

  /** For MT799 free-format text (:79:). */
  freeFormatText?: string

  /** Guarantee / SBLC details for MT760 (collateral transfer & issuance). */
  guarantee?: {
    /** :22A: Purpose of the message (ISSU, ICCO, etc.). */
    purpose?: string
    /** :22D: Form of the undertaking (DGAR demand guarantee, STBY standby LC). */
    form?: string
    /** :40C: Applicable rules (URDG, ISPR, etc.). */
    applicableRules?: string
    /** :23B: / :30: issue or effective date when present (ISO yyyy-mm-dd). */
    issueDate?: string
    /** :31E: / :35G: expiry date (ISO yyyy-mm-dd). */
    expiryDate?: string
    /** :32B: undertaking amount currency. */
    currency?: string
    /** :32B: undertaking amount. */
    amount?: number
    /** :50: applicant (instructing party). */
    applicant?: SwiftParty
    /** :59: beneficiary of the undertaking. */
    beneficiary?: SwiftParty
    /** :77C: / :77U: terms and conditions narrative. */
    terms?: string
  }

  /** Underlying customer credit transfer fields for MT202 COV (sequence B). */
  coverPayment?: {
    orderingCustomer?: SwiftParty
    beneficiary?: SwiftParty
    remittanceInfo?: string
  }

  /** Non-fatal warnings (e.g. unrecognized currency, suspicious BIC). */
  warnings: string[]
  /** Fatal structural / business errors. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

/**
 * Split a raw SWIFT message into its `{n:...}` blocks. Handles the nested
 * structure of Block 4 (which is delimited by `-}` and contains `:tag:` lines)
 * and the sub-block structure of Blocks 3 & 5.
 */
export function splitBlocks(raw: string): SwiftBlocks {
  const blocks: SwiftBlocks = { text: [] }
  if (!raw) return blocks

  const text = raw.replace(/\r\n/g, "\n").trim()

  // Match top-level blocks {1:...}, {2:...}, {3:...}, {4:...-}, {5:...}
  // Block 4 ends with "-}" so we capture greedily up to that terminator.
  const blockRegex = /\{(\d):/g
  let match: RegExpExecArray | null
  const indices: { id: string; start: number }[] = []
  while ((match = blockRegex.exec(text)) !== null) {
    // Only treat as a top-level block opener if at string start or preceded
    // by a block close `}` / whitespace (avoid matching inside content).
    const before = text.slice(0, match.index).trimEnd()
    if (match.index === 0 || before.endsWith("}")) {
      indices.push({ id: match[1], start: match.index })
    }
  }

  for (let i = 0; i < indices.length; i++) {
    const { id, start } = indices[i]
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length
    const segment = text.slice(start, end)
    // Strip the leading `{n:` and the matching trailing `}` / `-}`.
    const inner = segment
      .replace(/^\{\d:/, "")
      .replace(/-?\}\s*$/, "")
      .trim()

    switch (id) {
      case "1":
        blocks.basicHeader = inner
        break
      case "2":
        blocks.applicationHeader = inner
        break
      case "3":
        blocks.userHeader = parseSubBlocks(inner)
        break
      case "4":
        blocks.text = parseTextFields(inner)
        break
      case "5":
        blocks.trailer = parseSubBlocks(inner)
        break
    }
  }

  // Fallback: many printouts / PDF-extracted specimens dump the message fields
  // loosely WITHOUT a proper `{4:...-}` text block (or with a malformed `{3`
  // that swallows them, e.g. `{2:I760...}{3\n:20:...`). Standard block matching
  // then finds no text fields and every party/amount comes back blank. If we
  // recovered no text but the raw clearly carries `:tag:` field lines, parse
  // them by scanning the whole message — parseTextFields only matches lines
  // that start with `:NN[A-Z]?:`, so the `{1..}`/`{2:..}` header lines and any
  // trailing human-readable tables are safely ignored.
  if (!blocks.text.length) {
    const recovered = parseTextFields(text)
    if (recovered.length) blocks.text = recovered
  }

  return blocks
}

/** Parse `{121:...}{108:...}` style sub-blocks into a tag→value map. */
function parseSubBlocks(inner: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /\{(\w+):([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    out[m[1]] = m[2].trim()
  }
  return out
}

/** Parse Block 4 message text into an ordered list of `:tag:value` fields. */
function parseTextFields(inner: string): SwiftField[] {
  const fields: SwiftField[] = []
  const lines = inner.split("\n")
  let current: SwiftField | null = null

  for (const line of lines) {
    const tagMatch = line.match(/^:([0-9]{2}[A-Z]?):(.*)$/)
    if (tagMatch) {
      if (current) fields.push(current)
      current = { tag: tagMatch[1], value: tagMatch[2] }
    } else if (current) {
      // Continuation line of the current field.
      if (line.trim() === "-") continue
      current.value += (current.value ? "\n" : "") + line
    }
  }
  if (current) fields.push(current)
  return fields
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function parseBasicHeader(raw?: string): BasicHeader | undefined {
  if (!raw) return undefined
  // Format: F01BANKBEBBAXXX0000000000  (appId[1] serviceId[2] LT[12] session[4] seq[6])
  const appId = raw.slice(0, 1)
  const serviceId = raw.slice(1, 3)
  const ltAddress = raw.slice(3, 15)
  const sessionNumber = raw.slice(15, 19)
  const sequenceNumber = raw.slice(19, 25)
  return {
    applicationId: appId || undefined,
    serviceId: serviceId || undefined,
    ltAddress: ltAddress || undefined,
    senderBic: ltAddress ? ltAddress.slice(0, 8) : undefined,
    sessionNumber: sessionNumber || undefined,
    sequenceNumber: sequenceNumber || undefined,
  }
}

function parseApplicationHeader(raw?: string): ApplicationHeader | undefined {
  if (!raw) return undefined
  const dirChar = raw.charAt(0).toUpperCase()
  const direction = dirChar === "I" ? "input" : dirChar === "O" ? "output" : "unknown"
  const messageType = raw.slice(1, 4) || undefined

  if (direction === "input") {
    // I + MT(3) + destinationAddress(12) + priority(1) + ...
    const counterpartyAddress = raw.slice(4, 16) || undefined
    const priority = raw.slice(16, 17) || undefined
    return {
      direction,
      messageType,
      counterpartyAddress,
      counterpartyBic: counterpartyAddress ? counterpartyAddress.slice(0, 8) : undefined,
      priority,
    }
  }
  if (direction === "output") {
    // O + MT(3) + inputTime(4) + MIR(28) + outputDate(6) + outputTime(4) + priority(1)
    const inputTime = raw.slice(4, 8) || undefined
    const senderAddress = raw.slice(12, 24) || undefined
    return {
      direction,
      messageType,
      inputTime,
      counterpartyAddress: senderAddress,
      counterpartyBic: senderAddress ? senderAddress.slice(0, 8) : undefined,
    }
  }
  return { direction, messageType }
}

// ---------------------------------------------------------------------------
// Field value parsing helpers
// ---------------------------------------------------------------------------

/** Parse a SWIFT decimal ("1500,00" / "1.500,00") into a JS number. */
export function parseSwiftAmount(raw: string): number | undefined {
  if (!raw) return undefined
  // SWIFT uses comma as the decimal separator and no thousands separators.
  const cleaned = raw.trim().replace(/\./g, "").replace(",", ".")
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : undefined
}

/** Parse a SWIFT YYMMDD date into an ISO yyyy-mm-dd string. */
export function parseSwiftDate(yymmdd: string): string | undefined {
  const m = yymmdd.match(/^(\d{2})(\d{2})(\d{2})$/)
  if (!m) return undefined
  const [, yy, mm, dd] = m
  const year = Number(yy) + (Number(yy) <= 79 ? 2000 : 1900)
  const month = Number(mm)
  const day = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  return `${year}-${mm}-${dd}`
}

/**
 * Parse a value-date/currency/amount field (:32A: = date+ccy+amount,
 * :32B: / :33B: = ccy+amount only).
 */
function parseAmountField(value: string, withDate: boolean): {
  valueDate?: string
  currency?: string
  amount?: number
} {
  const v = value.trim()
  if (withDate) {
    const m = v.match(/^(\d{6})([A-Z]{3})([\d.,]+)$/)
    if (!m) return {}
    return { valueDate: parseSwiftDate(m[1]), currency: m[2], amount: parseSwiftAmount(m[3]) }
  }
  const m = v.match(/^([A-Z]{3})([\d.,]+)$/)
  if (!m) return {}
  return { currency: m[1], amount: parseSwiftAmount(m[2]) }
}

/**
 * Parse a party field (50A/50K/50F, 52A/52D, 57A/57D, 58A/58D, 59/59A/59F).
 * Option A carries a BIC; the first line may be an /account. Remaining lines
 * are name & address.
 */
function parseParty(tag: string, value: string): SwiftParty {
  const option = tag.length > 2 ? tag.slice(2) : undefined
  const lines = value.split("\n").map((l) => l.trim()).filter(Boolean)
  const party: SwiftParty = { option, nameAndAddress: [] }

  if (lines.length && lines[0].startsWith("/")) {
    party.account = lines.shift()!.slice(1)
  }

  if (option === "A" && lines.length) {
    // Option A: the (remaining) first line is a BIC.
    const candidate = lines[0].replace(/^\/+/, "").trim()
    if (/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(candidate)) {
      party.bic = candidate
      lines.shift()
    }
  }

  // Option F / K: structured or free name & address lines remain.
  party.nameAndAddress = lines
  return party
}

const findField = (fields: SwiftField[], tag: string): SwiftField | undefined =>
  fields.find((f) => f.tag === tag)

const findByPrefix = (fields: SwiftField[], prefix: string): SwiftField | undefined =>
  fields.find((f) => f.tag.startsWith(prefix))

// ---------------------------------------------------------------------------
// Message type detection
// ---------------------------------------------------------------------------

/** Detect the MT type from the application header and/or field signature. */
export function detectMessageType(blocks: SwiftBlocks): SwiftMessageType {
  const appHeader = blocks.applicationHeader
  let mt: string | undefined
  if (appHeader) {
    // Accept every common way a printout writes the block-2 type:
    //   {2:I760...}  {2:O760...}  (standard input/output application header)
    //   {2:MT760}    {2:760}      (bank-printout shorthand — very common)
    // The old regex only matched the leading I/O form, so a "{2:MT760}"
    // header fell through to MT103 and a blocked-funds guarantee was wrongly
    // treated (and credited) as a cash transfer.
    const m = appHeader.trim().match(/^(?:MT)?[IO]?\s*(\d{3})/i)
    if (m) mt = m[1]
  }
  // MT202 COV is an MT202 carrying a sequence B (cover) with :50a:/:59a:.
  if (mt === "202") {
    const hasCoverSeq =
      !!findByPrefix(blocks.text, "50") && !!findByPrefix(blocks.text, "59")
    return hasCoverSeq ? "MT202COV" : "MT202"
  }
  if (mt === "103") return "MT103"
  if (mt === "760") return "MT760"
  if (mt === "799") return "MT799"
  if (mt) return `MT${mt}`

  // Fall back to field-signature heuristics when no app header was supplied.
  if (findField(blocks.text, "79")) return "MT799"
  // MT760 carries undertaking-specific fields (sub-message type :12:, purpose
  // :22A:, form :22D:, applicable rules :40C:, guarantee terms :77C:/:77U:) and
  // no :32A:. Any of these is a strong signal it's a guarantee, not a payment.
  if (
    findField(blocks.text, "12") ||
    findField(blocks.text, "22A") ||
    findField(blocks.text, "22D") ||
    findField(blocks.text, "40C") ||
    findField(blocks.text, "77C") ||
    findField(blocks.text, "77U")
  ) {
    return "MT760"
  }
  if (findByPrefix(blocks.text, "59")) return "MT103"
  if (findByPrefix(blocks.text, "58")) return "MT202"
  return "UNKNOWN"
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/**
 * Parse a raw SWIFT MT message into a structured, enriched object with
 * validation. Never throws — structural problems surface as `errors`.
 */
export function parseSwiftMessage(raw: string): ParsedSwiftMessage {
  const warnings: string[] = []
  const errors: string[] = []

  const blocks = splitBlocks(raw)
  if (!blocks.text.length && !blocks.basicHeader) {
    errors.push("No recognizable SWIFT blocks were found. Check the message format.")
  }

  const type = detectMessageType(blocks)
  const basicHeader = parseBasicHeader(blocks.basicHeader)
  const applicationHeader = parseApplicationHeader(blocks.applicationHeader)

  const fields = blocks.text
  const uetr = blocks.userHeader?.["121"]
  const serviceTypeId = blocks.userHeader?.["111"]

  const result: ParsedSwiftMessage = {
    type,
    valid: true,
    blocks,
    basicHeader,
    applicationHeader,
    uetr,
    serviceTypeId,
    gpiEnabled: !!uetr,
    warnings,
    errors,
  }

  // Common references
  result.senderReference = findField(fields, "20")?.value.trim()
  result.relatedReference = findField(fields, "21")?.value.trim()

  // ISO 15022 securities messages (MT54x) carry the sender's reference in
  // :20C::SEME//<ref> rather than a plain :20:. Surface it as senderReference.
  if (!result.senderReference) {
    const f20c = findField(fields, "20C")?.value.trim()
    const seme = f20c?.match(/:SEME\/\/(\S+)/)?.[1]
    if (seme) result.senderReference = seme
  }

  // Amount fields — :32A: (date+ccy+amount) preferred, else :32B:.
  const f32a = findField(fields, "32A")
  if (f32a) {
    const parsed = parseAmountField(f32a.value, true)
    result.valueDate = parsed.valueDate
    result.currency = parsed.currency
    result.amount = parsed.amount
  } else {
    const f32b = findField(fields, "32B")
    if (f32b) {
      const parsed = parseAmountField(f32b.value, false)
      result.currency = parsed.currency
      result.amount = parsed.amount
    }
  }
  const f33b = findField(fields, "33B")
  if (f33b) {
    const parsed = parseAmountField(f33b.value, false)
    result.instructedCurrency = parsed.currency
    result.instructedAmount = parsed.amount
  }

  // Parties
  const ordering = findByPrefix(fields, "50")
  if (ordering) result.orderingCustomer = parseParty(ordering.tag, ordering.value)
  const orderingInst = findByPrefix(fields, "52")
  if (orderingInst) result.orderingInstitution = parseParty(orderingInst.tag, orderingInst.value)
  const accountWith = findByPrefix(fields, "57")
  if (accountWith) result.accountWithInstitution = parseParty(accountWith.tag, accountWith.value)
  const beneficiaryInst = findByPrefix(fields, "58")
  if (beneficiaryInst) result.beneficiaryInstitution = parseParty(beneficiaryInst.tag, beneficiaryInst.value)
  const beneficiary = findByPrefix(fields, "59")
  if (beneficiary) result.beneficiary = parseParty(beneficiary.tag, beneficiary.value)

  result.remittanceInfo = findField(fields, "70")?.value.trim()
  result.chargesDetail = findField(fields, "71A")?.value.trim()
  result.senderToReceiverInfo = findField(fields, "72")?.value.trim()
  result.freeFormatText = findField(fields, "79")?.value.trim()

  // MT202 COV underlying customer credit transfer (sequence B).
  if (type === "MT202COV") {
    result.coverPayment = {
      orderingCustomer: result.orderingCustomer,
      beneficiary: result.beneficiary,
      remittanceInfo: result.remittanceInfo,
    }
  }

  // MT760 guarantee / standby letter of credit (issuance & collateral transfer).
  if (type === "MT760") {
    const f32b = findField(fields, "32B")
    let gAmount: number | undefined
    let gCurrency: string | undefined
    if (f32b) {
      const parsed = parseAmountField(f32b.value, false)
      gCurrency = parsed.currency
      gAmount = parsed.amount
    }
    const applicantField = findByPrefix(fields, "50")
    const beneficiaryField = findByPrefix(fields, "59")
    const f30 = findField(fields, "30")?.value.trim()
    const f31e = findField(fields, "31E")?.value.trim()
    // :35G: expiry can be a date (YYMMDD) optionally followed by narrative.
    const f35g = findField(fields, "35G")?.value.trim()
    const f35gDate = f35g?.match(/\d{6}/)?.[0]
    result.guarantee = {
      purpose: findField(fields, "22A")?.value.trim(),
      form: findField(fields, "22D")?.value.trim(),
      applicableRules: findField(fields, "40C")?.value.trim(),
      issueDate: f30 ? parseSwiftDate(f30) : undefined,
      expiryDate: f31e ? parseSwiftDate(f31e) : f35gDate ? parseSwiftDate(f35gDate) : undefined,
      currency: gCurrency,
      amount: gAmount,
      applicant: applicantField ? parseParty(applicantField.tag, applicantField.value) : undefined,
      beneficiary: beneficiaryField ? parseParty(beneficiaryField.tag, beneficiaryField.value) : undefined,
      terms:
        findField(fields, "77C")?.value.trim() ??
        findField(fields, "77U")?.value.trim(),
    }
    // Surface the undertaking amount at the top level for reconciliation/enrichment.
    if (result.amount === undefined && gAmount !== undefined) {
      result.amount = gAmount
      result.currency = gCurrency
    }
  }

  validateBusinessRules(result)
  result.valid = result.errors.length === 0
  return result
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBusinessRules(msg: ParsedSwiftMessage): void {
  const { type, errors, warnings } = msg

  // :20: Sender reference is mandatory in all supported message types.
  if (!msg.senderReference) {
    errors.push("Missing mandatory field :20: (Sender's Reference).")
  } else if (msg.senderReference.length > 16) {
    errors.push("Field :20: exceeds the 16-character maximum.")
  }

  if (type === "MT103" || type === "MT202" || type === "MT202COV") {
    if (msg.amount === undefined) {
      errors.push("Missing or invalid settlement amount (:32A:).")
    } else if (msg.amount <= 0) {
      errors.push("Settlement amount must be greater than zero.")
    }
    if (!msg.currency) {
      errors.push("Missing settlement currency (:32A:).")
    } else if (!/^[A-Z]{3}$/.test(msg.currency)) {
      warnings.push(`Unusual currency code "${msg.currency}".`)
    }
    if (!msg.valueDate) warnings.push("No value date present in :32A:.")
  }

  if (type === "MT103") {
    if (!msg.orderingCustomer) errors.push("MT103 is missing the ordering customer (:50a:).")
    if (!msg.beneficiary) errors.push("MT103 is missing the beneficiary customer (:59a:).")
    if (!msg.chargesDetail) {
      warnings.push("No charges detail (:71A:) present.")
    } else if (!["OUR", "BEN", "SHA"].includes(msg.chargesDetail)) {
      warnings.push(`Unrecognized charges code "${msg.chargesDetail}" (expected OUR/BEN/SHA).`)
    }
  }

  if (type === "MT202" || type === "MT202COV") {
    if (!msg.relatedReference) warnings.push("No related reference (:21:) present on the 202.")
    if (!msg.beneficiaryInstitution) errors.push("MT202 is missing the beneficiary institution (:58a:).")
  }

  if (type === "MT799") {
    if (!msg.freeFormatText) errors.push("MT799 is missing the free-format narrative (:79:).")
  }

  if (type === "MT760") {
    if (!msg.guarantee?.form && !msg.guarantee?.purpose) {
      warnings.push("MT760 has no undertaking form (:22D:) or purpose (:22A:).")
    }
    if (msg.guarantee?.amount === undefined) {
      warnings.push("MT760 has no undertaking amount (:32B:).")
    } else if (msg.guarantee.amount <= 0) {
      errors.push("MT760 undertaking amount must be greater than zero.")
    }
    if (!msg.guarantee?.beneficiary) {
      warnings.push("MT760 has no beneficiary of the undertaking (:59:).")
    }
  }

  // Validate any IBAN / BIC fields we extracted.
  const ibanCandidates = [
    msg.orderingCustomer?.account,
    msg.beneficiary?.account,
    msg.coverPayment?.beneficiary?.account,
  ].filter(Boolean) as string[]
  for (const acct of ibanCandidates) {
    if (/^[A-Z]{2}\d{2}/.test(acct.replace(/\s/g, ""))) {
      const v = validateIban(acct)
      if (!v.valid) warnings.push(`Account "${acct}" failed IBAN validation: ${v.error ?? "invalid"}.`)
    }
  }
  const bicCandidates = [
    msg.orderingInstitution?.bic,
    msg.accountWithInstitution?.bic,
    msg.beneficiaryInstitution?.bic,
    msg.beneficiary?.bic,
    msg.basicHeader?.senderBic,
  ].filter(Boolean) as string[]
  for (const bic of bicCandidates) {
    const v = validateBic(bic)
    if (!v.valid) warnings.push(`BIC "${bic}" failed validation: ${v.error ?? "invalid"}.`)
  }
}

// ---------------------------------------------------------------------------
// Bridge to the reconciliation engine
// ---------------------------------------------------------------------------

/** A flat view consumed by the reconciliation `IncomingPayment` model. */
export interface SwiftPaymentExtract {
  amount?: number
  currency?: string
  payer: string
  reference: string
  senderIban?: string
  senderBic?: string
  valueDate?: string
  uetr?: string
}

/**
 * Reduce a parsed message to the fields the reconciliation engine matches on.
 * The remittance reference (:70:) is preferred as the matching key, falling
 * back to the related reference (:21:) then the sender's reference (:20:).
 */
export function toReconciliationInput(msg: ParsedSwiftMessage): SwiftPaymentExtract {
  const payerParty = msg.orderingCustomer ?? msg.orderingInstitution
  const payer =
    payerParty?.nameAndAddress?.[0] ??
    payerParty?.bic ??
    msg.applicationHeader?.counterpartyBic ??
    msg.basicHeader?.senderBic ??
    "Unknown sender"

  const reference =
    msg.remittanceInfo?.replace(/\n/g, " ").trim() ||
    msg.relatedReference ||
    msg.senderReference ||
    ""

  return {
    amount: msg.amount,
    currency: msg.currency,
    payer,
    reference,
    senderIban: payerParty?.account,
    senderBic: payerParty?.bic ?? msg.orderingInstitution?.bic ?? msg.basicHeader?.senderBic,
    valueDate: msg.valueDate,
    uetr: msg.uetr,
  }
}

// ---------------------------------------------------------------------------
// Generation (outbound MT103 / MT202)
// ---------------------------------------------------------------------------

export interface GenerateMtInput {
  type: "MT103" | "MT202"
  senderBic: string
  receiverBic: string
  /** :20: max 16 chars. */
  senderReference: string
  /** :21: related reference (202). */
  relatedReference?: string
  valueDate: string // ISO yyyy-mm-dd
  currency: string
  amount: number
  /** Ordering customer (103) or ordering institution (202). */
  ordering?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** Beneficiary customer (103) or beneficiary institution (202). */
  beneficiary?: { account?: string; bic?: string; nameAndAddress?: string[] }
  remittanceInfo?: string
  /** OUR / BEN / SHA (103 only). */
  chargesDetail?: "OUR" | "BEN" | "SHA"
  /** Provide to embed a gpi UETR (Block 3 field 121); auto-generated if omitted. */
  uetr?: string
  includeGpi?: boolean
}

/** Format an ISO yyyy-mm-dd to SWIFT YYMMDD. */
function toSwiftDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ""
  return `${m[1].slice(2)}${m[2]}${m[3]}`
}

/** Format a JS number to a SWIFT decimal (comma separator, no thousands sep). */
export function formatSwiftAmount(amount: number): string {
  return amount.toFixed(2).replace(".", ",")
}

/** Generate a RFC 4122 v4 UETR (lower-case) for gpi tracking. */
export function generateUetr(): string {
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function formatParty(party?: { account?: string; bic?: string; nameAndAddress?: string[] }): string {
  if (!party) return ""
  const lines: string[] = []
  if (party.account) lines.push(`/${party.account}`)
  if (party.bic) lines.push(party.bic)
  if (party.nameAndAddress) lines.push(...party.nameAndAddress)
  return lines.join("\n")
}

/**
 * Generate a well-formed SWIFT MT103 or MT202 message. Returns the raw FIN
 * text including Blocks 1-5. The result round-trips through `parseSwiftMessage`.
 */
export function generateSwiftMessage(input: GenerateMtInput): { raw: string; uetr: string } {
  const mt = input.type === "MT103" ? "103" : "202"
  const uetr = input.uetr ?? generateUetr()

  const block1 = `{1:F01${padBic(input.senderBic)}0000000000}`
  const block2 = `{2:I${mt}${padBic(input.receiverBic)}N}`
  const block3 = input.includeGpi !== false ? `{3:{121:${uetr}}}` : ""

  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  if (mt === "202" && input.relatedReference) lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  lines.push(`:32A:${toSwiftDate(input.valueDate)}${input.currency}${formatSwiftAmount(input.amount)}`)

  if (mt === "103") {
    const orderingOption = input.ordering?.bic ? "A" : "K"
    if (input.ordering) lines.push(`:50${orderingOption}:${formatParty(input.ordering)}`)
    const benOption = input.beneficiary?.bic ? "A" : ""
    if (input.beneficiary) lines.push(`:59${benOption}:${formatParty(input.beneficiary)}`)
    if (input.remittanceInfo) lines.push(`:70:${input.remittanceInfo}`)
    lines.push(`:71A:${input.chargesDetail ?? "SHA"}`)
  } else {
    if (input.ordering) lines.push(`:52A:${formatParty(input.ordering)}`)
    if (input.beneficiary) lines.push(`:58A:${formatParty(input.beneficiary)}`)
    if (input.remittanceInfo) lines.push(`:72:/INS/${input.remittanceInfo}`)
  }

  const block4 = `{4:\n${lines.join("\n")}\n-}`
  const raw = `${block1}${block2}${block3}${block4}`
  return { raw, uetr }
}

function padBic(bic: string): string {
  // LT address is 12 chars: 8-char BIC + LT code "X" + 3-char branch "XXX".
  const clean = bic.replace(/\s/g, "").toUpperCase()
  if (clean.length >= 12) return clean.slice(0, 12)
  if (clean.length === 11) return clean + "X"
  if (clean.length === 8) return clean + "XXXX"
  return clean.padEnd(12, "X")
}

// ---------------------------------------------------------------------------
// Generation (instrument messaging — MT760 guarantee / MT799 free format)
// ---------------------------------------------------------------------------

export interface GenerateMt760Input {
  senderBic: string
  receiverBic: string
  /** :20: Transaction reference (max 16 chars). */
  senderReference: string
  /** :23: Related reference / further identification (optional). */
  relatedReference?: string
  /** :22A: Purpose — "ISSU" issuance, "ICCO" collateral, "ISCO" counter, etc. */
  purpose?: string
  /** :22D: Form of undertaking — "DGAR" demand guarantee, "STBY" standby LC. */
  form?: "DGAR" | "STBY" | string
  /** :40C: Applicable rules — "URDG", "ISPR", "NONE". */
  applicableRules?: string
  /** Issue date (ISO yyyy-mm-dd) → :30:. */
  issueDate?: string
  /** Expiry date (ISO yyyy-mm-dd) → :31E:. */
  expiryDate?: string
  currency: string
  /** Undertaking amount → :32B:. */
  amount: number
  /** :50: Applicant / instructing party. */
  applicant?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :59: Beneficiary of the undertaking. */
  beneficiary?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :77C: Terms and conditions narrative. */
  terms?: string
  /** Embed a gpi UETR (Block 3 field 121); auto-generated unless includeGpi=false. */
  uetr?: string
  includeGpi?: boolean
}

/**
 * Generate a well-formed SWIFT MT760 (Guarantee / Standby Letter of Credit).
 * Used by the instrument desk to issue or collateral-transfer an SBLC/BG. The
 * output round-trips through `parseSwiftMessage` as type "MT760".
 */
export function generateMt760(input: GenerateMt760Input): { raw: string; uetr: string } {
  const uetr = input.uetr ?? generateUetr()
  const block1 = `{1:F01${padBic(input.senderBic)}0000000000}`
  const block2 = `{2:I760${padBic(input.receiverBic)}N}`
  const block3 = input.includeGpi !== false ? `{3:{121:${uetr}}}` : ""

  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  if (input.relatedReference) lines.push(`:23:${input.relatedReference.slice(0, 16)}`)
  if (input.purpose) lines.push(`:22A:${input.purpose}`)
  if (input.form) lines.push(`:22D:${input.form}`)
  if (input.applicableRules) lines.push(`:40C:${input.applicableRules}`)
  if (input.issueDate) lines.push(`:30:${toSwiftDate(input.issueDate)}`)
  if (input.applicant) lines.push(`:50:${formatParty(input.applicant)}`)
  if (input.beneficiary) lines.push(`:59:${formatParty(input.beneficiary)}`)
  lines.push(`:32B:${input.currency}${formatSwiftAmount(input.amount)}`)
  if (input.expiryDate) lines.push(`:31E:${toSwiftDate(input.expiryDate)}`)
  if (input.terms) lines.push(`:77C:${input.terms}`)

  const block4 = `{4:\n${lines.join("\n")}\n-}`
  return { raw: `${block1}${block2}${block3}${block4}`, uetr }
}

export interface GenerateMt799Input {
  senderBic: string
  receiverBic: string
  /** :20: Transaction reference (max 16 chars). */
  senderReference: string
  /** :21: Related reference (optional). */
  relatedReference?: string
  /** :79: Free-format narrative (RWA / pre-advice / confirmation). */
  narrative: string
  uetr?: string
  includeGpi?: boolean
}

/**
 * Generate a well-formed SWIFT MT799 (free-format) message — used for
 * ready-willing-able (RWA) advices and pre-advice confirmations on instrument
 * transactions. Round-trips through `parseSwiftMessage` as type "MT799".
 */
export function generateMt799(input: GenerateMt799Input): { raw: string; uetr: string } {
  const uetr = input.uetr ?? generateUetr()
  const block1 = `{1:F01${padBic(input.senderBic)}0000000000}`
  const block2 = `{2:I799${padBic(input.receiverBic)}N}`
  const block3 = input.includeGpi !== false ? `{3:{121:${uetr}}}` : ""

  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  if (input.relatedReference) lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  // :79: lines are limited to 50 chars each; wrap the narrative.
  const narrativeLines = input.narrative
    .split("\n")
    .flatMap((line) => line.match(/.{1,50}/g) ?? [""])
  lines.push(`:79:${narrativeLines.join("\n")}`)

  const block4 = `{4:\n${lines.join("\n")}\n-}`
  return { raw: `${block1}${block2}${block3}${block4}`, uetr }
}

// ---------------------------------------------------------------------------
// Generation — shared helpers for the extended catalogue
// ---------------------------------------------------------------------------

/** Assemble the standard FIN envelope (blocks 1-4) around a list of block-4 fields. */
function assembleFin(args: {
  mt: string
  senderBic: string
  receiverBic: string
  fields: string[]
  uetr?: string
  includeGpi?: boolean
}): { raw: string; uetr: string } {
  const uetr = args.uetr ?? generateUetr()
  const block1 = `{1:F01${padBic(args.senderBic)}0000000000}`
  const block2 = `{2:I${args.mt}${padBic(args.receiverBic)}N}`
  const block3 = args.includeGpi !== false ? `{3:{121:${uetr}}}` : ""
  const block4 = `{4:\n${args.fields.join("\n")}\n-}`
  return { raw: `${block1}${block2}${block3}${block4}`, uetr }
}

/** Wrap a multi-line narrative into SWIFT-safe lines (for :79: / :77x: / :4xA:). */
function wrapNarrative(text: string, width = 50): string {
  return text
    .split("\n")
    .flatMap((line) => line.match(new RegExp(`.{1,${width}}`, "g")) ?? [""])
    .join("\n")
}

// ---------------------------------------------------------------------------
// Generation — MT101 (Request for Transfer)
// ---------------------------------------------------------------------------

export interface GenerateMt101Input {
  senderBic: string
  receiverBic: string
  /** :20: Sender's reference (max 16 chars). */
  senderReference: string
  /** :28D: Message index/total, e.g. "1/1". */
  messageIndex?: string
  /** Requested execution date (ISO yyyy-mm-dd) → :30:. */
  executionDate: string
  currency: string
  amount: number
  /** :50a: Ordering customer / instructing party. */
  ordering?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :59a: Beneficiary. */
  beneficiary?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :70: Remittance information. */
  remittanceInfo?: string
  /** :71A: charges — OUR / BEN / SHA. */
  chargesDetail?: "OUR" | "BEN" | "SHA"
  uetr?: string
  includeGpi?: boolean
}

/** Generate a well-formed MT101 (Request for Transfer). Round-trips as "MT101". */
export function generateMt101(input: GenerateMt101Input): { raw: string; uetr: string } {
  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  lines.push(`:28D:${input.messageIndex ?? "1/1"}`)
  if (input.ordering) lines.push(`:50${input.ordering.bic ? "A" : "K"}:${formatParty(input.ordering)}`)
  lines.push(`:30:${toSwiftDate(input.executionDate)}`)
  lines.push(`:21:${input.senderReference.slice(0, 16)}`)
  lines.push(`:32B:${input.currency}${formatSwiftAmount(input.amount)}`)
  if (input.beneficiary) lines.push(`:59${input.beneficiary.bic ? "A" : ""}:${formatParty(input.beneficiary)}`)
  if (input.remittanceInfo) lines.push(`:70:${input.remittanceInfo}`)
  lines.push(`:71A:${input.chargesDetail ?? "SHA"}`)
  return assembleFin({
    mt: "101",
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

// ---------------------------------------------------------------------------
// Generation — MT202 COV (Cover Payment)
// ---------------------------------------------------------------------------

export interface GenerateMt202CovInput {
  senderBic: string
  receiverBic: string
  /** :20: Transaction reference. */
  senderReference: string
  /** :21: Related reference (links to the underlying MT103). */
  relatedReference: string
  valueDate: string
  currency: string
  amount: number
  /** Sequence A — ordering / beneficiary institutions. */
  orderingInstitution?: { account?: string; bic?: string; nameAndAddress?: string[] }
  beneficiaryInstitution?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** Sequence B — underlying customer credit transfer parties. */
  orderingCustomer?: { account?: string; bic?: string; nameAndAddress?: string[] }
  beneficiaryCustomer?: { account?: string; bic?: string; nameAndAddress?: string[] }
  remittanceInfo?: string
  uetr?: string
  includeGpi?: boolean
}

/** Generate a well-formed MT202 COV (cover payment). Round-trips as "MT202COV". */
export function generateMt202Cov(input: GenerateMt202CovInput): { raw: string; uetr: string } {
  const lines: string[] = []
  // Sequence A — general financial institution transfer.
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  lines.push(`:32A:${toSwiftDate(input.valueDate)}${input.currency}${formatSwiftAmount(input.amount)}`)
  if (input.orderingInstitution) lines.push(`:52A:${formatParty(input.orderingInstitution)}`)
  if (input.beneficiaryInstitution) lines.push(`:58A:${formatParty(input.beneficiaryInstitution)}`)
  // Sequence B — underlying customer credit transfer details.
  if (input.orderingCustomer)
    lines.push(`:50${input.orderingCustomer.bic ? "A" : "K"}:${formatParty(input.orderingCustomer)}`)
  if (input.beneficiaryCustomer)
    lines.push(`:59${input.beneficiaryCustomer.bic ? "A" : ""}:${formatParty(input.beneficiaryCustomer)}`)
  if (input.remittanceInfo) lines.push(`:70:${input.remittanceInfo}`)
  return assembleFin({
    mt: "202",
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

// ---------------------------------------------------------------------------
// Generation — free-format authenticated messages (MT199 / MT299 / MT999)
// ---------------------------------------------------------------------------

export interface GenerateFreeFormatInput {
  /** "199" | "299" | "999" — category-1/2/n free-format. */
  mt: "199" | "299" | "999" | string
  senderBic: string
  receiverBic: string
  senderReference: string
  relatedReference?: string
  /** :79: free-format narrative. */
  narrative: string
  uetr?: string
  includeGpi?: boolean
}

/** Generate an authenticated free-format message (MT199/MT299/MT999). */
export function generateFreeFormatMessage(input: GenerateFreeFormatInput): { raw: string; uetr: string } {
  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  if (input.relatedReference) lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  lines.push(`:79:${wrapNarrative(input.narrative)}`)
  return assembleFin({
    mt: String(input.mt),
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

// ---------------------------------------------------------------------------
// Generation — documentary credit family
// (MT700/707/710/720/730/740/742/747/750/752/754/756)
// ---------------------------------------------------------------------------

export interface GenerateDocumentaryCreditInput {
  /** Bare MT number e.g. "700", "707", "710", "720". */
  mt: string
  senderBic: string
  receiverBic: string
  /** :20: Documentary credit number / sender's reference. */
  senderReference: string
  /** :21: Related reference (amendments, advices). */
  relatedReference?: string
  /** :31C: Date of issue (ISO yyyy-mm-dd). */
  issueDate?: string
  /** :31D: Date of expiry (ISO yyyy-mm-dd). */
  expiryDate?: string
  /** :31D: Place of expiry, e.g. "GENEVA". */
  expiryPlace?: string
  /** :40A: Form of documentary credit, e.g. "IRREVOCABLE". */
  formOfCredit?: string
  currency?: string
  amount?: number
  /** :50: Applicant. */
  applicant?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :59: Beneficiary. */
  beneficiary?: { account?: string; bic?: string; nameAndAddress?: string[] }
  /** :45A: Description of goods / services. */
  goodsDescription?: string
  /** :46A: Documents required. */
  documentsRequired?: string
  /** :47A: Additional conditions. */
  additionalConditions?: string
  /** :71D: charges narrative. */
  charges?: string
  /** :79: free narrative (used by acknowledgements / advices like MT730 / MT750). */
  narrative?: string
  uetr?: string
  includeGpi?: boolean
}

/**
 * Generate a documentary-credit-family message. Field usage adapts to the
 * provided inputs, so the same builder serves issuance (MT700), amendment
 * (MT707), advices (MT710 / MT730 / MT750), transfer (MT720), reimbursement
 * (MT740 / MT742 / MT747) and settlement advices (MT752 / MT754 / MT756).
 */
export function generateDocumentaryCredit(input: GenerateDocumentaryCreditInput): {
  raw: string
  uetr: string
} {
  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  if (input.relatedReference) lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  if (input.formOfCredit) lines.push(`:40A:${input.formOfCredit}`)
  if (input.issueDate) lines.push(`:31C:${toSwiftDate(input.issueDate)}`)
  if (input.expiryDate || input.expiryPlace)
    lines.push(`:31D:${input.expiryDate ? toSwiftDate(input.expiryDate) : ""}${input.expiryPlace ?? ""}`)
  if (input.applicant) lines.push(`:50:${formatParty(input.applicant)}`)
  if (input.beneficiary) lines.push(`:59:${formatParty(input.beneficiary)}`)
  if (input.amount !== undefined)
    lines.push(`:32B:${input.currency ?? "USD"}${formatSwiftAmount(input.amount)}`)
  if (input.goodsDescription) lines.push(`:45A:${wrapNarrative(input.goodsDescription, 65)}`)
  if (input.documentsRequired) lines.push(`:46A:${wrapNarrative(input.documentsRequired, 65)}`)
  if (input.additionalConditions) lines.push(`:47A:${wrapNarrative(input.additionalConditions, 65)}`)
  if (input.charges) lines.push(`:71D:${wrapNarrative(input.charges, 65)}`)
  if (input.narrative) lines.push(`:79:${wrapNarrative(input.narrative)}`)
  return assembleFin({
    mt: input.mt,
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

// ---------------------------------------------------------------------------
// Generation — guarantee amendment family (MT767 / MT768 / MT769)
// ---------------------------------------------------------------------------

export interface GenerateGuaranteeAmendmentInput {
  /** "767" amendment, "768" acknowledgement, "769" reduction/release. */
  mt: "767" | "768" | "769" | string
  senderBic: string
  receiverBic: string
  /** :20: New reference for this message. */
  senderReference: string
  /** :21: Reference of the original guarantee/SBLC (the MT760 :20:). */
  relatedReference: string
  /** :22A: Purpose of the message, e.g. "ISSU" / "ICCO". */
  purpose?: string
  /** :30: Date of amendment / acknowledgement (ISO yyyy-mm-dd). */
  date?: string
  /** :32B: Increase/decrease or released amount. */
  currency?: string
  amount?: number
  /** :77U: narrative of amendment terms or acknowledgement text. */
  narrative?: string
  uetr?: string
  includeGpi?: boolean
}

/** Generate an MT767/MT768/MT769 guarantee amendment-family message. */
export function generateGuaranteeAmendment(input: GenerateGuaranteeAmendmentInput): {
  raw: string
  uetr: string
} {
  const lines: string[] = []
  lines.push(`:20:${input.senderReference.slice(0, 16)}`)
  lines.push(`:21:${input.relatedReference.slice(0, 16)}`)
  if (input.purpose) lines.push(`:22A:${input.purpose}`)
  if (input.date) lines.push(`:30:${toSwiftDate(input.date)}`)
  if (input.amount !== undefined)
    lines.push(`:32B:${input.currency ?? "USD"}${formatSwiftAmount(input.amount)}`)
  if (input.narrative) lines.push(`:77U:${wrapNarrative(input.narrative, 65)}`)
  return assembleFin({
    mt: String(input.mt),
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

// ---------------------------------------------------------------------------
// Generation — securities settlement (MT540/541/542/543 + confirmations 544-547)
// ---------------------------------------------------------------------------

export interface GenerateSecuritiesSettlementInput {
  /** "540" RF, "541" RVP, "542" DF, "543" DVP, "544"-"547" confirmations. */
  mt: "540" | "541" | "542" | "543" | "544" | "545" | "546" | "547" | string
  senderBic: string
  receiverBic: string
  /** :20C::SEME// Sender's message reference. */
  senderReference: string
  /** :23G: Function of the message — "NEWM" (new) or "CANC" (cancel). */
  func?: "NEWM" | "CANC" | string
  /** Trade date (ISO yyyy-mm-dd) → :98A::TRAD//. */
  tradeDate?: string
  /** Settlement date (ISO yyyy-mm-dd) → :98A::SETT//. */
  settlementDate?: string
  /** ISIN of the financial instrument → :35B:ISIN. */
  isin?: string
  /** Free description of the security. */
  securityDescription?: string
  /** Quantity of securities (FAMT/UNIT) → :36B::SETT//UNIT/. */
  quantity?: number
  /** Settlement amount (DVP/RVP) → :19A::SETT//. */
  currency?: string
  settlementAmount?: number
  /** Delivering / receiving agent (CSD participant) BIC → :95P::DEAG//:REAG//. */
  agentBic?: string
  /** Safekeeping / securities account → :97A::SAFE//. */
  safekeepingAccount?: string
  uetr?: string
  includeGpi?: boolean
}

/**
 * Generate an ISO 15022 securities settlement message (MT54x). Uses the
 * qualifier-based field structure (:16R:/:16S: blocks, :20C:, :23G:, :98A:,
 * :35B:, :36B:, :19A:, :95P:, :97A:) so it round-trips through the parser and
 * is suitable for Euroclear / DTC / ICSD instructions.
 */
export function generateSecuritiesSettlement(input: GenerateSecuritiesSettlementInput): {
  raw: string
  uetr: string
} {
  const isDelivery = input.mt === "542" || input.mt === "543" || input.mt === "546" || input.mt === "547"
  const isAgainstPayment =
    input.mt === "541" || input.mt === "543" || input.mt === "545" || input.mt === "547"
  const lines: string[] = []
  // General information sequence.
  lines.push(":16R:GENL")
  lines.push(`:20C::SEME//${input.senderReference.slice(0, 16)}`)
  lines.push(`:23G:${input.func ?? "NEWM"}`)
  lines.push(":16S:GENL")
  // Trade details sequence.
  lines.push(":16R:TRADDET")
  if (input.tradeDate) lines.push(`:98A::TRAD//${toSwiftDate8(input.tradeDate)}`)
  if (input.settlementDate) lines.push(`:98A::SETT//${toSwiftDate8(input.settlementDate)}`)
  if (input.isin)
    lines.push(
      `:35B:ISIN ${input.isin}${input.securityDescription ? `\n${wrapNarrative(input.securityDescription, 35)}` : ""}`,
    )
  else if (input.securityDescription) lines.push(`:35B:${wrapNarrative(input.securityDescription, 35)}`)
  lines.push(":16S:TRADDET")
  // Financial instrument / account sequence.
  lines.push(":16R:FIAC")
  if (input.quantity !== undefined) lines.push(`:36B::SETT//UNIT/${formatSwiftAmount(input.quantity)}`)
  if (input.safekeepingAccount) lines.push(`:97A::SAFE//${input.safekeepingAccount}`)
  lines.push(":16S:FIAC")
  // Settlement details sequence.
  lines.push(":16R:SETDET")
  lines.push(`:22F::SETR//TRAD`)
  if (input.agentBic)
    lines.push(`:95P::${isDelivery ? "REAG" : "DEAG"}//${padBic(input.agentBic).slice(0, 11)}`)
  if (isAgainstPayment && input.settlementAmount !== undefined)
    lines.push(`:19A::SETT//${input.currency ?? "USD"}${formatSwiftAmount(input.settlementAmount)}`)
  lines.push(":16S:SETDET")
  return assembleFin({
    mt: String(input.mt),
    senderBic: input.senderBic,
    receiverBic: input.receiverBic,
    fields: lines,
    uetr: input.uetr,
    includeGpi: input.includeGpi,
  })
}

/** Format an ISO yyyy-mm-dd date to the 8-digit YYYYMMDD used by :98A: in MT5xx. */
function toSwiftDate8(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ""
  return `${m[1]}${m[2]}${m[3]}`
}

