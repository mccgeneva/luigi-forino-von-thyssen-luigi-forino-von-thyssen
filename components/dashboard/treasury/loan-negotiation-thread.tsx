"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { upload } from "@vercel/blob/client"
import { Paperclip, Send, Loader2, FileText, X, MessagesSquare, Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  getInternalLoanThread,
  postInternalLoanMessage,
  getInternalLoanThreadAdmin,
  postInternalLoanMessageAdmin,
} from "@/app/actions/internal-loan"
import {
  LOAN_MAX_ATTACHMENTS_PER_MESSAGE,
  LOAN_UPLOAD_MAX_BYTES,
  type LoanNegotiationMessage,
  type LoanAttachment,
} from "@/lib/internal-loan"

function formatBytes(n?: number): string {
  if (!n || n <= 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Two-way loan negotiation thread. Used by both the administrator (inside the
 * evaluate dialog) and the borrower (inline on their Treasury loan card) to
 * discuss a pending internal loan, upload supporting documents, and negotiate
 * terms before the administrator finalises the decision.
 *
 * `role` decides message alignment/attribution and which server actions +
 * upload authorisation are used. Documents upload straight from the browser to
 * Vercel Blob (via /api/internal-loan/blob-upload) then attach to the message.
 */
export function LoanNegotiationThread({
  approvalId,
  role,
  passcode,
  readOnly = false,
  className,
}: {
  approvalId: string
  role: "admin" | "client"
  passcode?: string
  readOnly?: boolean
  className?: string
}) {
  const [messages, setMessages] = useState<LoanNegotiationMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState("")
  const [pending, setPending] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    try {
      const thread =
        role === "admin"
          ? await getInternalLoanThreadAdmin(passcode ?? "", approvalId)
          : await getInternalLoanThread(approvalId)
      if (thread) setMessages(thread.messages)
    } catch {
      // transient; keep whatever we have
    } finally {
      setLoading(false)
    }
  }, [approvalId, role, passcode])

  // Initial load + light polling so each side sees the other's replies promptly.
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 12000)
    return () => clearInterval(t)
  }, [load])

  // Keep the conversation pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const canSend = (body.trim().length > 0 || pending.length > 0) && !sending && !readOnly

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const incoming = Array.from(list)
    const room = LOAN_MAX_ATTACHMENTS_PER_MESSAGE - pending.length
    if (room <= 0) {
      toast.error(`Up to ${LOAN_MAX_ATTACHMENTS_PER_MESSAGE} documents per message.`)
      return
    }
    const accepted: File[] = []
    for (const f of incoming.slice(0, room)) {
      if (f.size > LOAN_UPLOAD_MAX_BYTES) {
        toast.error(`"${f.name}" is larger than 25 MB.`)
        continue
      }
      accepted.push(f)
    }
    if (accepted.length) setPending((prev) => [...prev, ...accepted])
  }

  const removePending = (idx: number) => setPending((prev) => prev.filter((_, i) => i !== idx))

  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      // 1) Upload any attached documents straight to Blob.
      const attachments: LoanAttachment[] = []
      for (const file of pending) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
        const result = await upload(`internal-loan/${approvalId}/${Date.now()}-${safe}`, file, {
          access: "public",
          handleUploadUrl: "/api/internal-loan/blob-upload",
          clientPayload: JSON.stringify(role === "admin" ? { passcode: passcode ?? "" } : {}),
        })
        attachments.push({
          name: file.name,
          url: result.url,
          pathname: result.pathname,
          size: file.size,
          contentType: file.type || undefined,
        })
      }

      // 2) Post the message.
      const res =
        role === "admin"
          ? await postInternalLoanMessageAdmin({
              passcode: passcode ?? "",
              approvalId,
              body: body.trim(),
              attachments,
            })
          : await postInternalLoanMessage({ approvalId, body: body.trim(), attachments })

      if (!res.ok) {
        toast.error("Message not sent", { description: res.error })
        return
      }
      setMessages(res.messages)
      setBody("")
      setPending([])
    } catch (err) {
      toast.error((err as Error).message || "Could not send the message.")
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter makes a newline. Respect IME composition.
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void send()
    }
  }

  const empty = useMemo(() => !loading && messages.length === 0, [loading, messages.length])

  return (
    <div className={cn("flex flex-col rounded-lg border border-border bg-background", className)}>
      {/* Conversation */}
      <div ref={scrollRef} className="max-h-80 min-h-[8rem] flex-1 space-y-3 overflow-y-auto p-3">
        {loading && messages.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading discussion…</p>
        )}
        {empty && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <MessagesSquare className="h-6 w-6 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              No messages yet. {readOnly ? "" : "Start the discussion, ask for documents, or negotiate terms."}
            </p>
          </div>
        )}
        {messages.map((m) => {
          const mine = m.from === role
          return (
            <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  mine
                    ? "bg-primary/15 text-foreground"
                    : "bg-secondary/50 text-foreground",
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-foreground">{m.author}</span>
                  <span
                    className={cn(
                      "rounded px-1 text-[9px] uppercase tracking-wide",
                      m.from === "admin"
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {m.from === "admin" ? "Administrator" : "Borrower"}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{formatTime(m.at)}</span>
                </div>
                {m.body && <p className="whitespace-pre-wrap break-words leading-relaxed">{m.body}</p>}
                {m.attachments.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {m.attachments.map((a, i) => (
                      <a
                        key={`${m.id}-${i}`}
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs transition-colors hover:border-primary/40"
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-foreground">{a.name}</span>
                        {a.size ? <span className="text-[10px] text-muted-foreground">{formatBytes(a.size)}</span> : null}
                        <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer */}
      {!readOnly && (
        <div className="border-t border-border p-3">
          {pending.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pending.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs"
                >
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => removePending(i)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx"
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                if (fileRef.current) fileRef.current.value = ""
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
              aria-label="Attach documents"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
              className="max-h-32 min-h-11 flex-1 resize-none"
            />
            <Button type="button" className="h-11 shrink-0" onClick={() => void send()} disabled={!canSend}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span className="ml-1.5 hidden sm:inline">{sending ? "Sending…" : "Send"}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
