/**
 * Canonical catalogue of the dashboard's client-facing sections, plus the pure
 * logic that decides whether the signed-in user may enter a given section.
 *
 * Two independent layers combine into the effective access for a section:
 *
 *  1. TIER default (Visitor vs PRO / Avant-Garde). A Visitor may only use the
 *     small `VISITOR_ALLOWED_KEYS` set; every other section is tier-locked.
 *     Non-Visitor tiers may use everything by default.
 *
 *  2. Per-user ADMINISTRATOR override (persisted in Neon, see
 *     lib/section-access-db.ts). For any user the administrator can force a
 *     section to:
 *       - "locked"   → blocked no matter the tier ("You are not allowed…").
 *       - "unlocked" → allowed no matter the tier. This is what lets an admin
 *         grant a Visitor full access to a specific section.
 *     No override row → fall back to the tier default.
 *
 * This module is intentionally free of any server-only / React imports so it can
 * be shared by the client gate, the admin panel, and server code alike.
 */

export type SectionOverride = "locked" | "unlocked"

/** Per-user map of section key → administrator override. Absent keys use the
 *  tier default. */
export type SectionAccessMap = Record<string, SectionOverride>

/** The effective result of evaluating a section for a specific user. */
export type SectionAccessResult =
  | "allowed"
  | "admin-locked" // explicitly blocked by an administrator for this user
  | "tier-locked" // blocked because a Visitor tier does not include it

export interface DashboardSection {
  /** Stable key used as the persisted override id (last route segment, or
   *  "overview" for the dashboard root). */
  key: string
  /** Human label shown in the admin panel. */
  label: string
  /** The route this section owns. Matched exactly for the overview and by
   *  prefix (including nested routes) for everything else. */
  path: string
  /** Grouping shown in the admin panel (mirrors the sidebar groups). */
  group: string
}

/**
 * Every client-facing section. The Administrator area (`/dashboard/admin`) is
 * deliberately excluded — it is admin-only and never a client section to lock.
 * Order and grouping mirror the sidebar so the admin panel reads naturally.
 */
export const DASHBOARD_SECTIONS: DashboardSection[] = [
  { key: "nqai", label: "NQAi Co-Pilot", path: "/dashboard/nqai", group: "Terminal" },
  { key: "console", label: "Trading Console", path: "/dashboard/console", group: "Terminal" },

  { key: "overview", label: "Overview", path: "/dashboard", group: "Banking" },
  { key: "bankeka", label: "Bankeka Messenger", path: "/dashboard/bankeka", group: "Banking" },
  { key: "payments", label: "Payments & Payees", path: "/dashboard/payments", group: "Banking" },
  { key: "send", label: "Send Money", path: "/dashboard/send", group: "Banking" },
  { key: "beneficiaries", label: "Beneficiaries", path: "/dashboard/beneficiaries", group: "Banking" },
  { key: "transactions", label: "Transactions", path: "/dashboard/transactions", group: "Banking" },
  { key: "statements", label: "Statements", path: "/dashboard/statements", group: "Banking" },
  { key: "certificates", label: "Certificates", path: "/dashboard/certificates", group: "Banking" },
  { key: "exchange", label: "Live FX Rates", path: "/dashboard/exchange", group: "Banking" },
  { key: "accounts", label: "Bank Accounts", path: "/dashboard/accounts", group: "Banking" },
  { key: "sub-accounts", label: "Sub-Accounts", path: "/dashboard/sub-accounts", group: "Banking" },
  { key: "equity-saving", label: "Equity Saving", path: "/dashboard/equity-saving", group: "Banking" },
  { key: "gateway", label: "Payment Gateway", path: "/dashboard/gateway", group: "Banking" },
  { key: "cards", label: "Cards", path: "/dashboard/cards", group: "Banking" },

  { key: "funding", label: "AES Project Funding", path: "/dashboard/funding", group: "Project Funding" },
  { key: "debits", label: "Debits & Financing", path: "/dashboard/debits", group: "Project Funding" },

  { key: "trading", label: "NAFTAhub Trading", path: "/dashboard/trading", group: "Trading & Instruments" },
  { key: "swift", label: "SWIFT Services", path: "/dashboard/swift", group: "Trading & Instruments" },
  { key: "instruments", label: "Bank Instruments", path: "/dashboard/instruments", group: "Trading & Instruments" },
  { key: "skr", label: "SKR Trading", path: "/dashboard/skr", group: "Trading & Instruments" },
  { key: "institutional", label: "Institutional Desk", path: "/dashboard/institutional", group: "Trading & Instruments" },
  { key: "dtc", label: "Securities Settlement", path: "/dashboard/dtc", group: "Trading & Instruments" },
  { key: "euroclear", label: "Euroclear Settlement", path: "/dashboard/euroclear", group: "Trading & Instruments" },
  { key: "commodity", label: "Commodity Trading", path: "/dashboard/commodity", group: "Trading & Instruments" },
  { key: "leverage", label: "Leverage & Risk", path: "/dashboard/leverage", group: "Trading & Instruments" },
  { key: "treasury", label: "Treasury Services", path: "/dashboard/treasury", group: "Trading & Instruments" },
  { key: "ppp", label: "Yield / PPP", path: "/dashboard/ppp", group: "Trading & Instruments" },
  { key: "fiduciary", label: "Fiduciary & Assets", path: "/dashboard/fiduciary", group: "Trading & Instruments" },

  { key: "network", label: "My Network", path: "/dashboard/network", group: "Platform" },
  { key: "plans", label: "Plans & Pricing", path: "/dashboard/plans", group: "Platform" },
  { key: "services", label: "Services & Compliance", path: "/dashboard/services", group: "Platform" },
  { key: "handbook", label: "Client Handbook", path: "/dashboard/handbook", group: "Platform" },
  { key: "settings", label: "Settings", path: "/dashboard/settings", group: "Platform" },
  { key: "support", label: "Support", path: "/dashboard/support", group: "Platform" },
]

const SECTION_BY_KEY = new Map(DASHBOARD_SECTIONS.map((s) => [s.key, s]))

/**
 * Sections a Visitor (pre-subscription) account may fully use WITHOUT any admin
 * override: payments in/out, the NQAi console, Bankeka Messenger, the overview,
 * their own bank accounts (so they can view their per-currency IBAN/SWIFT
 * details) and Plans (so they can actually upgrade). Everything else is
 * tier-locked for a Visitor unless an administrator explicitly unlocks it.
 */
export const VISITOR_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "overview",
  "nqai",
  "bankeka",
  "payments",
  "send",
  "accounts",
  "plans",
])

/**
 * Resolve which section a pathname belongs to. The overview owns `/dashboard`
 * exactly (so it never swallows the whole dashboard); every other section owns
 * its route and any nested route beneath it. Returns null for routes that are
 * not a lockable client section (e.g. the Administrator area) — those are never
 * gated by this system.
 */
export function resolveSectionKeyForPath(pathname: string): string | null {
  // Most specific first: any non-overview section whose path is a prefix.
  for (const section of DASHBOARD_SECTIONS) {
    if (section.key === "overview") continue
    if (pathname === section.path || pathname.startsWith(`${section.path}/`)) {
      return section.key
    }
  }
  if (pathname === "/dashboard") return "overview"
  return null
}

export function getSectionByKey(key: string): DashboardSection | undefined {
  return SECTION_BY_KEY.get(key)
}

/**
 * Pure evaluation of a user's access to the section that owns `pathname`.
 *
 * Precedence: an explicit administrator override always wins over the tier
 * default. Unknown routes (no owning section) are always allowed so this gate
 * never blocks a page it doesn't manage.
 */
export function evaluateSectionAccess(
  pathname: string,
  isVisitor: boolean,
  overrides: SectionAccessMap,
): SectionAccessResult {
  const key = resolveSectionKeyForPath(pathname)
  if (!key) return "allowed"

  // A Visitor can ALWAYS use their baseline sections — their own bank accounts,
  // payments in/out, Bankeka Messenger, the NQAi console, the overview and Plans
  // (so they can always view their per-currency account details and upgrade).
  // A stale or accidental administrator "locked" override must never hide one of
  // these from a Visitor, so this wins over any override for baseline sections.
  if (isVisitor && VISITOR_ALLOWED_KEYS.has(key)) return "allowed"

  const override = overrides[key]
  if (override === "locked") return "admin-locked"
  if (override === "unlocked") return "allowed"

  // No administrator override → fall back to the tier default.
  if (isVisitor) return "tier-locked"
  return "allowed"
}
