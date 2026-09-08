import assert from 'node:assert/strict'
import test from 'node:test'
import type { Archive } from '../model/archive.ts'
import { parseWebArchive } from './parse.ts'
import { serializeWebArchive } from './serialize.ts'

test('serializeWebArchive produces a binary plist (bplist00)', () => {
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: { url: 'https://example.invalid/', mimeType: 'text/html', data: new TextEncoder().encode('<html></html>'), textEncoding: 'UTF-8' },
		resources: new Map(),
		frames: [],
	}

	const bytes = serializeWebArchive(archive)

	assert.equal(new TextDecoder().decode(bytes.slice(0, 8)), 'bplist00')
})

test('serializeWebArchive round-trips through parseWebArchive for an archive with no subresources', () => {
	const archive: Archive = {
		mainUrl: 'https://example.invalid/',
		mainResource: {
			url: 'https://example.invalid/',
			mimeType: 'text/html',
			data: new TextEncoder().encode('<!DOCTYPE html><html><body>hello</body></html>'),
			textEncoding: 'UTF-8',
		},
		resources: new Map(),
		frames: [],
	}

	const { archive: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(archive))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, archive)
})

test('serializeWebArchive round-trips subresources, binary data, and resources without a charset', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

	const archive: Archive = {
		mainUrl: 'https://example.invalid/index.html',
		mainResource: {
			url: 'https://example.invalid/index.html',
			mimeType: 'text/html',
			data: new TextEncoder().encode('<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"></body></html>'),
			textEncoding: 'UTF-8',
		},
		resources: new Map([
			[
				'https://example.invalid/style.css',
				{ url: 'https://example.invalid/style.css', mimeType: 'text/css', data: new TextEncoder().encode('body { color: red; }'), textEncoding: 'UTF-8' },
			],
			['https://example.invalid/logo.png', { url: 'https://example.invalid/logo.png', mimeType: 'image/png', data: png }],
		]),
		frames: [],
	}

	const { archive: roundTripped, diagnostics } = parseWebArchive(serializeWebArchive(archive))

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(roundTripped, archive)
})

test('serializeWebArchive throws for an archive with frames, which it does not support yet', () => {
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

	assert.throws(() => serializeWebArchive(archive))
})
