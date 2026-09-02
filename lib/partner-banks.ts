// ---------------------------------------------------------------------------
// Partner banks (server-safe)
//
// This module holds the partner-bank catalogue, types, and pure lookup helpers
// with NO "use client" directive and no React imports, so it can be consumed
// from both client components and server actions (e.g. the account-inventory
// allocation logic). The client gateway store re-exports everything here so
// existing `@/lib/gateway-store` imports continue to work unchanged.
// ---------------------------------------------------------------------------

// The principal partner banks the gateway routes through. Each carries the BIC
// stem and the currencies it is the natural correspondent for, so the admin
// approval flow can suggest a sensible default per request currency.
export interface PartnerBank {
  key: string
  name: string
  country: string
  /** ISO 3166-1 alpha-2 country code — drives IBAN structure / jurisdiction. */
  countryCode: string
  bic: string
  currencies: string[]
  /** Geographic grouping for the Partner Banks directory. */
  region: BankRegion
  /**
   * Real domestic clearing identifier used to seed the bank-code portion of a
   * generated IBAN so it resolves to a genuine institution. Length/meaning is
   * country-specific: GB/IE 6-digit sort code; DE 8-digit BLZ; FR code
   * banque(5)+guichet(5); ES entidad(4)+oficina(4); IT ABI(5)+CAB(5); PT
   * bank(4)+branch(4); CH/AT clearing(5); BE/AE/LU bank code(3); SA bank
   * code(2); FI bank/office(6); SE clearing(3); NO/DK bank number(4). Omitted
   * for countries whose IBAN bank code is the BIC stem (NL, QA) or that have no
   * IBAN (US, CA, …).
   */
  nationalBankCode?: string
}

export type BankRegion = "Europe" | "Americas" | "Asia-Pacific" | "Middle East & Africa"

export const BANK_REGIONS: BankRegion[] = ["Europe", "Americas", "Asia-Pacific", "Middle East & Africa"]

// ~100 of the world's largest banks, grouped by region. `region` powers the
// grouped/searchable Partner Banks directory. `countryCode` drives the IBAN
// jurisdiction (IBAN countries get a generated IBAN, others domestic coords).
export const PARTNER_BANKS: PartnerBank[] = [
  // --- United Kingdom & Ireland ---
  { key: "hsbc", name: "HSBC", country: "United Kingdom", countryCode: "GB", bic: "HBUKGB4B", currencies: ["GBP", "USD", "EUR", "HKD", "SGD"], region: "Europe", nationalBankCode: "400003" },
  { key: "barclays", name: "Barclays", country: "United Kingdom", countryCode: "GB", bic: "BARCGB22", currencies: ["GBP", "EUR", "USD"], region: "Europe", nationalBankCode: "200050" },
  { key: "natwest", name: "NatWest", country: "United Kingdom", countryCode: "GB", bic: "NWBKGB2L", currencies: ["GBP", "EUR"], region: "Europe", nationalBankCode: "600001" },
  { key: "lloyds", name: "Lloyds Bank", country: "United Kingdom", countryCode: "GB", bic: "LOYDGB2L", currencies: ["GBP", "EUR", "USD"], region: "Europe", nationalBankCode: "309634" },
  { key: "standardchartered", name: "Standard Chartered", country: "United Kingdom", countryCode: "GB", bic: "SCBLGB2L", currencies: ["GBP", "USD", "EUR", "HKD", "SGD", "AED"], region: "Europe", nationalBankCode: "609104" },
  { key: "santanderuk", name: "Santander UK", country: "United Kingdom", countryCode: "GB", bic: "ABBYGB2L", currencies: ["GBP", "EUR"], region: "Europe", nationalBankCode: "090029" },
  { key: "aib", name: "Allied Irish Banks", country: "Ireland", countryCode: "IE", bic: "AIBKIE2D", currencies: ["EUR", "GBP", "USD"], region: "Europe", nationalBankCode: "931152" },
  { key: "bankofireland", name: "Bank of Ireland", country: "Ireland", countryCode: "IE", bic: "BOFIIE2D", currencies: ["EUR", "GBP", "USD"], region: "Europe", nationalBankCode: "900017" },

  // --- Eurozone & wider Europe ---
  { key: "bnpparibas", name: "BNP Paribas", country: "France", countryCode: "FR", bic: "BNPAFRPP", currencies: ["EUR", "USD", "CHF"], region: "Europe", nationalBankCode: "3000400001" },
  { key: "creditagricole", name: "Crédit Agricole", country: "France", countryCode: "FR", bic: "AGRIFRPP", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "1900600001" },
  { key: "societegenerale", name: "Société Générale", country: "France", countryCode: "FR", bic: "SOGEFRPP", currencies: ["EUR", "USD", "GBP"], region: "Europe", nationalBankCode: "3000300001" },
  { key: "bpce", name: "Groupe BPCE", country: "France", countryCode: "FR", bic: "CCBPFRPP", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "1090700001" },
  { key: "creditmutuel", name: "Crédit Mutuel", country: "France", countryCode: "FR", bic: "CMCIFRPP", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "1027800001" },
  { key: "deutschebank", name: "Deutsche Bank", country: "Germany", countryCode: "DE", bic: "DEUTDEFF", currencies: ["EUR", "USD", "GBP", "CHF"], region: "Europe", nationalBankCode: "50070010" },
  { key: "commerzbank", name: "Commerzbank", country: "Germany", countryCode: "DE", bic: "COBADEFF", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "50040000" },
  { key: "dzbank", name: "DZ Bank", country: "Germany", countryCode: "DE", bic: "GENODEFF", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "50060400" },
  { key: "kfw", name: "KfW", country: "Germany", countryCode: "DE", bic: "KFWIDEFF", currencies: ["EUR"], region: "Europe", nationalBankCode: "50020400" },
  { key: "ing", name: "ING Group", country: "Netherlands", countryCode: "NL", bic: "INGBNL2A", currencies: ["EUR", "USD", "GBP"], region: "Europe" },
  { key: "rabobank", name: "Rabobank", country: "Netherlands", countryCode: "NL", bic: "RABONL2U", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "abnamro", name: "ABN AMRO", country: "Netherlands", countryCode: "NL", bic: "ABNANL2A", currencies: ["EUR", "USD", "GBP"], region: "Europe" },
  { key: "santander", name: "Banco Santander", country: "Spain", countryCode: "ES", bic: "BSCHESMM", currencies: ["EUR", "USD", "GBP", "BRL"], region: "Europe", nationalBankCode: "00490001" },
  { key: "bbva", name: "BBVA", country: "Spain", countryCode: "ES", bic: "BBVAESMM", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "01820001" },
  { key: "caixabank", name: "CaixaBank", country: "Spain", countryCode: "ES", bic: "CAIXESBB", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "21000001" },
  { key: "intesa", name: "Intesa Sanpaolo", country: "Italy", countryCode: "IT", bic: "BCITITMM", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "0306901600" },
  { key: "unicredit", name: "UniCredit", country: "Italy", countryCode: "IT", bic: "UNCRITMM", currencies: ["EUR", "USD", "GBP"], region: "Europe", nationalBankCode: "0200801600" },
  { key: "kbc", name: "KBC Group", country: "Belgium", countryCode: "BE", bic: "KREDBEBB", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "734" },
  { key: "belfius", name: "Belfius", country: "Belgium", countryCode: "BE", bic: "GKCCBEBB", currencies: ["EUR"], region: "Europe", nationalBankCode: "068" },
  { key: "ubs", name: "UBS", country: "Switzerland", countryCode: "CH", bic: "UBSWCHZH", currencies: ["CHF", "EUR", "USD", "GBP"], region: "Europe", nationalBankCode: "00240" },
  { key: "zkb", name: "Zürcher Kantonalbank", country: "Switzerland", countryCode: "CH", bic: "ZKBKCHZZ", currencies: ["CHF", "EUR", "USD"], region: "Europe", nationalBankCode: "00700" },
  { key: "raiffeisench", name: "Raiffeisen Switzerland", country: "Switzerland", countryCode: "CH", bic: "RAIFCH22", currencies: ["CHF", "EUR"], region: "Europe", nationalBankCode: "80000" },
  { key: "erste", name: "Erste Group Bank", country: "Austria", countryCode: "AT", bic: "GIBAATWW", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "20111" },
  { key: "raiffeisenat", name: "Raiffeisen Bank International", country: "Austria", countryCode: "AT", bic: "RZBAATWW", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "31000" },
  { key: "cgd", name: "Caixa Geral de Depósitos", country: "Portugal", countryCode: "PT", bic: "CGDIPTPL", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "00350000" },
  { key: "millenniumbcp", name: "Millennium BCP", country: "Portugal", countryCode: "PT", bic: "BCOMPTPL", currencies: ["EUR"], region: "Europe", nationalBankCode: "00330000" },
  { key: "nordea", name: "Nordea", country: "Finland", countryCode: "FI", bic: "NDEAFIHH", currencies: ["EUR", "SEK", "NOK", "DKK", "USD"], region: "Europe", nationalBankCode: "182345" },
  { key: "opbank", name: "OP Financial Group", country: "Finland", countryCode: "FI", bic: "OKOYFIHH", currencies: ["EUR", "USD"], region: "Europe", nationalBankCode: "500001" },
  { key: "seb", name: "SEB", country: "Sweden", countryCode: "SE", bic: "ESSESESS", currencies: ["SEK", "EUR", "USD"], region: "Europe", nationalBankCode: "500" },
  { key: "handelsbanken", name: "Handelsbanken", country: "Sweden", countryCode: "SE", bic: "HANDSESS", currencies: ["SEK", "EUR", "USD", "GBP"], region: "Europe", nationalBankCode: "600" },
  { key: "swedbank", name: "Swedbank", country: "Sweden", countryCode: "SE", bic: "SWEDSESS", currencies: ["SEK", "EUR"], region: "Europe", nationalBankCode: "800" },
  { key: "dnb", name: "DNB Bank", country: "Norway", countryCode: "NO", bic: "DNBANOKK", currencies: ["NOK", "EUR", "USD"], region: "Europe", nationalBankCode: "1200" },
  { key: "danskebank", name: "Danske Bank", country: "Denmark", countryCode: "DK", bic: "DABADKKK", currencies: ["DKK", "EUR", "USD", "SEK", "NOK"], region: "Europe", nationalBankCode: "3000" },
  { key: "nykredit", name: "Nykredit", country: "Denmark", countryCode: "DK", bic: "NYKBDKKK", currencies: ["DKK", "EUR"], region: "Europe", nationalBankCode: "8117" },
  { key: "bankingcircle", name: "Banking Circle SA", country: "Luxembourg", countryCode: "LU", bic: "BCIRLULL", currencies: ["EUR", "USD", "GBP", "CHF"], region: "Europe", nationalBankCode: "080" },
  { key: "bil", name: "Banque Internationale à Luxembourg", country: "Luxembourg", countryCode: "LU", bic: "BILLLULL", currencies: ["EUR", "USD", "CHF"], region: "Europe", nationalBankCode: "002" },

  // --- North America ---
  { key: "jpmorgan", name: "JPMorgan Chase", country: "United States", countryCode: "US", bic: "CHASUS33", currencies: ["USD", "EUR", "GBP", "JPY"], region: "Americas" },
  { key: "bofa", name: "Bank of America", country: "United States", countryCode: "US", bic: "BOFAUS3N", currencies: ["USD", "EUR", "CAD"], region: "Americas" },
  { key: "citi", name: "Citibank", country: "United States", countryCode: "US", bic: "CITIUS33", currencies: ["USD", "EUR", "GBP", "JPY", "HKD", "SGD", "AED"], region: "Americas" },
  { key: "wellsfargo", name: "Wells Fargo", country: "United States", countryCode: "US", bic: "WFBIUS6S", currencies: ["USD"], region: "Americas" },
  { key: "usbank", name: "U.S. Bank", country: "United States", countryCode: "US", bic: "USBKUS44", currencies: ["USD"], region: "Americas" },
  { key: "pnc", name: "PNC Bank", country: "United States", countryCode: "US", bic: "PNCCUS33", currencies: ["USD"], region: "Americas" },
  { key: "truist", name: "Truist Bank", country: "United States", countryCode: "US", bic: "BRBTUS33", currencies: ["USD"], region: "Americas" },
  { key: "goldman", name: "Goldman Sachs", country: "United States", countryCode: "US", bic: "GSCMUS33", currencies: ["USD", "EUR", "GBP"], region: "Americas" },
  { key: "morganstanley", name: "Morgan Stanley", country: "United States", countryCode: "US", bic: "MSNYUS33", currencies: ["USD", "EUR"], region: "Americas" },
  { key: "bny", name: "BNY", country: "United States", countryCode: "US", bic: "IRVTUS3N", currencies: ["USD", "EUR", "GBP"], region: "Americas" },
  { key: "statestreet", name: "State Street", country: "United States", countryCode: "US", bic: "SBOSUS33", currencies: ["USD", "EUR"], region: "Americas" },
  { key: "capitalone", name: "Capital One", country: "United States", countryCode: "US", bic: "NFBKUS33", currencies: ["USD"], region: "Americas" },
  { key: "rbc", name: "Royal Bank of Canada", country: "Canada", countryCode: "CA", bic: "ROYCCAT2", currencies: ["CAD", "USD", "EUR", "GBP"], region: "Americas" },
  { key: "td", name: "TD Bank Group", country: "Canada", countryCode: "CA", bic: "TDOMCATTTOR", currencies: ["CAD", "USD"], region: "Americas" },
  { key: "scotiabank", name: "Scotiabank", country: "Canada", countryCode: "CA", bic: "NOSCCATT", currencies: ["CAD", "USD", "EUR"], region: "Americas" },
  { key: "bmo", name: "Bank of Montreal", country: "Canada", countryCode: "CA", bic: "BOFMCAM2", currencies: ["CAD", "USD"], region: "Americas" },
  { key: "cibc", name: "CIBC", country: "Canada", countryCode: "CA", bic: "CIBCCATT", currencies: ["CAD", "USD"], region: "Americas" },
  { key: "itau", name: "Itaú Unibanco", country: "Brazil", countryCode: "BR", bic: "ITAUBRSP", currencies: ["BRL", "USD", "EUR"], region: "Americas" },
  { key: "bradesco", name: "Banco Bradesco", country: "Brazil", countryCode: "BR", bic: "BBDEBRSP", currencies: ["BRL", "USD"], region: "Americas" },
  { key: "bancodobrasil", name: "Banco do Brasil", country: "Brazil", countryCode: "BR", bic: "BRASBRRJ", currencies: ["BRL", "USD", "EUR"], region: "Americas" },
  { key: "bancomer", name: "BBVA México", country: "Mexico", countryCode: "MX", bic: "BCMRMXMM", currencies: ["MXN", "USD"], region: "Americas" },
  { key: "banorte", name: "Banorte", country: "Mexico", countryCode: "MX", bic: "MENOMXMT", currencies: ["MXN", "USD"], region: "Americas" },
  { key: "citibanamex", name: "Citibanamex", country: "Mexico", countryCode: "MX", bic: "BNMXMXMM", currencies: ["MXN", "USD"], region: "Americas" },
  // --- Latin America (Andean, Southern Cone & Central America) ---
  { key: "bancodevenezuela", name: "Banco de Venezuela", country: "Venezuela", countryCode: "VE", bic: "BDVEVECA", currencies: ["VES", "USD", "EUR"], region: "Americas" },
  { key: "banesco", name: "Banesco", country: "Venezuela", countryCode: "VE", bic: "BANCVECA", currencies: ["VES", "USD"], region: "Americas" },
  { key: "mercantil", name: "Banco Mercantil", country: "Venezuela", countryCode: "VE", bic: "BAMRVECA", currencies: ["VES", "USD"], region: "Americas" },
  { key: "provincial", name: "BBVA Provincial", country: "Venezuela", countryCode: "VE", bic: "PROVVECA", currencies: ["VES", "USD"], region: "Americas" },
  { key: "bancodechile", name: "Banco de Chile", country: "Chile", countryCode: "CL", bic: "BCHICLRM", currencies: ["CLP", "USD", "EUR"], region: "Americas" },
  { key: "bancoestado", name: "BancoEstado", country: "Chile", countryCode: "CL", bic: "BECHCLRM", currencies: ["CLP", "USD"], region: "Americas" },
  { key: "santanderchile", name: "Banco Santander Chile", country: "Chile", countryCode: "CL", bic: "BSCHCLRM", currencies: ["CLP", "USD", "EUR"], region: "Americas" },
  { key: "bancolombia", name: "Bancolombia", country: "Colombia", countryCode: "CO", bic: "COLOCOBM", currencies: ["COP", "USD"], region: "Americas" },
  { key: "bancodebogota", name: "Banco de Bogotá", country: "Colombia", countryCode: "CO", bic: "BBOGCOBB", currencies: ["COP", "USD"], region: "Americas" },
  { key: "davivienda", name: "Davivienda", country: "Colombia", countryCode: "CO", bic: "CAFECOBB", currencies: ["COP", "USD"], region: "Americas" },
  { key: "bcp", name: "Banco de Crédito del Perú", country: "Peru", countryCode: "PE", bic: "BCPLPEPL", currencies: ["PEN", "USD"], region: "Americas" },
  { key: "bbvaperu", name: "BBVA Perú", country: "Peru", countryCode: "PE", bic: "BCONPEPL", currencies: ["PEN", "USD"], region: "Americas" },
  { key: "pichincha", name: "Banco Pichincha", country: "Ecuador", countryCode: "EC", bic: "PICHECEQ", currencies: ["USD"], region: "Americas" },
  { key: "nacionargentina", name: "Banco de la Nación Argentina", country: "Argentina", countryCode: "AR", bic: "NANMARBA", currencies: ["ARS", "USD"], region: "Americas" },
  { key: "bancomacro", name: "Banco Macro", country: "Argentina", countryCode: "AR", bic: "BSUDARBA", currencies: ["ARS", "USD"], region: "Americas" },
  { key: "bnp_panama", name: "Banco Nacional de Panamá", country: "Panama", countryCode: "PA", bic: "BNPAPAPA", currencies: ["USD"], region: "Americas" },
  { key: "bncr", name: "Banco Nacional de Costa Rica", country: "Costa Rica", countryCode: "CR", bic: "BNCRCRSJ", currencies: ["CRC", "USD"], region: "Americas" },

  // --- Asia-Pacific ---
  { key: "icbc", name: "ICBC", country: "China", countryCode: "CN", bic: "ICBKCNBJ", currencies: ["CNY", "USD", "HKD", "EUR"], region: "Asia-Pacific" },
  { key: "ccb", name: "China Construction Bank", country: "China", countryCode: "CN", bic: "PCBCCNBJ", currencies: ["CNY", "USD", "HKD"], region: "Asia-Pacific" },
  { key: "abchina", name: "Agricultural Bank of China", country: "China", countryCode: "CN", bic: "ABOCCNBJ", currencies: ["CNY", "USD"], region: "Asia-Pacific" },
  { key: "boc", name: "Bank of China", country: "China", countryCode: "CN", bic: "BKCHCNBJ", currencies: ["CNY", "USD", "HKD", "EUR", "GBP"], region: "Asia-Pacific" },
  { key: "bankofcomm", name: "Bank of Communications", country: "China", countryCode: "CN", bic: "COMMCNSH", currencies: ["CNY", "USD", "HKD"], region: "Asia-Pacific" },
  { key: "cmb", name: "China Merchants Bank", country: "China", countryCode: "CN", bic: "CMBCCNBS", currencies: ["CNY", "USD", "HKD"], region: "Asia-Pacific" },
  { key: "mufg", name: "MUFG Bank", country: "Japan", countryCode: "JP", bic: "BOTKJPJT", currencies: ["JPY", "USD", "EUR", "GBP"], region: "Asia-Pacific" },
  { key: "smbc", name: "Sumitomo Mitsui Banking Corp.", country: "Japan", countryCode: "JP", bic: "SMBCJPJT", currencies: ["JPY", "USD", "EUR"], region: "Asia-Pacific" },
  { key: "mizuho", name: "Mizuho Bank", country: "Japan", countryCode: "JP", bic: "MHCBJPJT", currencies: ["JPY", "USD", "EUR"], region: "Asia-Pacific" },
  { key: "japanpost", name: "Japan Post Bank", country: "Japan", countryCode: "JP", bic: "JPPSJPJ1", currencies: ["JPY"], region: "Asia-Pacific" },
  { key: "dbs", name: "DBS Bank", country: "Singapore", countryCode: "SG", bic: "DBSSSGSG", currencies: ["SGD", "USD", "HKD", "EUR"], region: "Asia-Pacific" },
  { key: "ocbc", name: "OCBC Bank", country: "Singapore", countryCode: "SG", bic: "OCBCSGSG", currencies: ["SGD", "USD", "HKD"], region: "Asia-Pacific" },
  { key: "uob", name: "United Overseas Bank", country: "Singapore", countryCode: "SG", bic: "UOVBSGSG", currencies: ["SGD", "USD"], region: "Asia-Pacific" },
  { key: "hangseng", name: "Hang Seng Bank", country: "Hong Kong", countryCode: "HK", bic: "HASEHKHH", currencies: ["HKD", "USD", "CNY"], region: "Asia-Pacific" },
  { key: "bochk", name: "Bank of China (Hong Kong)", country: "Hong Kong", countryCode: "HK", bic: "BKCHHKHH", currencies: ["HKD", "USD", "CNY"], region: "Asia-Pacific" },
  { key: "sbi", name: "State Bank of India", country: "India", countryCode: "IN", bic: "SBININBB", currencies: ["INR", "USD", "GBP", "AED"], region: "Asia-Pacific" },
  { key: "hdfc", name: "HDFC Bank", country: "India", countryCode: "IN", bic: "HDFCINBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },
  { key: "icici", name: "ICICI Bank", country: "India", countryCode: "IN", bic: "ICICINBB", currencies: ["INR", "USD", "GBP"], region: "Asia-Pacific" },
  { key: "axis", name: "Axis Bank", country: "India", countryCode: "IN", bic: "AXISINBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },
  { key: "commbank", name: "Commonwealth Bank", country: "Australia", countryCode: "AU", bic: "CTBAAU2S", currencies: ["AUD", "USD", "NZD"], region: "Asia-Pacific" },
  { key: "westpac", name: "Westpac", country: "Australia", countryCode: "AU", bic: "WPACAU2S", currencies: ["AUD", "USD", "NZD"], region: "Asia-Pacific" },
  { key: "anz", name: "ANZ", country: "Australia", countryCode: "AU", bic: "ANZBAU3M", currencies: ["AUD", "USD", "NZD", "SGD"], region: "Asia-Pacific" },
  { key: "nab", name: "National Australia Bank", country: "Australia", countryCode: "AU", bic: "NATAAU33", currencies: ["AUD", "USD"], region: "Asia-Pacific" },
  { key: "kbkookmin", name: "KB Kookmin Bank", country: "South Korea", countryCode: "KR", bic: "CZNBKRSE", currencies: ["KRW", "USD"], region: "Asia-Pacific" },
  { key: "shinhan", name: "Shinhan Bank", country: "South Korea", countryCode: "KR", bic: "SHBKKRSE", currencies: ["KRW", "USD", "EUR"], region: "Asia-Pacific" },
  { key: "maybank", name: "Maybank", country: "Malaysia", countryCode: "MY", bic: "MBBEMYKL", currencies: ["MYR", "USD", "SGD"], region: "Asia-Pacific" },

  // --- Middle East & Africa ---
  { key: "qnb", name: "Qatar National Bank", country: "Qatar", countryCode: "QA", bic: "QNBAQAQA", currencies: ["QAR", "USD", "EUR", "GBP"], region: "Middle East & Africa" },
  { key: "fab", name: "First Abu Dhabi Bank", country: "United Arab Emirates", countryCode: "AE", bic: "NBADAEAA", currencies: ["AED", "USD", "EUR", "GBP"], region: "Middle East & Africa", nationalBankCode: "035" },
  { key: "emiratesnbd", name: "Emirates NBD", country: "United Arab Emirates", countryCode: "AE", bic: "EBILAEAD", currencies: ["AED", "USD", "EUR"], region: "Middle East & Africa", nationalBankCode: "033" },
  { key: "adcb", name: "Abu Dhabi Commercial Bank", country: "United Arab Emirates", countryCode: "AE", bic: "ADCBAEAA", currencies: ["AED", "USD"], region: "Middle East & Africa", nationalBankCode: "030" },
  { key: "alrajhi", name: "Al Rajhi Bank", country: "Saudi Arabia", countryCode: "SA", bic: "RJHISARI", currencies: ["SAR", "USD"], region: "Middle East & Africa", nationalBankCode: "80" },
  { key: "snb", name: "Saudi National Bank", country: "Saudi Arabia", countryCode: "SA", bic: "NCBKSAJE", currencies: ["SAR", "USD", "EUR"], region: "Middle East & Africa", nationalBankCode: "10" },
  { key: "standardbank", name: "Standard Bank", country: "South Africa", countryCode: "ZA", bic: "SBZAZAJJ", currencies: ["ZAR", "USD", "EUR", "GBP"], region: "Middle East & Africa" },
  { key: "fnb", name: "First National Bank", country: "South Africa", countryCode: "ZA", bic: "FIRNZAJJ", currencies: ["ZAR", "USD"], region: "Middle East & Africa" },
  { key: "absa", name: "Absa Group", country: "South Africa", countryCode: "ZA", bic: "ABSAZAJJ", currencies: ["ZAR", "USD"], region: "Middle East & Africa" },

  // ===========================================================================
  // Extended global directory — real, published BIC/SWIFT codes. Institution
  // level (a bank's branches share its BIC; the branch is encoded in the
  // account/IBAN portion, not as a separate entry). Countries added here that
  // have an IBAN structure (see lib/iban.ts IBAN_SPECS) issue a generated IBAN;
  // the rest settle on domestic coordinates + the real BIC.
  // ===========================================================================

  // --- United States (additional) ---
  { key: "amex", name: "American Express Bank", country: "United States", countryCode: "US", bic: "AEIBUS33", currencies: ["USD", "EUR"], region: "Americas" },
  { key: "fifththird", name: "Fifth Third Bank", country: "United States", countryCode: "US", bic: "FTBCUS3C", currencies: ["USD"], region: "Americas" },
  { key: "citizens", name: "Citizens Bank", country: "United States", countryCode: "US", bic: "CTZIUS33", currencies: ["USD"], region: "Americas" },
  { key: "keybank", name: "KeyBank", country: "United States", countryCode: "US", bic: "KEYBUS33", currencies: ["USD"], region: "Americas" },
  { key: "regions", name: "Regions Bank", country: "United States", countryCode: "US", bic: "UPNBUS44", currencies: ["USD"], region: "Americas" },
  { key: "mtbank", name: "M&T Bank", country: "United States", countryCode: "US", bic: "MANTUS33", currencies: ["USD"], region: "Americas" },
  { key: "huntington", name: "Huntington National Bank", country: "United States", countryCode: "US", bic: "HUNTUS33", currencies: ["USD"], region: "Americas" },
  { key: "ally", name: "Ally Bank", country: "United States", countryCode: "US", bic: "ALLYUS3M", currencies: ["USD"], region: "Americas" },
  { key: "northerntrust", name: "Northern Trust", country: "United States", countryCode: "US", bic: "CNORUS44", currencies: ["USD", "EUR", "GBP"], region: "Americas" },

  // --- Canada (additional) ---
  { key: "nbc", name: "National Bank of Canada", country: "Canada", countryCode: "CA", bic: "BNDCCAMM", currencies: ["CAD", "USD"], region: "Americas" },
  { key: "desjardins", name: "Desjardins Group", country: "Canada", countryCode: "CA", bic: "CCDQCAMM", currencies: ["CAD", "USD"], region: "Americas" },
  { key: "laurentian", name: "Laurentian Bank of Canada", country: "Canada", countryCode: "CA", bic: "BLCMCAMM", currencies: ["CAD", "USD"], region: "Americas" },

  // --- Brazil / Mexico (additional) ---
  { key: "caixaef", name: "Caixa Econômica Federal", country: "Brazil", countryCode: "BR", bic: "CEFXBRSP", currencies: ["BRL", "USD"], region: "Americas" },
  { key: "santanderbr", name: "Santander Brasil", country: "Brazil", countryCode: "BR", bic: "BSCHBRSP", currencies: ["BRL", "USD", "EUR"], region: "Americas" },
  { key: "btgpactual", name: "BTG Pactual", country: "Brazil", countryCode: "BR", bic: "BPABBRSP", currencies: ["BRL", "USD"], region: "Americas" },
  { key: "santandermx", name: "Santander México", country: "Mexico", countryCode: "MX", bic: "BMSXMXMM", currencies: ["MXN", "USD"], region: "Americas" },
  { key: "hsbcmx", name: "HSBC México", country: "Mexico", countryCode: "MX", bic: "BIMEMXMM", currencies: ["MXN", "USD"], region: "Americas" },

  // --- New Zealand ---
  { key: "anznz", name: "ANZ New Zealand", country: "New Zealand", countryCode: "NZ", bic: "ANZBNZ22", currencies: ["NZD", "AUD", "USD"], region: "Asia-Pacific" },
  { key: "asb", name: "ASB Bank", country: "New Zealand", countryCode: "NZ", bic: "ASBBNZ2A", currencies: ["NZD", "USD"], region: "Asia-Pacific" },
  { key: "bnz", name: "Bank of New Zealand", country: "New Zealand", countryCode: "NZ", bic: "BKNZNZ22", currencies: ["NZD", "USD"], region: "Asia-Pacific" },
  { key: "kiwibank", name: "Kiwibank", country: "New Zealand", countryCode: "NZ", bic: "KIWINZ22", currencies: ["NZD"], region: "Asia-Pacific" },

  // --- Australia (additional) ---
  { key: "macquarie", name: "Macquarie Bank", country: "Australia", countryCode: "AU", bic: "MACQAU2S", currencies: ["AUD", "USD"], region: "Asia-Pacific" },
  { key: "boq", name: "Bank of Queensland", country: "Australia", countryCode: "AU", bic: "QBANAU4B", currencies: ["AUD"], region: "Asia-Pacific" },
  { key: "bendigo", name: "Bendigo and Adelaide Bank", country: "Australia", countryCode: "AU", bic: "BENDAU3B", currencies: ["AUD"], region: "Asia-Pacific" },

  // --- China (additional) ---
  { key: "psbc", name: "Postal Savings Bank of China", country: "China", countryCode: "CN", bic: "PSBCCNBJ", currencies: ["CNY", "USD"], region: "Asia-Pacific" },
  { key: "citic", name: "China CITIC Bank", country: "China", countryCode: "CN", bic: "CIBKCNBJ", currencies: ["CNY", "USD", "HKD"], region: "Asia-Pacific" },
  { key: "cebbank", name: "China Everbright Bank", country: "China", countryCode: "CN", bic: "EVERCNBJ", currencies: ["CNY", "USD"], region: "Asia-Pacific" },
  { key: "spdb", name: "Shanghai Pudong Development Bank", country: "China", countryCode: "CN", bic: "SPDBCNSH", currencies: ["CNY", "USD"], region: "Asia-Pacific" },
  { key: "minsheng", name: "China Minsheng Bank", country: "China", countryCode: "CN", bic: "MSBCCNBJ", currencies: ["CNY", "USD"], region: "Asia-Pacific" },

  // --- India (additional) ---
  { key: "bob", name: "Bank of Baroda", country: "India", countryCode: "IN", bic: "BARBINBB", currencies: ["INR", "USD", "GBP", "AED"], region: "Asia-Pacific" },
  { key: "pnb", name: "Punjab National Bank", country: "India", countryCode: "IN", bic: "PUNBINBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },
  { key: "canara", name: "Canara Bank", country: "India", countryCode: "IN", bic: "CNRBINBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },
  { key: "kotak", name: "Kotak Mahindra Bank", country: "India", countryCode: "IN", bic: "KKBKINBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },
  { key: "unionbankin", name: "Union Bank of India", country: "India", countryCode: "IN", bic: "UBININBB", currencies: ["INR", "USD"], region: "Asia-Pacific" },

  // --- Singapore / Hong Kong (additional) ---
  { key: "maybanksg", name: "Maybank Singapore", country: "Singapore", countryCode: "SG", bic: "MBBESGS2", currencies: ["SGD", "USD"], region: "Asia-Pacific" },
  { key: "scbhk", name: "Standard Chartered (Hong Kong)", country: "Hong Kong", countryCode: "HK", bic: "SCBLHKHH", currencies: ["HKD", "USD", "CNY", "GBP"], region: "Asia-Pacific" },
  { key: "hsbchk", name: "HSBC (Hong Kong)", country: "Hong Kong", countryCode: "HK", bic: "HSBCHKHH", currencies: ["HKD", "USD", "CNY", "EUR"], region: "Asia-Pacific" },
  { key: "bea", name: "Bank of East Asia", country: "Hong Kong", countryCode: "HK", bic: "BEASHKHH", currencies: ["HKD", "USD", "CNY"], region: "Asia-Pacific" },

  // --- South Korea (additional) ---
  { key: "woori", name: "Woori Bank", country: "South Korea", countryCode: "KR", bic: "HVBKKRSE", currencies: ["KRW", "USD"], region: "Asia-Pacific" },
  { key: "hana", name: "Hana Bank", country: "South Korea", countryCode: "KR", bic: "KOEXKRSE", currencies: ["KRW", "USD", "EUR"], region: "Asia-Pacific" },
  { key: "ibk", name: "Industrial Bank of Korea", country: "South Korea", countryCode: "KR", bic: "IBKOKRSE", currencies: ["KRW", "USD"], region: "Asia-Pacific" },

  // --- Malaysia (additional) ---
  { key: "cimb", name: "CIMB Bank", country: "Malaysia", countryCode: "MY", bic: "CIBBMYKL", currencies: ["MYR", "USD", "SGD"], region: "Asia-Pacific" },
  { key: "publicbank", name: "Public Bank Berhad", country: "Malaysia", countryCode: "MY", bic: "PBBEMYKL", currencies: ["MYR", "USD"], region: "Asia-Pacific" },
  { key: "rhb", name: "RHB Bank", country: "Malaysia", countryCode: "MY", bic: "RHBBMYKL", currencies: ["MYR", "USD"], region: "Asia-Pacific" },

  // --- Thailand ---
  { key: "bangkokbank", name: "Bangkok Bank", country: "Thailand", countryCode: "TH", bic: "BKKBTHBK", currencies: ["THB", "USD"], region: "Asia-Pacific" },
  { key: "kasikorn", name: "Kasikornbank", country: "Thailand", countryCode: "TH", bic: "KASITHBK", currencies: ["THB", "USD"], region: "Asia-Pacific" },
  { key: "scbthai", name: "Siam Commercial Bank", country: "Thailand", countryCode: "TH", bic: "SICOTHBK", currencies: ["THB", "USD"], region: "Asia-Pacific" },
  { key: "krungthai", name: "Krung Thai Bank", country: "Thailand", countryCode: "TH", bic: "KRTHTHBK", currencies: ["THB", "USD"], region: "Asia-Pacific" },

  // --- Indonesia ---
  { key: "mandiri", name: "Bank Mandiri", country: "Indonesia", countryCode: "ID", bic: "BMRIIDJA", currencies: ["IDR", "USD"], region: "Asia-Pacific" },
  { key: "bri", name: "Bank Rakyat Indonesia", country: "Indonesia", countryCode: "ID", bic: "BRINIDJA", currencies: ["IDR", "USD"], region: "Asia-Pacific" },
  { key: "bca", name: "Bank Central Asia", country: "Indonesia", countryCode: "ID", bic: "CENAIDJA", currencies: ["IDR", "USD"], region: "Asia-Pacific" },
  { key: "bni", name: "Bank Negara Indonesia", country: "Indonesia", countryCode: "ID", bic: "BNINIDJA", currencies: ["IDR", "USD"], region: "Asia-Pacific" },

  // --- Philippines ---
  { key: "bdo", name: "BDO Unibank", country: "Philippines", countryCode: "PH", bic: "BNORPHMM", currencies: ["PHP", "USD"], region: "Asia-Pacific" },
  { key: "metrobank", name: "Metrobank", country: "Philippines", countryCode: "PH", bic: "MBTCPHMM", currencies: ["PHP", "USD"], region: "Asia-Pacific" },
  { key: "bpi", name: "Bank of the Philippine Islands", country: "Philippines", countryCode: "PH", bic: "BOPIPHMM", currencies: ["PHP", "USD"], region: "Asia-Pacific" },

  // --- Vietnam ---
  { key: "vietcombank", name: "Vietcombank", country: "Vietnam", countryCode: "VN", bic: "BFTVVNVX", currencies: ["VND", "USD"], region: "Asia-Pacific" },
  { key: "bidv", name: "BIDV", country: "Vietnam", countryCode: "VN", bic: "BIDVVNVX", currencies: ["VND", "USD"], region: "Asia-Pacific" },
  { key: "vietinbank", name: "VietinBank", country: "Vietnam", countryCode: "VN", bic: "ICBVVNVX", currencies: ["VND", "USD"], region: "Asia-Pacific" },

  // --- Taiwan ---
  { key: "bankoftaiwan", name: "Bank of Taiwan", country: "Taiwan", countryCode: "TW", bic: "BKTWTWTP", currencies: ["TWD", "USD"], region: "Asia-Pacific" },
  { key: "ctbc", name: "CTBC Bank", country: "Taiwan", countryCode: "TW", bic: "CTCBTWTP", currencies: ["TWD", "USD"], region: "Asia-Pacific" },
  { key: "cathayunited", name: "Cathay United Bank", country: "Taiwan", countryCode: "TW", bic: "UWCBTWTP", currencies: ["TWD", "USD"], region: "Asia-Pacific" },

  // --- Poland ---
  { key: "pkobp", name: "PKO Bank Polski", country: "Poland", countryCode: "PL", bic: "BPKOPLPW", currencies: ["PLN", "EUR", "USD"], region: "Europe" },
  { key: "pekao", name: "Bank Pekao", country: "Poland", countryCode: "PL", bic: "PKOPPLPW", currencies: ["PLN", "EUR", "USD"], region: "Europe" },
  { key: "santanderpl", name: "Santander Bank Polska", country: "Poland", countryCode: "PL", bic: "WBKPPLPP", currencies: ["PLN", "EUR"], region: "Europe" },
  { key: "mbank", name: "mBank", country: "Poland", countryCode: "PL", bic: "BREXPLPW", currencies: ["PLN", "EUR"], region: "Europe" },
  { key: "ingpl", name: "ING Bank Śląski", country: "Poland", countryCode: "PL", bic: "INGBPLPW", currencies: ["PLN", "EUR"], region: "Europe" },

  // --- Czechia & Slovakia ---
  { key: "csas", name: "Česká spořitelna", country: "Czechia", countryCode: "CZ", bic: "GIBACZPX", currencies: ["CZK", "EUR"], region: "Europe" },
  { key: "csob", name: "ČSOB", country: "Czechia", countryCode: "CZ", bic: "CEKOCZPP", currencies: ["CZK", "EUR"], region: "Europe" },
  { key: "kbcz", name: "Komerční banka", country: "Czechia", countryCode: "CZ", bic: "KOMBCZPP", currencies: ["CZK", "EUR"], region: "Europe" },
  { key: "slsp", name: "Slovenská sporiteľňa", country: "Slovakia", countryCode: "SK", bic: "GIBASKBX", currencies: ["EUR"], region: "Europe" },
  { key: "vub", name: "VÚB banka", country: "Slovakia", countryCode: "SK", bic: "SUBASKBX", currencies: ["EUR"], region: "Europe" },
  { key: "tatrabanka", name: "Tatra banka", country: "Slovakia", countryCode: "SK", bic: "TATRSKBX", currencies: ["EUR", "USD"], region: "Europe" },

  // --- Hungary ---
  { key: "otp", name: "OTP Bank", country: "Hungary", countryCode: "HU", bic: "OTPVHUHB", currencies: ["HUF", "EUR", "USD"], region: "Europe" },
  { key: "khhu", name: "K&H Bank", country: "Hungary", countryCode: "HU", bic: "OKHBHUHB", currencies: ["HUF", "EUR"], region: "Europe" },
  { key: "erstehu", name: "Erste Bank Hungary", country: "Hungary", countryCode: "HU", bic: "GIBAHUHB", currencies: ["HUF", "EUR"], region: "Europe" },

  // --- Romania ---
  { key: "bancatransilvania", name: "Banca Transilvania", country: "Romania", countryCode: "RO", bic: "BTRLRO22", currencies: ["RON", "EUR", "USD"], region: "Europe" },
  { key: "bcr", name: "Banca Comercială Română", country: "Romania", countryCode: "RO", bic: "RNCBROBU", currencies: ["RON", "EUR"], region: "Europe" },
  { key: "brd", name: "BRD - Groupe Société Générale", country: "Romania", countryCode: "RO", bic: "BRDEROBU", currencies: ["RON", "EUR"], region: "Europe" },

  // --- Croatia & Slovenia ---
  { key: "zaba", name: "Zagrebačka banka", country: "Croatia", countryCode: "HR", bic: "ZABAHR2X", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "pbz", name: "Privredna banka Zagreb", country: "Croatia", countryCode: "HR", bic: "PBZGHR2X", currencies: ["EUR"], region: "Europe" },
  { key: "nlb", name: "Nova Ljubljanska banka", country: "Slovenia", countryCode: "SI", bic: "LJBASI2X", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "nkbm", name: "Nova KBM", country: "Slovenia", countryCode: "SI", bic: "KBMASI2X", currencies: ["EUR"], region: "Europe" },

  // --- Bulgaria ---
  { key: "unicreditbg", name: "UniCredit Bulbank", country: "Bulgaria", countryCode: "BG", bic: "UNCRBGSF", currencies: ["BGN", "EUR", "USD"], region: "Europe" },
  { key: "dskbank", name: "DSK Bank", country: "Bulgaria", countryCode: "BG", bic: "STSABGSF", currencies: ["BGN", "EUR"], region: "Europe" },
  { key: "ubbbg", name: "United Bulgarian Bank", country: "Bulgaria", countryCode: "BG", bic: "UBBSBGSF", currencies: ["BGN", "EUR"], region: "Europe" },

  // --- Baltics ---
  { key: "swedbanklt", name: "Swedbank Lietuva", country: "Lithuania", countryCode: "LT", bic: "HABALT22", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "sebalt", name: "SEB Lithuania", country: "Lithuania", countryCode: "LT", bic: "CBVILT2X", currencies: ["EUR"], region: "Europe" },
  { key: "swedbanklv", name: "Swedbank Latvija", country: "Latvia", countryCode: "LV", bic: "HABALV22", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "citadele", name: "Citadele banka", country: "Latvia", countryCode: "LV", bic: "PARXLV22", currencies: ["EUR"], region: "Europe" },
  { key: "swedbankee", name: "Swedbank Eesti", country: "Estonia", countryCode: "EE", bic: "HABAEE2X", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "lhv", name: "LHV Pank", country: "Estonia", countryCode: "EE", bic: "LHVBEE22", currencies: ["EUR"], region: "Europe" },

  // --- Greece & Cyprus ---
  { key: "nbg", name: "National Bank of Greece", country: "Greece", countryCode: "GR", bic: "ETHNGRAA", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "alphabank", name: "Alpha Bank", country: "Greece", countryCode: "GR", bic: "CRBAGRAA", currencies: ["EUR", "USD"], region: "Europe" },
  { key: "eurobank", name: "Eurobank", country: "Greece", countryCode: "GR", bic: "ERBKGRAA", currencies: ["EUR"], region: "Europe" },
  { key: "piraeus", name: "Piraeus Bank", country: "Greece", countryCode: "GR", bic: "PIRBGRAA", currencies: ["EUR"], region: "Europe" },
  { key: "bankofcyprus", name: "Bank of Cyprus", country: "Cyprus", countryCode: "CY", bic: "BCYPCY2N", currencies: ["EUR", "USD", "GBP"], region: "Europe" },
  { key: "hellenicbank", name: "Hellenic Bank", country: "Cyprus", countryCode: "CY", bic: "HEBACY2N", currencies: ["EUR", "USD"], region: "Europe" },

  // --- Malta, Iceland, Liechtenstein ---
  { key: "bov", name: "Bank of Valletta", country: "Malta", countryCode: "MT", bic: "VALLMTMT", currencies: ["EUR", "USD", "GBP"], region: "Europe" },
  { key: "landsbankinn", name: "Landsbankinn", country: "Iceland", countryCode: "IS", bic: "NBIIISRE", currencies: ["ISK", "EUR", "USD"], region: "Europe" },
  { key: "islandsbanki", name: "Íslandsbanki", country: "Iceland", countryCode: "IS", bic: "GLITISRE", currencies: ["ISK", "EUR"], region: "Europe" },
  { key: "lgt", name: "LGT Bank", country: "Liechtenstein", countryCode: "LI", bic: "BLFLLI2X", currencies: ["CHF", "EUR", "USD"], region: "Europe" },
  { key: "llb", name: "Liechtensteinische Landesbank", country: "Liechtenstein", countryCode: "LI", bic: "LILALI2X", currencies: ["CHF", "EUR", "USD"], region: "Europe" },
  { key: "vpbank", name: "VP Bank", country: "Liechtenstein", countryCode: "LI", bic: "VPBVLI2X", currencies: ["CHF", "EUR", "USD"], region: "Europe" },

  // --- Turkey & Ukraine ---
  { key: "isbank", name: "İşbank", country: "Turkey", countryCode: "TR", bic: "ISBKTRIS", currencies: ["TRY", "USD", "EUR"], region: "Europe" },
  { key: "garanti", name: "Garanti BBVA", country: "Turkey", countryCode: "TR", bic: "TGBATRIS", currencies: ["TRY", "USD", "EUR"], region: "Europe" },
  { key: "akbank", name: "Akbank", country: "Turkey", countryCode: "TR", bic: "AKBKTRIS", currencies: ["TRY", "USD", "EUR"], region: "Europe" },
  { key: "ziraat", name: "Ziraat Bankası", country: "Turkey", countryCode: "TR", bic: "TCZBTR2A", currencies: ["TRY", "USD", "EUR"], region: "Europe" },
  { key: "privatbank", name: "PrivatBank", country: "Ukraine", countryCode: "UA", bic: "PBANUA2X", currencies: ["UAH", "USD", "EUR"], region: "Europe" },
  { key: "oschadbank", name: "Oschadbank", country: "Ukraine", countryCode: "UA", bic: "COSBUAUK", currencies: ["UAH", "USD"], region: "Europe" },

  // --- Israel ---
  { key: "hapoalim", name: "Bank Hapoalim", country: "Israel", countryCode: "IL", bic: "POALILIT", currencies: ["ILS", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "leumi", name: "Bank Leumi", country: "Israel", countryCode: "IL", bic: "LUMIILIT", currencies: ["ILS", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "discountil", name: "Israel Discount Bank", country: "Israel", countryCode: "IL", bic: "IDBLILIT", currencies: ["ILS", "USD"], region: "Middle East & Africa" },
  { key: "mizrahi", name: "Mizrahi Tefahot Bank", country: "Israel", countryCode: "IL", bic: "MIZBILIT", currencies: ["ILS", "USD"], region: "Middle East & Africa" },

  // --- Gulf & Levant (additional IBAN jurisdictions) ---
  { key: "ahliunited", name: "Ahli United Bank", country: "Bahrain", countryCode: "BH", bic: "AUBBBHBM", currencies: ["BHD", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "nbbahrain", name: "National Bank of Bahrain", country: "Bahrain", countryCode: "BH", bic: "NBOBBHBM", currencies: ["BHD", "USD"], region: "Middle East & Africa" },
  { key: "gib", name: "Gulf International Bank", country: "Bahrain", countryCode: "BH", bic: "GULFBHBM", currencies: ["BHD", "USD", "SAR"], region: "Middle East & Africa" },
  { key: "nbk", name: "National Bank of Kuwait", country: "Kuwait", countryCode: "KW", bic: "NBOKKWKW", currencies: ["KWD", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "kfh", name: "Kuwait Finance House", country: "Kuwait", countryCode: "KW", bic: "KFHOKWKW", currencies: ["KWD", "USD"], region: "Middle East & Africa" },
  { key: "gulfbank", name: "Gulf Bank", country: "Kuwait", countryCode: "KW", bic: "GULBKWKW", currencies: ["KWD", "USD"], region: "Middle East & Africa" },
  { key: "arabbank", name: "Arab Bank", country: "Jordan", countryCode: "JO", bic: "ARABJOAX", currencies: ["JOD", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "housingbank", name: "Housing Bank for Trade and Finance", country: "Jordan", countryCode: "JO", bic: "HBHOJOAX", currencies: ["JOD", "USD"], region: "Middle East & Africa" },
  { key: "bankaudi", name: "Bank Audi", country: "Lebanon", countryCode: "LB", bic: "AUDBLBBX", currencies: ["LBP", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "blom", name: "BLOM Bank", country: "Lebanon", countryCode: "LB", bic: "BLOMLBBX", currencies: ["LBP", "USD"], region: "Middle East & Africa" },
  { key: "nbe", name: "National Bank of Egypt", country: "Egypt", countryCode: "EG", bic: "NBEGEGCX", currencies: ["EGP", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "banquemisr", name: "Banque Misr", country: "Egypt", countryCode: "EG", bic: "BMISEGCX", currencies: ["EGP", "USD"], region: "Middle East & Africa" },
  { key: "cib", name: "Commercial International Bank", country: "Egypt", countryCode: "EG", bic: "CIBEEGCX", currencies: ["EGP", "USD", "EUR"], region: "Middle East & Africa" },

  // --- Gulf (additional, existing IBAN jurisdictions) ---
  { key: "qib", name: "Qatar Islamic Bank", country: "Qatar", countryCode: "QA", bic: "QISBQAQA", currencies: ["QAR", "USD"], region: "Middle East & Africa" },
  { key: "cbq", name: "Commercial Bank of Qatar", country: "Qatar", countryCode: "QA", bic: "CBQAQAQA", currencies: ["QAR", "USD", "EUR"], region: "Middle East & Africa" },
  { key: "dib", name: "Dubai Islamic Bank", country: "United Arab Emirates", countryCode: "AE", bic: "DUIBAEAD", currencies: ["AED", "USD"], region: "Middle East & Africa", nationalBankCode: "042" },
  { key: "mashreq", name: "Mashreq Bank", country: "United Arab Emirates", countryCode: "AE", bic: "BOMLAEAD", currencies: ["AED", "USD", "EUR"], region: "Middle East & Africa", nationalBankCode: "033" },
  { key: "rakbank", name: "RAKBANK", country: "United Arab Emirates", countryCode: "AE", bic: "NRAKAEAK", currencies: ["AED", "USD"], region: "Middle East & Africa", nationalBankCode: "052" },
  { key: "riyadbank", name: "Riyad Bank", country: "Saudi Arabia", countryCode: "SA", bic: "RIBLSARI", currencies: ["SAR", "USD"], region: "Middle East & Africa", nationalBankCode: "20" },
  { key: "bsf", name: "Banque Saudi Fransi", country: "Saudi Arabia", countryCode: "SA", bic: "BSFRSARI", currencies: ["SAR", "USD", "EUR"], region: "Middle East & Africa", nationalBankCode: "55" },
  { key: "alinma", name: "Alinma Bank", country: "Saudi Arabia", countryCode: "SA", bic: "INMASARI", currencies: ["SAR", "USD"], region: "Middle East & Africa", nationalBankCode: "05" },

  // --- Africa (additional) ---
  { key: "nedbank", name: "Nedbank", country: "South Africa", countryCode: "ZA", bic: "NEDSZAJJ", currencies: ["ZAR", "USD"], region: "Middle East & Africa" },
  { key: "investec", name: "Investec Bank", country: "South Africa", countryCode: "ZA", bic: "IVESZAJJ", currencies: ["ZAR", "USD", "GBP"], region: "Middle East & Africa" },
  { key: "zenith", name: "Zenith Bank", country: "Nigeria", countryCode: "NG", bic: "ZEIBNGLA", currencies: ["NGN", "USD"], region: "Middle East & Africa" },
  { key: "gtbank", name: "Guaranty Trust Bank", country: "Nigeria", countryCode: "NG", bic: "GTBINGLA", currencies: ["NGN", "USD", "GBP"], region: "Middle East & Africa" },
  { key: "accessbank", name: "Access Bank", country: "Nigeria", countryCode: "NG", bic: "ABNGNGLA", currencies: ["NGN", "USD"], region: "Middle East & Africa" },
  { key: "equitybank", name: "Equity Bank", country: "Kenya", countryCode: "KE", bic: "EQBLKENA", currencies: ["KES", "USD"], region: "Middle East & Africa" },
  { key: "kcb", name: "KCB Bank", country: "Kenya", countryCode: "KE", bic: "KCBLKENX", currencies: ["KES", "USD"], region: "Middle East & Africa" },
]

export function partnerBankByKey(key?: string): PartnerBank | undefined {
  return PARTNER_BANKS.find((b) => b.key === key)
}

/** Banks that can issue an account in the requested currency. */
export function banksForCurrency(currency: string): PartnerBank[] {
  return PARTNER_BANKS.filter((b) => b.currencies.includes(currency))
}

/** Does the bank support issuance in the requested currency / jurisdiction? */
export function bankSupportsCurrency(bankKey: string, currency: string): boolean {
  return !!partnerBankByKey(bankKey)?.currencies.includes(currency)
}

/** Suggested default partner bank for a currency (first bank that supports it). */
export function suggestedBankFor(currency: string): PartnerBank {
  return banksForCurrency(currency)[0] ?? PARTNER_BANKS[0]
}
