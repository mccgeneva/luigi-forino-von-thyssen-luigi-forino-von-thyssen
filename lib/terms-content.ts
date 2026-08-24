// Single source of truth for the platform Terms of Use & User Agreement.
// Shared by the on-screen page (app/dashboard/terms/page.tsx) and the PDF
// generator (lib/terms-pdf.ts) so the two never drift apart.
//
// IMPORTANT — this is an HONEST software Terms of Use. It deliberately does NOT
// present the platform as a licensed bank, does NOT make any upfront/one-time
// fee a condition precedent to a promised payout, and does NOT promise
// guaranteed returns or the delivery of financial instruments. It describes the
// software, the user's rights and obligations, transparent fees, and clear risk
// warnings.

export const TERMS_META = {
  brand: "MCC Capital",
  platform: "MCC Banking & Trade Platform",
  title: "Platform Terms of Use & User Agreement",
  subtitle:
    "The rules governing your access to and use of the platform, written in plain language. Please read them before you use the service.",
  version: "Version 1.0",
  lastUpdated: `Last updated ${new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })}`,
  legalEntity: "MCC Capital — software platform operator",
  address: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  email: "support@mcc-capital.com",
}

export interface TermsSubsection {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
}

export interface TermsSection {
  id: string
  number: string
  title: string
  intro?: string
  subsections: TermsSubsection[]
}

export const TERMS_SECTIONS: TermsSection[] = [
  {
    id: "about",
    number: "01",
    title: "About this agreement",
    intro:
      "This agreement is a contract between you (the “user” or “client”) and the operator of the platform. By creating an account or using the platform you accept these terms.",
    subsections: [
      {
        heading: "What the platform is — and is not",
        paragraphs: [
          "The platform is a software application for managing accounts, viewing balances, initiating transfers, and using the tools made available inside it. It is a technology service.",
          "The platform operator is not a licensed bank, and the platform is not a deposit-taking institution unless and until a specific regulated banking partner is named to you in writing with its own licence and terms. Nothing on the platform should be read as a promise that funds are protected by a deposit-guarantee scheme.",
        ],
        bullets: [
          "The platform provides software tools and account interfaces.",
          "It does not, by itself, constitute a bank, broker-dealer, or investment adviser.",
          "Any regulated service is provided by a named, licensed third party under that party’s own terms.",
        ],
      },
      {
        heading: "Accepting these terms",
        paragraphs: [
          "You must accept these terms to use the platform. If you do not agree with them, do not create an account or use the service. If you use the platform on behalf of an organisation, you confirm you are authorised to bind that organisation.",
        ],
      },
    ],
  },
  {
    id: "eligibility",
    number: "02",
    title: "Eligibility & account registration",
    subsections: [
      {
        heading: "Who may use the platform",
        bullets: [
          "You must be at least 18 years old and legally able to enter into a contract.",
          "You must provide accurate registration details and keep them up to date.",
          "You may be asked to complete identity verification (KYC) before certain features are enabled. Access to features may be limited until verification is complete.",
        ],
      },
      {
        heading: "One account, your responsibility",
        paragraphs: [
          "You are responsible for everything that happens under your account. Keep your login credentials confidential, use a strong password, and notify us immediately if you suspect unauthorised access.",
        ],
      },
    ],
  },
  {
    id: "acceptable-use",
    number: "03",
    title: "Acceptable use",
    intro: "To keep the platform safe for everyone, you agree not to misuse it.",
    subsections: [
      {
        heading: "You must not",
        bullets: [
          "Use the platform for any unlawful purpose, including fraud, money laundering, or sanctions evasion.",
          "Impersonate any person or entity, or misrepresent your identity or affiliation.",
          "Attempt to gain unauthorised access to the platform, other accounts, or its underlying systems.",
          "Upload malware, scrape data at scale, or interfere with the platform’s normal operation.",
          "Use the platform to create, request, or circulate documents intended to mislead a third party about the status of funds, guarantees, or financial instruments.",
        ],
      },
      {
        heading: "Consequences of misuse",
        paragraphs: [
          "We may suspend or close accounts, remove content, and report activity to the relevant authorities where we reasonably believe these rules have been broken.",
        ],
      },
    ],
  },
  {
    id: "fees",
    number: "04",
    title: "Fees & charges",
    intro:
      "Fees are disclosed transparently before you incur them. We never ask for an upfront payment as a precondition for releasing money that is claimed to be owed to you.",
    subsections: [
      {
        heading: "How fees work",
        bullets: [
          "Any fee that applies to a feature is shown to you in the interface before you confirm the action.",
          "Fees are charged for the service actually provided (for example, processing a transfer or maintaining an account).",
          "We do not make a non-refundable upfront fee a condition precedent to receiving a promised payout, credit line, or instrument. Be cautious of anyone — inside or outside this platform — who asks you to do so.",
        ],
      },
      {
        heading: "Currency and conversion",
        paragraphs: [
          "Where a transaction involves currency conversion, the rate and any conversion spread applied are shown at the time of the transaction.",
        ],
      },
    ],
  },
  {
    id: "risk",
    number: "05",
    title: "Leverage, risk & no guarantee of return",
    intro:
      "Some features involve financial risk. This section is a risk warning — read it carefully.",
    subsections: [
      {
        heading: "No guaranteed returns",
        paragraphs: [
          "Nothing on the platform is a promise of profit or a guaranteed rate of return. Any figures shown for potential yield, leverage, or performance are illustrative and are not a commitment. Past performance does not predict future results.",
        ],
      },
      {
        heading: "Leverage increases risk",
        bullets: [
          "Leverage can amplify both gains and losses; you can lose more than your initial margin.",
          "Leveraged and financed positions require you to actually hold the margin or collateral you pledge. Requests without sufficient free collateral are declined.",
          "You are responsible for understanding a product before using it, and for seeking independent professional advice where appropriate.",
        ],
      },
      {
        heading: "Not investment advice",
        paragraphs: [
          "Information and tools on the platform are provided for general purposes and do not constitute investment, legal, tax, or accounting advice.",
        ],
      },
    ],
  },
  {
    id: "data",
    number: "06",
    title: "Your data & privacy",
    subsections: [
      {
        heading: "How we handle your information",
        paragraphs: [
          "We collect and process the information needed to provide the service, verify identity, and meet legal obligations. We apply reasonable technical and organisational measures to protect it.",
          "We do not sell your personal data. Where processing is described in a separate privacy notice, that notice applies alongside these terms.",
        ],
      },
    ],
  },
  {
    id: "liability",
    number: "07",
    title: "Liability & availability",
    subsections: [
      {
        heading: "Service availability",
        paragraphs: [
          "We aim to keep the platform available but do not guarantee uninterrupted access. Features may be changed, suspended, or withdrawn for maintenance, security, or legal reasons.",
        ],
      },
      {
        heading: "Limitation of liability",
        paragraphs: [
          "To the extent permitted by law, we are not liable for indirect or consequential losses, or for losses arising from your breach of these terms, your trading decisions, or events outside our reasonable control. Nothing in these terms excludes liability that cannot lawfully be excluded.",
        ],
      },
    ],
  },
  {
    id: "changes",
    number: "08",
    title: "Suspension, termination & changes",
    subsections: [
      {
        heading: "Ending the relationship",
        bullets: [
          "You may stop using the platform and request account closure at any time, subject to settling any outstanding obligations.",
          "We may suspend or terminate access where these terms are breached, where required by law, or to protect users and the platform.",
        ],
      },
      {
        heading: "Changes to these terms",
        paragraphs: [
          "We may update these terms from time to time. Material changes will be communicated through the platform. Continued use after a change takes effect means you accept the updated terms.",
        ],
      },
    ],
  },
  {
    id: "contact",
    number: "09",
    title: "Governing law & contact",
    subsections: [
      {
        heading: "Governing law",
        paragraphs: [
          "These terms are governed by the laws applicable at the platform operator’s registered seat, without prejudice to any mandatory consumer-protection rights available to you locally.",
        ],
      },
      {
        heading: "How to reach us",
        paragraphs: [
          `Questions about these terms can be sent to ${TERMS_META.email}. Written correspondence can be addressed to ${TERMS_META.brand}, ${TERMS_META.address}.`,
        ],
      },
    ],
  },
]
