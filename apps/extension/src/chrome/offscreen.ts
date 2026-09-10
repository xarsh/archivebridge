/**
 * Offscreen document: a `blob:` URL minting service, and nothing else.
 *
 * This document exists purely to close a platform gap —
 * `URL.createObjectURL` is unavailable in an MV3 service worker but
 * available here — so it deliberately holds no product logic. Capture,
 * conversion and the download itself all stay in the service worker (see
 * `background.ts`), which keeps the archive pipeline readable as one
 * linear function and keeps this Chrome-specific artifact from becoming a
 * place where behavior hides. Chrome does not expose `chrome.downloads`
 * here anyway (measured: the offscreen `chrome.*` surface is only `csi`,
 * `loadTimes` and `runtime`), so splitting the work any other way is not
 * an option.
 *
 * The `ready` announcement on load is what lets the service worker post to
 * this document without a polling loop: the worker starts listening
 * *before* it calls `chrome.offscreen.createDocument()`, so the
 * announcement cannot be missed. `ping` covers the other case — a document
 * that was already open before the worker started listening.
 */

import { asBlobUrlMessage, BLOB_URL_CHANNEL_NAME, type BlobUrlAnnouncement, type BlobUrlReply } from './blob-url-channel.ts'

const channel = new BroadcastChannel(BLOB_URL_CHANNEL_NAME)

/** Minted URLs, so a `revoke` can release exactly the one it names and nothing else. */
const mintedUrls = new Map<string, string>()

function reply(message: BlobUrlReply | BlobUrlAnnouncement): void {
	channel.postMessage(message)
}

channel.addEventListener('message', (event: MessageEvent<unknown>) => {
	const message = asBlobUrlMessage(event.data)
	if (message === undefined) {
		return
	}
	switch (message.kind) {
		case 'ping':
			reply({ kind: 'ready' })
			return
		case 'mint':
			try {
				const url = URL.createObjectURL(message.blob)
				mintedUrls.set(message.id, url)
				reply({ kind: 'minted', id: message.id, url })
			} catch (error) {
				reply({ kind: 'mint-failed', id: message.id, message: error instanceof Error ? error.message : String(error) })
			}
			return
		case 'revoke': {
			const url = mintedUrls.get(message.id)
			if (url !== undefined) {
				URL.revokeObjectURL(url)
				mintedUrls.delete(message.id)
			}
			return
		}
		// Replies and announcements are this document's own output, echoed back to it
		// because BroadcastChannel is a shared bus. Ignoring them is the whole handling.
		case 'minted':
		case 'mint-failed':
		case 'ready':
			return
	}
})

reply({ kind: 'ready' })
