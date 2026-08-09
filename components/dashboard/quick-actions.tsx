"use client"

import {
  Send,
  Download,
  FileText,
  DollarSign,
  Globe,
  Shield,
  ArrowRightLeft,
  Building2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

const actions = [
  {
    title: "Send Payment",
    description: "Transfer funds globally",
    icon: Send,
    color: "bg-blue-500/10 text-blue-400",
    href: "/dashboard/payments",
  },
  {
    title: "Receive Funds",
    description: "Share your account details",
    icon: Download,
    color: "bg-green-500/10 text-green-400",
    href: "/dashboard/receive",
  },
  {
    title: "Trade Instrument",
    description: "SBLC, MTN, BG",
    icon: FileText,
    color: "bg-orange-500/10 text-orange-400",
    href: "/dashboard/instruments",
  },
  {
    title: "Exchange Currency",
    description: "Live FX rates",
    icon: DollarSign,
    color: "bg-purple-500/10 text-purple-400",
    href: "/dashboard/exchange",
  },
  {
    title: "SWIFT Message",
    description: "MT messages",
    icon: Globe,
    color: "bg-cyan-500/10 text-cyan-400",
    href: "/dashboard/swift",
  },
  {
    title: "AML Check",
    description: "Compliance verification",
    icon: Shield,
    color: "bg-red-500/10 text-red-400",
    href: "/dashboard/services",
  },
  {
    title: "Internal Transfer",
    description: "Between accounts",
    icon: ArrowRightLeft,
    color: "bg-indigo-500/10 text-indigo-400",
    href: "/dashboard/payments",
  },
  {
    title: "Add Beneficiary",
    description: "New payment recipient",
    icon: Building2,
    color: "bg-emerald-500/10 text-emerald-400",
    href: "/dashboard/beneficiaries",
  },
]

export function QuickActions() {
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Quick Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {actions.map((action) => (
            <Button
              key={action.title}
              variant="outline"
              className="h-auto flex-col gap-2 p-4 bg-secondary/30 border-border hover:bg-secondary/50"
              asChild
            >
              <a href={action.href}>
                <div className={`rounded-lg p-2 ${action.color}`}>
                  <action.icon className="h-5 w-5" />
                </div>
                <span className="text-xs font-medium text-foreground">
                  {action.title}
                </span>
                <span className="text-[10px] text-muted-foreground text-center">
                  {action.description}
                </span>
              </a>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
