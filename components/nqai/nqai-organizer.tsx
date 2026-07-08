"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  Plus,
  Trash2,
  Loader2,
  MessageSquare,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  FolderInput,
  X,
  Search,
  ArrowDownUp,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Check,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { NqaiFolder, NqaiThreadSummary } from "@/lib/nqai-chat-db"

/** Root drop-zone sentinel (distinct from a real folder id). */
export const ROOT_DROP = "__root__"

export type SortMode = "recent" | "name" | "messages"

const SORT_LABELS: Record<SortMode, string> = {
  recent: "Last updated",
  name: "Name (A–Z)",
  messages: "Message count",
}

// ---------------------------------------------------------------------------
// Time + text helpers
// ---------------------------------------------------------------------------

/** Compact, tabular relative timestamp (e.g. "3m", "5h", "2d", "Apr 9"). */
function relativeTime(iso: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diff = Date.now() - then
  const min = Math.floor(diff / 60000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** True when a thread was updated within the last 24h (recency indicator). */
function isRecent(iso: string): boolean {
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && Date.now() - t < 24 * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function childFolders(folders: NqaiFolder[], parentId: string | null): NqaiFolder[] {
  return folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name))
}

/** Threads directly inside a folder (excludes archived), sorted by mode. */
function folderThreads(threads: NqaiThreadSummary[], folderId: string | null, sort: SortMode = "recent"): NqaiThreadSummary[] {
  return sortThreads(
    threads.filter((t) => (t.folderId ?? null) === folderId && !t.archived),
    sort,
  )
}

/** Sort threads by the chosen key, always floating pinned to the top. */
function sortThreads(threads: NqaiThreadSummary[], mode: SortMode): NqaiThreadSummary[] {
  const arr = [...threads]
  if (mode === "name") arr.sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled"))
  else if (mode === "messages") arr.sort((a, b) => b.messageCount - a.messageCount)
  else arr.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
  // Stable secondary pass: pinned first.
  arr.sort((a, b) => Number(b.pinned) - Number(a.pinned))
  return arr
}

/** Collect a folder's id and all descendant folder ids (for move guards). */
export function folderSubtreeIds(folders: NqaiFolder[], folderId: string): Set<string> {
  const out = new Set<string>([folderId])
  let added = true
  while (added) {
    added = false
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id)
        added = true
      }
    }
  }
  return out
}

/** Recursive count of non-archived threads inside a folder (incl. subfolders). */
function deepThreadCount(folders: NqaiFolder[], threads: NqaiThreadSummary[], folderId: string): number {
  const ids = folderSubtreeIds(folders, folderId)
  return threads.filter((t) => t.folderId && ids.has(t.folderId) && !t.archived).length
}

/** Human-readable folder path for a thread (used in search results). */
function folderPath(folders: NqaiFolder[], folderId: string | null): string {
  if (!folderId) return "Unfiled"
  const byId = new Map(folders.map((f) => [f.id, f]))
  const parts: string[] = []
  let cursor: string | null = folderId
  let guard = 0
  while (cursor && guard++ < 100) {
    const f = byId.get(cursor)
    if (!f) break
    parts.unshift(f.name)
    cursor = f.parentId
  }
  return parts.join(" / ") || "Unfiled"
}

/** Flatten folders into an indented list for "Move to…" pickers. */
function flattenForPicker(
  folders: NqaiFolder[],
  exclude: Set<string>,
  parentId: string | null = null,
  depth = 0,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = []
  for (const f of childFolders(folders, parentId)) {
    if (exclude.has(f.id)) continue
    out.push({ id: f.id, name: f.name, depth })
    out.push(...flattenForPicker(folders, exclude, f.id, depth + 1))
  }
  return out
}

/** Score + rank threads against a query across title, preview, summary, folder. */
function searchThreads(
  threads: NqaiThreadSummary[],
  folders: NqaiFolder[],
  q: string,
): NqaiThreadSummary[] {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const folderName = new Map(folders.map((f) => [f.id, f.name.toLowerCase()]))
  const scored: { t: NqaiThreadSummary; score: number }[] = []
  for (const t of threads) {
    const title = (t.title || "").toLowerCase()
    const preview = (t.preview || "").toLowerCase()
    const summary = (t.summary || "").toLowerCase()
    const fname = t.folderId ? folderName.get(t.folderId) || "" : ""
    let score = 0
    if (title.includes(query)) score += 4
    if (preview.includes(query)) score += 2
    if (summary.includes(query)) score += 1
    if (fname.includes(query)) score += 1
    if (score > 0) scored.push({ t, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.t.updatedAt || "").localeCompare(a.t.updatedAt || ""))
  return scored.map((s) => s.t)
}

// ---------------------------------------------------------------------------
// Shared context so the recursive nodes don't need deep prop drilling
// ---------------------------------------------------------------------------

interface OrganizerCtx {
  folders: NqaiFolder[]
  threads: NqaiThreadSummary[]
  sortMode: SortMode
  activeThreadId: string | null
  loadingThreadId: string | null
  expanded: Set<string>
  toggle: (id: string) => void
  focusedFolderId: string | null
  setFocusedFolderId: (id: string | null) => void
  renamingId: string | null
  setRenamingId: (id: string | null) => void
  onSelectThread: (id: string) => void
  onDeleteThread: (id: string) => void
  onRenameThread: (id: string, title: string) => void
  onPinThread: (id: string, pinned: boolean) => void
  onArchiveThread: (id: string, archived: boolean) => void
  onCreateFolder: (parentId: string | null) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onMoveThread: (threadId: string, folderId: string | null) => void
  onMoveFolder: (folderId: string, parentId: string | null) => void
  drag: { type: "thread" | "folder"; id: string } | null
  setDrag: (v: { type: "thread" | "folder"; id: string } | null) => void
  dropTarget: string | null
  setDropTarget: (v: string | null) => void
}

const OrganizerContext = createContext<OrganizerCtx | null>(null)
function useOrganizer() {
  const ctx = useContext(OrganizerContext)
  if (!ctx) throw new Error("useOrganizer must be used within OrganizerProvider")
  return ctx
}

// ---------------------------------------------------------------------------
// Inline rename editor
// ---------------------------------------------------------------------------

function InlineRename({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          onCommit(value.trim())
        } else if (e.key === "Escape") {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => {
        const v = value.trim()
        if (v && v !== initial) onCommit(v)
        else onCancel()
      }}
      className="min-w-0 flex-1 rounded-sm border border-primary/50 bg-background px-1 py-0.5 text-xs text-foreground focus:outline-none"
      aria-label="Rename"
    />
  )
}

// ---------------------------------------------------------------------------
// "Move to…" picker — a dialog (NOT a nested submenu).
// Radix submenus open on hover and do not reliably open on a touch tap, which
// left mobile users stuck on "Move to…". A dialog works on every input type.
// ---------------------------------------------------------------------------

function MoveToDialog({
  open,
  onOpenChange,
  exclude,
  currentFolderId,
  onPick,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  exclude: Set<string>
  currentFolderId: string | null
  onPick: (folderId: string | null) => void
  title: string
}) {
  const { folders } = useOrganizer()
  const options = useMemo(() => flattenForPicker(folders, exclude), [folders, exclude])

  const pick = (folderId: string | null) => {
    onPick(folderId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FolderInput className="h-4 w-4 text-primary" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] overflow-y-auto">
          <button
            type="button"
            disabled={currentFolderId === null}
            onClick={() => pick(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-3 py-2.5 text-left text-sm transition-colors",
              currentFolderId === null
                ? "cursor-default text-muted-foreground"
                : "text-foreground hover:bg-secondary",
            )}
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">Unfiled (root)</span>
            {currentFolderId === null && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </button>
          {options.map((o) => {
            const isCurrent = o.id === currentFolderId
            return (
              <button
                key={o.id}
                type="button"
                disabled={isCurrent}
                onClick={() => pick(o.id)}
                style={{ paddingLeft: o.depth * 14 + 12 }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm py-2.5 pr-3 text-left text-sm transition-colors",
                  isCurrent ? "cursor-default text-muted-foreground" : "text-foreground hover:bg-secondary",
                )}
              >
                <Folder className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{o.name}</span>
                {isCurrent && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Thread menu (shared by every thread surface)
// ---------------------------------------------------------------------------

function ThreadMenu({
  thread,
  open,
  onOpenChange,
}: {
  thread: NqaiThreadSummary
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const o = useOrganizer()
  const [moveOpen, setMoveOpen] = useState(false)
  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded-sm p-2 text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            aria-label="Conversation actions"
            title="Actions — or click and hold the chat"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => o.onPinThread(thread.id, !thread.pinned)}>
            {thread.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {thread.pinned ? "Unpin" : "Pin to top"}
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => o.setRenamingId(`t:${thread.id}`)}>
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-xs"
            onSelect={(e) => {
              // Defer so the menu finishes closing before the dialog opens
              // (avoids a focus race that can instantly dismiss the dialog).
              e.preventDefault()
              setTimeout(() => setMoveOpen(true), 0)
            }}
          >
            <FolderInput className="h-3.5 w-3.5" />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => o.onArchiveThread(thread.id, !thread.archived)}>
            {thread.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {thread.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-xs text-destructive focus:text-destructive"
            onSelect={() => o.onDeleteThread(thread.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MoveToDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        exclude={new Set()}
        currentFolderId={thread.folderId ?? null}
        onPick={(fid) => o.onMoveThread(thread.id, fid)}
        title={`Move "${thread.title || "Untitled"}" to…`}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Thread row (dense, single-line, with time + recency dot)
// ---------------------------------------------------------------------------

function ThreadRow({ thread, depth }: { thread: NqaiThreadSummary; depth: number }) {
  const o = useOrganizer()
  const isActive = thread.id === o.activeThreadId
  const isLoading = thread.id === o.loadingThreadId
  const isRenaming = o.renamingId === `t:${thread.id}`
  const recent = isRecent(thread.updatedAt) && !isActive

  // Click-and-hold (long press) and right-click both open the actions menu.
  const [menuOpen, setMenuOpen] = useState(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const longPressed = useRef(false)

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }
  const startPress = (e: ReactPointerEvent) => {
    if (isRenaming) return
    longPressed.current = false
    pressOrigin.current = { x: e.clientX, y: e.clientY }
    clearTimeout(pressTimer.current ?? undefined)
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      setMenuOpen(true)
      // Subtle haptic confirmation on supported touch devices.
      try {
        navigator.vibrate?.(12)
      } catch {
        /* no-op */
      }
    }, 450)
  }
  // Cancel the hold if the pointer moves enough to count as a scroll/drag.
  const movePress = (e: ReactPointerEvent) => {
    if (!pressOrigin.current) return
    const dx = Math.abs(e.clientX - pressOrigin.current.x)
    const dy = Math.abs(e.clientY - pressOrigin.current.y)
    if (dx > 10 || dy > 10) clearPress()
  }

  return (
    <div
      draggable={!isRenaming}
      onDragStart={(e) => {
        clearPress()
        o.setDrag({ type: "thread", id: thread.id })
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", thread.id)
      }}
      onDragEnd={() => {
        o.setDrag(null)
        o.setDropTarget(null)
      }}
      onContextMenu={(e) => {
        // Desktop right-click opens the same menu.
        if (isRenaming) return
        e.preventDefault()
        setMenuOpen(true)
      }}
      style={{ paddingLeft: depth * 12 + 8 }}
      className={cn(
        "group flex items-center gap-1.5 rounded-sm border py-1 pr-1 transition-colors select-none",
        isActive
          ? "border-primary/40 bg-primary/10"
          : "border-transparent hover:border-border hover:bg-secondary/50",
      )}
    >
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      ) : thread.pinned ? (
        <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : (
        <MessageSquare className={cn("h-3.5 w-3.5 shrink-0", isActive ? "text-primary" : "text-muted-foreground")} />
      )}
      {isRenaming ? (
        <InlineRename
          initial={thread.title || ""}
          onCommit={(v) => {
            o.onRenameThread(thread.id, v)
            o.setRenamingId(null)
          }}
          onCancel={() => o.setRenamingId(null)}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            // Suppress the select that follows a long-press release.
            if (longPressed.current) {
              longPressed.current = false
              return
            }
            o.onSelectThread(thread.id)
          }}
          onPointerDown={startPress}
          onPointerMove={movePress}
          onPointerUp={clearPress}
          onPointerLeave={clearPress}
          onPointerCancel={clearPress}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-label={`Open conversation: ${thread.title || "Untitled"}`}
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {thread.title || "Untitled conversation"}
          </span>
          {recent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Recently updated" />}
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {relativeTime(thread.updatedAt)}
          </span>
        </button>
      )}
      <ThreadMenu thread={thread} open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Folder row (recursive)
// ---------------------------------------------------------------------------

function FolderNode({ folder, depth }: { folder: NqaiFolder; depth: number }) {
  const o = useOrganizer()
  const isOpen = o.expanded.has(folder.id)
  const isRenaming = o.renamingId === `f:${folder.id}`
  const isDropTarget = o.dropTarget === folder.id
  const subFolders = childFolders(o.folders, folder.id)
  const threads = folderThreads(o.threads, folder.id, o.sortMode)
  const count = deepThreadCount(o.folders, o.threads, folder.id)

  const canAcceptDrag = (() => {
    if (!o.drag) return false
    if (o.drag.type === "thread") return true
    return !folderSubtreeIds(o.folders, o.drag.id).has(folder.id)
  })()

  const handleDrop = () => {
    if (!o.drag) return
    if (o.drag.type === "thread") o.onMoveThread(o.drag.id, folder.id)
    else if (canAcceptDrag) o.onMoveFolder(o.drag.id, folder.id)
    o.setDrag(null)
    o.setDropTarget(null)
  }

  return (
    <div>
      <div
        draggable={!isRenaming}
        onDragStart={(e) => {
          o.setDrag({ type: "folder", id: folder.id })
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData("text/plain", folder.id)
        }}
        onDragEnd={() => {
          o.setDrag(null)
          o.setDropTarget(null)
        }}
        onDragOver={(e) => {
          if (!o.drag || !canAcceptDrag) return
          e.preventDefault()
          if (o.dropTarget !== folder.id) o.setDropTarget(folder.id)
        }}
        onDragLeave={() => {
          if (o.dropTarget === folder.id) o.setDropTarget(null)
        }}
        onDrop={handleDrop}
        style={{ paddingLeft: depth * 12 + 4 }}
        className={cn(
          "group flex items-center gap-1 rounded-sm border py-1 pr-1 transition-colors",
          isDropTarget
            ? "border-primary bg-primary/15"
            : o.focusedFolderId === folder.id
              ? "border-primary/40 bg-primary/5"
              : "border-transparent hover:border-border hover:bg-secondary/40",
        )}
      >
        <button
          type="button"
          onClick={() => o.toggle(folder.id)}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={isOpen ? "Collapse folder" : "Expand folder"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
        </button>
        {isOpen ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
        )}
        {isRenaming ? (
          <InlineRename
            initial={folder.name}
            onCommit={(v) => {
              o.onRenameFolder(folder.id, v)
              o.setRenamingId(null)
            }}
            onCancel={() => o.setRenamingId(null)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              o.toggle(folder.id)
              o.setFocusedFolderId(folder.id)
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="truncate text-xs font-medium text-foreground">{folder.name}</span>
            {count > 0 && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
            )}
          </button>
        )}
        <FolderMenu folder={folder} />
      </div>

      {isOpen && (
        <div>
          {subFolders.map((f) => (
            <FolderNode key={f.id} folder={f} depth={depth + 1} />
          ))}
          {threads.map((t) => (
            <ThreadRow key={t.id} thread={t} depth={depth + 1} />
          ))}
          {subFolders.length === 0 && threads.length === 0 && (
            <p style={{ paddingLeft: (depth + 1) * 12 + 8 }} className="py-1 text-[10px] italic text-muted-foreground">
              Empty folder
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function FolderMenu({ folder }: { folder: NqaiFolder }) {
  const o = useOrganizer()
  const exclude = useMemo(() => folderSubtreeIds(o.folders, folder.id), [o.folders, folder.id])
  const [moveOpen, setMoveOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded-sm p-2 text-muted-foreground opacity-100 transition-opacity hover:text-foreground focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            aria-label="Folder actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => o.onCreateFolder(folder.id)}>
            <FolderPlus className="h-3.5 w-3.5" />
            New subfolder
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2 text-xs" onSelect={() => o.setRenamingId(`f:${folder.id}`)}>
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-xs"
            onSelect={(e) => {
              e.preventDefault()
              setTimeout(() => setMoveOpen(true), 0)
            }}
          >
            <FolderInput className="h-3.5 w-3.5" />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-xs text-destructive focus:text-destructive"
            onSelect={() => o.onDeleteFolder(folder.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MoveToDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        exclude={exclude}
        currentFolderId={folder.parentId}
        onPick={(pid) => o.onMoveFolder(folder.id, pid)}
        title={`Move "${folder.name}" to…`}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Root drop zone (drag here to unfile)
// ---------------------------------------------------------------------------

function RootArea({ children }: { children: ReactNode }) {
  const o = useOrganizer()
  const isTarget = o.dropTarget === ROOT_DROP
  return (
    <div
      onDragOver={(e) => {
        if (!o.drag) return
        e.preventDefault()
        if (o.dropTarget !== ROOT_DROP) o.setDropTarget(ROOT_DROP)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target && o.dropTarget === ROOT_DROP) o.setDropTarget(null)
      }}
      onDrop={() => {
        if (!o.drag) return
        if (o.drag.type === "thread") o.onMoveThread(o.drag.id, null)
        else o.onMoveFolder(o.drag.id, null)
        o.setDrag(null)
        o.setDropTarget(null)
      }}
      className={cn("rounded-sm", isTarget && o.drag && "ring-1 ring-primary/50")}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search box + sort control (shared toolbar)
// ---------------------------------------------------------------------------

function SortMenu({ value, onChange }: { value: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1 rounded-sm border border-border bg-background px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Sort conversations"
          title={`Sort: ${SORT_LABELS[value]}`}
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Sort</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
          <DropdownMenuItem key={m} className="gap-2 text-xs" onSelect={() => onChange(m)}>
            <Check className={cn("h-3.5 w-3.5", value === m ? "opacity-100" : "opacity-0")} />
            {SORT_LABELS[m]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Encapsulates search state, Cmd/Ctrl+K focus, and arrow/enter navigation. */
function useConsoleSearch(
  threads: NqaiThreadSummary[],
  folders: NqaiFolder[],
  onOpen: (id: string) => void,
) {
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchThreads(threads, folders, query), [threads, folders, query])

  useEffect(() => setHighlighted(0), [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘⇧K / Ctrl+Shift+K — ⌘K is reserved by the global command palette.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      if (query) setQuery("")
      else inputRef.current?.blur()
      return
    }
    if (!results.length) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const t = results[highlighted]
      if (t) {
        onOpen(t.id)
        setQuery("")
      }
    }
  }

  return { query, setQuery, results, inputRef, highlighted, setHighlighted, onInputKeyDown }
}

function SearchBox({
  query,
  setQuery,
  inputRef,
  onKeyDown,
}: {
  query: string
  setQuery: (v: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="relative flex-1">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search conversations…"
        className="h-7 w-full rounded-sm border border-border bg-background pl-7 pr-12 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
        aria-label="Search conversations"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
          <kbd className="pointer-events-none absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-secondary px-1 font-mono text-[9px] text-muted-foreground sm:block">
            ⌘⇧K
          </kbd>
      )}
    </div>
  )
}

/** Flat, ranked search results with keyboard highlight + rich preview. */
function SearchResults({
  results,
  folders,
  highlighted,
  setHighlighted,
}: {
  results: NqaiThreadSummary[]
  folders: NqaiFolder[]
  highlighted: number
  setHighlighted: (i: number) => void
}) {
  const o = useOrganizer()
  if (results.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No conversations match your search.</p>
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {results.map((t, i) => (
        <li key={t.id}>
          <div
            className={cn(
              "group flex items-start gap-2 rounded-sm border px-2 py-1.5 transition-colors",
              i === highlighted ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-secondary/50",
            )}
            onMouseEnter={() => setHighlighted(i)}
          >
            {t.pinned ? (
              <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <button
              type="button"
              onClick={() => o.onSelectThread(t.id)}
              className="flex min-w-0 flex-1 flex-col text-left"
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                  {t.title || "Untitled conversation"}
                </span>
                {t.archived && (
                  <span className="shrink-0 rounded-sm bg-secondary px-1 font-mono text-[9px] uppercase text-muted-foreground">
                    Arch
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {relativeTime(t.updatedAt)}
                </span>
              </span>
              {t.preview && <span className="mt-0.5 truncate text-[10px] text-muted-foreground">{t.preview}</span>}
              <span className="mt-0.5 flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                <Folder className="h-2.5 w-2.5" />
                {folderPath(folders, t.folderId)}
              </span>
            </button>
            <ThreadMenu thread={t} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Provider — wires parent state/handlers into the recursive tree
// ---------------------------------------------------------------------------

export interface OrganizerProps {
  folders: NqaiFolder[]
  threads: NqaiThreadSummary[]
  activeThreadId: string | null
  loadingThreadId: string | null
  expanded: Set<string>
  onToggle: (id: string) => void
  focusedFolderId: string | null
  onFocusFolder: (id: string | null) => void
  renamingId: string | null
  onRenamingId: (id: string | null) => void
  onSelectThread: (id: string) => void
  onDeleteThread: (id: string) => void
  onRenameThread: (id: string, title: string) => void
  onPinThread: (id: string, pinned: boolean) => void
  onArchiveThread: (id: string, archived: boolean) => void
  onCreateFolder: (parentId: string | null) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onMoveThread: (threadId: string, folderId: string | null) => void
  onMoveFolder: (folderId: string, parentId: string | null) => void
}

function OrganizerProvider({
  children,
  props,
  sortMode,
}: {
  children: ReactNode
  props: OrganizerProps
  sortMode: SortMode
}) {
  const [drag, setDrag] = useState<{ type: "thread" | "folder"; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const value: OrganizerCtx = {
    folders: props.folders,
    threads: props.threads,
    sortMode,
    activeThreadId: props.activeThreadId,
    loadingThreadId: props.loadingThreadId,
    expanded: props.expanded,
    toggle: props.onToggle,
    focusedFolderId: props.focusedFolderId,
    setFocusedFolderId: props.onFocusFolder,
    renamingId: props.renamingId,
    setRenamingId: props.onRenamingId,
    onSelectThread: props.onSelectThread,
    onDeleteThread: props.onDeleteThread,
    onRenameThread: props.onRenameThread,
    onPinThread: props.onPinThread,
    onArchiveThread: props.onArchiveThread,
    onCreateFolder: props.onCreateFolder,
    onRenameFolder: props.onRenameFolder,
    onDeleteFolder: props.onDeleteFolder,
    onMoveThread: props.onMoveThread,
    onMoveFolder: props.onMoveFolder,
    drag,
    setDrag,
    dropTarget,
    setDropTarget,
  }
  return <OrganizerContext.Provider value={value}>{children}</OrganizerContext.Provider>
}

/** Small uppercase section label used throughout the console. */
function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Sidebar panel
// ---------------------------------------------------------------------------

export function FolderTreePanel({
  props,
  onNewChat,
  onOpenManager,
  loadError = false,
  onRetry,
}: {
  props: OrganizerProps
  onNewChat: () => void
  onOpenManager: () => void
  /** True when the last history load failed (distinct from "no conversations"). */
  loadError?: boolean
  /** Retry loading the history. */
  onRetry?: () => void
}) {
  const [sortMode, setSortMode] = useState<SortMode>("recent")
  const [showArchived, setShowArchived] = useState(false)
  const search = useConsoleSearch(props.threads, props.folders, props.onSelectThread)

  const rootFolders = childFolders(props.folders, null)
  const rootThreads = folderThreads(props.threads, null, sortMode)
  const pinned = useMemo(
    () => sortThreads(props.threads.filter((t) => t.pinned && !t.archived), sortMode),
    [props.threads, sortMode],
  )
  const archived = useMemo(
    () => sortThreads(props.threads.filter((t) => t.archived), sortMode),
    [props.threads, sortMode],
  )
  const empty = props.folders.length === 0 && props.threads.length === 0
  const searching = search.query.trim().length > 0

  return (
    <OrganizerProvider props={props} sortMode={sortMode}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <Button type="button" size="sm" onClick={onNewChat} className="w-full justify-start gap-2" aria-label="Start a new conversation">
            <Plus className="h-4 w-4" />
            New chat
          </Button>
          <div className="flex items-center gap-1.5">
            <SearchBox
              query={search.query}
              setQuery={search.setQuery}
              inputRef={search.inputRef}
              onKeyDown={search.onInputKeyDown}
            />
            <SortMenu value={sortMode} onChange={setSortMode} />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => props.onCreateFolder(null)}
              className="flex-1 justify-center gap-1.5 text-[11px]"
              aria-label="Create a new folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New folder
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onOpenManager}
              className="flex-1 justify-center gap-1.5 text-[11px]"
              aria-label="Open the folder manager"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Manage
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {searching ? (
            <>
              <SectionLabel>
                Results · {search.results.length}
              </SectionLabel>
              <SearchResults
                results={search.results}
                folders={props.folders}
                highlighted={search.highlighted}
                setHighlighted={search.setHighlighted}
              />
            </>
          ) : empty && loadError ? (
            <div className="flex flex-col items-start gap-2 px-2 py-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Couldn&apos;t load your conversations just now. Your history is safe — this is only a
                temporary connection issue.
              </p>
              {onRetry && (
                <Button type="button" size="sm" variant="outline" onClick={onRetry} className="gap-1.5 text-[11px]">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              )}
            </div>
          ) : empty ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
              No saved conversations yet. Your chats are stored privately and will appear here.
            </p>
          ) : (
            <RootArea>
              <div className="flex flex-col gap-0.5">
                {pinned.length > 0 && (
                  <>
                    <SectionLabel className="flex items-center gap-1">
                      <Pin className="h-3 w-3" /> Pinned
                    </SectionLabel>
                    {pinned.map((t) => (
                      <ThreadRow key={`pin-${t.id}`} thread={t} depth={0} />
                    ))}
                    <div className="my-1 border-t border-border" />
                  </>
                )}
                {rootFolders.map((f) => (
                  <FolderNode key={f.id} folder={f} depth={0} />
                ))}
                {rootThreads.length > 0 && rootFolders.length > 0 && <SectionLabel className="mt-2">Unfiled</SectionLabel>}
                {rootThreads.map((t) => (
                  <ThreadRow key={t.id} thread={t} depth={0} />
                ))}

                {archived.length > 0 && (
                  <div className="mt-2 border-t border-border pt-1">
                    <button
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                      className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className={cn("h-3 w-3 transition-transform", showArchived && "rotate-90")} />
                      <Archive className="h-3 w-3" />
                      Archived · {archived.length}
                    </button>
                    {showArchived && archived.map((t) => <ThreadRow key={`arch-${t.id}`} thread={t} depth={0} />)}
                  </div>
                )}
              </div>
            </RootArea>
          )}
        </div>
      </div>
    </OrganizerProvider>
  )
}

// ---------------------------------------------------------------------------
// Full-screen manager
// ---------------------------------------------------------------------------

function Breadcrumb({
  folders,
  focusedId,
  onFocus,
}: {
  folders: NqaiFolder[]
  focusedId: string | null
  onFocus: (id: string | null) => void
}) {
  const trail: NqaiFolder[] = []
  let cursor = focusedId
  const byId = new Map(folders.map((f) => [f.id, f]))
  let guard = 0
  while (cursor && guard++ < 1000) {
    const f = byId.get(cursor)
    if (!f) break
    trail.unshift(f)
    cursor = f.parentId
  }
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
      <button
        type="button"
        onClick={() => onFocus(null)}
        className={cn("rounded-sm px-1.5 py-0.5 hover:bg-secondary", !focusedId && "font-semibold text-foreground")}
      >
        All conversations
      </button>
      {trail.map((f) => (
        <span key={f.id} className="flex items-center gap-1">
          <ChevronRight className="h-3 w-3" />
          <button
            type="button"
            onClick={() => onFocus(f.id)}
            className={cn("rounded-sm px-1.5 py-0.5 hover:bg-secondary", focusedId === f.id && "font-semibold text-foreground")}
          >
            {f.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

export function NqaiManager({
  props,
  onNewChat,
  onClose,
}: {
  props: OrganizerProps
  onNewChat: () => void
  onClose: () => void
}) {
  const [sortMode, setSortMode] = useState<SortMode>("recent")
  const search = useConsoleSearch(props.threads, props.folders, (id) => {
    props.onSelectThread(id)
    onClose()
  })
  const focused = props.focusedFolderId
  const subFolders = childFolders(props.folders, focused)
  const threads = folderThreads(props.threads, focused, sortMode)
  const searching = search.query.trim().length > 0

  const pinned = useMemo(
    () => sortThreads(props.threads.filter((t) => t.pinned && !t.archived), sortMode),
    [props.threads, sortMode],
  )

  // Esc closes the manager (unless a search query is active — that clears first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !search.query) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, search.query])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-primary" />
          <div className="leading-tight">
            <p className="text-sm font-semibold text-foreground">Conversation Manager</p>
            <p className="text-[11px] text-muted-foreground">
              Search, organize, pin, and archive your NQAi conversations
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden w-56 md:block">
            <SearchBox
              query={search.query}
              setQuery={search.setQuery}
              inputRef={search.inputRef}
              onKeyDown={search.onInputKeyDown}
            />
          </div>
          <SortMenu value={sortMode} onChange={setSortMode} />
          <Button type="button" size="sm" variant="outline" onClick={() => props.onCreateFolder(null)} className="gap-1.5 text-[11px]">
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New root folder</span>
          </Button>
          <Button type="button" size="sm" onClick={onNewChat} className="gap-1.5 text-[11px]">
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Close manager"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Mobile search */}
      <div className="border-b border-border bg-card px-4 py-2 md:hidden">
        <SearchBox
          query={search.query}
          setQuery={search.setQuery}
          inputRef={search.inputRef}
          onKeyDown={search.onInputKeyDown}
        />
      </div>

      <OrganizerProvider props={props} sortMode={sortMode}>
        <div className="flex min-h-0 flex-1">
          {/* Left: tree */}
          <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-card md:flex">
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <SectionLabel>Folders</SectionLabel>
              <RootArea>
                <div className="flex flex-col gap-0.5">
                  {childFolders(props.folders, null).map((f) => (
                    <FolderNode key={f.id} folder={f} depth={0} />
                  ))}
                  {folderThreads(props.threads, null, sortMode).map((t) => (
                    <ThreadRow key={t.id} thread={t} depth={0} />
                  ))}
                </div>
              </RootArea>
            </div>
          </aside>

          {/* Right: search results OR focused folder contents */}
          <section className="flex min-h-0 flex-1 flex-col">
            {!searching && (
              <div className="border-b border-border px-4 py-3">
                <Breadcrumb folders={props.folders} focusedId={focused} onFocus={props.onFocusFolder} />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {searching ? (
                <>
                  <SectionLabel className="mb-1">Results · {search.results.length}</SectionLabel>
                  <SearchResults
                    results={search.results}
                    folders={props.folders}
                    highlighted={search.highlighted}
                    setHighlighted={search.setHighlighted}
                  />
                </>
              ) : (
                <>
                  {!focused && pinned.length > 0 && (
                    <div className="mb-4">
                      <SectionLabel className="mb-1 flex items-center gap-1">
                        <Pin className="h-3 w-3" /> Pinned
                      </SectionLabel>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {pinned.map((t) => (
                          <ManagerThreadCard key={`pin-${t.id}`} thread={t} />
                        ))}
                      </div>
                    </div>
                  )}
                  {subFolders.length === 0 && threads.length === 0 && (!focused ? pinned.length === 0 : true) ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                      <Folder className="h-10 w-10 opacity-40" />
                      <p className="text-sm">This folder is empty.</p>
                      <p className="text-xs">Create a subfolder, or drag conversations here from the tree.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {subFolders.map((f) => (
                        <ManagerFolderCard key={f.id} folder={f} onFocus={props.onFocusFolder} />
                      ))}
                      {threads.map((t) => (
                        <ManagerThreadCard key={t.id} thread={t} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </OrganizerProvider>
    </div>
  )
}

/** Always-visible Rename button for the full-screen Manager cards. A pencil is
 *  universally understood, unlike the easily-missed "⋯" menu — this is the
 *  primary fix for users not finding how to rename. */
function RenameButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Pencil className="h-4 w-4" />
    </button>
  )
}

/** Always-visible Delete button + confirmation dialog for the Manager cards.
 *  Deletes are immediate/destructive server-side, so we always confirm first. */
function DeleteButton({
  label,
  description,
  onConfirm,
}: {
  label: string
  description: string
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-destructive/30 text-destructive transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onConfirm()
                setOpen(false)
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ManagerFolderCard({ folder, onFocus }: { folder: NqaiFolder; onFocus: (id: string) => void }) {
  const o = useOrganizer()
  const count = deepThreadCount(o.folders, o.threads, folder.id)
  const isDropTarget = o.dropTarget === folder.id
  const isRenaming = o.renamingId === `f:${folder.id}`
  const canAccept = !o.drag || o.drag.type === "thread" || !folderSubtreeIds(o.folders, o.drag.id).has(folder.id)
  return (
    <div
      onDragOver={(e) => {
        if (!o.drag || !canAccept) return
        e.preventDefault()
        if (o.dropTarget !== folder.id) o.setDropTarget(folder.id)
      }}
      onDragLeave={() => o.dropTarget === folder.id && o.setDropTarget(null)}
      onDrop={() => {
        if (!o.drag) return
        if (o.drag.type === "thread") o.onMoveThread(o.drag.id, folder.id)
        else if (canAccept) o.onMoveFolder(o.drag.id, folder.id)
        o.setDrag(null)
        o.setDropTarget(null)
      }}
      className={cn(
        "group flex items-center gap-2 rounded-sm border bg-card p-3 transition-colors",
        isDropTarget ? "border-primary bg-primary/10" : "border-border hover:border-primary/40",
      )}
    >
      <Folder className="h-5 w-5 shrink-0 text-primary" />
      {isRenaming ? (
        <InlineRename
          initial={folder.name}
          onCommit={(v) => {
            o.onRenameFolder(folder.id, v)
            o.setRenamingId(null)
          }}
          onCancel={() => o.setRenamingId(null)}
        />
      ) : (
        <button type="button" onClick={() => onFocus(folder.id)} className="flex min-w-0 flex-1 items-center text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{folder.name}</span>
            <span className="block font-mono text-[11px] text-muted-foreground">
              {count} {count === 1 ? "chat" : "chats"}
            </span>
          </span>
        </button>
      )}
      {!isRenaming && (
        <>
          <RenameButton label="Rename folder" onClick={() => o.setRenamingId(`f:${folder.id}`)} />
          <DeleteButton
            label="Delete folder"
            description={
              count > 0
                ? `Delete "${folder.name}"? Its ${count} ${count === 1 ? "conversation" : "conversations"} and any subfolders will be moved up, not deleted.`
                : `Delete the empty folder "${folder.name}"? This cannot be undone.`
            }
            onConfirm={() => o.onDeleteFolder(folder.id)}
          />
          <FolderMenu folder={folder} />
        </>
      )}
    </div>
  )
}

function ManagerThreadCard({ thread }: { thread: NqaiThreadSummary }) {
  const o = useOrganizer()
  const recent = isRecent(thread.updatedAt) && thread.id !== o.activeThreadId
  const isRenaming = o.renamingId === `t:${thread.id}`
  return (
    <div
      draggable
      onDragStart={(e) => {
        o.setDrag({ type: "thread", id: thread.id })
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", thread.id)
      }}
      onDragEnd={() => {
        o.setDrag(null)
        o.setDropTarget(null)
      }}
      className="group flex items-start gap-2 rounded-sm border border-border bg-card p-3 transition-colors hover:border-primary/40"
    >
      {thread.pinned ? (
        <Pin className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      ) : (
        <MessageSquare className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
      )}
      {isRenaming ? (
        <div className="flex min-w-0 flex-1 items-center">
          <InlineRename
            initial={thread.title || "Untitled conversation"}
            onCommit={(v) => {
              o.onRenameThread(thread.id, v)
              o.setRenamingId(null)
            }}
            onCancel={() => o.setRenamingId(null)}
          />
        </div>
      ) : (
        <button type="button" onClick={() => o.onSelectThread(thread.id)} className="flex min-w-0 flex-1 flex-col text-left">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {thread.title || "Untitled conversation"}
            </span>
            {recent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Recently updated" />}
          </span>
          {thread.preview && <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{thread.preview}</span>}
          <span className="mt-1 flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>{relativeTime(thread.updatedAt)}</span>
            <span>·</span>
            <span>{thread.messageCount} msg</span>
            {thread.archived && <span className="rounded-sm bg-secondary px-1 uppercase">Arch</span>}
          </span>
        </button>
      )}
      {!isRenaming && (
        <>
          <RenameButton label="Rename conversation" onClick={() => o.setRenamingId(`t:${thread.id}`)} />
          <DeleteButton
            label="Delete conversation"
            description={`Delete "${thread.title || "Untitled conversation"}"? This permanently removes the conversation and cannot be undone.`}
            onConfirm={() => o.onDeleteThread(thread.id)}
          />
          <ThreadMenu thread={thread} />
        </>
      )}
    </div>
  )
}
