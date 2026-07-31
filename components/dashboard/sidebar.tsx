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
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Landmark,
  Globe,
  Users,
  Headset,
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
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
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
  icon: LucideIcon
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: "Terminal",
    icon: Cpu,
    items: [
      { title: "NQAi Co-Pilot", href: "/dashboard/nqai", icon: Cpu, badge: "AI" },
      { title: "Trading Console", href: "/dashboard/console", icon: Network, badge: "Live" },
    ],
  },
  {
    label: "Banking",
    icon: Building2,
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
      { title: "Payment Gateway", href: "/dashboard/gateway", icon: Globe, badge: "IBAN" },
      { title: "Cards", href: "/dashboard/cards", icon: CreditCard },
    ],
  },
  {
    label: "Project Funding",
    icon: Building2,
    items: [
      { title: "AES Project Funding", href: "/dashboard/funding", icon: Building2, badge: "AES" },
    ],
  },
  {
    label: "Trading & Instruments",
    icon: TrendingUp,
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
    icon: Settings,
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

export function DashboardSidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()
  const isAdmin = useIsAdmin()

  // Hide admin-only destinations (e.g. Administrator) from non-admins. This is a
  // UX filter only — the admin routes are independently gated on the server.
  const visibleNavGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || isAdmin),
    }))
    .filter((group) => group.items.length > 0)

  const isActive = (href: string) => pathname === href

  const groupContainsActive = (group: NavGroup) => group.items.some((item) => isActive(item.href))

  // Open every group by default so all destinations (Internal Transfers, Treasury,
  // Fiduciary, etc.) are immediately visible. Users can still collapse any group.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    for (const group of navGroups) {
      initial[group.label] = true
    }
    return initial
  })

  const toggleGroup = (label: string) => {
    setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  return (
    <aside
      className={cn(
        "relative flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo Section */}
      <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
        {!collapsed && (
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
        )}
        {collapsed && (
          <img
            src="/images/mcc-logo.png"
            alt="MCC Capital logo"
            className="mx-auto h-9 w-9 rounded-full object-cover"
          />
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4 [scrollbar-gutter:stable] [scrollbar-width:thin]">
        {collapsed ? (
          // Collapsed compact rail: one icon per group, hover opens a flyout dropdown of its pages.
          <div className="space-y-1">
            {visibleNavGroups.map((group) => {
              const GroupIcon = group.icon
              const active = groupContainsActive(group)
              return (
                <HoverCard key={group.label} openDelay={80} closeDelay={120}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      aria-label={group.label}
                      className={cn(
                        "relative flex w-full items-center justify-center rounded-lg px-2 py-2.5 transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/40 [&>svg]:text-primary"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50"
                      )}
                    >
                      <GroupIcon className="h-5 w-5 shrink-0" />
                      {active && (
                        <span
                          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="right"
                    align="start"
                    sideOffset={12}
                    className="w-60 border-sidebar-border bg-sidebar p-2"
                  >
                    <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </p>
                    <div className="space-y-1">
                      {group.items.map((item) => (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                            isActive(item.href)
                              ? "bg-primary/15 text-primary font-semibold shadow-[inset_4px_0_0_0_var(--primary)] [&>svg]:text-primary"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/50"
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
                      ))}
                    </div>
                  </HoverCardContent>
                </HoverCard>
              )
            })}
          </div>
        ) : (
          // Expanded: dynamic dropdown/accordion groups.
          <div className="space-y-2">
            {visibleNavGroups.map((group) => {
              const open = openGroups[group.label] ?? false
              return (
                <Collapsible key={group.label} open={open} onOpenChange={() => toggleGroup(group.label)}>
                  <CollapsibleTrigger
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg px-2 py-2 text-xs font-semibold uppercase tracking-wider transition-colors",
                      "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      groupContainsActive(group) && "text-primary"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {group.label}
                      {groupContainsActive(group) && !open && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                      )}
                    </span>
                    <ChevronDown
                      className={cn("h-4 w-4 shrink-0 transition-transform duration-200", open && "rotate-180")}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                    <div className="mt-1 space-y-1 pb-1">
                      {group.items.map((item) => (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                            isActive(item.href)
                              ? "bg-primary/15 text-primary font-semibold shadow-[inset_4px_0_0_0_var(--primary)] [&>svg]:text-primary"
                              : "text-sidebar-foreground hover:bg-sidebar-accent/50"
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
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        )}
      </nav>

      {/* Relationship Manager + Account Tier */}
      {!collapsed && (
        <div className="space-y-3 border-t border-sidebar-border p-4">
          <div className="rounded-lg bg-gradient-to-r from-primary/20 to-primary/5 p-3">
            <div className="flex items-center gap-2">
              <Badge className="bg-primary text-primary-foreground text-[10px]">PRO</Badge>
              <span className="text-xs text-sidebar-foreground">Active Plan</span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Unlimited trading volume</p>
          </div>
          <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3">
            <div className="flex items-center gap-2">
              <Headset className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-sidebar-foreground">Relationship Manager</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              André Koller is available 24/7 for priority clients.
            </p>
            <Button asChild size="sm" className="mt-2 h-8 w-full text-xs">
              <Link href="/dashboard/support">Contact RM</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Sign Out — always available, regardless of collapsed state */}
      <div className="border-t border-sidebar-border p-3">
        <form action="/api/logout" method="POST">
          <Button
            type="submit"
            variant="ghost"
            className={cn(
              "h-10 w-full gap-2 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive",
              collapsed ? "justify-center px-0" : "justify-start",
            )}
            title="Sign out"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {collapsed ? <span className="sr-only">Sign out</span> : <span>Sign out</span>}
          </Button>
        </form>
      </div>

      {/* Collapse Toggle */}
      <Button
        variant="ghost"
        size="icon"
        className="absolute -right-3 top-20 h-6 w-6 rounded-full border border-sidebar-border bg-sidebar shadow-md"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </Button>
    </aside>
  )
}
