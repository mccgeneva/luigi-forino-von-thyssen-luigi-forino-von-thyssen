"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  ArrowLeftRight,
  Send,
  CreditCard,
  FileText,
  TrendingUp,
  DollarSign,
  Building2,
  Shield,
  Settings,
  HelpCircle,
  ChevronDown,
  Landmark,
  Globe,
  Users,
  Cpu,
  BookOpen,
  ShieldCheck,
  Banknote,
  Layers,
  Ship,
  Gauge,
  ScrollText,
  Award,
  LogOut,
  MessageSquareText,
  Network,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SheetClose } from "@/components/ui/sheet"
import { useIsAdmin } from "@/lib/use-current-user"

type NavItem = {
  title: string
  href: string
  icon: LucideIcon
  badge?: string
  /** Only rendered for authorized administrators. */
  adminOnly?: boolean
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: "Banking",
    items: [
        { title: "Overview", href: "/dashboard", icon: LayoutDashboard },
        { title: "Bankeka Messenger", href: "/dashboard/bankeka", icon: MessageSquareText, badge: "BBM" },
        { title: "Payments & Payees", href: "/dashboard/payments", icon: ArrowLeftRight },
      { title: "Send Money", href: "/dashboard/send", icon: Send, badge: "P2P" },
      { title: "Beneficiaries", href: "/dashboard/beneficiaries", icon: Users },
      { title: "Transactions", href: "/dashboard/transactions", icon: CreditCard },
      { title: "Statements", href: "/dashboard/statements", icon: ScrollText, badge: "PDF" },
      { title: "Certificates", href: "/dashboard/certificates", icon: Award, badge: "Official" },
      { title: "Live FX Rates", href: "/dashboard/exchange", icon: DollarSign },
      { title: "Bank Accounts", href: "/dashboard/accounts", icon: Building2 },
      { title: "Sub-Accounts", href: "/dashboard/sub-accounts", icon: Layers, badge: "PRO" },
      { title: "Payment Gateway", href: "/dashboard/gateway", icon: Globe, badge: "IBAN" },
      { title: "Cards", href: "/dashboard/cards", icon: CreditCard },
    ],
  },
  {
    label: "Project Funding",
    items: [
      { title: "AES Project Funding", href: "/dashboard/funding", icon: Building2, badge: "AES" },
      { title: "Debits & Financing", href: "/dashboard/debits", icon: Wallet, badge: "Calendar" },
    ],
  },
  {
    label: "Trading & Instruments",
    items: [
      { title: "NAFTAhub Trading", href: "/dashboard/trading", icon: Cpu, badge: "NQAi" },
      { title: "SWIFT Services", href: "/dashboard/swift", icon: Globe },
      { title: "Bank Instruments", href: "/dashboard/instruments", icon: FileText, badge: "New" },
      { title: "SKR Trading", href: "/dashboard/skr", icon: ShieldCheck, badge: "SKR" },
      { title: "Institutional Desk", href: "/dashboard/institutional", icon: Banknote, badge: "DOF" },
      { title: "Securities Settlement", href: "/dashboard/dtc", icon: Layers, badge: "DTC" },
      { title: "Euroclear Settlement", href: "/dashboard/euroclear", icon: Landmark, badge: "ICSD" },
      { title: "Commodity Trading", href: "/dashboard/commodity", icon: Ship, badge: "POP/POF" },
      { title: "Leverage & Risk", href: "/dashboard/leverage", icon: Gauge, badge: "1:30" },
      { title: "Treasury Services", href: "/dashboard/treasury", icon: ShieldCheck, badge: "Deposit" },
      { title: "Yield / PPP", href: "/dashboard/ppp", icon: TrendingUp },
      { title: "Fiduciary & Assets", href: "/dashboard/fiduciary", icon: Landmark },
    ],
  },
  {
    label: "Platform",
    items: [
      { title: "My Network", href: "/dashboard/network", icon: Network },
      { title: "Plans & Pricing", href: "/dashboard/plans", icon: DollarSign },
      { title: "Services & Compliance", href: "/dashboard/services", icon: Shield },
      { title: "Client Handbook", href: "/dashboard/handbook", icon: BookOpen },
      { title: "Administrator", href: "/dashboard/admin", icon: ShieldCheck, adminOnly: true },
      { title: "Settings", href: "/dashboard/settings", icon: Settings },
      { title: "Support", href: "/dashboard/support", icon: HelpCircle },
    ],
  },
]

export function MobileSidebar() {
  const pathname = usePathname()
  const isAdmin = useIsAdmin()

  // Hide admin-only destinations (e.g. Administrator) from non-admins. UX filter
  // only — the admin routes are independently gated on the server.
  const visibleNavGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || isAdmin),
    }))
    .filter((group) => group.items.length > 0)

  // Open every group by default so all destinations (Send Money, Internal Transfers,
  // Treasury, Fiduciary, etc.) are immediately visible. Users can still collapse any group.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const state: Record<string, boolean> = {}
    for (const group of navGroups) {
      state[group.label] = true
    }
    return state
  })

  const toggleGroup = (label: string) =>
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Logo */}
      <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
        {/* SheetClose closes the mobile menu when the logo is tapped so the overlay
            never lingers and blocks the page after navigating. */}
        <SheetClose asChild>
          <Link href="/dashboard" className="flex items-center gap-2">
            <img
              src="/images/mcc-logo.png"
              alt="MCC Capital logo"
              className="h-9 w-9 rounded-full object-cover"
            />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-sidebar-foreground">MCC Capital</span>
              <span className="text-[10px] text-muted-foreground">Swiss Banking</span>
            </div>
          </Link>
        </SheetClose>
      </div>

      {/* Scrollable dropdown navigation */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
        <div className="space-y-1">
          {visibleNavGroups.map((group) => {
            const isOpen = openGroups[group.label] ?? false
            const hasActive = group.items.some((item) => item.href === pathname)
            return (
              <Collapsible
                key={group.label}
                open={isOpen}
                onOpenChange={() => toggleGroup(group.label)}
                className="pb-1"
              >
                <CollapsibleTrigger
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                    hasActive ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <span className="flex items-center gap-2">
                    {group.label}
                    {!isOpen && hasActive && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                    )}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 transition-transform duration-200",
                      isOpen && "rotate-180",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                  <div className="space-y-1 pt-1">
                    {group.items.map((item) => (
                      // Each destination is wrapped in SheetClose so tapping it both
                      // navigates and dismisses the mobile menu + its overlay. Without
                      // this the sheet overlay can stay mounted and make the page
                      // appear "stuck" / unclickable after navigating.
                      <SheetClose asChild key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                            pathname === item.href
                              ? "bg-primary/15 text-primary font-semibold shadow-[inset_4px_0_0_0_var(--primary)] [&>svg]:text-primary"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/50",
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="flex-1">{item.title}</span>
                          {item.badge && (
                            <Badge
                              variant="secondary"
                              className="h-5 px-1.5 text-[10px] bg-primary/20 text-primary"
                            >
                              {item.badge}
                            </Badge>
                          )}
                        </Link>
                      </SheetClose>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </nav>

      {/* Account Tier */}
      <div className="shrink-0 border-t border-sidebar-border p-4">
        <div className="rounded-lg bg-gradient-to-r from-primary/20 to-primary/5 p-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-primary text-primary-foreground text-[10px]">PRO</Badge>
            <span className="text-xs text-sidebar-foreground">Active Plan</span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">Unlimited trading volume</p>
        </div>

        {/* Sign Out — always reachable from the mobile navigation */}
        <form action="/api/logout" method="POST" className="mt-3">
          <Button
            type="submit"
            variant="ghost"
            className="h-11 w-full justify-start gap-2 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Sign out</span>
          </Button>
        </form>
      </div>
    </div>
  )
}
