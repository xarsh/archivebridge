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

test('a Japanese title stays Unicode in the file name', () => {
	assert.equal(archiveFileStem('https://b.hatena.ne.jp/', 'はてなブックマーク'), 'はてなブックマーク')
	assert.equal(archiveFileName('https://b.hatena.ne.jp/', 'mhtml', 'はてなブックマーク'), 'はてなブックマーク.mhtml')
	assert.equal(archiveFileName('https://b.hatena.ne.jp/', 'webarchive', 'はてなブックマーク'), 'はてなブックマーク.webarchive')
})

test('an ASCII title takes priority over the URL', () => {
	assert.equal(archiveFileStem('https://example.com/some/path', 'Example Domain'), 'Example Domain')
})

test('illegal filename punctuation in a title collapses to single separators', () => {
	assert.equal(archiveFileStem(undefined, 'A/B\\C:D*E?F"G<H>I|J'), 'A-B-C-D-E-F-G-H-I-J')
})

test('NUL and other C0/C1 control characters are stripped from a title', () => {
	const withControls = `A${String.fromCharCode(0)}B${String.fromCharCode(0x1f)}C${String.fromCharCode(0x9f)}D`
	assert.equal(archiveFileStem(undefined, withControls), 'A-B-C-D')
})

test('a very long Unicode title truncates without splitting a multi-byte character', () => {
	const stem = archiveFileStem(undefined, 'あ'.repeat(200))
	const bytes = new TextEncoder().encode(stem)
	assert.ok(bytes.byteLength <= 150)
	assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), stem)
})

test('an emoji/surrogate-pair-heavy title truncates without corrupting a surrogate pair', () => {
	const stem = archiveFileStem(undefined, '😀'.repeat(100))
	const bytes = new TextEncoder().encode(stem)
	assert.ok(bytes.byteLength <= 150)
	// A split surrogate pair would leave a lone surrogate, which `TextEncoder`
	// silently replaces with U+FFFD rather than throwing — so a lossless
	// round trip (rather than merely "did not throw") is what actually proves
	// truncation respected code-point boundaries.
	assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(bytes), stem)
	assert.equal(stem.length % 2, 0, 'every surrogate pair kept both halves')
})

test('an empty title falls back to the URL', () => {
	assert.equal(archiveFileStem('https://example.com/page', ''), 'example.com-page')
})

test('no title falls back to the URL', () => {
	assert.equal(archiveFileStem('https://example.com/page'), 'example.com-page')
})

test('missing URL and missing title falls back to archive', () => {
	assert.equal(archiveFileStem(undefined, undefined), 'archive')
})

test('a title that is a Windows reserved device name falls back to the URL', () => {
	assert.equal(archiveFileStem('https://example.com/page', 'CON'), 'example.com-page')
	assert.equal(archiveFileStem('https://example.com/page', 'nul'), 'example.com-page')
})

test('a title that sanitizes away to nothing (all dots) falls back to the URL', () => {
	assert.equal(archiveFileStem('https://example.com/page', '...'), 'example.com-page')
})

test('bidi formatting/isolate control characters are stripped from a title', () => {
	// U+202E (RIGHT-TO-LEFT OVERRIDE) is exactly the character used in real
	// "spoofed extension" attacks (e.g. renaming a `.exe` payload so it
	// displays as a harmless-looking extension).
	const spoofed = `evil${String.fromCodePoint(0x202e)}exe.txt`
	const stem = archiveFileStem(undefined, spoofed)
	assert.equal(stem, 'evilexe.txt')
	assert.equal(
		[...stem].some((char) => (char.codePointAt(0) ?? 0) >= 0x200e && (char.codePointAt(0) ?? 0) <= 0x2069),
		false,
	)
})

test('the Arabic Letter Mark (U+061C) is stripped from a title', () => {
	const withAlm = `evil${String.fromCodePoint(0x061c)}exe.txt`
	const stem = archiveFileStem(undefined, withAlm)
	assert.equal(stem, 'evilexe.txt')
	assert.equal(
		[...stem].some((char) => char.codePointAt(0) === 0x061c),
		false,
	)
})

test('MHTML and WebArchive saves share the same title-derived stem', () => {
	assert.equal(archiveFileName('https://example.com/', 'mhtml', 'My Page'), 'My Page.mhtml')
	assert.equal(archiveFileName('https://example.com/', 'webarchive', 'My Page'), 'My Page.webarchive')
})
