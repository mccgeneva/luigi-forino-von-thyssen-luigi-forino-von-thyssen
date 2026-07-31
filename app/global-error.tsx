"use client"

import { useEffect } from "react"
import { reportClientError } from "@/lib/client-error-capture"

/**
 * Last-resort error boundary. Catches errors thrown in the root layout itself
 * (which `app/error.tsx` cannot catch). Renders its own <html>/<body> because
 * it replaces the entire document when the root layout fails. Without this, a
 * crash here would leave the user staring at a blank white page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.log("[v0] global-error boundary caught:", error?.message, error?.digest)
    // Report to the admin Errors & Debug log — marked critical since a root
    // layout crash takes down the whole document.
    reportClientError({
      severity: "critical",
      kind: "react.global-error",
      message: error?.message || "Application crashed (root layout)",
      stack: error?.stack ?? null,
      meta: { digest: error?.digest ?? null },
    })
  }, [error])

  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0f0f1a",
          color: "#f5f5f5",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: "#a1a1aa", marginBottom: 24, lineHeight: 1.5 }}>
            The application hit an unexpected error. Please try again.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
            <button
              onClick={() => reset()}
              style={{
                minHeight: 44,
                width: "100%",
                maxWidth: 260,
                padding: "0 24px",
                borderRadius: 10,
                border: "none",
                backgroundColor: "#e0b43a",
                color: "#1a1a2e",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              onClick={() => {
                // Hard reload to a clean route. If the root layout itself is
                // crashing, reset() would just replay the same crash, so we
                // fully reload the document from the sign-in page instead.
                window.location.href = "/login"
              }}
              style={{
                minHeight: 44,
                width: "100%",
                maxWidth: 260,
                padding: "0 24px",
                borderRadius: 10,
                border: "1px solid #3a3a4a",
                backgroundColor: "transparent",
                color: "#f5f5f5",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Sign in again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
