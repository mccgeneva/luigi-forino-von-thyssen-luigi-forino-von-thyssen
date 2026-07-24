"use client"

// Full-screen image viewer used across the admin dossier (login selfie, passport
// / ID, KYC document images). Rendered through a portal on document.body so it
// escapes any transformed / backdrop-blurred ancestor (which would otherwise
// clip a position:fixed overlay and show only a black screen on mobile). Tap the
// backdrop, the X, or press Escape to close; the image scales to fit the screen.
// A secondary action opens the original file in a new tab.

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { X, ExternalLink, ImageOff, Loader2 } from "lucide-react"

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading")

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    // Lock background scroll while the viewer is open.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  if (!mounted) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-4"
    >
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-foreground transition-colors hover:bg-secondary/70"
          title="Open original in a new tab"
          aria-label="Open original in a new tab"
        >
          <ExternalLink className="h-5 w-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-foreground transition-colors hover:bg-secondary/70"
          title="Close"
          aria-label="Close full-screen view"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {status === "loading" ? (
        <Loader2 className="absolute h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : null}

      {status === "error" ? (
        <div className="flex flex-col items-center gap-3 text-center text-muted-foreground" onClick={(e) => e.stopPropagation()}>
          <ImageOff className="h-10 w-10" aria-hidden="true" />
          <p className="text-sm">Could not load this image.</p>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-primary underline underline-offset-4"
          >
            Open the original in a new tab
          </a>
        </div>
      ) : null}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src || "/placeholder.svg"}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
        className={`max-h-[90vh] max-w-[95vw] rounded-lg object-contain shadow-2xl ${
          status === "loaded" ? "block" : "hidden"
        }`}
      />
    </div>,
    document.body,
  )
}
