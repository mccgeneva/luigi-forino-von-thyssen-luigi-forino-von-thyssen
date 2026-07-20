import { getSharedDealView } from "@/app/actions/approvals"
import { SharedDealDetail } from "@/components/commodity/shared-deal-detail"

// Always resolve the owner's LIVE deal state on each request — never cache.
export const dynamic = "force-dynamic"

export default async function SharedDealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const view = await getSharedDealView(decodeURIComponent(id))
  return <SharedDealDetail view={view} />
}
