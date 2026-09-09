import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { toBase64 } from '@exodus/bytes/base64.js'
import { parseMhtml } from './parse.ts'

const fixturePath = fileURLToPath(new URL('../../../../fixtures/mhtml/minimal.mhtml', import.meta.url))

/** Concatenates string and raw-byte chunks into one buffer, for cases whose point is the exact bytes (8bit/binary bodies, CRLF framing). */
function concatBytes(...chunks: readonly (string | Uint8Array)[]): Uint8Array {
	const encoder = new TextEncoder()
	const encoded = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk))
	const out = new Uint8Array(encoded.reduce((total, chunk) => total + chunk.length, 0))
	let offset = 0
	for (const chunk of encoded) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

test('parseMhtml parses fixtures/mhtml/minimal.mhtml into an MhtmlDocument', () => {
	const bytes = readFileSync(fixturePath)
	const { document, diagnostics } = parseMhtml(bytes)

	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts.length, 1)
	const root = document.parts[document.rootPartIndex]
	assert.equal(root?.location, 'https://example.invalid/')
	assert.equal(root?.mimeType, 'text/html')

	const html = new TextDecoder().decode(root?.data)
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'hello')
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'binary payload')
})

test('parseMhtml parses a part with no Content-Location, and it does not become the root', () => {
	// Absence of Content-Location is not itself fatal to parsing a part (docs/architecture.md,
	// MhtmlPart.location) — only genuinely unparseable bodies are dropped.
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/css',
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts.length, 2)
	const locationless = document.parts.find((part) => part.location === undefined)
	assert.equal(locationless !== undefined, true)
	assert.equal(new TextDecoder().decode(locationless?.data), 'no location here')
	assert.equal(
		document.rootPartIndex,
		document.parts.findIndex((part) => part.location === 'https://example.invalid/'),
	)
})

test('parseMhtml reports malformed-resource and drops a part with an invalid base64 body', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'Content-Transfer-Encoding: base64',
		'Content-Location: https://example.invalid/a.bin',
		'',
		'not valid base64!!',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.parts.length, 1)
	assert.deepEqual(diagnostics, [{ type: 'malformed-resource', url: 'https://example.invalid/a.bin', message: 'invalid base64 body' }])
})

test('parseMhtml reports duplicate-content-location and keeps both parts', () => {
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	// Both parts survive — MhtmlDocument.parts is a lossless reflection of the multipart
	// structure; duplicate identity is diagnosed, not silently resolved by dropping data.
	assert.equal(document.parts.length, 2)
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'first')
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-location', url: 'https://example.invalid/a.txt' }])
})

test('parseMhtml reports duplicate-content-id', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain',
		'Content-ID: <shared@archivebridge>',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'first',
		'--B',
		'Content-Type: text/plain',
		'Content-ID: <shared@archivebridge>',
		'Content-Location: https://example.invalid/b.txt',
		'',
		'second',
		'--B--',
		'',
	].join('\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.parts.length, 2)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-id', contentId: 'shared@archivebridge' }])
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'x-unknown' },
		{ type: 'malformed-archive', message: 'no main resource found in multipart/related body' },
	])
})

test('parseMhtml reports malformed-archive when the top-level Content-Type is not multipart/related', () => {
	const mhtml = ['MIME-Version: 1.0', 'Content-Type: text/html', '', '<html></html>'].join('\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(document, undefined)
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	// The root part is the *second* one in the body; start must override "first part wins".
	assert.equal(document.rootPartIndex, 1)
	assert.equal(document.parts[document.rootPartIndex]?.location, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'main document')
	assert.equal(document.parts.length, 2)
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.rootPartIndex, 0)
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'main document')
	assert.equal(document.parts.length, 2)
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

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.parts[document.rootPartIndex]?.location, 'https://example.invalid/')
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'main document')
	assert.deepEqual(diagnostics, [{ type: 'recovered-non-conforming-input', message: 'multipart/related start parameter references unknown Content-ID "missing@archivebridge"' }])
})

// --- MIME body byte preservation (RFC 2046 delimiter semantics) -------------
//
// These assert *byte equality* of a part's `data` against the exact bytes the
// source file carried, which is a stronger claim than the structural
// assertions above: a body must survive parsing verbatim, and the only bytes
// dropped from the raw span must be the ones RFC 2046 assigns to the boundary
// delimiter rather than to the body part.

test('parseMhtml preserves a 7bit body’s original CRLF bytes exactly', () => {
	const body = 'line one\r\nline two\r\nline three'
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
		body,
		'\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	// Byte-exact: no CRLF collapsed to LF anywhere inside the body.
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode(body))
})

test('parseMhtml preserves an 8bit body’s non-ASCII bytes and CRLFs exactly', () => {
	// 0xc3 0xa9 is "é" in UTF-8; 0xff is not valid UTF-8 at all, so a body that
	// survives it proves nothing decoded the payload as text on the way through.
	const body = new Uint8Array([0xc3, 0xa9, 0x0d, 0x0a, 0xff, 0xfe, 0x0d, 0x0a, 0x41])
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n',
		body,
		'\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, body)
})

test('parseMhtml preserves a binary body containing arbitrary CR and LF bytes exactly', () => {
	// A bare LF, a lone CR, and a CRLF, in one payload: every one of them has to
	// come back unchanged, including the CRLF that is *inside* the body rather
	// than in front of the delimiter.
	const body = new Uint8Array([0x00, 0x89, 0x0d, 0x0a, 0x0a, 0x0d, 0xff])
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\n\r\n',
		body,
		'\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, body)
})

test('parseMhtml excludes the multipart framing CRLF that precedes a delimiter from the body', () => {
	// RFC 2046: the CRLF immediately before `--boundary`/`--boundary--` belongs to
	// the delimiter, not to the preceding body part. So this body is exactly
	// "payload", with no trailing line ending — while the *next* part's body,
	// which really does end with a blank line, keeps one CRLF.
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\npayload\r\n--B\r\nContent-Type: text/plain\r\n\r\npayload\r\n\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('payload'))
	assert.deepEqual(document.parts[1]?.data, new TextEncoder().encode('payload\r\n'))
})

test('parseMhtml preserves LF-only bodies as LF for non-conforming input the tolerant reader still accepts', () => {
	const mhtml = concatBytes('MIME-Version: 1.0\nContent-Type: multipart/related; boundary="B"\n\n--B\nContent-Type: text/plain\nContent-Transfer-Encoding: 7bit\n\na\nb\n--B--\n')

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	// Not "corrected" to CRLF either: the reader is tolerant, not normalizing.
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('a\nb'))
})

test('parseMhtml decodes a quoted-printable soft line break without leaving a line ending behind', () => {
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nabc=\r\ndef\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('abcdef'))
})

test('parseMhtml decodes a quoted-printable hard line break to its original CRLF, not a normalized LF', () => {
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nfirst=20line\r\nsecond\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('first line\r\nsecond'))
})

test('parseMhtml decodes an explicitly quoted-printable-escaped CRLF (=0D=0A) the same as a hard line break', () => {
	const mhtml = concatBytes(
		'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nfirst=0D=0Asecond\r\n--B--\r\n',
	)

	const { document, diagnostics } = parseMhtml(mhtml)
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('first\r\nsecond'))
})

// --- Multipart opening/closing delimiter policy (RFC 2046) -------------------

test('parseMhtml reports malformed-archive when the declared boundary never appears at all', () => {
	// Previously this manufactured one empty, default text/plain part out of
	// nothing and reported a perfectly valid one-part document.
	const mhtml = ['MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="B"', '', 'Content-Type: text/html', '', 'not actually a multipart body at all', ''].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'multipart/related boundary "B" never appears as an opening delimiter' }])
})

test('parseMhtml keeps the collected parts and reports recovered-non-conforming-input when the closing delimiter is absent', () => {
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
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document, 'a truncated archive with a resolvable root still yields a document')
	assert.equal(document.parts.length, 2)
	assert.equal(document.rootPartIndex, 0)
	assert.equal(new TextDecoder().decode(document.parts[1]?.data), 'body { color: red; }')
	assert.deepEqual(diagnostics, [{ type: 'recovered-non-conforming-input', message: 'multipart/related body has no closing "--B--" delimiter' }])
})

test('parseMhtml ignores a preamble and an epilogue around a properly delimited body', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'This preamble is for non-MIME readers and is ignored per RFC 2046.',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'This epilogue is ignored too.',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts.length, 1)
	assert.deepEqual(document.parts[0]?.data, new TextEncoder().encode('main document'))
})

// --- Root-part resolution fallback chain ------------------------------------

test('parseMhtml falls back to the first part when both start and Snapshot-Content-Location reference nothing', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/stale',
		'Content-Type: multipart/related; boundary="B"; start="<missing@archivebridge>"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document, 'a stale Blink compatibility header must not be fatal to a usable archive')
	assert.equal(document.rootPartIndex, 0)
	assert.equal(new TextDecoder().decode(document.parts[document.rootPartIndex]?.data), 'main document')
	assert.deepEqual(diagnostics, [
		{ type: 'recovered-non-conforming-input', message: 'multipart/related start parameter references unknown Content-ID "missing@archivebridge"' },
		{ type: 'recovered-non-conforming-input', message: 'Snapshot-Content-Location references unknown Content-Location "https://example.invalid/stale"' },
	])
})

test('parseMhtml falls back to the first part when Snapshot-Content-Location references nothing and there is no start parameter', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/stale',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.rootPartIndex, 0)
	assert.deepEqual(diagnostics, [
		{ type: 'recovered-non-conforming-input', message: 'Snapshot-Content-Location references unknown Content-Location "https://example.invalid/stale"' },
	])
})

test('parseMhtml reports malformed-archive when an unmatched Snapshot-Content-Location has no parts left to fall back to', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Snapshot-Content-Location: https://example.invalid/stale',
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
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [
		{ type: 'unsupported-encoding', encoding: 'x-unknown' },
		{ type: 'recovered-non-conforming-input', message: 'Snapshot-Content-Location references unknown Content-Location "https://example.invalid/stale"' },
		{ type: 'malformed-archive', message: 'no main resource found in multipart/related body' },
	])
})

// --- MIME quoted-string parameter parsing -----------------------------------

test('parseMhtml does not split a quoted parameter value at a semicolon that follows an escaped quote', () => {
	// `start` carries an RFC 5322 msg-id whose local-part is a quoted-string
	// containing both a `"` and a `;`, so the parameter itself needs quoted-pair
	// escaping. A parser that toggles quote state on every `"` regardless of
	// escaping ends this parameter early and splits the value at the `;`, losing
	// both the boundary parameter that follows and the root part identity.
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; start="<\\"a;b\\"@example.invalid>"; boundary="B"',
		'',
		'--B',
		'Content-Type: text/css',
		'Content-Location: https://example.invalid/style.css',
		'',
		'body { color: red; }',
		'--B',
		'Content-Type: text/html',
		'Content-ID: <"a;b"@example.invalid>',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts.length, 2, 'the boundary parameter after the quoted start parameter must still be found')
	assert.equal(document.rootPartIndex, 1)
	assert.equal(document.parts[1]?.contentId, '"a;b"@example.invalid')
})

test('parseMhtml unescapes quoted-pairs in a parameter value rather than returning them raw', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html; charset="utf-\\8"',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts[0]?.textEncoding, 'utf-8')
})

test('parseMhtml recovers a syntactically invalid media type to the RFC 2045 §5.2 default', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: not a media type',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'data',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.parts[0]?.mimeType, 'text/plain')
	// RFC 2045 §5.2's default is the whole of `text/plain; charset=us-ascii`,
	// and §5.2 recommends assuming *that* default for a syntactically invalid
	// header — so the charset half applies here exactly as it does when
	// `Content-Type` is absent entirely.
	assert.equal(document.parts[0]?.textEncoding, 'us-ascii')
	assert.deepEqual(diagnostics, [
		{
			type: 'recovered-non-conforming-input',
			message: 'part for "https://example.invalid/a.txt" declares a syntactically invalid media type "not a media type"; defaulted to text/plain',
		},
	])
})

test('parseMhtml discards a charset parsed out of a syntactically invalid Content-Type', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: not a media type; charset=utf-8',
		'Content-Location: https://example.invalid/a.txt',
		'',
		'data',
		'--B--',
		'',
	].join('\r\n')

	const { document } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.parts[0]?.mimeType, 'text/plain')
	// Not `utf-8`. RFC 2045 §5.2's default is applied whole, and §5.1's grammar
	// (`type "/" subtype *(";" parameter)`) puts the parameters in the same
	// production as the media type — so once the media type fails to parse
	// there is no valid Content-Type field for `charset` to be a parameter of.
	// Salvaging it would mean trusting half of a field already declared
	// invalid, which no MIME rule supports.
	assert.equal(document.parts[0]?.textEncoding, 'us-ascii')
})

test('parseMhtml leaves textEncoding undefined for a valid media type that declares no charset', () => {
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/a.html',
		'',
		'<!DOCTYPE html><meta charset="shift_jis">',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	// Deliberately *not* us-ascii: RFC 2045 §5.2's default applies to a missing
	// or invalid Content-Type, not to a valid one that simply omits `charset`.
	// "No MIME-level charset" is what tells a consumer to honor the document's
	// own `<meta charset>` instead.
	assert.equal(document.parts[0]?.textEncoding, undefined)
})

test('parseMhtml reports malformed-archive when the boundary parameter is missing', () => {
	const mhtml = ['MIME-Version: 1.0', 'Content-Type: multipart/related', '', 'body'].join('\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.equal(document, undefined)
	assert.deepEqual(diagnostics, [{ type: 'malformed-archive', message: 'multipart/related is missing a boundary parameter' }])
})

test('parseMhtml stays tolerant of an unterminated quoted parameter value instead of failing or hanging', () => {
	// Foreign, malformed input: the `start` parameter's quoted-string is never closed
	// (its would-be closing quote is escaped), so it swallows the rest of the header.
	// The tolerant reader must still produce a document — here via the first-part
	// fallback, since the boundary swallowed along with it came from the parameter the
	// envelope did parse.
	const mhtml = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"; start="<missing@example.invalid\\"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(mhtml))
	assert.ok(document)
	assert.equal(document.rootPartIndex, 0)
	assert.equal(new TextDecoder().decode(document.parts[0]?.data), 'main document')
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'recovered-non-conforming-input')
})
