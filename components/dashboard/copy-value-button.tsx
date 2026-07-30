"use client"

import { useState } from "react"
import { Copy, Check } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Small icon button that copies a single field value to the clipboard.
 * Shows a transient check-mark + toast on success, and falls back gracefully
 * when the Clipboard API is unavailable (older/non-secure contexts).
 */
export function CopyValueButton({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        // Fallback for non-secure contexts without the async Clipboard API.
        const ta = document.createElement("textarea")
        ta.value = value
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      setCopied(true)
      toast.success(`${label} copied`, { description: value })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(`Could not copy ${label}`)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 shrink-0", className)}
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </Button>
  )
}
