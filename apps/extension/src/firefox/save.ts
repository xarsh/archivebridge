/**
 * Firefox save adapter: bytes -> the user's disk, through
 * `browser.downloads` and the native file chooser.
 *
 * It is much simpler than `chrome/save.ts`, and the whole difference is one
 * platform fact: Firefox's MV3 background is a *document*, so
 * `URL.createObjectURL` exists there. None of Chrome's offscreen-document
 * and `BroadcastChannel` machinery has anything to do here, and none of it
 * is imported or imitated.
 *
 * **There is no event-page lifetime workaround, because there is nothing to
 * work around.** Firefox keeps the background alive for as long as its own
 * `downloads.download({ saveAs: true })` call is outstanding — measured to
 * at least 130 seconds with the native chooser open, with or without an
 * `await`, with or without an `onChanged` listener — and the promise does
 * not settle until the user answers. That removes the entire class of
 * problem Chrome's save path is built around: no `DownloadItem` has to be
 * adopted by a successor, because there is no successor.
 *
 * **The one real hazard is revoking the blob URL too early.** Firefox reads
 * the blob *lazily*, no earlier than the user's answer: revoking about a
 * second after the chooser opened and then accepting produced
 * `state: "interrupted", error: "CRASH", bytesReceived: 0` (measured). So
 * the URL is released only once the download has reached a terminal state —
 * never on a timer, and never "shortly after calling download".
 *
 * **A cancelled save is not a failure and leaves nothing behind.**
 * Cancelling makes `downloads.download` *reject*
 * (`Download canceled by the user`) rather than resolve with an id that
 * later errors, and `downloads.search` afterwards reports no entry at all —
 * no download was ever created and no file was written. The only cleanup is
 * the blob URL this module made, which the `finally` below covers on every
 * path.
 */

/** What a completed save reports back. Same shape `chrome/save.ts` returns, because the command path shows it the same way. */
export interface SaveResult {
	readonly fileName: string
	readonly byteLength: number
}

/** The user dismissed the file chooser. An expected outcome of offering a chooser, not an error to badge the toolbar over. */
export class SaveCanceledError extends Error {
	constructor() {
		super('Save canceled.')
		this.name = 'SaveCanceledError'
	}
}

/** A download that reached a terminal state other than `complete`. Carries Firefox's own interruption reason, which is the only useful thing to show. */
export class SaveFailedError extends Error {
	constructor(state: string, reason: string | undefined) {
		super(reason === undefined ? `the download ended as "${state}"` : `the download ended as "${state}" (${reason})`)
		this.name = 'SaveFailedError'
	}
}

/**
 * Downloads this background is waiting on, by id.
 *
 * In-memory on purpose, and safe to be: the measurements above say the page
 * does not unload while its own download is outstanding, so "this page is
 * still waiting" is a state that cannot be orphaned the way Chrome's can.
 */
const awaitingDownloads = new Map<number, (state: string) => void>()

/**
 * Registered at module scope rather than inside the save, so that the
 * listener exists for the whole life of the background page. Also the
 * listener a *future* phase would need to wake an unloaded event page — it
 * costs nothing to have it in the right place already.
 */
browser.downloads.onChanged.addListener((delta) => {
	const state = delta.state?.current
	if (state === undefined || state === 'in_progress') {
		return
	}
	const settle = awaitingDownloads.get(delta.id)
	if (settle !== undefined) {
		awaitingDownloads.delete(delta.id)
		settle(state)
	}
})

/**
 * Narrows archive bytes to something `Blob` accepts.
 *
 * `Uint8Array` is generic over its backing buffer since TypeScript 5.7 and
 * `BlobPart` admits only an `ArrayBuffer`-backed view, while
 * `@xarsh/archivebridge` returns a plain `Uint8Array` — as it should, since
 * nothing about serializing an archive cares which buffer holds the result.
 * Resolved here, at the one call that depends on it, rather than threaded
 * through the pipeline. Duplicated from `chrome/save.ts` deliberately:
 * per-browser save adapters are parallel by design, and a shared module for
 * four lines would be the first thread of the abstraction the two are meant
 * not to have.
 */
function asBlobPart(bytes: Uint8Array): BlobPart {
	const buffer = bytes.buffer
	if (buffer instanceof ArrayBuffer) {
		return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
	}
	return bytes.slice()
}

/** The file name Firefox settled on, out of the absolute path it reports. */
function baseName(path: string): string {
	return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Waits for `downloadId` to stop being `in_progress`.
 *
 * The item's current state is read *after* the waiter is registered, which
 * closes the gap where a download reaches a terminal state between the
 * `download()` call returning and this listening for it — after which no
 * further `onChanged` would ever arrive and the save would hang.
 */
async function waitForTerminalState(downloadId: number): Promise<FirefoxDownloadItem> {
	const settled = new Promise<string>((resolve) => awaitingDownloads.set(downloadId, resolve))
	try {
		const [started] = await browser.downloads.search({ id: downloadId })
		if (started === undefined || started.state === 'in_progress') {
			await settled
		}
	} finally {
		awaitingDownloads.delete(downloadId)
	}
	const [item] = await browser.downloads.search({ id: downloadId })
	if (item === undefined) {
		throw new SaveFailedError('unknown', `download ${downloadId} reached a terminal state but could not be found`)
	}
	return item
}

/**
 * Writes `bytes` to disk as `fileName`, showing the browser's native file
 * chooser (`saveAs: true`) — which is what the trailing `…` in both command
 * labels promises.
 *
 * The returned `fileName` is what Firefox actually wrote, not necessarily
 * what was asked for: the user may rename the file in the chooser.
 */
export async function saveBytes(bytes: Uint8Array, fileName: string, mimeType: string): Promise<SaveResult> {
	const url = URL.createObjectURL(new Blob([asBlobPart(bytes)], { type: mimeType }))
	try {
		let downloadId: number
		try {
			downloadId = await browser.downloads.download({ url, filename: fileName, saveAs: true })
		} catch (error) {
			// Firefox reports a dismissed chooser as a rejection with this exact
			// message. An exact match rather than a fuzzy one: mistaking a real
			// failure for a cancellation would hide it.
			if (error instanceof Error && error.message === 'Download canceled by the user') {
				throw new SaveCanceledError()
			}
			throw error
		}
		const item = await waitForTerminalState(downloadId)
		if (item.state !== 'complete') {
			throw new SaveFailedError(item.state, item.error)
		}
		return { fileName: baseName(item.filename), byteLength: item.totalBytes }
	} finally {
		// Only now: the bytes are read no earlier than the user's answer, so
		// releasing them any sooner interrupts the download.
		URL.revokeObjectURL(url)
	}
}
