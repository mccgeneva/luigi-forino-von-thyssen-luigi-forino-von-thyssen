// Single source of truth for the MCC Capital Client Handbook.
// Consumed by both the on-screen handbook page and the PDF generator so the
// downloadable document always matches what the client reads in-app.

// A worked example: a real screenshot of an action being taken and the
// resulting screen, with a plain-language walk-through of the numbered steps.
export interface HandbookExample {
  // Short label shown on the example card, e.g. "Example — Sending a payment".
  title: string
  // Path to a real captured screenshot under /public (e.g. /handbook/send-money.png).
  image: string
  // Alt text / caption describing what the screenshot shows.
  caption: string
  // Ordered walk-through steps ("Action" then "Result" read naturally here).
  steps: string[]
}

export interface HandbookSubsection {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
  // Optional worked examples rendered after the text, each with a screenshot.
  examples?: HandbookExample[]
}

export interface HandbookSection {
  id: string
  number: string
  title: string
  intro?: string
  subsections: HandbookSubsection[]
}

// Every distinct screenshot path referenced by a worked example, so the PDF
// generator's caller can preload them all before rendering.
export function collectHandbookImagePaths(): string[] {
  const paths = new Set<string>()
  for (const section of HANDBOOK_SECTIONS) {
    for (const sub of section.subsections) {
      for (const ex of sub.examples ?? []) {
        if (ex.image) paths.add(ex.image)
      }
    }
  }
  return [...paths]
}

export const HANDBOOK_META = {
  title: "Client Handbook",
  subtitle: "MCC Banking & Trade Platform — Complete User Guide",
  version: "Edition 2026.4",
  lastUpdated: "Last updated: July 2026",
  brand: "MCC Capital",
  legalEntity: "MCC Holding SA",
  address: "Rue du Rhône 14, 1204 Geneva, Switzerland",
  email: "support@mcc-capital.com",
}

export const HANDBOOK_SECTIONS: HandbookSection[] = [
  {
    id: "introduction",
    number: "01",
    title: "Welcome to MCC Capital",
    intro:
      "This handbook is your complete guide to the MCC Banking & Trade Platform. It explains every feature available to you, from everyday banking to advanced instrument trading, so you can operate your account with confidence.",
    subsections: [
      {
        heading: "About the Platform",
        paragraphs: [
          "The MCC Banking & Trade Platform is a private digital banking environment operated under Swiss fiduciary standards by MCC Holding SA, headquartered in Geneva. It brings together multi-currency banking, international payments, instrument trading, and fiduciary asset management in a single secure workspace.",
          "Your platform is configured specifically for your profile. Balances, transactions, and holdings always reflect your real account activity — no placeholder or demonstration figures are ever shown.",
        ],
      },
      {
        heading: "Who This Handbook Is For",
        paragraphs: [
          "This document is intended for account holders and their authorized representatives. It assumes no prior technical knowledge and walks through each area of the platform in plain language.",
        ],
      },
    ],
  },
  {
    id: "getting-started",
    number: "02",
    title: "Getting Started",
    subsections: [
      {
        heading: "Signing In",
        paragraphs: [
          "Access the platform using the email address and password issued during onboarding. For your security, always sign in directly through the official platform address and never share your credentials.",
        ],
      },
      {
        heading: "The Dashboard Overview",
        paragraphs: [
          "After signing in you arrive at the Overview page. This is your command center, summarizing your total balance, recent activity, portfolio performance, and quick actions.",
        ],
        bullets: [
          "Portfolio summary — your real aggregated balance across all accounts and currencies.",
          "Recent transactions — your latest incoming and outgoing movements.",
          "Performance chart — cumulative balance plotted from your dated ledger entries.",
          "Quick actions — shortcuts to send payments, receive funds, and more.",
        ],
        examples: [
          {
            title: "Example — Reading your Overview",
            image: "/handbook/overview.png",
            caption:
              "The Overview page for a live account, showing the membership banner, multi-currency Account Balances, and headline metrics.",
            steps: [
              "Action: Sign in and land on the Overview page (Banking → Overview in the sidebar).",
              "Result: Your membership tier is shown at the top, followed by Account Balances — one card per currency (EUR, USD, GBP, CHF) with the live balance for each.",
              "Below the balances, the Total across all currencies is shown in EUR equivalent, alongside Active Instruments, 30-day Volume, and Bank Partners.",
              "Every figure is drawn from your real ledger — there are no placeholder or demonstration numbers anywhere on the platform.",
            ],
          },
        ],
      },
      {
        heading: "Navigation",
        paragraphs: [
          "The sidebar groups features into three areas: Banking, Trading & Instruments, and Platform. On mobile devices, open the menu using the button in the top bar. You can collapse the sidebar on desktop to maximize screen space.",
        ],
      },
    ],
  },
  {
    id: "master-account",
    number: "03",
    title: "Master Account & Multi-Currency Management",
    intro:
      "Your MCC master account is the single hub through which all balances, sub-accounts, and currencies are managed. Understanding how it works is the foundation for everything else in the platform.",
    subsections: [
      {
        heading: "The Master Account Model",
        paragraphs: [
          "Every relationship is anchored to a master account that holds your funds across all supported currencies. The Overview page aggregates these balances into a single portfolio value while still letting you act on each currency individually.",
          "Where authorized, sub-accounts (for example, additional authorized representatives) draw on the same underlying pool of funds as the master. This means an approval requested by a sub-account is funded from, and settled against, the master account's balances — keeping treasury centralized and auditable.",
        ],
      },
      {
        heading: "Supported Currencies",
        paragraphs: [
          "The platform operates natively in EUR, USD, GBP, and CHF. Each currency maintains its own available balance, and the system tracks cleared funds, holds (reserved funds), and pending movements separately so you always know what is truly spendable.",
        ],
        bullets: [
          "Available balance — cleared funds you can spend or reserve right now.",
          "Held / reserved — funds committed to an approved deal or instrument and temporarily unavailable.",
          "Pending — movements awaiting clearing or Administrator authorization.",
        ],
      },
      {
        heading: "Cross-Currency Funding & FX",
        paragraphs: [
          "When you commit to a transaction priced in a currency you do not hold enough of, the platform can fund the shortfall by executing a real foreign-exchange conversion at the prevailing rate — selling from your strongest currency to buy what the deal requires. Each conversion is capped at the available balance of the source currency, so a transaction can never drive any currency negative.",
          "If your total spendable balance across all currencies is still insufficient to cover a reservation, the request is automatically declined and you are notified with the exact shortfall, rather than the deal proceeding into an overdraft.",
        ],
      },
    ],
  },
  {
    id: "banking-details",
    number: "04",
    title: "Banking Details — IBAN & SWIFT Operations",
    intro:
      "This section explains your account coordinates and how the platform routes money internationally.",
    subsections: [
      {
        heading: "Your Account Coordinates",
        paragraphs: [
          "Each currency account carries its own IBAN and SWIFT/BIC. These coordinates appear on the Bank Accounts page and on certificates such as Proof of Funds, and are what counterparties use to remit funds to you.",
        ],
      },
      {
        heading: "SWIFT Messaging",
        paragraphs: [
          "International movements are carried over the SWIFT network. The platform supports the message types used in private and institutional banking, each with full end-to-end reference tracking (UETR) so a transfer can be followed from initiation to settlement.",
        ],
        bullets: [
          "MT103 — single customer credit transfer (client payments).",
          "MT202 — general financial institution transfer (bank-to-bank cover).",
          "MT760 — guarantee / standby letter of credit messaging for instruments.",
          "UETR tracking — a unique end-to-end reference on every message for status visibility.",
        ],
      },
      {
        heading: "Designated Settlement Banks",
        paragraphs: [
          "Certain activities route through dedicated correspondent accounts. For example, a designated Barclays Bank PLC account is used exclusively for funds related to bank-instrument trading. The relevant coordinates are always shown on the page for that activity so you remit to the correct account.",
        ],
      },
    ],
  },
  {
    id: "banking",
    number: "05",
    title: "Payments, Beneficiaries & Reconciliation",
    intro: "The Banking area covers the tools you use most often to move and monitor money.",
    subsections: [
      {
        heading: "Sending a Payment (Step by Step)",
        paragraphs: [
          "Outgoing payments follow a clear, reviewable flow so nothing leaves your account by accident.",
        ],
        bullets: [
          "1. Open Send and choose a saved beneficiary or enter new details.",
          "2. Enter the amount and select the debit currency.",
          "3. Add a payment reference for the recipient and your own records.",
          "4. Review the summary, including any cross-currency conversion.",
          "5. Confirm — the payment is submitted for Administrator authorization where required, then executed.",
        ],
        examples: [
          {
            title: "Example — Sending a payment",
            image: "/handbook/send-money.png",
            caption:
              "The Send Money screen with a new transfer being composed. The header cards show Available Balance, Total Sent, and Total Received.",
            steps: [
              "Action: Go to Send Money and keep the Instant tab selected to pay another verified MCC account holder in real time. (Use the Approval tab to pay any other recipient via Administrator review.)",
              "Action: Enter the recipient's registered email in Recipient email. The platform checks it live — here it reports 'No account found for this email yet', so this recipient would need the Approval route.",
              "Action: Type the Amount (250,000) and pick the debit Currency (EUR). Your available balance is shown directly beneath so you never overspend.",
              "Action: Add an optional Reference (Invoice 2026-014) that appears on both statements, then confirm.",
              "Result: An instant transfer settles immediately and appears in Transfer History; an approval transfer is queued for the Administrator and executes once authorized.",
            ],
          },
        ],
      },
      {
        heading: "Incoming Payments & Crediting",
        paragraphs: [
          "Funds remitted to your IBAN/SWIFT coordinates are received, verified against their supporting messaging, and credited to the matching currency account. High-value institutional receipts are handled through the Institutional Desk (Download of Funds) described later in this handbook.",
        ],
      },
      {
        heading: "Reconciliation & Statements",
        paragraphs: [
          "Every movement is recorded as a dated ledger entry with a direction, status, counterparty, and category. The Transactions and Statements pages let you search, filter, and export this history, and you can download a professional PDF receipt for any individual transaction for your records or your accountant.",
        ],
      },
      {
        heading: "Beneficiaries",
        paragraphs: [
          "Maintain a directory of trusted recipients. Each beneficiary stores the account name, bank, IBAN, and SWIFT/BIC so future payments are fast and accurate, and the register itself can be exported as a branded PDF.",
        ],
      },
      {
        heading: "Live FX Rates",
        paragraphs: [
          "Monitor live foreign-exchange rates across major currency pairs and use them to inform conversions and cross-border payments.",
        ],
      },
    ],
  },
  {
    id: "cards",
    number: "06",
    title: "Credit & Debit Cards",
    intro:
      "Request, customize, and manage MCC Capital Visa and Mastercard cards directly from the platform.",
    subsections: [
      {
        heading: "Requesting a Card",
        paragraphs: [
          "From the Cards page you can request a new Visa or Mastercard in your account currency. You choose the card network, the tier, the format (physical or virtual), a requested monthly spending limit, and optionally the intended purpose. The request is submitted for Administrator review and activated once approved.",
        ],
      },
      {
        heading: "Customization & Controls",
        bullets: [
          "Choose Visa or Mastercard and your preferred tier.",
          "Select a physical or virtual card format.",
          "Set a requested monthly spending limit in your account currency.",
          "Track spending against your limit, with figures reflecting only real card activity.",
        ],
      },
      {
        heading: "Approval & Activation",
        paragraphs: [
          "Cards follow the same authorization principle as the rest of the platform: a new card or limit change is reviewed by the Administrator before it becomes active, ensuring every instrument issued against your account is verified.",
        ],
      },
    ],
  },
  {
    id: "trading",
    number: "07",
    title: "Trading & Instruments",
    intro:
      "These advanced services support institutional-grade trading, settlement, and structured returns.",
    subsections: [
      {
        heading: "NAFTAhub Trading (NQAi Engine)",
        paragraphs: [
          "NAFTAhub is the platform's automated trading section, powered by the Neural Quantum AI (NQAi) engine. It covers commodities, FX, equities, crypto, and indices with live market data and AI-generated signals.",
          "Capital shown reflects your real available balance. No funds are allocated to NQAi until you fund and deploy a position. You can also apply to the Treuhand AG Limited hedge fund directly from this section.",
        ],
        bullets: [
          "Markets — live instruments with BUY / SELL / HOLD signals.",
          "AI Signals — NQAi confidence with technical overlays.",
          "Positions — your open positions and live profit & loss.",
          "ROI Tiers — structured return tiers (PRO and Avant-Garde).",
          "Treuhand Fund — apply to the capital-guaranteed hedge fund.",
        ],
      },
      {
        heading: "Treuhand AG Limited Hedge Fund",
        paragraphs: [
          "A fully automated, capital-guaranteed investment vehicle governed under Swiss fiduciary law and powered by NQAi. The fund offers a fixed 25% monthly ROI on active trading days, with capital protected under Swiss fiduciary guarantee.",
        ],
        bullets: [
          "Token unit value: €10,000 — minimum entry of 3 tokens (€30,000).",
          "0% entry and management fees.",
          "100% capital guaranteed under Swiss fiduciary law.",
          "Onboarding requires AML / KYC due diligence prior to admission.",
        ],
      },
      {
        heading: "SWIFT Services",
        paragraphs: [
          "Initiate and track international SWIFT transfers, including MT103 and related message types, with full reference and status visibility.",
        ],
      },
      {
        heading: "Bank Instruments",
        paragraphs: [
          "Trade and manage bank instruments such as guarantees and structured notes. A dedicated Barclays Bank PLC account is designated exclusively for the receipt and processing of funds related to bank instrument trading activities; its full details are shown on the Bank Instruments page.",
        ],
      },
      {
        heading: "Institutional Desk (Download of Funds)",
        paragraphs: [
          "The Institutional Desk handles high-value Download of Funds (DOF) — the controlled receipt and crediting of large institutional funds into your MCC Capital master account. Each request is verified against its supporting SWIFT messaging and documentation, then authorized by the Administrator before the funds are credited and made available.",
          "Requests support SWIFT MT103 and MT202 messaging with full UETR tracking, and can be settled in cash (SWIFT) or coordinated through DTC or Euroclear. You can submit a new Download of Funds request and follow each one through to authorization from the same page.",
        ],
        bullets: [
          "SWIFT MT103 / MT202 messaging with end-to-end UETR tracking.",
          "Originator, originating bank, and BIC captured for every request.",
          "Settlement via SWIFT cash, DTC, or Euroclear.",
          "Funds are credited only after Administrator authorization.",
        ],
      },
      {
        heading: "Securities Settlement (DTC / Euroclear)",
        paragraphs: [
          "Settle securities through the Depository Trust Company (DTC) or Euroclear using book-entry delivery. You can deliver securities out (receiving cash) or receive securities in, on either a delivery-versus-payment (DVP) or free-of-payment (FOP) basis.",
          "Each instruction captures the security type, ISIN or CUSIP, quantity, counterparty, and cash leg, and is tracked with a UETR. Settlement is finalized only after the Administrator authorizes the instruction.",
        ],
        bullets: [
          "DTC (US, CUSIP) and Euroclear (international, ISIN) depositories.",
          "Deliver or receive securities on a DVP or FOP basis.",
          "Supports bonds, equities, MTNs, treasury and corporate notes, and fund units.",
          "Every instruction is authorized by the Administrator before settlement.",
        ],
      },
      {
        heading: "Commodity Trading Desk",
        paragraphs: [
          "Structure high-value commodity and institutional transactions with full SWIFT/BIC routing, Proof of Product (seller) and Proof of Funds (buyer) document management, and a controlled, stage-by-stage deal workflow. Every deal is reviewed and authorized by the Administrator — nothing executes automatically.",
        ],
        bullets: [
          "Proof of Product (POP) and Proof of Funds (POF) document handling with versioning.",
          "Buyer, seller, shipping route, and instrument details captured per deal.",
          "Guided deal stages from structuring through to execution.",
          "Administrator review and document verification at each step.",
        ],
        examples: [
          {
            title: "Example — The Commodity Trading Desk",
            image: "/handbook/commodity-desk.png",
            caption:
              "The Commodity Trading Desk landing view, showing the standard six-step transaction sequence and the workflow tabs.",
            steps: [
              "Action: Open the Commodity Trading Desk (Trading & Instruments → Commodity).",
              "Result: The Standard transaction sequence is shown as six numbered stages — ICPO, FCO, Contract, POP, POF, and Execution — so you always know where a deal sits.",
              "Use the tabs below (Quotations, Spot Deals, Deal Workflow, Proof of Product, Proof of Funds) to move between pricing, live offers, your deals, and document management.",
              "The Quotations board shows indicative CIF/FOB cargo prices across major petroleum ports — reference levels for structuring; confirm firm pricing with the desk before execution.",
            ],
          },
        ],
      },
      {
        heading: "Commodity Quotations & Benchmarks",
        paragraphs: [
          "The desk publishes live commodity quotations and benchmark prices — including energy references such as Brent and WTI — so you can price deals against the current market. Indicative prices are clearly labelled as such; firm pricing is always confirmed with the desk before execution.",
        ],
      },
      {
        heading: "Spot Deals",
        paragraphs: [
          "The live Spot Deals board lists time-limited commodity offers with their product, quantity, price basis (for example CIF or FOB), the carrying vessel, and a countdown to expiry. When you commit to a spot deal, the platform reserves the required funds against your master account — running a capped cross-currency conversion if needed — and routes the commitment for Administrator authorization.",
        ],
        bullets: [
          "Product, quantity, and price basis (CIF / FOB) for each offer.",
          "Associated vessel and a live countdown to expiry.",
          "Funds are reserved on commitment and released if a deal is cancelled.",
          "Insufficiently funded commitments are automatically declined — never overdrawn.",
        ],
        examples: [
          {
            title: "Example — Managing one of your deals",
            image: "/handbook/deal-tools.png",
            caption:
              "A committed spot deal in the Deal Workflow tab: an approved, delivered Arab Light cargo showing the full stage tracker and the Deal tools row.",
            steps: [
              "Action: Open the Deal Workflow tab and scroll to My deals to see every deal you have committed to.",
              "Result: Each deal card shows its status badges (Approved, Delivered), the ICPO → FCO → Contract → POP → POF → Execution stage tracker, and the full commercial terms — value, commodity, quantity, unit price, buyer, seller, and route.",
              "The Deal tools row lets you manage a deal directly: Edit terms, Suspend (pause the workflow), Freeze (lock it and keep funds blocked), or Delete (which releases any reserved funds back to your balance).",
              "Result: Once a deal is Delivered & finalized it is locked — as the banner here confirms, it can no longer be revoked, so only the permitted tools remain available.",
            ],
          },
        ],
      },
      {
        heading: "Vessel Data & SKR",
        paragraphs: [
          "Commodity offers are linked to vessel information (such as the carrying ship and its identifiers) for due diligence, and to Safe Keeping Receipts (SKR) where goods or assets are held in custody. SKRs are managed under Certificates and can be issued as branded PDF documents.",
        ],
      },
      {
        heading: "Negotiation Workflow",
        paragraphs: [
          "Deals progress through guided stages — structuring, document exchange, verification, and execution — with the Administrator verifying supporting documentation at each step. This keeps high-value negotiations orderly, evidenced, and fully auditable from first contact to settlement.",
        ],
      },
      {
        heading: "Leverage & Risk",
        paragraphs: [
          "Request leveraged trading lines against your account equity and monitor margin in real time. You choose a leverage ratio of 1:2, 1:5, 1:10, 1:15, 1:20, 1:25, or up to 1:30; the borrowed amount, total buying power, and accrued debit interest are calculated for you before you submit.",
          "Borrowed funds carry debit interest under a risk-based inverse scale — a higher leverage multiple signals lower risk and carries a lower annual rate: 14% at 1:2, 10% at 1:5, 8% at 1:10, 7% at 1:15, 6% at 1:20, 4% at 1:25 and 3% at 1:30. Interest accrues from the moment the line is activated. When you switch a line off, the accrued interest is settled and the borrowed principal is repaid from your balance. Each line is denominated in your account's currency (EUR, USD, GBP, or CHF), and both activation and switch-off require Administrator approval.",
        ],
        bullets: [
          "Selectable leverage ratios from 1:2 up to 1:30.",
          "Live preview of borrowed funds, buying power, and interest before submitting.",
          "Risk-based debit interest (14% at 1:2 down to 3% at 1:30) on borrowed funds, settled on switch-off.",
          "Real-time margin monitoring with Administrator-approved activation and switch-off.",
        ],
      },
      {
        heading: "Yield / PPP",
        paragraphs: [
          "Explore Private Placement Programme opportunities and structured yield products. Figures reflect your real participation and are zero until you enroll.",
        ],
      },
      {
        heading: "Fiduciary & Assets",
        paragraphs: [
          "View assets held under custody through your fiduciary mandate. Total assets under custody are summed from your real holdings and remain at zero until a mandate is funded.",
        ],
      },
    ],
  },
  {
    id: "nqai",
    number: "08",
    title: "NQAi — Neural Quantum AI",
    intro:
      "NQAi is your private artificial-intelligence co-pilot, built into the platform to help you understand markets, your own account, and your next move — in plain language, on demand.",
    subsections: [
      {
        heading: "What NQAi Is",
        paragraphs: [
          "NQAi (Neural Quantum Artificial Intelligence) is a proprietary AI assistant available from the prominent NQAi button in the header and from the sidebar. It answers questions, explains platform features, and reasons over live market data and your own account context to give you grounded, relevant guidance.",
        ],
      },
      {
        heading: "How to Use It",
        bullets: [
          "Open NQAi from the header button (on any page) or the Terminal group in the sidebar.",
          "Type a question — for example about a benchmark price, a spot deal, or your balances.",
          "Use the suggested prompts to get started quickly.",
          "Start a fresh conversation at any time with the New control.",
        ],
        examples: [
          {
            title: "Example — Asking NQAi",
            image: "/handbook/nqai.png",
            caption:
              "The NQAi Co-Pilot workspace: saved conversations on the left, a personalized greeting, and one-tap suggested prompts.",
            steps: [
              "Action: Open NQAi Co-Pilot from the Terminal group in the sidebar (or the NQAi button in the header).",
              "Result: NQAi greets you with a briefing built from your own secure context — here it confirms the desk is loaded and states the account's available balance.",
              "Action: Pick a suggested prompt such as 'Brent vs WTI today' or 'Explain CIF vs FOB', or type your own question in the box at the bottom.",
              "Action: Attach a PDF, image, or CSV to have NQAi analyze it — it can also prepare downloadable PDF documents for you.",
              "Result: The conversation is saved privately to your account and appears in the left-hand list, so you can continue it later across sessions.",
            ],
          },
        ],
      },
      {
        heading: "Personalization & Memory",
        paragraphs: [
          "NQAi greets returning clients with a personalized briefing drawn from your own secure account context — for example your name, balances, pending items, and notifications. Conversations are saved privately to your account so they continue across sessions, and a rolling memory summary lets NQAi recall the thread of long discussions.",
          "All personal and financial context is assembled securely on the server and scoped strictly to you. It is never exposed to other clients, and NQAi always treats prices it quotes as indicative, directing you to the desk for firm execution.",
        ],
      },
      {
        heading: "What It Can Help With",
        bullets: [
          "Live market and benchmark prices, with context on movements.",
          "Your balances, recent transactions, certificates, and instruments.",
          "Explaining how a feature works and walking you through a workflow.",
          "Summarizing the current spot-deal board and flagging time-sensitive items.",
        ],
      },
    ],
  },
  {
    id: "console",
    number: "09",
    title: "Bloomberg-Style Console",
    intro:
      "The Console is a dense, professional trading terminal that brings your most important live information together on one screen.",
    subsections: [
      {
        heading: "Overview",
        paragraphs: [
          "Accessible from the Terminal group in the sidebar, the Console presents a multi-panel terminal in the style of an institutional trading desk: live markets, commodity benchmarks, the spot-deal board, and the NQAi co-pilot, all visible at once with a scrolling ticker and a live clock.",
        ],
      },
      {
        heading: "Working with Panels",
        bullets: [
          "Resizable, docked panels you can size to your preference on desktop.",
          "A markets watchlist and a commodity (CIF/FOB) benchmark board.",
          "The live Spot Deals panel with countdown timers.",
          "A docked NQAi panel so you can ask questions without leaving the terminal.",
          "A tabbed layout on mobile so the same information stays usable on a phone.",
        ],
      },
    ],
  },
  {
    id: "bankeka",
    number: "10",
    title: "Bankeka Messaging System",
    intro:
      "Bankeka is the platform's secure, private messaging system for communicating with the MCC team and other authorized parties.",
    subsections: [
      {
        heading: "Secure Communication",
        paragraphs: [
          "Bankeka keeps your platform conversations inside the secure environment rather than ordinary email. Use it to reach MCC Capital support, ask questions about a request, or coordinate on a deal — all tied to your authenticated account.",
        ],
      },
      {
        heading: "Starting a Conversation",
        bullets: [
          "Message MCC Capital support directly from the Bankeka page.",
          "Start a private conversation with another party by entering their email address.",
          "Keep all platform-related correspondence in one auditable place.",
        ],
      },
    ],
  },
  {
    id: "certificates",
    number: "11",
    title: "Certificates",
    intro:
      "Generate official, branded documents from your verified account data. Every certificate is produced from your real holdings and must be approved by MCC Capital before issuance.",
    subsections: [
      {
        heading: "Available Certificates",
        bullets: [
          "Certificate of Good Standing — confirmation of an active account in good standing.",
          "Certificate of Proof of Funds (POF) — your cleared per-currency balances.",
          "Certificate of Endorsement — formal endorsement for a stated purpose.",
          "Certificate of Ownership — confirmation of legal and beneficial account ownership.",
          "Safe Keeping Receipt (SKR) — evidence of assets or goods held in custody.",
        ],
      },
      {
        heading: "How Certificates Are Issued",
        paragraphs: [
          "You request a certificate from the Certificates page, selecting the type and any required parameters. The request is generated from your verified account data and submitted for MCC Capital approval. Once approved, you can download the certificate as a professionally formatted, branded PDF.",
          "Because certificates draw on your real balances and profile, they always reflect your current position — there are no placeholder figures.",
        ],
        examples: [
          {
            title: "Example — Requesting a certificate",
            image: "/handbook/certificates.png",
            caption:
              "The Bank Certificates page listing the available certificate types, each with a Request Certificate button, above your issued-certificates history.",
            steps: [
              "Action: Open Certificates (Banking → Certificates) to see the available types — Good Standing, Endorsement, Proof of Funds, and Ownership.",
              "Action: Click Request Certificate under the type you need. The request is built automatically from your verified account data.",
              "Result: The request is submitted to the MCC Capital Compliance Office for approval; each issued document carries a unique reference, verification code, watermark, and official seal, with a full audit trail retained.",
              "Result: Once approved, the certificate appears under Your Certificates and can be downloaded as a branded PDF.",
            ],
          },
        ],
      },
    ],
  },
  {
    id: "fees",
    number: "12",
    title: "Fees & Pricing",
    intro:
      "MCC believes in transparent pricing. This section summarizes the platform's membership plans and the principal costs associated with its services. Exact figures applicable to your relationship are always confirmed by your relationship manager before you commit.",
    subsections: [
      {
        heading: "Membership Plans",
        paragraphs: [
          "Access to the platform is organized into annual membership tiers, each pairing a yearly fee with a refundable security deposit held in our treasury bank.",
        ],
        bullets: [
          "PRO — €25,000 / year, with a €500,000 refundable security deposit. For active private investors and SMEs.",
          "Avant-Garde — €120,000 / year, with a €1,000,000 refundable security deposit. For institutions and high-net-worth clients.",
        ],
      },
      {
        heading: "What Each Plan Includes",
        bullets: [
          "PRO — multi-currency IBAN accounts, SWIFT MT103 & MT760 transfers, up to €5M trading volume per month, standard bank-instrument access, a dedicated account manager, and email & phone support.",
          "Avant-Garde — everything in PRO plus unlimited trading volume, priority SBLC / MTN / BG issuance, fiduciary & asset-custody mandate, PPP / yield enrollment, a 24/7 relationship manager, and a bespoke compliance & legal desk.",
        ],
      },
      {
        heading: "Leverage Costs",
        paragraphs: [
          "Leveraged trading lines carry debit interest on borrowed funds under a risk-based inverse scale — a higher ratio carries a lower rate (14% at 1:2, 10% at 1:5, 8% at 1:10, 7% at 1:15, 6% at 1:20, 4% at 1:25, 3% at 1:30) — accruing from activation. When a line is switched off, accrued interest is settled and the borrowed principal is repaid from your balance. There are no separate activation fees — the cost is the transparent interest on what you actually borrow.",
        ],
      },
      {
        heading: "Treuhand Fund Terms",
        bullets: [
          "Token unit value of €10,000, with a minimum entry of 3 tokens (€30,000).",
          "0% entry and 0% management fees.",
          "100% capital guaranteed under Swiss fiduciary law.",
        ],
      },
      {
        heading: "Foreign Exchange",
        paragraphs: [
          "Cross-currency funding is executed at the prevailing exchange rate at the time of the transaction, with the conversion shown to you before you confirm. Conversions are always capped at your available balance so a transaction can never create an overdraft.",
        ],
      },
      {
        heading: "Cards & Instruments",
        paragraphs: [
          "Card issuance, bank-instrument, and settlement-related charges depend on the specific product, tier, and transaction structure. Because these are bespoke, the applicable fees are confirmed with you by your relationship manager or shown on the relevant page before you proceed.",
        ],
      },
    ],
  },
  {
    id: "use-cases",
    number: "13",
    title: "Powerful Use Cases & Best Practices",
    intro:
      "The platform is most powerful when its features work together. These examples and practices help you get the most from your account.",
    subsections: [
      {
        heading: "Example Use Cases",
        bullets: [
          "Centralized multi-currency treasury — hold EUR, USD, GBP, and CHF in one master account and pay any counterparty without pre-funding each currency, letting capped FX cover the difference.",
          "Institutional fund receipt — bring a large incoming transfer onto the platform through the Institutional Desk with MT103/MT202 messaging and full UETR tracking, credited only after authorization.",
          "Commodity spot trade — price a deal against live benchmarks, commit to a spot offer on the board, and have funds reserved automatically against your master account pending Administrator approval.",
          "Proof of Funds on demand — generate a branded Proof of Funds certificate from your real cleared balances for a counterparty, then download it as a PDF.",
          "AI-assisted decisions — ask NQAi to summarize the spot board, explain a benchmark move, or recap your recent activity before you act.",
        ],
      },
      {
        heading: "Best Practices",
        bullets: [
          "Keep beneficiaries up to date so payments route accurately the first time.",
          "Review the cross-currency conversion shown before confirming a payment or deal.",
          "Track requests to authorization on each page — sensitive actions are deliberate, not automatic.",
          "Use Bankeka for platform correspondence so everything stays auditable in one place.",
          "Download PDF receipts and certificates as you go to keep your own records complete.",
        ],
      },
    ],
  },
  {
    id: "platform",
    number: "14",
    title: "Platform & Account Management",
    subsections: [
      {
        heading: "Plans & Pricing",
        paragraphs: [
          "Review the available service plans and their pricing, and understand which features are included at each level.",
        ],
      },
      {
        heading: "Services & Compliance",
        paragraphs: [
          "Access compliance documentation and the regulated services MCC provides, including AML/KYC, FATCA, and CRS standards.",
        ],
      },
      {
        heading: "Client Handbook",
        paragraphs: [
          "Read this complete guide to the platform at any time, and download it as a professionally formatted PDF for offline reference. The handbook always reflects the latest features available to you.",
        ],
      },
      {
        heading: "Administrator Authorization",
        paragraphs: [
          "High-value and institutional activities on the platform are protected by an Administrator authorization step. Outgoing payments, bank instruments, Download of Funds, DTC and Euroclear settlements, commodity deals, leverage lines, and Yield/PPP applications are submitted as requests and only take effect once the Administrator reviews and authorizes them.",
          "This control ensures that no funds move and no position is opened automatically — every sensitive action is verified against its supporting documentation first. You can follow the status of your requests on each respective page.",
        ],
      },
      {
        heading: "Settings",
        paragraphs: [
          "Manage your platform preferences, security options, and notification settings.",
        ],
      },
      {
        heading: "Profile",
        paragraphs: [
          "Review your company and KYC information. To request a change, contact support with supporting documentation.",
        ],
      },
      {
        heading: "Support",
        paragraphs: [
          "Reach the MCC team by email, phone, or in-app live chat, and browse frequently asked questions for quick answers.",
        ],
      },
    ],
  },
  {
    id: "security",
    number: "15",
    title: "Security, Approvals & Data Privacy",
    subsections: [
      {
        heading: "Protecting Your Account",
        bullets: [
          "Never share your password or one-time codes with anyone, including staff.",
          "Always verify beneficiary details before confirming a payment.",
          "Sign out when using shared or public devices.",
          "Contact support immediately if you notice unfamiliar activity.",
        ],
      },
      {
        heading: "The Approval Model",
        paragraphs: [
          "Sensitive actions never execute automatically. Outgoing payments, bank instruments, Download of Funds, DTC and Euroclear settlements, commodity and spot deals, leverage lines, card issuance, and Yield/PPP applications are submitted as requests and only take effect once the Administrator reviews and authorizes them. For sub-accounts, payments additionally require the Master's consent — a two-gate control.",
          "As part of this model, the platform checks fund availability before committing a reservation. If funds are insufficient, the request is declined automatically and you are notified, so no action can ever overdraw your account.",
        ],
      },
      {
        heading: "Regulatory Standards",
        paragraphs: [
          "MCC operates under Swiss fiduciary law and applies full AML, KYC, FATCA, and CRS due diligence. Compliance is monitored on an ongoing basis to protect clients and the integrity of the platform.",
        ],
      },
      {
        heading: "Data Privacy",
        paragraphs: [
          "Your data is scoped strictly to you. Balances, transactions, documents, and the context used by NQAi are assembled securely on the server and are never shared with other clients. Every figure shown across the platform reflects your real account activity — no placeholder or demonstration data is ever displayed.",
        ],
      },
    ],
  },
  {
    id: "support",
    number: "16",
    title: "Help & Contact",
    intro: "If you need assistance at any point, the MCC team is available through the following channels.",
    subsections: [
      {
        heading: "Contact Channels",
        bullets: [
          "Email: support@mcc-capital.com — replies within 24 hours.",
          "Phone: +41 22 000 0000 — Monday to Friday, 09:00–18:00 CET.",
          "Live Chat: available in-app during business hours.",
        ],
      },
      {
        heading: "Office",
        paragraphs: [
          "MCC Holding SA, Rue du Rhône 14, 1204 Geneva, Switzerland.",
        ],
      },
    ],
  },
]
