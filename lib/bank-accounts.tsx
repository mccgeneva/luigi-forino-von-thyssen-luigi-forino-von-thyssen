"use client"

// ---------------------------------------------------------------------------
// Shared bank-account data, formatting helpers and the live-account builder.
//
// This module is the single source of truth for the client's bank accounts so
// that BOTH the accounts list page and the per-account detail page render the
// exact same data. Balances are overlaid live from the ledger store via the
// useBankAccounts() hook.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react"
import { useLedger } from "@/lib/ledger-store"
import { useServerRequestList } from "@/lib/use-server-request-list"
import { mapApprovalStatus, type ApprovalRecord } from "@/lib/approval-sync"
import { useCurrentUser } from "@/lib/use-current-user"
import { getMyMasterBanking, type MyMasterBanking } from "@/app/actions/admin-users"
  import { type AccountLimits } from "@/app/actions/account-limits"
import { validateIban, lookupBankByIban, isGenericBankInfo, type BankInfo } from "@/lib/iban-swift"
import { useGateway, reconciledTotal, type GatewayAccount } from "@/lib/gateway-store"
import { ACCOUNT_TYPES } from "@/lib/gateway-catalog"
import type { ProfileItem } from "@/lib/users"

export type BankAccount = {
  id: string
  bankName: string
  bankLogo: string
  country: string
  countryCode: string
  rating: string
  accountName: string
  accountNumber: string
  iban: string
  swift: string
  currency: string
  balance: number
  availableBalance: number
  reservedBalance: number
  accountType: string
  status: string
  openDate: string
  lastActivity: string
  dailyLimit: number
  monthlyVolume: number
  /** When true the corresponding figure is uncapped and displays "Unlimited". */
  dailyLimitUnlimited?: boolean
  monthlyVolumeUnlimited?: boolean
  relationship: string
  contactPerson: string
  contactEmail: string
  branchAddress: string
  beneficiaryAddress: string
  sortCode?: string
  routingNumber?: string
  bsb?: string
  branchCode?: string
  escrowDetails?: string
  /**
   * Per-account tracked balance for REGISTERED external accounts only, derived
   * from ledger entries whose `account` (IBAN) matches this account. Lets a
   * client see how much has landed at THIS specific bank. These figures are a
   * subset of the matching currency Settlement Account, so they are NEVER added
   * into the per-currency totals (that would double-count the master balance).
   */
  trackedBalance?: number
  trackedAvailable?: number
  trackedReserved?: number
}

export const baseBankAccounts: BankAccount[] = [
  {
    id: "ACC-001",
    bankName: "Banking Circle - German Branch",
    bankLogo: "BC",
    country: "Germany",
    countryCode: "DE",
    rating: "A",
    accountName: "MCC Capital",
    accountNumber: "0029 2908 19",
    iban: "DE73 2022 0800 0029 2908 19",
    swift: "SXPYDEHHXXX",
    currency: "EUR",
    balance: 0.0,
    availableBalance: 0.0,
    reservedBalance: 0.0,
    accountType: "MCC Capital Bank Account",
    status: "active",
    openDate: "2026-04-24",
    lastActivity: "2026-04-24T18:20:00Z",
    dailyLimit: 0,
    monthlyVolume: 0,
    relationship: "Business Banking",
    contactPerson: "MCC Client Services",
    contactEmail: "admin@mccgva.ch",
    branchAddress: "80333 München, Germany",
    beneficiaryAddress: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  },
]

export const currencyAccountMeta: Record<
  string,
  {
    bankName: string
    bankLogo: string
    country: string
    countryCode: string
    swift: string
    accountType: string
  }
> = {
  USD: {
    bankName: "Banking Circle - US Branch",
    bankLogo: "BC",
    country: "United States",
    countryCode: "US",
    swift: "SXPYUS33XXX",
    accountType: "USD Settlement Account",
  },
  GBP: {
    bankName: "Banking Circle - UK Branch",
    bankLogo: "BC",
    country: "United Kingdom",
    countryCode: "GB",
    swift: "SXPYGB2LXXX",
    accountType: "GBP Settlement Account",
  },
  CHF: {
    bankName: "Banking Circle - Swiss Branch",
    bankLogo: "BC",
    country: "Switzerland",
    countryCode: "CH",
    swift: "SXPYCHGGXXX",
    accountType: "CHF Settlement Account",
  },
  JPY: {
    bankName: "Banking Circle - Japan Branch",
    bankLogo: "BC",
    country: "Japan",
    countryCode: "JP",
    swift: "SXPYJPJTXXX",
    accountType: "JPY Settlement Account",
  },
  AUD: {
    bankName: "Banking Circle - Australia Branch",
    bankLogo: "BC",
    country: "Australia",
    countryCode: "AU",
    swift: "SXPYAU2SXXX",
    accountType: "AUD Settlement Account",
  },
  CAD: {
    bankName: "Banking Circle - Canada Branch",
    bankLogo: "BC",
    country: "Canada",
    countryCode: "CA",
    swift: "SXPYCATTXXX",
    accountType: "CAD Settlement Account",
  },
  SGD: {
    bankName: "Banking Circle - Singapore Branch",
    bankLogo: "BC",
    country: "Singapore",
    countryCode: "SG",
    swift: "SXPYSGSGXXX",
    accountType: "SGD Settlement Account",
  },
}

export const currencySymbols: Record<string, string> = {
  CHF: "CHF",
  EUR: "€",
  USD: "$",
  GBP: "£",
  SGD: "S$",
  JPY: "¥",
  AUD: "A$",
  HKD: "HK$",
  AED: "AED",
}

export function formatCurrency(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || currency
  if (currency === "JPY") {
    return `${symbol}${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  }
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Compact currency for tight cards/tiles where large figures (millions and up)
 * would otherwise overflow. Amounts below 1M render in full (e.g. €100,000.00);
 * 1M+ are abbreviated on a single line (€100M, €1.5B, €2.3T). Always pair with a
 * `title` showing the exact `formatCurrency` value so the full number stays
 * accessible.
 */
export function formatCompactCurrency(amount: number, currency: string): string {
  const symbol = currencySymbols[currency] || currency
  const abs = Math.abs(amount)
  if (abs < 1_000_000) return formatCurrency(amount, currency)
  const units: Array<{ value: number; suffix: string }> = [
    { value: 1_000_000_000_000, suffix: "T" },
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
  ]
  const unit = units.find((u) => abs >= u.value)!
  const scaled = amount / unit.value
  // Up to one decimal, but drop a trailing ".0" (100.0M -> 100M).
  const text = scaled.toLocaleString("en-US", { maximumFractionDigits: 1 })
  return `${symbol}${text}${unit.suffix}`
}

export function getRatingColor(rating: string): string {
  if (rating.startsWith("AAA")) return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
  if (rating.startsWith("AA")) return "bg-green-500/20 text-green-400 border-green-500/30"
  if (rating.startsWith("A")) return "bg-amber-500/20 text-amber-400 border-amber-500/30"
  return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
    case "pending":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30"
    case "restricted":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30"
    case "dormant":
      return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
    case "closed":
      return "bg-red-500/20 text-red-400 border-red-500/30"
    default:
      return "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
  }
}

export function getFlagEmoji(countryCode: string): string {
  const flags: Record<string, string> = {
    CH: "🇨🇭",
    DE: "🇩🇪",
    US: "🇺🇸",
    GB: "🇬����",
    FR: "🇫🇷",
    SG: "🇸🇬",
    JP: "🇯🇵",
    AU: "🇦🇺",
    HK: "🇭🇰",
    AE: "🇦🇪",
  }
  return flags[countryCode] || "🏳️"
}

/**
 * Pull the master account's banking coordinates out of the signed-in user's
 * free-form `profile.banking` rows. This is the SAME record the administrator
 * edits in the Master Accounts panel, so surfacing it here is what makes an
 * admin change to the master account's IBAN / SWIFT / bank name actually show
 * up on the client's master account card. Label matching mirrors the admin-side
 * extractor and is tolerant of the various labels used across the platform.
 */
function extractMasterBanking(banking: ProfileItem[] | undefined): {
  bankName?: string
  iban?: string
  swift?: string
} {
  const rows = banking ?? []
  const find = (test: (label: string) => boolean) => rows.find((r) => test(r.label.toLowerCase()))?.value?.trim()
  const iban = find((l) => l.includes("iban"))
  const swift = find((l) => l.includes("swift") || l.includes("bic"))
  const bankName = find((l) => l.includes("bank") && !l.includes("iban") && !l.includes("swift") && !l.includes("bic"))
  return {
    ...(bankName ? { bankName } : {}),
    ...(iban ? { iban } : {}),
    ...(swift ? { swift } : {}),
  }
}

/** Two-letter monogram from a bank name, e.g. "Banking Circle" → "BC". */
function bankMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "BK"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/**
 * Rebuild a registered BankAccount from a `bank_account` approval record.
 *
 * The client's "Add Bank Account" flow mirrors the form straight into the
 * approval `payload` (flat fields, NOT under `payload.record`), so the admin
 * can review it cross-client. Once the administrator approves it the account
 * must surface back on the client's Bank Accounts page — this mapper is what
 * folds those DB-backed accounts into `useBankAccounts()`.
 *
 * Registered (external) accounts have no platform-tracked ledger balance — the
 * master settlement account (ACC-001) is the only balance-bearing account — so
 * balances are 0 here and never double-count the ledger. Rejected/cancelled
 * registrations are dropped (return null) so a declined request disappears.
 */
function bankAccountFromApproval(rec: ApprovalRecord): BankAccount | null {
  const p = (rec.payload ?? {}) as {
    bankName?: string
    accountName?: string | null
    accountType?: string | null
    country?: string | null
    countryCode?: string | null
    iban?: string | null
    swift?: string | null
    currency?: string | null
    accountNumber?: string | null
    dailyLimit?: number | null
    rating?: string | null
    branchAddress?: string | null
  }
  const status = mapApprovalStatus(rec.status, { approvedStatus: "active" })
  // Only registered (approved) or in-review (pending) accounts belong on the
  // client's list; declined/withdrawn ones are hidden.
  if (status !== "active" && status !== "pending") return null
  if (!p.bankName) return null

  return {
    id: rec.id,
    bankName: p.bankName,
    bankLogo: bankMonogram(p.bankName),
    country: p.country || "—",
    countryCode: p.countryCode || "",
    rating: p.rating || "NR",
    accountName: p.accountName || "—",
    accountNumber: p.accountNumber || "—",
    iban: p.iban || "—",
    swift: p.swift || "—",
    currency: p.currency || "EUR",
    balance: 0,
    availableBalance: 0,
    reservedBalance: 0,
    accountType: p.accountType || "Registered Account",
    status,
    openDate: (rec.decidedAt ?? rec.createdAt ?? new Date().toISOString()).slice(0, 10),
    lastActivity: rec.decidedAt ?? rec.createdAt ?? new Date().toISOString(),
    dailyLimit: p.dailyLimit ?? 0,
    monthlyVolume: 0,
    relationship: "Business Banking",
    contactPerson: "MCC Client Services",
    contactEmail: "admin@mccgva.ch",
    branchAddress: p.branchAddress || p.country || "—",
    beneficiaryAddress: "Rue du Rhone 14, 1204 Geneva, Switzerland",
  }
}

/**
 * Rebuild a BankAccount from an APPROVED Payment Gateway account.
 *
 * When a client adds an account through the Payment Gateway and the
 * administrator approves it, partner-bank coordinates (IBAN / BIC / remittance
 * reference) are assigned. That approved account must then surface on the
 * client's Bank Accounts page automatically — this mapper folds it in alongside
 * the master settlement accounts and any "Add Bank Account" registrations.
 *
 * Only ACTIVE (approved) gateway accounts are mapped; pending / rejected /
 * closed ones stay in the Payment Gateway view until they are approved. Inbound
 * funds collected at the gateway are reconciled into the Master Account ledger,
 * so the per-account "received" figure is surfaced on the `tracked*` fields and
 * kept OUT of the currency totals (balance stays 0) to avoid double-counting the
 * master balance — the same rule used for registered external accounts.
 */
function bankAccountFromGateway(gw: GatewayAccount): BankAccount | null {
  if (gw.status !== "active") return null
  const c = gw.coordinates
  const bankName = c?.partnerBankName || "Payment Gateway Partner Bank"
  const iban = c?.iban || ""
  const ibanCheck = iban ? validateIban(iban) : null
  const country = (ibanCheck?.valid ? ibanCheck.countryName : "") || "—"
  const countryCode = (ibanCheck?.valid ? ibanCheck.countryCode : "") || ""
  const received = reconciledTotal(gw)
  const typeLabel = ACCOUNT_TYPES[gw.type]?.label ?? "Payment Gateway Account"
  const decided = gw.decidedAt ?? gw.submittedAt ?? new Date().toISOString()

  return {
    id: gw.id,
    bankName,
    bankLogo: bankMonogram(bankName),
    country,
    countryCode,
    rating: "NR",
    accountName: gw.company || gw.accountHolder || "—",
    accountNumber: c?.accountNumber || c?.routingNumber || c?.reference || "—",
    iban: iban || "—",
    swift: c?.bic || "—",
    currency: gw.currency,
    balance: 0,
    availableBalance: 0,
    reservedBalance: 0,
    accountType: typeLabel,
    status: "active",
    openDate: decided.slice(0, 10),
    lastActivity: decided,
    dailyLimit: 0,
    monthlyVolume: 0,
    relationship: "Payment Gateway",
    contactPerson: "MCC Client Services",
    contactEmail: "admin@mccgva.ch",
    branchAddress: country,
    beneficiaryAddress: "Rue du Rhone 14, 1204 Geneva, Switzerland",
    escrowDetails: c?.reference ? `Inbound remittance reference: ${c.reference}` : undefined,
    trackedBalance: received,
    trackedAvailable: received,
    trackedReserved: 0,
  }
}

/**
 * Build the client's full account list with live ledger balances overlaid.
 * The master EUR account reflects the live ledger balance; every additional
 * currency the client holds surfaces a dedicated settlement account. Accounts
 * the client registered via "Add Bank Account" (and the admin approved) are
 * folded in from the DB-backed approvals backbone so they actually appear here.
 */
/** Normalise an IBAN/account string for comparison: strip non-alphanumerics,
 *  uppercase. So "CH57 0024 03OJ …" matches a ledger entry tagged "CH5700240..". */
export function normalizeAccountRef(value: string | undefined | null): string {
  return (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase()
}

export function useBankAccounts(): BankAccount[] {
  const { balanceFor, reservedFor, currencies, entries } = useLedger()
  // The client's Payment Gateway accounts. Once the administrator APPROVES a
  // gateway request it becomes "active" with assigned bank coordinates, and it
  // is folded into the list below so it appears here automatically — no manual
  // re-entry needed. Read from the shared gateway store (GatewayProvider wraps
  // the dashboard), which polls/refreshes on focus so an approval in another
  // session shows up without a reload.
  const { accounts: gatewayAccounts } = useGateway()
  // Banking coordinates overlaid onto the master account (ACC-001). These MUST
  // come from the session's data owner — i.e. the MASTER account — not the
  // signed-in user's own profile. For a joint/sub account the administrator
  // edits only the Master's banking rows, so reading the master (via the
  // server action) is what makes the change appear for EVERY member of the
  // shared environment (e.g. both members of a joint account), not just the
  // account that happens to be the master.
  const currentUser = useCurrentUser()
  const [resolvedMaster, setResolvedMaster] = useState<MyMasterBanking | null>(null)
  useEffect(() => {
    let cancelled = false
    getMyMasterBanking()
      .then((b) => {
        if (!cancelled) setResolvedMaster(b)
      })
      .catch(() => {
        // Transient failure — keep the own-profile fallback below.
      })
  }, [currentUser.id])
  // Use the resolved master once available; until then fall back to the user's
  // own banking rows so the card is never blank on first paint.
  const masterBanking: { bankName?: string; iban?: string; swift?: string } =
    resolvedMaster && (resolvedMaster.iban || resolvedMaster.swift || resolvedMaster.bankName)
      ? resolvedMaster
      : extractMasterBanking(currentUser.banking)

  // Resolve the bank identity (name / BIC / city / street address) FROM the
  // master IBAN so every displayed coordinate stays consistent with the IBAN's
  // country. Without this the master card kept the hardcoded German-branch
  // address, SWIFT and name (ACC-001 defaults) even when the admin set, e.g., a
  // Luxembourg IBAN — showing a München/Germany address on a LU account.
  const [masterBankInfo, setMasterBankInfo] = useState<BankInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    const iban = masterBanking.iban
    if (!iban || !validateIban(iban).valid) {
      setMasterBankInfo(null)
      return
    }
    lookupBankByIban(iban)
      .then((info) => {
        if (!cancelled) setMasterBankInfo(info)
      })
      .catch(() => {
        if (!cancelled) setMasterBankInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [masterBanking.iban])

  // Account limits (Daily Limit / Monthly Volume) set by the administrator.
  // Resolved server-side to this user's EFFECTIVE limits: their per-user
  // override if the admin set one, otherwise the platform-wide default. Each
  // figure carries an independent "Unlimited" flag.
  const [accountLimits, setAccountLimits] = useState<AccountLimits | null>(null)
  useEffect(() => {
    let cancelled = false
    // Read via the /api/account-limits route (NOT the fetchAccountLimits Server
    // Action). The action POSTs to /dashboard/* and is intercepted by the
    // session proxy, which 401s it whenever the signed meta cookie looks
    // stale/idle (common in the preview and on a resumed PWA); that failure was
    // silently swallowed, leaving the card showing a bare 0 even when the admin
    // had set Unlimited. The API route bypasses the proxy and always returns
    // real JSON, so the effective limits (per-user override or global default)
    // reliably reach the account card.
    fetch("/api/account-limits", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.ok && data.limits) setAccountLimits(data.limits as AccountLimits)
      })
      .catch(() => {
        /* keep the account's own default until the fetch succeeds */
      })
    return () => {
      cancelled = true
    }
  }, [currentUser.id])

  // Per-registered-account tracked balance: sum the ledger entries whose
  // counterparty `account` (IBAN) matches the registered account. Completed
  // credits add, completed debits subtract, held debits reserve. This is the
  // "money received at THIS bank" view; the same entries also feed the currency
  // Settlement Account, so the master balance reflects them automatically.
  const trackedFor = (iban: string, currency: string) => {
    const target = normalizeAccountRef(iban)
    if (!target) return { balance: 0, available: 0, reserved: 0 }
    const mine = entries.filter((e) => {
      if (e.currency !== currency) return false
      // Prefer the explicit receiving-account tag. Fall back to the legacy
      // `account` field for entries posted before per-bank attribution existed
      // (where the receiving IBAN was stored there).
      if (e.receivedAccount) return normalizeAccountRef(e.receivedAccount) === target
      return normalizeAccountRef(e.account) === target
    })
    const settled = mine
      .filter((e) => e.status === "completed")
      .reduce((sum, e) => sum + (e.direction === "credit" ? e.amount : -e.amount), 0)
    const reserved = mine
      .filter((e) => e.status === "hold" && e.direction === "debit")
      .reduce((sum, e) => sum + e.amount, 0)
    return { balance: settled, available: settled - reserved, reserved }
  }
  // The signed-in client's own bank-account registrations, sourced from Neon
  // (approved → active, pending → in review). Scoped to this user by the
  // approvals API, polled/refreshed like every other request list.
  const { records: registeredAccounts } = useServerRequestList<BankAccount>("bank_account", {
    fromApproval: bankAccountFromApproval,
  })

  const liveBaseAccounts = baseBankAccounts.map((account) => {
    if (account.id !== "ACC-001") return account
    // balanceFor() is the AVAILABLE (spendable) balance — it already excludes
    // funds on hold. Total = available + reserved, so the three figures add up
    // and the reserved hold (e.g. a commodity-deal block) is reflected here.
    const available = balanceFor(account.currency)
    const reserved = reservedFor(account.currency)

    // Overlay the admin-configured banking coordinates. Only the display
    // coordinates are overridden — the currency and live ledger balances are
    // left untouched, so the master settlement balance model is unaffected.
    const iban = masterBanking.iban || account.iban
    // Keep the country/flag consistent with an admin-set IBAN.
    const ibanCheck = masterBanking.iban ? validateIban(masterBanking.iban) : null
    const country = (ibanCheck?.valid ? ibanCheck.countryName : account.country) || account.country
    const countryCode = (ibanCheck?.valid ? ibanCheck.countryCode : account.countryCode) || account.countryCode
    // When the admin set an IBAN in a DIFFERENT country than the ACC-001
    // defaults (Germany), the hardcoded German SWIFT / bank name / München
    // address must NOT survive — they would contradict the IBAN. Prefer explicit
    // admin values, then the bank resolved FROM the IBAN, and only fall back to
    // the base account's coordinates when the IBAN country still matches it.
    const ibanCountryChanged = !!(ibanCheck?.valid && ibanCheck.countryCode && ibanCheck.countryCode !== account.countryCode)
    // Only use the resolved bank as a real identity (name / BIC / street) when it
    // is a confident directory match — a generic IBAN-structure fallback carries
    // no usable name/address and must not be shown.
    const resolvedBank = masterBankInfo && !isGenericBankInfo(masterBankInfo) ? masterBankInfo : null
    const swift = masterBanking.swift || resolvedBank?.bic || (ibanCountryChanged ? "" : account.swift)
    const bankName =
      masterBanking.bankName ||
      resolvedBank?.name ||
      (ibanCountryChanged ? `Master Settlement Account (${country})` : account.bankName)
    // Build a branch address consistent with the IBAN. Use the resolved bank's
    // street address when known, otherwise at least the IBAN's country — never
    // the hardcoded München/Germany line on a non-German IBAN.
    const resolvedAddress = resolvedBank
      ? [resolvedBank.address, [resolvedBank.postalCode, resolvedBank.city].filter(Boolean).join(" "), resolvedBank.country]
          .filter((part) => part && part.trim())
          .join(", ")
      : ""
    const branchAddress = resolvedAddress || (ibanCountryChanged ? country : account.branchAddress)

    return {
      ...account,
      iban,
      swift,
      bankName,
      bankLogo: bankName ? bankMonogram(bankName) : account.bankLogo,
      country,
      countryCode,
      branchAddress,
      balance: available + reserved,
      availableBalance: available,
      reservedBalance: reserved,
    }
  })

  const baseCurrencies = new Set(baseBankAccounts.map((a) => a.currency))
  const extraCurrencyAccounts = currencies
    .filter((cur) => !baseCurrencies.has(cur) && currencyAccountMeta[cur])
    .map((cur) => {
      const meta = currencyAccountMeta[cur]
      // Same model as the master account: available is net of holds, total adds
      // the reserved amount back so reserved funds surface per currency.
      const available = balanceFor(cur)
      const reserved = reservedFor(cur)
      return {
        id: `ACC-${cur}`,
        bankName: meta.bankName,
        bankLogo: meta.bankLogo,
        country: meta.country,
        countryCode: meta.countryCode,
        rating: "A",
        accountName: "MCC Capital",
        accountNumber: `${cur}-2908 19`,
        iban: "—",
        swift: meta.swift,
        currency: cur,
        balance: available + reserved,
        availableBalance: available,
        reservedBalance: reserved,
        accountType: meta.accountType,
        status: "active",
        openDate: "2026-04-24",
        lastActivity: new Date().toISOString(),
        dailyLimit: 0,
        monthlyVolume: 0,
        relationship: "Business Banking",
        contactPerson: "MCC Client Services",
        contactEmail: "admin@mccgva.ch",
        branchAddress: meta.country,
        beneficiaryAddress: "Rue du Rhone 14, 1204 Geneva, Switzerland",
      }
    })

  // De-dupe against any currency-derived settlement account id, then append the
  // client's registered accounts (newest-first as returned by the API).
  const existingIds = new Set([
    ...liveBaseAccounts.map((a) => a.id),
    ...extraCurrencyAccounts.map((a) => a.id),
  ])
  const registered = registeredAccounts
    .filter((a) => !existingIds.has(a.id))
    .map((a) => {
      // Overlay the per-account tracked balance (kept on dedicated `tracked*`
      // fields so balance/availableBalance stay 0 and the currency totals never
      // double-count the Settlement Account that holds the same funds).
      const t = trackedFor(a.iban, a.currency)
      return {
        ...a,
        trackedBalance: t.balance,
        trackedAvailable: t.available,
        trackedReserved: t.reserved,
      }
    })

  // Apply the global admin-configured limits to the platform SETTLEMENT
  // accounts (the master account ACC-001 and each per-currency account). These
  // are the "MCC Capital" accounts every user operates under, so the same
  // platform-wide Daily Limit / Monthly Volume shows for all users. Registered
  // external accounts keep their own values. Skipped until the limits load.
  const withLimits = (account: BankAccount): BankAccount => {
    if (!accountLimits) return account
    const isSettlement = account.id === "ACC-001" || account.id.startsWith("ACC-")
    if (!isSettlement) return account
    return {
      ...account,
      dailyLimit: accountLimits.dailyLimitUnlimited ? 0 : accountLimits.dailyLimitAmount,
      dailyLimitUnlimited: accountLimits.dailyLimitUnlimited,
      monthlyVolume: accountLimits.monthlyVolumeUnlimited ? 0 : accountLimits.monthlyVolumeAmount,
      monthlyVolumeUnlimited: accountLimits.monthlyVolumeUnlimited,
    }
  }

  // Approved Payment Gateway accounts, mapped into BankAccount cards and
  // de-duped against everything already assembled (settlement + registered).
  const priorIds = new Set([...existingIds, ...registered.map((a) => a.id)])
  const gatewayBankAccounts = gatewayAccounts
    .map(bankAccountFromGateway)
    .filter((a): a is BankAccount => a !== null)
    .filter((a) => !priorIds.has(a.id))

  return [
    ...liveBaseAccounts.map(withLimits),
    ...extraCurrencyAccounts.map(withLimits),
    ...registered,
    ...gatewayBankAccounts,
  ]
}
