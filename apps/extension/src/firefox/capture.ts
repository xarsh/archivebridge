/**
 * Firefox capture adapter: a live tab in, canonical MHTML bytes out.
 *
 * Firefox has no native MHTML capture API, so unlike `chrome/capture.ts` —
 * one call into the browser — this is ArchiveBridge's own capture. It is
 * still the same seam: `(tabId) => Promise<Uint8Array>`, which is what lets
 * `core/archive-bytes.ts` and everything downstream of it stay identical
 * between the two browsers.
 *
 * ```text
 * captureMhtml(tabId)
 *   ├─ scripting.executeScript   page-capture.ts, world: ISOLATED, frameIds: [0]
 *   ├─ acquireResources(...)     resources.ts     privileged fetch
 *   ├─ buildMhtmlDocument(...)   mhtml-document.ts  (pure)
 *   └─ serializeMhtml(...)       @xarsh/archivebridge
 * ```
 *
 * **Phase 1 is the top document only**, and `frameIds: [0]` is where that
 * is decided. A page's `<iframe>`/`<frame>`/`<object>`/`<embed>` elements
 * survive in the archived markup as the ordinary references they are: no
 * `cid:` link is written for them and no part is emitted, so the archive
 * never claims to contain a document it did not capture. Frames are Phase 2
 * and need the frame-identity join, the library's positional frame rewrite
 * and the host permission for every embedded origin.
 *
 * **This module is where the capture's limits are decided.** Both halves
 * take them as arguments — the injected function because it can import
 * nothing, `acquireResources` because the same reasoning applies to the
 * layer that owns policy — so `capture-limits.ts` is read in exactly one
 * place and every bound a page can push against is visible here. Reaching
 * one is a diagnostic and a missing resource, never a silent truncation and
 * never a failed save.
 *
 * **Capture-time diagnostics are logged, not returned.** Keeping the
 * `Promise<Uint8Array>` seam is worth more than plumbing a second channel
 * through the command path for a phase whose resource acquisition is
 * deliberately incomplete; surfacing "3 resources could not be fetched" to
 * the user arrives with the rest of resource completeness in Phase 4.
 */

import { serializeMhtml } from '@xarsh/archivebridge'
import { PAGE_CAPTURE_LIMITS, RESOURCE_FETCH_LIMITS } from './capture-limits.ts'
import { buildMhtmlDocument } from './mhtml-document.ts'
import type { CapturedBlob, CapturedCanvas, NetworkResourceReference, PageCaptureNote, PageCaptureResult } from './page-capture.ts'
import { capturePageState, PAGE_CAPTURE_NOTE_KINDS } from './page-capture.ts'
import { acquireResources, credentialScopeForDocumentUrl } from './resources.ts'

/** Thrown when the page could not be reached at all, as opposed to a capture that merely lost some resources. */
export class CaptureFailedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CaptureFailedError'
	}
}

/**
 * One collection of the capture result, narrowed member by member.
 *
 * The two failure modes are deliberately different, because they are
 * different kinds of wrong. A collection that **is not a list at all** is
 * not a capture result with something missing from it — the injected
 * function returns four arrays, always — so it is the same class of fault
 * as `html` coming back as a number, and it fails the save rather than
 * being silently read as empty. An individual **member** that is not what
 * it claims is dropped, which is the policy the rest of the capture already
 * follows for one resource that could not be had.
 *
 * `.filter()` on the collection was what this replaces, and the reason it
 * had to go is that it *assumes* the answer to the first question: a
 * structured-cloned string or object where an array was expected made the
 * boundary throw a bare `TypeError` from inside the narrowing that exists
 * to prevent exactly that.
 */
function narrowedMembers<T>(value: unknown, field: string, narrow: (member: Record<string, unknown>) => T | undefined): T[] {
	if (!Array.isArray(value)) {
		throw new CaptureFailedError(`the page returned a capture result whose ${field} is not a list`)
	}
	const members: T[] = []
	for (const member of value) {
		if (typeof member !== 'object' || member === null) {
			continue
		}
		const narrowed = narrow(member as Record<string, unknown>)
		if (narrowed !== undefined) {
			members.push(narrowed)
		}
	}
	return members
}

function asNetworkResourceReference(member: Record<string, unknown>): NetworkResourceReference | undefined {
	if (typeof member.url !== 'string' || (member.kind !== 'image' && member.kind !== 'stylesheet')) {
		return undefined
	}
	return { url: member.url, kind: member.kind }
}

/**
 * A canvas snapshot, with **no media type taken from the page**.
 *
 * The injected capture only ever produces PNG — it asks `toDataURL` for
 * `image/png` and refuses anything whose data URL does not say so — and
 * `mhtml-document.ts` writes a canvas part's `Content-Type` from its own
 * constant. A media type carried across the boundary would therefore be a
 * claim that is never needed and never checked, sitting one step away from
 * a MIME header; not having the field is a stronger guarantee than
 * validating it would be. What *is* checked is identity: `contentId` and
 * `cidUrl` are re-derived and compared against the ones the background
 * minted, in `mhtml-document.ts`.
 */
function asCapturedCanvas(member: Record<string, unknown>): CapturedCanvas | undefined {
	if (typeof member.contentId !== 'string' || typeof member.cidUrl !== 'string' || !(member.bytes instanceof Uint8Array)) {
		return undefined
	}
	return { contentId: member.contentId, cidUrl: member.cidUrl, bytes: member.bytes }
}

function asCapturedBlob(member: Record<string, unknown>): CapturedBlob | undefined {
	if (typeof member.url !== 'string' || typeof member.contentType !== 'string' || !(member.bytes instanceof Uint8Array)) {
		return undefined
	}
	// `contentType` stays raw on purpose: it is the blob's own header, and
	// `mhtml-document.ts` splits it through `content-type.ts` rather than
	// treating it as a media type.
	return { url: member.url, contentType: member.contentType, bytes: member.bytes }
}

function asPageCaptureNote(member: Record<string, unknown>): PageCaptureNote | undefined {
	// A note whose kind is not one this build knows would map to no
	// diagnostic at all, so it is dropped here rather than becoming a hole in
	// the diagnostics list.
	if (typeof member.detail !== 'string' || !(PAGE_CAPTURE_NOTE_KINDS as readonly unknown[]).includes(member.kind)) {
		return undefined
	}
	return { kind: member.kind as PageCaptureNote['kind'], detail: member.detail }
}

/**
 * Narrows the value that comes back across the world boundary.
 *
 * `scripting.executeScript` returns whatever the injected function
 * returned, structured-cloned, and the page it ran in is not something an
 * extension controls. This is the boundary where that value stops being
 * `unknown`, in the same "untrusted output is narrowed before it is read"
 * sense the project applies to parsed archive data — `mhtml-document.ts`
 * then re-checks the parts of it that carry archive identity.
 *
 * Narrowing here means **rebuilding**, not asserting: every value handed
 * on is a field this function read, checked and copied, so nothing reaches
 * the archive builder because it happened to be sitting on an object that
 * passed a type guard. The one rule that has to hold whatever the page
 * returns is that no shape it can produce reaches `serializeMhtml` and
 * fails the save; a fault at this boundary is a `CaptureFailedError`, never
 * an accidental `TypeError` from a method call on something that turned out
 * not to be an array.
 *
 * Exported for its own test: it is the trust boundary, and a boundary that
 * is only exercised through a real browser is one that gets tested for the
 * shapes a real browser produces rather than the shapes it must survive.
 */
export function asPageCaptureResult(value: unknown): PageCaptureResult {
	if (typeof value !== 'object' || value === null) {
		throw new CaptureFailedError('the page returned no capture result')
	}
	const candidate = value as Record<string, unknown>
	if (typeof candidate.url !== 'string' || typeof candidate.html !== 'string' || typeof candidate.mimeType !== 'string' || typeof candidate.title !== 'string') {
		throw new CaptureFailedError('the page returned a capture result of an unexpected shape')
	}
	return {
		url: candidate.url,
		mimeType: candidate.mimeType,
		title: candidate.title,
		html: candidate.html,
		networkResources: narrowedMembers(candidate.networkResources, 'resource list', asNetworkResourceReference),
		canvases: narrowedMembers(candidate.canvases, 'canvas list', asCapturedCanvas),
		blobs: narrowedMembers(candidate.blobs, 'blob list', asCapturedBlob),
		notes: narrowedMembers(candidate.notes, 'note list', asPageCaptureNote),
	}
}

/** Captures `tabId`'s top document as canonical MHTML bytes. */
export async function captureMhtml(tabId: number): Promise<Uint8Array> {
	// Minted here, in the privileged context, so that the identity a canvas
	// part is addressed by comes from one place and the page's claim about it
	// is checkable (`mhtml-document.ts`).
	const canvasContentIdPrefix = `canvas-${crypto.randomUUID()}@archivebridge`

	const injected = await browser.scripting.executeScript({
		// `frameIds: [0]` — the top document, explicitly. Phase 1 does not
		// capture frames; see the module header.
		target: { tabId, frameIds: [0] },
		world: 'ISOLATED',
		func: capturePageState,
		args: [{ canvasContentIdPrefix, ...PAGE_CAPTURE_LIMITS }],
	})

	const [injection] = injected
	if (injection === undefined) {
		throw new CaptureFailedError('the page could not be reached for capture')
	}
	if (injection.error !== undefined) {
		throw new CaptureFailedError(`the page could not be captured: ${String(injection.error)}`)
	}

	const capture = asPageCaptureResult(injection.result)
	// Every reference in this phase comes from the one top document, so they
	// all carry that document's scope — attached here rather than assumed by
	// `resources.ts`, which is what makes the credential rule per-reference
	// before there is a second document to get it wrong for. `capture.url` is
	// a navigated top document's URL, the case where the URL does decide the
	// origin; an inherited-origin frame will have to say what its scope is
	// instead of being re-parsed into one.
	const topDocumentScope = credentialScopeForDocumentUrl(capture.url)
	const acquired = await acquireResources(
		capture.networkResources.map((reference) => ({ ...reference, credentialScope: topDocumentScope })),
		RESOURCE_FETCH_LIMITS,
	)
	const built = buildMhtmlDocument(capture, acquired.resources, canvasContentIdPrefix)

	for (const diagnostic of [...acquired.diagnostics, ...built.diagnostics]) {
		console.warn('ArchiveBridge: diagnostic while capturing', diagnostic)
	}

	return serializeMhtml(built.document)
}
