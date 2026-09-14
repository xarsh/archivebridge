/**
 * The world boundary, given the shapes a page can actually put through it.
 *
 * `asPageCaptureResult` is where a value that came back from
 * `scripting.executeScript` stops being `unknown`. Everything downstream of
 * it — `acquireResources`, `buildMhtmlDocument`, `serializeMhtml` — is
 * written against `PageCaptureResult` and is entitled to believe it, so
 * every shape that boundary lets through is a shape the rest of the capture
 * has to survive.
 *
 * The E2E lane exercises the same boundary against a *real* Firefox, which
 * is the right place to prove the ordinary case crosses intact and the
 * wrong place to prove the hostile ones do not: a real page returns what
 * the injected function returned, and the values worth testing here are the
 * ones it never would. So these are direct calls, with the value that
 * arrives at the boundary written out in full.
 *
 * The rule every case below is a form of: **no value from the page may fail
 * the save except by the boundary deliberately failing it.** A
 * `CaptureFailedError` is a decision; a `TypeError` from calling `.filter()`
 * on something that turned out to be a string is not.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeMhtml } from '@xarsh/archivebridge'
import { asPageCaptureResult, CaptureFailedError } from './capture.ts'
import { buildMhtmlDocument } from './mhtml-document.ts'

const PAGE_URL = 'https://example.invalid/page'
const CANVAS_PREFIX = 'canvas-11111111-2222-3333-4444-555555555555@archivebridge'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A capture result as the injected function really produces one, with whatever a case is about spliced into it. */
function returned(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		url: PAGE_URL,
		mimeType: 'text/html',
		title: 'page',
		html: '<html lang="en"><head><title>page</title></head><body></body></html>',
		networkResources: [{ url: 'https://example.invalid/a.png', kind: 'image' }],
		canvases: [{ contentId: `${CANVAS_PREFIX}-0`, cidUrl: `cid:${encodeURIComponent(`${CANVAS_PREFIX}-0`)}`, bytes: PNG_BYTES }],
		blobs: [{ url: 'blob:https://example.invalid/9c8d', contentType: 'image/svg+xml', bytes: PNG_BYTES }],
		notes: [{ kind: 'canvas-unreadable', detail: 'SecurityError' }],
		...overrides,
	}
}

test('an ordinary capture result crosses the boundary intact', () => {
	const narrowed = asPageCaptureResult(returned())
	assert.equal(narrowed.url, PAGE_URL)
	assert.equal(narrowed.title, 'page')
	assert.deepEqual(narrowed.networkResources, [{ url: 'https://example.invalid/a.png', kind: 'image' }])
	assert.equal(narrowed.canvases.length, 1)
	assert.equal(narrowed.blobs.length, 1)
	assert.deepEqual(narrowed.notes, [{ kind: 'canvas-unreadable', detail: 'SecurityError' }])
})

test('the top-level shape is a decision, not a crash', () => {
	for (const value of [undefined, null, 'a string', 42, []]) {
		assert.throws(() => asPageCaptureResult(value), CaptureFailedError, `${JSON.stringify(value)} should have been refused deliberately`)
	}
	for (const field of ['url', 'mimeType', 'title', 'html']) {
		assert.throws(() => asPageCaptureResult(returned({ [field]: 7 })), CaptureFailedError, `a non-string ${field} should have been refused`)
	}
})

test('a collection that is not a list fails the capture rather than throwing a TypeError out of the narrowing', () => {
	// The injected function returns four arrays, always. Anything else is not
	// a capture result missing a field, it is not a capture result — and
	// `(candidate.networkResources ?? []).filter(...)` used to answer it with
	// a bare `TypeError` from inside the very function that exists to stop
	// page-shaped values reaching the archive builder.
	for (const field of ['networkResources', 'canvases', 'blobs', 'notes']) {
		for (const value of ['blob:https://example.invalid/1', { length: 3 }, 0, null]) {
			const error = (() => {
				try {
					asPageCaptureResult(returned({ [field]: value }))
					return undefined
				} catch (thrown) {
					return thrown
				}
			})()
			assert.ok(error instanceof CaptureFailedError, `${field} as ${JSON.stringify(value)} threw ${String(error)} instead of a CaptureFailedError`)
		}
	}
})

test('a member that is not what it claims is dropped, and the rest of the capture is kept', () => {
	const narrowed = asPageCaptureResult(
		returned({
			networkResources: [
				{ url: 'https://example.invalid/a.png', kind: 'image' },
				// Every field of a reference, wrong in turn.
				{ url: 'https://example.invalid/b.png', kind: 'script' },
				{ url: 42, kind: 'image' },
				{ kind: 'stylesheet' },
				'https://example.invalid/c.png',
				null,
				undefined,
			],
			canvases: [
				{ contentId: `${CANVAS_PREFIX}-0`, cidUrl: `cid:${encodeURIComponent(`${CANVAS_PREFIX}-0`)}`, bytes: PNG_BYTES },
				{ contentId: `${CANVAS_PREFIX}-1`, cidUrl: 'cid:whatever', bytes: 'not bytes' },
				{ contentId: `${CANVAS_PREFIX}-2`, bytes: PNG_BYTES },
				{ cidUrl: 'cid:x', bytes: PNG_BYTES },
				// An `ArrayBuffer` is not a `Uint8Array`, and `serializeMhtml` reads
				// `byteLength` off whatever it is handed.
				{ contentId: `${CANVAS_PREFIX}-3`, cidUrl: 'cid:y', bytes: new ArrayBuffer(8) },
				'cid:z',
			],
			blobs: [
				{ url: 'blob:https://example.invalid/9c8d', contentType: 'image/svg+xml', bytes: PNG_BYTES },
				{ url: 'blob:https://example.invalid/bad', contentType: 'image/png', bytes: [1, 2, 3] },
				{ url: 'blob:https://example.invalid/typeless', bytes: PNG_BYTES },
				{ contentType: 'image/png', bytes: PNG_BYTES },
				7,
			],
			notes: [
				{ kind: 'canvas-unreadable', detail: 'SecurityError' },
				// A kind no build knows maps to no diagnostic, so it is dropped
				// rather than becoming a hole in the diagnostics list.
				{ kind: 'invented-by-the-page', detail: 'anything' },
				{ kind: 'blob-unreadable', detail: 42 },
				{ detail: 'kindless' },
				'canvas-unreadable',
			],
		}),
	)

	assert.deepEqual(narrowed.networkResources, [{ url: 'https://example.invalid/a.png', kind: 'image' }])
	assert.deepEqual(
		narrowed.canvases.map((canvas) => canvas.contentId),
		[`${CANVAS_PREFIX}-0`],
	)
	assert.deepEqual(
		narrowed.blobs.map((blob) => blob.url),
		['blob:https://example.invalid/9c8d'],
	)
	assert.deepEqual(narrowed.notes, [{ kind: 'canvas-unreadable', detail: 'SecurityError' }])
})

test('what crosses is rebuilt, so nothing rides along on an object that passed a check', () => {
	const narrowed = asPageCaptureResult(
		returned({
			networkResources: [{ url: 'https://example.invalid/a.png', kind: 'image', credentials: 'include', toString: 'hostile' }],
			notes: [{ kind: 'canvas-unreadable', detail: 'SecurityError', extra: 'hostile' }],
		}),
	)
	assert.deepEqual(Object.keys(narrowed.networkResources[0] ?? {}).sort(), ['kind', 'url'])
	assert.deepEqual(Object.keys(narrowed.notes[0] ?? {}).sort(), ['detail', 'kind'])
})

test('a canvas cannot name its own media type, so it cannot name one that loses the save', () => {
	// The page claiming a media type for its canvas pixels used to be taken at
	// face value and written into an `MhtmlPart`, where `serializeMhtml`
	// throws on anything that is not an RFC 2045 `token "/" token` — which
	// costs the whole save, not one canvas. The boundary now drops the claim
	// and the archive builder writes the one value the pixels can possibly be.
	const contentId = `${CANVAS_PREFIX}-0`
	const narrowed = asPageCaptureResult(
		returned({
			canvases: [{ contentId, cidUrl: `cid:${encodeURIComponent(contentId)}`, mimeType: 'text/html/../../etc', bytes: PNG_BYTES }],
			blobs: [],
			notes: [],
		}),
	)
	assert.deepEqual(Object.keys(narrowed.canvases[0] ?? {}).sort(), ['bytes', 'cidUrl', 'contentId'])

	const built = buildMhtmlDocument(narrowed, [], CANVAS_PREFIX)
	const canvasPart = built.document.parts.find((part) => part.contentId === contentId)
	assert.equal(canvasPart?.mimeType, 'image/png')
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test('a hostile capture result still produces an archive, once it has been through the boundary', () => {
	// The end-to-end form of the rule: whatever the page returned, what comes
	// out of the boundary is something the archive builder and the serializer
	// can both accept.
	const narrowed = asPageCaptureResult(
		returned({
			networkResources: ['not a reference', { url: 'file:///etc/passwd', kind: 'image' }],
			canvases: [{ contentId: 'somebody-elses', cidUrl: 'cid:somebody-elses', bytes: PNG_BYTES }],
			blobs: [{ url: 'blob:https://example.invalid/9c8d', contentType: 'text/plain;charset=utf-8', bytes: PNG_BYTES }],
			notes: [{ kind: 'not-a-kind', detail: 'x' }],
		}),
	)
	const built = buildMhtmlDocument(narrowed, [], CANVAS_PREFIX)
	assert.doesNotThrow(() => serializeMhtml(built.document))
	// The canvas claimed an identity nobody minted, so it is reported and left
	// out rather than written as a part nothing can reach.
	assert.deepEqual(built.diagnostics, [{ type: 'unresolved-resource', url: 'cid:somebody-elses' }])
})
