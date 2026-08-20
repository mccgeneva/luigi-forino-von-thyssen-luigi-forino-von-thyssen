"use client"

import { useEffect, useMemo, useState } from "react"
import { Lock, LockOpen, RotateCcw, Loader2, ShieldHalf, User } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  DASHBOARD_SECTIONS,
  VISITOR_ALLOWED_KEYS,
  type SectionAccessMap,
  type SectionOverride,
} from "@/lib/dashboard-sections"

type SelectableClient = {
  id: string
  fullName: string
  company: string
  email: string
  accountBadge: string
}

/** All override choices offered per section. "default" clears the override so
 *  the section reverts to the user's tier default. */
type Choice = SectionOverride | "default"

function isVisitorBadge(badge: string): boolean {
  return (badge || "").trim().toLowerCase() === "visitor"
}

/** Group the section catalogue for display, preserving catalogue order. */
const SECTION_GROUPS = (() => {
  const groups: { label: string; keys: string[] }[] = []
  for (const section of DASHBOARD_SECTIONS) {
    let group = groups.find((g) => g.label === section.group)
    if (!group) {
      group = { label: section.group, keys: [] }
      groups.push(group)
    }
    group.keys.push(section.key)
  }
  return groups
})()

const SECTION_LABEL = new Map(DASHBOARD_SECTIONS.map((s) => [s.key, s.label]))

export function SectionAccessManager({ passcode }: { passcode: string }) {
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [target, setTarget] = useState<string>("")
  const [access, setAccess] = useState<SectionAccessMap>({})

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const targetClient = useMemo(() => clients.find((c) => c.id === target), [clients, target])
  const targetIsVisitor = targetClient ? isVisitorBadge(targetClient.accountBadge) : false
  const targetName = targetClient
    ? targetClient.company?.trim() || targetClient.fullName?.trim() || targetClient.email
    : "this user"

  // Load the client picker (and, once a target is chosen, its overrides) via the
  // /api/admin/section-access route — NOT a Server Action. Actions POST to
  // /dashboard/* and are 401'd by the session proxy on a stale meta cookie
  // (common in the preview), which would silently leave the picker empty. The
  // API route is not behind that proxy and returns real JSON.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    fetch("/api/admin/section-access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ op: "load", pin: passcode, targetId: target || undefined }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (!data?.ok) {
          setLoadError(
            data?.reason === "unauthorized"
              ? "Administrator authorization failed."
              : data?.error || "Could not load section access.",
          )
          return
        }
        setClients(Array.isArray(data.clients) ? data.clients : [])
        setAccess((data.access as SectionAccessMap) || {})
      })
      .catch(() => {
        if (!cancelled) setLoadError("Network error while loading section access.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [passcode, target])

  /** Effective state shown for a section given its override and the tier. */
  function effectiveFor(key: string): { choice: Choice; label: string; tone: "allowed" | "locked" } {
    const override = access[key]
    if (override === "locked") return { choice: "locked", label: "Locked", tone: "locked" }
    if (override === "unlocked") return { choice: "unlocked", label: "Unlocked", tone: "allowed" }
    // No override → tier default.
    if (targetIsVisitor) {
      return VISITOR_ALLOWED_KEYS.has(key)
        ? { choice: "default", label: "Allowed (tier default)", tone: "allowed" }
        : { choice: "default", label: "Locked (Visitor tier)", tone: "locked" }
    }
    return { choice: "default", label: "Allowed (tier default)", tone: "allowed" }
  }

  async function applyChoice(sectionKey: string, choice: Choice) {
    if (!target) return
    setSavingKey(sectionKey)
    try {
      const r = await fetch("/api/admin/section-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "set", pin: passcode, targetId: target, sectionKey, access: choice }),
      })
      const data = await r.json()
      if (!data?.ok) {
        toast.error(data?.error || "Could not update section access.")
        return
      }
      setAccess((data.access as SectionAccessMap) || {})
      const label = SECTION_LABEL.get(sectionKey) ?? sectionKey
      toast.success(
        choice === "locked"
          ? `Locked "${label}" for ${targetName}.`
          : choice === "unlocked"
            ? `Unlocked "${label}" for ${targetName}.`
            : `Reset "${label}" to the tier default.`,
      )
    } catch {
      toast.error("Network error while updating section access.")
    } finally {
      setSavingKey(null)
    }
  }

  async function resetAll() {
    if (!target) return
    setResetting(true)
    try {
      const r = await fetch("/api/admin/section-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ op: "clear", pin: passcode, targetId: target }),
      })
      const data = await r.json()
      if (!data?.ok) {
        toast.error(data?.error || "Could not reset section access.")
        return
      }
      setAccess({})
      toast.success(`Cleared all section overrides for ${targetName}.`)
    } catch {
      toast.error("Network error while resetting section access.")
    } finally {
      setResetting(false)
    }
  }

  const overrideCount = Object.keys(access).length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldHalf className="h-5 w-5 text-primary" />
          Section Access Control
        </CardTitle>
        <CardDescription>
          Lock or unlock any dashboard section for an individual user. Locking blocks the section for
          that user regardless of their plan (they will see &ldquo;You are not allowed to access this
          section&rdquo;). Unlocking grants full access regardless of their plan &mdash; this is how you
          let a Visitor fully operate in a section their tier would normally block.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Target picker */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Apply to user</label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-full sm:max-w-md">
              <SelectValue placeholder={loading ? "Loading users…" : "Select a user…"} />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    {(c.company?.trim() || c.fullName?.trim() || c.email)}
                    {isVisitorBadge(c.accountBadge) && (
                      <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">
                        Visitor
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        {!target && !loadError && (
          <p className="text-sm text-muted-foreground">
            Select a user to review and change which sections they can access.
          </p>
        )}

        {target && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <div className="text-sm">
                <span className="font-medium text-foreground">{targetName}</span>{" "}
                {targetIsVisitor ? (
                  <Badge variant="outline" className="ml-1 align-middle text-[10px]">
                    Visitor
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">· subscribed plan (full access by default)</span>
                )}
                <span className="ml-2 text-muted-foreground">
                  · {overrideCount} override{overrideCount === 1 ? "" : "s"}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={resetAll}
                disabled={resetting || overrideCount === 0}
              >
                {resetting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Reset all to tier default
              </Button>
            </div>

            <div className="space-y-5">
              {SECTION_GROUPS.map((group) => (
                <div key={group.label} className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </p>
                  <div className="space-y-1.5">
                    {group.keys.map((key) => {
                      const eff = effectiveFor(key)
                      const busy = savingKey === key
                      return (
                        <div
                          key={key}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {SECTION_LABEL.get(key)}
                            </p>
                            <p
                              className={cn(
                                "text-xs",
                                eff.tone === "locked" ? "text-destructive" : "text-emerald-600 dark:text-emerald-500",
                              )}
                            >
                              {busy ? "Saving…" : eff.label}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant={eff.choice === "unlocked" ? "default" : "outline"}
                              disabled={busy}
                              onClick={() => applyChoice(key, "unlocked")}
                            >
                              <LockOpen className="mr-1 h-3.5 w-3.5" />
                              Unlock
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant={eff.choice === "locked" ? "destructive" : "outline"}
                              disabled={busy}
                              onClick={() => applyChoice(key, "locked")}
                            >
                              <Lock className="mr-1 h-3.5 w-3.5" />
                              Lock
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy || eff.choice === "default"}
                              onClick={() => applyChoice(key, "default")}
                              title="Revert to the user's tier default"
                            >
                              Default
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
