import "server-only"
import { Resend } from "resend"

// The FROM domain MUST be verified in the Resend account that owns
// RESEND_API_KEY, otherwise Resend rejects the send with a 403. We reuse the
// same verified sender the activity log uses.
const FROM_EMAIL = process.env.ACTIVITY_LOG_FROM_EMAIL || "MCC Capital SWIFT <alerts@mccgva.ch>"

const SEND_TIMEOUT_MS = 8000

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

type SendResult = { ok: true; id?: string } | { ok: false; error: string }

async function send(to: string, subject: string, html: string): Promise<SendResult> {
  try {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      console.log("[v0] swift-email skipped: RESEND_API_KEY not set")
      return { ok: false, error: "missing_api_key" }
    }
    if (!to || !to.includes("@")) {
      console.log("[v0] swift-email skipped: invalid recipient", to)
      return { ok: false, error: "invalid_recipient" }
    }
    const resend = new Resend(apiKey)
    const { data, error } = await Promise.race([
      resend.emails.send({ from: FROM_EMAIL, to, subject, html }),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: `timeout after ${SEND_TIMEOUT_MS}ms` } }), SEND_TIMEOUT_MS),
      ),
    ])
    if (error) {
      console.log("[v0] swift-email send error:", JSON.stringify(error), "| to:", to)
      return { ok: false, error: "send_failed" }
    }
    console.log("[v0] swift-email sent:", data?.id ?? "(no id)", "->", to)
    return { ok: true, id: data?.id }
  } catch (err) {
    console.log("[v0] swift-email exception:", err)
    return { ok: false, error: "exception" }
  }
}

function shell(title: string, bodyRows: string, extra = ""): string {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0d;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#16161a;border:1px solid #2a2a31;border-radius:12px;overflow:hidden;">
      <div style="background:#1f1f25;padding:18px 24px;border-bottom:1px solid #2a2a31;">
        <div style="color:#e7b15a;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">MCC Capital · SWIFT</div>
        <div style="color:#f4f4f5;font-size:18px;font-weight:700;margin-top:4px;">${esc(title)}</div>
      </div>
      <div style="padding:24px;color:#d4d4d8;font-size:14px;line-height:1.6;">
        <table style="width:100%;border-collapse:collapse;">${bodyRows}</table>
        ${extra}
      </div>
      <div style="padding:14px 24px;border-top:1px solid #2a2a31;color:#71717a;font-size:11px;">
        This is an automated message from the MCC Capital treasury platform.
      </div>
    </div>
  </body></html>`
}

function row(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 0;color:#a1a1aa;width:160px;vertical-align:top;">${esc(label)}</td>
    <td style="padding:6px 0;color:#f4f4f5;font-weight:600;">${esc(value)}</td>
  </tr>`
}

export interface SwiftEmailInfo {
  messageType: string
  messageName: string
  uetr: string
  reference: string | null
  amount: string | null
  currency: string | null
  senderBic: string
  receiverBic: string
}

/** Sent to the client immediately when they submit a SWIFT message for routing. */
export async function sendSwiftSubmittedEmail(to: string, info: SwiftEmailInfo): Promise<SendResult> {
  const amount = info.amount ? `${info.currency ?? ""} ${info.amount}`.trim() : "—"
  const html = shell(
    "Message submitted for routing",
    row("Message type", `${info.messageType} · ${info.messageName}`) +
      row("UETR", info.uetr) +
      (info.reference ? row("Reference", info.reference) : "") +
      row("Amount", amount) +
      row("Sender BIC", info.senderBic) +
      row("Status", "Pending administrator approval"),
    `<p style="margin:18px 0 0;color:#a1a1aa;">Your SWIFT ${esc(info.messageType)} has been generated and submitted. An administrator will review it and route it to the designated beneficiary. You will see the outcome reflected in your SWIFT message log.</p>`,
  )
  return send(to, `[MCC SWIFT] ${info.messageType} submitted for routing — ${info.uetr.slice(0, 13)}…`, html)
}

/** A professional, bank-style row for the FIN transmission advice (light theme). */
function finRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:7px 12px;border:1px solid #d5dde5;background:#f4f7fa;color:#465a70;width:210px;font-size:12px;font-weight:600;vertical-align:top;">${esc(label)}</td>
    <td style="padding:7px 12px;border:1px solid #d5dde5;color:#0a2540;font-size:13px;font-family:'SF Mono',Menlo,Consolas,monospace;word-break:break-word;">${esc(value)}</td>
  </tr>`
}

/**
 * Sent to the routed recipient (a platform beneficiary OR an external
 * non-customer email) when an administrator approves & routes the message.
 *
 * Rendered as a professional SWIFT FIN transmission advice — clearly labelled a
 * system-generated copy for information. It deliberately does NOT fabricate
 * network authentication (ACK/MAC/PKI trailers, session/sequence numbers) so it
 * cannot be misrepresented as a network-authenticated proof of payment.
 */
export async function sendSwiftRoutedEmail(
  to: string,
  beneficiaryName: string,
  info: SwiftEmailInfo,
  rawFin: string,
): Promise<SendResult> {
  const amount = info.amount ? `${info.currency ?? ""} ${info.amount}`.trim() : "—"
  const mtNumber = info.messageType.replace(/^MT/i, "").trim()
  const sentAt = new Date().toUTCString()

  const details =
    finRow("Message Type", `MT${mtNumber} — ${info.messageName}`) +
    finRow("Sender (BIC)", info.senderBic || "—") +
    finRow("Receiver (BIC)", info.receiverBic || "—") +
    (info.reference ? finRow("Transaction Ref (:20:)", info.reference) : "") +
    finRow("Value / Amount (:32A:)", amount) +
    finRow("UETR (:121:)", info.uetr) +
    finRow("Priority", "Normal") +
    finRow("Delivery", "Delivery Notification — Routed") +
    finRow("Routed To", `${beneficiaryName || "Beneficiary"} <${to}>`) +
    finRow("Transmission (UTC)", sentAt)

  const html = `<!doctype html><html><body style="margin:0;background:#eef1f5;padding:24px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #cbd5e1;border-radius:6px;overflow:hidden;">
      <div style="background:#0a2540;padding:20px 28px;">
        <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.03em;">MCC CAPITAL</div>
        <div style="color:#8fb4d9;font-size:11px;letter-spacing:.16em;text-transform:uppercase;margin-top:3px;">SWIFT FIN · Financial Messaging</div>
      </div>
      <div style="background:#f1f5f9;border-bottom:1px solid #cbd5e1;padding:12px 28px;">
        <span style="display:inline-block;background:#0a2540;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.1em;padding:4px 10px;border-radius:3px;">SWIFT MESSAGE — TRANSMISSION COPY</span>
        <span style="color:#465a70;font-size:12px;margin-left:10px;">MT${esc(mtNumber)}</span>
      </div>
      <div style="padding:24px 28px;color:#0a2540;font-size:14px;line-height:1.6;">
        <p style="margin:0 0 16px;color:#334155;">Dear ${esc(beneficiaryName || "Beneficiary")},</p>
        <p style="margin:0 0 18px;color:#334155;">A SWIFT <strong>MT${esc(mtNumber)} (${esc(info.messageName)})</strong> has been routed to you by MCC Capital. The transmission header and full FIN body are reproduced below.</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">${details}</table>
        <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#465a70;margin-bottom:8px;">FIN Message Text (Block 4)</div>
        <pre style="margin:0;padding:16px;background:#0a2540;border:1px solid #0a2540;border-radius:6px;color:#e6edf5;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;">${esc(rawFin)}</pre>
      </div>
      <div style="padding:16px 28px;border-top:1px solid #cbd5e1;background:#f8fafc;color:#64748b;font-size:11px;line-height:1.5;">
        This is a system-generated SWIFT FIN copy transmitted for information by the MCC Capital treasury platform. It is a reproduction of the composed message and is not a network-authenticated confirmation or proof of settlement. UETR ${esc(info.uetr)}.
      </div>
    </div>
  </body></html>`

  return send(to, `SWIFT MT${mtNumber} — Transmission Copy · ${info.senderBic} → ${info.receiverBic || "—"} · ${info.uetr.slice(0, 8)}`, html)
}
