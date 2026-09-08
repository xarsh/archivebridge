import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { toBase64 } from '@exodus/bytes/base64.js'
import { parseMhtml } from './parse.ts'

const fixturePath = fileURLToPath(new URL('../../../../fixtures/mhtml/minimal.mhtml', import.meta.url))

test('parseMhtml parses fixtures/mhtml/minimal.mhtml into an Archive', () => {
	const bytes = readFileSync(fixturePath)
	const { archive, diagnostics } = parseMhtml(bytes)

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(archive.mainResource.url, 'https://example.invalid/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	// The main resource is not duplicated into `resources`; this fixture has no subresources.
	assert.equal(archive.resources.size, 0)
	assert.equal(archive.frames.length, 0)

	const html = new TextDecoder().decode(archive.mainResource.data)
	// The fixture has a blank line before its closing boundary; per RFC 2046 only the
	// CRLF immediately preceding the delimiter belongs to the delimiter, so one trailing
	// newline is genuinely part of the body content.
	assert.equal(html, '<!DOCTYPE html><html><head><title>Example</title></head><body><p>Minimal synthetic MHTML fixture for ArchiveBridge tests.</p></body></html>\n')
})

test('parseMhtml handles CRLF line endings the same as LF', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'hello',
		'--B--',
		'',
	].join('\r\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'hello')
})

test('parseMhtml decodes a base64 body', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: application/octet-stream',
		'Content-Transfer-Encoding: base64',
		'Content-Location: https://example.invalid/blob.bin',
		'',
		toBase64(new TextEncoder().encode('binary payload')),
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'binary payload')
})

test('parseMhtml drops a part missing Content-Location and reports malformed-resource', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'',
		'no location here',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(archive)
	// The malformed part is dropped; the remaining (main) part is not duplicated into `resources`.
	assert.equal(archive.resources.size, 0)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-resource')
})

test('parseMhtml reports duplicate-resource-url and keeps the first occurrence', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'first',
		'--B',
		'Content-Type: text/plain',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'second',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(archive)
	// The first occurrence becomes the main resource (no Snapshot-Content-Location header);
	// the second is a duplicate of it and is dropped, not added to `resources`.
	assert.equal(archive.resources.size, 0)
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'first')
	assert.deepEqual(diagnostics, [{ type: 'duplicate-resource-url', url: 'https://example.invalid/a.txt' }])
})

test('parseMhtml reports duplicate-resource-url when a part repeats the declared main resource URL', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'second copy',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(archive)
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'main document')
	// `resources` must not gain a second entry for the main resource's URL.
	assert.equal(archive.resources.size, 0)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-resource-url', url: 'https://example.invalid/' }])
})

test('parseMhtml reports unsupported-encoding and drops the part', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'Content-Transfer-Encoding: x-unknown',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'data',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(archive, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'x-unknown' },
		{ type: 'malformed-archive', message: 'no main resource found in multipart/related body' },
	])
})

test('parseMhtml reports malformed-archive when the top-level Content-Type is not multipart/related', () => {
	const mhtml = ['MIME-Version: 1.0', 'Content-Type: text/html', '', '<html></html>'].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(archive, undefined)
	assert.deepEqual(diagnostics, [{ type: 'unsupported-feature', feature: 'top-level Content-Type "text/html"' }])
})

test('parseMhtml selects the root part via the RFC 2387 start parameter, independent of part order', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"; start="<root@archivebridge>"',
		'',
		'--B',
		'Content-Type: text/css',
		'Content-Location: https://example.invalid/style.css',
		'',
		'body { color: red; }',
		'--B',
		'Content-Type: text/html',
		'Content-ID: <root@archivebridge>',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	// The root part is the *second* one in the body; start must override "first part wins".
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'main document')
	assert.equal(archive.resources.size, 1)
	assert.ok(archive.resources.has('https://example.invalid/style.css'))
})

test('parseMhtml treats the first part as the root per RFC 2387 when there is no start parameter or Snapshot-Content-Location', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B',
		'Content-Type: text/css',
		'Content-Location: https://example.invalid/style.css',
		'',
		'body { color: red; }',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'main document')
	assert.equal(archive.resources.size, 1)
	assert.ok(archive.resources.has('https://example.invalid/style.css'))
})

test('parseMhtml falls back to Snapshot-Content-Location and reports recovered-non-conforming-input when start references an unknown Content-ID', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/',
		'Content-Type: multipart/related; boundary="B"; start="<missing@archivebridge>"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(archive.mainResource.data), 'main document')
	assert.deepEqual(diagnostics, [{ type: 'recovered-non-conforming-input', message: 'multipart/related start parameter references unknown Content-ID "missing@archivebridge"' }])
})

test('parseMhtml reports malformed-archive when the boundary parameter is missing', () => {
	const mhtml = ['MIME-Version: 1.0', 'Content-Type: multipart/related', '', 'body'].join('\n')

	const { archive, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(archive, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'multipart/related is missing a boundary parameter' }])
})
