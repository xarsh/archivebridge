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
 * The `Blob` `saveAsMHTML` resolves with is backed by a temp file Chromium
 * owns, not by bytes already in memory (measured: reading it can throw a
 * `NotFoundError` — the standard DOMException for "the underlying data is
 * gone" — even though `saveAsMHTML` itself resolved without error, and even
 * though the same call reading the same tab succeeds a moment later). That
 * makes it a genuine race against Chromium's own housekeeping of that file
 * rather than anything this extension does wrong, so the only fix is to ask
 * for a fresh `Blob` — a stale one cannot be recovered — and retry a bounded
 * number of times.
 */
const CAPTURE_RETRIES = 3

function blobBackingGone(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'NotFoundError'
}

/**
 * Captures `tabId` as MHTML bytes.
 *
 * `saveAsMHTML` resolves with a `Blob` whose `type` is the empty string
 * (measured), so nothing here may branch on the MIME type Chrome reports
 * — the format is known from the API that produced it, not from the blob.
 */
export async function captureMhtml(tabId: number): Promise<Uint8Array> {
	for (let attempt = 1; ; attempt++) {
		const blob = await chrome.pageCapture.saveAsMHTML({ tabId })
		try {
			return new Uint8Array(await blob.arrayBuffer())
		} catch (error) {
			if (!blobBackingGone(error) || attempt >= CAPTURE_RETRIES) {
				throw error
			}
		}
	}
}
