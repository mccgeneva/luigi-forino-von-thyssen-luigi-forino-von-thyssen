// ---------------------------------------------------------------------------
// POST /charges  — alias of /api/v1/charge
//
// NQAi.cloud defaults its base URL to https://mcc-btp.app (no /api prefix) and
// posts subscription charges to `/charges`. To make that default just work with
// no configuration on NQAi's side, this route re-exports the canonical charge
// handler verbatim, so billing behavior (auth, plans, solvency, idempotency)
// is identical.
// ---------------------------------------------------------------------------

import { POST as chargePost } from "@/app/api/v1/charge/route"

// `dynamic` must be declared statically in the route file itself (Next.js parses
// route segment config at compile time and cannot follow a re-export).
export const dynamic = "force-dynamic"

export function POST(req: Request) {
  return chargePost(req)
}
