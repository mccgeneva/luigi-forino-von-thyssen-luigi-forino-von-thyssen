"use client"

import { useState } from "react"
import Link from "next/link"
import { Send, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
 import { Input } from "@/components/ui/input"
 import { MoneyInput } from "@/components/ui/money-input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CardVisual, useCards } from "@/components/dashboard/bank-cards"
import { useActivityLog } from "@/components/activity-tracker"
import { useBeneficiaries } from "@/lib/beneficiaries-store"

export function OverviewAside() {
  const log = useActivityLog()
  const cards = useCards()
  const { beneficiaries } = useBeneficiaries()
  // Payees are the client's own active beneficiaries — no fabricated payees.
  const payees = beneficiaries
    .filter((b) => b.status === "active")
    .map((b) => ({ id: b.id, name: b.name }))
  const [payee, setPayee] = useState("")
  const [amount, setAmount] = useState("")

  const handleTransfer = () => {
    const selected = payees.find((p) => p.id === payee)
    const formattedAmount = amount
      ? `€${Number.parseFloat(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—"
    log({
      action: `Quick transfer of ${formattedAmount} to ${selected?.name ?? payee}`,
      category: "Payments",
      details: {
        summary: `Client initiated a quick transfer of ${formattedAmount} to saved payee "${selected?.name ?? payee}" from the dashboard widget.`,
        payee: selected?.name ?? payee,
        amount: formattedAmount,
        source: "Dashboard quick transfer widget",
        submittedAt: new Date().toLocaleString("en-GB"),
      },
    })
    setAmount("")
  }

  return (
    <div className="space-y-6">
      {/* Cards widget */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg font-semibold">Your Cards</CardTitle>
          <Button asChild variant="ghost" size="sm" className="text-xs">
            <Link href="/dashboard/cards">
              View all
              <ChevronRight className="ml-1 h-3 w-3" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <CardVisual card={cards[0]} />
        </CardContent>
      </Card>

      {/* Quick transfer */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Quick Transfer</CardTitle>
          <p className="text-xs text-muted-foreground">Send funds to a saved payee</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {payees.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center">
              <p className="text-sm font-medium text-foreground">No saved payees yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a beneficiary to send a quick transfer.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href="/dashboard/beneficiaries">Add Beneficiary</Link>
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label className="text-xs">Payee</Label>
                <Select value={payee} onValueChange={setPayee}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select payee" />
                  </SelectTrigger>
                  <SelectContent>
                    {payees.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">Amount (EUR)</Label>
                <MoneyInput
                  placeholder="0.00"
                  value={amount}
                  onValueChange={setAmount}
                />
              </div>
              <Button className="w-full" onClick={handleTransfer} disabled={!amount || !payee}>
                <Send className="mr-2 h-4 w-4" />
                Send Transfer
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
