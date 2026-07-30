"use client"

import { useState } from "react"
import useSWR from "swr"
import { Cpu, Plus, Copy, Check, Loader2, Trash2, Ban, KeyRound, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"
import {
  listMyApiKeys,
  createMyApiKey,
  revokeMyApiKey,
  deleteMyApiKey,
} from "@/app/actions/user-api-keys"
import type { ApiKeyRecord, ApiKeyScope } from "@/lib/api-keys-db"

const SCOPES: { id: ApiKeyScope; label: string; description: string }[] = [
  { id: "read", label: "Read my data", description: "View my profile, balances and transactions." },
  { id: "write", label: "Update my contact details", description: "Update my phone, address and display name." },
  { id: "charge", label: "Charge my balance", description: "Debit subscription costs from my balance." },
]

function formatDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ApiAccess() {
  const { data, isLoading, mutate } = useSWR("my-api-keys", async () => {
    const res = await listMyApiKeys()
    if (!res.ok) throw new Error(res.error)
    return res.keys
  })
  const keys = data ?? []

  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["read"])
  const [creating, setCreating] = useState(false)
  const [newSecret, setNewSecret] = useState<{ name: string; plaintext: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const toggleScope = (scope: ApiKeyScope) =>
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))

  const handleCreate = async () => {
    if (!name.trim()) return toast.error("Enter a name for the key.")
    if (scopes.length === 0) return toast.error("Select at least one permission.")
    setCreating(true)
    try {
      const res = await createMyApiKey({ name: name.trim(), scopes })
      if (res.ok) {
        setNewSecret({ name: res.key.name, plaintext: res.plaintext })
        setName("")
        setScopes(["read"])
        await mutate()
      } else {
        toast.error(res.error)
      }
    } catch (err) {
      toast.error((err as Error)?.message || "The key could not be created.")
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    setBusyId(id)
    try {
      const res = await revokeMyApiKey(id)
      if (res.ok) {
        toast.success("Key revoked.")
        await mutate()
      } else toast.error(res.error)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (id: string) => {
    setBusyId(id)
    try {
      const res = await deleteMyApiKey(id)
      if (res.ok) {
        toast.success("Key deleted.")
        await mutate()
      } else toast.error(res.error)
    } finally {
      setBusyId(null)
    }
  }

  const copySecret = async () => {
    if (!newSecret) return
    try {
      await navigator.clipboard.writeText(newSecret.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Could not copy — select and copy manually.")
    }
  }

  const copyPrefix = async (id: string, prefix: string) => {
    try {
      await navigator.clipboard.writeText(prefix)
      setCopiedId(id)
      toast.success("Key identifier copied.")
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000)
    } catch {
      toast.error("Could not copy — select and copy manually.")
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <Label>NQAi.cloud API access</Label>
          <p className="text-xs text-muted-foreground text-pretty">
            Generate a key so NQAi.cloud can securely connect to your account here — reading your position and billing
            your subscription against your balance. The key inherits your login, so there&apos;s no second password to
            manage. Your secret is shown only once.
          </p>
        </div>
      </div>

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-primary" />
            Your new key “{newSecret.name}”
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-primary" />
            Copy it now — for your security it won&apos;t be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
              {newSecret.plaintext}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={copySecret}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={() => setNewSecret(null)}>
            Done
          </Button>
        </div>
      )}

      {/* Create form */}
      <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="api-key-name" className="text-xs">
            Key name
          </Label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. NQAi.cloud"
            autoComplete="off"
            className="text-base"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Permissions</Label>
          {SCOPES.map((s) => (
            <label
              key={s.id}
              htmlFor={`scope-${s.id}`}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3"
            >
              <Checkbox
                id={`scope-${s.id}`}
                checked={scopes.includes(s.id)}
                onCheckedChange={() => toggleScope(s.id)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.description}</p>
              </div>
            </label>
          ))}
        </div>
        <Button type="button" onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Generate key
        </Button>
      </div>

      {/* Existing keys */}
      <div className="space-y-2">
        <Label className="text-xs">Your keys</Label>
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            You don&apos;t have any API keys yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {keys.map((k: ApiKeyRecord) => {
              const revoked = k.status === "revoked"
              return (
                <li
                  key={k.id}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{k.name}</span>
                      {revoked ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          Revoked
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="text-xs">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <p className="font-mono text-xs text-muted-foreground">{k.keyPrefix}••••</p>
                      <button
                        type="button"
                        onClick={() => copyPrefix(k.id, k.keyPrefix)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Copy identifier for key ${k.name}`}
                      >
                        {copiedId === k.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDate(k.createdAt)} · Last used {formatDate(k.lastUsedAt)} · {k.requestCount} calls
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!revoked && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleRevoke(k.id)}
                        disabled={busyId === k.id}
                      >
                        <Ban className="mr-1.5 h-3.5 w-3.5" /> Revoke
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(k.id)}
                      disabled={busyId === k.id}
                      aria-label={`Delete key ${k.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <Separator />
      <p className="text-xs text-muted-foreground text-pretty">
        Keys never expire — revoke one anytime to cut access immediately. Give NQAi.cloud only the permissions it needs.
      </p>
    </div>
  )
}
