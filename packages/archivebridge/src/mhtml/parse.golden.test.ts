/**
 * Golden fixture tests: real Chrome-generated MHTML, as opposed to the
 * hand-written synthetic cases in parse.test.ts. These assert structural,
 * meaningful properties of the parsed Archive (URLs, mime types, resource
 * counts, non-empty payloads) rather than matching fixture bytes verbatim —
 * boundaries, dates, and Content-IDs are generated at save time and carry no
 * meaning of their own. See docs/architecture.md#testing (layer 2, "Golden
 * fixtures") and fixtures/README.md.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Archive } from '../model/archive.ts'
import { parseMhtml } from './parse.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/mhtml/${name}`, import.meta.url))
	return readFileSync(path)
}

function resourceByMimeType(archive: Archive, mimeType: string) {
	return [...archive.resources.values()].find((resource) => resource.mimeType === mimeType)
}

test('parseMhtml parses fixtures/mhtml/example-com.chrome.mhtml (Chrome, single stylesheet)', () => {
	const { archive, diagnostics } = parseMhtml(loadFixture('example-com.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.com/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// The one stylesheet Chrome inlined behind a cid: URL. The main HTML itself is not
	// duplicated into `resources` (see docs/architecture.md).
	assert.ok(archive.resources.size >= 1)

	const html = new TextDecoder().decode(archive.mainResource.data)
	assert.match(html, /<title>Example Domain<\/title>/)

	const css = resourceByMimeType(archive, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)
	assert.match(css.url, /^cid:/)
})

test('parseMhtml parses fixtures/mhtml/mdn-background-image.chrome.mhtml (Chrome, images + multiple stylesheets)', () => {
	const { archive, diagnostics } = parseMhtml(loadFixture('mdn-background-image.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://mdn.github.io/css-examples/learn/backgrounds-borders/background-image.html')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// An external stylesheet, two images, and two cid: stylesheets (the main HTML is not
	// duplicated into `resources`).
	assert.ok(archive.resources.size >= 4)

	const png = resourceByMimeType(archive, 'image/png')
	assert.ok(png, 'expected an image/png resource')
	assert.ok(png.data.length > 0)
	// PNG signature: confirms the base64 body decoded to real binary data, not
	// mangled/truncated bytes.
	assert.deepEqual([...png.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

	const jpeg = resourceByMimeType(archive, 'image/jpeg')
	assert.ok(jpeg, 'expected an image/jpeg resource')
	assert.ok(jpeg.data.length > 0)
	// JPEG SOI/EOI markers, same rationale as the PNG signature check above.
	assert.deepEqual([...jpeg.data.slice(0, 2)], [0xff, 0xd8])
	assert.deepEqual([...jpeg.data.slice(-2)], [0xff, 0xd9])

	const css = resourceByMimeType(archive, 'text/css')
	assert.ok(css, 'expected at least one text/css resource')
	assert.ok(css.data.length > 0)
})

test('parseMhtml parses fixtures/mhtml/mdn-js-and-css-preload.chrome.mhtml (Chrome, link rel=preload)', () => {
	const { archive, diagnostics } = parseMhtml(loadFixture('mdn-js-and-css-preload.chrome.mhtml'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://mdn.github.io/html-examples/link-rel-preload/js-and-css/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// The stylesheet it actually applies (`<link rel="stylesheet">`); the main HTML is not
	// duplicated into `resources`. The page also has a `<link rel="preload" as="script">`
	// for main.js, but Chrome does not capture preload-only resources into the saved MHTML
	// unless they were also otherwise used by the page, so no application/javascript
	// resource is expected here.
	assert.ok(archive.resources.size >= 1)

	const css = resourceByMimeType(archive, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)
})
