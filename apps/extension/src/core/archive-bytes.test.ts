import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { detectArchiveFormatFromBytes, parseWebArchive } from '@xarsh/archivebridge'
import { ArchiveConversionError, archiveBytesFrom } from './archive-bytes.ts'

const fixturesUrl = new URL('../../../../fixtures/', import.meta.url)

function fixture(path: string): Uint8Array {
	return readFileSync(fileURLToPath(new URL(path, fixturesUrl)))
}

const chromeCapture = fixture('mhtml/example-com.chrome.mhtml')
const nestedFrames = fixture('mhtml/frames-nested.chrome.mhtml')

test('saving as MHTML passes the browser capture through byte for byte', () => {
	const archive = archiveBytesFrom(chromeCapture, 'mhtml')
	assert.deepEqual(archive.bytes, chromeCapture)
	assert.equal(archive.format, 'mhtml')
	assert.equal(archive.mimeType, 'application/x-mimearchive')
})

test('the file name comes from the capture own root part title, not its URL', () => {
	const archive = archiveBytesFrom(chromeCapture, 'mhtml')
	assert.equal(archive.pageUrl, 'https://example.com/')
	assert.equal(archive.fileName, 'Example Domain.mhtml')
})

test('saving as WebArchive produces bytes ArchiveBridge recognizes as a WebArchive', () => {
	const archive = archiveBytesFrom(chromeCapture, 'webarchive')
	assert.equal(archive.format, 'webarchive')
	assert.equal(archive.fileName, 'Example Domain.webarchive')
	assert.equal(archive.mimeType, 'application/x-webarchive')
	assert.equal(detectArchiveFormatFromBytes(archive.bytes), 'webarchive')
})

test('MHTML and WebArchive saves of the same capture share the same title-derived stem', () => {
	assert.equal(archiveBytesFrom(chromeCapture, 'mhtml').fileName, 'Example Domain.mhtml')
	assert.equal(archiveBytesFrom(chromeCapture, 'webarchive').fileName, 'Example Domain.webarchive')
})

test('a capture whose root part has no title falls back to the URL-derived name', () => {
	const noTitle = new TextEncoder().encode(
		[
			'MIME-Version: 1.0',
			'Content-Type: multipart/related; boundary="B"',
			'',
			'--B',
			'Content-Type: text/html',
			'Content-Location: https://example.com/no-title',
			'',
			'<html><head></head><body>no title here</body></html>',
			'--B--',
			'',
		].join('\r\n'),
	)
	const archive = archiveBytesFrom(noTitle, 'mhtml')
	assert.equal(archive.fileName, 'example.com-no-title.mhtml')
})

test('a capture whose root part is not HTML falls back to the URL-derived name', () => {
	const nonHtmlRoot = new TextEncoder().encode(
		[
			'MIME-Version: 1.0',
			'Content-Type: multipart/related; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain',
			'Content-Location: https://example.com/plain',
			'',
			'<title>should not be read as a title</title>',
			'--B--',
			'',
		].join('\r\n'),
	)
	const archive = archiveBytesFrom(nonHtmlRoot, 'mhtml')
	assert.equal(archive.fileName, 'example.com-plain.mhtml')
})

test('the WebArchive keeps the captured main resource and subresources', () => {
	const archive = archiveBytesFrom(chromeCapture, 'webarchive')
	const parsed = parseWebArchive(archive.bytes)
	assert.notEqual(parsed.document, undefined)
	assert.equal(parsed.document?.mainResource.url, 'https://example.com/')
	assert.equal(parsed.document?.mainResource.mimeType, 'text/html')
	assert.deepEqual(
		parsed.document?.subresources.map((resource) => resource.mimeType),
		['text/css'],
	)
})

test('nested frames survive the conversion as WebSubframeArchives', () => {
	const archive = archiveBytesFrom(nestedFrames, 'webarchive')
	const parsed = parseWebArchive(archive.bytes)
	assert.notEqual(parsed.document, undefined)
	assert.equal(parsed.document?.subframeArchives.length, 1)
	// frames-nested is a page -> frame -> frame chain, so the reconstructed
	// WebArchive must nest one level deeper again rather than flattening.
	assert.equal(parsed.document?.subframeArchives[0]?.subframeArchives.length, 1)
})

test('an unparseable capture still saves as MHTML, under the fallback name', () => {
	const garbage = new TextEncoder().encode('this is not an MHTML document')
	const archive = archiveBytesFrom(garbage, 'mhtml')
	assert.deepEqual(archive.bytes, garbage)
	assert.equal(archive.fileName, 'archive.mhtml')
	assert.ok(archive.diagnostics.length > 0)
})

test('an unparseable capture cannot be converted, and says why', () => {
	const garbage = new TextEncoder().encode('this is not an MHTML document')
	assert.throws(
		() => archiveBytesFrom(garbage, 'webarchive'),
		(error: unknown) => {
			assert.ok(error instanceof ArchiveConversionError)
			assert.ok(error.diagnostics.length > 0)
			return true
		},
	)
})
