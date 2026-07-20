"use client"

import { useEffect, useState, useTransition } from "react"
import { ScanFace, ShieldCheck, ShieldAlert, Loader2, Trash2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { FaceCapture } from "@/components/auth/face-capture"
import type { FaceState } from "@/lib/biometric-types"

const ENROLL_SAMPLES = 3

const NOT_ENROLLED: FaceState = { enrolled: false, locked: false, failCount: 0, enrolledAt: null, lockedAt: null }

// Biometric enroll/status/disable go through a Route Handler (NOT a Server
// Action): Server Action POSTs are silently rejected on this app's production
// domains + mobile in-app webviews, which left the enroll flow hanging on
// "Securing your biometric profile…". Route Handlers are exempt from that check.
async function fetchFaceState(): Promise<FaceState> {
  const res = await fetch("/api/biometric", { cache: "no-store" })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return (await res.json()) as FaceState
}

async function postEnroll(descriptors: number[][]): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/biometric", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ descriptors }),
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (res.ok && json?.ok) return { ok: true }
  return { ok: false, error: json?.error || "Enrollment failed. Please try again." }
}

async function postDisable(): Promise<void> {
  await fetch("/api/biometric", { method: "DELETE", cache: "no-store" })
}

export function FaceIdManager() {
  const [state, setState] = useState<FaceState | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [captured, setCaptured] = useState<number[][]>([])
  const [enrolling, setEnrolling] = useState(false)
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()

  const refresh = () =>
    fetchFaceState()
      .then(setState)
      // Never let a transient failure leave the button permanently disabled —
      // fall back to a "not enrolled" state so the user can still try to enroll.
      .catch(() => setState(NOT_ENROLLED))
  useEffect(() => {
    void refresh()
  }, [])

  // Collect ENROLL_SAMPLES descriptors, then submit them all at once.
  const handleCapture = async (descriptor: number[]) => {
    const next = [...captured, descriptor]
    setCaptured(next)
    if (next.length >= ENROLL_SAMPLES) {
      setEnrolling(true)
      setError("")
      try {
        const res = await postEnroll(next)
        if (res.ok) {
          setDialogOpen(false)
          setCaptured([])
          void refresh()
        } else {
          setError(res.error || "Enrollment failed. Please try again.")
          setCaptured([])
        }
        return res
      } catch {
        // Network/transport failure — surface it instead of hanging the spinner.
        setError("Could not reach the server. Check your connection and try again.")
        setCaptured([])
        return { ok: false, error: "network" }
      } finally {
        // ALWAYS clear the spinner, even if the request threw. This is what left
        // the flow stuck on "Securing your biometric profile…" before.
        setEnrolling(false)
      }
    }
    return { ok: true }
  }

  const handleDisable = () => {
    startTransition(async () => {
      await postDisable()
      void refresh()
    })
  }

  const openEnroll = () => {
    setCaptured([])
    setError("")
    setDialogOpen(true)
  }

  const enrolled = state?.enrolled
  const locked = state?.locked

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ScanFace className="h-4 w-4 text-primary" />
              Face ID Login
            </CardTitle>
            <CardDescription>Biometric two-factor sign-in for this account</CardDescription>
          </div>
          {state &&
            (enrolled ? (
              <Badge
                className={
                  locked
                    ? "bg-destructive text-destructive-foreground gap-1"
                    : "bg-success text-success-foreground gap-1"
                }
              >
                {locked ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                {locked ? "Locked" : "Enabled"}
              </Badge>
            ) : (
              <Badge variant="outline">Not set up</Badge>
            ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground text-pretty">
          When enabled, signing in requires both your password and a live face scan. Your face is
          stored as an encrypted mathematical descriptor — never as a photo — and never leaves our
          servers in readable form.
        </p>

        {locked && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            Face ID is locked after too many failed attempts. Please contact your administrator to
            reset it, then you can set it up again.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {!enrolled ? (
            <Button onClick={openEnroll} disabled={!state} className="gap-2">
              <ScanFace className="h-4 w-4" />
              Set up Face ID
            </Button>
          ) : (
            <>
              <Button onClick={openEnroll} variant="outline" className="gap-2">
                <ScanFace className="h-4 w-4" />
                Re-enroll face
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="gap-2 text-destructive hover:text-destructive">
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    Turn off
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Turn off Face ID?</AlertDialogTitle>
                    <AlertDialogDescription>
                      You will sign in with your password only until you set up Face ID again. Your
                      stored biometric descriptor will be permanently deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDisable}>Turn off Face ID</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>

        {enrolled && state?.enrolledAt && !locked && (
          <p className="text-xs text-muted-foreground">
            Enrolled {new Date(state.enrolledAt).toLocaleDateString()}.
          </p>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(o) => !enrolling && setDialogOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up Face ID</DialogTitle>
            <DialogDescription>
              Look at the camera and scan {ENROLL_SAMPLES} times. Captured {captured.length} of{" "}
              {ENROLL_SAMPLES}.
            </DialogDescription>
          </DialogHeader>
          {enrolling ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Securing your biometric profile…</p>
            </div>
          ) : (
            <FaceCapture onCapture={handleCapture} actionLabel={`Capture ${captured.length + 1} of ${ENROLL_SAMPLES}`} />
          )}
          {error && <p className="text-center text-sm text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
