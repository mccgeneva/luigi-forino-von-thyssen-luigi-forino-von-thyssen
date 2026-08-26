"use client"

import { useRef, useState } from "react"
import { upload } from "@vercel/blob/client"
import { toast } from "sonner"
import { parseSwiftMessage } from "@/lib/swift-mt"
import { submitIncomingSwiftUpload } from "@/app/actions/incoming-swift"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Upload, FileUp, Loader2, ShieldCheck, Lock, CheckCircle2, X } from "lucide-react"

interface SwiftUploadDialogProps {
  onSubmitted?: () => void
}

export function SwiftUploadDialog({ onSubmitted }: SwiftUploadDialogProps) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState("")
  const [extracting, setExtracting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [docName, setDocName] = useState<string | null>(null)
  const [docPathname, setDocPathname] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setRaw("")
    setDocName(null)
    setDocPathname(null)
    setExtracting(false)
    setUploading(false)
    setSubmitting(false)
  }

  // Live client-side parse so the customer can confirm what they are submitting.
  const parsed = (() => {
    const text = raw.trim()
    if (!text) return null
    try {
      const m = parseSwiftMessage(text)
      if (!m.type) return null
      return {
        type: m.type,
        amount:
          m.amount != null
            ? `${m.currency ? `${m.currency} ` : ""}${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "",
        sender: m.basicHeader?.senderBic ?? "",
        receiver: m.applicationHeader?.counterpartyBic ?? "",
      }
    } catch {
      return null
    }
  })()

  const handleFile = async (file: File) => {
    setDocName(file.name)
    // 1) Upload the original printout to Blob so the administrator can verify it.
    setUploading(true)
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
      const blob = await upload(`swift/${Date.now()}-${safe}`, file, {
        access: "public",
        handleUploadUrl: "/api/swift/blob-upload",
      })
      setDocPathname(blob.pathname)
    } catch {
      toast.error("Could not upload the file. You can still paste the FIN text below.")
    } finally {
      setUploading(false)
    }

    // 2) Extract the SWIFT FIN text from the printout to pre-fill the field.
    setExtracting(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch("/api/swift/extract", { method: "POST", body: form })
      const data = (await res.json()) as {
        ok: boolean
        error?: string
        data?: { finMessage?: string; summary?: string }
      }
      if (data.ok && data.data?.finMessage) {
        setRaw(data.data.finMessage.trim())
        toast.success("Printout read", {
          description: data.data.summary || "Review the recovered SWIFT message below, then submit.",
        })
      } else {
        toast.warning("Couldn't read the printout automatically", {
          description: data.error || "Paste the SWIFT FIN text from the printout below.",
        })
      }
    } catch {
      toast.error("Extraction failed", { description: "Paste the SWIFT FIN text from the printout below." })
    } finally {
      setExtracting(false)
    }
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) void handleFile(f)
    e.target.value = ""
  }

  const handleSubmit = async () => {
    if (!raw.trim()) {
      toast.error("Provide the SWIFT FIN message text from the printout.")
      return
    }
    setSubmitting(true)
    try {
      const res = await submitIncomingSwiftUpload({
        raw,
        sourceDocPathname: docPathname,
        sourceDocName: docName,
      })
      if (res.ok) {
        toast.success(`${res.messageType ?? "SWIFT"} printout submitted`, {
          description: "It has been sent to the platform for verification. You'll be notified once it's processed.",
        })
        reset()
        setOpen(false)
        onSubmitted?.()
      } else {
        toast.error("Could not submit", { description: res.error })
      }
    } catch {
      toast.error("Could not submit the printout.")
    } finally {
      setSubmitting(false)
    }
  }

  const busy = extracting || uploading || submitting

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload className="mr-2 h-4 w-4" />
        Upload SWIFT printout
      </Button>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-primary" />
            Upload SWIFT printout receipt
          </DialogTitle>
          <DialogDescription>
            Received an incoming SWIFT (e.g. an MT760 blocked-funds guarantee) from your counterparty? Upload the bank
            printout and we&apos;ll transmit it to the platform for verification and action.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload */}
          <div className="rounded-lg border border-dashed border-border p-4">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={onPick}
            />
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="rounded-full bg-primary/10 p-2">
                <Upload className="h-5 w-5 text-primary" />
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  {uploading || extracting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {uploading ? "Uploading..." : "Reading printout..."}
                    </>
                  ) : (
                    <>
                      <FileUp className="mr-2 h-4 w-4" />
                      Choose printout (PDF or image)
                    </>
                  )}
                </Button>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  We read the SWIFT fields automatically. Max 15&nbsp;MB.
                </p>
              </div>
              {docName && (
                <Badge variant="outline" className="mt-1 gap-1 border-emerald-500/30 text-emerald-500">
                  <CheckCircle2 className="h-3 w-3" />
                  {docName}
                </Badge>
              )}
            </div>
          </div>

          {/* FIN text (authoritative, editable) */}
          <div className="space-y-1.5">
            <label htmlFor="swift-fin" className="text-sm font-medium text-foreground">
              SWIFT FIN message
            </label>
            <Textarea
              id="swift-fin"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"Paste the SWIFT FIN text from the printout, or upload the file above to fill it in.\n\ne.g.\n{1:...}{2:...}{4:\n:20:GTEE-REF\n:32B:EUR25000000,00\n..."}
              rows={8}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Check the recovered text matches your printout before submitting. You can edit it.
            </p>
          </div>

          {/* Live parse preview */}
          {parsed && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className="border-primary/30 text-primary">
                  {parsed.type}
                </Badge>
                {parsed.amount && <span className="font-medium text-foreground">{parsed.amount}</span>}
                {parsed.type === "MT760" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" /> Blocked-funds guarantee
                  </span>
                )}
              </div>
              {(parsed.sender || parsed.receiver) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {parsed.sender && <>Sender {parsed.sender}</>}
                  {parsed.sender && parsed.receiver && " → "}
                  {parsed.receiver && <>Receiver {parsed.receiver}</>}
                </p>
              )}
            </div>
          )}

          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Submitting does not credit or book anything automatically. An administrator verifies the message; for an
            MT760 it is then booked to your Bank Instruments as pledgeable blocked-funds collateral.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy || !raw.trim() || !parsed}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Submit for verification
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
