import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildBinary } from 'plist'
import { parseWebArchive } from './parse.ts'

const fixturePath = fileURLToPath(new URL('../../../../fixtures/webarchive/minimal.webarchive', import.meta.url))

function xmlPlist(dict: string): Uint8Array {
	const plist = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		dict,
		'</plist>',
	].join('\n')
	return new TextEncoder().encode(plist)
}

test('parseWebArchive parses fixtures/webarchive/minimal.webarchive into an Archive', () => {
	const bytes = readFileSync(fixturePath)
	const { archive, diagnostics } = parseWebArchive(bytes)

	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(archive.mainResource.url, 'https://example.invalid/')
	assert.equal(archive.mainResource.mimeType, 'text/html')
	assert.equal(archive.mainResource.textEncoding, 'UTF-8')
	// The fixture's WebSubresources is an empty array, and the main resource is not
	// duplicated into `resources` (see docs/architecture.md).
	assert.equal(archive.resources.size, 0)
	assert.equal(archive.frames.length, 0)

	const html = new TextDecoder().decode(archive.mainResource.data)
	assert.match(html, /Minimal synthetic WebArchive fixture/)
})

test('parseWebArchive parses a binary plist (bplist00)', () => {
	const bytes = buildBinary({
		WebMainResource: {
			WebResourceURL: 'https://example.invalid/',
			WebResourceMIMEType: 'text/html',
			WebResourceTextEncodingName: 'UTF-8',
			WebResourceData: new TextEncoder().encode('<html>binary plist</html>'),
		},
	})

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	assert.equal(archive.mainUrl, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(archive.mainResource.data), '<html>binary plist</html>')
})

test('parseWebArchive collects WebSubresources into resources', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/style.css</string>',
			'<key>WebResourceMIMEType</key><string>text/css</string>',
			'<key>WebResourceData</key><data>Ym9keSB7fQ==</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(archive)
	// Only the subresource; the main resource is not duplicated into `resources`.
	assert.equal(archive.resources.size, 1)
	const css = archive.resources.get('https://example.invalid/style.css')
	assert.ok(css)
	assert.equal(css.mimeType, 'text/css')
	assert.equal(new TextDecoder().decode(css.data), 'body {}')
	// Binary resources have no WebResourceTextEncodingName; the model must not invent one.
	assert.equal(css.textEncoding, undefined)
})

test('parseWebArchive drops a subresource missing WebResourceURL and reports malformed-resource', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceMIMEType</key><string>text/css</string>',
			'<key>WebResourceData</key><data>Ym9keSB7fQ==</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.ok(archive)
	// The malformed subresource is dropped; nothing else was added to `resources`.
	assert.equal(archive.resources.size, 0)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-resource')
})

test('parseWebArchive reports duplicate-resource-url and keeps the first occurrence', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/a.txt</string>',
			'<key>WebResourceMIMEType</key><string>text/plain</string>',
			'<key>WebResourceData</key><data>Zmlyc3Q=</data>',
			'</dict>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/a.txt</string>',
			'<key>WebResourceMIMEType</key><string>text/plain</string>',
			'<key>WebResourceData</key><data>c2Vjb25k</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.ok(archive)
	assert.equal(new TextDecoder().decode(archive.resources.get('https://example.invalid/a.txt')?.data), 'first')
	assert.deepEqual(diagnostics, [{ type: 'duplicate-resource-url', url: 'https://example.invalid/a.txt' }])
})

test('parseWebArchive reports duplicate-resource-url when a subresource repeats the main resource URL', () => {
	const bytes = xmlPlist(
		[
			'<dict>',
			'<key>WebMainResource</key>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>PGh0bWw+PC9odG1sPg==</data>',
			'</dict>',
			'<key>WebSubresources</key>',
			'<array>',
			'<dict>',
			'<key>WebResourceURL</key><string>https://example.invalid/</string>',
			'<key>WebResourceMIMEType</key><string>text/html</string>',
			'<key>WebResourceData</key><data>c2Vjb25k</data>',
			'</dict>',
			'</array>',
			'</dict>',
		].join('\n'),
	)

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.ok(archive)
	// `resources` must not gain a second entry for the main resource's URL.
	assert.equal(archive.resources.size, 0)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-resource-url', url: 'https://example.invalid/' }])
})

test('parseWebArchive reports malformed-archive when WebMainResource is missing', () => {
	const bytes = xmlPlist(['<dict>', '<key>WebSubresources</key>', '<array/>', '</dict>'].join('\n'))

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.equal(archive, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'WebArchive is missing WebMainResource' }])
})

test('parseWebArchive reports malformed-archive when the top-level plist is not a dictionary', () => {
	const bytes = xmlPlist('<string>not a dictionary</string>')

	const { archive, diagnostics } = parseWebArchive(bytes)
	assert.equal(archive, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'top-level property list is not a dictionary' }])
})

test('parseWebArchive reports malformed-archive for bytes that are not a plist at all', () => {
	const { archive, diagnostics } = parseWebArchive(new TextEncoder().encode('not a plist'))

	assert.equal(archive, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-archive')
})

test('parseWebArchive does not leak the XML parser fatal error to console.error', () => {
	// `plist`'s XML backend (`@xmldom/xmldom`) writes fatal parse errors straight to
	// console.error by default; parseWebArchive must suppress that so a malformed
	// archive produces a diagnostic and nothing else on stderr.
	const originalConsoleError = console.error
	const calls: unknown[][] = []
	console.error = (...args: unknown[]) => {
		calls.push(args)
	}
	try {
		parseWebArchive(new TextEncoder().encode('not a plist'))
	} finally {
		console.error = originalConsoleError
	}
	assert.deepEqual(calls, [])
})
