"use client"

// Full-screen image viewer used across the admin dossier (login selfie, passport
// / ID, KYC document images). Self-contained fixed overlay — no Dialog dependency
// — so it renders identically on mobile and desktop: tap the backdrop, the X, or
// press Escape to close; the image scales to fit the screen. A secondary action
// opens the original file in a new tab.

import { useEffect } from "react"
import { X, ExternalLink } from "lucide-react"

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
    >
      <div className="absolute right-4 top-4 flex gap-2">
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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src || "/placeholder.svg"}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain shadow-2xl"
      />
    </div>
  )
}
