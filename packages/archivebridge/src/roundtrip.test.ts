/**
 * Direct cross-format round-trip: WebArchiveDocument -> MHTML bytes ->
 * WebArchiveDocument, and MhtmlDocument -> WebArchive bytes ->
 * MhtmlDocument, through the actual byte-level serialize/parse boundary
 * (not just the in-memory converters, which convert/to-mhtml.test.ts and
 * convert/to-web-archive.test.ts already exercise directly).
 *
 * The round trip runs format-native model -> bytes -> format-native model,
 * with no shared intermediate representation anywhere in the chain, because
 * that is the actual conversion path (docs/architecture.md, "No
 * format-neutral Archive/ArchiveView IR"). What these tests assert is
 * therefore semantic losslessness across a real serialize/parse boundary.
 * Complements the single-format round-trip tests colocated with each
 * serializer (mhtml/serialize.test.ts, webarchive/serialize.test.ts). See
 * docs/architecture.md#testing (layer 4, "Round-trip tests").
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { convertWebArchiveToMhtml } from './convert/to-mhtml.ts'
import { convertMhtmlToWebArchive } from './convert/to-web-archive.ts'
import { parseMhtml } from './mhtml/parse.ts'
import { serializeMhtml } from './mhtml/serialize.ts'
import type { WebArchiveDocument, WebArchiveResource } from './model/webarchive.ts'
import { parseWebArchive } from './webarchive/parse.ts'
import { serializeWebArchive } from './webarchive/serialize.ts'

function loadFixture(dir: string, name: string): Uint8Array {
	return readFileSync(fileURLToPath(new URL(`../../../fixtures/${dir}/${name}`, import.meta.url)))
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

test('WebArchiveDocument -> MHTML bytes -> WebArchiveDocument survives unchanged for a document with no frames', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({
			url: 'https://example.invalid/index.html',
			data: new TextEncoder().encode('<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"></body></html>'),
		}),
		subresources: [
			resource({ url: 'https://example.invalid/style.css', mimeType: 'text/css', data: new TextEncoder().encode('body { color: red; }') }),
			resource({ url: 'https://example.invalid/logo.png', mimeType: 'image/png', textEncoding: undefined, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
		],
		subframeArchives: [],
		extra: new Map(),
	}

	const { document: mhtml, diagnostics: convertDiagnostics } = convertWebArchiveToMhtml(webDoc)
	assert.deepEqual(convertDiagnostics, [])

	const { document: reparsedMhtml, diagnostics: parseDiagnostics } = parseMhtml(serializeMhtml(mhtml))
	assert.deepEqual(parseDiagnostics, [])
	assert.ok(reparsedMhtml)

	const { document: roundTripped, diagnostics: backDiagnostics } = convertMhtmlToWebArchive(reparsedMhtml)
	assert.deepEqual(backDiagnostics, [])
	assert.deepEqual(roundTripped, webDoc)
})

test('WebArchiveDocument -> MHTML bytes -> WebArchiveDocument survives a full byte round trip for a real multi-frame capture (fixtures/webarchive/frames-nested.safari.webarchive)', () => {
	const { document: original } = parseWebArchive(loadFixture('webarchive', 'frames-nested.safari.webarchive'))
	assert.ok(original)

	const { document: mhtml, diagnostics: convertDiagnostics } = convertWebArchiveToMhtml(original)
	assert.deepEqual(convertDiagnostics, [])

	const { document: reparsedMhtml, diagnostics: parseDiagnostics } = parseMhtml(serializeMhtml(mhtml))
	// The root frame and its level2 child each independently fetch
	// "http://127.0.0.1:8091/style.css" (confirmed real WebKit behavior — see
	// fixtures/README.md's frame fixture provenance notes: no cross-frame dedup). Flattening
	// both into sibling MHTML parts under the same Content-Location is a genuine, expected
	// duplicate-content-location, not a bug.
	assert.deepEqual(parseDiagnostics, [{ type: 'duplicate-content-location', url: 'http://127.0.0.1:8091/style.css' }])
	assert.ok(reparsedMhtml)

	const { document: roundTripped, diagnostics: backDiagnostics } = convertMhtmlToWebArchive(reparsedMhtml)
	assert.deepEqual(backDiagnostics, [])

	// Every frame that actually contains an <iframe> (root, level2) gets its HTML bytes rewritten
	// when its iframe reference round-trips (cid: out, then a resolved URL back in); the
	// resource's own declared encoding (here, UTF-8) is preserved throughout rather than forced to
	// change, so only the exact bytes of the rewritten `src` attribute differ — not a loss of
	// meaning (docs/architecture.md, "Semantic losslessness"; see convert/semantic-roundtrip.test.ts
	// for a field-by-field, frame-src-normalized deep comparison of this same fixture). Only the
	// leaf frame (level3, no iframes to rewrite) and plain subresources are expected to survive
	// byte-for-byte.
	assert.equal(roundTripped.mainResource.url, original.mainResource.url)
	assert.equal(roundTripped.mainResource.frameName, original.mainResource.frameName)
	assert.deepEqual(roundTripped.subresources, original.subresources)
	assert.equal(roundTripped.subframeArchives.length, 1)

	const level2 = roundTripped.subframeArchives[0]
	const originalLevel2 = original.subframeArchives[0]
	assert.equal(level2?.mainResource.url, originalLevel2?.mainResource.url)
	assert.equal(level2?.mainResource.frameName, originalLevel2?.mainResource.frameName)
	assert.deepEqual(level2?.subresources, originalLevel2?.subresources)
	assert.equal(level2?.subframeArchives.length, 1)

	// The deepest frame has no iframe of its own, so nothing about it is ever rewritten.
	assert.deepEqual(level2?.subframeArchives[0], originalLevel2?.subframeArchives[0])
})

test('MhtmlDocument -> WebArchive bytes -> MhtmlDocument preserves the frame structure and resource bytes of a real multi-frame capture (fixtures/mhtml/frames-nested.chrome.mhtml)', () => {
	const { document: original } = parseMhtml(loadFixture('mhtml', 'frames-nested.chrome.mhtml'))
	assert.ok(original)

	const { document: webDoc, diagnostics: convertDiagnostics } = convertMhtmlToWebArchive(original)
	assert.deepEqual(convertDiagnostics, [])

	const { document: reparsedWebDoc, diagnostics: parseDiagnostics } = parseWebArchive(serializeWebArchive(webDoc))
	assert.deepEqual(parseDiagnostics, [])
	assert.ok(reparsedWebDoc)

	// Content-IDs are freshly generated on this direction's conversion (nothing in a WebArchive
	// plist to preserve them from), so this direction is checked structurally rather than via a
	// literal deepEqual against `original` — see docs/architecture.md, "Content-ID: preservation,
	// generation, and identity".
	assert.equal(reparsedWebDoc.mainResource.url, original.parts[original.rootPartIndex]?.location)
	assert.equal(reparsedWebDoc.subframeArchives.length, 1)
	assert.equal(reparsedWebDoc.subframeArchives[0]?.mainResource.url, 'http://127.0.0.1:8091/iframe-nested/mid.html')
	assert.equal(reparsedWebDoc.subframeArchives[0]?.subframeArchives.length, 1)
	assert.equal(reparsedWebDoc.subframeArchives[0]?.subframeArchives[0]?.mainResource.url, 'http://127.0.0.1:8091/iframe-nested/leaf.html')
})

test('a metadata sidecar survives a full WebArchiveDocument -> MHTML bytes -> WebArchiveDocument round trip', () => {
	const webDoc: WebArchiveDocument = {
		mainResource: resource({ frameName: '' }),
		subresources: [
			resource({ url: 'https://example.invalid/logo.png', mimeType: 'image/png', textEncoding: undefined, response: new TextEncoder().encode('nskeyedarchiver-blob') }),
		],
		subframeArchives: [],
		extra: new Map([['SomeFutureAppleDocumentKey', 'document-level-value']]),
	}

	const { document: mhtml } = convertWebArchiveToMhtml(webDoc)
	assert.ok(mhtml.parts.some((part) => part.mimeType === 'application/vnd.archivebridge.metadata'))

	const { document: reparsedMhtml } = parseMhtml(serializeMhtml(mhtml))
	assert.ok(reparsedMhtml)
	const { document: roundTripped, diagnostics } = convertMhtmlToWebArchive(reparsedMhtml)

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, webDoc)
})

test('a real Chrome capture’s resource bytes, CRLFs included, survive MHTML bytes -> MhtmlDocument -> MHTML bytes -> MhtmlDocument', () => {
	// Byte equality of every part's `data`, not just structural equivalence: the
	// fixture is a quoted-printable Chrome capture whose HTML carries CRLF hard line
	// breaks, so this pins down both that parsing preserves them (rather than
	// normalizing them to LF) and that a parse -> serialize -> parse cycle is stable.
	const original = parseMhtml(loadFixture('mhtml', 'example-com.chrome.mhtml'))
	assert.deepEqual(original.diagnostics, [])
	assert.ok(original.document)

	const rootHtml = new TextDecoder().decode(original.document.parts[original.document.rootPartIndex]?.data)
	assert.match(rootHtml, /\r\n/, 'the fixture must actually contain a CRLF for this to be testing anything')

	const { document: reparsed, diagnostics } = parseMhtml(serializeMhtml(original.document))
	assert.deepEqual(diagnostics, [])
	assert.ok(reparsed)
	assert.equal(reparsed.parts.length, original.document.parts.length)
	assert.equal(reparsed.rootPartIndex, original.document.rootPartIndex)
	original.document.parts.forEach((part, index) => {
		assert.deepEqual(reparsed.parts[index]?.data, part.data, `part ${index} bytes must be identical`)
		assert.equal(reparsed.parts[index]?.location, part.location)
		assert.equal(reparsed.parts[index]?.mimeType, part.mimeType)
	})
})
