"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Wallet,
  ShieldCheck,
  ScanSearch,
  ArrowLeftRight,
  Sparkles,
  CheckCircle2,
  Clock,
  Loader2,
  type LucideIcon,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useActivityLog } from "@/components/activity-tracker"

interface ServiceMetric {
  label: string
  value: string
}

interface Service {
  icon: LucideIcon
  name: string
  description: string
  status: string
  active: boolean
  /** Longer copy shown in the management panel. */
  overview: string
  features: string[]
  metrics: ServiceMetric[]
}

const services: Service[] = [
  {
    icon: Wallet,
    name: "PayMaster",
    description:
      "Centralised mass-payment engine for payroll, supplier settlements and bulk SWIFT disbursements.",
    status: "Active",
    active: true,
    overview:
      "PayMaster consolidates high-volume outbound payments into a single supervised workflow with dual authorisation, batch scheduling and full SWIFT gpi tracking.",
    features: [
      "Bulk payroll & supplier runs (up to 5,000 lines per batch)",
      "Dual-authorisation approval chains",
      "SWIFT gpi end-to-end tracking",
      "Automated value-date scheduling",
    ],
    metrics: [
      { label: "Batches this month", value: "42" },
      { label: "Avg. settlement", value: "3.1h" },
      { label: "Success rate", value: "99.8%" },
    ],
  },
  {
    icon: ShieldCheck,
    name: "PPI — Payment Protection Insurance",
    description:
      "Transaction insurance covering settlement risk and counterparty default on high-value transfers.",
    status: "Active",
    active: true,
    overview:
      "PPI underwrites your high-value transfers against settlement failure and counterparty default, with cover issued per-transaction and claims handled by our Zurich desk.",
    features: [
      "Per-transaction cover up to CHF 25M",
      "Settlement-risk & counterparty-default protection",
      "48-hour claims assessment",
      "Certificate issued for each insured transfer",
    ],
    metrics: [
      { label: "Cover in force", value: "CHF 18M" },
      { label: "Active policies", value: "7" },
      { label: "Open claims", value: "0" },
    ],
  },
  {
    icon: ScanSearch,
    name: "AML Screening",
    description:
      "Real-time anti-money-laundering and sanctions screening on every inbound and outbound payment.",
    status: "Active",
    active: true,
    overview:
      "Every payment is screened in real time against global sanctions, PEP and adverse-media lists, with automatic holds and a full audit trail for regulators.",
    features: [
      "OFAC, EU, UN & SECO sanctions lists",
      "PEP and adverse-media screening",
      "Automatic hold on positive matches",
      "Regulator-ready audit trail",
    ],
    metrics: [
      { label: "Screened (30d)", value: "1,284" },
      { label: "Flagged", value: "3" },
      { label: "False positives", value: "0.4%" },
    ],
  },
  {
    icon: ArrowLeftRight,
    name: "FX Active Account",
    description: "Live interbank FX rates with automated hedging across 38 currency pairs.",
    status: "Active",
    active: true,
    overview:
      "The FX Active Account gives you live interbank pricing, one-click conversions and rule-based hedging to protect exposures across 38 currency pairs.",
    features: [
      "Live interbank rates, no hidden spread",
      "Rule-based automated hedging",
      "38 currency pairs supported",
      "Forward contracts up to 12 months",
    ],
    metrics: [
      { label: "Pairs", value: "38" },
      { label: "Traded (30d)", value: "CHF 4.2M" },
      { label: "Avg. spread", value: "0.12%" },
    ],
  },
  {
    icon: Sparkles,
    name: "AI Trading Forecasts",
    description:
      "Machine-learning yield and market forecasts informing PPP and instrument strategies.",
    status: "Beta",
    active: false,
    overview:
      "AI Trading Forecasts applies machine-learning models to market and yield data to inform PPP and instrument strategies. This service is currently in closed beta.",
    features: [
      "ML yield & market forecasts",
      "PPP and instrument strategy signals",
      "Weekly outlook reports",
      "Priority onboarding for beta members",
    ],
    metrics: [
      { label: "Model accuracy", value: "87%" },
      { label: "Beta seats", value: "Limited" },
      { label: "Coverage", value: "12 markets" },
    ],
  },
]

const compliance = [
  { label: "FINMA Supervision", value: "Compliant" },
  { label: "KYC / KYB Verification", value: "Verified" },
  { label: "AML / CFT Framework", value: "Active" },
  { label: "GDPR Data Protection", value: "Compliant" },
  { label: "ISO 27001 Security", value: "Certified" },
  { label: "PSD2 Open Banking", value: "Enabled" },
]

export default function ServicesPage() {
  const log = useActivityLog()
  const [selected, setSelected] = useState<Service | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Services the client has requested a beta seat for during this session.
  const [requested, setRequested] = useState<Record<string, boolean>>({})

  const openPanel = (service: Service) => {
    setSelected(service)
    log({
      action: `Opened ${service.name} management panel`,
      category: "Services & Compliance",
      details: {
        summary: `Client opened the management panel for the "${service.name}" service.`,
        service: service.name,
        status: service.status,
        openedAt: new Date().toLocaleString("en-GB"),
      },
    })
  }

  const submitRequest = () => {
    if (!selected) return
    const service = selected
    const isBeta = !service.active
    setSubmitting(true)
    // Simulate the request being lodged with the relationship desk.
    setTimeout(() => {
      log({
        action: isBeta
          ? `Requested beta access to ${service.name}`
          : `Requested a configuration change for ${service.name}`,
        category: "Services & Compliance",
        details: {
          summary: isBeta
            ? `Client requested beta enrollment for the "${service.name}" service.`
            : `Client submitted a management request for the "${service.name}" service.`,
          service: service.name,
          requestedAt: new Date().toLocaleString("en-GB"),
        },
      })
      if (isBeta) setRequested((prev) => ({ ...prev, [service.name]: true }))
      setSubmitting(false)
      setSelected(null)
      toast.success(
        isBeta ? `Beta access requested for ${service.name}` : `Request sent for ${service.name}`,
        {
          description: isBeta
            ? "We'll notify you once you're enrolled in the beta program."
            : "Your relationship manager will follow up shortly.",
        },
      )
    }, 700)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground text-balance">Services &amp; Compliance</h1>
        <p className="text-sm text-muted-foreground">
          Value-added banking services and regulatory compliance status
        </p>
      </div>

      {/* Services */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => {
          const hasRequested = requested[service.name]
          return (
            <Card key={service.name} className="bg-card border-border">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <service.icon className="h-5 w-5 text-primary" />
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      service.active
                        ? "bg-green-500/10 text-green-500 border-green-500/20 text-[10px]"
                        : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20 text-[10px]"
                    }
                  >
                    {service.active ? (
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                    ) : (
                      <Clock className="mr-1 h-3 w-3" />
                    )}
                    {service.status}
                  </Badge>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-foreground">{service.name}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {service.description}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 w-full min-h-11"
                  onClick={() => openPanel(service)}
                >
                  {service.active ? "Manage" : hasRequested ? "Requested" : "Join Beta"}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Compliance status */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Regulatory Compliance</CardTitle>
          <p className="text-xs text-muted-foreground">
            MCC Capital operates under full Swiss and EU regulatory frameworks
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {compliance.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-lg border border-border bg-secondary/30 p-3"
              >
                <span className="text-sm text-foreground">{item.label}</span>
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px]">
                  <ShieldCheck className="mr-1 h-3 w-3" />
                  {item.value}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Management panel */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {selected ? (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <selected.icon className="h-6 w-6 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="text-left text-base leading-tight text-pretty">
                      {selected.name}
                    </DialogTitle>
                    <Badge
                      variant="outline"
                      className={
                        selected.active
                          ? "mt-1 bg-green-500/10 text-green-500 border-green-500/20 text-[10px]"
                          : "mt-1 bg-yellow-500/10 text-yellow-500 border-yellow-500/20 text-[10px]"
                      }
                    >
                      {selected.active ? (
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                      ) : (
                        <Clock className="mr-1 h-3 w-3" />
                      )}
                      {selected.status}
                    </Badge>
                  </div>
                </div>
                <DialogDescription className="pt-2 text-left text-pretty">
                  {selected.overview}
                </DialogDescription>
              </DialogHeader>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-2">
                {selected.metrics.map((m) => (
                  <div
                    key={m.label}
                    className="rounded-lg border border-border bg-secondary/30 p-3 text-center"
                  >
                    <p className="text-sm font-semibold text-foreground">{m.value}</p>
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{m.label}</p>
                  </div>
                ))}
              </div>

              {/* Features */}
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {selected.active ? "Included" : "What you get in the beta"}
                </p>
                <ul className="space-y-2">
                  {selected.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-foreground">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="text-pretty">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setSelected(null)}
                  disabled={submitting}
                >
                  Close
                </Button>
                <Button className="min-h-11" onClick={submitRequest} disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending…
                    </>
                  ) : selected.active ? (
                    "Request a change"
                  ) : (
                    "Request beta access"
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
