"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  LayoutDashboard,
  ArrowLeftRight,
  CreditCard,
  FileText,
  TrendingUp,
  DollarSign,
  Building2,
  Shield,
  Settings,
  HelpCircle,
  Landmark,
  Globe,
  Users,
  Cpu,
  BookOpen,
  ShieldCheck,
  ArrowDownLeft,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useBeneficiaries } from "@/lib/beneficiaries-store"
import { useLedger } from "@/lib/ledger-store"
import { useIsAdmin } from "@/lib/use-current-user"

interface PageEntry {
  title: string
  href: string
  icon: LucideIcon
  keywords?: string
  /** Only surfaced for authorized administrators. */
  adminOnly?: boolean
}

const pages: PageEntry[] = [
  { title: "Overview", href: "/dashboard", icon: LayoutDashboard, keywords: "home dashboard" },
  { title: "Payments & Payees", href: "/dashboard/payments", icon: ArrowLeftRight, keywords: "send pay transfer payment request" },
  { title: "Beneficiaries", href: "/dashboard/beneficiaries", icon: Users, keywords: "payee recipient" },
  { title: "Transactions", href: "/dashboard/transactions", icon: CreditCard, keywords: "history ledger statement" },
  { title: "Live FX Rates", href: "/dashboard/exchange", icon: DollarSign, keywords: "exchange currency forex" },
  { title: "Bank Accounts", href: "/dashboard/accounts", icon: Building2, keywords: "iban balance" },
  { title: "Cards", href: "/dashboard/cards", icon: CreditCard, keywords: "debit credit card" },
  { title: "NAFTAhub Trading", href: "/dashboard/trading", icon: Cpu, keywords: "nqai trade markets" },
  { title: "SWIFT Services", href: "/dashboard/swift", icon: Globe, keywords: "wire mt103" },
  { title: "Bank Instruments", href: "/dashboard/instruments", icon: FileText, keywords: "sblc bg lc guarantee" },
  { title: "Yield / PPP", href: "/dashboard/ppp", icon: TrendingUp, keywords: "program returns" },
  { title: "Fiduciary & Assets", href: "/dashboard/fiduciary", icon: Landmark, keywords: "custody trust" },
  { title: "Plans & Pricing", href: "/dashboard/plans", icon: DollarSign, keywords: "subscription tier" },
  { title: "Services & Compliance", href: "/dashboard/services", icon: Shield, keywords: "kyc aml" },
  { title: "Client Handbook", href: "/dashboard/handbook", icon: BookOpen, keywords: "guide manual pdf" },
  { title: "Administrator", href: "/dashboard/admin", icon: ShieldCheck, keywords: "approve reject admin", adminOnly: true },
  { title: "Settings", href: "/dashboard/settings", icon: Settings, keywords: "preferences account" },
  { title: "Support", href: "/dashboard/support", icon: HelpCircle, keywords: "help contact" },
]

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { beneficiaries } = useBeneficiaries()
  const { entries } = useLedger()
  const isAdmin = useIsAdmin()

  // Hide admin-only pages from non-admins. UX filter only — the route is gated
  // on the server regardless.
  const visiblePages = useMemo(() => pages.filter((p) => !p.adminOnly || isAdmin), [isAdmin])

  // Open on Cmd/Ctrl+K.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  const transactions = useMemo(
    () =>
      entries.slice(0, 50).map((e) => ({
        id: e.id,
        counterparty: e.counterparty,
        reference: e.reference ?? "",
        category: e.category ?? "",
        direction: e.direction,
        label: `${e.direction === "credit" ? "+" : "-"}${e.currency} ${e.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      })),
    [entries],
  )

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      {/* Desktop trigger (looks like a search field) */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden md:flex flex-1 max-w-md items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/70"
        aria-label="Open search"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Search transactions, beneficiaries...</span>
        <kbd className="pointer-events-none hidden lg:inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      {/* Mobile trigger */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open search"
      >
        <Search className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <Command
            filter={(value, search, keywords) => {
              const haystack = `${value} ${(keywords ?? []).join(" ")}`.toLowerCase()
              return haystack.includes(search.toLowerCase()) ? 1 : 0
            }}
          >
            <CommandInput placeholder="Search transactions, beneficiaries, pages..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>

              <CommandGroup heading="Pages">
                {visiblePages.map((p) => (
                  <CommandItem
                    key={p.href}
                    value={p.title}
                    keywords={p.keywords ? [p.keywords] : undefined}
                    onSelect={() => go(p.href)}
                  >
                    <p.icon className="mr-2 h-4 w-4 text-muted-foreground" />
                    <span>{p.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>

              {beneficiaries.length > 0 && (
                <CommandGroup heading="Beneficiaries">
                  {beneficiaries.map((b) => (
                    <CommandItem
                      key={b.id}
                      value={`beneficiary ${b.name} ${b.alias ?? ""} ${b.bankName} ${b.beneficiaryCountry}`}
                      onSelect={() => go("/dashboard/beneficiaries")}
                    >
                      <Users className="mr-2 h-4 w-4 text-muted-foreground" />
                      <div className="flex flex-col">
                        <span>{b.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {b.bankName} · {b.currency}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {transactions.length > 0 && (
                <CommandGroup heading="Transactions">
                  {transactions.map((t) => (
                    <CommandItem
                      key={t.id}
                      value={`transaction ${t.counterparty} ${t.reference} ${t.category} ${t.id}`}
                      onSelect={() => go("/dashboard/transactions")}
                    >
                      {t.direction === "credit" ? (
                        <ArrowDownLeft className="mr-2 h-4 w-4 text-green-500" />
                      ) : (
                        <ArrowUpRight className="mr-2 h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="flex flex-1 flex-col">
                        <span>{t.counterparty}</span>
                        <span className="text-xs text-muted-foreground">
                          {t.reference || t.category || t.id}
                        </span>
                      </div>
                      <span
                        className={
                          t.direction === "credit"
                            ? "text-xs font-medium text-green-500"
                            : "text-xs font-medium text-foreground"
                        }
                      >
                        {t.label}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
