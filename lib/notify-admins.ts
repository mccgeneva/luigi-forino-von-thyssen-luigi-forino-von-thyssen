import "server-only"

import { adminEmails } from "@/lib/admin-auth"
import { getDynamicUserByEmail } from "@/lib/admin-users-db"
import { insertNotification } from "@/lib/notifications-db"
import { KIND_LABELS, type ApprovalKind } from "@/lib/approval-kinds"

/**
 * Fan a bell notification out to EVERY administrator — the proprietor AND every
 * other admin — so ANY admin can see and act on a customer's request. Admins
 * are resolved from `adminEmails()` (all baseline admins + any ADMIN_EMAILS
 * extras) and mapped to their notifiable user records. Deduplicated by id, and
 * any `excludeIds` (typically the submitter and the data-owner) are skipped so
 * an admin acting on their own account is never alerted about themselves.
 *
 * Best-effort by design: a notification failure must NEVER block or fail the
 * customer's underlying submission. This is the general fix for "only the
 * president is notified when customers transact — every admin must be noticed
 * and be able to act with the customer".
 */
export async function notifyAllAdminsOfSubmission(opts: {
  customerName: string
  kind: ApprovalKind
  title: string
  amount?: number | null
  currency?: string | null
  excludeIds?: string[]
}): Promise<void> {
  try {
    const emails = adminEmails()
    const admins = await Promise.all(emails.map((e) => getDynamicUserByEmail(e).catch(() => undefined)))
    const excluded = new Set((opts.excludeIds ?? []).filter(Boolean))
    const seen = new Set<string>()
    const label = KIND_LABELS[opts.kind] ?? "request"
    const amountStr =
      opts.amount && opts.amount > 0 && opts.currency
        ? ` (${opts.currency} ${opts.amount.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })})`
        : ""
    await Promise.all(
      admins
        .filter(
          (a): a is NonNullable<typeof a> =>
            !!a && !excluded.has(a.id) && !seen.has(a.id) && (seen.add(a.id), true),
        )
        .map((admin) =>
          insertNotification({
            userId: admin.id,
            tone: "warning",
            title: `New ${label} needs review`,
            body: `${opts.customerName} submitted a ${label.toLowerCase()} ("${opts.title}")${amountStr} that is pending administrator review. Open the Administrator panel to review and action it.`,
            href: "/dashboard/admin",
          }).catch(() => undefined),
        ),
    )
  } catch {
    // Admin notification is best-effort — never affect the customer's submission.
  }
}
