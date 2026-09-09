import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildBinary } from 'plist'
import { buildSidecarPart } from '../mhtml/sidecar.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { serializeWebArchive } from '../webarchive/serialize.ts'
import { convertWebArchiveToMhtml } from './to-mhtml.ts'
import { convertMhtmlToWebArchive } from './to-web-archive.ts'

function loadWebArchiveFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/webarchive/${name}`, import.meta.url))
	return readFileSync(path)
}

function htmlPart(overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return { contentId: undefined, location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: 'utf-8', data: new TextEncoder().encode('<html></html>'), ...overrides }
}

test('convertMhtmlToWebArchive converts a single-part document with no frames', () => {
	const document: MhtmlDocument = { parts: [htmlPart({ data: new TextEncoder().encode('<html><body>hi</body></html>') })], rootPartIndex: 0 }
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	assert.equal(webDoc.mainResource.url, 'https://example.invalid/')
	assert.equal(webDoc.subresources.length, 0)
	assert.equal(webDoc.subframeArchives.length, 0)
})

test('convertMhtmlToWebArchive round-trips fixtures/webarchive/frames-nested.safari.webarchive through convertWebArchiveToMhtml and back', () => {
	const { document: original } = parseWebArchive(loadWebArchiveFixture('frames-nested.safari.webarchive'))
	assert.ok(original)

	const { document: mhtml, diagnostics: toMhtmlDiagnostics } = convertWebArchiveToMhtml(original)
	assert.deepEqual(toMhtmlDiagnostics, [])

	const { document: roundTripped, diagnostics: toWebArchiveDiagnostics } = convertMhtmlToWebArchive(mhtml)
	assert.deepEqual(toWebArchiveDiagnostics, [])

	assert.equal(roundTripped.mainResource.url, original.mainResource.url)
	assert.equal(roundTripped.mainResource.frameName, original.mainResource.frameName)
	assert.equal(roundTripped.subresources.length, original.subresources.length)
	assert.equal(roundTripped.subresources[0]?.url, original.subresources[0]?.url)
	assert.deepEqual(roundTripped.subresources[0]?.response, original.subresources[0]?.response)

	assert.equal(roundTripped.subframeArchives.length, 1)
	const level2 = roundTripped.subframeArchives[0]
	assert.equal(level2?.mainResource.url, original.subframeArchives[0]?.mainResource.url)
	assert.equal(level2?.mainResource.frameName, original.subframeArchives[0]?.mainResource.frameName)

	assert.equal(level2?.subframeArchives.length, 1)
	assert.equal(level2?.subframeArchives[0]?.mainResource.url, original.subframeArchives[0]?.subframeArchives[0]?.mainResource.url)
})

test('convertMhtmlToWebArchive round-trips fixtures/webarchive/frames-cross-origin.safari.webarchive (sibling same-origin + cross-origin frames)', () => {
	const { document: original } = parseWebArchive(loadWebArchiveFixture('frames-cross-origin.safari.webarchive'))
	assert.ok(original)

	const { document: mhtml } = convertWebArchiveToMhtml(original)
	const { document: roundTripped, diagnostics } = convertMhtmlToWebArchive(mhtml)

	assert.deepEqual(diagnostics, [])
	assert.equal(roundTripped.subframeArchives.length, 2)
	const urls = roundTripped.subframeArchives.map((frame) => frame.mainResource.url).sort()
	const originalUrls = original.subframeArchives.map((frame) => frame.mainResource.url).sort()
	assert.deepEqual(urls, originalUrls)
})

test('convertMhtmlToWebArchive rewrites a cid: iframe reference back to a resolved URL', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', location: 'https://example.invalid/', data: new TextEncoder().encode('<iframe src="cid:child@archivebridge"></iframe>') }),
			htmlPart({ contentId: 'child@archivebridge', location: 'https://example.invalid/child.html', data: new TextEncoder().encode('<p>child</p>') }),
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	assert.equal(webDoc.subframeArchives.length, 1)
	assert.equal(webDoc.subframeArchives[0]?.mainResource.url, 'https://example.invalid/child.html')
	assert.match(new TextDecoder().decode(webDoc.mainResource.data), /src="https:\/\/example\.invalid\/child\.html"/)
})

test('convertMhtmlToWebArchive reports unresolved-resource for a cid: reference with no matching part', () => {
	const document: MhtmlDocument = {
		parts: [htmlPart({ contentId: 'root@archivebridge', data: new TextEncoder().encode('<iframe src="cid:missing@archivebridge"></iframe>') })],
		rootPartIndex: 0,
	}
	const { diagnostics } = convertMhtmlToWebArchive(document)
	assert.deepEqual(diagnostics, [{ type: 'unresolved-resource', url: 'cid:missing@archivebridge' }])
})

test('convertMhtmlToWebArchive assigns a non-frame part to the nearest preceding frame-root, keeping resources grouped per frame', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', location: 'https://example.invalid/', data: new TextEncoder().encode('<iframe src="cid:child@archivebridge"></iframe>') }),
			{ contentId: undefined, location: 'https://example.invalid/root.css', mimeType: 'text/css', textEncoding: 'utf-8', data: new TextEncoder().encode('body{}') },
			htmlPart({ contentId: 'child@archivebridge', location: 'https://example.invalid/child.html', data: new TextEncoder().encode('<p>child</p>') }),
			{ contentId: undefined, location: 'https://example.invalid/child.css', mimeType: 'text/css', textEncoding: 'utf-8', data: new TextEncoder().encode('p{}') },
		],
		rootPartIndex: 0,
	}
	const { document: webDoc } = convertMhtmlToWebArchive(document)

	assert.equal(webDoc.subresources.length, 1)
	assert.equal(webDoc.subresources[0]?.url, 'https://example.invalid/root.css')
	assert.equal(webDoc.subframeArchives[0]?.subresources.length, 1)
	assert.equal(webDoc.subframeArchives[0]?.subresources[0]?.url, 'https://example.invalid/child.css')
})

test('convertMhtmlToWebArchive never treats the metadata sidecar part as a page resource', () => {
	const { document: original } = parseWebArchive(loadWebArchiveFixture('frames-nested.safari.webarchive'))
	assert.ok(original)
	const { document: mhtml } = convertWebArchiveToMhtml(original)
	assert.ok(mhtml.parts.some((part) => part.mimeType === 'application/vnd.archivebridge.metadata'))

	const { document: webDoc } = convertMhtmlToWebArchive(mhtml)
	const allUrls = [webDoc.mainResource, ...webDoc.subresources, ...webDoc.subframeArchives.flatMap((f) => [f.mainResource, ...f.subresources])].map((r) => r.url)
	assert.ok(!allUrls.some((url) => url.includes('archivebridge.metadata')))
})

test('convertMhtmlToWebArchive never treats ANY duplicate metadata-sidecar-media-type part as a page resource, even though findSidecarPart itself returns undefined for a duplicate', () => {
	const document: MhtmlDocument = {
		parts: [htmlPart({ contentId: 'root@archivebridge' }), buildSidecarPart(new Map()), buildSidecarPart(new Map())],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.ok(diagnostics.some((d) => d.type === 'duplicate-metadata-sidecar'))
	assert.equal(webDoc.subresources.length, 0)
})

test('convertMhtmlToWebArchive treats a sidecar with a missing ArchiveBridgeSchemaVersion as absent (diagnostic, no hard failure), and still excludes it from page resources', () => {
	const versionlessSidecar: MhtmlPart = {
		contentId: undefined,
		location: undefined,
		mimeType: 'application/vnd.archivebridge.metadata',
		textEncoding: undefined,
		data: buildBinary({ resources: { 'root@archivebridge': { webResourceFrameName: 'should-not-be-read' } } }),
	}
	const document: MhtmlDocument = { parts: [htmlPart({ contentId: 'root@archivebridge' }), versionlessSidecar], rootPartIndex: 0 }
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.ok(diagnostics.some((d) => d.type === 'malformed-metadata-sidecar'))
	assert.equal(webDoc.mainResource.frameName, undefined)
	assert.equal(webDoc.subresources.length, 0)
})

test('convertMhtmlToWebArchive still converts the surrounding document successfully when the sidecar has one malformed resource entry (whole-sidecar rejection, not a hard failure)', () => {
	const malformedSidecar: MhtmlPart = {
		contentId: undefined,
		location: undefined,
		mimeType: 'application/vnd.archivebridge.metadata',
		textEncoding: undefined,
		data: buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'root@archivebridge': { webResourceFrameName: 42 } } }),
	}
	const document: MhtmlDocument = {
		parts: [htmlPart({ contentId: 'root@archivebridge', data: new TextEncoder().encode('<p>hi</p>') }), malformedSidecar],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.ok(diagnostics.some((d) => d.type === 'malformed-metadata-sidecar'))
	assert.equal(webDoc.mainResource.url, 'https://example.invalid/')
	// The malformed sidecar degrades to "no residual metadata," not a dropped/failed frameName.
	assert.equal(webDoc.mainResource.frameName, undefined)
})

test('convertMhtmlToWebArchive detects a text/html frame root case-insensitively (TEXT/HTML)', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', mimeType: 'TEXT/HTML', data: new TextEncoder().encode('<iframe src="cid:child@archivebridge"></iframe>') }),
			htmlPart({ contentId: 'child@archivebridge', location: 'https://example.invalid/child.html', data: new TextEncoder().encode('<p>child</p>') }),
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	assert.equal(webDoc.subframeArchives.length, 1)
	assert.equal(webDoc.subframeArchives[0]?.mainResource.url, 'https://example.invalid/child.html')
})

test('convertMhtmlToWebArchive assigns a synthetic placeholder URL (with a diagnostic) to a part with neither a Content-Location nor a Content-ID, instead of silently returning an empty url', () => {
	const document: MhtmlDocument = { parts: [htmlPart({ contentId: undefined, location: undefined })], rootPartIndex: 0 }
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.notEqual(webDoc.mainResource.url, '')
	assert.match(webDoc.mainResource.url, /^about:archivebridge-unidentified-part-\d+$/)
	assert.ok(diagnostics.some((d) => d.type === 'malformed-resource' && d.url === webDoc.mainResource.url))
})

test('convertMhtmlToWebArchive preserves WebResourceFrameName from the sidecar for a non-frame-root part, instead of discarding it', () => {
	const sidecar = buildSidecarPart(
		new Map([['child@archivebridge', { webResourceResponse: undefined, webResourceFrameName: 'synthetic-name', resourceExtra: undefined, documentExtra: undefined }]]),
	)
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', data: new TextEncoder().encode('<p>no frames here</p>') }),
			{ contentId: 'child@archivebridge', location: 'https://example.invalid/child.css', mimeType: 'text/css', textEncoding: 'utf-8', data: new TextEncoder().encode('p{}') },
			sidecar,
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	assert.equal(webDoc.subresources.length, 1)
	assert.equal(webDoc.subresources[0]?.frameName, 'synthetic-name')
})

/** Encodes `text` as raw ISO-8859-1/windows-1252-compatible bytes (byte value == code point). */
function encodeLatin1(text: string): Uint8Array {
	return Uint8Array.from(text, (ch) => {
		const code = ch.codePointAt(0)
		if (code === undefined || code > 0xff) {
			throw new Error(`encodeLatin1: ${JSON.stringify(ch)} is outside the Latin-1 byte range`)
		}
		return code
	})
}

test('convertMhtmlToWebArchive preserves a non-UTF-8 declared encoding when a cid: rewrite actually happens', () => {
	const html = '<html><body>café <iframe src="cid:child@archivebridge"></iframe></body></html>'
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', textEncoding: 'iso-8859-1', data: encodeLatin1(html) }),
			htmlPart({ contentId: 'child@archivebridge', location: 'https://example.invalid/child.html', data: new TextEncoder().encode('<p>child</p>') }),
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	assert.equal(webDoc.mainResource.textEncoding, 'iso-8859-1')
	const decoded = Array.from(webDoc.mainResource.data, (byte) => String.fromCharCode(byte)).join('')
	assert.ok(decoded.includes('café'))
	assert.match(decoded, /src="https:\/\/example\.invalid\/child\.html"/)
})

test('convertMhtmlToWebArchive refuses to rewrite (unsupported-encoding, unmodified bytes) when the original UTF-8 bytes have a BOM that decode/encode cannot preserve', () => {
	const bom = new Uint8Array([0xef, 0xbb, 0xbf])
	const html = '<iframe src="cid:child@archivebridge"></iframe>'
	const originalBytes = new Uint8Array([...bom, ...new TextEncoder().encode(html)])
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', data: originalBytes }),
			htmlPart({ contentId: 'child@archivebridge', location: 'https://example.invalid/child.html', data: new TextEncoder().encode('<p>child</p>') }),
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [{ type: 'unsupported-encoding', encoding: 'utf-8' }])
	assert.deepEqual(webDoc.mainResource.data, originalBytes)
	// The cid: reference is left exactly as it was, unresolved to any URL.
	assert.match(new TextDecoder().decode(webDoc.mainResource.data).slice(3), /src="cid:child@archivebridge"/)
})

test('convertMhtmlToWebArchive never resolves a cid: reference to either part when two parts share the same Content-ID', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', data: new TextEncoder().encode('<iframe src="cid:dup@archivebridge"></iframe>') }),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/first.html', data: new TextEncoder().encode('<p>first</p>') }),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/second.html', data: new TextEncoder().encode('<p>second</p>') }),
		],
		rootPartIndex: 0,
	}
	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)

	assert.ok(diagnostics.some((d) => d.type === 'duplicate-content-id' && d.contentId === 'dup@archivebridge'))
	assert.equal(webDoc.subframeArchives.length, 0)
})

test("convertMhtmlToWebArchive reports duplicate-content-id exactly once (not twice) for an ambiguous Content-ID referenced by a reachable frame, even though both findFrameRootReferences and this converter's own cid: rewrite independently notice the ambiguity", () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({ contentId: 'root@archivebridge', location: 'https://example.invalid/', data: new TextEncoder().encode('<iframe src="cid:frame@archivebridge"></iframe>') }),
			htmlPart({
				contentId: 'frame@archivebridge',
				location: 'https://example.invalid/frame.html',
				data: new TextEncoder().encode('<iframe src="cid:dup@archivebridge"></iframe>'),
			}),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/first.html', data: new TextEncoder().encode('<p>first</p>') }),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/second.html', data: new TextEncoder().encode('<p>second</p>') }),
		],
		rootPartIndex: 0,
	}
	const { diagnostics } = convertMhtmlToWebArchive(document)

	const duplicateContentIdDiagnostics = diagnostics.filter((d) => d.type === 'duplicate-content-id')
	assert.equal(duplicateContentIdDiagnostics.length, 1, `expected exactly one duplicate-content-id, got ${JSON.stringify(diagnostics)}`)
	assert.deepEqual(duplicateContentIdDiagnostics, [{ type: 'duplicate-content-id', contentId: 'dup@archivebridge' }])
	assert.ok(diagnostics.some((d) => d.type === 'unresolved-resource' && d.url === 'cid:dup@archivebridge'))
})

test('convertMhtmlToWebArchive reports duplicate-content-id exactly once even for multiple cid: references to the same ambiguous Content-ID', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart({
				contentId: 'root@archivebridge',
				location: 'https://example.invalid/',
				data: new TextEncoder().encode('<iframe src="cid:dup@archivebridge"></iframe><iframe src="cid:dup@archivebridge"></iframe>'),
			}),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/first.html', data: new TextEncoder().encode('<p>first</p>') }),
			htmlPart({ contentId: 'dup@archivebridge', location: 'https://example.invalid/second.html', data: new TextEncoder().encode('<p>second</p>') }),
		],
		rootPartIndex: 0,
	}
	const { diagnostics } = convertMhtmlToWebArchive(document)

	const duplicateContentIdDiagnostics = diagnostics.filter((d) => d.type === 'duplicate-content-id')
	assert.equal(duplicateContentIdDiagnostics.length, 1, `expected exactly one duplicate-content-id, got ${JSON.stringify(diagnostics)}`)
	const unresolvedResourceDiagnostics = diagnostics.filter((d) => d.type === 'unresolved-resource')
	assert.equal(unresolvedResourceDiagnostics.length, 2, 'each of the two references still individually fails to resolve')
})

test('convertMhtmlToWebArchive produces a serializable document when a foreign sidecar tries to smuggle a reserved key into resourceExtra', () => {
	// The end-to-end shape of the reserved-key concern: an untrusted MHTML sidecar
	// claiming `resourceExtra: { WebResourceURL: ... }` would, if carried through,
	// end up in WebArchiveResource.extra and either override the typed url or make
	// serialization fail. The sidecar is rejected as malformed metadata instead, so
	// conversion degrades to "no residual metadata" and the result still serializes.
	const hostileSidecar: MhtmlPart = {
		contentId: undefined,
		location: undefined,
		mimeType: 'application/vnd.archivebridge.metadata',
		textEncoding: undefined,
		data: buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'root@archivebridge': { resourceExtra: { WebResourceURL: 'https://evil.invalid/' } } } }),
	}
	const document: MhtmlDocument = {
		parts: [htmlPart({ contentId: 'root@archivebridge', data: new TextEncoder().encode('<p>hi</p>') }), hostileSidecar],
		rootPartIndex: 0,
	}

	const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)
	assert.ok(diagnostics.some((d) => d.type === 'malformed-metadata-sidecar'))
	assert.equal(webDoc.mainResource.url, 'https://example.invalid/', 'the typed url must not be displaced')
	assert.equal(webDoc.mainResource.extra.size, 0)

	const { document: roundTripped, diagnostics: parseDiagnostics } = parseWebArchive(serializeWebArchive(webDoc))
	assert.deepEqual(parseDiagnostics, [])
	assert.equal(roundTripped?.mainResource.url, 'https://example.invalid/')
})
