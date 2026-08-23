import { redirect } from "next/navigation"
import { getMyIdentity } from "@/app/actions/admin-users"
import { getVisitorLink } from "@/lib/visitor-link-db"
import { LinkedAccountShell } from "@/components/dashboard/linked-account-shell"
import { DashboardSidebar } from "@/components/dashboard/sidebar"
import { DashboardHeader } from "@/components/dashboard/header"
import { MarketTicker } from "@/components/dashboard/market-ticker"
import { BackToTop } from "@/components/dashboard/back-to-top"
import { VisitorReadOnlyBanner } from "@/components/dashboard/visitor-readonly-banner"
import { SectionGate } from "@/components/dashboard/section-gate"
import { PinchZoom } from "@/components/pinch-zoom"
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
import { MonetizationInterestReconciler } from "@/components/monetization-interest-reconciler"
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
import { InternalLoanProvider } from "@/lib/internal-loan-store"
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

  // A VISITOR linked to another user's sub-account is CONFINED to a single
  // restricted view of that one compartment — no sidebar, no other dashboard
  // sections, no shared providers. Whatever /dashboard/* route they navigate to
  // renders only their linked sub-account. This is the authoritative gate; the
  // link is resolved fresh per request from the server session.
  const visitorLink = await getVisitorLink(identity.id)
  if (visitorLink) {
    const displayName =
      (identity.kind === "dynamic" && (identity.profile.fullName || identity.profile.company)) || "there"
    return <LinkedAccountShell displayName={displayName} />
  }

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
      <InternalLoanProvider>
      <GatewayProvider>
      <SessionGuard />
      <PointerEventsGuard />
      <FundingCapitalReconciler />
      <TreasuryFinancingReconciler />
      <LeverageInterestReconciler />
      <MonetizationInterestReconciler />
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
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <DashboardHeader />
            <MarketTicker />
            <main className="flex-1 overflow-hidden">
              <PinchZoom>
                <div className="p-4 pb-24 md:p-6 md:pb-24">
                  <VisitorReadOnlyBanner />
                  <SectionGate>{children}</SectionGate>
                </div>
              </PinchZoom>
            </main>
          </div>
          <BackToTop />
        </div>
      </div>
      </GatewayProvider>
      </InternalLoanProvider>
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
