"use client"

import { useMemo } from "react"
import { useCurrentUser } from "@/lib/use-current-user"
import type { ProfileItem } from "@/lib/users"

/**
 * The account-holder identity block printed at the top of every exported /
 * "extract" document (transaction history, statements, SWIFT log, payments,
 * beneficiary register, instruments register, SKR statement, ...).
 *
 * Centralised here so every export renders a consistent "PREPARED FOR" header
 * and so the address-lookup logic lives in exactly one place.
 */
export interface HolderIdentity {
  holderName?: string
  holderCompany?: string
  holderAddress?: string
}

function findValue(items: ProfileItem[] | undefined, label: string): string | undefined {
  return items?.find((it) => it.label.toLowerCase() === label.toLowerCase())?.value?.trim() || undefined
}

// Address labels are dynamic (many are extracted from an uploaded KYC document),
// so we cannot rely on one fixed label. Look for the best "address" row across
// the profile arrays: prefer an explicit registered / beneficiary / company
// address, then fall back to any label that mentions "address" — while never
// mistaking an "email address" row for a postal address.
function findAddress(...groups: (ProfileItem[] | undefined)[]): string | undefined {
  const all = groups.flatMap((g) => g ?? [])
  const isAddress = (label: string) => {
    const l = label.toLowerCase()
    return l.includes("address") && !l.includes("email") && !l.includes("e-mail")
  }
  const preferred = all.find((it) => {
    const l = it.label.toLowerCase()
    return isAddress(l) && /(registered|beneficiary|company|legal|residential|domicile|operative)/.test(l)
  })
  const chosen = preferred ?? all.find((it) => isAddress(it.label))
  return chosen?.value?.trim() || undefined
}

/**
 * Derive the current signed-in user's holder identity for use in exported PDFs.
 * Returns `undefined` fields (rather than empty strings) when data is missing,
 * so the PDF generators simply omit the corresponding line.
 */
export function useHolderIdentity(): HolderIdentity {
  const user = useCurrentUser()
  return useMemo(() => {
    const { banking, companyInfo, principal, company, fullName } = user
    const holderName = findValue(banking, "Account Holder") || company || fullName || undefined
    const holderCompany = company && company !== holderName ? company : undefined
    const holderAddress = findAddress(banking, companyInfo, principal)
    return { holderName, holderCompany, holderAddress }
  }, [user])
}
