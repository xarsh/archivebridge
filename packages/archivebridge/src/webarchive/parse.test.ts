import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildBinary } from 'plist'
import { parseWebArchive } from './parse.ts'

const fixturePath = fileURLToPath(new URL('../../../../fixtures/webarchive/minimal.webarchive', import.meta.url))

function xmlPlist(dict: string): Uint8Array {
	const plist = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		dict,
		'</plist>',
	].join('\n')
	return new TextEncoder().encode(plist)
}

test('parseWebArchive parses fixtures/webarchive/minimal.webarchive into a WebArchiveDocument', () => {
	const bytes = readFileSync(fixturePath)
	const { document, diagnostics } = parseWebArchive(bytes)

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'https://example.invalid/')
	assert.equal(document.mainResource.mimeType, 'text/html')
	assert.equal(document.mainResource.textEncoding, 'UTF-8')
	assert.equal(document.subresources.length, 0)
	assert.equal(document.subframeArchives.length, 0)

	const html = new TextDecoder().decode(document.mainResource.data)
	assert.match(html, /Minimal synthetic WebArchive fixture/)
})

test('parseWebArchive parses a binary plist (bplist00)', () => {
	const bytes = buildBinary({
		WebMainResource: {
			WebResourceURL: 'https://example.invalid/',
			WebResourceMIMEType: 'text/html',
			WebResourceTextEncodingName: 'UTF-8',
			WebResourceData: new TextEncoder().encode('<html>binary plist</html>'),
		},
	})

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(document.mainResource.data), '<html>binary plist</html>')
})

test('parseWebArchive collects WebSubresources', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/style.css</string>',
			'<key>WebResourceMIMEType</key><string>text/css</string>',
			'<key>WebResourceData</key><data>Ym9keSB7fQ==</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.subresources.length, 1)
	const css = document.subresources.find((resource) => resource.url === 'https://example.invalid/style.css')
	assert.ok(css)
	assert.equal(css.mimeType, 'text/css')
	assert.equal(new TextDecoder().decode(css.data), 'body {}')
	// Binary resources have no WebResourceTextEncodingName; the model must not invent one.
	assert.equal(css.textEncoding, undefined)
})

test('parseWebArchive drops a subresource missing WebResourceURL and reports malformed-resource', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceMIMEType</key><string>text/css</string>',
			'<key>WebResourceData</key><data>Ym9keSB7fQ==</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document)
	// The malformed subresource is dropped; nothing else was added.
	assert.equal(document.subresources.length, 0)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-resource')
})

test('parseWebArchive reports duplicate-content-location and keeps both subresources', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/a.txt</string>',
			'<key>WebResourceMIMEType</key><string>text/plain</string>',
			'<key>WebResourceData</key><data>Zmlyc3Q=</data>',
			'</dict>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/a.txt</string>',
			'<key>WebResourceMIMEType</key><string>text/plain</string>',
			'<key>WebResourceData</key><data>c2Vjb25k</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document)
	assert.equal(document.subresources.length, 2)
	assert.equal(new TextDecoder().decode(document.subresources[0]?.data), 'first')
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-location', url: 'https://example.invalid/a.txt' }])
})

test('parseWebArchive reports duplicate-content-location when a subresource repeats the main resource URL', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>c2Vjb25k</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document)
	assert.equal(document.subresources.length, 1)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-location', url: 'https://example.invalid/' }])
})

test('parseWebArchive recursively parses WebSubframeArchives', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'<key>WebResourceFrameName</key><string></string>',
			'</dict>',
			'<key>WebSubframeArchives</key>',
			'<array>',
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/child.html</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>Y2hpbGQ=</data>',
			'<key>WebResourceFrameName</key><string>&lt;!--frame1--&gt;</string>',
			'</dict>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.frameName, '')
	assert.equal(document.subframeArchives.length, 1)
	const child = document.subframeArchives[0]
	assert.equal(child?.mainResource.url, 'https://example.invalid/child.html')
	assert.equal(child?.mainResource.frameName, '<!--frame1-->')
	assert.equal(new TextDecoder().decode(child?.mainResource.data), 'child')
})

test('parseWebArchive preserves WebResourceResponse and unrecognized keys in extra', () => {
	const bytes = buildBinary({
		WebMainResource: {
			WebResourceURL: 'https://example.invalid/',
			WebResourceMIMEType: 'text/html',
			WebResourceData: new TextEncoder().encode('<html></html>'),
		},
		WebSubresources: [
			{
				WebResourceURL: 'https://example.invalid/logo.png',
				WebResourceMIMEType: 'image/png',
				WebResourceData: new TextEncoder().encode('fake-png-bytes'),
				WebResourceResponse: new TextEncoder().encode('fake-nskeyedarchiver-blob'),
			},
		],
		SomeFutureAppleDocumentKey: 'document-level-value',
	})

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.extra.get('SomeFutureAppleDocumentKey'), 'document-level-value')
	const image = document.subresources[0]
	assert.equal(new TextDecoder().decode(image?.response), 'fake-nskeyedarchiver-blob')
})

test('parseWebArchive reports malformed-archive when WebMainResource is missing', () => {
	const bytes = xmlPlist(['<dict>', '<key>WebSubresources</key>', '<array/>', '</dict>'].join('\n'))

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebArchive is missing WebMainResource' }])
})

test('parseWebArchive reports malformed-archive when the top-level plist is not a dictionary', () => {
	const bytes = xmlPlist('<string>not a dictionary</string>')

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebArchive entry is not a dictionary' }])
})

test('parseWebArchive reports malformed-archive for bytes that are not a plist at all', () => {
	const { document, diagnostics } = parseWebArchive(new TextEncoder().encode('not a plist'))

	assert.equal(document, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-archive')
})

// --- Malformed *optional* fields: diagnose, don't silently pretend absent ---
//
// Reading a present-but-wrong-typed optional key as `undefined` is tolerant but
// too silent: it makes a real type error indistinguishable from the key simply
// not being there. These assert the diagnostic, and that the surrounding
// resource/document still survives.

/** A minimal one-resource archive whose main resource dictionary carries `extraKeys`. */
function archiveWithMainResourceKeys(extraKeys: Record<string, unknown>): Uint8Array {
	return buildBinary({
		WebMainResource: {
			WebResourceURL: 'https://example.invalid/',
			WebResourceMIMEType: 'text/html',
			WebResourceData: new TextEncoder().encode('<html></html>'),
			...extraKeys,
		},
		// biome-ignore lint/suspicious/noExplicitAny: buildBinary's parameter type does not admit a deliberately wrong-typed value, which is exactly what these tests supply.
	} as any)
}

test('parseWebArchive diagnoses a WebResourceTextEncodingName of the wrong plist type instead of silently dropping it', () => {
	const { document, diagnostics } = parseWebArchive(archiveWithMainResourceKeys({ WebResourceTextEncodingName: 42 }))

	assert.ok(document, 'a wrong-typed optional field must not fail the resource')
	assert.equal(document.mainResource.textEncoding, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', url: 'https://example.invalid/', message: 'WebResourceTextEncodingName is present but is not a string; treated as absent' },
	])
})

test('parseWebArchive diagnoses a WebResourceFrameName of the wrong plist type instead of silently dropping it', () => {
	const { document, diagnostics } = parseWebArchive(archiveWithMainResourceKeys({ WebResourceFrameName: [1, 2] }))

	assert.ok(document)
	assert.equal(document.mainResource.frameName, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', url: 'https://example.invalid/', message: 'WebResourceFrameName is present but is not a string; treated as absent' },
	])
})

test('parseWebArchive diagnoses a WebResourceResponse of the wrong plist type instead of silently dropping it', () => {
	const { document, diagnostics } = parseWebArchive(archiveWithMainResourceKeys({ WebResourceResponse: 'not a data blob' }))

	assert.ok(document)
	assert.equal(document.mainResource.response, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', url: 'https://example.invalid/', message: 'WebResourceResponse is present but is not plist data; treated as absent' },
	])
})

test('parseWebArchive leaves every absent optional resource field diagnostic-free', () => {
	const { document, diagnostics } = parseWebArchive(archiveWithMainResourceKeys({}))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.textEncoding, undefined)
	assert.equal(document.mainResource.frameName, undefined)
	assert.equal(document.mainResource.response, undefined)
})

test('parseWebArchive diagnoses a WebSubresources that is present but not an array, and keeps the document', () => {
	const bytes = buildBinary({
		WebMainResource: { WebResourceURL: 'https://example.invalid/', WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html></html>') },
		WebSubresources: 'not an array',
		// biome-ignore lint/suspicious/noExplicitAny: see archiveWithMainResourceKeys.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document, 'a malformed optional collection must not fail the whole document')
	assert.deepEqual(document.subresources, [])
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebSubresources is present but is not an array; treated as absent' }])
})

test('parseWebArchive diagnoses a WebSubframeArchives that is present but not an array, and keeps the document', () => {
	const bytes = buildBinary({
		WebMainResource: { WebResourceURL: 'https://example.invalid/', WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html></html>') },
		WebSubframeArchives: { notAn: 'array' },
		// biome-ignore lint/suspicious/noExplicitAny: see archiveWithMainResourceKeys.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document)
	assert.deepEqual(document.subframeArchives, [])
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebSubframeArchives is present but is not an array; treated as absent' }])
})

test('parseWebArchive leaves absent WebSubresources/WebSubframeArchives diagnostic-free', () => {
	const bytes = buildBinary({
		WebMainResource: { WebResourceURL: 'https://example.invalid/', WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html></html>') },
	})

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.subresources, [])
	assert.deepEqual(document.subframeArchives, [])
})

test('parseWebArchive drops only the unusable nested subframe, keeping the valid parent document', () => {
	const bytes = buildBinary({
		WebMainResource: { WebResourceURL: 'https://example.invalid/', WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html></html>') },
		WebSubframeArchives: [
			{ WebMainResource: { WebResourceURL: 'https://example.invalid/ok', WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html>ok</html>') } },
			{ WebSubresources: [] },
		],
	})

	const { document, diagnostics } = parseWebArchive(bytes)
	assert.ok(document, 'a malformed subframe must not take its parent down with it')
	assert.equal(document.mainResource.url, 'https://example.invalid/')
	assert.equal(document.subframeArchives.length, 1)
	assert.equal(document.subframeArchives[0]?.mainResource.url, 'https://example.invalid/ok')
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebArchive is missing WebMainResource' }])
})

test('parseWebArchive does not leak the XML parser fatal error to console.error', () => {
	// `plist`'s XML backend (`@xmldom/xmldom`) writes fatal parse errors straight to
	// console.error by default; parseWebArchive must suppress that so a malformed
	// archive produces a diagnostic and nothing else on stderr.
	const originalConsoleError = console.error
	const calls: unknown[][] = []
	console.error = (...args: unknown[]) => {
		calls.push(args)
	}
	try {
		parseWebArchive(new TextEncoder().encode('not a plist'))
	} finally {
		console.error = originalConsoleError
	}
	assert.deepEqual(calls, [])
})

// --- plist dictionary prototype poisoning (see plist-dict.ts) ---------------
//
// These build the malicious archive as real serialized plist bytes, so the
// dependency boundary is what is under test: `plist`'s binary backend assigns
// dictionary entries with `dict[key] = value`, which for a key literally named
// `__proto__` replaces the dictionary's prototype instead of adding an own key.
// Before `plist-dict.ts` existed, ordinary field access inherited those values
// and a resource owning no WebResourceURL at all parsed successfully with an
// attacker-chosen URL and zero diagnostics.

const GOOD_RESOURCE = {
	WebResourceURL: 'https://example.invalid/',
	WebResourceMIMEType: 'text/html',
	WebResourceData: new TextEncoder().encode('<html></html>'),
}

/** A plist dictionary with a real own, enumerable `__proto__` key — inexpressible as an object literal, which is why the hazard exists. */
function dictWithProtoKey(protoValue: unknown, ownKeys: Record<string, unknown> = {}): Record<string, unknown> {
	const object: Record<string, unknown> = {}
	Object.defineProperty(object, '__proto__', { value: protoValue, enumerable: true, writable: true, configurable: true })
	return Object.assign(object, ownKeys)
}

const PROTOTYPE_REPLACED = 'is a dictionary whose prototype was replaced, which a "__proto__" plist key does'

test('parseWebArchive does not let a WebResource inherit WebResourceURL through a __proto__ plist key', () => {
	const bytes = buildBinary({
		// Owns WebResourceData only: both required string fields would have to come
		// from the attacker-supplied prototype.
		WebMainResource: dictWithProtoKey(
			{ WebResourceURL: 'https://injected.invalid/', WebResourceMIMEType: 'text/html' },
			{ WebResourceData: new TextEncoder().encode('<html></html>') },
		),
		// biome-ignore lint/suspicious/noExplicitAny: buildBinary's parameter type cannot express an own `__proto__` key, which is exactly what this test supplies.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.equal(document, undefined, 'an inherited WebResourceURL must never satisfy the required field')
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', message: `WebResource entry ${PROTOTYPE_REPLACED}` },
		{ type: 'malformed-archive', message: 'WebMainResource could not be parsed' },
	])
})

test('parseWebArchive does not let a WebResource inherit WebResourceMIMEType or WebResourceData through a __proto__ plist key', () => {
	const bytes = buildBinary({
		// Owns the URL only; MIME type and data would have to be inherited.
		WebMainResource: dictWithProtoKey(
			{ WebResourceMIMEType: 'text/html', WebResourceData: new TextEncoder().encode('<html></html>') },
			{ WebResourceURL: 'https://example.invalid/' },
		),
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', message: `WebResource entry ${PROTOTYPE_REPLACED}` },
		{ type: 'malformed-archive', message: 'WebMainResource could not be parsed' },
	])
})

test('parseWebArchive does not let optional resource fields be inherited through a __proto__ plist key', () => {
	const bytes = buildBinary({
		WebMainResource: dictWithProtoKey({ WebResourceFrameName: 'injected-frame', WebResourceTextEncodingName: 'utf-8' }, GOOD_RESOURCE),
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	// The dictionary is rejected wholesale rather than accepted-minus-the-inherited
	// fields: silently normalizing it would discard the only evidence that the
	// input carried a `__proto__` key at all (see plist-dict.ts).
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', message: `WebResource entry ${PROTOTYPE_REPLACED}` },
		{ type: 'malformed-archive', message: 'WebMainResource could not be parsed' },
	])
})

test('parseWebArchive does not let a top-level dictionary inherit WebMainResource through a __proto__ plist key', () => {
	const bytes = buildBinary(
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
		dictWithProtoKey({ WebMainResource: GOOD_RESOURCE }) as any,
	)

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: `WebArchive entry ${PROTOTYPE_REPLACED}` }])
})

test('parseWebArchive does not let a top-level dictionary inherit WebSubresources or WebSubframeArchives through a __proto__ plist key', () => {
	const bytes = buildBinary({
		WebMainResource: GOOD_RESOURCE,
		WebSubframeArchives: [dictWithProtoKey({ WebSubresources: [{ ...GOOD_RESOURCE, WebResourceURL: 'https://injected.invalid/x.css' }] }, { WebMainResource: GOOD_RESOURCE })],
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.ok(document, 'only the poisoned subframe is dropped; the parent survives')
	assert.equal(document.subframeArchives.length, 0)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: `WebArchive entry ${PROTOTYPE_REPLACED}` }])
})

test('parseWebArchive drops only a poisoned subresource, keeping the rest of the document', () => {
	const bytes = buildBinary({
		WebMainResource: GOOD_RESOURCE,
		WebSubresources: [
			dictWithProtoKey({ WebResourceURL: 'https://injected.invalid/' }, { WebResourceData: new TextEncoder().encode('x') }),
			{ ...GOOD_RESOURCE, WebResourceURL: 'https://example.invalid/ok.css', WebResourceMIMEType: 'text/css' },
		],
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.ok(document, 'the existing partial-recovery policy applies: one bad subresource must not fail the archive')
	assert.deepEqual(
		document.subresources.map((resource) => resource.url),
		['https://example.invalid/ok.css'],
	)
	assert.deepEqual(diagnostics, [{ type: 'malformed-resource', message: `WebResource entry ${PROTOTYPE_REPLACED}` }])
})

test('parseWebArchive rejects a dictionary whose __proto__ plist key is null, which leaves no prototype at all', () => {
	const bytes = buildBinary({
		WebMainResource: dictWithProtoKey(null, GOOD_RESOURCE),
		// biome-ignore lint/suspicious/noExplicitAny: see dictWithProtoKey.
	} as any)

	const { document, diagnostics } = parseWebArchive(bytes)

	// Nothing can be spoofed through a null prototype, but the dictionary was still
	// specialized by a key ArchiveBridge can neither see nor round-trip, so it is
	// malformed rather than silently accepted.
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'malformed-resource', message: `WebResource entry ${PROTOTYPE_REPLACED}` },
		{ type: 'malformed-archive', message: 'WebMainResource could not be parsed' },
	])
})

test('parseWebArchive reports a malformed-archive rather than throwing for an XML plist carrying a __proto__ key', () => {
	// The dependency's XML backend rejects `__proto__` itself (its own CVE-2022-22912
	// hardening) by throwing, so this path never reaches the prototype check — it must
	// still surface as an ordinary diagnostic, not an unhandled error.
	const bytes = xmlPlist(['<dict>', '<key>__proto__</key>', '<dict>', '<key>WebMainResource</key>', '<string>x</string>', '</dict>', '</dict>'].join('\n'))

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.equal(document, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-archive')
	assert.match(diagnostics[0]?.type === 'malformed-archive' ? diagnostics[0].message : '', /__proto__/)
})

test('parseWebArchive still preserves ordinary unknown plist keys in extra, at both levels', () => {
	// The prototype rule must not have narrowed unknown-key preservation for normal keys.
	const bytes = buildBinary({
		WebMainResource: { ...GOOD_RESOURCE, SomeFutureAppleResourceKey: 'resource-value' },
		SomeFutureAppleDocumentKey: 'document-value',
	})

	const { document, diagnostics } = parseWebArchive(bytes)

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual([...document.mainResource.extra], [['SomeFutureAppleResourceKey', 'resource-value']])
	assert.deepEqual([...document.extra], [['SomeFutureAppleDocumentKey', 'document-value']])
})
