// IBAN & SWIFT/BIC validation + bank directory lookup utilities.
//
// - IBAN: structural length-per-country check + ISO 7064 mod-97-10 checksum.
// - BIC/SWIFT: ISO 9362 structural validation (bank, country, location, branch).
// - Bank lookup: resolves the institution behind a valid BIC or IBAN using a
//   curated directory. For IBANs outside the curated list, callers can enrich
//   the result with the openiban.com directory via the `resolveIbanExternal`
//   server action (kept out of this module so it stays client-bundle safe).

export type BankInfo = {
  name: string
  city?: string
  country: string
  countryCode: string
  bic?: string
  branch?: string
  /** Street address of the registered/head office, when known. */
  address?: string
  /** Postal / ZIP code of the registered office, when known. */
  postalCode?: string
}

export type IbanValidation = {
  valid: boolean
  formatted: string
  countryCode?: string
  countryName?: string
  bankCode?: string
  error?: string
}

export type BicValidation = {
  valid: boolean
  normalized: string
  bankCode?: string
  countryCode?: string
  countryName?: string
  locationCode?: string
  branchCode?: string
  error?: string
}

// ISO 3166 country names for the codes we care about (covers the app's markets).
// Full ISO 3166-1 alpha-2 list. BIC validation (below) rejects any country code
// NOT in this map, so it must cover every real country — a partial list falsely
// flagged valid BICs like FCBKTWTPXXX (TW = Taiwan) as "Unknown country code".
const COUNTRY_NAMES: Record<string, string> = {
  AD: "Andorra", AE: "United Arab Emirates", AF: "Afghanistan", AG: "Antigua and Barbuda",
  AI: "Anguilla", AL: "Albania", AM: "Armenia", AO: "Angola", AQ: "Antarctica",
  AR: "Argentina", AS: "American Samoa", AT: "Austria", AU: "Australia", AW: "Aruba",
  AX: "Åland Islands", AZ: "Azerbaijan", BA: "Bosnia and Herzegovina", BB: "Barbados",
  BD: "Bangladesh", BE: "Belgium", BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain",
  BI: "Burundi", BJ: "Benin", BL: "Saint Barthélemy", BM: "Bermuda", BN: "Brunei",
  BO: "Bolivia", BQ: "Bonaire, Sint Eustatius and Saba", BR: "Brazil", BS: "Bahamas",
  BT: "Bhutan", BV: "Bouvet Island", BW: "Botswana", BY: "Belarus", BZ: "Belize",
  CA: "Canada", CC: "Cocos (Keeling) Islands", CD: "DR Congo", CF: "Central African Republic",
  CG: "Congo", CH: "Switzerland", CI: "Côte d'Ivoire", CK: "Cook Islands", CL: "Chile",
  CM: "Cameroon", CN: "China", CO: "Colombia", CR: "Costa Rica", CU: "Cuba",
  CV: "Cape Verde", CW: "Curaçao", CX: "Christmas Island", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic",
  DZ: "Algeria", EC: "Ecuador", EE: "Estonia", EG: "Egypt", EH: "Western Sahara",
  ER: "Eritrea", ES: "Spain", ET: "Ethiopia", FI: "Finland", FJ: "Fiji",
  FK: "Falkland Islands", FM: "Micronesia", FO: "Faroe Islands", FR: "France",
  GA: "Gabon", GB: "United Kingdom", GD: "Grenada", GE: "Georgia", GF: "French Guiana",
  GG: "Guernsey", GH: "Ghana", GI: "Gibraltar", GL: "Greenland", GM: "Gambia",
  GN: "Guinea", GP: "Guadeloupe", GQ: "Equatorial Guinea", GR: "Greece",
  GS: "South Georgia", GT: "Guatemala", GU: "Guam", GW: "Guinea-Bissau", GY: "Guyana",
  HK: "Hong Kong", HM: "Heard Island and McDonald Islands", HN: "Honduras", HR: "Croatia",
  HT: "Haiti", HU: "Hungary", ID: "Indonesia", IE: "Ireland", IL: "Israel", IM: "Isle of Man",
  IN: "India", IO: "British Indian Ocean Territory", IQ: "Iraq", IR: "Iran", IS: "Iceland",
  IT: "Italy", JE: "Jersey", JM: "Jamaica", JO: "Jordan", JP: "Japan", KE: "Kenya",
  KG: "Kyrgyzstan", KH: "Cambodia", KI: "Kiribati", KM: "Comoros", KN: "Saint Kitts and Nevis",
  KP: "North Korea", KR: "South Korea", KW: "Kuwait", KY: "Cayman Islands", KZ: "Kazakhstan",
  LA: "Laos", LB: "Lebanon", LC: "Saint Lucia", LI: "Liechtenstein", LK: "Sri Lanka",
  LR: "Liberia", LS: "Lesotho", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", LY: "Libya",
  MA: "Morocco", MC: "Monaco", MD: "Moldova", ME: "Montenegro", MF: "Saint Martin",
  MG: "Madagascar", MH: "Marshall Islands", MK: "North Macedonia", ML: "Mali", MM: "Myanmar",
  MN: "Mongolia", MO: "Macao", MP: "Northern Mariana Islands", MQ: "Martinique", MR: "Mauritania",
  MS: "Montserrat", MT: "Malta", MU: "Mauritius", MV: "Maldives", MW: "Malawi", MX: "Mexico",
  MY: "Malaysia", MZ: "Mozambique", NA: "Namibia", NC: "New Caledonia", NE: "Niger",
  NF: "Norfolk Island", NG: "Nigeria", NI: "Nicaragua", NL: "Netherlands", NO: "Norway",
  NP: "Nepal", NR: "Nauru", NU: "Niue", NZ: "New Zealand", OM: "Oman", PA: "Panama",
  PE: "Peru", PF: "French Polynesia", PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan",
  PL: "Poland", PM: "Saint Pierre and Miquelon", PN: "Pitcairn", PR: "Puerto Rico",
  PS: "Palestine", PT: "Portugal", PW: "Palau", PY: "Paraguay", QA: "Qatar", RE: "Réunion",
  RO: "Romania", RS: "Serbia", RU: "Russia", RW: "Rwanda", SA: "Saudi Arabia",
  SB: "Solomon Islands", SC: "Seychelles", SD: "Sudan", SE: "Sweden", SG: "Singapore",
  SH: "Saint Helena", SI: "Slovenia", SJ: "Svalbard and Jan Mayen", SK: "Slovakia",
  SL: "Sierra Leone", SM: "San Marino", SN: "Senegal", SO: "Somalia", SR: "Suriname",
  SS: "South Sudan", ST: "São Tomé and Príncipe", SV: "El Salvador", SX: "Sint Maarten",
  SY: "Syria", SZ: "Eswatini", TC: "Turks and Caicos Islands", TD: "Chad",
  TF: "French Southern Territories", TG: "Togo", TH: "Thailand", TJ: "Tajikistan",
  TK: "Tokelau", TL: "Timor-Leste", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga",
  TR: "Turkey", TT: "Trinidad and Tobago", TV: "Tuvalu", TW: "Taiwan", TZ: "Tanzania",
  UA: "Ukraine", UG: "Uganda", UM: "United States Minor Outlying Islands", US: "United States",
  UY: "Uruguay", UZ: "Uzbekistan", VA: "Vatican City", VC: "Saint Vincent and the Grenadines",
  VE: "Venezuela", VG: "British Virgin Islands", VI: "U.S. Virgin Islands", VN: "Vietnam",
  VU: "Vanuatu", WF: "Wallis and Futuna", WS: "Samoa", XK: "Kosovo", YE: "Yemen",
  YT: "Mayotte", ZA: "South Africa", ZM: "Zambia", ZW: "Zimbabwe",
}

export function countryName(code?: string): string | undefined {
  if (!code) return undefined
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase()
}

// Official IBAN lengths by country (ISO 13616 registry subset).
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, BH: 22, CH: 21, CY: 28, CZ: 24,
  DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21,
  HU: 28, IE: 22, IL: 23, IT: 27, KW: 30, LI: 21, LT: 20, LU: 20, LV: 21,
  MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, QA: 29, RO: 24, SA: 24,
  SE: 24, SI: 19, SK: 24,
}

// How many leading BBAN characters identify the bank, per country (ISO 13616
// national bank-identifier lengths). Complete for every country in
// IBAN_LENGTHS so a valid IBAN always yields a bank code for directory lookup.
const IBAN_BANK_CODE_LENGTH: Record<string, number> = {
  AD: 4, AE: 3, AT: 5, BE: 3, BG: 4, BH: 4, CH: 5, CY: 3, CZ: 4,
  DE: 8, DK: 4, EE: 2, ES: 4, FI: 3, FR: 5, GB: 4, GR: 3, HR: 7,
  HU: 3, IE: 4, IL: 3, IT: 5, KW: 4, LI: 5, LT: 5, LU: 3, LV: 4,
  MC: 5, MT: 4, NL: 4, NO: 4, PL: 8, PT: 4, QA: 4, RO: 4, SA: 2,
  SE: 3, SI: 5, SK: 4,
}

// Curated bank directory. Each entry can be matched by BIC (full or 6-char
// prefix) and/or by an IBAN national bank code keyed per country.
type DirectoryEntry = {
  name: string
  city: string
  countryCode: string
  bicPrefixes: string[] // 6 or 8 char prefixes
  /** Full 8-char primary SWIFT/BIC, used to auto-fill the SWIFT field from an IBAN. */
  primaryBic?: string
  /** Registered/head-office street address, used to auto-fill the bank address. */
  address?: string
  /** Postal / ZIP code of the registered office. */
  postalCode?: string
  ibanBankCodes?: { country: string; code: string }[]
}

const BANK_DIRECTORY: DirectoryEntry[] = [
  { name: "MCC Capital Bank", city: "Geneva", countryCode: "CH", bicPrefixes: ["MCCBCH"], primaryBic: "MCCBCHGG", address: "Rue du Rhône 100", postalCode: "1204", ibanBankCodes: [{ country: "CH", code: "08390" }] },
  { name: "UBS Switzerland AG", city: "Zurich", countryCode: "CH", bicPrefixes: ["UBSWCH"], primaryBic: "UBSWCHZH", address: "Bahnhofstrasse 45", postalCode: "8001", ibanBankCodes: [{ country: "CH", code: "00273" }] },
  { name: "Credit Suisse (Schweiz) AG", city: "Zurich", countryCode: "CH", bicPrefixes: ["CRESCH"], primaryBic: "CRESCHZZ", address: "Paradeplatz 8", postalCode: "8001", ibanBankCodes: [{ country: "CH", code: "04835" }] },
  { name: "Banking Circle / SX Payments", city: "Hamburg", countryCode: "DE", bicPrefixes: ["SXPYDE"], primaryBic: "SXPYDEHH", address: "Willy-Brandt-Strasse 23", postalCode: "20457", ibanBankCodes: [{ country: "DE", code: "20220800" }] },
  { name: "Deutsche Bank AG", city: "Frankfurt", countryCode: "DE", bicPrefixes: ["DEUTDE"], primaryBic: "DEUTDEFF", address: "Taunusanlage 12", postalCode: "60325", ibanBankCodes: [{ country: "DE", code: "50070010" }] },
  { name: "Commerzbank AG", city: "Frankfurt", countryCode: "DE", bicPrefixes: ["COBADE"], primaryBic: "COBADEFF", address: "Kaiserplatz 16", postalCode: "60311", ibanBankCodes: [{ country: "DE", code: "50040000" }] },
  { name: "BNP Paribas", city: "Paris", countryCode: "FR", bicPrefixes: ["BNPAFR"], primaryBic: "BNPAFRPP", address: "16 Boulevard des Italiens", postalCode: "75009", ibanBankCodes: [{ country: "FR", code: "30004" }] },
  { name: "Société Générale", city: "Paris", countryCode: "FR", bicPrefixes: ["SOGEFR"], primaryBic: "SOGEFRPP", address: "29 Boulevard Haussmann", postalCode: "75009", ibanBankCodes: [{ country: "FR", code: "30003" }] },
  { name: "JPMorgan Chase Bank, N.A.", city: "New York", countryCode: "US", bicPrefixes: ["CHASUS"], primaryBic: "CHASUS33", address: "383 Madison Avenue", postalCode: "10179" },
  { name: "Citibank N.A.", city: "New York", countryCode: "US", bicPrefixes: ["CITIUS"], primaryBic: "CITIUS33", address: "388 Greenwich Street", postalCode: "10013" },
  { name: "Bank of America, N.A.", city: "Charlotte", countryCode: "US", bicPrefixes: ["BOFAUS"], primaryBic: "BOFAUS3N", address: "100 North Tryon Street", postalCode: "28255" },
  { name: "NatWest Bank", city: "London", countryCode: "GB", bicPrefixes: ["NWBKGB"], primaryBic: "NWBKGB2L", address: "250 Bishopsgate", postalCode: "EC2M 4AA", ibanBankCodes: [{ country: "GB", code: "NWBK" }] },
  { name: "Barclays Bank PLC", city: "London", countryCode: "GB", bicPrefixes: ["BARCGB"], primaryBic: "BARCGB22", address: "1 Churchill Place", postalCode: "E14 5HP", ibanBankCodes: [{ country: "GB", code: "BARC" }] },
  { name: "HSBC Bank PLC", city: "London", countryCode: "GB", bicPrefixes: ["HBUKGB", "MIDLGB"], primaryBic: "HBUKGB4B", address: "8 Canada Square", postalCode: "E14 5HQ", ibanBankCodes: [{ country: "GB", code: "HBUK" }, { country: "GB", code: "MIDL" }] },
  { name: "HSBC Bank Middle East", city: "Abu Dhabi", countryCode: "AE", bicPrefixes: ["HABORU", "BBMEAE"], primaryBic: "BBMEAEAD", address: "Al Maqam Tower, ADGM Square, Al Maryah Island" },
  { name: "Emirates NBD", city: "Dubai", countryCode: "AE", bicPrefixes: ["EBILAE"], primaryBic: "EBILAEAD", address: "Baniyas Road, Deira", ibanBankCodes: [{ country: "AE", code: "033" }] },
  { name: "DBS Bank Ltd", city: "Singapore", countryCode: "SG", bicPrefixes: ["DBSSSG"], primaryBic: "DBSSSGSG", address: "12 Marina Boulevard, Marina Bay Financial Centre Tower 3", postalCode: "018982" },
  { name: "Standard Chartered Bank", city: "Singapore", countryCode: "SG", bicPrefixes: ["SCBLSG"], primaryBic: "SCBLSGSG", address: "8 Marina Boulevard, Marina Bay Financial Centre Tower 1", postalCode: "018981" },
  { name: "MUFG Bank, Ltd.", city: "Tokyo", countryCode: "JP", bicPrefixes: ["BOTKJP"], primaryBic: "BOTKJPJT", address: "2-7-1 Marunouchi, Chiyoda-ku", postalCode: "100-8388" },
  { name: "The Hongkong and Shanghai Banking Corp.", city: "Hong Kong", countryCode: "HK", bicPrefixes: ["HSBCHK"], primaryBic: "HSBCHKHH", address: "1 Queen's Road Central" },
  { name: "ING Bank N.V.", city: "Amsterdam", countryCode: "NL", bicPrefixes: ["INGBNL"], primaryBic: "INGBNL2A", address: "Bijlmerdreef 106", postalCode: "1102 CT", ibanBankCodes: [{ country: "NL", code: "INGB" }] },
  { name: "CaixaBank S.A.", city: "Barcelona", countryCode: "ES", bicPrefixes: ["CAIXES"], primaryBic: "CAIXESBB", address: "Calle Pintor Sorolla 2-4", postalCode: "46002", ibanBankCodes: [{ country: "ES", code: "2100" }] },
  { name: "UniCredit S.p.A.", city: "Milan", countryCode: "IT", bicPrefixes: ["UNCRIT"], primaryBic: "UNCRITMM", address: "Piazza Gae Aulenti 3", postalCode: "20154", ibanBankCodes: [{ country: "IT", code: "02008" }] },

  // --- Pan-European fintech / e-money institutions (issue IBANs across many
  //     countries; matched by their national bank code where applicable) ---
  { name: "Revolut Bank UAB", city: "Vilnius", countryCode: "LT", bicPrefixes: ["REVOLT", "REVO"], primaryBic: "REVOLT21", address: "Konstitucijos pr. 21B", postalCode: "08130", ibanBankCodes: [{ country: "LT", code: "32500" }] },
  { name: "UAB Paysera LT", city: "Vilnius", countryCode: "LT", bicPrefixes: ["EVIULT"], primaryBic: "EVIULT2V", address: "Pilaitės pr. 16", postalCode: "04352", ibanBankCodes: [{ country: "LT", code: "35000" }] },
  { name: "Wise Europe SA", city: "Brussels", countryCode: "BE", bicPrefixes: ["TRWIBE"], primaryBic: "TRWIBEB1", address: "Avenue Louise 54", postalCode: "1050", ibanBankCodes: [{ country: "BE", code: "967" }] },
  { name: "N26 Bank AG", city: "Berlin", countryCode: "DE", bicPrefixes: ["NTSBDE"], primaryBic: "NTSBDEB1", address: "Voltairestraße 8", postalCode: "10179", ibanBankCodes: [{ country: "DE", code: "10011001" }] },

  // --- Lithuania (LT) ---
  { name: "AB SEB bankas", city: "Vilnius", countryCode: "LT", bicPrefixes: ["CBVILT"], primaryBic: "CBVILT2X", address: "Konstitucijos pr. 24", postalCode: "08105", ibanBankCodes: [{ country: "LT", code: "70440" }] },
  { name: "Swedbank AB (Lithuania)", city: "Vilnius", countryCode: "LT", bicPrefixes: ["HABALT"], primaryBic: "HABALT22", address: "Konstitucijos pr. 20A", postalCode: "03502", ibanBankCodes: [{ country: "LT", code: "73000" }] },
  { name: "Luminor Bank AS Lithuania", city: "Vilnius", countryCode: "LT", bicPrefixes: ["AGBLLT"], primaryBic: "AGBLLT2X", address: "Konstitucijos pr. 21A", postalCode: "03601", ibanBankCodes: [{ country: "LT", code: "21400" }] },
  { name: "Šiaulių bankas AB", city: "Šiauliai", countryCode: "LT", bicPrefixes: ["CBSBLT"], primaryBic: "CBSBLT26", address: "Tilžės g. 149", postalCode: "76348", ibanBankCodes: [{ country: "LT", code: "71800" }] },

  // --- Latvia (LV, 4-letter bank code) ---
  { name: "Swedbank AS (Latvia)", city: "Riga", countryCode: "LV", bicPrefixes: ["HABALV"], primaryBic: "HABALV22", address: "Balasta dambis 1A", postalCode: "LV-1048", ibanBankCodes: [{ country: "LV", code: "HABA" }] },
  { name: "SEB banka AS", city: "Riga", countryCode: "LV", bicPrefixes: ["UNLALV"], primaryBic: "UNLALV2X", address: "Meistaru iela 1, Valdlauči", postalCode: "LV-1076", ibanBankCodes: [{ country: "LV", code: "UNLA" }] },
  { name: "Luminor Bank AS (Latvia)", city: "Riga", countryCode: "LV", bicPrefixes: ["RIKOLV"], primaryBic: "RIKOLV2X", address: "Skanstes iela 12", postalCode: "LV-1013", ibanBankCodes: [{ country: "LV", code: "RIKO" }] },

  // --- Estonia (EE, 2-digit bank code) ---
  { name: "Swedbank AS (Estonia)", city: "Tallinn", countryCode: "EE", bicPrefixes: ["HABAEE"], primaryBic: "HABAEE2X", address: "Liivalaia 8", postalCode: "15040", ibanBankCodes: [{ country: "EE", code: "22" }] },
  { name: "AS SEB Pank", city: "Tallinn", countryCode: "EE", bicPrefixes: ["EEUHEE"], primaryBic: "EEUHEE2X", address: "Tornimäe 2", postalCode: "15010", ibanBankCodes: [{ country: "EE", code: "10" }] },
  { name: "AS LHV Pank", city: "Tallinn", countryCode: "EE", bicPrefixes: ["LHVBEE"], primaryBic: "LHVBEE22", address: "Tartu mnt 2", postalCode: "10145", ibanBankCodes: [{ country: "EE", code: "77" }] },

  // --- Poland (PL, bank identified by first 3 of the 8-digit code; we match
  //     the common full settlement codes of the largest banks) ---
  { name: "PKO Bank Polski", city: "Warsaw", countryCode: "PL", bicPrefixes: ["BPKOPL"], primaryBic: "BPKOPLPW", address: "ul. Puławska 15", postalCode: "02-515", ibanBankCodes: [{ country: "PL", code: "10201026" }] },

  // --- Ireland (IE, 4-letter bank code) ---
  { name: "Allied Irish Banks plc", city: "Dublin", countryCode: "IE", bicPrefixes: ["AIBKIE"], primaryBic: "AIBKIE2D", address: "10 Molesworth Street", postalCode: "D02 R126", ibanBankCodes: [{ country: "IE", code: "AIBK" }] },
  { name: "Bank of Ireland", city: "Dublin", countryCode: "IE", bicPrefixes: ["BOFIIE"], primaryBic: "BOFIIE2D", address: "40 Mespil Road", postalCode: "D04 C2N4", ibanBankCodes: [{ country: "IE", code: "BOFI" }] },

  // --- Malta (MT, 4-letter bank code = BIC bank prefix) ---
  { name: "Papaya Ltd", city: "Sliema", countryCode: "MT", bicPrefixes: ["PAPYMT"], primaryBic: "PAPYMTMT", address: "Tower Business Centre, Tower Street, Swatar", postalCode: "BKR 4013", ibanBankCodes: [{ country: "MT", code: "PAPY" }] },
  { name: "Bank of Valletta plc", city: "Santa Venera", countryCode: "MT", bicPrefixes: ["VALLMT"], primaryBic: "VALLMTMT", address: "BOV Centre, Triq il-Kanun", postalCode: "SVR 9030", ibanBankCodes: [{ country: "MT", code: "VALL" }] },
  { name: "HSBC Bank Malta plc", city: "Valletta", countryCode: "MT", bicPrefixes: ["MMEBMT"], primaryBic: "MMEBMTMT", address: "116 Archbishop Street", postalCode: "VLT 1444", ibanBankCodes: [{ country: "MT", code: "MMEB" }] },
  { name: "APS Bank plc", city: "Swatar", countryCode: "MT", bicPrefixes: ["APSBMT"], primaryBic: "APSBMTMT", address: "APS Centre, Tower Street", postalCode: "BKR 4012", ibanBankCodes: [{ country: "MT", code: "APSB" }] },
  { name: "Lombard Bank Malta plc", city: "Valletta", countryCode: "MT", bicPrefixes: ["LBMAMT"], primaryBic: "LBMAMTMT", address: "67 Republic Street", postalCode: "VLT 1117", ibanBankCodes: [{ country: "MT", code: "LBMA" }] },
]

function normalize(value: string): string {
  return (value || "").toUpperCase().replace(/[\s-]/g, "")
}

// ISO 7064 mod-97-10 over the rearranged IBAN, computed in chunks so we never
// rely on BigInt and never overflow Number.
function mod97(input: string): number {
  let remainder = ""
  for (let i = 0; i < input.length; i++) {
    remainder += input[i]
    if (remainder.length >= 9) {
      remainder = String(Number(remainder) % 97)
    }
  }
  return Number(remainder) % 97
}

export function validateIban(raw: string): IbanValidation {
  const value = normalize(raw)
  const formatted = (value.match(/.{1,4}/g) || []).join(" ")

  if (!value) {
    return { valid: false, formatted: "", error: "IBAN is required" }
  }
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(value)) {
    return { valid: false, formatted, error: "Invalid IBAN format" }
  }

  const countryCode = value.slice(0, 2)
  const expectedLength = IBAN_LENGTHS[countryCode]
  if (!expectedLength) {
    return { valid: false, formatted, countryCode, error: `Unsupported IBAN country: ${countryCode}` }
  }
  if (value.length !== expectedLength) {
    return {
      valid: false,
      formatted,
      countryCode,
      error: `IBAN must be ${expectedLength} characters for ${countryName(countryCode)}`,
    }
  }

  // Move first 4 chars to the end and convert letters (A=10 … Z=35).
  const rearranged = value.slice(4) + value.slice(0, 4)
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55))
  if (mod97(numeric) !== 1) {
    return { valid: false, formatted, countryCode, error: "IBAN checksum failed" }
  }

  const bankLen = IBAN_BANK_CODE_LENGTH[countryCode]
  const bankCode = bankLen ? value.slice(4, 4 + bankLen) : undefined

  return {
    valid: true,
    formatted,
    countryCode,
    countryName: countryName(countryCode),
    bankCode,
  }
}

const BIC_REGEX = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/

export function validateBic(raw: string): BicValidation {
  const value = normalize(raw)

  if (!value) {
    return { valid: false, normalized: "", error: "SWIFT/BIC is required" }
  }
  if (value.length !== 8 && value.length !== 11) {
    return { valid: false, normalized: value, error: "BIC must be 8 or 11 characters" }
  }
  if (!BIC_REGEX.test(value)) {
    return { valid: false, normalized: value, error: "Invalid SWIFT/BIC format" }
  }

  const countryCode = value.slice(4, 6)
  if (!COUNTRY_NAMES[countryCode]) {
    return { valid: false, normalized: value, countryCode, error: `Unknown country code: ${countryCode}` }
  }

  return {
    valid: true,
    normalized: value,
    bankCode: value.slice(0, 4),
    countryCode,
    countryName: countryName(countryCode),
    locationCode: value.slice(6, 8),
    branchCode: value.length === 11 ? value.slice(8, 11) : undefined,
  }
}

function findByBic(bic: string): DirectoryEntry | undefined {
  const v = normalize(bic)
  const six = v.slice(0, 6)
  return BANK_DIRECTORY.find((e) => e.bicPrefixes.some((p) => p === v || p === six || v.startsWith(p)))
}

function findByIban(countryCode: string, bankCode?: string): DirectoryEntry | undefined {
  if (!bankCode) return undefined
  return BANK_DIRECTORY.find((e) =>
    e.ibanBankCodes?.some((b) => b.country === countryCode && b.code === bankCode),
  )
}

// Simulate an async directory lookup so the UI can show a verifying state.
function delay<T>(value: T, ms = 450): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export async function lookupBankByBic(raw: string): Promise<BankInfo | null> {
  const result = validateBic(raw)
  if (!result.valid || !result.countryCode) return delay(null)

  const entry = findByBic(result.normalized)
  const info: BankInfo = entry
    ? {
        name: entry.name,
        city: entry.city,
        country: countryName(entry.countryCode) ?? entry.countryCode,
        countryCode: entry.countryCode,
        bic: result.normalized,
        address: entry.address,
        postalCode: entry.postalCode,
        branch:
          result.branchCode && result.branchCode !== "XXX"
            ? `Branch ${result.branchCode}`
            : "Head Office",
      }
    : {
        // Valid BIC but not in directory — still resolve country + codes.
        name: `Financial institution (${result.bankCode})`,
        country: result.countryName ?? result.countryCode,
        countryCode: result.countryCode,
        bic: result.normalized,
        branch:
          result.branchCode && result.branchCode !== "XXX"
            ? `Branch ${result.branchCode}`
            : "Head Office",
      }
  return delay(info)
}

// Corporate-form / geography words that carry no brand meaning, so they must
// not drive a directory match (e.g. "HSBC HOLDINGS PLC" should match on HSBC).
const NAME_STOPWORDS = new Set([
  "BANK", "BANQUE", "BANCA", "BANCO", "AG", "SA", "PLC", "NV", "NA",
  "LTD", "LIMITED", "INC", "CORP", "CORPORATION", "GROUP", "HOLDINGS", "HOLDING",
  "THE", "OF", "AND", "CO", "COMPANY", "SPA", "AS", "UAB", "AB", "PANK", "BANKAS",
  "BANKA", "EUROPE", "INTERNATIONAL", "SCHWEIZ", "SWITZERLAND", "SUISSE",
  "FINANCIAL", "SERVICES", "TRUST", "PUBLIC", "JOINT", "STOCK",
])

/** Uppercase, strip diacritics + punctuation, drop corporate-form stopwords. */
function brandTokens(name: string): string[] {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t))
}

/**
 * Resolve a bank from the curated directory by its free-text legal / issuer
 * name (e.g. from GLEIF or OpenFIGI). Matches on shared brand tokens, with a
 * 4-character stem match so brand variants align (CITIGROUP↔CITIBANK). Returns
 * only a confident single best match — otherwise null, so we never guess.
 */
export async function lookupBankByName(rawName: string): Promise<BankInfo | null> {
  const q = brandTokens(rawName)
  if (!q.length) return delay(null)

  let best: DirectoryEntry | undefined
  let bestScore = 0
  for (const e of BANK_DIRECTORY) {
    const et = brandTokens(e.name)
    let score = 0
    for (const qt of q) {
      for (const t of et) {
        if (qt === t) score += 2
        else if (qt.length >= 4 && t.length >= 4 && qt.slice(0, 4) === t.slice(0, 4)) score += 1
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }
  if (!best || bestScore === 0) return delay(null)

  return delay({
    name: best.name,
    city: best.city,
    country: countryName(best.countryCode) ?? best.countryCode,
    countryCode: best.countryCode,
    bic: best.primaryBic,
    address: best.address,
    postalCode: best.postalCode,
    branch: "Head Office",
  })
}

export async function lookupBankByIban(raw: string): Promise<BankInfo | null> {
  const result = validateIban(raw)
  if (!result.valid || !result.countryCode) return delay(null)

  const country = countryName(result.countryCode) ?? result.countryName ?? result.countryCode
  const entry = findByIban(result.countryCode, result.bankCode)

  // Known bank in the curated directory — richest data (incl. street address).
  if (entry) {
    return delay({
      name: entry.name,
      city: entry.city,
      country: countryName(entry.countryCode) ?? entry.countryCode,
      countryCode: entry.countryCode,
      bic: entry.primaryBic,
      address: entry.address,
      postalCode: entry.postalCode,
    })
  }

  // Not curated — return a generic label from the IBAN structure. Richer data
  // (real bank name/BIC/city) is resolved separately by callers via the
  // `resolveIbanExternal` server action, so this shared utility stays free of
  // any server-only imports and can be safely bundled into client components.
  return delay({
    name: result.bankCode ? `Bank code ${result.bankCode}` : "Registered institution",
    country,
    countryCode: result.countryCode,
  })
}

/**
 * True when a resolved BankInfo is only the generic IBAN-structure fallback
 * (no real bank identity), meaning callers should try the external directory.
 */
export function isGenericBankInfo(info: BankInfo | null): boolean {
  if (!info) return true
  return !info.bic && (/^Bank code /.test(info.name) || info.name === "Registered institution")
}
