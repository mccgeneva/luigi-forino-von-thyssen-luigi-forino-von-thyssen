"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { upload } from "@vercel/blob/client"
import {
  ArrowLeft,
  MessageSquarePlus,
  Search,
  Send,
  ShieldCheck,
  MessagesSquare,
  Loader2,
  Mail,
  Lock,
  Paperclip,
  FileText,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { MessageBubble } from "./message-bubble"
import { MessageStatusIcon } from "./message-status"
import {
  BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE,
  BANKEKA_UPLOAD_MAX_BYTES,
  type BankekaConversation,
  type BankekaMessage,
  type BankekaParticipant,
  type BankekaAttachment,
} from "@/lib/bankeka-shared"

interface ThreadResult {
  participant: BankekaParticipant
  messages: BankekaMessage[]
}
type SendResult = { ok: true; message: BankekaMessage } | { ok: false; error: string }
type DeleteResult = { ok: true } | { ok: false; error: string }
type FindRecipientResult =
  | { ok: true; participant: BankekaParticipant }
  | { ok: false; error: string }

export interface MessengerProps {
  /** Unique cache namespace so the client and admin messengers never collide. */
  scope: string
  fetchConversations: () => Promise<BankekaConversation[]>
  fetchThread: (otherId: string) => Promise<ThreadResult | null>
  send: (otherId: string, body: string, attachments?: BankekaAttachment[]) => Promise<SendResult>
  /** Enables document/image attachments in the composer (both parties). */
  attachmentsEnabled?: boolean
  /** clientPayload forwarded to the Blob upload route (carries the admin PIN
   *  when the console runs outside a normal user session). */
  uploadPayload?: string
  /** Auto-open this thread on mount (used by the inline loan-discussion view). */
  initialThreadId?: string
  /** Participant header to show while the auto-opened thread loads. */
  initialParticipant?: BankekaParticipant
  /** Prefill the composer once when the thread first opens. */
  initialDraft?: string
  /** Hide the conversation-list column and show only the thread (embedded use). */
  hideConversationList?: boolean
  /**
   * When provided, enables "Delete for me" on each message. Deleting is
   * non-destructive: it hides the message from the current viewer only, the
   * other participant still sees it.
   */
  deleteMessage?: (messageId: string) => Promise<DeleteResult>
  /**
   * Enables the private "new conversation" picker. There is deliberately NO
   * browsable directory: a user can only start a thread with someone whose
   * EXACT email address they already know, and the lookup never reveals names
   * or account data.
   */
  findByEmail?: (email: string) => Promise<FindRecipientResult>
  /** Optional pinned support contact (MCC Capital · Administration). */
  fetchSupportContact?: () => Promise<BankekaParticipant | null>
  /** Shown in the empty-state panel of the conversation list. */
  emptyHint?: string
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
}

export function Messenger({
  scope,
  fetchConversations,
  fetchThread,
  send,
  deleteMessage,
  findByEmail,
  fetchSupportContact,
  attachmentsEnabled = false,
  uploadPayload,
  initialThreadId,
  initialParticipant,
  initialDraft,
  hideConversationList = false,
  emptyHint = "Select a conversation to start messaging.",
}: MessengerProps) {
  const [activeId, setActiveId] = useState<string | null>(initialThreadId ?? null)
  const [activeParticipant, setActiveParticipant] = useState<BankekaParticipant | null>(
    initialParticipant ?? null,
  )
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  // Composer attachments (already uploaded to Blob, pending send).
  const [attachments, setAttachments] = useState<BankekaAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const draftSeeded = useRef(false)
  const [pending, setPending] = useState<Record<string, BankekaMessage[]>>({})
  // Optimistically hidden message ids (delete-for-me), cleared once the server
  // read reflects the deletion.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [contactsOpen, setContactsOpen] = useState(false)
  // Private "new conversation" lookup state (exact email only).
  const [emailQuery, setEmailQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [foundParticipant, setFoundParticipant] = useState<BankekaParticipant | null>(null)
  const [supportContact, setSupportContact] = useState<BankekaParticipant | null>(null)
  const scrollEndRef = useRef<HTMLDivElement | null>(null)

  // Conversation list — polled for near-real-time delivery & unread updates.
  const { data: conversations = [], mutate: mutateConversations } = useSWR(
    [scope, "conversations"],
    () => fetchConversations(),
    { refreshInterval: 5000, revalidateOnFocus: true },
  )

  // Active thread — polled faster while open so replies/receipts feel live.
  const { data: thread, mutate: mutateThread } = useSWR(
    activeId ? [scope, "thread", activeId] : null,
    () => (activeId ? fetchThread(activeId) : null),
    { refreshInterval: 3000, revalidateOnFocus: true },
  )

  // Pinned support contact (loaded lazily when the picker opens).
  useEffect(() => {
    if (contactsOpen && fetchSupportContact && !supportContact) {
      fetchSupportContact()
        .then((c) => {
          if (c) setSupportContact(c)
        })
        .catch(() => {})
    }
  }, [contactsOpen, fetchSupportContact, supportContact])

  // Prefill the composer once for an embedded/auto-opened thread (e.g. the loan
  // discussion, pre-tagged with the loan reference). Admin can edit before sending.
  useEffect(() => {
    if (initialDraft && !draftSeeded.current) {
      draftSeeded.current = true
      setDraft(initialDraft)
    }
  }, [initialDraft])

  const serverMessages = thread?.messages ?? []
  const pendingForActive = activeId ? pending[activeId] ?? [] : []
  const messages = useMemo(
    () => [...serverMessages, ...pendingForActive].filter((m) => !deletedIds.has(m.id)),
    [serverMessages, pendingForActive, deletedIds],
  )

  // Keep the resolved participant header in sync once a thread loads.
  useEffect(() => {
    if (thread?.participant) setActiveParticipant(thread.participant)
  }, [thread?.participant])

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length, activeId])

  const openThread = (participant: BankekaParticipant) => {
    setActiveId(participant.id)
    setActiveParticipant(participant)
    setContactsOpen(false)
    // Clear the private lookup so the next open starts fresh.
    setEmailQuery("")
    setSearchError(null)
    setFoundParticipant(null)
    // Opening reads incoming messages → refresh unread counts shortly after.
    setTimeout(() => mutateConversations(), 400)
  }

  const handleDialogOpenChange = (open: boolean) => {
    setContactsOpen(open)
    if (!open) {
      setEmailQuery("")
      setSearchError(null)
      setFoundParticipant(null)
    }
  }

  const handleFindByEmail = async () => {
    if (!findByEmail) return
    const email = emailQuery.trim()
    if (!email || searching) return
    setSearching(true)
    setSearchError(null)
    setFoundParticipant(null)
    try {
      const res = await findByEmail(email)
      if (res.ok) setFoundParticipant(res.participant)
      else setSearchError(res.error)
    } catch {
      setSearchError("Could not complete the search. Please try again.")
    } finally {
      setSearching(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const room = BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE - attachments.length
    if (room <= 0) {
      toast.error(`You can attach up to ${BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE} files per message.`)
      return
    }
    const chosen = Array.from(files).slice(0, room)
    setUploading(true)
    try {
      for (const file of chosen) {
        if (file.size > BANKEKA_UPLOAD_MAX_BYTES) {
          toast.error(`"${file.name}" is too large (max 25 MB).`)
          continue
        }
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
        const result = await upload(`bankeka/${scope}/${Date.now()}-${safe}`, file, {
          access: "public",
          handleUploadUrl: "/api/bankeka/blob-upload",
          clientPayload: uploadPayload,
        })
        setAttachments((prev) => [
          ...prev,
          { name: file.name, url: result.url, size: file.size, contentType: file.type || undefined },
        ])
      }
    } catch (err) {
      toast.error((err as Error).message || "The file could not be uploaded.")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleSend = async () => {
    const body = draft.trim()
    const files = attachments
    if ((!body && files.length === 0) || !activeId || sending || uploading) return
    const tempId = `temp_${Date.now()}`
    const optimistic: BankekaMessage = {
      id: tempId,
      senderId: "me",
      recipientId: activeId,
      body,
      attachments: files,
      kind: "direct",
      createdAt: new Date().toISOString(),
      outgoing: true,
      status: "sent",
    }
    setPending((p) => ({ ...p, [activeId]: [...(p[activeId] ?? []), optimistic] }))
    setDraft("")
    setAttachments([])
    setSending(true)
    try {
      const res = await send(activeId, body, files)
      if (!res.ok) {
        toast.error(res.error)
        setDraft(body)
        setAttachments(files)
      }
    } catch {
      toast.error("Could not send the message.")
      setDraft(body)
      setAttachments(files)
    } finally {
      // Drop the optimistic echo and pull the authoritative thread + list.
      setPending((p) => ({ ...p, [activeId]: (p[activeId] ?? []).filter((m) => m.id !== tempId) }))
      setSending(false)
      await Promise.all([mutateThread(), mutateConversations()])
    }
  }

  const handleDelete = async (messageId: string) => {
    if (!deleteMessage || messageId.startsWith("temp_")) return
    // Optimistically hide it, then confirm with the server.
    setDeletedIds((prev) => new Set(prev).add(messageId))
    try {
      const res = await deleteMessage(messageId)
      if (!res.ok) {
        toast.error(res.error)
        setDeletedIds((prev) => {
          const next = new Set(prev)
          next.delete(messageId)
          return next
        })
        return
      }
      await Promise.all([mutateThread(), mutateConversations()])
    } catch {
      toast.error("Could not delete the message.")
      setDeletedIds((prev) => {
        const next = new Set(prev)
        next.delete(messageId)
        return next
      })
    }
  }

  const filteredConversations = conversations.filter((c) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      c.participant.name.toLowerCase().includes(q) ||
      c.participant.company.toLowerCase().includes(q) ||
      c.lastMessage.toLowerCase().includes(q)
    )
  })

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-xl border border-border bg-card",
        hideConversationList ? "h-[60vh] min-h-[24rem]" : "h-[calc(100vh-12rem)] min-h-[28rem]",
      )}
    >
      {/* Conversation list */}
      {!hideConversationList && (
      <div
        className={cn(
          "flex w-full flex-col border-r border-border md:w-80 md:shrink-0",
          activeId ? "hidden md:flex" : "flex",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search messages"
              className="h-9 pl-8 text-base md:text-sm"
              aria-label="Search conversations"
            />
          </div>
          {findByEmail && (
            <Dialog open={contactsOpen} onOpenChange={handleDialogOpenChange}>
              <DialogTrigger asChild>
                <Button size="icon" variant="secondary" className="h-9 w-9 shrink-0" aria-label="New conversation">
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>New conversation</DialogTitle>
                  <DialogDescription className="text-pretty">
                    Enter the exact email address of the person you want to message. For everyone&apos;s
                    privacy, accounts can&apos;t be browsed — you can only reach someone whose email
                    address you already know.
                  </DialogDescription>
                </DialogHeader>

                {/* Always-reachable support contact */}
                {supportContact && (
                  <button
                    type="button"
                    onClick={() => openThread(supportContact)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary"
                  >
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        <ShieldCheck className="h-4 w-4" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{supportContact.name}</p>
                      <p className="truncate text-xs text-muted-foreground">Official support channel</p>
                    </div>
                  </button>
                )}

                {supportContact && (
                  <div className="flex items-center gap-3 py-0.5">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      or message by email
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}

                {/* Exact email lookup */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleFindByEmail()
                  }}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Mail className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        type="email"
                        inputMode="email"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={emailQuery}
                        onChange={(e) => setEmailQuery(e.target.value)}
                        placeholder="name@example.com"
                        className="h-10 pl-8 text-base md:text-sm"
                        aria-label="Recipient email address"
                      />
                    </div>
                    <Button type="submit" disabled={searching || !emailQuery.trim()} className="h-10 shrink-0">
                      {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
                    </Button>
                  </div>
                </form>

                {searchError && (
                  <p className="text-xs text-destructive" role="alert">
                    {searchError}
                  </p>
                )}

                {foundParticipant && (
                  <button
                    type="button"
                    onClick={() => openThread(foundParticipant)}
                    className="flex w-full items-center gap-3 rounded-lg border border-success/40 bg-success/5 px-3 py-2.5 text-left transition-colors hover:bg-success/10"
                  >
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="bg-secondary text-xs text-foreground">
                        {foundParticipant.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{foundParticipant.name}</p>
                      <p className="truncate text-xs text-muted-foreground">Tap to start a private conversation</p>
                    </div>
                    <Send className="h-4 w-4 shrink-0 text-success" />
                  </button>
                )}

                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Lock className="h-3 w-3" />
                  We never reveal other members&apos; names or account details.
                </p>
              </DialogContent>
            </Dialog>
          )}
        </div>

        <ScrollArea className="flex-1">
          {filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                <MessagesSquare className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No conversations yet</p>
              <p className="text-xs text-muted-foreground text-pretty">{emptyHint}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filteredConversations.map((c) => {
                const hasUnread = c.unread > 0
                return (
                  <li key={c.participant.id}>
                    <button
                      type="button"
                      onClick={() => openThread(c.participant)}
                      className={cn(
                        "relative flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-secondary",
                        activeId === c.participant.id && "bg-secondary",
                        // A received-but-unread conversation gets a clear accent
                        // tint so it's obvious at a glance WHICH chat has a new
                        // message.
                        hasUnread && "bg-primary/5",
                      )}
                    >
                      {/* Accent bar down the left edge of an unread conversation. */}
                      {hasUnread && (
                        <span aria-hidden className="absolute inset-y-0 left-0 w-1 rounded-r-sm bg-primary" />
                      )}
                      <div className="relative shrink-0">
                        <Avatar className="h-10 w-10">
                          <AvatarFallback
                            className={cn(
                              "text-xs",
                              c.participant.isAdmin
                                ? "bg-primary text-primary-foreground"
                                : "bg-secondary text-foreground",
                            )}
                          >
                            {c.participant.isAdmin ? <ShieldCheck className="h-5 w-5" /> : c.participant.initials}
                          </AvatarFallback>
                        </Avatar>
                        {/* Glanceable unread dot on the avatar. */}
                        {hasUnread && (
                          <span
                            aria-hidden
                            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-background bg-primary"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p
                            className={cn(
                              "truncate text-sm text-foreground",
                              hasUnread ? "font-bold" : "font-semibold",
                            )}
                          >
                            {c.participant.name}
                          </p>
                          <span
                            className={cn(
                              "shrink-0 text-[10px]",
                              hasUnread ? "font-semibold text-primary" : "text-muted-foreground",
                            )}
                          >
                            {relativeTime(c.lastMessageAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1">
                          {c.lastOutgoing && (
                            <MessageStatusIcon status={c.lastStatus} className="shrink-0 text-muted-foreground" />
                          )}
                          {/* min-w-0 + flex-1 so a long preview truncates instead
                              of pushing the unread badge off the right edge. */}
                          <p
                            className={cn(
                              "min-w-0 flex-1 truncate text-xs",
                              hasUnread ? "font-medium text-foreground" : "text-muted-foreground",
                            )}
                          >
                            {c.lastMessage}
                          </p>
                          {hasUnread && (
                            <Badge className="ml-1 h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[10px]">
                              {c.unread}
                              <span className="sr-only"> unread messages</span>
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      </div>
      )}

      {/* Thread view — min-w-0 is essential: without it this flex column keeps
          its intrinsic (content) min-width, so long message text / references
          widen the column past the viewport and push the composer's send button
          off-screen. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          hideConversationList ? "flex" : activeId ? "flex" : "hidden md:flex",
        )}
      >
        {!activeId || !activeParticipant ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
              <MessagesSquare className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">Bankeka Messenger</p>
            <p className="max-w-xs text-xs text-muted-foreground text-pretty">{emptyHint}</p>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="flex items-center gap-3 border-b border-border p-3">
              {!hideConversationList && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="md:hidden"
                  onClick={() => setActiveId(null)}
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              )}
              <Avatar className="h-9 w-9">
                <AvatarFallback
                  className={cn(
                    "text-xs",
                    activeParticipant.isAdmin
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-foreground",
                  )}
                >
                  {activeParticipant.isAdmin ? <ShieldCheck className="h-4 w-4" /> : activeParticipant.initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{activeParticipant.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {activeParticipant.isAdmin
                    ? "Official platform channel"
                    : activeParticipant.company || "Private thread"}
                </p>
              </div>
              <Badge variant="secondary" className="ml-auto hidden items-center gap-1 text-[10px] sm:flex">
                <ShieldCheck className="h-3 w-3 text-success" />
                Private
              </Badge>
            </div>

            {/* Messages — native overflow scroll (not Radix ScrollArea) so touch
                momentum scrolling works reliably on mobile, even over tall
                broadcast messages. touch-pan-y + overscroll-contain keep the
                gesture inside the thread. */}
            <div className="min-w-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain bg-background/40">
              <div className="flex min-w-0 flex-col gap-2 p-4">
                {messages.length === 0 ? (
                  <p className="py-10 text-center text-xs text-muted-foreground">
                    No messages yet. Say hello to start the conversation.
                  </p>
                ) : (
                  messages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      pending={m.id.startsWith("temp_")}
                      onDelete={deleteMessage ? handleDelete : undefined}
                    />
                  ))
                )}
                <div ref={scrollEndRef} />
              </div>
            </div>

            {/* Composer */}
            <div className="border-t border-border p-3">
              {/* Pending attachment chips (uploaded, awaiting send) */}
              {(attachments.length > 0 || uploading) && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {attachments.map((a, i) => (
                    <span
                      key={`${a.url}-${i}`}
                      className="flex max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{a.name}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                        aria-label={`Remove ${a.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                  {uploading && (
                    <span className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading…
                    </span>
                  )}
                </div>
              )}
              <div className="flex w-full min-w-0 items-end gap-2">
                {attachmentsEnabled && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => handleFiles(e.target.files)}
                      aria-hidden="true"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-11 w-11 shrink-0"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || sending || attachments.length >= BANKEKA_MAX_ATTACHMENTS_PER_MESSAGE}
                      aria-label="Attach a document"
                    >
                      <Paperclip className="h-5 w-5" />
                    </Button>
                  </>
                )}
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  placeholder="Type a message"
                  rows={1}
                  className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none text-base md:text-sm"
                  aria-label="Message"
                />
                <Button
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  onClick={handleSend}
                  disabled={sending || uploading || (!draft.trim() && attachments.length === 0)}
                  aria-label="Send message"
                >
                  {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
