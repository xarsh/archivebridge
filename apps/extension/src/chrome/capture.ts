/**
 * Chrome/Edge capture adapter: the browser's own MHTML serializer.
 *
 * Chromium exposes native MHTML capture, so ArchiveBridge does not walk
 * the DOM here — it asks Blink for the bytes it already knows how to
 * produce. This needs only the `pageCapture` permission: capture of an
 * ordinary `http(s)` tab succeeds with no `host_permissions` at all
 * (measured). Firefox and Safari have no equivalent API and will need an
 * ArchiveBridge-authored capture implementation; that is why capture is
 * its own adapter rather than something the command path does inline.
 * See docs/architecture.md, "Browser extension: capture and save are
 * separate per-browser concerns".
 */

/**
 * Captures `tabId` as MHTML bytes.
 *
 * `saveAsMHTML` resolves with a `Blob` whose `type` is the empty string
 * (measured), so nothing here may branch on the MIME type Chrome reports
 * — the format is known from the API that produced it, not from the blob.
 */
export async function captureMhtml(tabId: number): Promise<Uint8Array> {
	const blob = await chrome.pageCapture.saveAsMHTML({ tabId })
	return new Uint8Array(await blob.arrayBuffer())
}
