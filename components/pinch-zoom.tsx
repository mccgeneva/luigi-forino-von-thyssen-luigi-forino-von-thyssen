"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

const MIN_SCALE = 1
const MAX_SCALE = 4

/**
 * Horizontal-locked pinch-to-zoom surface.
 *
 * Wraps the main scrollable content and provides a smooth, two-finger
 * pinch gesture that enlarges / shrinks the content WITHOUT any horizontal
 * shift or jitter:
 *
 *  - Content is scaled from the TOP-CENTER, so the horizontal center stays
 *    perfectly fixed (no left/right drift while pinching).
 *  - Horizontal panning is disabled entirely (`overflow-x: hidden` +
 *    `touch-action: pan-y`), so the only movement possible is vertical scroll.
 *  - A sizer element grows to `naturalHeight * scale` so the browser's native
 *    vertical scrollbar covers the full zoomed content.
 *  - `touch-action: pan-y` lets one-finger vertical scrolling stay native and
 *    buttery; only multi-touch is intercepted for the zoom.
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

  // Resize the sizer so the vertical scrollbar reflects the zoomed height.
  const syncSizerHeight = useCallback((s: number) => {
    const content = contentRef.current
    const sizer = sizerRef.current
    if (!content || !sizer) return
    const naturalHeight = content.scrollHeight
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
      syncSizerHeight(clamped)
      if (commit) setScale(clamped)
    },
    [syncSizerHeight],
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

  // Keep the sizer height correct when content changes or on resize while zoomed.
  useEffect(() => {
    if (scale === 1) {
      if (sizerRef.current) sizerRef.current.style.height = ""
      return
    }
    syncSizerHeight(scale)
    const onResize = () => syncSizerHeight(gesture.current.scale)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [scale, syncSizerHeight])

  return (
    <div
      ref={viewportRef}
      data-zoom-viewport=""
      className="h-full w-full overflow-y-auto overflow-x-hidden overscroll-contain"
      style={{ touchAction: "pan-y" }}
    >
      <div ref={sizerRef} className="w-full">
        <div
          ref={contentRef}
          className="w-full origin-top will-change-transform"
          style={{ transformOrigin: "top center" }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
