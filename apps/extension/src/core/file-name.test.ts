import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveFileName, archiveFileStem } from './file-name.ts'

test('a root URL becomes just the host', () => {
	assert.equal(archiveFileName('https://example.com/', 'mhtml'), 'example.com.mhtml')
})

test('the path is folded into the stem', () => {
	assert.equal(archiveFileName('https://example.com/a/b', 'webarchive'), 'example.com-a-b.webarchive')
})

test('query and fragment are dropped', () => {
	assert.equal(archiveFileStem('https://example.com/search?q=hello#top'), 'example.com-search')
})

test('the port is kept, with its colon sanitized away', () => {
	assert.equal(archiveFileStem('http://127.0.0.1:8931/index.html'), '127.0.0.1-8931-index.html')
})

test('non-ASCII characters collapse into a single separator', () => {
	assert.equal(archiveFileStem('https://example.com/日本語/page'), 'example.com-page')
})

test('a percent-encoded path is decoded before sanitation, not turned into hex', () => {
	assert.equal(archiveFileStem('https://example.com/a%20b'), 'example.com-a-b')
})

test('no output starts or ends with a separator', () => {
	for (const url of ['https://example.com/-/', 'https://example.com/./', 'https://example.com/...', 'https://example.com/日本語/']) {
		const stem = archiveFileStem(url)
		assert.doesNotMatch(stem, /^[.-]/, url)
		assert.doesNotMatch(stem, /[.-]$/, url)
	}
})

test('the stem stays within one path component on every filesystem', () => {
	const stem = archiveFileStem(`https://example.com/${'a'.repeat(500)}`)
	assert.equal(stem.length, 96)
	assert.equal(archiveFileName(`https://example.com/${'a'.repeat(500)}`, 'webarchive').length, 96 + '.webarchive'.length)
})

test('an unparseable URL is sanitized rather than rejected', () => {
	assert.equal(archiveFileStem('not a url at all'), 'not-a-url-at-all')
})

test('a missing URL falls back instead of failing', () => {
	assert.equal(archiveFileName(undefined, 'mhtml'), 'archive.mhtml')
})

test('an opaque URL uses its scheme-specific part', () => {
	assert.equal(archiveFileName('about:blank', 'mhtml'), 'blank.mhtml')
})

test('a name that sanitizes away to nothing falls back', () => {
	assert.equal(archiveFileName('...', 'mhtml'), 'archive.mhtml')
	assert.equal(archiveFileName('', 'webarchive'), 'archive.webarchive')
})

test('a Windows reserved device name is never used as the stem', () => {
	assert.equal(archiveFileStem('https://con/'), 'archive')
	assert.equal(archiveFileStem('file:///nul.html'), 'archive')
})

test('a file: URL uses its path', () => {
	assert.equal(archiveFileStem('file:///tmp/page.html'), 'tmp-page.html')
})

test('the same URL always produces the same name', () => {
	assert.equal(archiveFileStem('https://example.com/a/b'), archiveFileStem('https://example.com/a/b'))
})
