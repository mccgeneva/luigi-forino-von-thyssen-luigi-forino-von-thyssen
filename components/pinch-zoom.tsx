"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

const MIN_SCALE = 1
const MAX_SCALE = 4

/**
 * Pinch-to-zoom surface for the main scrollable content.
 *
 * Scaling is anchored to the TOP-LEFT corner and, while zoomed, a sizer
 * element is expanded to the scaled dimensions so BOTH scrollbars reveal the
 * full enlarged content:
 *
 *  - `transform-origin: top left` keeps the left edge pinned, so the content
 *    grows down-and-right predictably (no content is pushed off the left edge).
 *  - When zoomed the sizer is sized to `naturalWidth * scale` ×
 *    `naturalHeight * scale`, and the viewport switches to `overflow-x: auto`
 *    with `touch-action: pan-x pan-y`, so every edge — including right-side
 *    action buttons — stays reachable by panning. Previously the content was
 *    scaled from the center with `overflow-x: hidden`, which clipped both
 *    edges once zoomed and made edge controls impossible to tap.
 *  - At 1x the content is unscaled and horizontal panning stays locked
 *    (`overflow-x: hidden` + `touch-action: pan-y`) so normal vertical
 *    scrolling is native and buttery with no accidental horizontal drift.
 *
 * The scale is smoothed by writing the transform directly in the move handler
 * (no React re-render per frame) and only committing to state on gesture end,
 * which keeps the gesture at 60fps even on mid-range mobile devices.
 */
export function PinchZoom({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [scale, setScale] = useState(1)

  // Live gesture state kept in refs so move events never trigger re-renders.
  const gesture = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    scale: 1,
    lastTap: 0,
  })

  const distance = (touches: TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.hypot(dx, dy)
  }

  // Resize the sizer so both scrollbars reflect the zoomed content. The content
  // is pinned to the viewport's visible width while zoomed so that scaling it
  // never feeds back into layout (which would otherwise compound each frame).
  const syncSizer = useCallback((s: number) => {
    const viewport = viewportRef.current
    const content = contentRef.current
    const sizer = sizerRef.current
    if (!viewport || !content || !sizer) return
    if (s <= 1) {
      content.style.width = ""
      sizer.style.width = ""
      sizer.style.height = ""
      return
    }
    const naturalWidth = viewport.clientWidth
    content.style.width = `${naturalWidth}px`
    const naturalHeight = content.scrollHeight
    sizer.style.width = `${naturalWidth * s}px`
    sizer.style.height = `${naturalHeight * s}px`
  }, [])

  const applyScale = useCallback(
    (s: number, commit: boolean) => {
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
      gesture.current.scale = clamped
      const content = contentRef.current
      if (content) {
        content.style.transform = clamped === 1 ? "" : `scale(${clamped})`
      }
      syncSizer(clamped)
      if (commit) setScale(clamped)
    },
    [syncSizer],
  )

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        gesture.current.active = true
        gesture.current.startDist = distance(e.touches)
        gesture.current.startScale = gesture.current.scale
        // Stop native page scroll/zoom while pinching.
        e.preventDefault()
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!gesture.current.active || e.touches.length !== 2) return
      e.preventDefault()
      const dist = distance(e.touches)
      if (gesture.current.startDist <= 0) return
      const next = gesture.current.startScale * (dist / gesture.current.startDist)
      applyScale(next, false)
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (gesture.current.active && e.touches.length < 2) {
        gesture.current.active = false
        // Commit the final scale to React state once the pinch settles.
        applyScale(gesture.current.scale, true)
      }
      // Double-tap (single finger) to reset zoom back to 1x.
      if (e.touches.length === 0 && gesture.current.scale > 1) {
        const now = Date.now()
        if (now - gesture.current.lastTap < 300) {
          applyScale(1, true)
        }
        gesture.current.lastTap = now
      }
    }

    // Passive:false is required so preventDefault() actually suppresses the
    // browser's own pinch / scroll during the gesture.
    viewport.addEventListener("touchstart", onTouchStart, { passive: false })
    viewport.addEventListener("touchmove", onTouchMove, { passive: false })
    viewport.addEventListener("touchend", onTouchEnd, { passive: false })
    viewport.addEventListener("touchcancel", onTouchEnd, { passive: false })

    return () => {
      viewport.removeEventListener("touchstart", onTouchStart)
      viewport.removeEventListener("touchmove", onTouchMove)
      viewport.removeEventListener("touchend", onTouchEnd)
      viewport.removeEventListener("touchcancel", onTouchEnd)
    }
  }, [applyScale])

  // Keep the sizer dimensions correct when content changes or on resize while zoomed.
  useEffect(() => {
    if (scale === 1) {
      syncSizer(1)
      return
    }
    syncSizer(scale)
    const onResize = () => syncSizer(gesture.current.scale)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [scale, syncSizer])

  const zoomed = scale > 1

  return (
    <div
      ref={viewportRef}
      data-zoom-viewport=""
      className={cn(
        "h-full w-full overflow-y-auto overscroll-contain",
        zoomed ? "overflow-x-auto" : "overflow-x-hidden",
      )}
      style={{ touchAction: zoomed ? "pan-x pan-y" : "pan-y" }}
    >
      <div ref={sizerRef} className="w-full">
        <div
          ref={contentRef}
          className="w-full will-change-transform"
          style={{ transformOrigin: "top left" }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
