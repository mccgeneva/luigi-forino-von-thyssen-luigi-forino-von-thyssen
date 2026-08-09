// ---------------------------------------------------------------------------
// Canonical demo / showcase dataset (pure, server-safe).
//
// The demo account (user u3) is pre-populated with strong simulated performance
// data across every section of the platform: large multi-currency balances and
// transaction history, approved payments, active bank instruments, yield/PPP
// investments, beneficiaries, Download-of-Funds and DTC settlements, a
// commodity deal, an active leverage line and SKR receipts.
//
// This module contains ONLY pure data producers — no `window`, no localStorage,
// no server-only imports — so it can be consumed by the server seeding action
// (app/actions/demo-seed.ts) which writes the records into Neon, keyed by the
// demo user's id, exactly like any other client-authored data. The records are
// shaped to match each store's view-model so they round-trip through the
// `approval_requests.payload.record` convention the migrated stores read from.
// ---------------------------------------------------------------------------

import { generateUetr } from "@/lib/swift-gpi"
import { demoBeneficiaries } from "@/lib/demo-beneficiaries"
import { DEMO_USER_ID } from "@/lib/users"

export { demoBeneficiaries }

// ISO timestamp for `n` days before now.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}
// ISO yyyy-mm-dd for `n` days before now.
function dateAgo(n: number): string {
  return daysAgo(n).slice(0, 10)
}
// ISO yyyy-mm-dd for `n` days in the future.
function dateAhead(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// --- Ledger: large completed multi-currency balances + history -------------
export function ledgerEntries() {
  return [
    { id: "PPY8842170", direction: "credit", amount: 250_000_000, currency: "USD", status: "completed", date: daysAgo(96), counterparty: "BlackRock Institutional Trust", account: "0048871220", bank: "JPMorgan Chase, New York", reference: "MT103/UBO-SETTLE-9920", comment: "Institutional capital settlement", category: "Capital Inflow" },
    { id: "PPY8839004", direction: "credit", amount: 180_000_000, currency: "USD", status: "completed", date: daysAgo(74), counterparty: "US Treasury Note Redemption", account: "TSY-2027-A", bank: "Federal Reserve Bank", reference: "DTC/BOND-RDM-4471", comment: "Treasury note redemption proceeds", category: "Securities" },
    { id: "PPY8830551", direction: "credit", amount: 95_000_000, currency: "USD", status: "completed", date: daysAgo(18), counterparty: "MCC Oil & Gas Trade Desk", account: "0091824470", bank: "Citibank N.A.", reference: "TRADE-PROCEEDS-7781", comment: "Commodity trade proceeds", category: "Trade Income" },
    { id: "PPY8825119", direction: "debit", amount: 42_000_000, currency: "USD", status: "completed", date: daysAgo(22), counterparty: "Glencore International AG", account: "CH9300762011", bank: "UBS Switzerland AG", reference: "PAY-OUT-3320", comment: "Cargo prepayment", category: "Outgoing Payment" },

    { id: "PPY8820773", direction: "credit", amount: 320_000_000, currency: "EUR", status: "completed", date: daysAgo(88), counterparty: "Deutsche Bank Private Wealth", account: "DE89370400440532013000", bank: "Deutsche Bank AG, Frankfurt", reference: "MT103/EUR-INFLOW-2210", comment: "Mandate funding", category: "Capital Inflow" },
    { id: "PPY8814460", direction: "credit", amount: 140_000_000, currency: "EUR", status: "completed", date: daysAgo(12), counterparty: "Euroclear Bank SA", account: "ECLR-90021", bank: "Euroclear Bank, Brussels", reference: "DTC/EUR-SETTLE-8841", comment: "Securities settlement credit", category: "Securities" },
    { id: "PPY8809912", direction: "debit", amount: 55_000_000, currency: "EUR", status: "completed", date: daysAgo(15), counterparty: "Vitol SA", account: "CH5604835012345678009", bank: "Credit Suisse, Geneva", reference: "PAY-OUT-2299", comment: "Refined product purchase", category: "Outgoing Payment" },

    { id: "PPY8803341", direction: "credit", amount: 96_000_000, currency: "GBP", status: "completed", date: daysAgo(63), counterparty: "Barclays Investment Bank", account: "GB29NWBK60161331926819", bank: "Barclays Bank PLC, London", reference: "MT103/GBP-INFLOW-5510", comment: "Structured note proceeds", category: "Capital Inflow" },
    { id: "PPY8800218", direction: "credit", amount: 60_000_000, currency: "GBP", status: "completed", date: daysAgo(20), counterparty: "HSBC Global Banking", account: "GB94BARC10201530093459", bank: "HSBC UK Bank PLC", reference: "TRADE-PROCEEDS-6602", comment: "FX trade gains", category: "Trade Income" },
    { id: "PPY8796640", direction: "debit", amount: 18_000_000, currency: "GBP", status: "completed", date: daysAgo(9), counterparty: "Trafigura Group", account: "GB33BUKB20201555555555", bank: "Lloyds Bank, London", reference: "PAY-OUT-1180", comment: "Logistics settlement", category: "Outgoing Payment" },

    { id: "PPY8791007", direction: "credit", amount: 88_000_000, currency: "CHF", status: "completed", date: daysAgo(70), counterparty: "Banque Cantonale de Genève", account: "CH8000788000080803803", bank: "BCGE, Geneva", reference: "MT103/CHF-INFLOW-3301", comment: "Private mandate funding", category: "Capital Inflow" },
    { id: "PPY8788213", direction: "credit", amount: 40_000_000, currency: "CHF", status: "completed", date: daysAgo(28), counterparty: "Pictet & Cie", account: "CH5604835098765432001", bank: "Pictet, Geneva", reference: "YIELD-PAYOUT-4410", comment: "Yield programme distribution", category: "Yield Income" },
    { id: "PPY8784490", direction: "debit", amount: 12_000_000, currency: "CHF", status: "completed", date: daysAgo(4), counterparty: "MCC Petroli SA", account: "CH9300762011623852957", bank: "UBS Switzerland AG", reference: "PAY-OUT-0907", comment: "Intra-group allocation", category: "Outgoing Payment" },
  ]
}

// --- Payments: approved large transfers + one pending ----------------------
export function paymentRequests() {
  const mk = (amount: number, currency: string) => {
    const fee = Math.round(amount * 0.02)
    return { amount, fee, total: amount + fee, currency }
  }
  return [
    { id: "PAY-DEMO-0001", uetr: generateUetr(), beneficiary: "Glencore International AG", beneficiaryCountry: "Switzerland", iban: "CH9300762011623852957", swiftCode: "UBSWCHZH80A", reference: "Crude oil cargo prepayment", notes: "FOB Rotterdam — Q2 allocation", payeeSource: "Master Account", status: "approved", submittedAt: daysAgo(23), decidedAt: daysAgo(22), ...mk(42_000_000, "USD") },
    { id: "PAY-DEMO-0002", uetr: generateUetr(), beneficiary: "Vitol SA", beneficiaryCountry: "Switzerland", iban: "CH5604835012345678009", swiftCode: "CRESCHZZ80A", reference: "Refined product purchase", notes: "CIF Genoa delivery", payeeSource: "Master Account", status: "approved", submittedAt: daysAgo(16), decidedAt: daysAgo(15), ...mk(55_000_000, "EUR") },
    { id: "PAY-DEMO-0003", uetr: generateUetr(), beneficiary: "Trafigura Group", beneficiaryCountry: "United Kingdom", iban: "GB33BUKB20201555555555", swiftCode: "LOYDGB2L", reference: "Logistics & freight settlement", notes: "Charter party settlement", payeeSource: "Master Account", status: "approved", submittedAt: daysAgo(10), decidedAt: daysAgo(9), ...mk(18_000_000, "GBP") },
    { id: "PAY-DEMO-0004", uetr: generateUetr(), beneficiary: "Mercuria Energy Trading", beneficiaryCountry: "Switzerland", iban: "CH5604835098761234009", swiftCode: "BCGECHGGXXX", reference: "Gas supply tranche", notes: "Awaiting Administrator authorization", payeeSource: "Master Account", status: "pending", submittedAt: daysAgo(1), ...mk(30_000_000, "USD") },
  ]
}

// --- Yield / PPP: active high-performing investments -----------------------
export function pppRequests() {
  return [
    { id: "PPP-DEMO-0001", programId: "mcc-platinum-40", programName: "MCC Platinum Yield Programme", expectedReturn: "40% per annum", returnFrequency: "Monthly", duration: "12 months", currency: "USD", amount: 150_000_000, sourceOfFunds: "Institutional capital settlement", payoutAccount: "Master Account (USD)", status: "approved", submittedAt: daysAgo(80), decidedAt: daysAgo(78) },
    { id: "PPP-DEMO-0002", programId: "mcc-managed-buysell", programName: "Managed Buy/Sell Trade Programme", expectedReturn: "6.5% per month", returnFrequency: "Weekly", duration: "40 weeks", currency: "EUR", amount: 200_000_000, sourceOfFunds: "Mandate funding", payoutAccount: "Master Account (EUR)", status: "approved", submittedAt: daysAgo(60), decidedAt: daysAgo(58) },
    { id: "PPP-DEMO-0003", programId: "mcc-private-placement", programName: "Private Placement Programme (PPP)", expectedReturn: "100% per annum", returnFrequency: "Quarterly", duration: "10 months", currency: "CHF", amount: 80_000_000, sourceOfFunds: "Yield programme distribution", payoutAccount: "Master Account (CHF)", status: "pending", submittedAt: daysAgo(3) },
  ]
}

// --- Bank instruments: active, high face-value -----------------------------
export function instruments() {
  return [
    { id: "INS-DEMO-0001", type: "SBLC", typeFull: "Standby Letter of Credit", issuer: "Barclays Bank PLC, London", faceValue: 500_000_000, currency: "USD", status: "active", issuedDate: dateAgo(120), expiryDate: dateAhead(245), daysRemaining: 245, rating: "AA / Aa2", purpose: "Trade finance collateral & monetization", assignable: true, monetizable: true, tradeType: "Leased", submittedAt: daysAgo(122), decidedAt: daysAgo(120) },
    { id: "INS-DEMO-0002", type: "BG", typeFull: "Bank Guarantee", issuer: "Deutsche Bank AG, Frankfurt", faceValue: 250_000_000, currency: "EUR", status: "active", issuedDate: dateAgo(90), expiryDate: dateAhead(275), daysRemaining: 275, rating: "A+ / A1", purpose: "Performance guarantee — commodity contract", assignable: true, monetizable: true, tradeType: "Owned", submittedAt: daysAgo(92), decidedAt: daysAgo(90) },
    { id: "INS-DEMO-0003", type: "MTN", typeFull: "Medium Term Note", issuer: "HSBC Holdings PLC", faceValue: 175_000_000, currency: "GBP", status: "active", issuedDate: dateAgo(60), expiryDate: dateAhead(670), daysRemaining: 670, rating: "AA- / Aa3", purpose: "Fixed-income portfolio holding", assignable: false, monetizable: true, tradeType: "Owned", submittedAt: daysAgo(62), decidedAt: daysAgo(60) },
  ]
}

// --- Download of Funds: approved institutional inflow ----------------------
export function dofRequests() {
  return [
    { id: "DOF-DEMO0001", uetr: generateUetr(), amount: 250_000_000, currency: "USD", valueDate: dateAgo(96), purpose: "Institutional capital settlement — UBO funds", originatorName: "BlackRock Institutional Trust", originatorBank: "JPMorgan Chase Bank N.A.", originatorBankBic: "CHASUS33", originatorAccount: "US64SVBKUS6S3300958879048", originatorCountry: "United States", correspondentBank: "Citibank N.A.", correspondentBic: "CITIUS33", mt103Ref: "MT103-DEMO-9920", mt202Ref: "MT202-DEMO-9921", pofReference: "POF-DEMO-4471", bclReference: "BCL-DEMO-3320", settlementMethod: "SWIFT", isin: "", cusip: "", notes: "Funds credited to master account", status: "approved", submittedAt: daysAgo(98), decidedAt: daysAgo(96) },
    { id: "DOF-DEMO0002", uetr: generateUetr(), amount: 320_000_000, currency: "EUR", valueDate: dateAgo(88), purpose: "Discretionary mandate funding", originatorName: "Deutsche Bank Private Wealth", originatorBank: "Deutsche Bank AG", originatorBankBic: "DEUTDEFF", originatorAccount: "DE89370400440532013000", originatorCountry: "Germany", correspondentBank: "Commerzbank AG", correspondentBic: "COBADEFF", mt103Ref: "MT103-DEMO-2210", mt202Ref: "MT202-DEMO-2211", pofReference: "POF-DEMO-2299", bclReference: "BCL-DEMO-2288", settlementMethod: "SWIFT", isin: "", cusip: "", notes: "Mandate funding credited", status: "approved", submittedAt: daysAgo(90), decidedAt: daysAgo(88) },
  ]
}

// --- DTC / Euroclear: approved securities settlements -----------------------
export function dtcRequests() {
  return [
    { id: "DTC-DEMO0001", uetr: generateUetr(), depository: "DTC", direction: "deliver", settlementBasis: "DVP", securityName: "US Treasury Note 4.25% 2027", securityType: "Treasury Note", isin: "US91282CEZ76", cusip: "91282CEZ7", quantity: 180_000_000, pricePercent: "100.000", cashAmount: 180_000_000, currency: "USD", participantNumber: "DTC-2207", agentBank: "BNY Mellon", agentBankBic: "IRVTUS3N", counterpartyName: "Goldman Sachs & Co", counterpartyParticipant: "DTC-0005", counterpartyBic: "GSCCUS33", tradeDate: dateAgo(76), valueDate: dateAgo(74), mt54xRef: "MT543-DEMO-4471", poaReference: "POA-DEMO-4470", notes: "Bond redemption settled DVP", status: "approved", submittedAt: daysAgo(77), decidedAt: daysAgo(74) },
    { id: "DTC-DEMO0002", uetr: generateUetr(), depository: "Euroclear", direction: "receive", settlementBasis: "DVP", securityName: "MCC Structured Note Series A", securityType: "MTN", isin: "XS2345678901", cusip: "", quantity: 140_000_000, pricePercent: "100.000", cashAmount: 140_000_000, currency: "EUR", participantNumber: "ECLR-90021", agentBank: "Euroclear Bank SA", agentBankBic: "MGTCBEBE", counterpartyName: "Deutsche Bank AG", counterpartyParticipant: "ECLR-11023", counterpartyBic: "DEUTDEFF", tradeDate: dateAgo(59), valueDate: dateAgo(57), mt54xRef: "MT541-DEMO-8841", poaReference: "POA-DEMO-8840", notes: "Securities received versus payment", status: "approved", submittedAt: daysAgo(60), decidedAt: daysAgo(57) },
  ]
}

// --- Commodity deal: approved / executed with verified documents -----------
export function commodityDeals() {
  const popVer = { version: 1, fileName: "SGS-Inspection-2025-0042.pdf", reference: "SGS-2025-0042", issuedBy: "SGS SA, Geneva", issueDate: dateAgo(40), notes: "Quality & quantity verified", uploadedAt: daysAgo(40) }
  const pofVer = { version: 1, fileName: "BCL-Barclays-3320.pdf", reference: "BCL-3320", issuedBy: "Barclays Bank PLC", issueDate: dateAgo(42), notes: "Bank Comfort Letter confirmed", uploadedAt: daysAgo(42) }
  return [
    {
      id: "DEAL-DEMO0001",
      uetr: generateUetr(),
      title: "Jet Fuel A1 — 2,000,000 BBL FOB Rotterdam",
      category: "Commodity Trade",
      tradeStructure: "FOB",
      commodity: "Jet Fuel A1",
      quantity: "2,000,000 BBL",
      approxValue: 184_000_000,
      currency: "USD",
      buyerName: "MCC Capital Group Inc.",
      sellerName: "Shell International Trading",
      sendingBank: "JPMorgan Chase Bank N.A.",
      sendingBankBic: "CHASUS33",
      receivingBank: "Banque Cantonale de Genève",
      receivingBankBic: "BCGECHGGXXX",
      instrumentType: "SBLC",
      originCountry: "Netherlands",
      destinationCountry: "Switzerland",
      mt103Ref: "MT103-DEAL-7781",
      mt202Ref: "MT202-DEAL-7782",
      mt799Ref: "MT799-DEAL-7783",
      notes: "Executed — cargo allocated and shipped",
      stage: "execution",
      status: "approved",
      documents: [
        { id: "DOC-DEMO0001", module: "POP", docType: "SGS Inspection Report", status: "verified", currentVersion: 1, versions: [popVer], decidedAt: daysAgo(39) },
        { id: "DOC-DEMO0002", module: "POF", docType: "Bank Comfort Letter (BCL)", status: "verified", currentVersion: 1, versions: [pofVer], swiftRef: "MT799-DEAL-7783", decidedAt: daysAgo(41) },
      ],
      submittedAt: daysAgo(45),
      decidedAt: daysAgo(38),
    },
  ]
}

// --- Leverage: active high-equity line --------------------------------------
export function leverageRequests() {
  const equity = 200_000_000
  const ratio = 10
  return [
    {
      id: "LEV-DEMO-0001",
      account: "master",
      accountLabel: "Master Account",
      equity,
      currency: "USD",
      leverageRatio: ratio,
      buyingPower: equity * ratio, // 2,000,000,000
      borrowedAmount: equity * (ratio - 1), // 1,800,000,000
      interestRate: 0.08, // risk-based scale: 1:10 -> 8% p.a.
      instrumentType: "Commodities & FX",
      notes: "Active leverage line — strong margin level",
      status: "approved",
      submittedAt: daysAgo(50),
      decidedAt: daysAgo(49),
      activatedAt: daysAgo(49),
    },
  ]
}

// --- SKR Trading: safe keeping receipts held under custody ------------------
export function skrRecords() {
  return [
    {
      id: "SKR-480021",
      custodian: "Barclays Bank PLC, London",
      beneficialOwner: "MCC Capital Demo Portfolio",
      faceValue: 100_000_000,
      currency: "USD",
      issueDate: dateAgo(150),
      expiryDate: dateAhead(215),
      custodyAccountRef: "CUST-204417",
      status: "active",
      notes: "Safe keeping receipt held under custody at Barclays London. Verified and authenticated.",
      documents: [
        { id: "DOC-771001", name: "SKR-Certificate-Barclays-480021.pdf", docType: "SKR Certificate", uploadedAt: daysAgo(150) },
        { id: "DOC-771002", name: "Custodian-Confirmation-480021.pdf", docType: "Custodian Confirmation", uploadedAt: daysAgo(149) },
      ],
      transactions: [
        { id: "TX-900101", date: daysAgo(150), type: "Issuance", description: "SKR created and assigned to the portfolio. Custodian: Barclays Bank PLC, London.", reference: "ADM-440021" },
        { id: "TX-900102", date: daysAgo(120), type: "Verification", description: "Instrument verified and authenticated with the issuing custodian.", reference: "REF-440088" },
      ],
      assignedUserId: DEMO_USER_ID,
      createdAt: daysAgo(150),
      updatedAt: daysAgo(120),
    },
    {
      id: "SKR-480144",
      custodian: "Deutsche Bank AG, Frankfurt",
      beneficialOwner: "MCC Capital Demo Portfolio",
      faceValue: 75_000_000,
      currency: "EUR",
      issueDate: dateAgo(90),
      expiryDate: dateAhead(275),
      custodyAccountRef: "CUST-205590",
      status: "active",
      notes: "Held under custody at Deutsche Bank Frankfurt for collateral purposes.",
      documents: [
        { id: "DOC-772001", name: "SKR-Certificate-Deutsche-480144.pdf", docType: "SKR Certificate", uploadedAt: daysAgo(90) },
      ],
      transactions: [
        { id: "TX-901101", date: daysAgo(90), type: "Issuance", description: "SKR created and assigned to the portfolio. Custodian: Deutsche Bank AG, Frankfurt.", reference: "ADM-441044" },
      ],
      assignedUserId: DEMO_USER_ID,
      createdAt: daysAgo(90),
      updatedAt: daysAgo(90),
    },
    {
      id: "SKR-480290",
      custodian: "HSBC Holdings PLC, London",
      beneficialOwner: "MCC Capital Demo Portfolio",
      faceValue: 40_000_000,
      currency: "GBP",
      issueDate: dateAgo(30),
      custodyAccountRef: "CUST-206710",
      status: "pending",
      notes: "Awaiting final custodian authentication before activation.",
      documents: [],
      transactions: [
        { id: "TX-902101", date: daysAgo(30), type: "Issuance", description: "SKR created pending custodian authentication. Custodian: HSBC Holdings PLC.", reference: "ADM-442290" },
      ],
      assignedUserId: DEMO_USER_ID,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
    },
  ]
}
