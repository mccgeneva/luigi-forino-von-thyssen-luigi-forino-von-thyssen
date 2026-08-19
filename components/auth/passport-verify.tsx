"use client"

import { useRef, useState } from "react"
import { upload } from "@vercel/blob/client"
import { AlertCircle, ArrowLeft, BadgeCheck, Camera, IdCard, Loader2, ShieldQuestion, Upload } from "lucide-react"
import { verifyIdentityAndLogin, type LoginState } from "@/app/actions/auth"
import { descriptorFromImage, loadImageFromFile, FaceModelLoadError } from "@/lib/face-client"
import { FaceCapture } from "@/components/auth/face-capture"
import { Button } from "@/components/ui/button"

type SubStep = "passport" | "selfie"

function markLoginHandoff() {
  try {
    localStorage.setItem("mcc_login_handoff", "1")
  } catch {
    // Ignore storage access errors (e.g. privacy mode).
  }
}

/**
 * Mandatory identity-verification step shown after the password is verified for
 * an account that has not yet been verified (and every time for the shared demo
 * account). The user uploads their passport bio-data page, then takes a live
 * selfie; the server confirms the document reads as a passport and that the
 * selfie matches the passport photo before granting a session.
 *
 * Privacy: the passport image is used only for this one check and is deleted
 * from storage immediately afterwards. Face matching sends only numeric
 * descriptors — never the raw selfie image — to the server.
 */
export function PassportVerify({
  challenge,
  name,
  demo,
  onBack,
}: {
  challenge: string
  name?: string
  demo?: boolean
  onBack: () => void
}) {
  const [subStep, setSubStep] = useState<SubStep>("passport")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  // Held between sub-steps: the chosen passport file and its face descriptor.
  const passportFileRef = useRef<File | null>(null)
  const passportDescriptorRef = useRef<number[] | null>(null)
  // Two separate inputs so the user can EITHER open the camera OR pick an
  // existing photo/file. A single input with `capture` forces the camera on
  // mobile and hides the gallery/file option, which is what we're fixing.
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const handlePassportSelected = async (file: File | undefined) => {
    if (!file) return
    setError("")
    setBusy(true)
    try {
      const img = await loadImageFromFile(file)
      const descriptor = await descriptorFromImage(img)
      if (!descriptor) {
        setError(
          "We couldn't find a face photo on that image. Make sure the whole passport bio-data page is in frame, well lit, and in focus.",
        )
        setBusy(false)
        return
      }
      passportFileRef.current = file
      passportDescriptorRef.current = descriptor
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(file)
      })
    } catch (err) {
      if (err instanceof FaceModelLoadError) {
        setError("Couldn't load the document scanner. Check your connection and try again.")
      } else {
        setError("We couldn't read that image. Please choose a clear photo of your passport.")
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSelfie = async (selfieDescriptor: number[], selfieImage?: string) => {
    const passportFile = passportFileRef.current
    const passportDescriptor = passportDescriptorRef.current
    if (!passportFile || !passportDescriptor) {
      setSubStep("passport")
      return { ok: false, error: "Please add your passport photo first." }
    }
    setError("")
    markLoginHandoff()
    try {
      // Upload the passport image fresh for this attempt. The server deletes it
      // after every check (pass or fail), so each retry re-uploads.
      const blob = await upload(`identity/${Date.now()}-passport.jpg`, passportFile, {
        access: "public",
        handleUploadUrl: "/api/identity/blob-upload",
        clientPayload: JSON.stringify({ challenge }),
      })

      const res: LoginState = await verifyIdentityAndLogin(challenge, {
        passportDescriptor,
        selfieDescriptor,
        passportPathname: blob.pathname,
        passportContentType: passportFile.type || "image/jpeg",
        selfieImage,
      })

      if (res?.success) {
        window.location.assign(res.redirectTo || "/dashboard?fresh=1")
        return { ok: true }
      }

      if (res?.error) {
        setError(res.error)
        // Challenge expired or hard failure (e.g. account inactive / locked):
        // no longer an identity retry → send the user back to the password form.
        if (!res.identityRequired) setTimeout(onBack, 2400)
        return { ok: false, error: res.error }
      }
      return { ok: false, error: "Verification failed. Please try again." }
    } catch (err) {
      const raw = err instanceof Error ? err.message : ""
      // The Vercel Blob client throws this opaque error whenever our token route
      // rejects the upload — most often because the short-lived secure session
      // (login challenge) expired during the passport/selfie capture. Show an
      // actionable message and send the user back to sign in again so they get a
      // fresh session, instead of leaving them stuck on a dead token.
      if (/client token/i.test(raw)) {
        const message = "Your secure sign-in session expired. Please enter your password again to restart verification."
        setError(message)
        setTimeout(onBack, 2600)
        return { ok: false, error: message }
      }
      const message = raw || "Upload failed. Please try again."
      setError(message)
      return { ok: false, error: message }
    }
  }

  const passportReady = !!passportDescriptorRef.current

  return (
    <div className="space-y-5">
      <div className="text-center space-y-1">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          {subStep === "passport" ? (
            <IdCard className="h-5 w-5 text-primary" />
          ) : (
            <BadgeCheck className="h-5 w-5 text-primary" />
          )}
        </div>
        <h2 className="text-base font-semibold text-foreground">Verify your identity</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {name ? `${name}, ` : ""}
          {subStep === "passport"
            ? "Add a photo of your passport bio-data page to continue."
            : "Now take a live selfie so we can match it to your passport photo."}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2" aria-hidden="true">
        <span className={`h-1.5 w-8 rounded-full ${subStep === "passport" ? "bg-primary" : "bg-primary/40"}`} />
        <span className={`h-1.5 w-8 rounded-full ${subStep === "selfie" ? "bg-primary" : "bg-muted"}`} />
      </div>

      {subStep === "passport" ? (
        <div className="space-y-4">
          {/* Camera: opens the device camera on mobile. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              handlePassportSelected(e.target.files?.[0])
              e.target.value = ""
            }}
          />
          {/* Upload: opens the gallery / file picker (no `capture`), also works on desktop.
              PDF is allowed too so users can upload a scanned passport document. */}
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              handlePassportSelected(e.target.files?.[0])
              e.target.value = ""
            }}
          />

          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={busy}
            className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/40 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-muted/60 disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl || "/placeholder.svg"}
                alt="Selected passport preview"
                className="h-28 w-auto rounded-md border border-border object-contain"
              />
            ) : (
              <Upload className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="text-sm font-medium text-foreground">
              {busy
                ? "Reading document…"
                : previewUrl
                  ? "Passport photo added — tap to replace"
                  : "Tap to upload a photo or file"}
            </span>
            {!busy && !previewUrl && (
              <span className="text-xs text-muted-foreground">
                JPG or PNG from your phone or computer · the bio-data page with your photo
              </span>
            )}
          </button>

          {/* Explicit camera option for mobile users who want to snap a fresh photo. */}
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full gap-2"
            disabled={busy}
            onClick={() => cameraInputRef.current?.click()}
          >
            <Camera className="h-4 w-4" />
            Take a photo instead
          </Button>

          {passportReady && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
              <BadgeCheck className="h-4 w-4 shrink-0 text-primary" />
              <span>Face photo detected on your document.</span>
            </div>
          )}

          <Button
            type="button"
            className="h-11 w-full text-base"
            disabled={!passportReady || busy}
            onClick={() => {
              setError("")
              setSubStep("selfie")
            }}
          >
            Continue to selfie
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <FaceCapture onCapture={handleSelfie} actionLabel="Take selfie & verify" autoStart autoScan captureSelfie />
          <Button
            type="button"
            variant="ghost"
            className="w-full gap-2"
            onClick={() => {
              setError("")
              setSubStep("passport")
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to passport
          </Button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground text-pretty">
        <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {demo
            ? "Demo account: your passport is checked live and deleted immediately — nothing is saved. "
            : "Your passport is used once to verify you, then deleted. An encrypted face match and a login selfie snapshot are kept for security and are visible only to administrators. "}
          This is an in-app identity check, not a government-issued authenticity certificate.
        </span>
      </p>

      <Button type="button" variant="ghost" onClick={onBack} className="w-full gap-2">
        <ArrowLeft className="h-4 w-4" />
        Use a different account
      </Button>
    </div>
  )
}
