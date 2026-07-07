import { Resend } from "resend"

// PRODUCTION — mccgva.ch domain is verified in Resend, so logs send to the trader desk.
// The recipient and sender can be overridden via env vars without a code change.
// NOTE: the FROM domain MUST be a domain verified in the Resend account that owns
// RESEND_API_KEY, otherwise Resend rejects the send with a 403.
const TRADER_EMAIL = process.env.ACTIVITY_LOG_TO_EMAIL || "Trader@mccgva.ch"
const FROM_EMAIL =
  process.env.ACTIVITY_LOG_FROM_EMAIL || "MCC Capital Activity Log <alerts@mccgva.ch>"

export type ActivityLog = {
  action: string
  category: string
  details?: Record<string, string | number | boolean | null | undefined>
  path?: string
  user?: string
  /**
   * Optional stable account id. Set by server callers that already know WHO the
   * event belongs to (e.g. the login flow). When absent, the persistence layer
   * resolves it from the session cookie. Never trusted from raw client input for
   * anything security-sensitive — it only groups events in the audit trail.
   */
  userId?: string
  /**
   * Optional URL of a login selfie image (in Blob storage) associated with this
   * event. Only set for biometric login events by the server.
   */
  selfieUrl?: string
}

// --- Email throttling ---------------------------------------------------
// We only email the trader desk for meaningful, important events:
//   • Login / Logout and any security event
//   • System errors / failures / declines
//   • Successful bank operations (payments, beneficiaries, instruments, FX, etc.)
//   • Other critical business requests
// Pure navigation and read-only/UI noise (viewing, exporting, copying, toggling
// settings, refreshing, draft saving) are intentionally NOT emailed.

// Routine authentication events that should NEVER be emailed to the trader desk.
// These are matched FIRST, before any always-email/security rule, so the desk
// is no longer notified on every sign-in or sign-out. Security-relevant auth
// events ("Login failed", "Session terminated automatically") deliberately use
// different action strings and remain fully covered by ALWAYS_EMAIL_PATTERNS.
const SUPPRESS_EMAIL_PATTERNS: RegExp[] = [
  /^Login successful$/i, // a normal, successful sign-in
  /^Logout$/i, // a normal, user-initiated sign-out
]

// Security / failure / error events ALWAYS notify, regardless of anything else.
const ALWAYS_EMAIL_PATTERNS: RegExp[] = [
  /security/i,
  /\bdeclined\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /\bunauthor/i, // unauthorized / unauthorised
  /\bblocked\b/i,
  /\bsession terminated\b/i,
]

// Default-ALLOW model: every operation/transaction a user performs is emailed to
// the trader desk. Only pure, read-only UI noise is filtered out.
const NOISE_ACTION_PATTERNS: RegExp[] = [
  /^Viewed\b/i, // opened a detail view (read-only)
  /^Downloaded\b/i, // saved an on-screen document/receipt/certificate locally
  /^Exported\b/i, // exported a list already visible to CSV
  /^Copied\b/i, // copied a value to the clipboard
  /^Refreshed\b/i, // refreshed a queue/list
  /^Opened\b/i, // opened a settings/management panel
  /^Tracked\b/i, // opened SWIFT gpi tracking for a payment
  /^Saved\b.*\bdraft\b/i, // saved a draft (not yet submitted)
  /^Set a rate alert\b/i, // local FX rate alert
  /^(Enabled|Disabled) setting:/i, // toggled a local preference
  /^(Hid|Revealed) card details\b/i, // showed/hid card numbers on screen
]

// Decides whether an activity is important enough to email.
export function shouldEmail(activity: ActivityLog): boolean {
  const action = activity.action ?? ""
  const category = activity.category ?? ""

  // Routine login/logout: never email, even though "Authentication" would
  // otherwise pass the default-allow filter below.
  if (SUPPRESS_EMAIL_PATTERNS.some((re) => re.test(action))) {
    return false
  }

  if (ALWAYS_EMAIL_PATTERNS.some((re) => re.test(action) || re.test(category))) {
    return true
  }
  return !NOISE_ACTION_PATTERNS.some((re) => re.test(action))
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function buildRows(details?: ActivityLog["details"]) {
  if (!details) return ""
  return Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(
      ([key, value]) => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;text-transform:capitalize;">${escapeHtml(
            key.replace(/([A-Z])/g, " $1").trim(),
          )}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;">${escapeHtml(
            String(value),
          )}</td>
        </tr>`,
    )
    .join("")
}

function buildEmailHtml(activity: ActivityLog, ipAddress: string, timestamp: string) {
  const user = activity.user || "Jesus Santos Alvarez Fernandez (IPOSTRAD Securities SL)"
  const detailRows = buildRows(activity.details)

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;">
      <div style="background:#0f172a;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;color:#ffffff;font-size:18px;">MCC Capital — Platform Activity Log</h1>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:12px;">Automated operation report</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;width:35%;">Action</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;font-weight:600;">${escapeHtml(
              activity.action,
            )}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;">Category</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;">${escapeHtml(
              activity.category,
            )}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;">User</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;">${escapeHtml(
              user,
            )}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;">IP Address</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;font-family:monospace;">${escapeHtml(
              ipAddress,
            )}</td>
          </tr>
          ${
            activity.path
              ? `<tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;">Location</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;">${escapeHtml(
              activity.path,
            )}</td>
          </tr>`
              : ""
          }
          <tr>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;color:#374151;font-size:13px;">Timestamp</td>
            <td style="padding:8px 12px;border:1px solid #e5e7eb;color:#111827;font-size:13px;">${escapeHtml(
              timestamp,
            )} (Zurich)</td>
          </tr>
        </table>
        ${
          detailRows
            ? `<h2 style="font-size:14px;color:#374151;margin:0 0 8px;">Operation Details</h2>
        <table style="width:100%;border-collapse:collapse;">${detailRows}</table>`
            : ""
        }
      </div>
    </div>`
}

// Hard cap on the Resend network call so a slow/hanging upstream can never keep
// the (deferred) work alive indefinitely.
export const SEND_TIMEOUT_MS = 8000

/**
 * Delivers a single activity email to the trader desk. Safe to call from a
 * Route Handler or a Server Action. Honours throttling, requires RESEND_API_KEY,
 * and never throws — failures are logged and swallowed so logging can never
 * break the calling flow.
 */
export async function deliverActivityEmail(activity: ActivityLog, ipAddress: string) {
  try {
    if (!shouldEmail(activity)) {
      return { ok: true as const, skipped: true as const }
    }

    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      console.log("[v0] deliverActivityEmail skipped: RESEND_API_KEY not set")
      return { ok: false as const, error: "missing_api_key" as const }
    }

    const resend = new Resend(apiKey)
    const timestamp = new Date().toLocaleString("en-GB", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: "Europe/Zurich",
    })
    const html = buildEmailHtml(activity, ipAddress, timestamp)

    const { data, error } = await Promise.race([
      resend.emails.send({
        from: FROM_EMAIL,
        to: TRADER_EMAIL,
        subject: `[MCC Activity] ${activity.action}`,
        html,
      }),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(
          () => resolve({ data: null, error: { message: `timeout after ${SEND_TIMEOUT_MS}ms` } }),
          SEND_TIMEOUT_MS,
        ),
      ),
    ])

    if (error) {
      console.log(
        "[v0] deliverActivityEmail send error:",
        JSON.stringify(error),
        "| from:",
        FROM_EMAIL,
        "| to:",
        TRADER_EMAIL,
      )
      return { ok: false as const, error: "send_failed" as const }
    }

    console.log("[v0] deliverActivityEmail email sent:", data?.id ?? "(no id)", "->", TRADER_EMAIL)
    return { ok: true as const, id: data?.id }
  } catch (err) {
    console.log("[v0] deliverActivityEmail exception:", err)
    return { ok: false as const, error: "exception" as const }
  }
}
