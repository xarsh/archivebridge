/**
 * Golden fixture tests: real Safari-generated WebArchive files, as opposed
 * to the hand-written synthetic cases in parse.test.ts. These assert
 * structural, meaningful properties of the parsed Archive (URLs, mime
 * types, resource counts, non-empty payloads) rather than matching fixture
 * bytes verbatim. See docs/architecture.md#testing (layer 2, "Golden
 * fixtures") and fixtures/README.md.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Archive } from '../model/archive.ts'
import { parseWebArchive } from './parse.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/webarchive/${name}`, import.meta.url))
	return readFileSync(path)
}

function resourceByMimeType(archive: Archive, mimeType: string) {
	return [...archive.resources.values()].find((resource) => resource.mimeType === mimeType)
}

test('parseWebArchive parses fixtures/webarchive/example-com.safari.webarchive (Safari, single resource)', () => {
	const { archive, diagnostics } = parseWebArchive(loadFixture('example-com.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.com/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.equal(archive.mainResource.textEncoding, 'UTF-8')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// Safari didn't capture any WebSubresources for this page (its <style> is inline), and
	// the main resource is not duplicated into `resources` (see docs/architecture.md).
	assert.equal(archive.resources.size, 0)

	const html = new TextDecoder().decode(archive.mainResource.data)
	assert.match(html, /<title>Example Domain<\/title>/)
})

test('parseWebArchive parses fixtures/webarchive/mdn-background-image.safari.webarchive (Safari, images + scripts + stylesheets)', () => {
	const { archive, diagnostics } = parseWebArchive(loadFixture('mdn-background-image.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://mdn.github.io/css-examples/learn/backgrounds-borders/background-image.html')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// A script, a stylesheet, a JPEG, and a PNG (the main HTML is not duplicated into
	// `resources`).
	assert.equal(archive.resources.size, 4)

	const png = resourceByMimeType(archive, 'image/png')
	assert.ok(png, 'expected an image/png resource')
	assert.ok(png.data.length > 0)
	// PNG signature: confirms the plist <data> element decoded to real binary
	// data, not mangled/truncated bytes.
	assert.deepEqual([...png.data.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	// Binary resources have no WebResourceTextEncodingName in Safari's output.
	assert.equal(png.textEncoding, undefined)

	const jpeg = resourceByMimeType(archive, 'image/jpeg')
	assert.ok(jpeg, 'expected an image/jpeg resource')
	assert.ok(jpeg.data.length > 0)
	// JPEG SOI/EOI markers, same rationale as the PNG signature check above.
	assert.deepEqual([...jpeg.data.slice(0, 2)], [0xff, 0xd8])
	assert.deepEqual([...jpeg.data.slice(-2)], [0xff, 0xd9])

	const css = resourceByMimeType(archive, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)

	const js = resourceByMimeType(archive, 'application/javascript')
	assert.ok(js, 'expected an application/javascript resource')
	assert.ok(js.data.length > 0)
})

test('parseWebArchive parses fixtures/webarchive/mdn-js-and-css-preload.safari.webarchive (Safari, link rel=preload)', () => {
	const { archive, diagnostics } = parseWebArchive(loadFixture('mdn-js-and-css-preload.safari.webarchive'))

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://mdn.github.io/html-examples/link-rel-preload/js-and-css/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.ok(archive.mainResource.data.length > 0)
	assert.equal(archive.frames.length, 0)

	// The preloaded script and the stylesheet (the main HTML is not duplicated into
	// `resources`).
	assert.equal(archive.resources.size, 2)

	const js = resourceByMimeType(archive, 'application/javascript')
	assert.ok(js, 'expected an application/javascript resource')
	assert.ok(js.data.length > 0)

	const css = resourceByMimeType(archive, 'text/css')
	assert.ok(css, 'expected a text/css resource')
	assert.ok(css.data.length > 0)
})
