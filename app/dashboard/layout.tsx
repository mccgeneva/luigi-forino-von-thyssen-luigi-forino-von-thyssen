import { redirect } from "next/navigation"
import { getMyIdentity } from "@/app/actions/admin-users"
import { DashboardSidebar } from "@/components/dashboard/sidebar"
import { DashboardHeader } from "@/components/dashboard/header"
import { MarketTicker } from "@/components/dashboard/market-ticker"
import { BackToTop } from "@/components/dashboard/back-to-top"
import { ActivityTracker } from "@/components/activity-tracker"
import { CurrentUserProvider } from "@/lib/use-current-user"
import { PdfViewerProvider } from "@/lib/pdf-viewer"
import { SessionGuard } from "@/components/session-guard"
import { ImpersonationBanner } from "@/components/impersonation-banner"
import { PointerEventsGuard } from "@/components/pointer-events-guard"
import { DemoSeedGate } from "@/components/demo-seed-gate"
import { FundingCapitalReconciler } from "@/components/funding-capital-reconciler"
import { TreasuryFinancingReconciler } from "@/components/treasury-financing-reconciler"
import { LeverageInterestReconciler } from "@/components/leverage-interest-reconciler"
import { BeneficiariesProvider } from "@/lib/beneficiaries-store"
import { LedgerProvider } from "@/lib/ledger-store"
import { PaymentRequestsProvider } from "@/lib/payment-requests-store"
import { InstrumentRequestsProvider } from "@/lib/instrument-requests-store"
import { CardRequestsProvider } from "@/lib/card-requests-store"
import { MonetizationRequestsProvider } from "@/lib/monetization-requests-store"
import { PPPRequestsProvider } from "@/lib/ppp-requests-store"
import { ProjectFundingProvider } from "@/lib/project-funding-store"
import { FiduciaryRequestsProvider } from "@/lib/fiduciary-requests-store"
import { SkrProvider } from "@/lib/skr-store"
import { DOFRequestsProvider } from "@/lib/dof-requests-store"
import { DTCRequestsProvider } from "@/lib/dtc-requests-store"
import { EuroclearRequestsProvider } from "@/lib/euroclear-requests-store"
import { CommodityDealsProvider } from "@/lib/commodity-deals-store"
import { LeverageRequestsProvider } from "@/lib/leverage-requests-store"
import { CertificateRequestsProvider } from "@/lib/certificates-store"
import { TreasuryProvider } from "@/lib/treasury-store"
import { GatewayProvider } from "@/lib/gateway-store"

// Identity depends on the per-request session cookie, so this layout must never
// be statically cached or shared between users.
export const dynamic = "force-dynamic"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Authoritative, per-request identity resolved from the httpOnly session
  // cookie on the SERVER. This is the single source of truth for who is signed
  // in: it is computed fresh on every request/refresh (never a stale client
  // cache, never a CDN-shared payload), so a user can only ever see the account
  // their own session cookie resolves to. No valid session → back to login.
  const identity = await getMyIdentity()
  if (!identity) redirect("/login?expired=expiry")

  return (
    <CurrentUserProvider initialIdentity={identity}>
    <PdfViewerProvider>
    <ActivityTracker>
      <DemoSeedGate>
      <BeneficiariesProvider>
      <LedgerProvider>
      <PaymentRequestsProvider>
      <InstrumentRequestsProvider>
      <CardRequestsProvider>
      <MonetizationRequestsProvider>
      <PPPRequestsProvider>
      <ProjectFundingProvider>
      <FiduciaryRequestsProvider>
      <SkrProvider>
      <DOFRequestsProvider>
      <DTCRequestsProvider>
      <EuroclearRequestsProvider>
      <CommodityDealsProvider>
      <LeverageRequestsProvider>
      <CertificateRequestsProvider>
      <TreasuryProvider>
      <GatewayProvider>
      <SessionGuard />
      <PointerEventsGuard />
      <FundingCapitalReconciler />
      <TreasuryFinancingReconciler />
      <LeverageInterestReconciler />
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        {/* Maintenance banner — only while an administrator is signed in as this client. */}
        {identity.impersonator && (
          <ImpersonationBanner
            adminName={identity.impersonator.name}
            targetName={
              identity.kind === "dynamic"
                ? identity.profile.fullName || identity.profile.company || "this client"
                : "this client"
            }
          />
        )}
        <div className="flex flex-1 overflow-hidden">
          {/* Desktop Sidebar */}
          <div className="hidden md:block">
            <DashboardSidebar />
          </div>

          {/* Main Content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <DashboardHeader />
            <MarketTicker />
            <main className="flex-1 overflow-y-auto p-4 pb-24 md:p-6 md:pb-24">{children}</main>
          </div>
          <BackToTop />
        </div>
      </div>
      </GatewayProvider>
      </TreasuryProvider>
      </CertificateRequestsProvider>
      </LeverageRequestsProvider>
      </CommodityDealsProvider>
      </EuroclearRequestsProvider>
      </DTCRequestsProvider>
      </DOFRequestsProvider>
      </SkrProvider>
      </FiduciaryRequestsProvider>
      </ProjectFundingProvider>
      </PPPRequestsProvider>
      </MonetizationRequestsProvider>
      </CardRequestsProvider>
      </InstrumentRequestsProvider>
      </PaymentRequestsProvider>
      </LedgerProvider>
      </BeneficiariesProvider>
      </DemoSeedGate>
    </ActivityTracker>
    </PdfViewerProvider>
    </CurrentUserProvider>
  )
}
