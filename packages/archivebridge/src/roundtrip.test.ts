/**
 * Cross-format round-trip: Archive -> MHTML -> Archive -> WebArchive ->
 * Archive. Complements the single-format round-trip tests colocated with
 * each serializer (mhtml/serialize.test.ts, webarchive/serialize.test.ts).
 * See docs/architecture.md#testing (layer 4, "Round-trip tests").
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMhtml } from './mhtml/parse.ts'
import { serializeMhtml } from './mhtml/serialize.ts'
import type { Archive } from './model/archive.ts'
import { parseWebArchive } from './webarchive/parse.ts'
import { serializeWebArchive } from './webarchive/serialize.ts'

test('an archive survives Archive -> MHTML -> Archive -> WebArchive -> Archive unchanged', () => {
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

	const mhtmlResult = parseMhtml(serializeMhtml(archive))
	assert.deepEqual(mhtmlResult.diagnostics, [])
	assert.deepEqual(mhtmlResult.archive, archive)
	assert.ok(mhtmlResult.archive)

	const webArchiveResult = parseWebArchive(serializeWebArchive(mhtmlResult.archive))
	assert.deepEqual(webArchiveResult.diagnostics, [])
	assert.deepEqual(webArchiveResult.archive, archive)
})
