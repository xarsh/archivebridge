import assert from 'node:assert/strict'
import test from 'node:test'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { indexArchiveResources, resolveReference } from './resources.ts'

function part(overrides: Partial<MhtmlPart>): MhtmlPart {
	return { contentId: undefined, location: undefined, mimeType: 'text/plain', textEncoding: undefined, data: new Uint8Array(), ...overrides }
}

function documentOf(parts: readonly MhtmlPart[]): MhtmlDocument {
	return { parts, rootPartIndex: 0 }
}

const PAGE = 'https://example.com/page.html'

function fixture(): { readonly index: ReturnType<typeof indexArchiveResources>; readonly diagnostics: readonly Diagnostic[] } {
	const diagnostics: Diagnostic[] = []
	const index = indexArchiveResources(
		documentOf([
			part({ location: PAGE, mimeType: 'text/html', contentId: 'root@x' }),
			part({ location: 'https://example.com/a.png', mimeType: 'image/png', contentId: 'image@x' }),
			part({ location: 'cid:inline@x', mimeType: 'text/css', contentId: 'inline@x' }),
		]),
		diagnostics,
	)
	return { index, diagnostics }
}

test('resolves an absolute URL, a relative URL and a query/fragment variant to the same part', () => {
	const { index } = fixture()
	for (const reference of ['https://example.com/a.png', 'a.png', './a.png', '/a.png', 'a.png#anchor']) {
		assert.deepEqual(resolveReference(index, reference, PAGE), { kind: 'part', partIndex: 1, url: 'https://example.com/a.png' }, `failed for ${reference}`)
	}
})

test('resolves a cid: reference through the Content-ID index, percent-encoding and all', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'cid:image@x', PAGE), { kind: 'part', partIndex: 1, url: undefined })
	assert.deepEqual(resolveReference(index, 'CID:image%40x', PAGE), { kind: 'part', partIndex: 1, url: undefined })
	assert.deepEqual(resolveReference(index, 'cid:nothing@x', PAGE), { kind: 'unresolved', url: 'cid:nothing@x' })
})

test('a synthetic cid: Content-Location is reachable by Content-ID, not as a URL', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'cid:inline@x', PAGE), { kind: 'part', partIndex: 2, url: undefined })
	assert.equal(index.partIndexByUrl.has('cid:inline@x'), false)
})

test('a reference the archive has no part for is unresolved, never a network fallback', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'https://elsewhere.example/x.png', PAGE), { kind: 'unresolved', url: 'https://elsewhere.example/x.png' })
	assert.deepEqual(resolveReference(index, 'missing.png', PAGE), { kind: 'unresolved', url: 'https://example.com/missing.png' })
})

test('does not fall back to matching by file name when the URL does not match', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'https://other.example/a.png', PAGE), { kind: 'unresolved', url: 'https://other.example/a.png' })
})

test('an empty or fragment-only reference stays as written, and never re-loads the document', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, '', PAGE), { kind: 'same-document', url: '' })
	assert.deepEqual(resolveReference(index, '   ', PAGE), { kind: 'same-document', url: '' })
	assert.deepEqual(resolveReference(index, '#section', PAGE), { kind: 'same-document', url: '#section' })
})

test('a data: URL is kept verbatim, because it carries its own bytes', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'data:image/gif;base64,AAAA', PAGE), { kind: 'self-contained', url: 'data:image/gif;base64,AAAA' })
	assert.deepEqual(resolveReference(index, 'DATA:image/gif,x', PAGE), { kind: 'self-contained', url: 'DATA:image/gif,x' })
})

test('rejects every scheme an archive must not be able to name', () => {
	const { index } = fixture()
	for (const reference of ['javascript:alert(1)', 'file:///etc/passwd', 'ws://example.com/', 'wss://example.com/', 'chrome-extension://abc/x.js', 'vbscript:x', 'mailto:a@b.c']) {
		assert.equal(resolveReference(index, reference, PAGE).kind, 'rejected', `expected ${reference} to be rejected`)
	}
})

test('a relative reference with no usable base URL is rejected rather than guessed at', () => {
	const { index } = fixture()
	assert.deepEqual(resolveReference(index, 'a.png', undefined), { kind: 'rejected', url: 'a.png' })
	assert.deepEqual(resolveReference(index, 'a.png', 'cid:something@x'), { kind: 'rejected', url: 'a.png' })
})

test('an ambiguous Content-Location resolves to nothing at all, plus a diagnostic', () => {
	const diagnostics: Diagnostic[] = []
	const index = indexArchiveResources(
		documentOf([
			part({ location: PAGE, mimeType: 'text/html' }),
			part({ location: 'https://example.com/a.png', mimeType: 'image/png' }),
			part({ location: 'https://example.com/a.png', mimeType: 'image/gif' }),
		]),
		diagnostics,
	)
	assert.deepEqual(resolveReference(index, 'https://example.com/a.png', PAGE), { kind: 'unresolved', url: 'https://example.com/a.png' })
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-location', url: 'https://example.com/a.png' }])
})

test('an ambiguous Content-ID resolves to nothing at all, plus a diagnostic', () => {
	const diagnostics: Diagnostic[] = []
	const index = indexArchiveResources(documentOf([part({ contentId: 'dup@x', mimeType: 'text/html' }), part({ contentId: 'dup@x', mimeType: 'image/png' })]), diagnostics)
	assert.deepEqual(resolveReference(index, 'cid:dup@x', PAGE), { kind: 'unresolved', url: 'cid:dup@x' })
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-id', contentId: 'dup@x' }])
})

test('a part with neither a Content-Location nor a Content-ID is simply unreachable', () => {
	const diagnostics: Diagnostic[] = []
	const index = indexArchiveResources(documentOf([part({ location: PAGE, mimeType: 'text/html' }), part({ mimeType: 'image/png' })]), diagnostics)
	assert.equal(index.partIndexByUrl.size, 1)
	assert.equal(index.partIndexByContentId.size, 0)
	assert.deepEqual(diagnostics, [])
})
