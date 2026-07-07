"use client"

import { useActionState, useState } from "react"
import { useFormStatus } from "react-dom"
import { Lock, Mail, ShieldCheck, AlertCircle, ScanFace, ArrowLeft } from "lucide-react"
import { login, completeFaceLogin, type LoginState } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FaceCapture } from "@/components/auth/face-capture"
import { PassportVerify } from "@/components/auth/passport-verify"

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full h-11 text-base" disabled={pending}>
      {pending ? "Verifying..." : "Sign In"}
    </Button>
  )
}

function markLoginHandoff() {
  // Mark that authentication originated from this browser tab. The SessionGuard
  // on the dashboard uses this one-time flag to tell a genuine login apart from
  // a tab that was closed and later reopened with a still-valid cookie.
  try {
    localStorage.setItem("mcc_login_handoff", "1")
  } catch {
    // Ignore storage access errors (e.g. privacy mode).
  }
}

/**
 * Second step shown only after the password is verified for a user who has
 * enrolled Face ID. Captures a live descriptor and calls `completeFaceLogin`,
 * which redirects on a successful strict match.
 */
function FaceStep({
  challenge,
  name,
  onBack,
}: {
  challenge: string
  name?: string
  onBack: () => void
}) {
  const [error, setError] = useState("")
  const [activeChallenge, setActiveChallenge] = useState(challenge)

  const handleCapture = async (descriptor: number[], selfie?: string) => {
    setError("")
    // Set the genuine-login handoff before the (possible) server redirect so the
    // SessionGuard treats a face-verified login the same as a password login.
    markLoginHandoff()
    const res = await completeFaceLogin(activeChallenge, descriptor, selfie)
    // A returned error means the scan failed or the challenge needs retrying.
    if (res?.error) {
      setError(res.error)
      if (res.challenge) setActiveChallenge(res.challenge)
      // If the challenge expired / face no longer enrolled, send them back to password.
      if (!res.faceRequired) setTimeout(onBack, 2200)
      return { ok: false, error: res.error }
    }
    // Success: the session cookies are set server-side. Perform a FULL-page
    // navigation (not client routing) so the proxy re-reads the fresh session
    // cookies and the SessionGuard sees the genuine-login handoff flag.
    if (res?.success) {
      window.location.assign(res.redirectTo || "/dashboard?fresh=1")
    }
    return { ok: true }
  }

  return (
    <div className="space-y-5">
      <div className="text-center space-y-1">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <ScanFace className="h-5 w-5 text-primary" />
        </div>
        <h2 className="text-base font-semibold text-foreground">Face verification</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          {name ? `Welcome back, ${name}. ` : ""}Confirm it&apos;s you with a quick face scan.
        </p>
      </div>

      <FaceCapture onCapture={handleCapture} actionLabel="Verify my face" autoStart captureSelfie />

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Button type="button" variant="ghost" onClick={onBack} className="w-full gap-2">
        <ArrowLeft className="h-4 w-4" />
        Use a different account
      </Button>
    </div>
  )
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {})
  // Local flag lets the user back out of a second-factor step to the password form.
  const [backToPassword, setBackToPassword] = useState(false)

  const showFaceStep = state?.faceRequired && state.challenge && !backToPassword
  const showIdentityStep = state?.identityRequired && state.challenge && !backToPassword

  if (showIdentityStep) {
    return (
      <PassportVerify
        challenge={state.challenge!}
        name={state.name}
        demo={state.demo}
        onBack={() => setBackToPassword(true)}
      />
    )
  }

  if (showFaceStep) {
    return (
      <FaceStep
        challenge={state.challenge!}
        name={state.name}
        onBack={() => setBackToPassword(true)}
      />
    )
  }

  return (
    <form action={formAction} onSubmit={markLoginHandoff} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="you@company.com"
            required
            className="pl-10 h-11 text-base"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            required
            className="pl-10 h-11 text-base"
          />
        </div>
      </div>

      {state?.error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      <SubmitButton />

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Authorized access only. All activity is monitored and logged.
      </p>
    </form>
  )
}
