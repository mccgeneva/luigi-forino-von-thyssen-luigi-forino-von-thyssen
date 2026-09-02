"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import useSWR from "swr"
import { Bell, User, LogOut, Settings, HelpCircle, Menu, BookOpen, ShieldCheck, Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GlobalSearch } from "./global-search"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { MobileSidebar } from "./mobile-sidebar"
import { useCurrentUser, useIsAdmin } from "@/lib/use-current-user"
import { BankekaHeaderButton } from "@/components/bankeka/bankeka-header-button"
import type { NotificationsSnapshot } from "@/app/actions/notifications"

/** SWR fetcher: read notifications via the Route Handler (never the Server
 * Action) so polling can never block navigation. Always resolves to a usable
 * snapshot. */
async function fetchNotifications(): Promise<NotificationsSnapshot> {
  try {
    const res = await fetch("/api/notifications")
    if (!res.ok) return { items: [], unread: 0 }
    const data = (await res.json()) as { ok: boolean; items?: NotificationsSnapshot["items"]; unread?: number }
    return { items: data.items ?? [], unread: data.unread ?? 0 }
  } catch {
    return { items: [], unread: 0 }
  }
}

/** Relative "time ago" label for a notification timestamp. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diff = Math.max(0, Date.now() - then)
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/** Map a notification tone to its status dot color. */
const toneDot: Record<string, string> = {
  success: "bg-success",
  warning: "bg-yellow-500",
  error: "bg-destructive",
  info: "bg-primary",
}

/** Live UTC clock + market status pill, Bloomberg terminal style. */
function TerminalClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const time = now
    ? now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" })
    : "--:--:--"

  return (
    <div className="hidden lg:flex items-center gap-3 rounded-sm border border-border bg-secondary px-3 py-1.5">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-success">Live</span>
      </span>
      <span className="font-mono text-xs tabular-nums text-foreground">{time}</span>
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">UTC</span>
    </div>
  )
}

export function DashboardHeader() {
  const user = useCurrentUser()
  const isAdmin = useIsAdmin()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  // Header dropdowns are controlled so we can dim/blur the rest of the screen
  // while one is open — the open menu then reads as the single focused layer
  // instead of competing with the busy dashboard behind it.
  const [notifOpen, setNotifOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const anyMenuOpen = notifOpen || userOpen

  // Live notifications from the DB (cross-device). Polls so a decision made by
  // an admin shows up shortly after, even without a page reload.
  //
  // CRITICAL: we poll a Route Handler (`/api/notifications`) with plain fetch,
  // NOT the `getMyNotifications` Server Action. Next.js runs Server Actions
  // through a single serialized queue and locks client navigation behind any
  // in-flight one — so a slow/cold serverless DB call on this 30s poll would
  // freeze every Link/router navigation until a hard refresh. A Route Handler
  // has no such coupling: a slow DB only makes this background fetch slow.
  // revalidateOnFocus stays off for the same historical reason.
  const { data, mutate } = useSWR<NotificationsSnapshot>("my-notifications", fetchNotifications, {
    refreshInterval: 12000,
    revalidateOnFocus: false,
  })
  const notifications = data?.items ?? []
  const unread = data?.unread ?? 0

  // Persistent "to-do" count of everything awaiting ANY administrator's action.
  // Shown as a badge on a dedicated Administrator button so every admin — incl.
  // sub-account admins whose transient notification bell may already be marked
  // read — always sees pending work and can jump straight to the panel. Only
  // polled for admins (the endpoint returns 0/false for everyone else anyway).
  const { data: adminTodo, mutate: mutateAdminTodo } = useSWR<{ ok: boolean; total: number }>(
    isAdmin ? "admin-pending-count" : null,
    async () => {
      try {
        const res = await fetch("/api/admin/pending-count")
        if (!res.ok) return { ok: false, total: 0 }
        return (await res.json()) as { ok: boolean; total: number }
      } catch {
        return { ok: false, total: 0 }
      }
    },
    { refreshInterval: 12000, revalidateOnFocus: false },
  )
  const adminPending = adminTodo?.total ?? 0

  // Force an immediate resync the instant the app is re-shown. SWR pauses its
  // interval while the tab is hidden and revalidateOnFocus is off, so on a
  // mobile / installed-PWA resume nothing would refresh until the next tick —
  // making an admin operation appear "out of sync for a long time". Revalidating
  // on visibilitychange + pageshow (bfcache / PWA resume) fixes that.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== "visible") return
      void mutate()
      void mutateAdminTodo()
    }
    document.addEventListener("visibilitychange", resync)
    window.addEventListener("pageshow", resync)
    return () => {
      document.removeEventListener("visibilitychange", resync)
      window.removeEventListener("pageshow", resync)
    }
  }, [mutate, mutateAdminTodo])

  const markAllRead = async () => {
    // Optimistically clear the unread badge, then persist via the Route Handler.
    mutate(
      (prev) =>
        prev
          ? { items: prev.items.map((n) => ({ ...n, read: true })), unread: 0 }
          : prev,
      false,
    )
    try {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    } catch {
      // ignore — the next poll reconciles state
    }
    mutate()
  }

  // Mark a SINGLE notification read — fired when the user taps a notification to
  // jump to its related section/action. Clears that notification's unread badge
  // (and decrements the bell count) immediately, then persists via the Route
  // Handler with an `ids` subset. The Link's own navigation is unaffected.
  const markOneRead = (id: string) => {
    setNotifOpen(false)
    mutate(
      (prev) => {
        if (!prev) return prev
        const target = prev.items.find((n) => n.id === id)
        if (!target || target.read) return prev
        return {
          items: prev.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
          unread: Math.max(0, prev.unread - 1),
        }
      },
      false,
    )
    // Fire-and-forget so navigation is instant; the next poll reconciles anyway.
    void fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {})
  }
  return (
    <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-card px-4 md:px-6">
      {/* Dimming backdrop shown while a header dropdown is open, so the menu is
          the clear focus. Tapping it closes whichever menu is open. Rendered to
          body at z-40 — below the z-50 menu content, above the page. */}
      {anyMenuOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            aria-hidden="true"
            onClick={() => {
              setNotifOpen(false)
              setUserOpen(false)
            }}
            className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm animate-in fade-in-0 duration-150"
          />,
          document.body,
        )}
      {/* Mobile Menu */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden">
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-64">
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <SheetDescription className="sr-only">
            Browse banking, trading, and platform sections.
          </SheetDescription>
          <MobileSidebar />
        </SheetContent>
      </Sheet>

      {/* Global Search */}
      <GlobalSearch />

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* NQAi launcher — always visible, prominent entry to the AI co-pilot */}
        <Button
          asChild
          size="sm"
          className="group relative h-9 gap-1.5 overflow-hidden bg-primary px-3 font-semibold text-primary-foreground shadow-[0_0_0_1px_var(--color-primary)] hover:bg-primary/90"
        >
          <Link href="/dashboard/nqai" aria-label="Open NQAi, the Neural Quantum AI co-pilot">
            <Cpu className="h-4 w-4" />
            <span className="hidden sm:inline">NQAi</span>
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          </Link>
        </Button>

        {/* Live UTC clock + market status */}
        <TerminalClock />

        {/* Bankeka Messenger */}
        <BankekaHeaderButton />

        {/* Administrator to-do — persistent pending-tasks indicator for admins.
            Independent of the notification bell's read state, so an admin who
            has cleared their bell can still see and reach pending admin work. */}
        {isAdmin && (
          <Button asChild variant="ghost" size="icon" className="relative">
            <Link href="/dashboard/admin" aria-label={`Administrator panel${adminPending > 0 ? ` — ${adminPending} pending` : ""}`}>
              <ShieldCheck className="h-5 w-5" />
              {adminPending > 0 && (
                <Badge className="absolute -right-1 -top-1 h-5 w-5 rounded-full p-0 text-[10px] bg-primary text-primary-foreground flex items-center justify-center">
                  {adminPending > 9 ? "9+" : adminPending}
                </Badge>
              )}
              <span className="sr-only">Administrator tasks</span>
            </Link>
          </Button>
        )}

        {/* Notifications */}
        <DropdownMenu open={notifOpen} onOpenChange={setNotifOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative">
              <Bell className="h-5 w-5" />
              {unread > 0 && (
                <Badge className="absolute -right-1 -top-1 h-5 w-5 rounded-full p-0 text-[10px] bg-primary text-primary-foreground flex items-center justify-center">
                  {unread > 9 ? "9+" : unread}
                </Badge>
              )}
              <span className="sr-only">Notifications</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Notifications</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs text-primary disabled:opacity-50"
                disabled={unread === 0}
                onClick={markAllRead}
              >
                Mark all read
              </Button>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary mb-2">
                  <Bell className="h-4 w-4 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No notifications</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  You&apos;re all caught up
                </p>
              </div>
            ) : (
              notifications.map((notification) => {
                const content = (
                  <>
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${toneDot[notification.tone] ?? "bg-primary"}`} />
                      <span className="font-medium text-sm">{notification.title}</span>
                      {!notification.read && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-label="Unread" />
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground pl-4 text-pretty">{notification.body}</span>
                    <span className="text-[10px] text-muted-foreground pl-4">{timeAgo(notification.createdAt)}</span>
                  </>
                )
                return (
                  <DropdownMenuItem
                    key={notification.id}
                    className={`flex flex-col items-start gap-1 p-3 cursor-pointer ${
                      notification.read ? "" : "bg-secondary/40"
                    }`}
                    asChild={!!notification.href}
                    onSelect={notification.href ? undefined : () => markOneRead(notification.id)}
                  >
                    {notification.href ? (
                      <Link href={notification.href} onClick={() => markOneRead(notification.id)}>
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </DropdownMenuItem>
                )
              })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="justify-center text-primary cursor-pointer">
              <Link href="/dashboard/transactions">View all activity</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* User Menu */}
        <DropdownMenu open={userOpen} onOpenChange={setUserOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 px-2">
              <Avatar className="h-8 w-8">
                {user.avatarUrl && (
                  <AvatarImage src={user.avatarUrl} alt={user.fullName} className="object-cover" />
                )}
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {user.initials}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:flex flex-col items-start">
                <span className="text-sm font-medium">{user.shortName}</span>
                <span className="text-[10px] text-muted-foreground">{user.headerTag}</span>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{user.fullName}</span>
              <span className="text-[10px] font-normal text-muted-foreground">{user.role} · {user.company}</span>
              <span className="text-[10px] font-normal text-muted-foreground">{user.accountEmail}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/dashboard/profile">
                <User className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/settings">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/handbook">
                <BookOpen className="mr-2 h-4 w-4" />
                Client Handbook
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/support">
                <HelpCircle className="mr-2 h-4 w-4" />
                Support
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link href="/dashboard/admin">
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Administrator
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <form action="/api/logout" method="POST">
              <DropdownMenuItem
                className="text-destructive cursor-pointer"
                onSelect={(e) => e.preventDefault()}
                asChild
              >
                <button type="submit" className="flex w-full items-center">
                  <LogOut className="mr-2 h-4 w-4" />
                  Log out
                </button>
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
