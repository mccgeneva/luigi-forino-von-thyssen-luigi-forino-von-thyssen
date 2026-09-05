import { NextResponse } from "next/server"
import { isCurrentSessionAdmin } from "@/lib/admin-auth"
import {
  countPendingByKind,
  countPaymentsAwaitingDelivery,
  countYieldTerminationRequests,
  countTradingFundTerminationRequests,
  countInstrumentExitRequests,
} from "@/lib/approvals-db"
import { listCreditableIncomingSwift } from "@/lib/incoming-swift-db"
import { countPendingEquityReleases } from "@/lib/equity-release-db"
import { listAllSwiftRoutingRequests } from "@/lib/swift-routing-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Read-only aggregate count of everything awaiting ANY administrator's action.
 *
 * ROLE-gated only (admin email), NOT PIN-gated: seeing that there is work to do
 * is not a privileged mutation, and requiring the PIN just to light up a nav
 * badge would defeat the purpose. The PIN is still required to actually open
 * the panel and action anything.
 *
 * This powers a persistent "to-do" badge on the Administrator nav entry so
 * EVERY admin — including sub-account admins like a.koller@mccgva.ch whose
 * transient notification bell may already be marked read — can always see and
 * find pending admin tasks, independent of the read-state of their bell.
 *
 * The queues counted here are distinct tables/markers (no double counting):
 *   - pending approval_requests (all kinds)         via countPendingByKind
 *   - inbound SWIFT awaiting credit/booking         via listCreditableIncomingSwift
 *   - approved payments awaiting delivery           via countPaymentsAwaitingDelivery
 *   - yield / trading-fund early-termination asks    via count…TerminationRequests
 *   - equity-saving release requests                 via countPendingEquityReleases
 *   - client→beneficiary SWIFT routing requests      via listAllSwiftRoutingRequests
 */
export async function GET() {
  if (!(await isCurrentSessionAdmin())) {
    return NextResponse.json({ ok: false, total: 0 }, { status: 200 })
  }

  const [
    pendingByKind,
    creditableSwift,
    paymentsAwaitingDelivery,
    yieldTerminations,
    tradingFundTerminations,
    equityReleases,
    swiftRouting,
    instrumentExits,
  ] = await Promise.allSettled([
    countPendingByKind(),
    listCreditableIncomingSwift(),
    countPaymentsAwaitingDelivery(),
    countYieldTerminationRequests(),
    countTradingFundTerminationRequests(),
    countPendingEquityReleases(),
    listAllSwiftRoutingRequests(),
    countInstrumentExitRequests(),
  ])

  const approvals =
    pendingByKind.status === "fulfilled"
      ? Object.values(pendingByKind.value).reduce((sum, n) => sum + (Number(n) || 0), 0)
      : 0
  const incomingSwift = creditableSwift.status === "fulfilled" ? creditableSwift.value.length : 0
  const delivery = paymentsAwaitingDelivery.status === "fulfilled" ? paymentsAwaitingDelivery.value : 0
  const yields = yieldTerminations.status === "fulfilled" ? yieldTerminations.value : 0
  const treuhand = tradingFundTerminations.status === "fulfilled" ? tradingFundTerminations.value : 0
  const equity = equityReleases.status === "fulfilled" ? equityReleases.value : 0
  const routing =
    swiftRouting.status === "fulfilled"
      ? swiftRouting.value.filter((r) => r.status === "pending").length
      : 0
  const instrumentExit = instrumentExits.status === "fulfilled" ? instrumentExits.value : 0

  const total = approvals + incomingSwift + delivery + yields + treuhand + equity + routing + instrumentExit

  return NextResponse.json({
    ok: true,
    total,
    breakdown: { approvals, incomingSwift, delivery, yields, treuhand, equity, routing, instrumentExit },
  })
}
