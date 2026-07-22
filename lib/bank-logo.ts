// ---------------------------------------------------------------------------
// Bank issuer logo resolver (server-safe, no React / no "use client").
//
// Resolves the REAL issuing bank behind an instrument to its genuine brand
// logo. The logo mark is fetched at render time from a public logo CDN keyed
// on the bank's real web domain — nothing is fabricated. When we can't map the
// bank to a known domain, callers fall back to a typographic monogram crest
// built from the bank's real initials (typography, not an invented logo).
//
// Domain resolution order:
//   1) BIC institution code (first 4 chars) → domain  (most reliable)
//   2) Bank-name token match                → domain
// ---------------------------------------------------------------------------

// Real domains for the major issuing banks in the app's partner catalogue,
// keyed by the 4-character BIC institution code (ISO 9362). These are the
// banks' genuine corporate domains.
const BIC_STEM_DOMAINS: Record<string, string> = {
  // United Kingdom & Ireland
  HBUK: "hsbc.com",
  MIDL: "hsbc.com",
  BARC: "barclays.co.uk",
  NWBK: "natwest.com",
  LOYD: "lloydsbank.com",
  SCBL: "sc.com",
  ABBY: "santander.co.uk",
  AIBK: "aib.ie",
  BOFI: "bankofireland.com",
  // Eurozone & wider Europe
  BNPA: "bnpparibas.com",
  AGRI: "credit-agricole.com",
  SOGE: "societegenerale.com",
  CCBP: "groupebpce.com",
  CMCI: "creditmutuel.fr",
  DEUT: "db.com",
  COBA: "commerzbank.com",
  GENO: "dzbank.de",
  KFWI: "kfw.de",
  INGB: "ing.com",
  RABO: "rabobank.com",
  ABNA: "abnamro.com",
  BSCH: "santander.com",
  BBVA: "bbva.com",
  CAIX: "caixabank.com",
  BCIT: "intesasanpaolo.com",
  UNCR: "unicreditgroup.eu",
  KRED: "kbc.com",
  GKCC: "belfius.be",
  UBSW: "ubs.com",
  ZKBK: "zkb.ch",
  RAIF: "raiffeisen.ch",
  GIBA: "erstegroup.com",
  RZBA: "rbinternational.com",
  CGDI: "cgd.pt",
  BCOM: "millenniumbcp.pt",
  NDEA: "nordea.com",
  OKOY: "op.fi",
  ESSE: "seb.se",
  CBVI: "seb.se",
  HAND: "handelsbanken.com",
  SWED: "swedbank.com",
  HABA: "swedbank.com",
  DNBA: "dnb.no",
  DABA: "danskebank.com",
  NYKB: "nykredit.dk",
  BCIR: "bankingcircle.com",
  SXPY: "bankingcircle.com",
  BILL: "bil.com",
  CRES: "credit-suisse.com",
  // North America
  CHAS: "jpmorganchase.com",
  BOFA: "bankofamerica.com",
  CITI: "citigroup.com",
  WFBI: "wellsfargo.com",
  USBK: "usbank.com",
  PNCC: "pnc.com",
  BRBT: "truist.com",
  GSCM: "goldmansachs.com",
  MSNY: "morganstanley.com",
  IRVT: "bny.com",
  SBOS: "statestreet.com",
  NFBK: "capitalone.com",
  ROYC: "rbc.com",
  TDOM: "td.com",
  NOSC: "scotiabank.com",
  BOFM: "bmo.com",
  CIBC: "cibc.com",
  ITAU: "itau.com.br",
  BBDE: "bradesco.com.br",
  BRAS: "bb.com.br",
  BCMR: "bbva.mx",
  MENO: "banorte.com",
  BNMX: "banamex.com",
  // Asia-Pacific
  ICBK: "icbc.com.cn",
  PCBC: "ccb.com",
  ABOC: "abchina.com",
  BKCH: "boc.cn",
  COMM: "bankcomm.com",
  CMBC: "cmbchina.com",
  BOTK: "mufg.jp",
  SMBC: "smbc.co.jp",
  MHCB: "mizuhobank.com",
  JPPS: "jp-bank.japanpost.jp",
  DBSS: "dbs.com",
  OCBC: "ocbc.com",
  UOVB: "uobgroup.com",
  HASE: "hangseng.com",
  HSBC: "hsbc.com.hk",
  SBIN: "sbi.co.in",
  HDFC: "hdfcbank.com",
  ICIC: "icicibank.com",
  AXIS: "axisbank.com",
  CTBA: "commbank.com.au",
  WPAC: "westpac.com.au",
  ANZB: "anz.com.au",
  // Middle East & Africa
  EBIL: "emiratesnbd.com",
  BBME: "hsbc.ae",
}

// Name-token fallbacks (lowercased substring → domain) for when a BIC is not
// present or its stem is not in the map above.
const NAME_DOMAINS: Array<{ match: string; domain: string }> = [
  { match: "hsbc", domain: "hsbc.com" },
  { match: "barclays", domain: "barclays.co.uk" },
  { match: "natwest", domain: "natwest.com" },
  { match: "lloyds", domain: "lloydsbank.com" },
  { match: "standard chartered", domain: "sc.com" },
  { match: "santander", domain: "santander.com" },
  { match: "bnp paribas", domain: "bnpparibas.com" },
  { match: "crédit agricole", domain: "credit-agricole.com" },
  { match: "credit agricole", domain: "credit-agricole.com" },
  { match: "société générale", domain: "societegenerale.com" },
  { match: "societe generale", domain: "societegenerale.com" },
  { match: "deutsche bank", domain: "db.com" },
  { match: "commerzbank", domain: "commerzbank.com" },
  { match: "ing", domain: "ing.com" },
  { match: "rabobank", domain: "rabobank.com" },
  { match: "abn amro", domain: "abnamro.com" },
  { match: "bbva", domain: "bbva.com" },
  { match: "caixabank", domain: "caixabank.com" },
  { match: "intesa", domain: "intesasanpaolo.com" },
  { match: "unicredit", domain: "unicreditgroup.eu" },
  { match: "kbc", domain: "kbc.com" },
  { match: "ubs", domain: "ubs.com" },
  { match: "credit suisse", domain: "credit-suisse.com" },
  { match: "erste", domain: "erstegroup.com" },
  { match: "raiffeisen", domain: "rbinternational.com" },
  { match: "nordea", domain: "nordea.com" },
  { match: "handelsbanken", domain: "handelsbanken.com" },
  { match: "swedbank", domain: "swedbank.com" },
  { match: "danske", domain: "danskebank.com" },
  { match: "banking circle", domain: "bankingcircle.com" },
  { match: "jpmorgan", domain: "jpmorganchase.com" },
  { match: "j.p. morgan", domain: "jpmorganchase.com" },
  { match: "bank of america", domain: "bankofamerica.com" },
  { match: "citibank", domain: "citigroup.com" },
  { match: "citigroup", domain: "citigroup.com" },
  { match: "citibanamex", domain: "banamex.com" },
  { match: "wells fargo", domain: "wellsfargo.com" },
  { match: "u.s. bank", domain: "usbank.com" },
  { match: "pnc", domain: "pnc.com" },
  { match: "truist", domain: "truist.com" },
  { match: "goldman", domain: "goldmansachs.com" },
  { match: "morgan stanley", domain: "morganstanley.com" },
  { match: "state street", domain: "statestreet.com" },
  { match: "capital one", domain: "capitalone.com" },
  { match: "royal bank of canada", domain: "rbc.com" },
  { match: "scotiabank", domain: "scotiabank.com" },
  { match: "bank of montreal", domain: "bmo.com" },
  { match: "cibc", domain: "cibc.com" },
  { match: "itaú", domain: "itau.com.br" },
  { match: "itau", domain: "itau.com.br" },
  { match: "bradesco", domain: "bradesco.com.br" },
  { match: "banco do brasil", domain: "bb.com.br" },
  { match: "icbc", domain: "icbc.com.cn" },
  { match: "china construction", domain: "ccb.com" },
  { match: "agricultural bank of china", domain: "abchina.com" },
  { match: "bank of china", domain: "boc.cn" },
  { match: "china merchants", domain: "cmbchina.com" },
  { match: "mufg", domain: "mufg.jp" },
  { match: "sumitomo mitsui", domain: "smbc.co.jp" },
  { match: "mizuho", domain: "mizuhobank.com" },
  { match: "dbs", domain: "dbs.com" },
  { match: "ocbc", domain: "ocbc.com" },
  { match: "united overseas", domain: "uobgroup.com" },
  { match: "hang seng", domain: "hangseng.com" },
  { match: "state bank of india", domain: "sbi.co.in" },
  { match: "hdfc", domain: "hdfcbank.com" },
  { match: "icici", domain: "icicibank.com" },
  { match: "axis bank", domain: "axisbank.com" },
  { match: "commonwealth bank", domain: "commbank.com.au" },
  { match: "westpac", domain: "westpac.com.au" },
  { match: "anz", domain: "anz.com.au" },
  { match: "emirates nbd", domain: "emiratesnbd.com" },
  { match: "deutsche", domain: "db.com" },
]

/** Resolve the bank's real corporate domain from its BIC and/or name. */
export function resolveBankDomain(bankName?: string | null, bic?: string | null): string | null {
  const stem = (bic || "").trim().toUpperCase().slice(0, 4)
  if (stem && BIC_STEM_DOMAINS[stem]) return BIC_STEM_DOMAINS[stem]

  const name = (bankName || "").toLowerCase()
  if (name) {
    for (const { match, domain } of NAME_DOMAINS) {
      if (name.includes(match)) return domain
    }
  }
  return null
}

/**
 * Public logo-CDN URL for a domain. Uses Google's favicon service, which serves
 * the real logo mark from the institution's own site (free, no token, reliable
 * in print). `size` up to 256 is supported.
 */
export function logoUrlForDomain(domain: string, size = 128): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`
}

/** A secondary source used as an onerror fallback before the monogram. */
export function altLogoUrlForDomain(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`
}

/** Up to two initials from the real bank name — a typographic crest, not a logo. */
export function bankMonogram(bankName?: string | null): string {
  const words = (bankName || "")
    .replace(/[^A-Za-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "of", "and", "group", "bank", "banco", "banque"].includes(w.toLowerCase()))
  if (words.length === 0) {
    const t = (bankName || "?").trim()
    return (t.slice(0, 2) || "?").toUpperCase()
  }
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export interface BankLogo {
  domain: string | null
  logoUrl: string | null
  altLogoUrl: string | null
  monogram: string
}

/** One-shot resolver returning everything the printout needs. */
export function resolveBankLogo(bankName?: string | null, bic?: string | null, size = 128): BankLogo {
  const domain = resolveBankDomain(bankName, bic)
  return {
    domain,
    logoUrl: domain ? logoUrlForDomain(domain, size) : null,
    altLogoUrl: domain ? altLogoUrlForDomain(domain) : null,
    monogram: bankMonogram(bankName),
  }
}
