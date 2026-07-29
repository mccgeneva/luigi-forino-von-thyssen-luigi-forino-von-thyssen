"use client"

import { useEffect, useState } from "react"
import { Download, Share, Plus, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** The `beforeinstallprompt` event isn't in the standard lib DOM types. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export function DownloadAppButton() {
  // The captured native install prompt (Android/Chromium). Null until the
  // browser fires `beforeinstallprompt`, or on browsers that never do (iOS).
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [platform, setPlatform] = useState<"ios" | "other">("other")

  useEffect(() => {
    // Detect iOS (no beforeinstallprompt support → manual Add to Home Screen).
    const ua = window.navigator.userAgent.toLowerCase()
    const isIOS = /iphone|ipad|ipod/.test(ua) || (ua.includes("mac") && "ontouchend" in document)
    setPlatform(isIOS ? "ios" : "other")

    // Already running as an installed PWA.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari exposes this non-standard flag when launched from home screen.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    if (standalone) setInstalled(true)

    const onBeforeInstall = (e: Event) => {
      // Stop Chrome's mini-infobar so we control when the prompt appears.
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  async function handleClick() {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === "accepted") setInstalled(true)
      setDeferredPrompt(null)
      return
    }
    // No native prompt available (iOS, or already-eligible browsers that
    // haven't fired the event yet) → show manual install instructions.
    setShowManual(true)
  }

  if (installed) {
    return (
      <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm font-medium text-muted-foreground">
        <Check className="h-4 w-4 shrink-0 text-primary" />
        App installed on this device
      </div>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        className="mt-4 h-12 w-full gap-2 rounded-lg text-sm font-medium"
      >
        <Download className="h-4 w-4 shrink-0" />
        Download App on Your Mobile
      </Button>

      <Dialog open={showManual} onOpenChange={setShowManual}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Install the MCC Capital app</DialogTitle>
            <DialogDescription>
              Add the platform to your home screen for a full-screen, app-like experience.
            </DialogDescription>
          </DialogHeader>

          {platform === "ios" ? (
            <ol className="space-y-3 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  1
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  Tap the Share button
                  <Share className="inline h-4 w-4 text-primary" />
                  in Safari&apos;s toolbar.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  2
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  Choose
                  <span className="inline-flex items-center gap-1 font-medium">
                    Add to Home Screen
                    <Plus className="inline h-4 w-4 text-primary" />
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  3
                </span>
                <span>
                  Tap <span className="font-medium">Add</span> to finish. The MCC Capital icon appears on your home
                  screen.
                </span>
              </li>
            </ol>
          ) : (
            <ol className="space-y-3 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  1
                </span>
                <span>Open your browser menu (the three-dot icon).</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  2
                </span>
                <span>
                  Tap <span className="font-medium">Install app</span> or{" "}
                  <span className="font-medium">Add to Home screen</span>.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                  3
                </span>
                <span>Confirm to add the MCC Capital app to your device.</span>
              </li>
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
