import assert from 'node:assert/strict'
import test from 'node:test'
import { findReservedExtraKey, RESERVED_DOCUMENT_KEYS, RESERVED_RESOURCE_KEYS, type WebArchiveDocument, type WebArchiveResource } from './webarchive.ts'

function resource(overrides: Partial<WebArchiveResource> = {}): WebArchiveResource {
	return {
		url: 'https://example.com/',
		mimeType: 'text/html',
		data: new TextEncoder().encode('<html></html>'),
		textEncoding: 'utf-8',
		frameName: undefined,
		response: undefined,
		extra: new Map(),
		...overrides,
	}
}

test('WebArchiveDocument nests subframeArchives recursively', () => {
	const leaf: WebArchiveDocument = {
		mainResource: resource({ url: 'https://example.com/child.html', frameName: '<!--frame1-->' }),
		subresources: [],
		subframeArchives: [],
		extra: new Map(),
	}
	const root: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [resource({ url: 'https://example.com/style.css', mimeType: 'text/css', frameName: undefined })],
		subframeArchives: [leaf],
		extra: new Map(),
	}

	assert.equal(root.subframeArchives.length, 1)
	assert.equal(root.subframeArchives[0]?.mainResource.frameName, '<!--frame1-->')
})

test('response is preserved opaquely and only expected on subresources', () => {
	const response = new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74])
	const sub = resource({ url: 'https://example.com/logo.png', mimeType: 'image/png', response })
	assert.equal(sub.response, response)
})

test('extra preserves unrecognized plist keys opaquely', () => {
	const document: WebArchiveDocument = {
		mainResource: resource(),
		subresources: [],
		subframeArchives: [],
		extra: new Map([['SomeFutureAppleKey', 'value']]),
	}
	assert.equal(document.extra.get('SomeFutureAppleKey'), 'value')
})

test('RESERVED_RESOURCE_KEYS/RESERVED_DOCUMENT_KEYS name exactly the plist keys the typed fields own', () => {
	// One definition, shared by webarchive/parse.ts (which subtracts these when
	// collecting `extra`), webarchive/serialize.ts (which rejects them in `extra`),
	// and mhtml/sidecar.ts (which rejects a sidecar supplying them). Pinning the
	// contents here is what makes "coherent across all three" a checked claim
	// rather than three lists that happen to agree today.
	assert.deepEqual([...RESERVED_RESOURCE_KEYS].sort(), [
		'WebResourceData',
		'WebResourceFrameName',
		'WebResourceMIMEType',
		'WebResourceResponse',
		'WebResourceTextEncodingName',
		'WebResourceURL',
	])
	assert.deepEqual([...RESERVED_DOCUMENT_KEYS].sort(), ['WebMainResource', 'WebSubframeArchives', 'WebSubresources'])
})

test('findReservedExtraKey reports the first reserved key an extra map claims, and undefined for ordinary unknown keys', () => {
	assert.equal(findReservedExtraKey(new Map(), RESERVED_RESOURCE_KEYS), undefined)
	assert.equal(findReservedExtraKey(new Map([['SomeFutureAppleKey', 1]]), RESERVED_RESOURCE_KEYS), undefined)
	assert.equal(findReservedExtraKey(new Map([['WebResourceURL', 'x']]), RESERVED_RESOURCE_KEYS), 'WebResourceURL')
	// The two sets are separate namespaces: a document key is not reserved on a resource.
	assert.equal(findReservedExtraKey(new Map([['WebMainResource', 'x']]), RESERVED_RESOURCE_KEYS), undefined)
	assert.equal(findReservedExtraKey(new Map([['WebMainResource', 'x']]), RESERVED_DOCUMENT_KEYS), 'WebMainResource')
})
