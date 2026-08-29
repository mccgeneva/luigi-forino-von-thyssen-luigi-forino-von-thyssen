"use client"

import { useState } from "react"
import Link from "next/link"
import { Receipt, Download, ExternalLink } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useActivityLog } from "@/components/activity-tracker"
import { generateCostCataloguePdf } from "@/lib/cost-catalogue-pdf"
import { usePdfViewer } from "@/lib/pdf-viewer"
import { COST_CATALOGUE_META } from "@/lib/cost-catalogue"

/**
 * Profile → Terms and Costs. Lets the client open the complete fee catalogue
 * online (the /dashboard/terms-costs page) or download the certifiable PDF at
 * any time. Both actions are audit-logged.
 */
export function TermsCostsCard() {
  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const [preparing, setPreparing] = useState(false)

  const handleDownload = () => {
    if (preparing) return
    setPreparing(true)
    show(generateCostCataloguePdf())
    setPreparing(false)
    logActivity({
      action: "Downloaded the platform Terms & Costs catalogue (PDF)",
      category: "Platform",
      details: {
        summary: "Client downloaded the complete platform fee catalogue from their Profile.",
        document: COST_CATALOGUE_META.title,
        version: COST_CATALOGUE_META.version,
        format: "PDF",
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" /> Terms and Costs
          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-[10px] text-primary">
            {COST_CATALOGUE_META.version}
          </Badge>
        </CardTitle>
        <CardDescription>
          The complete, certified schedule of every platform fee, charge and interest rate — and when each applies. Open
          it online or download the PDF at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 sm:flex-row">
        <Button asChild variant="outline" className="sm:flex-1 bg-transparent">
          <Link href="/dashboard/terms-costs">
            <ExternalLink className="mr-2 h-4 w-4" />
            View online
          </Link>
        </Button>
        <Button className="sm:flex-1" onClick={handleDownload} disabled={preparing}>
          <Download className="mr-2 h-4 w-4" />
          {preparing ? "Preparing…" : "Download PDF"}
        </Button>
      </CardContent>
    </Card>
  )
}
