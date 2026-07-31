// Client-side error reporter. Posts automatically-detected browser anomalies to
// the /api/debug/capture ingest route so they appear in the admin Errors & Debug
// log without the client ever having to report a bug manually.
//
// Designed to be *defensive*: it must never throw (it runs inside error paths),
// never spam the server (throttled + deduped), and never block the UI
// (fire-and-forget with keepalive).

export type ClientSeverity = "critical" | "error" | "warning" | "info"

interface ReportInput {
  severity?: ClientSeverity
  kind?: string
  message: string
  stack?: string | null
  meta?: Record<string, unknown> | null
}

// Throttle: at most N reports per rolling window, so a render loop that throws
// on every frame cannot flood the ingest endpoint.
const MAX_PER_WINDOW = 8
const WINDOW_MS = 10_000
// De-dupe identical signatures for this long.
const DEDUPE_MS = 30_000

let windowStart = 0
let windowCount = 0
const recentSignatures = new Map<string, number>()

function allow(signature: string): boolean {
  const now = Date.now()

  // Rolling throttle window.
  if (now - windowStart > WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  if (windowCount >= MAX_PER_WINDOW) return false

  // De-dupe identical errors.
  const last = recentSignatures.get(signature)
  if (last && now - last < DEDUPE_MS) return false

  // Opportunistically prune the de-dupe map so it can't grow unbounded.
  if (recentSignatures.size > 100) {
    for (const [sig, ts] of recentSignatures) {
      if (now - ts > DEDUPE_MS) recentSignatures.delete(sig)
    }
  }

  windowCount += 1
  recentSignatures.set(signature, now)
  return true
}

/** Report a client anomaly. Safe to call from any error path; never throws. */
export function reportClientError(input: ReportInput): void {
  try {
    if (typeof window === "undefined") return
    const message = (input.message || "").slice(0, 2000)
    if (!message) return

    const signature = `${input.kind ?? ""}|${message}`
    if (!allow(signature)) return

    const body = JSON.stringify({
      severity: input.severity ?? "error",
      kind: input.kind ?? "client.error",
      message,
      stack: input.stack ? String(input.stack).slice(0, 8000) : null,
      path: window.location?.pathname ?? null,
      meta: {
        ...(input.meta ?? {}),
        url: window.location?.href ?? null,
        viewport:
          typeof window.innerWidth === "number" ? `${window.innerWidth}x${window.innerHeight}` : null,
      },
    })

    // keepalive lets the POST survive a navigation / tab close, so we still
    // capture the error that is about to unload the page.
    void fetch("/api/debug/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // swallow — reporting is best-effort
    })
  } catch {
    // never throw from the reporter
  }
}

let installed = false

/**
 * Install global browser error handlers ONCE. Captures uncaught exceptions and
 * unhandled promise rejections. Idempotent and SSR-safe.
 */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return
  installed = true

  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error as { message?: string; stack?: string } | undefined
    reportClientError({
      severity: "error",
      kind: "window.onerror",
      message: err?.message || event.message || "Uncaught error",
      stack: err?.stack ?? null,
      meta: {
        filename: event.filename || null,
        line: event.lineno ?? null,
        column: event.colno ?? null,
      },
    })
  })

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: string; stack?: string } | string | undefined
    const message =
      typeof reason === "string" ? reason : reason?.message || "Unhandled promise rejection"
    reportClientError({
      severity: "error",
      kind: "unhandledrejection",
      message,
      stack: typeof reason === "object" ? reason?.stack ?? null : null,
    })
  })
}
