import assert from 'node:assert/strict'
import test from 'node:test'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { extractHtmlTitle, extractMhtmlRootTitle } from './html-title.ts'
import { textCodecFor } from './text-codec.ts'

function htmlPart(html: string, overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return {
		contentId: undefined,
		location: 'https://example.invalid/',
		mimeType: 'text/html',
		textEncoding: undefined,
		data: new TextEncoder().encode(html),
		...overrides,
	}
}

function documentOf(...parts: MhtmlPart[]): MhtmlDocument {
	return { parts, rootPartIndex: 0 }
}

test('extractHtmlTitle reads a plain ASCII title', () => {
	assert.equal(extractHtmlTitle('<html><head><title>Example Domain</title></head><body></body></html>'), 'Example Domain')
})

test('extractHtmlTitle reads a Unicode title verbatim', () => {
	assert.equal(extractHtmlTitle('<html><head><title>はてなブックマーク</title></head></html>'), 'はてなブックマーク')
})

test('extractHtmlTitle decodes HTML character references', () => {
	assert.equal(extractHtmlTitle('<title>A &amp; B</title>'), 'A & B')
})

test('extractHtmlTitle collapses newlines and repeated whitespace', () => {
	assert.equal(extractHtmlTitle('<title>\n  GitHub  \t·\n\nChange is constant.  </title>'), 'GitHub · Change is constant.')
})

test('extractHtmlTitle returns undefined when there is no title element', () => {
	assert.equal(extractHtmlTitle('<html><body><h1>Not a title</h1></body></html>'), undefined)
})

test('extractHtmlTitle returns undefined for an empty title', () => {
	assert.equal(extractHtmlTitle('<title></title>'), undefined)
})

test('extractHtmlTitle returns undefined for a whitespace-only title', () => {
	assert.equal(extractHtmlTitle('<title>   \n\t  </title>'), undefined)
})

test("extractHtmlTitle never uses an inert <template>'s title", () => {
	assert.equal(extractHtmlTitle('<template><title>inactive</title></template><body></body>'), undefined)
})

test('extractHtmlTitle does not throw on malformed HTML', () => {
	assert.doesNotThrow(() => extractHtmlTitle('<title>unterminated'))
	assert.equal(extractHtmlTitle('<title>unterminated'), 'unterminated')
})

test("extractMhtmlRootTitle reads the root part's title", () => {
	const document = documentOf(htmlPart('<title>Example Domain</title>'))
	assert.equal(extractMhtmlRootTitle(document), 'Example Domain')
})

test('extractMhtmlRootTitle honors a non-zero rootPartIndex', () => {
	const document: MhtmlDocument = {
		parts: [htmlPart('<title>frame</title>', { location: 'https://example.invalid/frame' }), htmlPart('<title>root</title>')],
		rootPartIndex: 1,
	}
	assert.equal(extractMhtmlRootTitle(document), 'root')
})

test('extractMhtmlRootTitle returns undefined when the root part is not HTML', () => {
	const document = documentOf({
		contentId: undefined,
		location: undefined,
		mimeType: 'text/plain',
		textEncoding: undefined,
		data: new TextEncoder().encode('<title>not html</title>'),
	})
	assert.equal(extractMhtmlRootTitle(document), undefined)
})

test('extractMhtmlRootTitle is case-insensitive on the declared media type', () => {
	const document = documentOf(htmlPart('<title>Example</title>', { mimeType: 'Text/HTML' }))
	assert.equal(extractMhtmlRootTitle(document), 'Example')
})

test('extractMhtmlRootTitle decodes the root part using its declared textEncoding', () => {
	const title = 'はてなブックマーク'
	const codec = textCodecFor('shift_jis')
	const encoded = codec.encode(`<html><head><title>${title}</title></head></html>`)
	assert.notEqual(encoded, undefined)
	const document = documentOf(htmlPart('', { textEncoding: 'shift_jis', data: encoded ?? new Uint8Array() }))
	assert.equal(extractMhtmlRootTitle(document), title)
})
