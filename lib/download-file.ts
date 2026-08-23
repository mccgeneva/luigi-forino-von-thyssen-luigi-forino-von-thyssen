/**
 * Save a file WITHOUT navigating the page.
 *
 * Inside the installed PWA / in-app webview there is no browser chrome, so a
 * plain `<a href target="_blank">` or even `<a download>` just navigates the
 * single webview to the raw Blob URL and strands the user with no way back
 * (the "open a document, can't exit" trap). This helper instead fetches the
 * bytes and hands them to the native share sheet on mobile (Save to Files),
 * or triggers an object-URL download on desktop — never a bare navigation.
 *
 * Returns true if a save/share was initiated (or cancelled by the user),
 * false only if the file could not be fetched.
 */
export async function downloadFile(url: string, filename?: string): Promise<boolean> {
  const name = filename && filename.trim() ? filename.trim() : "document"
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
    const blob = await res.blob()
    const file = new File([blob], name, {
      type: blob.type || "application/octet-stream",
    })

    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean
    }
    if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: name })
        return true
      } catch (err) {
        // User dismissed the share sheet — that's a successful "no-op", NOT a
        // failure, and we must NOT fall through to a navigation.
        if ((err as Error).name === "AbortError") return true
        // Any other share error: fall through to the object-URL download.
      }
    }

    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = objectUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
    return true
  } catch {
    return false
  }
}
