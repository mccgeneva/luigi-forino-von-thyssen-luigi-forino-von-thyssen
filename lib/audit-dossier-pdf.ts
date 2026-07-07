// ---------------------------------------------------------------------------
// KYC & Activity dossier — client-side PDF builder.
//
// Produces a self-contained, print-ready dossier for an account that an
// administrator can hand to authorities: full identity on file (including the
// unmasked passport number), the retained passport image and the login selfie,
// summary statistics, geolocated IPs, devices, and the COMPLETE activity log.
//
// Uses jsPDF (already the app's standard export engine) and returns a jsPDF doc
// so it can be shown in the shared <PdfPreviewModal> (preview / download / print).
// ---------------------------------------------------------------------------

import { jsPDF } from "jspdf"
import { ADMIN_PASSCODE } from "@/lib/admin-config"
import type { UserAuditReport } from "@/lib/security-audit-service"
import {
  blobFileUrl,
  type UploadedKycDocument,
  type DossierAnalysis,
  type DocComplianceAnalysis,
  type KycRiskLevel,
} from "@/lib/kyc-types"

/** Human-readable file size for the dossier document list. */
function fmtSize(bytes: number): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface LoadedImage {
  dataUrl: string
  width: number
  height: number
}

/**
 * Fetch a (session-gated, same-origin) image URL and decode it to a JPEG data
 * URL plus its natural dimensions. Returns null on any failure so a missing
 * image never blocks the dossier.
 */
async function loadImage(url: string | null): Promise<LoadedImage | null> {
  if (!url) return null
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "include" })
    if (!res.ok) return null
    const blob = await res.blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.9), width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}

function fmt(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Build the dossier PDF for a report. Loads images first, then lays out pages. */
export async function buildDossierDoc(report: UserAuditReport, analysis?: DossierAnalysis | null): Promise<jsPDF> {
  const [passport, selfie] = await Promise.all([
    loadImage(report.passportImageUrl),
    loadImage(report.selfie.url),
  ])

  // Per-document analysis, keyed by document id (the retained passport image is
  // keyed "passport-image").
  const analysisById = new Map<string, DocComplianceAnalysis>()
  for (const a of analysis?.documents ?? []) analysisById.set(a.docId, a)

  // Preload EVERY image-type uploaded document (no cap) so the full pack is
  // embedded. Non-image docs (PDFs) are noted with metadata + their AI analysis,
  // since the vision model reads PDF content directly into the report.
  const documents = report.documents ?? []
  const imageDocs = documents.filter((d) => d.isImage)
  const loadedDocImages = new Map<string, LoadedImage>()
  await Promise.all(
    imageDocs.map(async (d) => {
      const img = await loadImage(blobFileUrl(d.pathname, ADMIN_PASSCODE))
      if (img) loadedDocImages.set(d.id, img)
    }),
  )

  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const PAGE_W = 210
  const PAGE_H = 297
  const M = 14 // margin
  const CW = PAGE_W - M * 2 // content width
  let y = M

  // --- theme colors (kept minimal) ---
  const ink: [number, number, number] = [23, 23, 23]
  const muted: [number, number, number] = [110, 110, 110]
  const accent: [number, number, number] = [15, 82, 66] // deep green
  const line: [number, number, number] = [220, 220, 220]

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - M) {
      doc.addPage()
      y = M
    }
  }

  const sectionTitle = (label: string) => {
    ensureSpace(12)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(...accent)
    doc.text(label.toUpperCase(), M, y)
    y += 2
    doc.setDrawColor(...accent)
    doc.setLineWidth(0.4)
    doc.line(M, y, M + CW, y)
    y += 5
  }

  const kv = (label: string, value: string, colX: number, colW: number) => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(...muted)
    doc.text(label.toUpperCase(), colX, y)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9.5)
    doc.setTextColor(...ink)
    const lines = doc.splitTextToSize(value || "—", colW)
    doc.text(lines, colX, y + 4)
    return 4 + lines.length * 4
  }

  const riskColor = (level: KycRiskLevel): [number, number, number] => {
    if (level === "high") return [176, 42, 42] // red
    if (level === "medium") return [176, 116, 20] // amber
    return [15, 110, 70] // green
  }

  // Wrapped paragraph in the current text style; advances y.
  const paragraph = (text: string, size = 8.5, color: [number, number, number] = ink, indent = 0) => {
    if (!text) return
    doc.setFont("helvetica", "normal")
    doc.setFontSize(size)
    doc.setTextColor(...color)
    const lines = doc.splitTextToSize(text, CW - indent)
    for (const ln of lines) {
      ensureSpace(size * 0.5)
      doc.text(ln, M + indent, y)
      y += size * 0.48 + 1
    }
  }

  // A coloured pill (used for risk / completeness chips).
  const pill = (label: string, x: number, fill: [number, number, number]) => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    const w = doc.getTextWidth(label) + 6
    doc.setFillColor(...fill)
    doc.roundedRect(x, y - 3.4, w, 5, 1, 1, "F")
    doc.setTextColor(255, 255, 255)
    doc.text(label, x + 3, y)
    return w
  }

  // A small bulleted list; advances y.
  const bulletList = (items: string[], size = 8.5, color: [number, number, number] = ink) => {
    for (const it of items) {
      if (!it) continue
      doc.setFont("helvetica", "normal")
      doc.setFontSize(size)
      doc.setTextColor(...color)
      const lines = doc.splitTextToSize(it, CW - 5)
      ensureSpace(lines.length * (size * 0.48 + 1))
      doc.text("•", M, y)
      for (let i = 0; i < lines.length; i++) {
        doc.text(lines[i], M + 4, y)
        y += size * 0.48 + 1
      }
    }
  }

  // ===== Header banner =====
  doc.setFillColor(...accent)
  doc.rect(0, 0, PAGE_W, 26, "F")
  doc.setTextColor(255, 255, 255)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(14)
  doc.text("KYC & ACTIVITY DOSSIER", M, 12)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.text("NAFTAhub · NQAi Neural Quantum Artificial Intelligence — Confidential", M, 18)
  doc.text(`Generated ${fmt(new Date().toISOString())}`, M, 22.5)
  y = 34

  // ===== Subject line =====
  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.setTextColor(...ink)
  const acct = doc.splitTextToSize(report.account || report.userId, CW)
  doc.text(acct, M, y)
  y += acct.length * 6 + 1
  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text(`Account ID: ${report.userId}`, M, y)
  y += 7

  // ===== Identity =====
  sectionTitle("Identity on file")
  const colW = (CW - 8) / 2
  const c1 = M
  const c2 = M + colW + 8
  const startY = y
  const h1 = kv("Full name", report.identity.fullName || report.account || "—", c1, colW)
  const h2 = kv("Nationality / country", report.identity.country || "—", c2, colW)
  y = startY + Math.max(h1, h2) + 3
  const startY2 = y
  const h3 = kv("Passport / document number", report.passportNo || (report.identity.passportLast4 ? `•••• ${report.identity.passportLast4}` : "—"), c1, colW)
  const h4 = kv("Identity verification", report.identity.verified ? `Verified · ${fmt(report.identity.verifiedAt)}` : "Not verified", c2, colW)
  y = startY2 + Math.max(h3, h4) + 6

  // ===== Biometric documents (passport + selfie) =====
  sectionTitle("Biometric documents")
  const imgBoxW = (CW - 8) / 2
  const imgBoxH = 55
  ensureSpace(imgBoxH + 10)
  const drawImageBox = (x: number, label: string, img: LoadedImage | null, placeholder: string) => {
    doc.setDrawColor(...line)
    doc.setLineWidth(0.3)
    doc.roundedRect(x, y, imgBoxW, imgBoxH, 1.5, 1.5, "S")
    if (img) {
      // Fit while preserving aspect ratio, inside a small inset.
      const pad = 2
      const maxW = imgBoxW - pad * 2
      const maxH = imgBoxH - pad * 2
      const ratio = Math.min(maxW / img.width, maxH / img.height)
      const w = img.width * ratio
      const h = img.height * ratio
      doc.addImage(img.dataUrl, "JPEG", x + (imgBoxW - w) / 2, y + (imgBoxH - h) / 2, w, h)
    } else {
      doc.setFont("helvetica", "italic")
      doc.setFontSize(8)
      doc.setTextColor(...muted)
      doc.text(placeholder, x + imgBoxW / 2, y + imgBoxH / 2, { align: "center" })
    }
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    doc.setTextColor(...muted)
    doc.text(label.toUpperCase(), x, y + imgBoxH + 4)
  }
  drawImageBox(M, "Passport / ID document", passport, "No passport image retained")
  drawImageBox(M + imgBoxW + 8, `Login selfie · ${fmt(report.selfie.at)}`, selfie, "No login selfie captured")
  y += imgBoxH + 10

  // ===== AI KYC analysis (overall verdict) =====
  const verdict = analysis?.verdict ?? null
  if (analysis) {
    sectionTitle("AI KYC analysis")
    if (verdict) {
      // Verdict chips: completeness + overall risk.
      ensureSpace(8)
      const completenessLabel = verdict.completeness.toUpperCase()
      const completenessFill: [number, number, number] =
        verdict.completeness === "complete"
          ? [15, 110, 70]
          : verdict.completeness === "partial"
            ? [176, 116, 20]
            : [176, 42, 42]
      let px = M
      px += pill(`FILE: ${completenessLabel}`, px, completenessFill) + 3
      pill(`RISK: ${verdict.overallRisk.toUpperCase()}`, px, riskColor(verdict.overallRisk))
      y += 6

      if (verdict.narrative) {
        paragraph(verdict.narrative, 8.5, ink)
        y += 1
      }
      if (verdict.presentDocumentTypes.length) {
        ensureSpace(6)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(...muted)
        doc.text("DOCUMENTS PRESENT", M, y)
        y += 4
        paragraph(verdict.presentDocumentTypes.join(" · "), 8.5, ink)
        y += 1
      }
      if (verdict.missingRecommended.length) {
        ensureSpace(6)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(...muted)
        doc.text("RECOMMENDED / MISSING", M, y)
        y += 4
        bulletList(verdict.missingRecommended, 8.5, [150, 90, 20])
        y += 1
      }
      if (verdict.keyFindings.length) {
        ensureSpace(6)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(...muted)
        doc.text("KEY FINDINGS", M, y)
        y += 4
        bulletList(verdict.keyFindings, 8.5, ink)
        y += 1
      }
      if (verdict.redFlags.length) {
        ensureSpace(6)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(176, 42, 42)
        doc.text("RED FLAGS", M, y)
        y += 4
        bulletList(verdict.redFlags, 8.5, [176, 42, 42])
        y += 1
      }
    } else {
      paragraph(
        "Per-document analysis is included below; an overall verdict could not be generated automatically.",
        8.5,
        muted,
      )
    }
    doc.setFont("helvetica", "italic")
    doc.setFontSize(7)
    doc.setTextColor(150, 150, 150)
    ensureSpace(6)
    doc.text(
      `AI-assisted analysis generated ${fmt(analysis.analyzedAt)}. Machine-generated; not a licensed authenticity attestation. Review before reliance.`,
      M,
      y,
    )
    y += 6
  }

  // ===== Uploaded KYC documents =====
  sectionTitle(`KYC documents on file (${documents.length})`)
  if (documents.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text("No KYC documents uploaded.", M, y)
    y += 8
  } else {
    // 1) Embed image documents in a 2-column grid of image boxes.
    const embedded = documents.filter((d) => loadedDocImages.has(d.id))
    for (let i = 0; i < embedded.length; i += 2) {
      ensureSpace(imgBoxH + 8)
      const left = embedded[i]
      const right = embedded[i + 1]
      drawImageBox(M, `${left.label} · ${left.filename}`, loadedDocImages.get(left.id) ?? null, "Image unavailable")
      if (right) {
        drawImageBox(
          M + imgBoxW + 8,
          `${right.label} · ${right.filename}`,
          loadedDocImages.get(right.id) ?? null,
          "Image unavailable",
        )
      }
      y += imgBoxH + 8
    }

    // 2) List EVERY document with metadata (type, filename, size, uploader, date).
    for (const d of documents) {
      ensureSpace(9)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9)
      doc.setTextColor(...ink)
      const title = doc.splitTextToSize(`${d.label} — ${d.filename || "document"}`, CW)
      doc.text(title, M, y)
      y += title.length * 4
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7.5)
      doc.setTextColor(...muted)
      const meta = `${d.isImage ? "Image" : d.contentType || "File"} · ${fmtSize(d.sizeBytes)} · uploaded by ${d.uploadedBy} · ${fmt(d.createdAt)}`
      doc.text(doc.splitTextToSize(meta, CW), M, y)
      y += 4

      // Per-document AI analysis (when the report was generated with analysis).
      const da = analysisById.get(d.id)
      if (da) {
        ensureSpace(6)
        // Detected type + risk chip on one line.
        doc.setFont("helvetica", "bold")
        doc.setFontSize(7.5)
        doc.setTextColor(...ink)
        doc.text(`Detected: ${da.detectedType || "—"}`, M, y)
        pill(`RISK: ${da.riskLevel.toUpperCase()}`, M + CW - 24, riskColor(da.riskLevel))
        y += 4
        if (da.error) {
          paragraph(`Not analysed automatically: ${da.error}`, 7.5, [176, 42, 42])
        } else {
          if (da.summary) paragraph(da.summary, 7.8, ink)
          const keyBits = [
            da.personName ? `Name: ${da.personName}` : "",
            da.documentNumber ? `No.: ${da.documentNumber}` : "",
            da.issuingAuthority ? `Issuer: ${da.issuingAuthority}` : "",
            da.issueDate ? `Issued: ${da.issueDate}` : "",
            da.expiryDate ? `Expires: ${da.expiryDate}` : "",
          ].filter(Boolean)
          if (keyBits.length) paragraph(keyBits.join("  ·  "), 7.5, muted)
          for (const f of da.extractedFields) {
            if (f.label || f.value) paragraph(`${f.label}: ${f.value}`, 7.3, muted, 4)
          }
          if (da.consistencyNotes) paragraph(`Consistency: ${da.consistencyNotes}`, 7.5, ink)
          if (da.redFlags.length) {
            doc.setFont("helvetica", "bold")
            doc.setFontSize(7.3)
            doc.setTextColor(176, 42, 42)
            ensureSpace(4)
            doc.text("Red flags:", M, y)
            y += 3.4
            bulletList(da.redFlags, 7.3, [176, 42, 42])
          }
        }
        y += 1
      }

      doc.setTextColor(150, 150, 150)
      doc.setFontSize(7)
      ensureSpace(4)
      doc.text("Original file retained securely; accessible to authorised administrators via NAFTAhub.", M, y)
      y += 3
      doc.setDrawColor(...line)
      doc.setLineWidth(0.15)
      doc.line(M, y + 0.5, M + CW, y + 0.5)
      y += 3.5
    }
    y += 2
  }

  // ===== Summary statistics =====
  sectionTitle("Activity summary")
  const stats: [string, string | number][] = [
    ["Total events", report.stats.eventCount],
    ["Successful logins", report.stats.loginCount],
    ["Failed logins", report.stats.failedLoginCount],
    ["Distinct devices", report.stats.distinctDeviceCount],
    ["Distinct IPs", report.stats.distinctIpCount],
    ["First seen", report.stats.firstSeen ? fmt(report.stats.firstSeen) : "—"],
    ["Last seen", report.stats.lastSeen ? fmt(report.stats.lastSeen) : "—"],
  ]
  const perRow = 3
  const cellW = (CW - (perRow - 1) * 4) / perRow
  const cellH = 13
  let col = 0
  ensureSpace(cellH)
  let rowY = y
  for (const [label, value] of stats) {
    const x = M + col * (cellW + 4)
    doc.setDrawColor(...line)
    doc.setFillColor(248, 248, 248)
    doc.roundedRect(x, rowY, cellW, cellH, 1, 1, "FD")
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7)
    doc.setTextColor(...muted)
    doc.text(label.toUpperCase(), x + 2.5, rowY + 4.5)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(...ink)
    doc.text(String(value), x + 2.5, rowY + 10)
    col++
    if (col >= perRow) {
      col = 0
      rowY += cellH + 3
      if (rowY + cellH > PAGE_H - M) {
        doc.addPage()
        rowY = M
      }
    }
  }
  y = (col === 0 ? rowY : rowY + cellH + 3) + 4

  // ===== Locations & IPs =====
  sectionTitle("Locations & IP addresses")
  if (report.locations.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text("No IP addresses recorded.", M, y)
    y += 8
  } else {
    for (const loc of report.locations) {
      ensureSpace(10)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9)
      doc.setTextColor(...ink)
      doc.text(loc.ip, M, y)
      const where = loc.isPrivate
        ? "Private / local network"
        : [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Location unknown"
      const coords = loc.latitude != null && loc.longitude != null ? `  (${loc.latitude}, ${loc.longitude})` : ""
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...muted)
      const detail = doc.splitTextToSize(`${where}${loc.isp ? ` · ${loc.isp}` : ""}${coords}`, CW - 40)
      doc.text(detail, M + 38, y)
      y += Math.max(detail.length * 4, 5) + 2
    }
    y += 2
  }

  // ===== Devices =====
  sectionTitle("Devices")
  if (report.devices.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text("No devices recorded.", M, y)
    y += 8
  } else {
    for (const d of report.devices) {
      ensureSpace(9)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(9)
      doc.setTextColor(...ink)
      doc.text([d.browser, d.os].filter(Boolean).join(" · ") || "Unknown device", M, y)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...muted)
      doc.text(
        `${d.deviceType || "—"} · ${d.ipAddress || "—"} · last seen ${fmt(d.lastSeen)} · ${d.eventCount} events`,
        M,
        y + 4,
      )
      y += 9
    }
    y += 2
  }

  // ===== Full activity timeline =====
  sectionTitle(`Complete activity log (${report.events.length} events)`)
  if (report.events.length === 0) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text("No events recorded.", M, y)
    y += 8
  } else {
    for (const e of report.events) {
      const detailStr =
        e.details && Object.keys(e.details).length > 0
          ? Object.entries(e.details)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")
          : ""
      const meta = [fmt(e.createdAt), e.ipAddress, [e.browser, e.os].filter(Boolean).join(" "), e.path]
        .filter(Boolean)
        .join(" · ")
      const actionLines = doc.splitTextToSize(`${e.action}  [${e.category || "General"}]`, CW)
      const metaLines = doc.splitTextToSize(meta, CW)
      const detailLines = detailStr ? doc.splitTextToSize(detailStr, CW) : []
      const blockH = actionLines.length * 4 + metaLines.length * 3.5 + detailLines.length * 3.5 + 4
      ensureSpace(blockH)
      doc.setFont("helvetica", "bold")
      doc.setFontSize(8.5)
      doc.setTextColor(...ink)
      doc.text(actionLines, M, y)
      y += actionLines.length * 4
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7.5)
      doc.setTextColor(...muted)
      doc.text(metaLines, M, y)
      y += metaLines.length * 3.5
      if (detailLines.length) {
        doc.setTextColor(150, 150, 150)
        doc.text(detailLines, M, y)
        y += detailLines.length * 3.5
      }
      doc.setDrawColor(...line)
      doc.setLineWidth(0.15)
      doc.line(M, y + 0.5, M + CW, y + 0.5)
      y += 3
    }
  }

  // ===== Footer on every page =====
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setDrawColor(...line)
    doc.setLineWidth(0.2)
    doc.line(M, PAGE_H - 10, PAGE_W - M, PAGE_H - 10)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7)
    doc.setTextColor(...muted)
    doc.text("CONFIDENTIAL — generated by NAFTAhub for the account controller.", M, PAGE_H - 6)
    doc.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 6, { align: "right" })
  }

  return doc
}
