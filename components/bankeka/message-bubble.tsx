"use client"

import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { MoreVertical, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { MessageStatusIcon } from "./message-status"
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
          "max-w-[80%] select-none rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
          outgoing
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : isBroadcast
              ? "rounded-bl-sm border border-primary/30 bg-primary/10 text-foreground"
              : "rounded-bl-sm bg-secondary text-secondary-foreground",
        )}
        onContextMenu={onContextMenu}
      >
        {isBroadcast && (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">Broadcast</p>
        )}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
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
