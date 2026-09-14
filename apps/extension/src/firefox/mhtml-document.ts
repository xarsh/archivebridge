/**
 * Turns one page capture plus the bytes fetched for it into an
 * `MhtmlDocument` — the point where page-derived *data* becomes archive
 * *structure*, and the last step before `serializeMhtml`.
 *
 * Three things about it are deliberate.
 *
 * **It is a pure function.** No `browser.*`, no DOM, no `fetch`, no clock,
 * no randomness that is not passed in. That is what lets the whole of
 * Phase 1's byte behaviour — root identity, the canvas `cid:` link, the
 * form-state policy's effect on the archived markup, what becomes a MIME
 * part and what does not — be asserted under `node --test` with no browser
 * anywhere, exactly as `core/archive-bytes.ts` already is.
 *
 * **The page's output is narrowed before it is read.** A capture result
 * arrives across a world boundary from a page an extension does not
 * control, so this module validates rather than trusts: a canvas's
 * `Content-ID` must be the one the background minted, its `cid:` URI must
 * be the one the library spells for that `Content-ID`, and a URL, media
 * type or charset that cannot appear in a MIME header is dropped with a
 * diagnostic rather than handed to the serializer (which would throw and
 * fail the whole save).
 *
 * That last check is deliberately *re-done* here rather than assumed of the
 * producers upstream. `resources.ts` and `content-type.ts` already return
 * writable media types, `capture.ts` has already narrowed the page's own
 * output, and this is still the boundary where a part is built, so it
 * enforces the serializer's rule itself — with the serializer's own
 * `isValidMediaType`, not a regex that agrees with it today. One unwritable
 * value reaching `serializeMhtml` does not lose a resource, it loses the
 * save. Every field that becomes a header goes through that: a resource's
 * and a blob's URL, media type and charset are checked here, a canvas's
 * `Content-ID` is checked against the one the background minted, and a
 * canvas's media type is not page data at all — it is this module's
 * {@link CANVAS_MIME_TYPE}.
 *
 * **It builds no format-specific anything.** Everything here is the
 * library's own `MhtmlPart`/`MhtmlDocument` shape; the MIME bytes,
 * base64 encoding, `Content-ID` generation for parts that have none, and
 * every representability rule stay in `@xarsh/archivebridge`. The
 * extension's job is to say which resources exist, not how MHTML is
 * written (CONTRIBUTING.md, "Boundaries to keep").
 */

import { type Diagnostic, encodeCidUri, isValidMediaType, type MhtmlDocument, type MhtmlPart } from '@xarsh/archivebridge'
import { readContentType } from './content-type.ts'
import type { PageCaptureNote, PageCaptureResult } from './page-capture.ts'

/**
 * What a canvas part says it is.
 *
 * Stated here rather than carried back from the page: the injected capture
 * asks `toDataURL` for `image/png` and refuses any data URL that does not
 * say so, which makes a page-supplied media type a claim that would be
 * checked against this constant anyway. A canvas part is the one part whose
 * `Content-Type` nothing outside this extension chose.
 */
const CANVAS_MIME_TYPE = 'image/png'

/** One resource the background fetched, in the form this module needs it. */
export interface AcquiredResource {
	/** The URL the page referenced, not the one a redirect landed on: it is what the archived markup points at, so it is what has to resolve. */
	readonly url: string
	readonly mimeType: string
	readonly textEncoding: string | undefined
	readonly bytes: Uint8Array
}

export interface BuiltMhtmlDocument {
	readonly document: MhtmlDocument
	readonly diagnostics: readonly Diagnostic[]
}

/** Thrown when the capture cannot become an archive at all, as opposed to the ordinary case of one resource going missing. */
export class CaptureAssemblyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CaptureAssemblyError'
	}
}

/**
 * A value that can be written into a MIME header field at all.
 * `serializeMhtml` enforces this itself and *throws* when it is violated —
 * correct for the library, and the wrong outcome for one bad resource URL
 * out of fifty, so this checks first and drops the part instead. A
 * browser-serialized URL is ASCII by construction (`document.URL` and
 * `URL.href` punycode the host and percent-encode the rest), so this only
 * ever fires on something the page synthesized.
 */
function isWritableHeaderValue(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code < 0x20 || code > 0x7e) {
			return false
		}
	}
	return true
}

/** Maps the page's own notes onto the project's diagnostic vocabulary. The page reports what it could not do; naming the diagnostic is this side's job. */
function diagnosticForNote(note: PageCaptureNote): Diagnostic {
	switch (note.kind) {
		case 'canvas-unreadable':
			return { type: 'unsupported-feature', feature: `canvas pixels could not be read (${note.detail})` }
		case 'blob-unreadable':
			return { type: 'unresolved-resource', url: note.detail }
		// Every limit the injected capture can reach reports the same way: the
		// page is intact, one thing in it was not collected, and the note says
		// which bound stopped it. None of them is a malformed resource, so none
		// of them borrows that vocabulary.
		case 'canvas-limit-reached':
		case 'blob-too-large':
		case 'blob-limit-reached':
		case 'resource-limit-reached':
		case 'capture-byte-limit-reached':
			return { type: 'unsupported-feature', feature: note.detail }
	}
}

/**
 * Assembles the archive.
 *
 * `canvasContentIdPrefix` must be the same value handed to the injected
 * capture, and is what makes a canvas's claimed `Content-ID` checkable
 * rather than merely plausible.
 */
export function buildMhtmlDocument(capture: PageCaptureResult, resources: readonly AcquiredResource[], canvasContentIdPrefix: string): BuiltMhtmlDocument {
	const diagnostics: Diagnostic[] = capture.notes.map(diagnosticForNote)

	if (!isWritableHeaderValue(capture.url)) {
		throw new CaptureAssemblyError(`the page's own URL cannot be written into a MIME header: ${JSON.stringify(capture.url)}`)
	}

	// `text/html` rather than `document.contentType` verbatim for the same
	// reason the serializer validates it: a media type that is not a real
	// `token "/" token` cannot be written, and the capture only ever runs on
	// a document the browser already parsed as HTML.
	const rootMimeType = isValidMediaType(capture.mimeType) ? capture.mimeType : 'text/html'

	const parts: MhtmlPart[] = [
		{
			contentId: undefined,
			location: capture.url,
			mimeType: rootMimeType,
			// The snapshot is encoded with `TextEncoder`, which is UTF-8 only;
			// the page's own `<meta charset>` was reconciled with that during
			// capture, so the archive makes one consistent claim.
			textEncoding: 'utf-8',
			data: new TextEncoder().encode(capture.html),
		},
	]

	const usedLocations = new Set<string>([capture.url])

	function addLocatedPart(url: string, mimeType: string, textEncoding: string | undefined, bytes: Uint8Array): void {
		if (!isWritableHeaderValue(url) || !isWritableHeaderValue(mimeType) || (textEncoding !== undefined && !isWritableHeaderValue(textEncoding))) {
			diagnostics.push({ type: 'malformed-resource', url, message: 'the resource could not be recorded: its URL, media type or charset cannot appear in a MIME header' })
			return
		}
		if (!isValidMediaType(mimeType)) {
			diagnostics.push({ type: 'malformed-resource', url, message: `the resource could not be recorded: ${JSON.stringify(mimeType)} is not a media type MHTML can name` })
			return
		}
		if (usedLocations.has(url)) {
			// Two parts claiming one Content-Location make the reference
			// ambiguous and unresolvable for every consumer, so the second is
			// dropped rather than written.
			diagnostics.push({ type: 'duplicate-content-location', url })
			return
		}
		usedLocations.add(url)
		parts.push({ contentId: undefined, location: url, mimeType, textEncoding, data: bytes })
	}

	for (const resource of resources) {
		addLocatedPart(resource.url, resource.mimeType, resource.textEncoding, resource.bytes)
	}

	for (const blob of capture.blobs) {
		// A `blob:` URL is absolute, unique, and exactly what the archived
		// markup still points at, so it is the part's Content-Location. It
		// resolves nowhere outside this archive, which is the same guarantee
		// the converter's synthetic `cid:` namespace is built for.
		//
		// Its `Content-Type` is whatever the page handed `new Blob()`, so it
		// is split here rather than trusted as a media type: `text/plain` and
		// `text/plain;charset=utf-8` are both ordinary things for a page to
		// produce, and only the first is something a MIME part's `Content-Type`
		// field can be set to on its own.
		const { mimeType, textEncoding } = readContentType(blob.contentType, 'application/octet-stream')
		addLocatedPart(blob.url, mimeType, textEncoding, blob.bytes)
	}

	capture.canvases.forEach((canvas, index) => {
		const expectedContentId = `${canvasContentIdPrefix}-${index}`
		if (canvas.contentId !== expectedContentId || canvas.cidUrl !== encodeCidUri(expectedContentId)) {
			// Only reachable if the injected capture and the library disagree
			// about `cid:` spelling or about which identity this canvas was
			// given. Dropping the part leaves the reference unresolved and
			// says so, rather than writing a part nothing can reach.
			diagnostics.push({ type: 'unresolved-resource', url: canvas.cidUrl })
			return
		}
		parts.push({ contentId: canvas.contentId, location: undefined, mimeType: CANVAS_MIME_TYPE, textEncoding: undefined, data: canvas.bytes })
	})

	return { document: { parts, rootPartIndex: 0 }, diagnostics }
}
