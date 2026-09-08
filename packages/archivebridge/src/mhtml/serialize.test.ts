import assert from 'node:assert/strict'
import test from 'node:test'
import type { Archive } from '../model/archive.ts'
import { parseMhtml } from './parse.ts'
import { serializeMhtml } from './serialize.ts'

test('serializeMhtml produces standards-conforming multipart/related MHTML', () => {
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: { url: 'https://example.invalid/', mimeType: 'text/html', data: new TextEncoder().encode('<html></html>'), textEncoding: 'utf-8' },
		resources: new Map(),
		frames: [],
	}

	const bytes = serializeMhtml(archive)
	const text = new TextDecoder().decode(bytes)

	assert.match(text, /^MIME-Version: 1\.0\r\n/)
	// The root part is identified via RFC 2387's `start` parameter, not the Blink-specific
	// `Snapshot-Content-Location` header, which this serializer never writes.
	const contentTypeMatch = text.match(/Content-Type: multipart\/related; type="text\/html"; boundary="([^"]+)"; start="<([^>]+)>"\r\n/)
	assert.ok(contentTypeMatch, 'expected a Content-Type header with boundary and start parameters')
	assert.doesNotMatch(text, /Snapshot-Content-Location/)

	const rootContentId = contentTypeMatch[2]
	assert.match(text, new RegExp(`Content-ID: <${rootContentId}>\\r\\n`))
	assert.match(text, /Content-Location: https:\/\/example\.invalid\/\r\n/)
	assert.match(text, /Content-Transfer-Encoding: base64\r\n/)
	// The document must end with the closing delimiter (`--boundary--`) followed by a CRLF.
	assert.match(text, /--\r\n$/)
})

test('serializeMhtml round-trips through parseMhtml for an archive with no subresources', () => {
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: {
			url: 'https://example.invalid/',
			mimeType: 'text/html',
			data: new TextEncoder().encode('<!DOCTYPE html><html><body>hello</body></html>'),
			textEncoding: 'utf-8',
		},
		resources: new Map(),
		frames: [],
	}

	const { archive: roundTripped, diagnostics } = parseMhtml(serializeMhtml(archive))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, archive)
})

test('serializeMhtml round-trips subresources, binary data, and resources without a charset', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

	const archive: Archive = {
		mainUrl: 'https://example.invalid/index.html',
		mainResource: {
			url: 'https://example.invalid/index.html',
			mimeType: 'text/html',
			data: new TextEncoder().encode('<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"></body></html>'),
			textEncoding: 'utf-8',
		},
		resources: new Map([
			[
				'https://example.invalid/style.css',
				{ url: 'https://example.invalid/style.css', mimeType: 'text/css', data: new TextEncoder().encode('body { color: red; }'), textEncoding: 'utf-8' },
			],
			['https://example.invalid/logo.png', { url: 'https://example.invalid/logo.png', mimeType: 'image/png', data: png }],
		]),
		frames: [],
	}

	const bytes = serializeMhtml(archive)
	const text = new TextDecoder().decode(bytes)
	// Only the root part gets a Content-ID; it's the anchor the `start` parameter points at,
	// not a general per-part identifier.
	assert.equal([...text.matchAll(/Content-ID:/g)].length, 1)

	const { archive: roundTripped, diagnostics } = parseMhtml(bytes)

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, archive)
})

test('serializeMhtml throws rather than injecting a line break from an untrusted resource URL into MHTML headers', () => {
	// A URL like this cannot come from parseMhtml (headers can't contain a raw
	// CRLF), but it can come from a WebArchive plist's WebResourceURL string,
	// which has no such restriction. serializeMhtml must reject it rather than
	// splicing it into a header line, or a convert from an untrusted WebArchive
	// could inject arbitrary MIME headers/parts into the MHTML output.
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: {
			url: 'https://example.invalid/\r\nContent-Type: text/html\r\nContent-Location: https://evil.invalid/\r\n\r\ninjected',
			mimeType: 'text/html',
			data: new TextEncoder().encode('<html></html>'),
		},
		resources: new Map(),
		frames: [],
	}

	assert.throws(() => serializeMhtml(archive), /line break/)
})

test('serializeMhtml throws for an archive with frames, which it does not support yet', () => {
	const leaf: Archive = {
		mainUrl: 'https://example.invalid/frame.html',
		mainResource: { url: 'https://example.invalid/frame.html', mimeType: 'text/html', data: new TextEncoder().encode('<html></html>') },
		resources: new Map(),
		frames: [],
	}
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: { url: 'https://example.invalid/', mimeType: 'text/html', data: new TextEncoder().encode('<html></html>') },
		resources: new Map(),
		frames: [leaf],
	}

	assert.throws(() => serializeMhtml(archive))
})
