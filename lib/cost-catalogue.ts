// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for the customer-facing platform cost catalogue.
//
// Shared by the on-screen page (app/dashboard/terms-costs/page.tsx) and the PDF
// generator (lib/cost-catalogue-pdf.ts) so the online document and the
// downloadable PDF NEVER drift apart.
//
// STAYS ALIGNED WITH LIVE FEE LOGIC: wherever the fee constant lives in a
// dependency-free, client-safe module it is IMPORTED here, so if the rate is
// retuned in one place this catalogue follows automatically. A handful of rates
// live in server-only modules or inside a page component (they cannot be
// imported into a client bundle) — those are written as literals below with a
// `// from …` comment pointing at the authoritative source, and MUST be kept in
// sync when that source changes.
// ---------------------------------------------------------------------------

import { CARD_FEES } from "@/lib/card-fees"
import { GATEWAY_ACCOUNT_FEE } from "@/lib/gateway-catalog"
import {
  SUB_ACCOUNT_SERVICE_FEE,
  SUB_ACCOUNT_ANNUAL_FEE,
  SUB_ACCOUNT_CLOSING_FEE,
  TRANSFER_FEE_RATE,
} from "@/lib/sub-account-fees"
import { INSTRUMENT_MANAGEMENT_FEE_RATE } from "@/lib/instrument-fees"
import { INSTRUMENT_UPGRADE_FEE_RATE } from "@/lib/instrument-upgrade"
import { LEVERAGE_AUDIT_FEE_RATE, LEVERAGE_PPI_RATE } from "@/lib/leverage-audit-fee"
import { EQUITY_RATE_AT_MIN_LTV, EQUITY_RATE_AT_MAX_LTV, PPI_RATE } from "@/lib/monetization-equity"
import { DEBIT_INTEREST_SCALE } from "@/lib/leverage-rates"
import { ACQUISITION_FEE_RATES, MCC_BENEFIT_SHARE, CLIENT_BENEFIT_SHARE } from "@/lib/instrument-marketplace"

// --- Rates that live in server-only modules / page components ---------------
// (cannot be imported into this client-safe catalogue — kept in sync manually).
const PAYMENT_PLATFORM_FEE_RATE = 0.02 // from app/dashboard/payments/page.tsx PLATFORM_FEE_RATE
const FX_EXCHANGE_FEE_RATE = 0.004 // from app/dashboard/exchange/page.tsx conversionFee
const INBOUND_FX_FEE_RATE = 0.005 // from app/actions/incoming-swift.ts GATEWAY_FX_FEE_RATE
const MT760_RECEIPT_FEE_RATE = 0.002 // from app/actions/incoming-swift.ts GUARANTEE_RECEIPT_FEE_RATE
const YIELD_EARLY_CANCEL_RATE = 0.02 // from lib/ppp-yield.ts YIELD_EARLY_CANCELLATION_PENALTY_RATE
const PROJECT_FUNDING_RATE = 0.018 // from lib/interest-accrual.ts (AES Project Funding cost of capital)
const TREASURY_FINANCING_RATE = 0.03 // from lib/guarantees-profile.ts LEVERAGE_TREASURY_RATE
const OVERDRAFT_CEILING_RATE = 0.08 // from lib/overdraft.ts OVERDRAFT_RATE

// --- Formatting helpers -----------------------------------------------------

/** Format a decimal fraction as a percentage, e.g. 0.0035 → "0.035%". */
export function pct(fraction: number, maxFractionDigits = 3): string {
  return `${(fraction * 100).toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits })}%`
}

/** Format an EUR whole/decimal amount, e.g. 1000 → "€1,000". */
function eur(amount: number): string {
  return `€${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

// --- Document metadata + revision history (versioning / audit trail) --------

export const COST_CATALOGUE_META = {
  brand: "MCC Capital",
  platform: "MCC Banking & Trade Platform",
  title: "Terms & Costs — Complete Fee Catalogue",
  subtitle:
    "A certified, self-explanatory schedule of every fee, charge and interest rate that can apply across the platform, and exactly when each one applies.",
  version: "Version 1.0",
  effectiveDate: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }),
  legalEntity: "MCC Capital — software platform operator",
  address: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  email: "support@mcc-capital.com",
}

export interface CatalogueRevision {
  version: string
  date: string
  summary: string
}

/**
 * Published revision history. Each published cost schedule is recorded here so
 * historical fee schedules remain documented (append a new entry — never edit a
 * past one — whenever a rate changes and the version is bumped).
 */
export const COST_CATALOGUE_REVISIONS: CatalogueRevision[] = [
  {
    version: "Version 1.0",
    date: COST_CATALOGUE_META.effectiveDate,
    summary:
      "First published, consolidated catalogue covering membership, payments, FX, gateway, cards, sub-accounts, bank instruments, leverage & treasury financing, project funding, monetization, yield/PPP and operational charges.",
  },
]

// --- Catalogue structure ----------------------------------------------------

export interface CostRow {
  /** The fee, charge or product line. */
  item: string
  /** The headline rate or amount. */
  fee: string
  /** Plain-language explanation of exactly when the cost applies. */
  when: string
}

export interface CostSection {
  id: string
  number: string
  title: string
  intro?: string
  rows: CostRow[]
  /** Optional clarifying note shown under the table. */
  note?: string
}

export const COST_SECTIONS: CostSection[] = [
  {
    id: "membership",
    number: "01",
    title: "Membership & Account Tiers",
    intro:
      "Annual platform membership. The security deposit is a refundable guarantee held in treasury, not a fee. NQAi and platform tools are included with each paid tier.",
    rows: [
      {
        item: "Visitor",
        fee: "Free",
        when: "Read-only trial. Upgrade to PRO or Avant-Garde at any time to transact.",
      },
      {
        item: "PRO — annual membership",
        fee: `${eur(25000)} / year`,
        when: "For active private investors and SMEs. Trading volume up to €5M / month.",
      },
      {
        item: "PRO — security deposit",
        fee: `${eur(500000)} (refundable)`,
        when: "Held in treasury to activate the membership. A leverage deposit of €50,000 applies.",
      },
      {
        item: "Avant-Garde — annual membership",
        fee: `${eur(120000)} / year`,
        when: "For institutions and high-net-worth clients. Unlimited trading volume.",
      },
      {
        item: "Avant-Garde — security deposit",
        fee: `${eur(1000000)} (refundable)`,
        when: "Client contributes €100,000 in cash under the approved 1:10 facility; MCC HOLDING SA finances the remaining €900,000. A leverage deposit of €100,000 applies.",
      },
    ],
    note: "The security deposit secures the account and is returned on closure; it is not consumed as a fee.",
  },
  {
    id: "payments",
    number: "02",
    title: "Payments & Transfers",
    intro: "Charges on money movement. Fees are debited from the Master Account in the transfer currency.",
    rows: [
      {
        item: "Outgoing payment (SWIFT MT103)",
        fee: `${pct(PAYMENT_PLATFORM_FEE_RATE)} of the amount`,
        when: "Charged on top of every outgoing payment when the request is submitted for administrator approval.",
      },
      {
        item: "Instant internal transfer",
        fee: "Free",
        when: "Instant sends between accounts on the platform carry no fee.",
      },
      {
        item: "Sub-account internal transfer",
        fee: `${pct(TRANSFER_FEE_RATE)} of the amount`,
        when: "Every movement of funds between the Master Account and a sub-account (or between two sub-accounts). Always debited from the Master Account.",
      },
    ],
  },
  {
    id: "fx",
    number: "03",
    title: "Currency Exchange (FX)",
    intro: "Costs applied when converting between currencies.",
    rows: [
      {
        item: "Currency exchange / conversion",
        fee: `${pct(FX_EXCHANGE_FEE_RATE)} of the amount`,
        when: "Charged in the source currency each time you convert one currency into another on the Exchange.",
      },
      {
        item: "Inbound settlement FX conversion",
        fee: `${pct(INBOUND_FX_FEE_RATE)} of the amount`,
        when: "Applied when an incoming payment or SWIFT credit arrives in a currency different from the receiving account and must be auto-converted.",
      },
    ],
  },
  {
    id: "gateway-cards",
    number: "04",
    title: "Payment Gateway & Cards",
    intro: "One-time issuance fees, denominated in EUR and debited from the Master Account.",
    rows: [
      {
        item: "Add a bank account via Payment Gateway",
        fee: eur(GATEWAY_ACCOUNT_FEE),
        when: "One-time fee each time a virtual IBAN, collection or multi-currency account is added.",
      },
      {
        item: "Virtual card issuance",
        fee: eur(CARD_FEES.virtual),
        when: "One-time fee charged when a new virtual card is requested.",
      },
      {
        item: "Physical card issuance",
        fee: eur(CARD_FEES.physical),
        when: "One-time fee charged when a new physical card is requested.",
      },
    ],
  },
  {
    id: "sub-accounts",
    number: "05",
    title: "Sub-Accounts",
    intro:
      "Isolated compartments under a single login. Tariffs are in EUR and always reflected on the Master Account.",
    rows: [
      {
        item: "Service fee — alias sub-account",
        fee: eur(SUB_ACCOUNT_SERVICE_FEE.alias),
        when: "One-time, charged when an administrator activates an alias sub-account.",
      },
      {
        item: "Service fee — declared UBO sub-account",
        fee: eur(SUB_ACCOUNT_SERVICE_FEE.declared),
        when: "One-time, charged when an administrator activates a fully declared UBO sub-account.",
      },
      {
        item: "Annual fee",
        fee: `${eur(SUB_ACCOUNT_ANNUAL_FEE)} / year`,
        when: "Billed in advance from the activation date and on each anniversary while the sub-account is active.",
      },
      {
        item: "Closing fee",
        fee: eur(SUB_ACCOUNT_CLOSING_FEE),
        when: "Charged when an administrator closes the sub-account.",
      },
    ],
  },
  {
    id: "instruments",
    number: "06",
    title: "Bank Instruments",
    intro:
      "Fees on acquiring, receiving, transforming and settling bank instruments (SBLC, BG, MTN, CD, MT760, etc.), computed on the instrument face value.",
    rows: [
      {
        item: "Reserve / Assign an instrument",
        fee: `${pct(ACQUISITION_FEE_RATES.assign)} of face value`,
        when: "Upfront, to reserve or assign a marketplace instrument to your name (you become the assignee; MCC HOLDING SA retains ownership).",
      },
      {
        item: "Lease an instrument",
        fee: `${pct(ACQUISITION_FEE_RATES.lease)} of face value`,
        when: "Collateral transfer for the instrument's term (returned at maturity).",
      },
      {
        item: "Purchase an instrument",
        fee: `${pct(ACQUISITION_FEE_RATES.purchase)} of face value`,
        when: "Outright purchase — full ownership transfers to you (no benefit split).",
      },
      {
        item: "Inbound MT760 guarantee receipt",
        fee: `${pct(MT760_RECEIPT_FEE_RATE)} of face value`,
        when: "Charged when an inbound MT760 blocked-funds guarantee is received and booked into your Bank Instruments as pledgeable collateral.",
      },
      {
        item: "Instrument transformation / upgrade",
        fee: `${pct(INSTRUMENT_UPGRADE_FEE_RATE, 4)} of old face value`,
        when: "One-time expertise & upgrade fee, charged only when you confirm an administrator-negotiated upgrade into a fresh instrument.",
      },
      {
        item: "Management & settlement (delete)",
        fee: `${pct(INSTRUMENT_MANAGEMENT_FEE_RATE)} of face value`,
        when: 'Charged when you delete ("settle out") an instrument you hold. Not charged when returning an instrument to the marketplace.',
      },
    ],
    note: `Investment returns generated using a reserved/assigned (MCC-owned) instrument are split ${pct(MCC_BENEFIT_SHARE, 0)} to MCC HOLDING SA and ${pct(CLIENT_BENEFIT_SHARE, 0)} to you; you bear 100% of the costs. An outright purchase carries no split.`,
  },
  {
    id: "leverage",
    number: "07",
    title: "Leverage & Treasury Financing",
    intro:
      "Costs of a leveraged trading line or a treasury security-deposit facility. Application charges are debited from the Master Account on confirmation.",
    rows: [
      {
        item: "Audit & compliance fee",
        fee: `${pct(LEVERAGE_AUDIT_FEE_RATE, 5)} × ratio × buying power`,
        when: "Charged when a leverage application is confirmed (whether the line is ultimately accepted or rejected) — it covers the Treasury-partner verification. Non-refundable.",
      },
      {
        item: "Payment Protection Insurance (PPI)",
        fee: `${pct(LEVERAGE_PPI_RATE)} of buying power`,
        when: "Charged upfront with the audit fee. Fully refunded if the line is declined or withdrawn.",
      },
      {
        item: "Debit interest — leverage line",
        fee: interestScaleLabel(),
        when: "Annual rate charged monthly as 1/12, accruing from the day funds are credited. Higher leverage carries more risk and a higher rate.",
      },
      {
        item: "Special Treasury Financing",
        fee: `${pct(TREASURY_FINANCING_RATE)} p.a.`,
        when: "Annual debit interest on a financed treasury security deposit, charged monthly and pro-rated for partial months.",
      },
    ],
  },
  {
    id: "financing",
    number: "08",
    title: "Financing, Loans & Project Funding",
    intro: "Cost of capital on funded facilities.",
    rows: [
      {
        item: "AES Project Funding",
        fee: `${pct(PROJECT_FUNDING_RATE)} p.a.`,
        when: "Cost of capital on approved project funding, charged monthly from the day funds are credited and pro-rated for partial months.",
      },
      {
        item: "Internal loan — arrangement fee",
        fee: "Set at approval (variable)",
        when: "An optional one-time arrangement fee an administrator may set on an approved internal loan; the full principal is credited to your Master Account at approval.",
      },
      {
        item: "Internal loan — debit interest",
        fee: "Monthly, per approved terms",
        when: "Debit interest accrues monthly on the outstanding loan principal from the day funds are credited.",
      },
    ],
  },
  {
    id: "monetization",
    number: "09",
    title: "Instrument Monetization",
    intro:
      "Upfront costs to monetize a bank instrument, expressed against the advance (face value × chosen LTV, from 1% to 100%).",
    rows: [
      {
        item: "Equity deposit",
        fee: `${pct(EQUITY_RATE_AT_MIN_LTV)} → ${pct(EQUITY_RATE_AT_MAX_LTV)} of the advance`,
        when: `Scales linearly with the chosen Loan-to-Value: ${pct(EQUITY_RATE_AT_MIN_LTV)} at 1% LTV up to ${pct(EQUITY_RATE_AT_MAX_LTV)} at 100% LTV. Posted upfront.`,
      },
      {
        item: "Payment Protection Insurance (PPI)",
        fee: `${pct(PPI_RATE)} of the advance`,
        when: "Funded from the same upfront deposit as the equity.",
      },
    ],
  },
  {
    id: "yield",
    number: "10",
    title: "Yield / PPP Programs",
    intro: "Charges related to yield and private-placement (PPP) programs.",
    rows: [
      {
        item: "Early-cancellation penalty",
        fee: `${pct(YIELD_EARLY_CANCEL_RATE)} of invested principal`,
        when: "Charged from the Master Account when you cancel an ongoing (approved) program before its term ends. Earned ROI already credited is retained.",
      },
      {
        item: "Benefit split (MCC-owned instrument funding)",
        fee: `${pct(MCC_BENEFIT_SHARE, 0)} MCC / ${pct(CLIENT_BENEFIT_SHARE, 0)} you`,
        when: "When a program is funded by an instrument owned by MCC HOLDING SA, the program's return is split; you keep 25%. Funded from your own means → you keep 100%.",
      },
    ],
  },
  {
    id: "operational",
    number: "11",
    title: "Overdraft & Operational Charges",
    intro: "Operational rules that can affect the Master Account balance.",
    rows: [
      {
        item: "Controlled overdraft",
        fee: `Up to ${pct(OVERDRAFT_CEILING_RATE)} of the secured treasury deposit`,
        when: "Automatic platform charges & fees may draw the Master Account negative up to this ceiling when positive funds are exhausted. Ordinary outgoing money movement still requires positive funds.",
      },
      {
        item: "Document generation",
        fee: "Included",
        when: "Statements, certificates, receipts, SKR, corporate offers (FCO) and confirmations are generated at no additional charge.",
      },
      {
        item: "Commodity trading",
        fee: "No separate platform fee",
        when: "Commodity deals do not carry a distinct platform fee; any instrument, financing or payment used within a deal is charged under its own section above.",
      },
    ],
  },
]

/** Human label for the leverage debit-interest scale, e.g. "1:2 2% … 1:30 22%". */
function interestScaleLabel(): string {
  const first = DEBIT_INTEREST_SCALE[0]
  const last = DEBIT_INTEREST_SCALE[DEBIT_INTEREST_SCALE.length - 1]
  return `${pct(first.rate, 0)} p.a. (1:${first.ratio}) → ${pct(last.rate, 0)} p.a. (1:${last.ratio})`
}

/** The full leverage rate ladder as rows, for a detailed table in the document. */
export const LEVERAGE_RATE_LADDER: { ratio: string; rate: string }[] = DEBIT_INTEREST_SCALE.map((a) => ({
  ratio: `1:${a.ratio}`,
  rate: `${pct(a.rate, 0)} p.a.`,
}))
