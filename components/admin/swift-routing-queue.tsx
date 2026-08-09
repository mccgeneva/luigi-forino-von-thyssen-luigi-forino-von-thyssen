"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Loader2,
  Inbox,
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  Copy,
  Users,
  Mail,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import { toast } from "sonner"
import {
  listAllSwiftRoutingRequestsAdmin,
  listSwiftBeneficiaries,
  approveSwiftRoutingAdmin,
  declineSwiftRoutingAdmin,
} from "@/app/actions/swift-routing"
import type { SwiftRoutingRequest } from "@/lib/swift-routing-db"
import type { SelectableClient } from "@/app/actions/admin-users"

function StatusBadge({ status }: { status: SwiftRoutingRequest["status"] }) {
  if (status === "approved")
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Routed
      </Badge>
    )
  if (status === "declined")
    return (
      <Badge className="gap-1 bg-destructive/15 text-destructive">
        <XCircle className="h-3 w-3" /> Declined
      </Badge>
    )
  return (
    <Badge className="gap-1 bg-amber-500/15 text-amber-600 dark:text-amber-400">
      <Clock className="h-3 w-3" /> Pending
    </Badge>
  )
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success("FIN copied to clipboard"),
    () => toast.error("Could not copy"),
  )
}

export function SwiftRoutingQueue() {
  const [requests, setRequests] = useState<SwiftRoutingRequest[]>([])
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [loading, setLoading] = useState(true)

  // Approve dialog
  const [approveTarget, setApproveTarget] = useState<SwiftRoutingRequest | null>(null)
  const [routeMode, setRouteMode] = useState<"platform" | "external">("platform")
  const [beneficiaryId, setBeneficiaryId] = useState("")
  const [externalName, setExternalName] = useState("")
  const [externalEmail, setExternalEmail] = useState("")
  // Decline dialog
  const [declineTarget, setDeclineTarget] = useState<SwiftRoutingRequest | null>(null)
  const [declineReason, setDeclineReason] = useState("")
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const [reqRes, benRes] = await Promise.all([
      listAllSwiftRoutingRequestsAdmin(ADMIN_PASSCODE),
      listSwiftBeneficiaries(ADMIN_PASSCODE),
    ])
    if (reqRes.ok) setRequests(reqRes.requests)
    else toast.error(reqRes.error)
    if (benRes.ok) setClients(benRes.clients)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pending = useMemo(() => requests.filter((r) => r.status === "pending"), [requests])
  const decided = useMemo(() => requests.filter((r) => r.status !== "pending"), [requests])

  const openApprove = (req: SwiftRoutingRequest) => {
    setRouteMode("platform")
    setBeneficiaryId("")
    setExternalName("")
    setExternalEmail("")
    setApproveTarget(req)
  }

  const confirmApprove = async () => {
    if (!approveTarget) return

    let beneficiary: { userId: string | null; email: string; name: string }
    if (routeMode === "platform") {
      const client = clients.find((c) => c.id === beneficiaryId)
      if (!client) {
        toast.error("Select a beneficiary from the list before routing.")
        return
      }
      beneficiary = { userId: client.id, email: client.email, name: client.fullName || client.company }
    } else {
      const email = externalEmail.trim()
      const name = externalName.trim()
      if (!name) {
        toast.error("Enter the external recipient's name.")
        return
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast.error("Enter a valid external email address.")
        return
      }
      beneficiary = { userId: null, email, name }
    }

    setBusy(true)
    const res = await approveSwiftRoutingAdmin(ADMIN_PASSCODE, approveTarget.id, beneficiary)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRequests((prev) => prev.map((r) => (r.id === res.request.id ? res.request : r)))
    toast.success("Message routed", {
      description: res.emailed
        ? `The SWIFT ${res.request.messageType} was emailed to ${beneficiary.email}.`
        : `Routed to ${beneficiary.name}, but the email could not be delivered.`,
    })
    setApproveTarget(null)
  }

  const confirmDecline = async () => {
    if (!declineTarget) return
    setBusy(true)
    const res = await declineSwiftRoutingAdmin(ADMIN_PASSCODE, declineTarget.id, declineReason)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    setRequests((prev) => prev.map((r) => (r.id === res.request.id ? res.request : r)))
    toast.success("Request declined")
    setDeclineTarget(null)
    setDeclineReason("")
  }

  const RequestCard = ({ req }: { req: SwiftRoutingRequest }) => {
    const amount = req.amount ? `${req.currency ?? ""} ${req.amount}`.trim() : null
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">{req.messageType}</span>
              <span className="text-sm text-muted-foreground">{req.messageName}</span>
            </div>
            <span className="text-xs text-muted-foreground">
              From {req.customerName} · {req.customerEmail || "no email"}
            </span>
          </div>
          <StatusBadge status={req.status} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <span className="text-muted-foreground">Sender BIC</span>
            <p className="font-mono text-foreground">{req.senderBic}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Receiver BIC</span>
            <p className="font-mono text-foreground">{req.receiverBic || "—"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Amount</span>
            <p className="font-mono text-foreground">{amount ?? "—"}</p>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <span className="text-muted-foreground">UETR</span>
            <p className="break-all font-mono text-foreground">{req.uetr}</p>
          </div>
          {req.status === "approved" && req.beneficiaryEmail ? (
            <div className="col-span-2 sm:col-span-3">
              <span className="text-muted-foreground">Routed to</span>
              <p className="text-foreground">
                {req.beneficiaryName} · {req.beneficiaryEmail}
              </p>
            </div>
          ) : null}
          {req.status === "declined" && req.decisionNote ? (
            <div className="col-span-2 sm:col-span-3">
              <span className="text-muted-foreground">Reason</span>
              <p className="text-foreground">{req.decisionNote}</p>
            </div>
          ) : null}
        </div>

        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-primary">View FIN message</summary>
          <div className="mt-2 flex flex-col gap-2">
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
              {req.raw}
            </pre>
            <Button variant="outline" size="sm" className="w-fit gap-1.5 bg-transparent" onClick={() => copy(req.raw)}>
              <Copy className="h-3.5 w-3.5" /> Copy FIN
            </Button>
          </div>
        </details>

        {req.status === "pending" ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => openApprove(req)}>
              <Send className="h-3.5 w-3.5" /> Approve &amp; route
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 bg-transparent"
              onClick={() => setDeclineTarget(req)}
            >
              <XCircle className="h-3.5 w-3.5" /> Decline
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground text-lg">
              <Inbox className="h-5 w-5 text-primary" /> SWIFT Routing Approvals
            </CardTitle>
            <CardDescription>
              Review client-submitted SWIFT messages and route them to the correct beneficiary by email.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 bg-transparent" onClick={() => void load()}>
            <Loader2 className={loading ? "h-3.5 w-3.5 animate-spin" : "hidden"} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading routing requests…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Pending approval {pending.length > 0 ? `(${pending.length})` : ""}
              </h3>
              {pending.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  No SWIFT messages are waiting for routing.
                </p>
              ) : (
                pending.map((req) => <RequestCard key={req.id} req={req} />)
              )}
            </div>

            {decided.length > 0 ? (
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-foreground">History</h3>
                {decided.map((req) => (
                  <RequestCard key={req.id} req={req} />
                ))}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      {/* Approve & route dialog with beneficiary picker */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => !o && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Route SWIFT message</DialogTitle>
            <DialogDescription>
              {approveTarget
                ? `Choose who should receive the ${approveTarget.messageType} (${approveTarget.uetr.slice(0, 13)}…). The full FIN message is emailed to them as a professional SWIFT transmission copy.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            {/* Destination mode: an existing platform user, or any external email. */}
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-1">
              <button
                type="button"
                onClick={() => setRouteMode("platform")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  routeMode === "platform" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <Users className="h-4 w-4" /> Platform user
              </button>
              <button
                type="button"
                onClick={() => setRouteMode("external")}
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  routeMode === "external" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <Mail className="h-4 w-4" /> External email
              </button>
            </div>

            {routeMode === "platform" ? (
              <div className="flex flex-col gap-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <Users className="h-4 w-4" /> Beneficiary
                </Label>
                <Select value={beneficiaryId} onValueChange={setBeneficiaryId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a platform user" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.length === 0 ? (
                      <div className="px-2 py-3 text-center text-sm text-muted-foreground">No active platform users</div>
                    ) : (
                      clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.fullName} · {c.company} — {c.email}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ext-name" className="text-sm">
                    Recipient name
                  </Label>
                  <Input
                    id="ext-name"
                    value={externalName}
                    onChange={(e) => setExternalName(e.target.value)}
                    placeholder="e.g., Beneficiary Bank / Counterparty name"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ext-email" className="text-sm">
                    Recipient email
                  </Label>
                  <Input
                    id="ext-email"
                    type="email"
                    inputMode="email"
                    value={externalEmail}
                    onChange={(e) => setExternalEmail(e.target.value)}
                    placeholder="name@bank.com"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  The recipient does not need a platform account. They receive the SWIFT transmission copy by email.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="bg-transparent" onClick={() => setApproveTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={confirmApprove}
              disabled={busy || (routeMode === "platform" ? !beneficiaryId : !externalEmail.trim() || !externalName.trim())}
              className="gap-1.5"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Approve &amp; route
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline dialog */}
      <Dialog open={!!declineTarget} onOpenChange={(o) => !o && setDeclineTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline routing request</DialogTitle>
            <DialogDescription>
              The client will see this message was declined. No email is sent to any beneficiary.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <Label className="text-sm">Reason (optional)</Label>
            <Textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="e.g., Beneficiary details could not be verified."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" className="bg-transparent" onClick={() => setDeclineTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDecline} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
