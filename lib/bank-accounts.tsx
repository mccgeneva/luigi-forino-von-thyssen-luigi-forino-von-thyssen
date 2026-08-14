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
import { fetchAccountLimits, type AccountLimits } from "@/app/actions/account-limits"
import { validateIban } from "@/lib/iban-swift"
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
    GB: "🇬🇧",
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

  // Platform-wide account limits (Daily Limit / Monthly Volume) set by the
  // administrator — a single global setting applied to every user's settlement
  // account below, with independent "Unlimited" flags.
  const [accountLimits, setAccountLimits] = useState<AccountLimits | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchAccountLimits()
      .then((l) => {
        if (!cancelled) setAccountLimits(l)
      })
      .catch(() => {
        /* keep the account's own default until the fetch succeeds */
      })
  }, [])

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
    const swift = masterBanking.swift || account.swift
    const bankName = masterBanking.bankName || account.bankName
    // Keep the country/flag consistent with an admin-set IBAN.
    const ibanCheck = masterBanking.iban ? validateIban(masterBanking.iban) : null
    const country = (ibanCheck?.valid ? ibanCheck.countryName : account.country) || account.country
    const countryCode = (ibanCheck?.valid ? ibanCheck.countryCode : account.countryCode) || account.countryCode

    return {
      ...account,
      iban,
      swift,
      bankName,
      bankLogo: masterBanking.bankName ? bankMonogram(masterBanking.bankName) : account.bankLogo,
      country,
      countryCode,
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

  return [...liveBaseAccounts.map(withLimits), ...extraCurrencyAccounts.map(withLimits), ...registered]
}
