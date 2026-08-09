"use client"

import { useEffect, useState } from "react"
import {
  ArrowDownToLine,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Send,
  UserPlus,
  Inbox,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import {
  ingestIncomingSwiftAdmin,
  listUnmatchedIncomingSwiftAdmin,
  assignIncomingSwiftAdmin,
  type IngestResult,
} from "@/app/actions/incoming-swift"
import { listSelectableClients, type SelectableClient } from "@/app/actions/admin-users"
import type { IncomingSwiftMessage } from "@/lib/incoming-swift-db"
import { toast } from "sonner"

const SAMPLE = `{1:F01DEUTDEFFAXXX0000000000}
{2:I103CHASUS33XXXXN}
{3:{121:eb6305c9-1f7f-49de-aed0-16487c27b42d}}
{4:
:20:REF-INC-55021
:23B:CRED
:32A:240617EUR15000,00
:50K:/DE89370400440532013000
ACME COMMODITIES GMBH
FRANKFURT
:57A:CHASUS33
:59:/CH9300762011623852957
ANDRE KOLLER
GENEVA
:70:INVOICE 8842
:71A:SHA
-}
{5:{CHK:123456789ABC}}`

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
}

export function IncomingSwiftDelivery() {
  const [raw, setRaw] = useState("")
  const [ingesting, setIngesting] = useState(false)
  const [result, setResult] = useState<IngestResult | null>(null)

  const [unmatched, setUnmatched] = useState<IncomingSwiftMessage[]>([])
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [clients, setClients] = useState<SelectableClient[]>([])
  const [assignSel, setAssignSel] = useState<Record<string, string>>({})
  const [assigning, setAssigning] = useState<string | null>(null)

  const loadQueue = async () => {
    setLoadingQueue(true)
    const res = await listUnmatchedIncomingSwiftAdmin(ADMIN_PASSCODE)
    setLoadingQueue(false)
    if (res.ok) setUnmatched(res.messages)
  }

  useEffect(() => {
    void loadQueue()
    void listSelectableClients(ADMIN_PASSCODE).then(setClients)
  }, [])

  const handleIngest = async () => {
    if (!raw.trim()) return
    setIngesting(true)
    setResult(null)
    try {
      const res = await ingestIncomingSwiftAdmin(ADMIN_PASSCODE, raw)
      setResult(res)
      if (!res.ok) {
        toast.error(res.error ?? "Could not ingest the message.")
      } else if (res.status === "matched") {
        toast.success(`Delivered to ${res.matchedTo}.`)
        setRaw("")
      } else {
        toast.warning("No matching account — added to the review queue.")
        setRaw("")
        void loadQueue()
      }
    } catch {
      toast.error("Could not reach the delivery engine.")
    } finally {
      setIngesting(false)
    }
  }

  const handleAssign = async (id: string) => {
    const userId = assignSel[id]
    if (!userId) {
      toast.error("Select a customer to assign this message to.")
      return
    }
    setAssigning(id)
    const res = await assignIncomingSwiftAdmin(ADMIN_PASSCODE, id, userId)
    setAssigning(null)
    if (res.ok) {
      toast.success("Message assigned and delivered.")
      setUnmatched((prev) => prev.filter((m) => m.id !== id))
    } else {
      toast.error(res.error ?? "Could not assign the message.")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Ingest + auto-match */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Receive &amp; deliver an incoming SWIFT message</CardTitle>
          <CardDescription>
            Paste an inbound SWIFT FIN message. It is cross-checked against every active bank account by beneficiary
            IBAN (:59:) and receiving bank BIC (:57a:). On a confident match it is delivered straight to that
            customer&apos;s SWIFT Messages inbox and they are notified; otherwise it goes to the review queue below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="{1:F01...}{2:I103...}{4:&#10;:20:...&#10;:59:/IBAN&#10;-}"
            className="min-h-[240px] font-mono text-xs leading-relaxed"
            aria-label="Incoming SWIFT message"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleIngest} disabled={ingesting || !raw.trim()} className="gap-2">
              {ingesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
              Receive &amp; match
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRaw(SAMPLE)} className="bg-transparent">
              Load sample
            </Button>
            {raw && (
              <Button variant="outline" size="sm" onClick={() => setRaw("")} className="bg-transparent">
                Clear
              </Button>
            )}
          </div>

          {result?.ok && (
            <div
              className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-sm ${
                result.status === "matched"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              }`}
            >
              {result.status === "matched" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>
                {result.status === "matched" ? (
                  <>
                    Delivered to <strong>{result.matchedTo}</strong>. {result.reason}
                  </>
                ) : (
                  <>Not matched. {result.reason} Review it in the queue below.</>
                )}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Unmatched review queue */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Inbox className="h-4 w-4" /> Review queue
                {unmatched.length > 0 && (
                  <Badge variant="secondary">{unmatched.length}</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Messages that could not be matched to a single active account. Assign each to the correct customer to
                deliver it.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={loadQueue} disabled={loadingQueue} className="gap-2 bg-transparent">
              {loadingQueue ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {unmatched.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loadingQueue ? "Loading…" : "No messages awaiting review."}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {unmatched.map((m) => (
                <div key={m.id} className="rounded-lg border border-border p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge className="bg-primary/15 text-primary">{m.messageType}</Badge>
                    {m.amount && <span className="text-sm font-semibold text-foreground">{m.amount}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDate(m.createdAt)}</span>
                  </div>
                  <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                    <Detail label="Beneficiary" value={m.beneficiaryName || "—"} />
                    <Detail label="Beneficiary IBAN" value={m.beneficiaryIban || "—"} mono />
                    <Detail label="Receiving bank (:57a:)" value={m.receiverBic || "—"} mono />
                    <Detail label="Ordering customer" value={m.orderingCustomer || "—"} />
                    {m.reference && <Detail label="Reference" value={m.reference} />}
                    {m.uetr && <Detail label="UETR" value={m.uetr} mono />}
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {m.matchReason}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Select
                      value={assignSel[m.id] ?? ""}
                      onValueChange={(v) => setAssignSel((prev) => ({ ...prev, [m.id]: v }))}
                    >
                      <SelectTrigger className="h-9 w-full sm:w-[320px]">
                        <SelectValue placeholder="Assign to customer…" />
                      </SelectTrigger>
                      <SelectContent>
                        {clients.length === 0 ? (
                          <div className="px-2 py-3 text-center text-sm text-muted-foreground">No active accounts</div>
                        ) : (
                          clients.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.fullName} · {c.company} — {c.email}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => handleAssign(m.id)}
                      disabled={assigning === m.id || !assignSel[m.id]}
                      className="gap-1.5"
                    >
                      {assigning === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                      Assign &amp; deliver
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`break-all text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  )
}
