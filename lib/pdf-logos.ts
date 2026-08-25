// Centralised brand-logo system for every generated PDF (NQAi documents,
// statements, receipts, certificates, instruments, funding docs, …).
//
// Three official marks are placed depending on the document context:
//   - "capital"  → MCC Capital   (banking / trade / general platform docs)
//   - "petroli"  → MCC Petroli   (oil, gas, petroleum, crude, diesel deals)
//   - "naftahub" → NAFTAhub      (platform onboarding / handbook / product)
//
// jsPDF's addImage needs raster data synchronously, so we warm an in-memory
// data-URL cache once (from the dashboard layout / PDF viewer provider) and the
// generators read from it synchronously via getPdfLogo(). If the cache is cold
// (logo not yet fetched) drawBrandMark() falls back to the classic gold "M"
// badge, so nothing ever breaks.

import type { jsPDF } from "jspdf"
import { BRAND } from "@/lib/pdf-core"

export type PdfBrand = "capital" | "petroli" | "naftahub" | "fco"

interface LogoEntry {
  dataUrl: string
  width: number
  height: number
}

const LOGO_SRC: Record<PdfBrand, string> = {
  capital: "/logos/mcc-capital.jpeg",
  petroli: "/logos/mcc-petroli.jpeg",
  naftahub: "/logos/naftahub.jpeg",
  fco: "/logos/fco.jpeg",
}

/** Display name + tagline for each brand, used for the letterhead text. */
export const BRAND_LABELS: Record<PdfBrand, { name: string; tagline: string }> = {
  capital: { name: "MCC Capital", tagline: "MCC Banking & Trade Platform" },
  petroli: { name: "MCC Petroli", tagline: "Arabian Emirates Crude Oil" },
  naftahub: { name: "NAFTAhub", tagline: "Global Commodity Trade Platform" },
  fco: { name: "NAFTAhub", tagline: "Full Corporate Offer" },
}

const cache = new Map<PdfBrand, LogoEntry>()
let warming: Promise<void> | null = null

// Load one logo, downscale it to a sane max edge (keeps the embedded PDF small —
// the raw MCC Petroli artwork is ~9k px wide), and cache it as a JPEG data URL
// on a white matte (the source art already sits on white, so panels blend).
async function loadOne(brand: PdfBrand, maxEdge = 1200): Promise<void> {
  if (cache.has(brand)) return
  const res = await fetch(LOGO_SRC[brand])
  if (!res.ok) throw new Error(`logo fetch ${brand} ${res.status}`)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  cache.set(brand, { dataUrl: canvas.toDataURL("image/jpeg", 0.92), width: w, height: h })
}

/** Fetch + cache all three logos. Idempotent; safe to call on every mount. */
export async function warmPdfLogos(): Promise<void> {
  if (warming) return warming
  warming = (async () => {
    await Promise.all(
      (Object.keys(LOGO_SRC) as PdfBrand[]).map((b) =>
        loadOne(b).catch((err) => {
          console.log("[v0] pdf logo warm failed:", b, err instanceof Error ? err.message : String(err))
        }),
      ),
    )
  })()
  return warming
}

export function getPdfLogo(brand: PdfBrand): LogoEntry | null {
  return cache.get(brand) ?? null
}

const OIL_RE =
  /\b(oil|gas|petrol|petroleum|crude|diesel|en\s?590|jet\s?fuel|jp\s?54|d[26]\b|gasoil|fuel|bunker|barrel|bbl|refinery|refined|hydrocarbon|lng|lpg|naphtha|kerosene|bitumen|mazut|fco|icpo|cargo lift|dip test|tank storage)\b/i
const NAFTAHUB_RE = /\b(naftahub|onboarding|client handbook|platform guide|welcome pack)\b/i

/**
 * Pick the brand a document should carry from its title / body. Oil & gas
 * material → MCC Petroli; platform onboarding/handbook → NAFTAhub; everything
 * else (banking, instruments, statements, trade) → MCC Capital.
 */
export function pickPdfBrand(...texts: Array<string | undefined | null>): PdfBrand {
  const t = texts.filter(Boolean).join(" ")
  if (OIL_RE.test(t)) return "petroli"
  if (NAFTAHUB_RE.test(t)) return "naftahub"
  return "capital"
}

/**
 * Draw the brand mark, fitted (aspect-preserved) inside the given box, on an
 * optional white rounded panel. Returns the actual drawn width so callers can
 * position following text. Falls back to the classic gold "M" badge if the
 * logo cache is cold.
 */
export function drawBrandMark(
  doc: jsPDF,
  brand: PdfBrand,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  opts?: { panel?: boolean; radius?: number },
): number {
  const logo = getPdfLogo(brand)
  const panel = opts?.panel ?? true

  if (logo) {
    const pad = panel ? Math.min(boxW, boxH) * 0.12 : 0
    const innerW = boxW - pad * 2
    const innerH = boxH - pad * 2
    const scale = Math.min(innerW / logo.width, innerH / logo.height)
    const w = logo.width * scale
    const h = logo.height * scale
    const panelW = w + pad * 2
    const panelH = h + pad * 2
    if (panel) {
      const r = opts?.radius ?? Math.min(panelW, panelH) * 0.18
      doc.setFillColor(255, 255, 255)
      doc.roundedRect(x, y + (boxH - panelH) / 2, panelW, panelH, r, r, "F")
    }
    const dx = x + pad
    const dy = y + (boxH - panelH) / 2 + pad
    doc.addImage(logo.dataUrl, "JPEG", dx, dy, w, h, undefined, "FAST")
    return panel ? panelW : w
  }

  // Fallback: classic gold rounded square with an "M".
  const s = Math.min(boxW, boxH)
  const fx = x
  const fy = y + (boxH - s) / 2
  doc.setFillColor(...BRAND.gold)
  doc.roundedRect(fx, fy, s, s, s * 0.18, s * 0.18, "F")
  doc.setTextColor(...BRAND.ink)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(s * 0.55)
  doc.text("M", fx + s / 2, fy + s / 2 + s * 0.19, { align: "center" })
  return s
}
