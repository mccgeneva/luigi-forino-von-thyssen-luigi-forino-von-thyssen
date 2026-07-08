"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Lock, ShieldCheck, ArrowLeft } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ADMIN_SESSION_KEY } from "@/lib/admin-config"
import { verifyAdminGate, confirmAdminSession } from "@/app/actions/admin-session"
import { AdminSwiftInspector } from "@/components/dashboard/admin-swift-inspector"
import { SwiftRoutingQueue } from "@/components/admin/swift-routing-queue"

export default function AdminSwiftPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [passcode, setPasscode] = useState("")
  const [gateError, setGateError] = useState<string | null>(null)

  const [gateChecking, setGateChecking] = useState(false)

  // A persisted unlock flag only re-unlocks after the SERVER re-confirms this
  // session is an admin. The admin subtree layout already blocks non-admins, so
  // this is defense-in-depth.
  useEffect(() => {
    let cancelled = false
    let flagged = false
    try {
      flagged = window.sessionStorage.getItem(ADMIN_SESSION_KEY) === "true"
    } catch {
      flagged = false
    }
    if (!flagged) return
    ;(async () => {
      try {
        if (await confirmAdminSession()) {
          if (!cancelled) setUnlocked(true)
        } else {
          try {
            window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
          } catch {
            // ignore
          }
        }
      } catch {
        // stay locked on error
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleUnlock = async () => {
    if (gateChecking) return
    setGateChecking(true)
    setGateError(null)
    try {
      const res = await verifyAdminGate(passcode.trim())
      if (res.ok) {
        setUnlocked(true)
        setGateError(null)
        setPasscode("")
        try {
          window.sessionStorage.setItem(ADMIN_SESSION_KEY, "true")
        } catch {
          // ignore
        }
      } else if (res.reason === "forbidden") {
        setGateError("This account is not authorized to access the Administrator Panel.")
      } else {
        setGateError("Incorrect administrator passcode. Please try again.")
      }
    } catch {
      setGateError("Could not verify administrator access. Please try again.")
    } finally {
      setGateChecking(false)
    }
  }

  if (!unlocked) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center justify-center py-16">
        <Card className="w-full border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl font-semibold">SWIFT Message Inspector</CardTitle>
            <p className="text-pretty text-sm text-muted-foreground">
              This area is restricted. Enter the Administrator passcode to parse, validate, ingest, and
              generate SWIFT MT messages.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="swift-passcode">Administrator Passcode</Label>
              <Input
                id="swift-passcode"
                type="password"
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value)
                  setGateError(null)
                }}
                onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                placeholder="Enter passcode"
                autoComplete="off"
              />
              {gateError && (
                <p className="text-sm text-destructive" role="alert">
                  {gateError}
                </p>
              )}
            </div>
            <Button className="w-full" onClick={handleUnlock}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Unlock Inspector
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href="/dashboard/admin">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Administrator Area
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <SwiftRoutingQueue />
      <AdminSwiftInspector />
    </div>
  )
}
