"use client"

import { useEffect, useState, useCallback } from "react"
import { Users, Plus, Loader2, ShieldCheck, Link2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import {
  listMyLinkedAccounts,
  createLinkedAccount,
  getMyLinkedContext,
  type LinkedAccountView,
} from "@/app/actions/linked-accounts"

/**
 * Read-only banner shown on a Joint (J) account holder's own profile, making it
 * explicit that they operate inside their Master's shared environment. Renders
 * nothing for every non-joint account.
 */
export function SharedEnvironmentBanner() {
  const [master, setMaster] = useState<{ name?: string; email?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMyLinkedContext().then((ctx) => {
      if (cancelled) return
      if (ctx.isJoint) setMaster({ name: ctx.masterName, email: ctx.masterEmail })
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!master) return null

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex items-start gap-3 pt-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Link2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Linked account with full shared access</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {master.name
              ? `You operate inside ${master.name}'s environment — shared balance, instruments, transactions, deals and documents — with full operational rights. Your login and Face ID remain your own.`
              : "You operate inside your primary account's shared environment with full operational rights. Your login and Face ID remain your own."}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Self-service management of Linked / Joint (J) accounts, shown on the Master's
 * profile. A Joint account has its own login and Face ID but operates fully
 * inside the Master's shared environment with unrestricted rights.
 *
 * The component fetches its own state from the server action, which returns an
 * empty list for any non-master session — so it simply renders nothing for
 * Sub/Child/Joint accounts and never needs the parent to know the relationship.
 */
export function LinkedAccountsCard() {
  const { toast } = useToast()
  const [accounts, setAccounts] = useState<LinkedAccountView[]>([])
  const [loading, setLoading] = useState(true)
  const [isMaster, setIsMaster] = useState(false)
  const [context, setContext] = useState<LinkedContext>({ isJoint: false })
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState("")

  const load = useCallback(async () => {
    const [res, ctx] = await Promise.all([listMyLinkedAccounts(), getMyLinkedContext()])
    if (res.ok) {
      setAccounts(res.accounts)
      // Explicit flag from the server: only a Master account may own/create
      // linked accounts, so the card is hidden for everyone else.
      setIsMaster(res.isMaster)
    } else {
      setIsMaster(false)
    }
    setContext(ctx)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function resetForm() {
    setFullName("")
    setEmail("")
    setPassword("")
    setRole("")
  }

  async function handleCreate() {
    setSubmitting(true)
    const res = await createLinkedAccount({ fullName, email, password, role: role || undefined })
    setSubmitting(false)
    if (res.ok) {
      toast({ title: "Linked account created", description: `${res.account.fullName} can now sign in with their own credentials.` })
      setAccounts((prev) => [res.account, ...prev])
      resetForm()
      setOpen(false)
    } else {
      toast({ title: "Could not create linked account", description: res.error, variant: "destructive" })
    }
  }

  // A Joint account sees a read-only banner explaining its shared access
  // instead of the management card.
  if (!loading && context.isJoint) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4 text-primary" />
            Linked account
          </CardTitle>
          <CardDescription>You share a joint environment with a primary account holder.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/40 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                {context.masterName ? `Linked to ${context.masterName}` : "Linked to a primary account"}
              </p>
              <p className="text-muted-foreground">
                {"You operate inside the primary account's shared environment \u2014 balance, instruments, transactions, deals and documents \u2014 with full rights. Your login and Face ID are your own."}
              </p>
              {context.masterEmail ? (
                <p className="text-xs text-muted-foreground">Primary: {context.masterEmail}</p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Hide entirely until we know this is a master account (and not a joint one).
  if (!loading && !isMaster) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-muted-foreground" />
              Linked Accounts
            </CardTitle>
            <CardDescription>
              Give a partner or co-director their own login with full shared access to this account.
            </CardDescription>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5 shrink-0">
                <Plus className="h-4 w-4" />
                Add linked account
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a linked account</DialogTitle>
                <DialogDescription>
                  {"The new account signs in with its own email, password and Face ID, but shares this account's entire environment \u2014 balance, instruments, transactions, deals and documents \u2014 with full operational rights."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="linked-name">Full name</Label>
                  <Input
                    id="linked-name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jordan Rivera"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="linked-email">Email</Label>
                  <Input
                    id="linked-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="partner@company.com"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="linked-password">Temporary password</Label>
                  <Input
                    id="linked-password"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    Share this securely; the holder can change it after first sign-in.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="linked-role">Role (optional)</Label>
                  <Input
                    id="linked-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="Joint Account Holder"
                    autoComplete="off"
                  />
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 p-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs text-muted-foreground">
                    {"This account will have unrestricted rights \u2014 including payments \u2014 acting with the same authority as you. Only add people you fully trust."}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={submitting} className="gap-1.5">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create account
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading linked accounts…
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Link2 className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-foreground">No linked accounts yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Add a joint holder to let someone operate this account alongside you with their own secure login.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((acct) => (
              <li key={acct.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {acct.fullName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{acct.fullName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {acct.email} · {acct.role}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="outline" className="gap-1">
                    Linked (J)
                  </Badge>
                  <Badge
                    variant={acct.status === "active" ? "default" : "secondary"}
                    className="capitalize"
                  >
                    {acct.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
