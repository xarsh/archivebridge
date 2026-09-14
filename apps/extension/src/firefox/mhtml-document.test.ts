/**
 * The archive half of a Firefox capture, asserted with no browser
 * anywhere.
 *
 * `buildMhtmlDocument` is pure, so everything about what a capture *becomes*
 * — which parts exist, what identifies them, whether the canvas `cid:` link
 * resolves, whether the bytes parse, render and convert — is testable here
 * rather than only through a real Firefox. What is *not* testable here is
 * everything that needs a live DOM: the form-state policy, the canvas
 * replacement, shadow-root serialization. Those are the Firefox E2E lane's
 * subject, against a real page, because a fake DOM would only prove this
 * file's idea of one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMhtml, parseWebArchive, renderMhtml, serializeMhtml } from '@xarsh/archivebridge'
import { archiveBytesFrom } from '../core/archive-bytes.ts'
import { type AcquiredResource, buildMhtmlDocument, CaptureAssemblyError } from './mhtml-document.ts'
import type { PageCaptureResult } from './page-capture.ts'

const PAGE_URL = 'https://example.invalid/page'
const CANVAS_PREFIX = 'canvas-11111111-2222-3333-4444-555555555555@archivebridge'

/** A 1x1 PNG, valid enough for the library to carry and for a test to compare byte for byte. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

function capture(overrides: Partial<PageCaptureResult> = {}): PageCaptureResult {
	return {
		url: PAGE_URL,
		mimeType: 'text/html',
		title: 'page',
		html: `<!DOCTYPE html>\n<html lang="en"><head><title>page</title><link rel="stylesheet" href="/style.css"></head><body><img src="/image.png" alt=""><img src="cid:${encodeURIComponent(`${CANVAS_PREFIX}-0`)}" style="width:64px;height:16px" alt=""></body></html>`,
		networkResources: [],
		canvases: [{ contentId: `${CANVAS_PREFIX}-0`, cidUrl: `cid:${encodeURIComponent(`${CANVAS_PREFIX}-0`)}`, bytes: PNG_BYTES }],
		blobs: [{ url: 'blob:https://example.invalid/9c8d', contentType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') }],
		notes: [],
		...overrides,
	}
}

const RESOURCES: readonly AcquiredResource[] = [
	{ url: 'https://example.invalid/style.css', mimeType: 'text/css', textEncoding: 'utf-8', bytes: new TextEncoder().encode('body{color:red}') },
	{ url: 'https://example.invalid/image.png', mimeType: 'image/png', textEncoding: undefined, bytes: PNG_BYTES },
]

test('root identity is the page itself', () => {
	const built = buildMhtmlDocument(capture(), RESOURCES, CANVAS_PREFIX)
	assert.equal(built.document.rootPartIndex, 0)
	const root = built.document.parts[0]
	assert.equal(root?.location, PAGE_URL)
	assert.equal(root?.mimeType, 'text/html')
	// The snapshot is written with `TextEncoder`, so the part has to say UTF-8
	// whatever the original page's encoding was.
	assert.equal(root?.textEncoding, 'utf-8')
})

test('acquired resources, blob bytes and canvas pixels each become one part, identified the way they can be', () => {
	const built = buildMhtmlDocument(capture(), RESOURCES, CANVAS_PREFIX)
	assert.deepEqual(
		built.document.parts.map((part) => part.location),
		[PAGE_URL, 'https://example.invalid/style.css', 'https://example.invalid/image.png', 'blob:https://example.invalid/9c8d', undefined],
	)
	// The canvas is the one part with no URL to be addressed by, so it is
	// addressed by Content-ID and referenced as `cid:` — which is also what
	// makes it work through the ordinary conversion machinery, with no
	// canvas-specific metadata anywhere.
	const canvasPart = built.document.parts[4]
	assert.equal(canvasPart?.contentId, `${CANVAS_PREFIX}-0`)
	assert.equal(canvasPart?.mimeType, 'image/png')
	assert.deepEqual(canvasPart?.data, PNG_BYTES)
	assert.deepEqual(built.diagnostics, [])
})

test('the assembled document serializes and parses back with no diagnostics', () => {
	const built = buildMhtmlDocument(capture(), RESOURCES, CANVAS_PREFIX)
	const parsed = parseMhtml(serializeMhtml(built.document))
	assert.deepEqual(parsed.diagnostics, [])
	assert.equal(parsed.document?.parts.length, 5)
	assert.equal(parsed.document?.parts[parsed.document.rootPartIndex]?.location, PAGE_URL)
})

test('the canvas reference resolves from the archive rather than pointing at nothing', () => {
	const built = buildMhtmlDocument(capture(), RESOURCES, CANVAS_PREFIX)
	const parsed = parseMhtml(serializeMhtml(built.document))
	assert.notEqual(parsed.document, undefined)
	if (parsed.document === undefined) {
		return
	}
	const minted: string[] = []
	const rendered = renderMhtml(parsed.document, {
		createResourceUrl: (bytes, mimeType) => {
			minted.push(mimeType)
			return `resource:${minted.length}:${bytes.byteLength}`
		},
	})
	assert.deepEqual(
		rendered.warnings.filter((warning) => warning.type === 'unresolved-reference'),
		[],
	)
	assert.ok(minted.includes('image/png'), 'the canvas PNG was never minted as a resource, so the cid: reference did not resolve')
})

test('a canvas whose claimed identity is not the one that was minted is dropped, not written', () => {
	const tampered = capture({
		canvases: [{ contentId: 'canvas-somebody-elses@example', cidUrl: 'cid:canvas-somebody-elses@example', bytes: PNG_BYTES }],
	})
	const built = buildMhtmlDocument(tampered, [], CANVAS_PREFIX)
	assert.deepEqual(
		built.document.parts.map((part) => part.contentId),
		[undefined, undefined],
	)
	assert.deepEqual(built.diagnostics, [{ type: 'unresolved-resource', url: 'cid:canvas-somebody-elses@example' }])
})

test('a resource URL that cannot be written into a MIME header is reported, not handed to the serializer', () => {
	const built = buildMhtmlDocument(
		capture({ canvases: [], blobs: [] }),
		[{ url: 'https://example.invalid/café', mimeType: 'image/png', textEncoding: undefined, bytes: PNG_BYTES }],
		CANVAS_PREFIX,
	)
	assert.equal(built.document.parts.length, 1)
	assert.equal(built.diagnostics[0]?.type, 'malformed-resource')
	// The whole point: this would otherwise throw out of `serializeMhtml` and
	// take the entire save with it.
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test('two resources claiming one URL produce one part and a diagnostic', () => {
	const duplicated: readonly AcquiredResource[] = [RESOURCES[0] as AcquiredResource, RESOURCES[0] as AcquiredResource]
	const built = buildMhtmlDocument(capture({ canvases: [], blobs: [] }), duplicated, CANVAS_PREFIX)
	assert.equal(built.document.parts.length, 2)
	assert.deepEqual(built.diagnostics, [{ type: 'duplicate-content-location', url: 'https://example.invalid/style.css' }])
})

test('a blob’s Content-Type is split into a media type and a charset, not used as one', () => {
	// `new Blob([…], { type: 'text/plain;charset=utf-8' })` is ordinary page
	// code, and its blob response repeats that header verbatim. Passing the
	// whole thing through as a media type made `serializeMhtml` throw, which
	// loses the entire save rather than one resource.
	const built = buildMhtmlDocument(
		capture({
			canvases: [],
			blobs: [
				{ url: 'blob:https://example.invalid/typed', contentType: 'text/plain;charset=utf-8', bytes: new TextEncoder().encode('hello') },
				// A blob created with no type reports an empty header, not an absent one.
				{ url: 'blob:https://example.invalid/typeless', contentType: '', bytes: new TextEncoder().encode('bytes') },
				{ url: 'blob:https://example.invalid/hostile', contentType: 'text/plain/../../etc', bytes: new TextEncoder().encode('bytes') },
			],
		}),
		[],
		CANVAS_PREFIX,
	)
	assert.deepEqual(
		built.document.parts.slice(1).map((part) => [part.mimeType, part.textEncoding]),
		[
			['text/plain', 'utf-8'],
			['application/octet-stream', undefined],
			['application/octet-stream', undefined],
		],
	)
	assert.deepEqual(built.diagnostics, [])
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test('a media type that cannot be written loses its resource, never the save', () => {
	// The producers upstream already fall back, so this is the backstop: the
	// boundary that builds a part enforces the serializer's own rule itself.
	const built = buildMhtmlDocument(
		capture({ canvases: [], blobs: [] }),
		[
			{ url: 'https://example.invalid/a.css', mimeType: 'text/css/garbage', textEncoding: undefined, bytes: PNG_BYTES },
			{ url: 'https://example.invalid/b.css', mimeType: '', textEncoding: undefined, bytes: PNG_BYTES },
			{ url: 'https://example.invalid/c.css', mimeType: 'text/css', textEncoding: undefined, bytes: PNG_BYTES },
		],
		CANVAS_PREFIX,
	)
	assert.deepEqual(
		built.document.parts.map((part) => part.location),
		[PAGE_URL, 'https://example.invalid/c.css'],
	)
	assert.deepEqual(
		built.diagnostics.map((diagnostic) => diagnostic.type),
		['malformed-resource', 'malformed-resource'],
	)
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test('a document whose own content type is not a media type still produces a writable root', () => {
	const built = buildMhtmlDocument(capture({ mimeType: 'text/html/x', canvases: [], blobs: [] }), [], CANVAS_PREFIX)
	assert.equal(built.document.parts[0]?.mimeType, 'text/html')
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test("the page's own notes come back as diagnostics rather than being swallowed", () => {
	const built = buildMhtmlDocument(capture({ canvases: [], blobs: [], notes: [{ kind: 'canvas-unreadable', detail: 'SecurityError' }] }), [], CANVAS_PREFIX)
	assert.deepEqual(built.diagnostics, [{ type: 'unsupported-feature', feature: 'canvas pixels could not be read (SecurityError)' }])
})

test('every limit the injected capture can reach is reported, and none of them is a failure', () => {
	const notes = [
		{ kind: 'resource-limit-reached', detail: 'too many references' },
		{ kind: 'blob-limit-reached', detail: 'too many blobs' },
		{ kind: 'blob-too-large', detail: 'one enormous blob' },
		{ kind: 'canvas-limit-reached', detail: 'too many pixels' },
		{ kind: 'capture-byte-limit-reached', detail: 'budget spent' },
	] as const
	const built = buildMhtmlDocument(capture({ canvases: [], blobs: [], notes }), [], CANVAS_PREFIX)
	assert.deepEqual(
		built.diagnostics,
		notes.map((note) => ({ type: 'unsupported-feature', feature: note.detail })),
	)
	// The page itself is still archived: a limit costs a resource, not a save.
	assert.equal(built.document.parts.length, 1)
	assert.doesNotThrow(() => serializeMhtml(built.document))
})

test('a page URL that cannot be written fails the capture outright rather than producing a rootless archive', () => {
	assert.throws(() => buildMhtmlDocument(capture({ url: 'https://example.invalid/日' }), [], CANVAS_PREFIX), CaptureAssemblyError)
})

test('the assembled bytes go through the same archiveBytesFrom seam Chrome uses, in both formats', () => {
	const built = buildMhtmlDocument(capture(), RESOURCES, CANVAS_PREFIX)
	const bytes = serializeMhtml(built.document)

	const mhtml = archiveBytesFrom(bytes, 'mhtml')
	assert.deepEqual(mhtml.bytes, bytes, 'the MHTML path must pass ArchiveBridge-authored bytes through untouched')
	assert.equal(mhtml.pageUrl, PAGE_URL)
	assert.equal(mhtml.fileName, 'page.mhtml')

	const webarchive = archiveBytesFrom(bytes, 'webarchive')
	const parsed = parseWebArchive(webarchive.bytes)
	assert.equal(parsed.document?.mainResource.url, PAGE_URL)
	// The canvas had no URL in MHTML; conversion gives it one in the
	// synthetic Content-ID namespace and rewrites the reference to match, so
	// the linkage survives semantically even though the `cid:` spelling does
	// not.
	const canvasResource = (parsed.document?.subresources ?? []).find((resource) => resource.url.includes('content-id.archivebridge.invalid'))
	assert.notEqual(canvasResource, undefined, 'the canvas PNG lost its identity on conversion')
	assert.deepEqual(canvasResource?.data, PNG_BYTES)
	const mainHtml = new TextDecoder().decode(parsed.document?.mainResource.data ?? new Uint8Array())
	assert.ok(mainHtml.includes(canvasResource?.url ?? 'missing'), 'the converted markup does not point at the converted canvas resource')
})
