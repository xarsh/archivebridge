/**
 * The protocol that moves captured/converted archive bytes from the MV3
 * service worker to an offscreen document and gets a `blob:` URL back.
 *
 * **Why this exists at all.** `chrome.pageCapture.saveAsMHTML()` runs in
 * the service worker, but `URL.createObjectURL` is `undefined` there
 * (measured on Chrome for Testing 153) — and `chrome.downloads` is
 * `undefined` inside an offscreen document, where `createObjectURL` does
 * exist. Neither context can do the whole job, so the bytes have to cross
 * from one to the other.
 *
 * **Why `BroadcastChannel`.** `chrome.runtime.sendMessage` cannot carry
 * binary data at all: it serializes as JSON, so a `Blob` and an
 * `ArrayBuffer` both arrive as `{}` and a `Uint8Array` arrives as an
 * object with one numeric key per byte (all measured). Three mechanisms
 * that *do* work were compared on a real 12.9 MB `pageCapture` result:
 *
 * | mechanism         | service worker -> offscreen |
 * | ----------------- | --------------------------- |
 * | `BroadcastChannel`| 1 ms                        |
 * | Cache Storage     | 9 ms                        |
 * | IndexedDB         | 12 ms                       |
 *
 * `BroadcastChannel` is both the fastest and the only one of the three
 * with nothing to clean up: it is a structured-clone message channel
 * between same-origin contexts, so the `Blob` crosses by reference and
 * there is no cache entry or database record that can outlive a failed
 * save. Cache Storage and IndexedDB would each need their own deletion
 * path on every error branch, and a crash between write and delete would
 * leak archive bytes into the profile on disk. Both remain viable
 * fallbacks if a future requirement (a handoff that must survive service
 * worker termination, say) actually needs persistence — nothing here
 * depends on the choice beyond this module.
 *
 * Bytes are handed over as a `Blob` rather than a `Uint8Array` because
 * that is what both ends want anyway: `pageCapture` produces one, and
 * `createObjectURL` consumes one, so nothing is copied in between.
 */

/** The channel name. Namespaced because `BroadcastChannel` names are shared across the whole extension origin. */
export const BLOB_URL_CHANNEL_NAME = 'archivebridge.blob-url'

/** Service worker -> offscreen document. */
export type BlobUrlRequest =
	| {
			readonly kind: 'mint'
			readonly id: string
			readonly blob: Blob
	  }
	| {
			readonly kind: 'revoke'
			readonly id: string
	  }
	/** Liveness probe: an offscreen document that is already loaded answers with `ready`. See {@link BlobUrlAnnouncement}. */
	| {
			readonly kind: 'ping'
	  }

/** Offscreen document -> service worker, in reply to a `mint`. */
export type BlobUrlReply =
	| {
			readonly kind: 'minted'
			readonly id: string
			readonly url: string
	  }
	| {
			readonly kind: 'mint-failed'
			readonly id: string
			readonly message: string
	  }

/** Offscreen document -> service worker, unsolicited on load and in reply to a `ping`. */
export interface BlobUrlAnnouncement {
	readonly kind: 'ready'
}

export type BlobUrlMessage = BlobUrlRequest | BlobUrlReply | BlobUrlAnnouncement

/**
 * Narrows a `BroadcastChannel` payload to a known message.
 *
 * The payload arrives from another extension context rather than from the
 * network, so this is not a security boundary — but it is still `unknown`
 * as far as the type system is concerned, and this project's convention is
 * that `unknown` gets narrowed at runtime rather than asserted away.
 */
export function asBlobUrlMessage(data: unknown): BlobUrlMessage | undefined {
	if (typeof data !== 'object' || data === null) {
		return undefined
	}
	const message = data as { kind?: unknown }
	switch (message.kind) {
		case 'mint':
		case 'revoke':
		case 'ping':
		case 'minted':
		case 'mint-failed':
		case 'ready':
			return data as BlobUrlMessage
		default:
			return undefined
	}
}
