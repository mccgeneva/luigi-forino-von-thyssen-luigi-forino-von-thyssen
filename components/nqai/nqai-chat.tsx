"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type UIMessage } from "ai"
import { Streamdown } from "streamdown"
import {
  Cpu,
  ArrowUp,
  Square,
  AlertTriangle,
  Sparkles,
  User,
  Ship,
  Radar,
  Warehouse,
  Loader2,
  BookOpen,
  Maximize2,
  Minimize2,
  Send,
  Paperclip,
  FileText,
  FileSpreadsheet,
  ImageIcon,
  Download,
  X,
  Plus,
  History,
  RotateCcw,
  FolderTree,
  ChevronUp,
  ChevronDown,
  CornerDownRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { NQAI_WELCOME, NQAI_TAGLINE, NQAI_SUGGESTIONS } from "@/lib/nqai"
import {
  bootstrapNqai,
  listNqaiOrganizerAction,
  loadNqaiThreadAction,
  deleteNqaiThreadAction,
  renameNqaiThreadAction,
  pinNqaiThreadAction,
  archiveNqaiThreadAction,
  createNqaiFolderAction,
  renameNqaiFolderAction,
  deleteNqaiFolderAction,
  moveNqaiThreadAction,
  moveNqaiFolderAction,
} from "@/app/actions/nqai"
import type { NqaiThreadSummary, NqaiFolder } from "@/lib/nqai-chat-db"
import { FolderTreePanel, NqaiManager, folderSubtreeIds, type OrganizerProps } from "@/components/nqai/nqai-organizer"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { useCurrentUser } from "@/lib/use-current-user"
import { generateNqaiDocumentPdf } from "@/lib/nqai-document-pdf"
import { warmPdfLogos, pickPdfBrand, type PdfBrand } from "@/lib/pdf-logos"

/** Client-accepted upload types and the limit, mirrored by the upload route.
 *  Office/rich-text/tiff/bin are extracted or converted server-side into a
 *  model-ingestible payload (text or PNG). */
const ACCEPTED_UPLOAD =
  ".pdf,.doc,.docx,.rtf,.txt,.csv,.gif,.jpg,.jpeg,.png,.webp,.tif,.tiff,.heic,.heif,.bmp,.avif,.bin," +
  "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/rtf,text/rtf,text/plain,text/csv,image/*,application/octet-stream"
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Resilience tuning for auto-recovering an interrupted streaming turn.
 *  A backgrounded mobile tab suspends JS and silently drops the streaming
 *  socket, leaving a turn hung forever (no error, no completion) — the "frozen,
 *  must restart" symptom. These bound how aggressively we auto-resume. */
const MAX_AUTO_RECOVERIES = 2 // per turn, so a genuinely broken turn can't loop
const STALL_MS = 45000 // no streamed content for this long ⇒ hung (safety net); above the ~22s tool-call ceiling to avoid false trips
const VISIBILITY_GRACE_MS = 3500 // after returning to the tab, wait this long for the stream to resume on its own before restarting
const POST_RETURN_ERROR_WINDOW_MS = 12000 // an error surfacing within this long after returning is treated as a dropped-socket casualty, not a genuine fault

interface PendingAttachment {
  id: string
  name: string
  size: number
  mediaType: string
  status: "uploading" | "ready" | "error"
  url?: string
  error?: string
}

/** A file attached to a (user) message, reconstructed from its parts. */
interface MessageFile {
  url: string
  name: string
  mediaType: string
}

/** Pick an icon for an attachment based on its media type. */
function fileIcon(mediaType: string) {
  if (mediaType.startsWith("image/")) return ImageIcon
  if (mediaType === "application/pdf") return FileText
  if (mediaType.includes("csv")) return FileSpreadsheet
  return FileText
}

/**
 * Produce an accurate, human message for a chat error. The previous text always
 * blamed the Anthropic key, which was misleading — most failures are transient
 * stream faults or timeouts on heavy document analysis, which simply need a retry.
 */
function describeNqaiError(error: Error | undefined): string {
  const raw = (error?.message || "").toLowerCase()
  if (raw.includes("api key") || raw.includes("not configured") || raw.includes("offline")) {
    return "NQAi is offline — the Anthropic key is not configured. Add ANTHROPIC_API_KEY, then try again."
  }
  if (raw.includes("could not read") || raw.includes("attachment")) {
    return "NQAi could not read an attachment in this conversation. Try removing it or starting a new chat."
  }
  return "NQAi hit a transient fault (the request may have taken too long, e.g. a large document). Please try again."
}

function formatBytes(bytes: number): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Extract file attachments from a message's parts. */
function messageFiles(message: UIMessage): MessageFile[] {
  if (!message.parts) return []
  const out: MessageFile[] = []
  message.parts.forEach((p) => {
    const part = p as { type?: string; url?: string; mediaType?: string; filename?: string }
    if (part.type === "file" && part.url) {
      out.push({
        url: part.url,
        name: part.filename || "attachment",
        mediaType: part.mediaType || "application/octet-stream",
      })
    }
  })
  return out
}

/** A document NQAi authored via the createDocument tool, ready to download. */
interface DocArtifact {
  key: string
  title: string
  markdown: string
  brand?: PdfBrand | null
}

/** Extract finished createDocument artifacts from an assistant message. */
function documentArtifacts(message: UIMessage): DocArtifact[] {
  if (!message.parts) return []
  const out: DocArtifact[] = []
  message.parts.forEach((p, i) => {
    const part = p as {
      type?: string
      state?: string
      output?: { ok?: boolean; title?: string; markdown?: string; brand?: PdfBrand | null }
    }
    if (part.type !== "tool-createDocument") return
    const o = part.output
    if (part.state === "output-available" && o?.ok && o.markdown) {
      out.push({ key: `doc-${i}`, title: o.title || "NQAi Document", markdown: o.markdown, brand: o.brand ?? null })
    }
  })
  return out
}

/** Extract the plain-text content from a UIMessage's parts array. */
function messageText(message: UIMessage): string {
  if (!message.parts) return ""
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

/** Human labels for NQAi's live data tools, shown as activity chips. */
// Present-tense labels shown while a tool is still running.
const TOOL_LABELS: Record<string, string> = {
  "tool-verifyVessel": "Verifying vessel",
  "tool-searchVessels": "Searching vessel catalogue",
  "tool-listSpotDeals": "Scanning spot-deal board",
  "tool-discoverOilDeals": "Matching vessels & oil deals",
  "tool-vesselDataProviderStatus": "Checking AIS provider",
  "tool-findTankStorage": "Searching tank terminals",
  "tool-getTerminalDetails": "Loading terminal profile",
  "tool-searchResearch": "Searching global research",
  "tool-lookupInstitution": "Looking up institution",
  "tool-exploreConcept": "Mapping research field",
  "tool-sendEmail": "Sending email",
  "tool-sendSms": "Sending SMS",
  "tool-createDocument": "Drafting document",
}

// Past-tense labels shown once a tool has finished successfully, so a completed
// chip never looks like it is perpetually "Sending…".
const TOOL_DONE_LABELS: Record<string, string> = {
  "tool-verifyVessel": "Vessel verified",
  "tool-searchVessels": "Catalogue searched",
  "tool-listSpotDeals": "Spot-deal board scanned",
  "tool-discoverOilDeals": "Vessels & deals matched",
  "tool-vesselDataProviderStatus": "AIS provider checked",
  "tool-findTankStorage": "Tank terminals found",
  "tool-getTerminalDetails": "Terminal profile loaded",
  "tool-searchResearch": "Research retrieved",
  "tool-lookupInstitution": "Institution found",
  "tool-exploreConcept": "Field mapped",
  "tool-sendEmail": "Email sent",
  "tool-sendSms": "SMS sent",
  "tool-createDocument": "Document ready",
}

// Labels shown when a tool finished but reported a failure (e.g. email not
// configured, invalid recipient, provider error).
const TOOL_FAIL_LABELS: Record<string, string> = {
  "tool-sendEmail": "Email failed",
  "tool-sendSms": "SMS failed",
}

/** Tool keys that belong to the knowledge/research layer (book icon). */
const KNOWLEDGE_TOOLS = new Set(["tool-searchResearch", "tool-lookupInstitution", "tool-exploreConcept"])

/** Tool keys that send an outbound message (send icon). */
const MESSAGING_TOOLS = new Set(["tool-sendEmail", "tool-sendSms"])

  /** Tool keys that author a document (file icon). */
  const DOCUMENT_TOOLS = new Set(["tool-createDocument"])

  /** Tool keys that query tank terminals / storage (warehouse icon). */
  const STORAGE_TOOLS = new Set(["tool-findTankStorage", "tool-getTerminalDetails"])

interface ToolActivity {
  key: string
  label: string
  done: boolean
  failed: boolean
  kind: "vessel" | "knowledge" | "messaging" | "document" | "storage"
}

/** Collect tool invocations from a message's parts for the activity strip. */
function toolActivity(message: UIMessage): ToolActivity[] {
  if (!message.parts) return []
  const out: ToolActivity[] = []
  message.parts.forEach((p, i) => {
    const type = (p as { type?: string }).type ?? ""
    if (!type.startsWith("tool-")) return
    if (!(type in TOOL_LABELS)) return
    const state = (p as { state?: string }).state ?? ""
    const done = state === "output-available" || state === "output-error"
    // A tool can finish "successfully" (output-available) yet still report a
    // logical failure via `{ ok: false }` in its output (e.g. email not
    // configured). Treat both as a failed chip so the user sees it plainly.
    const output = (p as { output?: { ok?: boolean } }).output
    const failed = done && (state === "output-error" || output?.ok === false)
    const label = failed
      ? TOOL_FAIL_LABELS[type] ?? `${TOOL_LABELS[type]} — failed`
      : done
        ? TOOL_DONE_LABELS[type] ?? TOOL_LABELS[type]
        : TOOL_LABELS[type]
    out.push({
      key: `${type}-${i}`,
      label,
      done,
      failed,
      kind: KNOWLEDGE_TOOLS.has(type)
        ? "knowledge"
        : MESSAGING_TOOLS.has(type)
          ? "messaging"
          : DOCUMENT_TOOLS.has(type)
            ? "document"
            : STORAGE_TOOLS.has(type)
              ? "storage"
              : "vessel",
    })
  })
  return out
}

function NqaiAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-primary/40 bg-primary/10 text-primary",
        className,
      )}
      aria-hidden="true"
    >
      <Cpu className="h-3.5 w-3.5" />
    </span>
  )
}

export function NqaiChat({ variant = "page" }: { variant?: "page" | "panel" }) {
  const [input, setInput] = useState("")
  const [greeting, setGreeting] = useState("")
  const [bootstrapped, setBootstrapped] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Multi-thread history state.
  const [threads, setThreads] = useState<NqaiThreadSummary[]>([])
  // True only when a history LOAD actually failed (vs. the user genuinely
  // having no saved conversations). Drives a "couldn't load — retry" state so a
  // transient DB hiccup never looks like lost history.
  const [historyLoadError, setHistoryLoadError] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Folder organizer state.
  const [folders, setFolders] = useState<NqaiFolder[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [focusedFolderId, setFocusedFolderId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The active thread id is read inside the transport at send time, so keep a
  // ref in sync with the state to avoid stale closures.
  const activeThreadIdRef = useRef<string | null>(null)
  // Build the transport once; inject the current thread id into every request.
  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null)
  if (!transportRef.current) {
    transportRef.current = new DefaultChatTransport<UIMessage>({
      api: "/api/nqai",
      prepareSendMessagesRequest: ({ body, messages, id }) => ({
        body: { ...body, messages, id, threadId: activeThreadIdRef.current ?? "" },
      }),
    })
  }
  const { messages, sendMessage, setMessages, status, error, stop, regenerate, clearError } = useChat({
    transport: transportRef.current,
  })
  const pdf = usePdfViewer()
  const user = useCurrentUser()
  const clientName = [user?.fullName, user?.company].filter(Boolean).join(" — ") || undefined

  const busy = status === "submitted" || status === "streaming"
  const hasConversation = messages.length > 0
  // Gate the portal so it only renders client-side (avoids SSR/hydration issues).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const uploadingFiles = attachments.some((a) => a.status === "uploading")
  const readyFiles = attachments.filter((a) => a.status === "ready" && a.url)
  const canSend = !busy && !uploadingFiles && (input.trim().length > 0 || readyFiles.length > 0)

  // ── Resilience: never leave a turn "frozen" after a tab/app switch ──────────
  // Mirror status/messages into refs so the watchdog closures below always read
  // live values without re-subscribing. `lastActivityRef` tracks the last time
  // streamed content arrived; the rest bound the auto-recovery attempts.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const statusRef = useRef(status)
  statusRef.current = status
  const lastActivityRef = useRef(Date.now())
  const hiddenAtRef = useRef(0)
  const becameVisibleAtRef = useRef(0)
  const lastHiddenForRef = useRef(0)
  const recoveringRef = useRef(false)
  const recoveryAttemptsRef = useRef(0)
  const [recovering, setRecovering] = useState(false)

  // Resume an interrupted turn. The server persists a turn ONLY in onFinish
  // (never on an aborted/dropped stream), so the in-memory transcript is
  // authoritative — we must NOT reload from the DB here (that would lose the
  // just-sent user message). regenerate() keeps a trailing user message (or
  // drops a half-streamed assistant one) and re-runs the turn.
  //
  // We recover TWO post-background states: (1) HUNG — the socket died silently
  // and status is still submitted/streaming; (2) ERRORED — iOS/Safari abort the
  // in-flight fetch when the tab is backgrounded, so useChat surfaces an error
  // (the "transient fault" banner). Both are the same underlying cause: the app
  // was switched away mid-turn. A genuine foreground error (real 503/no-key) is
  // NOT auto-recovered — only errors tied to a recent tab return are.
  const attemptRecovery = useCallback(
    async (reason: string) => {
      if (recoveringRef.current) return
      const s = statusRef.current
      const canRecover = s === "submitted" || s === "streaming" || s === "error"
      if (!canRecover) return
      if (messagesRef.current.length === 0) return
      if (recoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES) return
      recoveringRef.current = true
      recoveryAttemptsRef.current += 1
      setRecovering(true)
      console.log(`[v0] NQAi resuming interrupted turn (${reason}); attempt ${recoveryAttemptsRef.current}`)
      try {
        await stop() // tear down the dead/hung stream and reset status
        clearError()
        // Fire-and-forget: regenerate() only resolves when the WHOLE resumed turn
        // finishes (and never, if that stream also hangs), so we must not await it
        // — doing so would pin the guard/banner for the entire answer. We kick it
        // and release the guard shortly after so a fresh interruption can recover
        // again (bounded by MAX_AUTO_RECOVERIES).
        regenerate().catch((err) =>
          console.log("[v0] NQAi resume request failed:", err instanceof Error ? err.message : String(err)),
        )
        lastActivityRef.current = Date.now()
      } catch (err) {
        console.log("[v0] NQAi recovery failed:", err instanceof Error ? err.message : String(err))
      } finally {
        window.setTimeout(() => {
          recoveringRef.current = false
          setRecovering(false)
        }, 1200)
      }
    },
    [stop, clearError, regenerate],
  )

  // Track streamed progress (baseline while busy, and on every chunk) and reset
  // the per-turn recovery budget once a turn completes cleanly.
  useEffect(() => {
    if (busy) lastActivityRef.current = Date.now()
  }, [messages, busy])
  useEffect(() => {
    if (status === "ready") recoveryAttemptsRef.current = 0
  }, [status])

  // Auto-recover when a turn ERRORS shortly after returning from the background.
  // iOS aborts the in-flight fetch on backgrounding, so the turn surfaces an
  // error (not a hang) the moment we come back. Only treat it as a tab-switch
  // casualty if we were genuinely hidden and just returned — foreground errors
  // keep their manual Retry.
  useEffect(() => {
    if (status !== "error") return
    const sinceReturn = becameVisibleAtRef.current ? Date.now() - becameVisibleAtRef.current : Number.POSITIVE_INFINITY
    if (lastHiddenForRef.current >= 1500 && sinceReturn <= POST_RETURN_ERROR_WINDOW_MS) {
      void attemptRecovery("tab-return-error")
    }
  }, [status, attemptRecovery])

  // Watchdog + visibility recovery.
  useEffect(() => {
    // Safety net: while foregrounded, a stream that emits nothing for STALL_MS
    // is hung (a dead socket that never closed) — resume it.
    const interval = window.setInterval(() => {
      const s = statusRef.current
      if (s !== "submitted" && s !== "streaming") return
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastActivityRef.current > STALL_MS) void attemptRecovery("stall")
    }, 5000)

    // Primary trigger: the freeze happens on tab/app switch. On return, if the
    // turn is still hung after a short grace (nothing streamed in during it), the
    // socket is dead — resume. If it already errored, the error effect above
    // handles it immediately.
    let graceTimer: number | undefined
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now()
        return
      }
      const hiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0
      hiddenAtRef.current = 0
      lastHiddenForRef.current = hiddenFor
      becameVisibleAtRef.current = Date.now()
      const s = statusRef.current
      if (hiddenFor < 1500) return // brief blur can't kill the socket
      // Already errored on return → recover now.
      if (s === "error") {
        void attemptRecovery("tab-return-error")
        return
      }
      const mid = s === "submitted" || s === "streaming"
      if (!mid) return
      window.clearTimeout(graceTimer)
      const activityBefore = lastActivityRef.current
      graceTimer = window.setTimeout(() => {
        const st = statusRef.current
        const stillMid = st === "submitted" || st === "streaming"
        // Resume if still hung with no new content, OR it errored during the grace.
        if ((stillMid && lastActivityRef.current === activityBefore) || st === "error") {
          void attemptRecovery("tab-return")
        }
      }, VISIBILITY_GRACE_MS)
    }

    document.addEventListener("visibilitychange", onVisible)
    // iOS bfcache restore is another "back to the app" signal.
    window.addEventListener("pageshow", onVisible)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(graceTimer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onVisible)
    }
  }, [attemptRecovery])

  // Download an NQAi-authored document as a branded PDF via the shared viewer.
  const downloadDocument = useCallback(
    async (artifact: DocArtifact) => {
      try {
        // Ensure the brand logos are loaded so the PDF carries the right mark.
        await warmPdfLogos()
        const brand: PdfBrand = artifact.brand ?? pickPdfBrand(artifact.title, artifact.markdown)
        const generated = generateNqaiDocumentPdf({
          title: artifact.title,
          markdown: artifact.markdown,
          clientName,
          brand,
        })
        pdf.show(generated)
      } catch (err) {
        console.log("[v0] NQAi document PDF failed:", err instanceof Error ? err.message : String(err))
      }
    },
    [pdf, clientName],
  )

  // Upload one file to Blob via the NQAi upload route, tracking its progress.
  const uploadAttachment = useCallback(async (id: string, file: File) => {
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch("/api/nqai/upload", { method: "POST", body: form })
      const data = (await res.json().catch(() => ({}))) as {
        url?: string
        mediaType?: string
        error?: string
      }
      if (!res.ok || !data.url) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: data.error || "Upload failed" } : a)),
        )
        return
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, status: "ready", url: data.url, mediaType: data.mediaType || a.mediaType } : a,
        ),
      )
    } catch {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "error", error: "Upload failed" } : a)),
      )
    }
  }, [])

  // Validate and queue files for upload (from the picker or drag & drop).
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      list.forEach((file) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        if (file.size > MAX_UPLOAD_BYTES) {
          setAttachments((prev) => [
            ...prev,
            { id, name: file.name, size: file.size, mediaType: file.type, status: "error", error: "Over 20 MB" },
          ])
          return
        }
        setAttachments((prev) => [
          ...prev,
          { id, name: file.name, size: file.size, mediaType: file.type || "application/octet-stream", status: "uploading" },
        ])
        void uploadAttachment(id, file)
      })
    },
    [uploadAttachment],
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // Auto-grow the composer: reset to a single row, then expand to fit content
  // up to a comfortable max (after which it scrolls internally).
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    const max = 220
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
  }, [])

  // Re-fit whenever the value changes (typing, paste, or reset after sending).
  useEffect(() => {
    resizeTextarea()
  }, [input, resizeTextarea])

  // Allow Esc to exit full-screen.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  // On mount, fetch the personalized greeting and the user's thread history.
  // The console ALWAYS opens clean — we never seed the live transcript; the
  // user explicitly opens a thread from history to continue it.
  const loadHistory = useCallback(async () => {
    setHistoryLoadError(false)
    // Retry a few times with backoff: the history panel is populated by a DB
    // read that can transiently fail on a serverless cold start / Neon reset.
    // We must not surface an empty "no conversations" state on a mere hiccup.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await bootstrapNqai()
        if (data.ok) {
          if (data.greeting) setGreeting(data.greeting)
          setThreads(data.threads ?? [])
          setFolders(data.folders ?? [])
          return true
        }
      } catch {
        /* fall through to retry */
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
    setHistoryLoadError(true)
    return false
  }, [])

  useEffect(() => {
    let active = true
    loadHistory()
      .catch(() => {})
      .finally(() => {
        if (active) setBootstrapped(true)
      })
    return () => {
      active = false
    }
  }, [loadHistory])

  // Keep the thread-id ref in sync with state for the transport closure.
  const setActiveThread = useCallback((id: string | null) => {
    activeThreadIdRef.current = id
    setActiveThreadId(id)
  }, [])

  // Refresh threads + folders (best-effort) — e.g. after a turn produces a title.
  const refreshThreads = useCallback(async () => {
    try {
      const next = await listNqaiOrganizerAction()
      // Only overwrite local state on a confirmed-good load. On failure keep the
      // existing threads/folders rather than blanking the panel to empty.
      if (next.ok) {
        setThreads(next.threads)
        setFolders(next.folders)
        setHistoryLoadError(false)
      }
    } catch {
      /* best-effort — preserve whatever is already displayed */
    }
  }, [])

  // After a streamed turn completes, refresh history so a freshly-created
  // thread (and its generated title) appears in the panel.
  const prevStatusRef = useRef(status)
  useEffect(() => {
    if ((prevStatusRef.current === "streaming" || prevStatusRef.current === "submitted") && status === "ready") {
      void refreshThreads()
    }
    prevStatusRef.current = status
  }, [status, refreshThreads])

  // Resolve the element that ACTUALLY scrolls. Depending on the height chain
  // of the surrounding layout (the dashboard wraps content in a pinch-zoom
  // viewport), the conversation may scroll either its own inner container OR an
  // ancestor scroll container. We pick whichever currently has real overflow so
  // every scroll action + the "back to top" visibility work reliably.
  const getScroller = useCallback((): HTMLElement | null => {
    const inner = scrollRef.current
    if (!inner) return null
    if (inner.scrollHeight > inner.clientHeight + 4) return inner
    let el: HTMLElement | null = inner.parentElement
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) return el
      el = el.parentElement
    }
    return inner
  }, [])

  // Auto-scroll to the newest content as it streams in.
  useEffect(() => {
    const el = getScroller()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, busy, getScroller])

  // Manual navigation for the persistent left-side scroll toggle. Long
  // generated documents (handbooks, tables, ASCII diagrams) can run for many
  // screens, so the user always needs a reliable way to move the conversation
  // up/down and to jump straight to the composer at the very bottom.
  const scrollByPage = useCallback(
    (direction: 1 | -1) => {
      const el = getScroller()
      if (!el) return
      // Scroll ~85% of the visible height so a little context carries over.
      el.scrollBy({ top: direction * el.clientHeight * 0.85, behavior: "smooth" })
    },
    [getScroller],
  )

  const scrollToInput = useCallback(() => {
    const el = getScroller()
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    // Focus the composer so the input + send button are immediately usable.
    textareaRef.current?.focus()
  }, [getScroller])

  // Jump back to the very top of the conversation. Instead of guessing which
  // single element scrolls, we scroll EVERY plausible container to the top at
  // once — the inner container, any scrollable ancestor, the pinch-zoom
  // viewport, and the window. Scrolling one that is already at the top is a
  // harmless no-op, so this works regardless of the surrounding layout.
  const scrollToTop = useCallback(() => {
    const targets = new Set<Element | Window>()
    const inner = scrollRef.current
    if (inner) {
      targets.add(inner)
      let el: HTMLElement | null = inner.parentElement
      while (el) {
        const oy = getComputedStyle(el).overflowY
        if (oy === "auto" || oy === "scroll") targets.add(el)
        el = el.parentElement
      }
    }
    const viewport = document.querySelector("[data-zoom-viewport]")
    if (viewport) targets.add(viewport)
    if (document.scrollingElement) targets.add(document.scrollingElement)
    targets.add(window)
    targets.forEach((t) => {
      try {
        ;(t as HTMLElement | Window).scrollTo({ top: 0, behavior: "smooth" })
      } catch {
        /* ignore any element that can't be scrolled */
      }
    })
  }, [])

  // Clear the live transcript and start a fresh thread (clean welcome view).
  // The next message will lazily create a new thread id.
  const handleNewChat = useCallback(() => {
    if (busy) stop()
    setMessages([])
    setActiveThread(null)
    setInput("")
    setAttachments([])
    setHistoryOpen(false)
    clearError()
  }, [busy, stop, setMessages, setActiveThread, clearError])

  // Switch into a stored thread: load its transcript and make it active.
  const handleSelectThread = useCallback(
    async (id: string) => {
      if (loadingThreadId) return
      if (id === activeThreadId) {
        setHistoryOpen(false)
        return
      }
      if (busy) stop()
      setLoadingThreadId(id)
      try {
        const res = await loadNqaiThreadAction(id)
        if (res.ok) {
          setMessages(res.messages)
          setActiveThread(id)
          setInput("")
          setAttachments([])
          clearError()
          setHistoryOpen(false)
        }
      } finally {
        setLoadingThreadId(null)
      }
    },
    [loadingThreadId, activeThreadId, busy, stop, setMessages, setActiveThread, clearError],
  )

  // Delete a stored thread; if it was the open one, fall back to a clean view.
  const handleDeleteThread = useCallback(
    async (id: string) => {
      setThreads((prev) => prev.filter((t) => t.id !== id))
      if (id === activeThreadId) {
        setMessages([])
        setActiveThread(null)
      }
      try {
        await deleteNqaiThreadAction(id)
      } finally {
        void refreshThreads()
      }
    },
    [activeThreadId, setMessages, setActiveThread, refreshThreads],
  )

  // ---- Folder organizer handlers -----------------------------------------

  const handleToggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Rename a thread (optimistic), then persist.
  const handleRenameThread = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim()
      if (!clean) return
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title: clean } : t)))
      try {
        await renameNqaiThreadAction(id, clean)
      } finally {
        void refreshThreads()
      }
    },
    [refreshThreads],
  )

  // Pin / unpin a thread (optimistic).
  const handlePinThread = useCallback(
    async (id: string, pinned: boolean) => {
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, pinned } : t)))
      try {
        await pinNqaiThreadAction(id, pinned)
      } finally {
        void refreshThreads()
      }
    },
    [refreshThreads],
  )

  // Archive / unarchive a thread (optimistic).
  const handleArchiveThread = useCallback(
    async (id: string, archived: boolean) => {
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, archived } : t)))
      try {
        await archiveNqaiThreadAction(id, archived)
      } finally {
        void refreshThreads()
      }
    },
    [refreshThreads],
  )

  // Create a folder, expand its parent, and drop straight into rename mode.
  const handleCreateFolder = useCallback(
    async (parentId: string | null) => {
      const res = await createNqaiFolderAction("New folder", parentId)
      if (res.ok && res.folder) {
        setFolders((prev) => [...prev, res.folder as NqaiFolder])
        if (parentId) setExpandedFolders((prev) => new Set(prev).add(parentId))
        setExpandedFolders((prev) => new Set(prev).add((res.folder as NqaiFolder).id))
        setRenamingId(`f:${(res.folder as NqaiFolder).id}`)
      }
      void refreshThreads()
    },
    [refreshThreads],
  )

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      const clean = name.trim()
      if (!clean) return
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: clean } : f)))
      try {
        await renameNqaiFolderAction(id, clean)
      } finally {
        void refreshThreads()
      }
    },
    [refreshThreads],
  )

  // Delete a folder: contents are lifted to its parent server-side. Mirror that
  // optimistically so the tree doesn't flash empty before the refresh lands.
  const handleDeleteFolder = useCallback(
    async (id: string) => {
      setFolders((prev) => {
        const target = prev.find((f) => f.id === id)
        const newParent = target?.parentId ?? null
        return prev
          .filter((f) => f.id !== id)
          .map((f) => (f.parentId === id ? { ...f, parentId: newParent } : f))
      })
      setThreads((prev) => {
        const target = folders.find((f) => f.id === id)
        const newParent = target?.parentId ?? null
        return prev.map((t) => (t.folderId === id ? { ...t, folderId: newParent } : t))
      })
      if (focusedFolderId === id) setFocusedFolderId(null)
      try {
        await deleteNqaiFolderAction(id)
      } finally {
        void refreshThreads()
      }
    },
    [folders, focusedFolderId, refreshThreads],
  )

  const handleMoveThread = useCallback(
    async (threadId: string, folderId: string | null) => {
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, folderId } : t)))
      if (folderId) setExpandedFolders((prev) => new Set(prev).add(folderId))
      try {
        await moveNqaiThreadAction(threadId, folderId)
      } finally {
        void refreshThreads()
      }
    },
    [refreshThreads],
  )

  const handleMoveFolder = useCallback(
    async (folderId: string, parentId: string | null) => {
      // Guard cycles on the client too (server also rejects) for snappy UX.
      if (parentId && folderSubtreeIds(folders, folderId).has(parentId)) return
      setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, parentId } : f)))
      if (parentId) setExpandedFolders((prev) => new Set(prev).add(parentId))
      try {
        await moveNqaiFolderAction(folderId, parentId)
      } finally {
        void refreshThreads()
      }
    },
    [folders, refreshThreads],
  )

  // Bundle everything the organizer tree + manager need.
  const organizerProps: OrganizerProps = {
    folders,
    threads,
    activeThreadId,
    loadingThreadId,
    expanded: expandedFolders,
    onToggle: handleToggleFolder,
    focusedFolderId,
    onFocusFolder: setFocusedFolderId,
    renamingId,
    onRenamingId: setRenamingId,
    onSelectThread: handleSelectThread,
    onDeleteThread: handleDeleteThread,
    onRenameThread: handleRenameThread,
    onPinThread: handlePinThread,
    onArchiveThread: handleArchiveThread,
    onCreateFolder: handleCreateFolder,
    onRenameFolder: handleRenameFolder,
    onDeleteFolder: handleDeleteFolder,
    onMoveThread: handleMoveThread,
    onMoveFolder: handleMoveFolder,
  }

  const submit = (text: string) => {
    const value = text.trim()
    const files = attachments.filter((a) => a.status === "ready" && a.url)
    // Need either text or at least one uploaded file; never send while a file
    // is still uploading.
    if ((!value && files.length === 0) || busy || uploadingFiles) return
    // Fresh turn ⇒ fresh auto-recovery budget.
    recoveryAttemptsRef.current = 0
    // Lazily mint a thread id on the first message of a new conversation, and
    // set the ref BEFORE sending so the transport tags this request correctly.
    if (!activeThreadIdRef.current) {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? `t-${crypto.randomUUID()}`
          : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
      setActiveThread(id)
    }
    const fileParts = files.map((a) => ({
      type: "file" as const,
      url: a.url as string,
      mediaType: a.mediaType,
      filename: a.name,
    }))
    sendMessage({
      role: "user",
      parts: [...fileParts, ...(value ? [{ type: "text" as const, text: value }] : [])],
    })
    setInput("")
    setAttachments([])
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    submit(input)
  }

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 bg-background",
        fullscreen && "fixed inset-0 z-50 h-[100dvh]",
      )}
    >
      {/* Persistent history sidebar (page variant, large screens) */}
      {variant === "page" && (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:flex">
          <FolderTreePanel
            props={organizerProps}
            onNewChat={handleNewChat}
            onOpenManager={() => setManagerOpen(true)}
            loadError={historyLoadError}
            onRetry={() => void loadHistory()}
          />
        </aside>
      )}

      {/* History drawer (mobile, and the dockable panel variant) */}
      {historyOpen && (
        <div className={cn("absolute inset-0 z-40 flex", variant === "page" && "lg:hidden")}>
          <button
            type="button"
            className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
            aria-label="Close history"
            onClick={() => setHistoryOpen(false)}
          />
          <aside className="relative flex h-full w-72 max-w-[85%] flex-col border-r border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <History className="h-3.5 w-3.5" />
                History
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => setHistoryOpen(false)}
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label="Close history"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <FolderTreePanel
                props={organizerProps}
                onNewChat={handleNewChat}
                onOpenManager={() => {
                  setHistoryOpen(false)
                  setManagerOpen(true)
                }}
                loadError={historyLoadError}
                onRetry={() => void loadHistory()}
              />
            </div>
          </aside>
        </div>
      )}

      {/* Main chat column — `min-w-0` + `overflow-x-hidden` guarantee wide content
          (tables, long tokens) can never widen the layout and push the composer's
          send button off the right edge of the viewport. */}
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      {/* Persistent left-side control bar — grouped pills that stay visible and
          non-overlapping at all times: (1) core actions (New Chat, History,
          Stop), (2) a contextual Scroll-to-Top, and (3) scroll navigation
          (page up/down + jump to composer). Kept vertically centred on the left
          edge so long generated documents can always be navigated, even when a
          mobile in-app browser chrome crowds the bottom of the screen. */}
      <div className="pointer-events-none absolute left-1.5 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-2 sm:left-2">
        {/* Core actions */}
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-full border border-border bg-card/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <button
            type="button"
            onClick={handleNewChat}
            disabled={busy}
            className="flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none active:bg-accent disabled:opacity-40"
            aria-label="Start a new conversation"
            title="New chat"
          >
            <Plus className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className={cn(
              "flex h-11 w-11 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none active:bg-accent",
              // On the page variant a persistent history sidebar is already shown
              // at lg+, so the drawer toggle is only needed below lg.
              variant === "page" && "lg:hidden",
            )}
            aria-label="Open conversation history"
            title="History"
          >
            <History className="h-5 w-5" />
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => stop()}
              className="flex h-11 w-11 items-center justify-center border-t border-border text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none active:bg-destructive/15"
              aria-label="Stop generating"
              title="Stop"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          )}
        </div>

        {/* Scroll navigation */}
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-full border border-border bg-card/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <button
            type="button"
            onClick={() => scrollByPage(-1)}
            className="flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none active:bg-accent"
            aria-label="Scroll up"
            title="Scroll up"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => scrollByPage(1)}
            className="flex h-11 w-11 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none active:bg-accent"
            aria-label="Scroll down"
            title="Scroll down"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={scrollToInput}
            className="flex h-11 w-11 items-center justify-center border-t border-border text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none active:bg-primary/15"
            aria-label="Jump to message input"
            title="Jump to message box"
          >
            <CornerDownRight className="h-5 w-5" />
          </button>
        </div>
      </div>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <NqaiAvatar />
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-foreground">NQAi</span>
              <span className="inline-block whitespace-nowrap rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                Super Intelligence
              </span>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{NQAI_TAGLINE}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setManagerOpen(true)}
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            aria-label="Manage conversation folders"
          >
            <FolderTree className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Manage</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setHistoryOpen(true)}
            className={cn(
              "h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground",
              variant === "page" && "lg:hidden",
            )}
            aria-label="Open conversation history"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">History</span>
            {threads.length > 0 && (
              <span className="rounded-sm bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                {threads.length}
              </span>
            )}
          </Button>
          {hasConversation && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleNewChat}
              disabled={busy}
              className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              aria-label="Start a new conversation"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New</span>
            </Button>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                error
                  ? "bg-destructive"
                  : recovering
                    ? "bg-warning animate-pulse"
                    : busy
                      ? "bg-warning animate-pulse"
                      : "bg-success animate-pulse",
              )}
            />
            <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:inline">
              {error ? "Fault" : recovering ? "Reconnecting" : busy ? "Reasoning" : "Online"}
            </span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setFullscreen((v) => !v)}
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
            title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        <div
          className={cn(
            "mx-auto w-full",
            variant === "page" ? "max-w-3xl space-y-3" : "space-y-3",
          )}
        >
        {/* Canonical welcome message — always shown on load */}
        <div className="flex gap-2.5">
          <NqaiAvatar />
          <div className="min-w-0 flex-1">
            <div className="rounded-sm border border-primary/20 bg-card p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                <Sparkles className="h-3 w-3" />
                NQAi · Neural Quantum Artificial Intelligence
              </p>
              <p className="whitespace-pre-line text-pretty text-[14px] leading-relaxed text-foreground/90 sm:text-[13px]">
                {NQAI_WELCOME}
              </p>
              <p className="mt-2.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
                Running on RISC-V · Research cloud, UC Berkeley · Proprietary architecture
              </p>
            </div>

            {/* Personalized briefing — generated server-side from the signed-in
                client's own private account context. */}
            {greeting && (
              <div className="mt-2.5 flex gap-2 rounded-sm border border-primary/20 bg-primary/5 p-2.5 text-[14px] leading-relaxed text-foreground/90 sm:text-[13px]">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <p className="text-pretty break-words [overflow-wrap:anywhere]">{greeting}</p>
              </div>
            )}

            {/* Suggested prompts (hidden once a conversation starts, and held
                back until bootstrap finishes so returning users don't see a
                flash of chips before their history loads) */}
            {bootstrapped && !hasConversation && (
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {NQAI_SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => submit(s.prompt)}
                    className="flex items-center gap-2 rounded-sm border border-border bg-secondary/40 px-2.5 py-1.5 text-left text-[11px] text-foreground transition-colors hover:border-primary/40 hover:bg-secondary"
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate">{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Chat turns */}
        {messages.map((message) => {
          const text = messageText(message)
          const isUser = message.role === "user"
          const activity = isUser ? [] : toolActivity(message)
          const files = isUser ? messageFiles(message) : []
          const docs = isUser ? [] : documentArtifacts(message)
          return (
            <div key={message.id} className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
              {isUser ? (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border bg-secondary text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                </span>
              ) : (
                <NqaiAvatar />
              )}
              <div
                className={cn(
                  "min-w-0 max-w-[88%] break-words rounded-sm border px-3 py-2 text-[15px] leading-relaxed sm:max-w-[85%] sm:text-[13px]",
                  isUser
                    ? "border-primary/30 bg-primary/10 text-foreground"
                    : "border-border bg-card text-foreground/90",
                )}
              >
                {activity.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {activity.map((a) => (
                      <span
                        key={a.key}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                          a.failed
                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                            : a.done
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-warning/30 bg-warning/10 text-warning",
                        )}
                      >
                        {!a.done ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : a.failed ? (
                          <AlertTriangle className="h-3 w-3" />
                        ) : a.kind === "knowledge" ? (
                          <BookOpen className="h-3 w-3" />
                        ) : a.kind === "messaging" ? (
                          <Send className="h-3 w-3" />
                        ) : a.kind === "document" ? (
                          <FileText className="h-3 w-3" />
                        ) : a.kind === "storage" ? (
                          <Warehouse className="h-3 w-3" />
                        ) : a.label.includes("vessel") || a.label.includes("AIS") ? (
                          <Ship className="h-3 w-3" />
                        ) : (
                          <Radar className="h-3 w-3" />
                        )}
                        <span>{a.label}</span>
                      </span>
                    ))}
                  </div>
                )}
                {/* Attachments the client uploaded with this message */}
                {files.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {files.map((f, idx) => {
                      const Icon = fileIcon(f.mediaType)
                      return (
                        <a
                          key={`${f.url}-${idx}`}
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-[200px] items-center gap-1.5 rounded-sm border border-border bg-background/60 px-2 py-1 text-xs text-foreground transition-colors hover:border-primary/40"
                          title={f.name}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                          <span className="truncate">{f.name}</span>
                        </a>
                      )
                    })}
                  </div>
                )}
                {text ? (
                  isUser ? (
                    <p className="whitespace-pre-wrap text-pretty break-words [overflow-wrap:anywhere]">{text}</p>
                  ) : (
                    <Streamdown
                      className={cn(
                        "max-w-none min-w-0 break-words text-[15px] leading-relaxed sm:text-[13px]",
                        "[&_p]:my-1.5 [&_p]:break-words [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
                        "[&_strong]:font-semibold [&_strong]:text-foreground",
                        "[&_h1]:mb-1.5 [&_h1]:mt-2 [&_h1]:text-[15px] [&_h1]:font-semibold sm:[&_h1]:text-sm [&_h2]:mb-1.5 [&_h2]:mt-2 [&_h2]:text-[15px] [&_h2]:font-semibold sm:[&_h2]:text-[13px] [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[15px] [&_h3]:font-semibold sm:[&_h3]:text-[13px]",
                        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:break-words",
                        "[&_code]:rounded-sm [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
                        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:border [&_pre]:border-border [&_pre]:bg-secondary/60 [&_pre]:p-2.5",
                            // Wide tables must scroll WITHIN the bubble, not expand the
                            // layout — otherwise they push the composer's send button off
                            // the right edge of a mobile viewport. `block` + `max-w-full` +
                            // `overflow-x-auto` turns the table into a self-contained
                            // horizontally-scrollable box.
                            "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs",
                            "[&_td]:whitespace-nowrap [&_th]:whitespace-nowrap",
                        "[&_th]:border [&_th]:border-border [&_th]:bg-secondary/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
                        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:tabular-nums",
                        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
                        "[&_hr]:my-3 [&_hr]:border-border",
                      )}
                    >
                      {text}
                    </Streamdown>
                  )
                ) : files.length === 0 && docs.length === 0 ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
                  </span>
                ) : null}

                {/* Downloadable documents NQAi authored in this turn */}
                {docs.length > 0 && (
                  <div className={cn("flex flex-col gap-2", text ? "mt-3" : "mt-0")}>
                    {docs.map((doc) => (
                      <div
                        key={doc.key}
                        className="flex items-center gap-3 rounded-sm border border-primary/30 bg-primary/5 p-3"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-primary/30 bg-background text-primary">
                          <FileText className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-foreground">{doc.title}</p>
                          <p className="text-[10px] text-muted-foreground">PDF document · prepared by NQAi</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => downloadDocument(doc)}
                          className="shrink-0 gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {recovering && !error && (
          <div className="flex items-center gap-2 rounded-sm border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <span>Connection interrupted after switching away — reconnecting and resuming your request…</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{describeNqaiError(error)}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                clearError()
                void regenerate()
              }}
              className="h-7 shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        </div>
      </div>

      {/* Composer */}
      <form
        onSubmit={onSubmit}
        className="relative border-t border-border bg-card p-3 [padding-bottom:calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto w-full max-w-3xl">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          {/* Pending attachment chips */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((a) => {
                const Icon = fileIcon(a.mediaType)
                return (
                  <span
                    key={a.id}
                    className={cn(
                      "inline-flex max-w-[260px] flex-col gap-0.5 rounded-sm border px-2 py-1 text-xs",
                      a.status === "error"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border bg-background text-foreground",
                    )}
                    title={a.error ? `${a.name} — ${a.error}` : a.name}
                  >
                    <span className="flex items-center gap-1.5">
                      {a.status === "uploading" ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      ) : a.status === "error" ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                      <span className="truncate">{a.name}</span>
                      {a.status === "ready" && a.size > 0 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={`Remove ${a.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                    {a.status === "error" && a.error && (
                      <span className="pl-5 text-[10px] leading-snug text-pretty break-words">{a.error}</span>
                    )}
                  </span>
                )
              })}
            </div>
          )}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
            }}
            className={cn(
              "flex items-end gap-2 rounded-md border border-border bg-background px-3 py-2 transition-colors focus-within:border-primary/50",
              dragOver && "border-primary bg-primary/5",
            )}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="h-8 w-8 shrink-0 self-end text-muted-foreground hover:text-foreground"
              aria-label="Attach document"
              title="Attach a document for NQAi to analyze"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  submit(input)
                }
              }}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData.files)
                if (pasted.length > 0) {
                  e.preventDefault()
                  addFiles(pasted)
                }
              }}
              rows={1}
              placeholder="Ask NQAi, or attach a document to analyze…  (Shift + Enter for a new line)"
              className="min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-label="Message NQAi"
            />
            {busy ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => stop()}
                className="h-8 w-8 shrink-0 self-end text-muted-foreground hover:text-foreground"
                aria-label="Stop generating"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!canSend}
                className="h-8 w-8 shrink-0 self-end"
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">
            {uploadingFiles
              ? "Uploading attachment…"
              : "Attach PDFs, images, or text/CSV for analysis. NQAi can also prepare downloadable PDF documents."}
          </p>
        </div>
      </form>
      </div>

      {/* Full-screen folder / desktop manager */}
      {managerOpen && (
        <NqaiManager props={organizerProps} onNewChat={handleNewChat} onClose={() => setManagerOpen(false)} />
      )}

      {/* Persistent "back to top" button. Rendered via a portal to document.body
          with FIXED positioning so it is always pinned to the bottom of the
          screen — immune to the pinch-zoom wrapper's transforms and to whichever
          element actually scrolls. Tapping it scrolls every container to the top. */}
      {mounted &&
        hasConversation &&
        createPortal(
          <button
            type="button"
            onClick={scrollToTop}
            className="fixed left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary/50 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-xl transition-transform active:scale-95"
            style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
            aria-label="Scroll to the start of the conversation"
          >
            <ArrowUp className="h-4 w-4" />
            <span>Top</span>
          </button>,
          document.body,
        )}
    </div>
  )
}
