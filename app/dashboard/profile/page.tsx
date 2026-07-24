"use client"

import { BadgeCheck, FileText, ExternalLink } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ProfileAvatarEditor } from "@/components/dashboard/profile-avatar-editor"
import { FaceIdManager } from "@/components/dashboard/face-id-manager"
import { LinkedAccountsCard, SharedEnvironmentBanner } from "@/components/dashboard/linked-accounts-card"
import { Separator } from "@/components/ui/separator"
import { useCurrentUser } from "@/lib/use-current-user"
import { KYC_DOCUMENT_LABELS, blobFileUrl } from "@/lib/kyc-types"

function InfoList({ items }: { items: { label: string; value: string; icon: React.ElementType }[] }) {
  return (
    <div className="space-y-4">
      {items.map((item, i) => (
        <div key={item.label}>
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
              <item.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="text-sm font-medium text-foreground break-words">{item.value}</p>
            </div>
          </div>
          {i < items.length - 1 && <Separator className="mt-4" />}
        </div>
      ))}
    </div>
  )
}

export default function ProfilePage() {
  const user = useCurrentUser()
  const principal = user.principal
  const company = user.companyInfo
  const banking = user.banking
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Client information and account holder details
        </p>
      </div>

      {/* Identity header */}
      <Card>
        <CardContent className="flex flex-col sm:flex-row sm:items-center gap-4 pt-6">
          <ProfileAvatarEditor />
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-foreground">{user.fullName}</h2>
              <Badge variant="outline" className="gap-1">
                <BadgeCheck className="h-3 w-3" /> Verified
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{user.role} · {user.company}</p>
            <p className="text-xs text-muted-foreground">{user.accountEmail}</p>
          </div>
          <Badge className="bg-primary text-primary-foreground self-start sm:self-center">{user.accountBadge}</Badge>
        </CardContent>
      </Card>

      {/* Shown only to Joint (J) holders: they share their Master's environment. */}
      <SharedEnvironmentBanner />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Principal */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Principal</CardTitle>
            <CardDescription>Account holder identity</CardDescription>
          </CardHeader>
          <CardContent>
            <InfoList items={principal} />
          </CardContent>
        </Card>

        {/* Holding Company */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Holding Company</CardTitle>
            <CardDescription>Registered entity & tax details</CardDescription>
          </CardHeader>
          <CardContent>
            <InfoList items={company} />
          </CardContent>
        </Card>
      </div>

      {/* Banking */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Banking</CardTitle>
          <CardDescription>Primary business account</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {banking.map((item) => (
              <div key={item.label} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <item.icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-sm font-medium text-foreground break-words">{item.value}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Linked / Joint accounts — shown only to Master accounts. */}
      <LinkedAccountsCard />

      {/* Security — Face ID */}
      <FaceIdManager />

      {/* Identity Document */}
      {user.passportMeta && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identity Document</CardTitle>
            <CardDescription>Passport on file — {user.passportMeta.country}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4">
              {user.passportImage && (
                <img
                  src={user.passportImage || "/placeholder.svg"}
                  alt={`Passport copy of ${user.fullName}`}
                  className="w-full sm:w-64 rounded-lg border border-border object-contain"
                />
              )}
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="gap-1">
                    <BadgeCheck className="h-3 w-3" /> Document verified
                  </Badge>
                </div>
                <p className="text-muted-foreground">Type: <span className="text-foreground font-medium">{user.passportMeta.type}</span></p>
                <p className="text-muted-foreground">Passport No.: <span className="text-foreground font-medium">{user.passportMeta.passportNo}</span></p>
                <p className="text-muted-foreground">Surname: <span className="text-foreground font-medium">{user.passportMeta.surname}</span></p>
                <p className="text-muted-foreground">Given Names: <span className="text-foreground font-medium">{user.passportMeta.givenNames}</span></p>
                <p className="text-muted-foreground">Valid until: <span className="text-foreground font-medium">{user.passportMeta.validUntil}</span></p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KYC Documents */}
      {user.kycDocuments && user.kycDocuments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">KYC Documents</CardTitle>
            <CardDescription>Identity and compliance documents on file</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {user.kycDocuments.map((doc) => (
                <a
                  key={`${doc.type}-${doc.pageNumber}`}
                  href={`${blobFileUrl(doc.pathname)}#page=${doc.pageNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 p-3 transition-colors hover:border-primary"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {KYC_DOCUMENT_LABELS[doc.type]}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {doc.label} · Page {doc.pageNumber}
                      </p>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
