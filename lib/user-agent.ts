// ---------------------------------------------------------------------------
// Dependency-free user-agent parser.
//
// Derives an approximate device / OS / browser label from a request's
// User-Agent string for the security-audit timeline. This is best-effort and
// intentionally simple — UA strings are spoofable and vary widely, so treat the
// output as a hint, not proof. No third-party library is used.
// ---------------------------------------------------------------------------

export interface ParsedUserAgent {
  /** "Mobile" | "Tablet" | "Desktop" | "Bot" | "Unknown" */
  deviceType: string
  /** Best-effort OS + version, e.g. "iOS 17", "Windows 10/11", "macOS". */
  os: string
  /** Best-effort browser + major version, e.g. "Safari 17", "Chrome 120". */
  browser: string
  /** A compact one-line summary for tables, e.g. "iPhone · iOS 17 · Safari 17". */
  summary: string
}

const UNKNOWN: ParsedUserAgent = {
  deviceType: "Unknown",
  os: "Unknown",
  browser: "Unknown",
  summary: "Unknown device",
}

function major(version: string | undefined): string {
  if (!version) return ""
  return version.replace(/_/g, ".").split(".")[0] || ""
}

/** Parse a User-Agent header into a coarse device/OS/browser description. */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua || !ua.trim()) return UNKNOWN
  const s = ua

  // --- Bots ---------------------------------------------------------------
  if (/bot|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview/i.test(s)) {
    return { deviceType: "Bot", os: "Unknown", browser: "Automated agent", summary: "Automated agent / bot" }
  }

  // --- OS -----------------------------------------------------------------
  let os = "Unknown"
  let device = ""
  let iOSVer = ""
  if (/iphone/i.test(s)) {
    device = "iPhone"
    iOSVer = major(s.match(/OS (\d+[_.]\d+)/i)?.[1])
    os = `iOS${iOSVer ? " " + iOSVer : ""}`
  } else if (/ipad/i.test(s)) {
    device = "iPad"
    iOSVer = major(s.match(/OS (\d+[_.]\d+)/i)?.[1])
    os = `iPadOS${iOSVer ? " " + iOSVer : ""}`
  } else if (/android/i.test(s)) {
    const av = major(s.match(/Android (\d+(?:\.\d+)?)/i)?.[1])
    os = `Android${av ? " " + av : ""}`
    device = s.match(/;\s*([^;)]+)\s+Build/i)?.[1]?.trim() || "Android device"
  } else if (/windows nt/i.test(s)) {
    const nt = s.match(/Windows NT (\d+\.\d+)/i)?.[1]
    os = nt === "10.0" ? "Windows 10/11" : nt ? `Windows (NT ${nt})` : "Windows"
  } else if (/mac os x/i.test(s)) {
    os = "macOS"
  } else if (/cros/i.test(s)) {
    os = "ChromeOS"
  } else if (/linux/i.test(s)) {
    os = "Linux"
  }

  // --- Device type --------------------------------------------------------
  let deviceType = "Desktop"
  if (/mobile|iphone|android.*mobile/i.test(s)) deviceType = "Mobile"
  else if (/ipad|tablet|android(?!.*mobile)/i.test(s)) deviceType = "Tablet"

  // --- Browser ------------------------------------------------------------
  // Order matters: Edge/Opera/Chrome all contain "Safari"/"Chrome" tokens.
  let browser = "Unknown"
  let m: RegExpMatchArray | null
  if ((m = s.match(/Edg(?:e|A|iOS)?\/(\d+)/i))) browser = `Edge ${m[1]}`
  else if ((m = s.match(/OPR\/(\d+)/i)) || (m = s.match(/Opera\/(\d+)/i))) browser = `Opera ${m[1]}`
  else if ((m = s.match(/SamsungBrowser\/(\d+)/i))) browser = `Samsung Internet ${m[1]}`
  else if ((m = s.match(/FxiOS\/(\d+)/i)) || (m = s.match(/Firefox\/(\d+)/i))) browser = `Firefox ${m[1]}`
  else if ((m = s.match(/CriOS\/(\d+)/i))) browser = `Chrome ${m[1]}`
  else if ((m = s.match(/Chrome\/(\d+)/i))) browser = `Chrome ${m[1]}`
  else if (/Safari/i.test(s) && (m = s.match(/Version\/(\d+)/i))) browser = `Safari ${m[1]}`
  else if (/Safari/i.test(s)) browser = "Safari"

  const deviceLabel = device || (deviceType === "Desktop" ? os : deviceType)
  const summary = [deviceLabel, os !== deviceLabel ? os : "", browser]
    .filter((p) => p && p !== "Unknown")
    .join(" · ")

  return { deviceType, os, browser, summary: summary || "Unknown device" }
}
