import assert from 'node:assert/strict'
import test from 'node:test'
import { type PlistValue, parseBinary } from 'plist'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'
import { parseWebArchive } from './parse.ts'
import { serializeWebArchive } from './serialize.ts'

function resource(overrides: Partial<WebArchiveResource> = {}): WebArchiveResource {
	return {
		url: 'https://example.invalid/',
		mimeType: 'text/html',
		data: new TextEncoder().encode('<html></html>'),
		textEncoding: 'UTF-8',
		frameName: undefined,
		response: undefined,
		extra: new Map(),
		...overrides,
	}
}

test('serializeWebArchive produces a binary plist (bplist00)', () => {
	const document: WebArchiveDocument = { mainResource: resource(), subresources: [], subframeArchives: [], extra: new Map() }

	const bytes = serializeWebArchive(document)

	assert.equal(new TextDecoder().decode(bytes.slice(0, 8)), 'bplist00')
})

test('serializeWebArchive round-trips through parseWebArchive for a document with no subresources', () => {
	const document: WebArchiveDocument = {
		mainResource: resource({ data: new TextEncoder().encode('<!DOCTYPE html><html><body>hello</body></html>') }),
		subresources: [],
		subframeArchives: [],
		extra: new Map(),
	}

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, document)
})

test('serializeWebArchive round-trips subresources, binary data, and resources without a charset', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

	const document: WebArchiveDocument = {
		mainResource: resource({
			url: 'https://example.invalid/index.html',
			data: new TextEncoder().encode('<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"></body></html>'),
		}),
		subresources: [
			resource({ url: 'https://example.invalid/style.css', mimeType: 'text/css', data: new TextEncoder().encode('body { color: red; }') }),
			resource({ url: 'https://example.invalid/logo.png', mimeType: 'image/png', textEncoding: undefined, data: png }),
		],
		subframeArchives: [],
		extra: new Map(),
	}

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, document)
})

test('serializeWebArchive round-trips WebResourceResponse, WebResourceFrameName, and extra', () => {
	const document: WebArchiveDocument = {
		mainResource: resource({ frameName: '' }),
		subresources: [
			resource({ url: 'https://example.invalid/logo.png', mimeType: 'image/png', textEncoding: undefined, response: new TextEncoder().encode('nskeyedarchiver-blob') }),
		],
		subframeArchives: [],
		extra: new Map([['SomeFutureAppleDocumentKey', 'document-level-value']]),
	}

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, document)
})

test('serializeWebArchive recursively round-trips WebSubframeArchives', () => {
	const document: WebArchiveDocument = {
		mainResource: resource({ frameName: '' }),
		subresources: [],
		subframeArchives: [
			{
				mainResource: resource({ url: 'https://example.invalid/child.html', frameName: '<!--frame1-->', data: new TextEncoder().encode('child') }),
				subresources: [],
				subframeArchives: [],
				extra: new Map(),
			},
		],
		extra: new Map(),
	}

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, document)
})

test('serializeWebArchive omits WebSubframeArchives entirely when there are no subframes', () => {
	const document: WebArchiveDocument = { mainResource: resource(), subresources: [], subframeArchives: [], extra: new Map() }

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))
	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped?.subframeArchives, [])
})

// Asserted against the *emitted plist keys*, not the re-parsed model: parsing
// maps an absent collection and an empty one onto the same `[]`, so a
// round-trip assertion cannot tell an omitted key from an empty array. Real
// WebKit omits both keys when empty — fixtures/webarchive/example-com
// .safari.webarchive's root and frames-nested's leaf frame each carry only
// `WebMainResource`.
test('serializeWebArchive omits empty WebSubresources/WebSubframeArchives keys, at every depth', () => {
	const leaf: WebArchiveDocument = { mainResource: resource({ url: 'https://example.invalid/leaf.html' }), subresources: [], subframeArchives: [], extra: new Map() }
	const root: WebArchiveDocument = { mainResource: resource(), subresources: [], subframeArchives: [leaf], extra: new Map() }

	const emitted = parseBinary(serializeWebArchive(root)) as Record<string, PlistValue>

	assert.deepEqual(Object.keys(emitted).toSorted(), ['WebMainResource', 'WebSubframeArchives'])
	const [emittedLeaf] = emitted.WebSubframeArchives as Record<string, PlistValue>[]
	assert.deepEqual(Object.keys(emittedLeaf ?? {}), ['WebMainResource'])
})

test('serializeWebArchive still emits WebSubresources when there is at least one subresource', () => {
	const document: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [resource({ url: 'https://example.invalid/style.css', mimeType: 'text/css', data: new TextEncoder().encode('body{}') })],
		subframeArchives: [],
		extra: new Map(),
	}

	const emitted = parseBinary(serializeWebArchive(document)) as Record<string, PlistValue>

	assert.deepEqual(Object.keys(emitted).toSorted(), ['WebMainResource', 'WebSubresources'])
})

// --- Reserved keys inside `extra` -------------------------------------------
//
// `extra` is defined as the *unknown* plist keys only (model/webarchive.ts), so
// a reserved key inside it is an invalid constructed model: it would either
// override a typed field or have to be silently discarded, and neither is
// something a serializer should decide on its own. Reachable from untrusted
// input, too: a foreign metadata sidecar can supply `resourceExtra`/
// `documentExtra` (see mhtml/sidecar.test.ts for that end of it).

test('serializeWebArchive rejects a resource whose extra claims a reserved resource key', () => {
	for (const key of ['WebResourceURL', 'WebResourceMIMEType', 'WebResourceData', 'WebResourceTextEncodingName', 'WebResourceResponse', 'WebResourceFrameName']) {
		const document: WebArchiveDocument = {
			mainResource: resource({ extra: new Map([[key, 'hijacked']]) }),
			subresources: [],
			subframeArchives: [],
			extra: new Map(),
		}
		assert.throws(() => serializeWebArchive(document), new RegExp(`reserved key "${key}"`), `expected ${key} in extra to be rejected`)
	}
})

test('serializeWebArchive rejects a subresource (not just the main resource) whose extra claims a reserved resource key', () => {
	const document: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [resource({ url: 'https://example.invalid/logo.png', extra: new Map([['WebResourceURL', 'https://evil.invalid/']]) })],
		subframeArchives: [],
		extra: new Map(),
	}

	assert.throws(() => serializeWebArchive(document), /reserved key "WebResourceURL"/)
})

test('serializeWebArchive rejects a document whose extra claims a reserved document key', () => {
	for (const key of ['WebMainResource', 'WebSubresources', 'WebSubframeArchives']) {
		const document: WebArchiveDocument = {
			mainResource: resource(),
			subresources: [],
			subframeArchives: [],
			extra: new Map([[key, 'hijacked']]),
		}
		assert.throws(() => serializeWebArchive(document), new RegExp(`reserved key "${key}"`), `expected ${key} in extra to be rejected`)
	}
})

test('serializeWebArchive rejects a nested subframe document whose extra claims a reserved document key', () => {
	const document: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [],
		subframeArchives: [
			{
				mainResource: resource({ url: 'https://example.invalid/child.html' }),
				subresources: [],
				subframeArchives: [],
				extra: new Map([['WebMainResource', 'hijacked']]),
			},
		],
		extra: new Map(),
	}

	assert.throws(() => serializeWebArchive(document), /reserved key "WebMainResource"/)
})

test('serializeWebArchive still round-trips ordinary unknown extra keys at both levels', () => {
	const document: WebArchiveDocument = {
		mainResource: resource({ extra: new Map([['SomeFutureAppleResourceKey', 'resource-level-value']]) }),
		subresources: [],
		subframeArchives: [],
		extra: new Map([['SomeFutureAppleDocumentKey', 'document-level-value']]),
	}

	const { document: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(document))
	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, document)
})
