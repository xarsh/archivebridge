/**
 * Chrome/Edge save adapter: bytes -> the user's disk, through the
 * browser's own download machinery and its native file chooser.
 *
 * The route is forced by two measured platform facts that point in
 * opposite directions: `URL.createObjectURL` does not exist in an MV3
 * service worker, and `chrome.downloads` does not exist in an offscreen
 * document. So the bytes go service worker -> offscreen document (as a
 * `Blob`, over `BroadcastChannel` — see `blob-url-channel.ts` for why that
 * mechanism), come back as a `blob:` URL string, and the service worker
 * hands that URL to `chrome.downloads.download`.
 *
 * **A save can outlive the worker that started it, and this module is
 * built for that.** Chrome does keep the initiating worker alive while the
 * native chooser is open, but only up to its per-request ceiling: measured
 * on Chrome for Testing 153, a worker with a chooser open was terminated
 * after ~6 minutes, while the offscreen document, its `blob:` URL and the
 * pending `DownloadItem` all survived. A user who takes longer than that to
 * pick a folder must still get their file. So:
 *
 * - The completion handling — `settleAwaitedDownload` and
 *   `adoptSettledDownload` — is wired to `chrome.downloads.onChanged` at
 *   global scope by `background.ts`. A listener registered inside
 *   `download()` cannot wake a worker (measured: once the worker that
 *   registered one dynamically was gone, download activity started no new
 *   one), which is exactly what a save that outlives its worker needs.
 * - Cleanup is conditional, not blind. `releaseOffscreenDocument` frees the
 *   archive bytes only when nothing might still be reading them, which it
 *   works out from the `DownloadItem` — the one piece of state the browser
 *   keeps across worker restarts, so this module needs no persistence of
 *   its own.
 *
 * On that last point, one measured fact is worth recording because it is
 * *not* what the shape of this code suggests: Chrome reads a `blob:` URL
 * eagerly, before the chooser is answered. A 200 MB blob download reported
 * `bytesReceived === totalBytes` within 250 ms of `download()` returning,
 * with the chooser still open — and closing the offscreen document at that
 * point still produced a byte-complete file. So freeing the bytes while a
 * chooser is open is not observably fatal today. The condition stays anyway:
 * it costs one `downloads.search` call and it does not depend on
 * undocumented staging timing that could change. What it cannot cover is a
 * save running in this same worker — `background.ts` serializes every
 * release against the command path for that, which is the only thing that
 * reliably excludes the window between minting a URL and Chrome reading it,
 * where no `DownloadItem` exists to speak for the bytes yet.
 */

import { asBlobUrlMessage, BLOB_URL_CHANNEL_NAME, type BlobUrlRequest } from './blob-url-channel.ts'

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html'

/** How long to wait for an already-open offscreen document to answer a `ping`. Generous: it only ever elapses in the pathological case below. */
const READY_TIMEOUT_MS = 5_000

/** How often to re-`ping` while waiting. */
const PING_INTERVAL_MS = 100

/**
 * How long to wait for a `mint` reply. Reached only if the offscreen
 * document is lost between announcing `ready` and answering — a renderer
 * crash, or anything else that takes the document away mid-command. The
 * wait is bounded because the alternative is a save that hangs until Chrome
 * kills the worker minutes later, with the popup still saying "Capturing…".
 * Generous relative to the work: a `BroadcastChannel` mint of 805 MB was
 * measured at under a millisecond.
 */
const MINT_TIMEOUT_MS = 10_000

/**
 * Every `blob:` URL this extension mints starts with this, and no other
 * extension's does. It is what lets a *restarted* worker recognise a
 * `DownloadItem` as one of its own saves with no bookkeeping of its own.
 */
const OWN_BLOB_URL_PREFIX = `blob:${chrome.runtime.getURL('')}`

/** What a completed save reports back, so the caller can say what it wrote. */
export interface SaveResult {
	readonly fileName: string
	readonly byteLength: number
}

/** The outcome of a save whose worker died before the download finished, as seen by the worker that picked up the pieces. */
export type AdoptedSave = ({ readonly ok: true } & SaveResult) | { readonly ok: false; readonly reason: string }

/** A download that ended in any state other than `complete`. Carries Chrome's own interruption reason, which is the only useful thing to show a user here. */
export class SaveFailedError extends Error {
	constructor(state: string, reason: string | undefined) {
		super(reason === undefined ? `the download ended as "${state}"` : `the download ended as "${state}" (${reason})`)
		this.name = 'SaveFailedError'
	}
}

function rejectAfter(ms: number, message: string): { readonly promise: Promise<never>; readonly cancel: () => void } {
	let timer: ReturnType<typeof setTimeout>
	const promise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
	})
	return { promise, cancel: () => clearTimeout(timer) }
}

/**
 * Ensures an offscreen document is loaded and listening on the blob-URL
 * channel, and returns the open channel.
 *
 * The listener is installed before `createDocument()` so the document's
 * unsolicited `ready` announcement cannot be missed. When a document is
 * already open — a second save in one service-worker lifetime, or one
 * left behind by a previous save — there is no fresh announcement to wait
 * for, so this pings until it gets an answer instead of assuming the
 * document is loaded (it may still be mid-load).
 */
async function openReadyChannel(): Promise<BroadcastChannel> {
	const channel = new BroadcastChannel(BLOB_URL_CHANNEL_NAME)
	const ready = new Promise<void>((resolve) => {
		channel.addEventListener('message', (event: MessageEvent<unknown>) => {
			if (asBlobUrlMessage(event.data)?.kind === 'ready') {
				resolve()
			}
		})
	})

	const alreadyOpen = await chrome.offscreen.hasDocument()
	if (!alreadyOpen) {
		await chrome.offscreen.createDocument({
			url: OFFSCREEN_DOCUMENT_PATH,
			reasons: ['BLOBS'],
			justification: 'Creating a blob: URL for the archive being saved. URL.createObjectURL is unavailable in an MV3 service worker.',
		})
	}

	const timeout = rejectAfter(READY_TIMEOUT_MS, 'the offscreen document did not become ready')
	const ping: BlobUrlRequest = { kind: 'ping' }
	const pinger = setInterval(() => channel.postMessage(ping), PING_INTERVAL_MS)
	channel.postMessage(ping)
	try {
		await Promise.race([ready, timeout.promise])
		return channel
	} catch (error) {
		channel.close()
		throw error
	} finally {
		clearInterval(pinger)
		timeout.cancel()
	}
}

/**
 * Narrows archive bytes to something `Blob` will accept.
 *
 * Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer,
 * and `BlobPart` only admits an `ArrayBuffer`-backed view — while
 * `@xarsh/archivebridge` returns a plain `Uint8Array` (i.e.
 * `ArrayBufferLike`-backed), as it should: nothing about serializing an
 * archive cares which kind of buffer holds the result. Rather than
 * threading that type parameter through the whole pipeline for the sake of
 * one `new Blob(...)` call, the distinction is resolved once, here, at the
 * point that actually depends on it. The `ArrayBuffer` case (always, in
 * practice) re-views the same memory and copies nothing.
 */
function asBlobPart(bytes: Uint8Array): BlobPart {
	const buffer = bytes.buffer
	if (buffer instanceof ArrayBuffer) {
		return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
	}
	// A SharedArrayBuffer-backed view cannot be handed to Blob at all, so this
	// branch has to copy. No code path in this extension reaches it today.
	return bytes.slice()
}

/** Sends `bytes` to the offscreen document and resolves with the `blob:` URL it minted for them. */
async function mintBlobUrl(channel: BroadcastChannel, id: string, bytes: Uint8Array, mimeType: string): Promise<string> {
	const minted = new Promise<string>((resolve, reject) => {
		channel.addEventListener('message', (event: MessageEvent<unknown>) => {
			const message = asBlobUrlMessage(event.data)
			if (message === undefined) {
				return
			}
			if (message.kind === 'minted' && message.id === id) {
				resolve(message.url)
			} else if (message.kind === 'mint-failed' && message.id === id) {
				reject(new Error(message.message))
			}
		})
	})
	const request: BlobUrlRequest = { kind: 'mint', id, blob: new Blob([asBlobPart(bytes)], { type: mimeType }) }
	channel.postMessage(request)
	const timeout = rejectAfter(MINT_TIMEOUT_MS, 'the offscreen document did not return a blob: URL')
	try {
		return await Promise.race([minted, timeout.promise])
	} finally {
		timeout.cancel()
	}
}

/**
 * Downloads this worker instance started and has not seen finish, by
 * download id. In-memory on purpose: an entry only means "this worker is
 * still waiting", and a worker that dies stops waiting. What makes the save
 * itself survive is the `DownloadItem`, not this map.
 */
const awaitingDownloads = new Map<number, (state: string) => void>()

/** Whether a download is still reading a `blob:` URL this extension minted — including one started by a worker that has since been terminated. */
async function ownDownloadInProgress(): Promise<boolean> {
	const items = await chrome.downloads.search({ state: 'in_progress' })
	return items.some((item) => item.url.startsWith(OWN_BLOB_URL_PREFIX))
}

/**
 * Closes the offscreen document, releasing the archive bytes it holds — but
 * only once nothing might still be reading them.
 *
 * Two things can still need them, and they are guarded differently. A save
 * running in *this* worker is excluded by **running every call to this
 * function under the command serialization in `background.ts`** — a check
 * on some "a save is in flight" flag would not do, because the flag would
 * be read before the two `await`s below and acted on after them, and a save
 * that starts in between mints its URL into a document that is already
 * being closed (observed: `chrome.downloads.download` then rejects with
 * "The requested file could not be read"). A download left `in_progress` by
 * a worker that is *gone* cannot be serialized against, and does not need
 * to be: it has a `DownloadItem`, that item is the only trace such a save
 * leaves behind, and reading it is why this needs no state of its own. See
 * the module header for what is and is not known to go wrong when this
 * releases too early.
 *
 * Best-effort and non-throwing, on the same reasoning as `background.ts`'s
 * `showOutcome`: this releases memory after a save has already succeeded or
 * failed, so a failure here must not become — or mask — the save's outcome.
 */
export async function releaseOffscreenDocument(): Promise<void> {
	try {
		if (!(await chrome.offscreen.hasDocument())) {
			return
		}
		if (await ownDownloadInProgress()) {
			return
		}
		await chrome.offscreen.closeDocument()
	} catch (error) {
		console.error('ArchiveBridge: could not release the offscreen document', error)
	}
}

/** The file name Chrome settled on, out of the absolute path it reports. */
function baseName(path: string): string {
	return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * What a completed `DownloadItem` says was actually written, independent of
 * whatever name was originally suggested to `chrome.downloads.download` --
 * the browser-observed truth, shared by the normal-completion path in
 * {@link saveBytes} and the adopted-completion path in
 * {@link adoptSettledDownload} so the two can never describe the same kind
 * of event differently.
 */
function saveResultFrom(item: ChromeDownloadItem): SaveResult {
	return { fileName: baseName(item.filename), byteLength: item.totalBytes }
}

/**
 * Hands a terminal `downloads.onChanged` delta to the save that is waiting
 * for it in *this* worker, and says whether that was the end of it.
 *
 * Synchronous, and deliberately not serialized: this is the notification a
 * running save is blocked on, so queueing it behind that same save would
 * deadlock the queue. Returns `true` for anything already dealt with, which
 * includes every delta that is nobody's business — the common case, since a
 * global listener sees every download in the browser.
 */
export function settleAwaitedDownload(delta: ChromeDownloadDelta): boolean {
	const state = delta.state?.current
	if (state === undefined || state === 'in_progress') {
		return true
	}
	const settle = awaitingDownloads.get(delta.id)
	if (settle === undefined) {
		return false
	}
	awaitingDownloads.delete(delta.id)
	settle(state)
	return true
}

/**
 * Finishes a save whose worker was terminated before its download was: it
 * releases the archive bytes nobody else will, and returns what became of
 * the save so the caller can report it — the popup that asked for the save
 * lost its message channel when its worker died, so the badge and its
 * tooltip are the only surface left.
 *
 * Must run under `background.ts`'s command serialization; see
 * {@link releaseOffscreenDocument}. Returns `undefined` for a download that
 * is not ArchiveBridge's, which is most of them.
 */
export async function adoptSettledDownload(delta: ChromeDownloadDelta): Promise<AdoptedSave | undefined> {
	const state = delta.state?.current
	if (state === undefined || state === 'in_progress') {
		return undefined
	}
	const [item] = await chrome.downloads.search({ id: delta.id })
	if (item === undefined || !item.url.startsWith(OWN_BLOB_URL_PREFIX)) {
		return undefined
	}
	await releaseOffscreenDocument()
	return state === 'complete' ? { ok: true, ...saveResultFrom(item) } : { ok: false, reason: new SaveFailedError(state, item.error).message }
}

/**
 * Starts the download and resolves with the completed `DownloadItem` once it
 * stops being `in_progress`. With the native chooser open this stays pending
 * for as long as the user takes — or for as long as this worker lives,
 * whichever is shorter — which is why it has no timeout of its own.
 *
 * `fileName` is only ever the *requested* name. The user can rename the file
 * in the chooser, so the returned item — not this argument — is what a
 * caller must read to learn what actually reached disk.
 */
async function download(url: string, fileName: string): Promise<ChromeDownloadItem> {
	const downloadId = await chrome.downloads.download({ url, filename: fileName, saveAs: true })
	const settled = new Promise<string>((resolve) => awaitingDownloads.set(downloadId, resolve))
	try {
		// The global listener has been in place since the worker started, so
		// no event can be lost for want of a listener. The remaining gap is this
		// one: the download can reach a terminal state before the line above
		// names it, and then no further `onChanged` will ever arrive and this
		// save hangs until Chrome kills the worker. The gap is real, not
		// theoretical — 3 of 180 multi-megabyte blob downloads reached a
		// terminal state inside it (measured). A download that fails the
		// instant it starts is the way to hit it with a chooser in play: the
		// blob-URL size ceiling, for one, reports `NETWORK_FAILED` immediately.
		// Reading the item's current state closes the gap.
		const [started] = await chrome.downloads.search({ id: downloadId })
		if (started === undefined || started.state === 'in_progress') {
			await settled
		}
	} finally {
		// When the state came from the query rather than the event, the event is
		// still on its way and will find nobody waiting, so this download is
		// also handed to `adoptSettledDownload` a second time. That no longer
		// produces a second user-visible report: a save has begun in this
		// worker by the time that happens, and `background.ts`'s stale-adopted-
		// outcome policy suppresses exactly that case — see its comment.
		awaitingDownloads.delete(downloadId)
	}
	// Read the final item rather than trust the state string above: it may
	// have come from the event, and this is the one place both paths agree on
	// what Chrome actually settled on.
	const [item] = await chrome.downloads.search({ id: downloadId })
	if (item === undefined) {
		throw new Error(`ArchiveBridge: download ${downloadId} reached a terminal state but its DownloadItem could not be found`)
	}
	if (item.state !== 'complete') {
		throw new SaveFailedError(item.state, item.error)
	}
	return item
}

/**
 * Writes `bytes` to disk as `fileName`, showing the browser's native file
 * chooser (`saveAs: true`) so the user picks the location — the trailing
 * `…` in the extension's menu labels promises exactly that.
 *
 * The returned `SaveResult.fileName` is Chrome's actual final basename, not
 * necessarily `fileName`: the user may have renamed the file in the chooser.
 */
export async function saveBytes(bytes: Uint8Array, fileName: string, mimeType: string): Promise<SaveResult> {
	const id = crypto.randomUUID()
	const channel = await openReadyChannel()
	try {
		const url = await mintBlobUrl(channel, id, bytes, mimeType)
		let item: ChromeDownloadItem
		try {
			item = await download(url, fileName)
		} finally {
			const revoke: BlobUrlRequest = { kind: 'revoke', id }
			channel.postMessage(revoke)
		}
		return saveResultFrom(item)
	} finally {
		channel.close()
		await releaseOffscreenDocument()
	}
}
