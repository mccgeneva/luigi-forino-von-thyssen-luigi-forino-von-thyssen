"use client"

import { useCallback, useEffect, useState } from "react"
import { KeyRound, Plus, Copy, Check, Ban, Trash2, ShieldCheck, Eye, RefreshCw, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  adminListApiKeys,
  adminCreateApiKey,
  adminRevokeApiKey,
  adminDeleteApiKey,
} from "@/app/actions/api-keys"
import type { ApiKeyRecord, ApiKeyScope } from "@/lib/api-keys-db"

const SCOPE_LABELS: Record<ApiKeyScope, { label: string; description: string }> = {
  read: { label: "Read customer data", description: "Retrieve a customer's profile, balances and transactions." },
  charge: { label: "Charge balance", description: "Debit subscription costs from a customer's balance." },
  sso: {
    label: "SSO sign-in link",
    description: "Sign an already-authenticated NQAi user into their existing account — no second password.",
  },
}

export function ApiKeysManager({ passcode }: { passcode: string }) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [loading, setLoading] = useState(true)

  // Create form state
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["read"])
  const [creating, setCreating] = useState(false)

  // Newly created secret (shown once)
  const [newSecret, setNewSecret] = useState<{ name: string; plaintext: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await adminListApiKeys(passcode)
    if (res.ok) setKeys(res.keys)
    else toast.error(res.error)
    setLoading(false)
  }, [passcode])

  useEffect(() => {
    load()
  }, [load])

  const toggleScope = (scope: ApiKeyScope) => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("Enter a name for the key.")
      return
    }
    if (scopes.length === 0) {
      toast.error("Select at least one scope.")
      return
    }
    setCreating(true)
    const res = await adminCreateApiKey(passcode, { name: name.trim(), scopes })
    setCreating(false)
    if (res.ok) {
      setNewSecret({ name: res.key.name, plaintext: res.plaintext })
      setName("")
      setScopes(["read"])
      await load()
    } else {
      toast.error(res.error)
    }
  }

  const handleRevoke = async (id: string) => {
    const res = await adminRevokeApiKey(passcode, id)
    if (res.ok) {
      toast.success("API key revoked.")
      await load()
    } else {
      toast.error(res.error)
    }
  }

  const handleDelete = async (id: string) => {
    const res = await adminDeleteApiKey(passcode, id)
    if (res.ok) {
      toast.success("API key deleted.")
      await load()
    } else {
      toast.error(res.error)
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

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <KeyRound className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-foreground">API Keys</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            Issue keys that let external applications (e.g. NQAi.cloud) read a specific customer&apos;s data and charge
            subscription costs against the balance they hold on this platform.
          </p>
        </div>
      </div>

      {/* Create a new key */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="h-4 w-4" />
            Create a new API key
          </CardTitle>
          <CardDescription>
            Choose the least-privilege scopes the integration needs. The secret is shown only once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="key-name">Key name</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. NQAi.cloud Production"
              autoComplete="off"
            />
          </div>
          <div className="space-y-3">
            <Label>Scopes</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(SCOPE_LABELS) as ApiKeyScope[]).map((scope) => (
                <label
                  key={scope}
                  htmlFor={`scope-${scope}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/50"
                >
                  <Checkbox
                    id={`scope-${scope}`}
                    checked={scopes.includes(scope)}
                    onCheckedChange={() => toggleScope(scope)}
                    className="mt-0.5"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium text-foreground">{SCOPE_LABELS[scope].label}</span>
                    <span className="block text-xs text-muted-foreground">{SCOPE_LABELS[scope].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Create API key
          </Button>
        </CardContent>
      </Card>

      {/* Integration reference — the exact endpoints NQAi.cloud calls */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Integration reference</CardTitle>
          <CardDescription>
            Every request sends the key as an <code className="font-mono text-xs">Authorization: Bearer</code> header.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-1">
            <p className="font-medium text-foreground">Read a customer (scope: read)</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
              {"GET /api/v1/customer?email=customer@example.com"}
            </pre>
            <p className="text-muted-foreground text-pretty">
              Returns the customer&apos;s profile, KYC status, per-currency balances and recent transactions.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground">Charge a subscription (scope: charge)</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
              {`POST /api/v1/charge
{
  "email": "customer@example.com",
  "amount": 49,
  "currency": "EUR",
  "description": "NQAi Pro subscription",
  "idempotencyKey": "unique-per-charge"
}`}
            </pre>
            <p className="text-muted-foreground text-pretty">
              Debits the balance immediately and returns <code className="font-mono text-xs">balanceAfter</code>. An
              insufficient balance is rejected with <code className="font-mono text-xs">402</code> and nothing is
              posted. Reusing an <code className="font-mono text-xs">idempotencyKey</code> returns the original charge
              instead of billing again.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-foreground">Single sign-on hand-off (scope: sso)</p>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
              {`POST /api/v1/sso
{
  "email": "customer@example.com"
}
→ { "url": "https://mcc-btp.app/sso?token=…", "expiresAt": "…" }`}
            </pre>
            <p className="text-muted-foreground text-pretty">
              For a user NQAi has already logged in. Returns a one-time link; redirect the browser to it and the user
              lands in their <span className="font-medium text-foreground">existing</span> mcc-btp.app account — the
              login is inherited, so no second email or password is ever created. The account must already exist
              (unknown emails return <code className="font-mono text-xs">404</code>); the link is single-use and
              expires within minutes.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Existing keys */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Issued keys</CardTitle>
            <CardDescription>{keys.length} key{keys.length === 1 ? "" : "s"} total</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading keys…</p>
          ) : keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No API keys yet. Create one above.</p>
          ) : (
            <ul className="divide-y divide-border">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{k.name}</span>
                      {k.status === "active" ? (
                        <Badge variant="secondary" className="gap-1">
                          <ShieldCheck className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <Ban className="h-3 w-3" />
                          Revoked
                        </Badge>
                      )}
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="text-xs">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {k.keyPrefix}
                      {"••••••••"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {k.requestCount.toLocaleString()} request{k.requestCount === 1 ? "" : "s"}
                      {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}` : " · never used"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {k.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => handleRevoke(k.id)}>
                        <Ban className="mr-2 h-4 w-4" />
                        Revoke
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(k.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Delete {k.name}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* One-time secret reveal */}
      <Dialog open={!!newSecret} onOpenChange={(open) => !open && setNewSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-primary" />
              Copy your API key now
            </DialogTitle>
            <DialogDescription>
              This is the only time the full secret for <strong>{newSecret?.name}</strong> is shown. Store it securely —
              it cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                {newSecret?.plaintext}
              </code>
              <Button size="sm" variant="outline" onClick={copySecret}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="sr-only">Copy</span>
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>
                Send this to NQAi.cloud as an{" "}
                <code className="font-mono">Authorization: Bearer</code> header. Revoke it immediately if it leaks.
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setNewSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
