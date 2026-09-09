import assert from 'node:assert/strict'
import test from 'node:test'
import type { MhtmlDocument, MhtmlPart } from './mhtml.ts'

function part(overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return {
		contentId: undefined,
		location: 'https://example.com/',
		mimeType: 'text/html',
		textEncoding: 'utf-8',
		data: new TextEncoder().encode('<html></html>'),
		...overrides,
	}
}

test('MhtmlDocument holds a flat, order-preserving part list', () => {
	const root = part({ location: 'https://example.com/' })
	const image = part({ location: 'https://example.com/logo.png', mimeType: 'image/png', textEncoding: undefined, data: new Uint8Array([1, 2, 3]) })
	const document: MhtmlDocument = { parts: [root, image], rootPartIndex: 0 }

	assert.equal(document.parts.length, 2)
	assert.equal(document.parts[document.rootPartIndex], root)
})

test('rootPartIndex can name a part that is not physically first', () => {
	const other = part({ location: 'https://example.com/other.html' })
	const root = part({ location: 'https://example.com/', contentId: 'root@archivebridge' })
	const document: MhtmlDocument = { parts: [other, root], rootPartIndex: 1 }

	assert.equal(document.parts[document.rootPartIndex]?.contentId, 'root@archivebridge')
})

test('a part may have neither location nor contentId', () => {
	const sidecar = part({ location: undefined, contentId: undefined, mimeType: 'application/vnd.archivebridge.metadata' })
	assert.equal(sidecar.location, undefined)
	assert.equal(sidecar.contentId, undefined)
})
