"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Camera, Loader2, ScanFace, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { captureDescriptor, FaceModelLoadError } from "@/lib/face-client"

type Phase = "idle" | "loading" | "ready" | "scanning" | "error"

/** Heuristic: are we inside an in-app browser webview (e.g. opened from a
 *  messaging app)? These frequently block camera access or the WebGL/model
 *  fetch that face recognition needs, so we surface a "open in your browser"
 *  hint when capture fails. */
function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent || ""
  return /FBAN|FBAV|Instagram|Line|WhatsApp|WeChat|Telegram|Snapchat|Twitter|TikTok|; wv\)|GSA\//i.test(ua)
}

const IN_APP_HINT =
  " If you opened this from inside another app, tap the menu and choose “Open in Safari/Chrome”, then try again."

interface FaceCaptureProps {
  /** Called with a captured 128-float descriptor and, when `captureSelfie` is
      enabled, a downscaled JPEG data URL of the live frame. Return a promise so
      the component can show progress and surface a failure message. */
  onCapture: (descriptor: number[], selfie?: string) => Promise<{ ok: boolean; error?: string } | void>
  /** Number of samples to gather before completing (enrollment uses several). */
  samples?: number
  /** Button label for the scan action. */
  actionLabel?: string
  /** Auto-start the camera on mount (login uses this for a fast path). */
  autoStart?: boolean
  /**
   * When true, also grab a small JPEG snapshot of the live frame and pass it to
   * `onCapture`. Used by the LOGIN flow so an administrator can later confirm
   * who actually signed in. Enrollment leaves this off — it only needs the
   * numeric descriptor.
   */
  captureSelfie?: boolean
}

/**
 * Grab a small JPEG snapshot of the current video frame. Downscaled to keep the
 * stored image tiny (a login thumbnail, not a high-res photo). Returns undefined
 * if the frame can't be read.
 */
function grabSelfieFrame(video: HTMLVideoElement): string | undefined {
  try {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return undefined
    const maxW = 320
    const scale = Math.min(1, maxW / vw)
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(vw * scale)
    canvas.height = Math.round(vh * scale)
    const ctx = canvas.getContext("2d")
    if (!ctx) return undefined
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", 0.7)
  } catch {
    return undefined
  }
}

/**
 * Reusable webcam capture surface. Requests the camera, lets the user scan, and
 * extracts a face descriptor locally. Used for both enrollment (multiple
 * samples) and login verification (single sample). No image ever leaves the
 * device — only the numeric descriptor is passed to `onCapture`.
 */
export function FaceCapture({
  onCapture,
  samples = 1,
  actionLabel = "Scan face",
  autoStart = false,
  captureSelfie = false,
}: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [message, setMessage] = useState<string>("")
  const [progress, setProgress] = useState(0)
  const busyRef = useRef(false)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    setMessage("")
    setPhase("loading")

    // Pre-flight: the camera API is only available in a secure context and on
    // browsers that expose getUserMedia. Failing these early gives a clear
    // reason instead of a generic throw.
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setPhase("error")
      setMessage("Camera access requires a secure (https) connection. Open this page over https and try again.")
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error")
      setMessage(
        "This browser doesn’t allow camera access." + (isInAppBrowser() ? IN_APP_HINT : " Try a different browser such as Safari or Chrome."),
      )
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setPhase("ready")
    } catch (err) {
      setPhase("error")
      const name = err instanceof Error ? err.name : ""
      if (name === "NotAllowedError" || name === "SecurityError") {
        setMessage(
          "Camera permission was blocked. Allow camera access for this site in your browser settings, then try again." +
            (isInAppBrowser() ? IN_APP_HINT : ""),
        )
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setMessage("No camera was found on this device.")
      } else if (name === "NotReadableError") {
        setMessage("Your camera is in use by another app. Close it and try again.")
      } else {
        setMessage(
          "Camera access was denied or is unavailable." + (isInAppBrowser() ? IN_APP_HINT : " Enable camera permissions and try again."),
        )
      }
    }
  }, [])

  useEffect(() => {
    if (autoStart) void startCamera()
    return () => stopCamera()
  }, [autoStart, startCamera, stopCamera])

  const handleScan = useCallback(async () => {
    if (busyRef.current || !videoRef.current) return
    busyRef.current = true
    setPhase("scanning")
    setMessage("")
    try {
      const collected: number[][] = []
      for (let i = 0; i < samples; i++) {
        // Give the user a beat between samples so we capture slight variation.
        let descriptor: number[] | null = null
        for (let attempt = 0; attempt < 12 && !descriptor; attempt++) {
          descriptor = await captureDescriptor(videoRef.current)
          if (!descriptor) await new Promise((r) => setTimeout(r, 350))
        }
        if (!descriptor) {
          setPhase("ready")
          setMessage("No face detected. Make sure your face is centered and well lit.")
          busyRef.current = false
          return
        }
        collected.push(descriptor)
        setProgress(Math.round(((i + 1) / samples) * 100))
        if (i < samples - 1) await new Promise((r) => setTimeout(r, 400))
      }

      // For the login flow, grab a single live-frame snapshot while the camera
      // is still running so the admin audit trail can show who signed in.
      const selfie = captureSelfie && videoRef.current ? grabSelfieFrame(videoRef.current) : undefined

      // For multi-sample enrollment send all; for single just the one.
      let lastError: string | undefined
      for (const d of collected) {
        const res = await onCapture(d, selfie)
        if (res && res.ok === false) lastError = res.error
      }
      if (lastError) {
        setPhase("ready")
        setMessage(lastError)
      } else {
        stopCamera()
        setPhase("idle")
      }
    } catch (err) {
      // A model-load failure is the most common real cause here (the ~7MB face
      // models can't be fetched, or WebGL is unavailable — typical inside in-app
      // browser webviews). Surface that specifically so the user knows it's the
      // environment, not their face. Keep the camera "ready" so retry can
      // re-attempt the load (face-client resets its cached promise on failure).
      if (err instanceof FaceModelLoadError) {
        setPhase("ready")
        setMessage(
          "Couldn’t load the face scanner." +
            (isInAppBrowser() ? IN_APP_HINT : " Check your connection and try again."),
        )
      } else {
        setPhase("error")
        setMessage("Something went wrong during the scan. Please try again.")
      }
    } finally {
      busyRef.current = false
      setProgress(0)
    }
  }, [onCapture, samples, stopCamera, captureSelfie])

  const live = phase === "ready" || phase === "scanning"

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={cn(
          "relative aspect-square w-full max-w-[260px] overflow-hidden rounded-full border-2",
          phase === "scanning" ? "border-primary" : "border-border",
        )}
      >
        {/* Video is always mounted so the ref is stable; hidden until live. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={cn("h-full w-full object-cover", live ? "opacity-100" : "opacity-0")}
        />
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            {phase === "loading" ? (
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : phase === "error" ? (
              <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
            ) : (
              <ScanFace className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
            )}
          </div>
        )}
        {phase === "scanning" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-primary/30">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      {message && (
        <p
          className={cn(
            "text-center text-sm text-pretty",
            phase === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      )}

      {phase === "idle" || phase === "error" ? (
        <button
          type="button"
          onClick={startCamera}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          Enable camera
        </button>
      ) : (
        <button
          type="button"
          onClick={handleScan}
          disabled={phase !== "ready"}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {phase === "scanning" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Scanning…
            </>
          ) : (
            <>
              <ScanFace className="h-4 w-4" aria-hidden="true" />
              {actionLabel}
            </>
          )}
        </button>
      )}
    </div>
  )
}
