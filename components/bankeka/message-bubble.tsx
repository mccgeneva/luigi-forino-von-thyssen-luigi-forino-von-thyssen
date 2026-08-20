"use client"

import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { MoreVertical, Trash2, FileText, Download, Landmark } from "lucide-react"
import { cn } from "@/lib/utils"
import { MessageStatusIcon } from "./message-status"
import type { BankekaAttachment } from "@/lib/bankeka-shared"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { BankekaMessage, MessageStatus } from "@/lib/bankeka-shared"

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

/**
 * A loan negotiation opener is a system-generated message of the form
 *   "Regarding your internal loan request INTE-XXXX-XXXX — EUR 10,000,000.00: <text>"
 * Detecting it lets us render a labelled topic header so the private loan
 * discussion is visually separated from broadcasts and casual chat in the
 * shared MCC Capital channel (they otherwise look identical). Returns the loan
 * reference, the amount label, and any remaining body text after the colon.
 */
function parseLoanTopic(body: string | undefined): { ref: string; amount: string; rest: string } | null {
  if (!body) return null
  const m = body.match(/^Regarding your internal loan request\s+(INTE-[A-Z0-9-]+)\s+—\s+([^:]+):\s*([\s\S]*)$/)
  if (!m) return null
  return { ref: m[1], amount: m[2].trim(), rest: m[3].trim() }
}

export function MessageBubble({
  message,
  pending,
  onDelete,
}: {
  message: BankekaMessage
  /** When true the message is an unconfirmed local echo (optimistic send). */
  pending?: boolean
  /** When provided, enables "Delete for me" on this message. */
  onDelete?: (id: string) => void
}) {
  const outgoing = message.outgoing
  const isBroadcast = message.kind === "broadcast" && !outgoing
  const loanTopic = message.kind === "broadcast" ? null : parseLoanTopic(message.body)
  const status: MessageStatus | "sending" = pending ? "sending" : message.status

  // Long-press / right-click opens the actions menu; a hover kebab is the mouse
  // affordance and the menu's anchor. Disabled for optimistic (pending) echoes.
  const canDelete = Boolean(onDelete) && !pending
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const pressTimer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)

  const clearTimer = () => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = undefined
    }
  }
  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canDelete || e.button === 2) return
    longPressed.current = false
    clearTimer()
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      navigator.vibrate?.(12)
      setMenuOpen(true)
    }, 450)
  }
  const onContextMenu = (e: ReactMouseEvent) => {
    if (!canDelete) return
    e.preventDefault()
    setMenuOpen(true)
  }

  return (
    <div className={cn("group flex w-full items-end gap-1", outgoing ? "justify-end" : "justify-start")}>
      {/* Mouse affordance (left of outgoing bubbles) */}
      {canDelete && outgoing && (
        <BubbleMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onDelete={() => setConfirmOpen(true)}
          side="left"
        />
      )}

      <div
        onPointerDown={onPointerDown}
        onPointerUp={clearTimer}
        onPointerMove={clearTimer}
        onPointerCancel={clearTimer}
        className={cn(
          // touch-pan-y: let vertical swipes scroll the thread instead of being
          // swallowed by the long-press handler on tall broadcast bubbles.
          "max-w-[80%] touch-pan-y select-none rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
          outgoing
            ? cn(
                "rounded-br-sm bg-primary text-primary-foreground",
                // Ring a loan-topic message the admin sent so it reads as a
                // formal loan thread, not a casual reply.
                loanTopic && "ring-1 ring-sky-300/50",
              )
            : isBroadcast
              ? "rounded-bl-sm border border-primary/30 bg-primary/10 text-foreground"
              : loanTopic
                ? "rounded-bl-sm border border-sky-500/30 bg-sky-500/10 text-foreground"
                : "rounded-bl-sm bg-secondary text-secondary-foreground",
        )}
        onContextMenu={onContextMenu}
      >
        {isBroadcast && (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">Broadcast</p>
        )}
        {loanTopic && (
          <div
            className={cn(
              "mb-1 flex items-center gap-1.5 border-b pb-1 text-[10px] font-semibold uppercase tracking-wider",
              outgoing ? "border-primary-foreground/25 text-primary-foreground/90" : "border-sky-500/25 text-sky-600 dark:text-sky-400",
            )}
          >
            <Landmark className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Internal Loan · {loanTopic.ref} · {loanTopic.amount}
            </span>
          </div>
        )}
        {loanTopic
          ? loanTopic.rest && <p className="whitespace-pre-wrap break-words normal-case">{loanTopic.rest}</p>
          : message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}
        {message.attachments && message.attachments.length > 0 && (
          <div className={cn("flex flex-col gap-1.5", message.body && "mt-2")}>
            {message.attachments.map((a, i) => (
              <AttachmentChip key={`${a.url}-${i}`} attachment={a} outgoing={outgoing} />
            ))}
          </div>
        )}
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1",
            outgoing ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          <span className="text-[10px] tabular-nums">{formatTime(message.createdAt)}</span>
          {outgoing && <MessageStatusIcon status={status} className="text-primary-foreground/80" />}
        </div>
      </div>

      {/* Mouse affordance (right of incoming bubbles) */}
      {canDelete && !outgoing && (
        <BubbleMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onDelete={() => setConfirmOpen(true)}
          side="right"
        />
      )}

      {canDelete && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this message?</AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">
                This removes the message from your view only. The other participant will still see it. This
                can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete?.(message.id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete for me
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** A single attachment rendered inside a bubble: image → tappable preview,
 *  everything else → a compact file chip. Both open/download in a new tab. */
function AttachmentChip({ attachment, outgoing }: { attachment: BankekaAttachment; outgoing: boolean }) {
  const isImage = (attachment.contentType ?? "").startsWith("image/")

  if (isImage) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-lg border border-black/10"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url || "/placeholder.svg"}
          alt={attachment.name}
          className="max-h-52 w-full object-cover"
          loading="lazy"
        />
      </a>
    )
  }

  const size = formatBytes(attachment.size)
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors",
        outgoing
          ? "border-primary-foreground/25 bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "border-border bg-background/60 hover:bg-background",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          outgoing ? "bg-primary-foreground/20" : "bg-secondary",
        )}
      >
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{attachment.name}</span>
        {size && <span className={cn("block", outgoing ? "text-primary-foreground/70" : "text-muted-foreground")}>{size}</span>}
      </span>
      <Download className={cn("h-4 w-4 shrink-0", outgoing ? "text-primary-foreground/70" : "text-muted-foreground")} />
    </a>
  )
}

/** The controlled actions menu: a subtle kebab (hover/focus affordance) that is
 *  also the anchor for the long-press-triggered menu. */
function BubbleMenu({
  open,
  onOpenChange,
  onDelete,
  side,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDelete: () => void
  side: "left" | "right"
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Message options"
          className={cn(
            // Always visible so the delete action is discoverable on touch
            // devices (no hover); a touch has no group-hover, so an opacity-0
            // kebab would never appear. Subtle by default, full on hover/open.
            "mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-70 transition-opacity hover:bg-secondary focus:opacity-100 focus-visible:outline-none group-hover:opacity-100 data-[state=open]:opacity-100",
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={side === "left" ? "end" : "start"} className="w-44">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            onDelete()
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete for me
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
