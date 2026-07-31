"use client"

import { useEffect } from "react"
import { installGlobalErrorCapture } from "@/lib/client-error-capture"

/**
 * Installs the global browser error handlers (window.onerror /
 * unhandledrejection) exactly once for the whole app, so uncaught client
 * anomalies are automatically captured into the admin Errors & Debug log.
 * Renders nothing.
 */
export function DebugCaptureListener() {
  useEffect(() => {
    installGlobalErrorCapture()
  }, [])
  return null
}
