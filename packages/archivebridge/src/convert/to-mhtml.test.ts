import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodePartText, findFrameRootReferences } from '../mhtml/frames.ts'
import { findSidecarPart, parseSidecarPart } from '../mhtml/sidecar.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument } from '../model/mhtml.ts'
import { RESERVED_DOCUMENT_KEYS, RESERVED_RESOURCE_KEYS, type WebArchiveDocument, type WebArchiveResource } from '../model/webarchive.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { convertWebArchiveToMhtml } from './to-mhtml.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/webarchive/${name}`, import.meta.url))
	return readFileSync(path)
}

function resource(overrides: Partial<WebArchiveResource> = {}): WebArchiveResource {
	return {
		url: 'https://example.invalid/',
		mimeType: 'text/html',
		data: new TextEncoder().encode('<html></html>'),
		textEncoding: 'utf-8',
		frameName: undefined,
		response: undefined,
		extra: new Map(),
		...overrides,
	}
}

/** A minimal childless `WebArchiveDocument` wrapping a single main resource, for use as a `subframeArchives` entry. */
function frameDoc(overrides: Partial<WebArchiveResource> = {}): WebArchiveDocument {
	return { mainResource: resource(overrides), subresources: [], subframeArchives: [], extra: new Map() }
}

test('convertWebArchiveToMhtml flattens a document with no frames into a single-part MhtmlDocument', () => {
	const webDoc: WebArchiveDocument = { mainResource: resource(), subresources: [], subframeArchives: [], extra: new Map() }
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [])
	assert.equal(document.parts.length, 1)
	assert.equal(document.parts[document.rootPartIndex]?.location, 'https://example.invalid/')
})

test('convertWebArchiveToMhtml rewrites fixtures/webarchive/frames-nested.safari.webarchive into a flat, cid:-linked MhtmlDocument', () => {
	const { document: webDoc } = parseWebArchive(loadFixture('frames-nested.safari.webarchive'))
	assert.ok(webDoc)

	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)
	assert.deepEqual(diagnostics, [])

	// root + its stylesheet + level2 + level2's stylesheet + level3 = 5 parts, no sidecar
	// needed here (WebResourceResponse is present on subresources though, so a sidecar part
	// is expected too).
	const htmlParts = document.parts.filter((part) => part.mimeType === 'text/html')
	assert.equal(htmlParts.length, 3)

	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	const rootHtml = decodePartText(root)
	assert.match(rootHtml, /src="cid:/)
	assert.doesNotMatch(rootHtml, /level2\.html/)

	const adjacency = findFrameRootReferences(document, [])
	const rootChildren = adjacency.get(document.rootPartIndex)
	assert.equal(rootChildren?.length, 1)
	const level2 = document.parts[rootChildren?.[0] ?? -1]
	assert.equal(level2?.location, 'http://127.0.0.1:8091/case-b/level2.html')

	const level2Children = adjacency.get(rootChildren?.[0] ?? -1)
	assert.equal(level2Children?.length, 1)
	assert.equal(document.parts[level2Children?.[0] ?? -1]?.location, 'http://127.0.0.1:8091/case-b/level3.html')

	// A sidecar part must exist: subresources carry WebResourceResponse, and frame-root
	// resources carry WebResourceFrameName.
	const found = findSidecarPart(document, [])
	assert.ok(found, 'expected a metadata sidecar part')
	const sidecar = parseSidecarPart(found.part, [])
	assert.ok(sidecar)
	assert.equal(sidecar.get(root.contentId ?? '')?.webResourceFrameName, '')
})

test('convertWebArchiveToMhtml reports unresolved-resource for an iframe that does not match any captured subframe', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ data: new TextEncoder().encode('<iframe src="https://uncaptured.invalid/child.html"></iframe>') }),
		subresources: [],
		subframeArchives: [],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [{ type: 'unresolved-resource', url: 'https://uncaptured.invalid/child.html' }])
	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	assert.match(decodePartText(root), /src="https:\/\/uncaptured\.invalid\/child\.html"/)
})

test('convertWebArchiveToMhtml preserves original bytes/encoding for an HTML document with no iframes to rewrite', () => {
	const html = '<html><body>plain, no frames</body></html>'
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ data: new TextEncoder().encode(html), textEncoding: 'iso-8859-1' }),
		subresources: [],
		subframeArchives: [],
		extra: new Map(),
	}
	const { document } = convertWebArchiveToMhtml(webDoc)

	const root = document.parts[document.rootPartIndex]
	assert.deepEqual(root?.data, new TextEncoder().encode(html))
	assert.equal(root?.textEncoding, 'iso-8859-1')
})

/** Encodes `text` as raw ISO-8859-1/windows-1252-compatible bytes (byte value == code point, valid for any string whose characters are all U+0000-U+00FF), without pulling in a charset codec dependency just for test fixture construction. */
function encodeLatin1(text: string): Uint8Array {
	return Uint8Array.from(text, (ch) => {
		const code = ch.codePointAt(0)
		if (code === undefined || code > 0xff) {
			throw new Error(`encodeLatin1: ${JSON.stringify(ch)} is outside the Latin-1 byte range`)
		}
		return code
	})
}

test('convertWebArchiveToMhtml preserves a non-UTF-8 declared encoding (and non-ASCII bytes) when an iframe rewrite actually happens', () => {
	const html = '<html><body>café <iframe src="child.html"></iframe></body></html>'
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: encodeLatin1(html), textEncoding: 'iso-8859-1' }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://example.invalid/child.html' })],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [])
	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	// textEncoding must stay iso-8859-1 — not silently promoted to utf-8 just because a rewrite happened.
	assert.equal(root.textEncoding, 'iso-8859-1')
	const decoded = Array.from(root.data, (byte) => String.fromCharCode(byte)).join('')
	assert.match(decoded, /café <iframe src="cid:/)
	// The café text itself must still decode to the same non-ASCII character, not mojibake from a UTF-8 misinterpretation.
	assert.ok(decoded.includes('café'))
})

test('convertWebArchiveToMhtml degrades non-destructively (diagnostic, unmodified bytes) when the declared encoding cannot be safely re-encoded after a rewrite', () => {
	const html = '<iframe src="child.html"></iframe>'
	const originalBytes = encodeLatin1(html)
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: originalBytes, textEncoding: 'x-totally-fake-charset-not-real' }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://example.invalid/child.html' })],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	// The rewrite is refused entirely (not just the re-encode step), so the captured child is
	// never linked via cid: either — it's still emitted as a part (see the next assertion), just
	// reported as unconsumed since nothing in the parent's HTML ended up referencing it.
	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'x-totally-fake-charset-not-real' },
		{ type: 'unconsumed-child-frame', url: 'https://example.invalid/child.html' },
	])
	const root = document.parts[document.rootPartIndex]
	// The rewrite could not be safely applied, so the original bytes/encoding are kept as-is
	// rather than corrupting them or silently falling back to UTF-8.
	assert.deepEqual(root?.data, originalBytes)
	assert.equal(root?.textEncoding, 'x-totally-fake-charset-not-real')
	// The child's resource data is still present as its own MHTML part — a refused rewrite must
	// not drop the captured resource, only fail to link it.
	assert.equal(document.parts.length, 2)
})

test('convertWebArchiveToMhtml matches same-URL sibling frames one-to-one (same bytes) instead of collapsing both iframes onto one child', () => {
	const html = '<iframe src="same.html"></iframe><iframe src="same.html"></iframe>'
	const child = frameDoc({ url: 'https://example.invalid/same.html', data: new TextEncoder().encode('<p>shared</p>') })
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: new TextEncoder().encode(html) }),
		subresources: [],
		subframeArchives: [child, child],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [])
	const htmlParts = document.parts.filter((part) => part.mimeType === 'text/html')
	// main + 2 distinct flattened children (even though same URL and same bytes, these are two
	// separate captured MIME entities and must not collapse into one part referenced twice).
	assert.equal(htmlParts.length, 3)

	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	const cids = [...decodePartText(root).matchAll(/src="cid:([^"]+)"/g)].map((m) => decodeURIComponent(m[1] ?? ''))
	assert.equal(cids.length, 2)
	assert.notEqual(cids[0], cids[1])
	assert.ok(cids.every((cid) => htmlParts.some((part) => part.contentId === cid)))
})

test('convertWebArchiveToMhtml matches same-URL sibling frames one-to-one (different bytes) instead of collapsing both iframes onto one child', () => {
	const html = '<iframe src="same.html"></iframe><iframe src="same.html"></iframe>'
	const childA = frameDoc({ url: 'https://example.invalid/same.html', data: new TextEncoder().encode('<p>first</p>') })
	const childB = frameDoc({ url: 'https://example.invalid/same.html', data: new TextEncoder().encode('<p>second</p>') })
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: new TextEncoder().encode(html) }),
		subresources: [],
		subframeArchives: [childA, childB],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [])
	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	const cids = [...decodePartText(root).matchAll(/src="cid:([^"]+)"/g)].map((m) => decodeURIComponent(m[1] ?? ''))
	assert.equal(cids.length, 2)
	assert.notEqual(cids[0], cids[1])

	const partByContentId = new Map(document.parts.filter((part) => part.contentId !== undefined).map((part) => [part.contentId, part]))
	assert.deepEqual(partByContentId.get(cids[0] ?? '')?.data, childA.mainResource.data)
	assert.deepEqual(partByContentId.get(cids[1] ?? '')?.data, childB.mainResource.data)
})

test('convertWebArchiveToMhtml reports unresolved-resource (without reusing an already-consumed child) when there are more same-URL iframes than captured subframes', () => {
	const html = '<iframe src="same.html"></iframe><iframe src="same.html"></iframe>'
	const child = frameDoc({ url: 'https://example.invalid/same.html' })
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: new TextEncoder().encode(html) }),
		subresources: [],
		subframeArchives: [child],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [{ type: 'unresolved-resource', url: 'https://example.invalid/same.html' }])
	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	const rootHtml = decodePartText(root)
	// The first occurrence is linked via cid:, the second (with no remaining candidate) is left
	// exactly as it was in the original markup rather than reusing the first child's cid:.
	const matches = [...rootHtml.matchAll(/<iframe src="([^"]+)">/g)].map((m) => m[1])
	assert.equal(matches.length, 2)
	assert.match(matches[0] ?? '', /^cid:/)
	assert.equal(matches[1], 'same.html')
})

test('convertWebArchiveToMhtml refuses to rewrite (unsupported-encoding, unconsumed-child-frame, unmodified bytes) when the original UTF-8 bytes have a BOM that decode/encode cannot preserve', () => {
	const bom = new Uint8Array([0xef, 0xbb, 0xbf])
	const html = '<iframe src="child.html"></iframe>'
	const originalBytes = new Uint8Array([...bom, ...new TextEncoder().encode(html)])
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: originalBytes, textEncoding: 'utf-8' }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://example.invalid/child.html' })],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'utf-8' },
		{ type: 'unconsumed-child-frame', url: 'https://example.invalid/child.html' },
	])
	const root = document.parts[document.rootPartIndex]
	assert.deepEqual(root?.data, originalBytes)
	// The captured child is still present as its own part, just unlinked.
	assert.equal(document.parts.filter((part) => part.mimeType === 'text/html').length, 2)
})

test('convertWebArchiveToMhtml refuses to rewrite (unsupported-encoding) when the original bytes contain a malformed byte sequence decode/encode cannot preserve', () => {
	// Build the bytes by hand: a lone 0xFF (never valid anywhere in UTF-8) inside an HTML comment,
	// which `TextDecoder`'s lenient UTF-8 decode replaces with U+FFFD on decode — a replacement
	// that does not re-encode back to the original 0xFF byte.
	const prefix = new TextEncoder().encode('<!--')
	const suffix = new TextEncoder().encode('--><iframe src="child.html"></iframe>')
	const originalBytes = new Uint8Array([...prefix, 0xff, ...suffix])
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/', data: originalBytes, textEncoding: 'utf-8' }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://example.invalid/child.html' })],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'utf-8' },
		{ type: 'unconsumed-child-frame', url: 'https://example.invalid/child.html' },
	])
	const root = document.parts[document.rootPartIndex]
	assert.deepEqual(root?.data, originalBytes)
})

test('convertWebArchiveToMhtml resolves a relative iframe src against <base href>, not the document URL', () => {
	const html = '<html><head><base href="https://cdn.invalid/assets/"></head><body><iframe src="child.html"></iframe></body></html>'
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/page.html', data: new TextEncoder().encode(html) }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://cdn.invalid/assets/child.html' })],
		extra: new Map(),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)

	assert.deepEqual(diagnostics, [])
	const root = document.parts[document.rootPartIndex]
	assert.ok(root)
	assert.match(decodePartText(root), /src="cid:/)
})

// --- Reserved `extra` keys on the hand-constructed-model path ----------------
//
// `convertWebArchiveToMhtml` is public API, so it can receive a
// `WebArchiveDocument` that never came from `parseWebArchive` (which subtracts
// the reserved keys) and never went through `serializeWebArchive` (which
// rejects them). Residual `extra` flows from there into the metadata sidecar,
// whose *reader* rejects reserved keys — so without a matching writer-side
// check, ArchiveBridge would emit a sidecar it later classifies as
// `malformed-metadata-sidecar` and, because that rejection is whole-sidecar,
// silently drop every resource's residual metadata on the way back.

test('convertWebArchiveToMhtml refuses a mainResource whose extra claims a reserved WebArchive key', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ extra: new Map([['WebResourceURL', 'https://impostor.invalid/']]) }),
		subresources: [],
		subframeArchives: [],
		extra: new Map(),
	}
	assert.throws(() => convertWebArchiveToMhtml(webDoc), /reserved WebArchive key "WebResourceURL"/)
})

test('convertWebArchiveToMhtml refuses a subresource whose extra claims a reserved WebArchive key', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [resource({ url: 'https://example.invalid/style.css', mimeType: 'text/css', extra: new Map([['WebResourceData', new Uint8Array([1, 2, 3])]]) })],
		subframeArchives: [],
		extra: new Map(),
	}
	assert.throws(() => convertWebArchiveToMhtml(webDoc), /reserved WebArchive key "WebResourceData"/)
})

test('convertWebArchiveToMhtml refuses a nested frame mainResource whose extra claims a reserved WebArchive key', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ data: new TextEncoder().encode('<iframe src="child.html"></iframe>') }),
		subresources: [],
		subframeArchives: [frameDoc({ url: 'https://example.invalid/child.html', extra: new Map([['WebResourceMIMEType', 'text/plain']]) })],
		extra: new Map(),
	}
	assert.throws(() => convertWebArchiveToMhtml(webDoc), /reserved WebArchive key "WebResourceMIMEType"/)
})

test('convertWebArchiveToMhtml refuses a top-level document whose extra claims a reserved WebArchive key', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [],
		subframeArchives: [],
		extra: new Map([['WebSubresources', []]]),
	}
	assert.throws(() => convertWebArchiveToMhtml(webDoc), /reserved WebArchive key "WebSubresources"/)
})

test('convertWebArchiveToMhtml refuses a nested document whose extra claims a reserved WebArchive key', () => {
	const child: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.invalid/child.html' }),
		subresources: [],
		subframeArchives: [],
		extra: new Map([['WebMainResource', 'not a resource dictionary']]),
	}
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ data: new TextEncoder().encode('<iframe src="child.html"></iframe>') }),
		subresources: [],
		subframeArchives: [child],
		extra: new Map(),
	}
	assert.throws(() => convertWebArchiveToMhtml(webDoc), /reserved WebArchive key "WebMainResource"/)
})

test('convertWebArchiveToMhtml carries ordinary unknown extra keys through to a sidecar its own reader accepts', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ extra: new Map([['WebResourceFutureThing', 'kept']]) }),
		subresources: [resource({ url: 'https://example.invalid/style.css', mimeType: 'text/css', extra: new Map([['SomeOtherKey', 42]]) })],
		subframeArchives: [],
		extra: new Map([['WebDocumentFutureThing', 'also kept']]),
	}
	const { document, diagnostics } = convertWebArchiveToMhtml(webDoc)
	assert.deepEqual(diagnostics, [])

	const sidecarResult = findSidecarPart(document, [])
	assert.ok(sidecarResult)
	const parseDiagnostics: Diagnostic[] = []
	const sidecar = parseSidecarPart(sidecarResult.part, parseDiagnostics)
	assert.deepEqual(parseDiagnostics, [])
	assert.ok(sidecar)

	const rootId = document.parts[document.rootPartIndex]?.contentId
	assert.ok(rootId)
	assert.equal(sidecar.get(rootId)?.resourceExtra?.get('WebResourceFutureThing'), 'kept')
	assert.equal(sidecar.get(rootId)?.documentExtra?.get('WebDocumentFutureThing'), 'also kept')
})

test('every sidecar convertWebArchiveToMhtml emits is one parseSidecarPart accepts, for every reserved key', () => {
	// The end-to-end invariant the checks above exist for: across every reserved
	// resource and document key, this public path either refuses outright or emits a
	// sidecar its own reader parses without a `malformed-metadata-sidecar`
	// diagnostic. It must never do the third thing — emit a sidecar that later
	// parses as malformed, silently discarding all residual metadata.
	const reserved = [...RESERVED_RESOURCE_KEYS, ...RESERVED_DOCUMENT_KEYS]

	for (const key of reserved) {
		for (const placement of ['resource', 'document'] as const) {
			const extra = new Map([[key, 'value']])
			const webDoc: WebArchiveDocument = {
				mainResource: placement === 'resource' ? resource({ extra }) : resource(),
				subresources: [],
				subframeArchives: [],
				extra: placement === 'document' ? extra : new Map(),
			}

			let converted: MhtmlDocument
			try {
				converted = convertWebArchiveToMhtml(webDoc).document
			} catch {
				continue // refused at the writer, which is the acceptable outcome
			}

			const sidecarResult = findSidecarPart(converted, [])
			if (sidecarResult === undefined) {
				continue
			}
			const parseDiagnostics: Diagnostic[] = []
			parseSidecarPart(sidecarResult.part, parseDiagnostics)
			assert.deepEqual(parseDiagnostics, [], `ArchiveBridge emitted a sidecar its own reader rejects for ${placement} extra key ${key}`)
		}
	}
})
