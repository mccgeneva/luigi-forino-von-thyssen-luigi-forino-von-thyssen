"use client"

import { useEffect, useState } from "react"
import { ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Floating "back to top" control for long, data-heavy dashboard pages.
 * It tracks the dashboard's scrollable <main> region and smoothly returns
 * the user to the top from any scroll position.
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  // The dashboard layout renders content inside the pinch-zoom viewport
  // (the actual scroll container), falling back to <main> if it isn't present.
  useEffect(() => {
    const el =
      document.querySelector("[data-zoom-viewport]") ?? document.querySelector("main")
    setScroller(el instanceof HTMLElement ? el : null)
  }, [])

  useEffect(() => {
    if (!scroller) return
    const onScroll = () => setVisible(scroller.scrollTop > 320)
    onScroll()
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => scroller.removeEventListener("scroll", onScroll)
  }, [scroller])

  const scrollToTop = () => {
    scroller?.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to top"
      className={cn(
        // Pinned bottom-LEFT so it never overlaps the NQAi composer's send
        // button (which is always bottom-right). h-12/w-12 keeps a >=44px touch target.
        "fixed bottom-6 left-6 z-50 flex h-12 w-12 items-center justify-center rounded-full",
        "border border-border bg-primary text-primary-foreground shadow-lg",
        "transition-all duration-300 hover:opacity-90",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"
      )}
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  )
}
