/**
 * Golden fixture tests: real Chrome-generated MHTML, as opposed to the
 * hand-written synthetic cases in parse.test.ts. These assert structural,
 * meaningful properties of the parsed MhtmlDocument (URLs, mime types, part
 * counts, non-empty payloads) rather than matching fixture bytes verbatim —
 * boundaries, dates, and Content-IDs are generated at save time and carry no
 * meaning of their own. See docs/architecture.md#testing (layer 2, "Golden
 * fixtures") and fixtures/README.md.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { parseMhtml } from './parse.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/mhtml/${name}`, import.meta.url))
	return readFileSync(path)
}

function partByMimeType(document: MhtmlDocument, mimeType: string): MhtmlPart | undefined {
	return document.parts.find((part) => part.mimeType === mimeType)
}

test('parseMhtml parses fixtures/mhtml/example-com.chrome.mhtml (Chrome, single stylesheet)', () => {
	const { document, diagnostics } = parseMhtml(loadFixture('example-com.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'https://example.com/')
	assert.equal(root?.mimeType, 'text/html')
	assert.ok((root?.data.length ?? 0) > 0)

	// The main HTML plus the one stylesheet Chrome inlined behind a cid: URL.
	assert.ok(document.parts.length >= 2)

	const html = new TextDecoder().decode(root?.data)
	assert.match(html, /<title>Example Domain<\/title>/)

	const css = partByMimeType(document, 'text/css')
	assert.ok(css, 'expected a text/css part')
	assert.ok(css.data.length > 0)
	assert.match(css.location ?? '', /^cid:/)
})

test('parseMhtml parses fixtures/mhtml/mdn-background-image.chrome.mhtml (Chrome, images + multiple stylesheets)', () => {
	const { document, diagnostics } = parseMhtml(loadFixture('mdn-background-image.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'https://mdn.github.io/css-examples/learn/backgrounds-borders/background-image.html')
	assert.equal(root?.mimeType, 'text/html')
	assert.ok((root?.data.length ?? 0) > 0)

	// The main HTML, an external stylesheet, two images, and two cid: stylesheets.
	assert.ok(document.parts.length >= 5)

	const png = partByMimeType(document, 'image/png')
	assert.ok(png, 'expected an image/png part')
	assert.ok(png.data.length > 0)
	// PNG signature: confirms the base64 body decoded to real binary data, not
	// mangled/truncated bytes.
	assert.deepEqual([...png.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

	const jpeg = partByMimeType(document, 'image/jpeg')
	assert.ok(jpeg, 'expected an image/jpeg part')
	assert.ok(jpeg.data.length > 0)
	// JPEG SOI/EOI markers, same rationale as the PNG signature check above.
	assert.deepEqual([...jpeg.data.slice(0, 2)], [0xff, 0xd8])
	assert.deepEqual([...jpeg.data.slice(-2)], [0xff, 0xd9])

	const css = partByMimeType(document, 'text/css')
	assert.ok(css, 'expected at least one text/css part')
	assert.ok(css.data.length > 0)
})

test('parseMhtml parses fixtures/mhtml/mdn-js-and-css-preload.chrome.mhtml (Chrome, link rel=preload)', () => {
	const { document, diagnostics } = parseMhtml(loadFixture('mdn-js-and-css-preload.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'https://mdn.github.io/html-examples/link-rel-preload/js-and-css/')
	assert.equal(root?.mimeType, 'text/html')
	assert.ok((root?.data.length ?? 0) > 0)

	// The main HTML plus the stylesheet it actually applies (`<link rel="stylesheet">`). The
	// page also has a `<link rel="preload" as="script">` for main.js, but Chrome does not
	// capture preload-only resources into the saved MHTML unless they were also otherwise
	// used by the page, so no application/javascript part is expected here.
	assert.ok(document.parts.length >= 2)

	const css = partByMimeType(document, 'text/css')
	assert.ok(css, 'expected a text/css part')
	assert.ok(css.data.length > 0)
})

test('parseMhtml parses fixtures/mhtml/frames-nested.chrome.mhtml (Chrome, 2-level same-origin iframe chain)', () => {
	const { document, diagnostics } = parseMhtml(loadFixture('frames-nested.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	// main -> mid.html -> leaf.html, each its own flat sibling MIME part.
	assert.equal(document.parts.length, 3)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'http://127.0.0.1:8091/iframe-nested/')

	const rootHtml = new TextDecoder().decode(root?.data)
	const rootCidMatch = rootHtml.match(/cid:([^"'=\s]+)/)
	assert.ok(rootCidMatch, 'expected the root document to reference a child frame via cid:')
	const childCid = decodeURIComponent(rootCidMatch[1] ?? '')
	const child = document.parts.find((part) => part.contentId === childCid)
	assert.ok(child, 'expected the referenced cid: to match a sibling part’s Content-ID')
	assert.equal(child.location, 'http://127.0.0.1:8091/iframe-nested/mid.html')

	const childHtml = new TextDecoder().decode(child.data)
	const grandchildCidMatch = childHtml.match(/cid:([^"'=\s]+)/)
	assert.ok(grandchildCidMatch, 'expected the mid-level document to reference a further child frame via cid:')
	const grandchildCid = decodeURIComponent(grandchildCidMatch[1] ?? '')
	const grandchild = document.parts.find((part) => part.contentId === grandchildCid)
	assert.ok(grandchild, 'expected the referenced cid: to match a sibling part’s Content-ID')
	assert.equal(grandchild.location, 'http://127.0.0.1:8091/iframe-nested/leaf.html')
})

test('parseMhtml parses fixtures/mhtml/frames-cross-origin.chrome.mhtml (Chrome, cross-origin iframe sibling)', () => {
	const { document, diagnostics } = parseMhtml(loadFixture('frames-cross-origin.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts.length, 2)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'http://127.0.0.1:8091/iframe-cross-origin/')

	const rootHtml = new TextDecoder().decode(root?.data)
	const cidMatch = rootHtml.match(/cid:([^"'=\s]+)/)
	assert.ok(cidMatch, 'expected the root document to reference the cross-origin child frame via cid:')
	const childCid = decodeURIComponent(cidMatch[1] ?? '')
	const child = document.parts.find((part) => part.contentId === childCid)
	assert.ok(child, 'expected the referenced cid: to match a sibling part’s Content-ID')
	assert.equal(child.location, 'http://127.0.0.1:8092/iframe-cross-origin/child.html')
})
