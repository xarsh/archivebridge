/**
 * Golden fixture tests: real Safari/WebKit-generated WebArchive files, as
 * opposed to the hand-written synthetic cases in parse.test.ts. These
 * assert structural, meaningful properties of the parsed WebArchiveDocument
 * (URLs, mime types, resource counts, non-empty payloads) rather than
 * matching fixture bytes verbatim. See docs/architecture.md#testing (layer
 * 2, "Golden fixtures") and fixtures/README.md.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'
import { parseWebArchive } from './parse.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/webarchive/${name}`, import.meta.url))
	return readFileSync(path)
}

function resourceByMimeType(document: WebArchiveDocument, mimeType: string): WebArchiveResource | undefined {
	return document.subresources.find((resource) => resource.mimeType === mimeType)
}

test('parseWebArchive parses fixtures/webarchive/example-com.safari.webarchive (Safari, single resource)', () => {
	const { document, diagnostics } = parseWebArchive(loadFixture('example-com.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'https://example.com/')
	assert.equal(document.mainResource.mimeType, 'text/html')
	assert.equal(document.mainResource.textEncoding, 'UTF-8')
	assert.ok(document.mainResource.data.length > 0)
	assert.equal(document.subframeArchives.length, 0)

	// Safari didn't capture any WebSubresources for this page (its <style> is inline).
	assert.equal(document.subresources.length, 0)

	const html = new TextDecoder().decode(document.mainResource.data)
	assert.match(html, /<title>Example Domain<\/title>/)
})

test('parseWebArchive parses fixtures/webarchive/mdn-background-image.safari.webarchive (Safari, images + scripts + stylesheets)', () => {
	const { document, diagnostics } = parseWebArchive(loadFixture('mdn-background-image.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'https://mdn.github.io/css-examples/learn/backgrounds-borders/background-image.html')
	assert.equal(document.mainResource.mimeType, 'text/html')
	assert.ok(document.mainResource.data.length > 0)
	assert.equal(document.subframeArchives.length, 0)

	// A script, a stylesheet, a JPEG, and a PNG.
	assert.equal(document.subresources.length, 4)

	const png = resourceByMimeType(document, 'image/png')
	assert.ok(png, 'expected an image/png resource')
	assert.ok(png.data.length > 0)
	// PNG signature: confirms the plist <data> element decoded to real binary
	// data, not mangled/truncated bytes.
	assert.deepEqual([...png.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	// Binary resources have no WebResourceTextEncodingName in Safari's output.
	assert.equal(png.textEncoding, undefined)

	const jpeg = resourceByMimeType(document, 'image/jpeg')
	assert.ok(jpeg, 'expected an image/jpeg resource')
	assert.ok(jpeg.data.length > 0)
	// JPEG SOI/EOI markers, same rationale as the PNG signature check above.
	assert.deepEqual([...jpeg.data.slice(0, 2)], [0xff, 0xd8])
	assert.deepEqual([...jpeg.data.slice(-2)], [0xff, 0xd9])

	const css = resourceByMimeType(document, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)

	const js = resourceByMimeType(document, 'application/javascript')
	assert.ok(js, 'expected an application/javascript resource')
	assert.ok(js.data.length > 0)
})

test('parseWebArchive parses fixtures/webarchive/mdn-js-and-css-preload.safari.webarchive (Safari, link rel=preload)', () => {
	const { document, diagnostics } = parseWebArchive(loadFixture('mdn-js-and-css-preload.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'https://mdn.github.io/html-examples/link-rel-preload/js-and-css/')
	assert.equal(document.mainResource.mimeType, 'text/html')
	assert.ok(document.mainResource.data.length > 0)
	assert.equal(document.subframeArchives.length, 0)

	// The preloaded script and the stylesheet.
	assert.equal(document.subresources.length, 2)

	const js = resourceByMimeType(document, 'application/javascript')
	assert.ok(js, 'expected an application/javascript resource')
	assert.ok(js.data.length > 0)

	const css = resourceByMimeType(document, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)
})

test('parseWebArchive parses fixtures/webarchive/frames-nested.safari.webarchive (WKWebView, 2-level recursive WebSubframeArchives)', () => {
	const { document, diagnostics } = parseWebArchive(loadFixture('frames-nested.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'http://127.0.0.1:8091/case-b/index.html')
	assert.equal(document.mainResource.frameName, '')
	assert.equal(document.subresources.length, 1)
	assert.equal(document.subresources[0]?.url, 'http://127.0.0.1:8091/style.css')
	// WebKit writes WebResourceResponse only on subresources, never on any WebMainResource.
	assert.ok(document.subresources[0]?.response !== undefined)
	assert.equal(document.mainResource.response, undefined)

	assert.equal(document.subframeArchives.length, 1)
	const level2 = document.subframeArchives[0]
	assert.equal(level2?.mainResource.url, 'http://127.0.0.1:8091/case-b/level2.html')
	// Frame names are synthesized sequentially across the whole document, not per-subtree.
	assert.equal(level2?.mainResource.frameName, '<!--frame1-->')

	assert.equal(level2?.subframeArchives.length, 1)
	const level3 = level2?.subframeArchives[0]
	assert.equal(level3?.mainResource.url, 'http://127.0.0.1:8091/case-b/level3.html')
	assert.equal(level3?.mainResource.frameName, '<!--frame2-->')
	// The deepest frame has no further subresources/subframes.
	assert.equal(level3?.subresources.length, 0)
	assert.equal(level3?.subframeArchives.length, 0)
})

test('parseWebArchive parses fixtures/webarchive/frames-cross-origin.safari.webarchive (WKWebView, same-origin + cross-origin sibling subframes)', () => {
	const { document, diagnostics } = parseWebArchive(loadFixture('frames-cross-origin.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.mainResource.url, 'http://127.0.0.1:8091/case-c/index.html')
	assert.equal(document.subframeArchives.length, 2)

	const [same, cross] = document.subframeArchives
	assert.equal(same?.mainResource.url, 'http://127.0.0.1:8091/case-c/child-same.html')
	assert.equal(cross?.mainResource.url, 'http://127.0.0.1:8092/case-c/child-cross.html')
	// Each frame fetched its own independent copy of the stylesheet — no cross-frame dedup.
	assert.equal(same?.subresources[0]?.url, 'http://127.0.0.1:8091/style.css')
	assert.equal(cross?.subresources[0]?.url, 'http://127.0.0.1:8092/style.css')
})
