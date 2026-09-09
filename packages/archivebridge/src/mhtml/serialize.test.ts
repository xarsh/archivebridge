import assert from 'node:assert/strict'
import test from 'node:test'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { parseMhtml } from './parse.ts'
import { serializeMhtml } from './serialize.ts'

/** Strips generated Content-IDs so a round-tripped document can be compared against the literal input that had none. */
function withoutContentIds(document: MhtmlDocument): MhtmlDocument {
	return { ...document, parts: document.parts.map((part) => ({ ...part, contentId: undefined })) }
}

test('serializeMhtml produces standards-conforming multipart/related MHTML', () => {
	const document: MhtmlDocument = {
		parts: [{ contentId: undefined, location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: 'utf-8', data: new TextEncoder().encode('<html></html>') }],
		rootPartIndex: 0,
	}

	const bytes = serializeMhtml(document)
	const text = new TextDecoder().decode(bytes)

	assert.match(text, /^MIME-Version: 1\.0\r\n/)
	// The root part is identified via RFC 2387's `start` parameter, not the Blink-specific
	// `Snapshot-Content-Location` header, which this serializer never writes.
	const contentTypeMatch = text.match(/Content-Type: multipart\/related; type="text\/html"; boundary="([^"]+)"; start="<([^>]+)>"\r\n/)
	assert.ok(contentTypeMatch, 'expected a Content-Type header with boundary and start parameters')
	assert.doesNotMatch(text, /Snapshot-Content-Location/)

	const rootContentId = contentTypeMatch[2]
	assert.match(text, new RegExp(`Content-ID: <${rootContentId}>\\r\\n`))
	assert.match(text, /Content-Location: https:\/\/example\.invalid\/\r\n/)
	assert.match(text, /Content-Transfer-Encoding: base64\r\n/)
	// The document must end with the closing delimiter (`--boundary--`) followed by a CRLF.
	assert.match(text, /--\r\n$/)
})

test('serializeMhtml assigns every part a Content-ID, not only the root', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: undefined, location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: 'utf-8', data: new TextEncoder().encode('<html></html>') },
			{ contentId: undefined, location: 'https://example.invalid/style.css', mimeType: 'text/css', textEncoding: 'utf-8', data: new TextEncoder().encode('body {}') },
		],
		rootPartIndex: 0,
	}

	const bytes = serializeMhtml(document)
	const text = new TextDecoder().decode(bytes)
	assert.equal([...text.matchAll(/Content-ID:/g)].length, 2)

	const { document: roundTripped, diagnostics } = parseMhtml(bytes)
	assert.deepEqual(diagnostics, [])
	assert.ok(roundTripped?.parts.every((part) => typeof part.contentId === 'string' && part.contentId.length > 0))
})

test('serializeMhtml preserves an existing Content-ID rather than regenerating it', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: 'stable@archivebridge', location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: 'utf-8', data: new TextEncoder().encode('<html></html>') },
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))
	assert.deepEqual(diagnostics, [])
	assert.equal(roundTripped?.parts[0]?.contentId, 'stable@archivebridge')
})

test('serializeMhtml round-trips through parseMhtml for a document with no subresources', () => {
	const document: MhtmlDocument = {
		parts: [
			{
				contentId: undefined,
				location: 'https://example.invalid/',
				mimeType: 'text/html',
				textEncoding: 'utf-8',
				data: new TextEncoder().encode('<!DOCTYPE html><html><body>hello</body></html>'),
			},
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))

	assert.deepEqual(diagnostics, [])
	assert.ok(roundTripped)
	assert.deepEqual(withoutContentIds(roundTripped), document)
})

test('serializeMhtml round-trips subresources, binary data, and resources without a charset', () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03])

	const document: MhtmlDocument = {
		parts: [
			{
				contentId: undefined,
				location: 'https://example.invalid/index.html',
				mimeType: 'text/html',
				textEncoding: 'utf-8',
				data: new TextEncoder().encode('<html><head><link rel="stylesheet" href="style.css"></head><body><img src="logo.png"></body></html>'),
			},
			{ contentId: undefined, location: 'https://example.invalid/style.css', mimeType: 'text/css', textEncoding: 'utf-8', data: new TextEncoder().encode('body { color: red; }') },
			{ contentId: undefined, location: 'https://example.invalid/logo.png', mimeType: 'image/png', textEncoding: undefined, data: png },
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))

	assert.deepEqual(diagnostics, [])
	assert.ok(roundTripped)
	assert.deepEqual(withoutContentIds(roundTripped), document)
})

test('serializeMhtml throws rather than injecting a line break from an untrusted resource URL into MHTML headers', () => {
	// A URL like this cannot come from parseMhtml (headers can't contain a raw
	// CRLF), but it can come from a WebArchive plist's WebResourceURL string,
	// which has no such restriction. serializeMhtml must reject it rather than
	// splicing it into a header line, or a convert from an untrusted WebArchive
	// could inject arbitrary MIME headers/parts into the MHTML output.
	const document: MhtmlDocument = {
		parts: [
			{
				contentId: undefined,
				location: 'https://example.invalid/\r\nContent-Type: text/html\r\nContent-Location: https://evil.invalid/\r\n\r\ninjected',
				mimeType: 'text/html',
				textEncoding: undefined,
				data: new TextEncoder().encode('<html></html>'),
			},
		],
		rootPartIndex: 0,
	}

	assert.throws(() => serializeMhtml(document), /line break/)
})

/** A one-part document with `overrides` applied to that part, for the writer-conformance cases below. */
function documentWithPart(overrides: Partial<MhtmlPart>): MhtmlDocument {
	return {
		parts: [
			{
				contentId: undefined,
				location: 'https://example.invalid/',
				mimeType: 'text/html',
				textEncoding: undefined,
				data: new TextEncoder().encode('<html></html>'),
				...overrides,
			},
		],
		rootPartIndex: 0,
	}
}

// --- Content-ID uniqueness (RFC 2045/2392 world-uniqueness) -----------------

test('serializeMhtml refuses to emit a document in which two parts claim the same Content-ID', () => {
	// parseMhtml is tolerant of this (it reports duplicate-content-id and keeps both
	// parts), but writing it back out would produce a document whose `cid:` references
	// are ambiguous — reader tolerance must not become writer non-conformance.
	const document: MhtmlDocument = {
		parts: [
			{ contentId: 'shared@archivebridge', location: 'https://example.invalid/a', mimeType: 'text/html', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: 'shared@archivebridge', location: 'https://example.invalid/b', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
		],
		rootPartIndex: 0,
	}

	assert.throws(() => serializeMhtml(document), /same Content-ID "shared@archivebridge"/)
})

test('serializeMhtml preserves several distinct existing Content-IDs unchanged', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: 'first@archivebridge', location: 'https://example.invalid/a', mimeType: 'text/html', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: 'second@archivebridge', location: 'https://example.invalid/b', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))
	assert.deepEqual(diagnostics, [])
	assert.deepEqual(
		roundTripped?.parts.map((part) => part.contentId),
		['first@archivebridge', 'second@archivebridge'],
	)
})

test('serializeMhtml generates a distinct Content-ID for every part that has none', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: undefined, location: 'https://example.invalid/a', mimeType: 'text/html', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: undefined, location: 'https://example.invalid/b', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: undefined, location: 'https://example.invalid/c', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))
	assert.deepEqual(diagnostics, [])
	const contentIds = roundTripped?.parts.map((part) => part.contentId) ?? []
	assert.equal(contentIds.length, 3)
	assert.equal(new Set(contentIds).size, 3)
})

test('serializeMhtml mixes preserved and generated Content-IDs without collision', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: 'kept@archivebridge', location: 'https://example.invalid/a', mimeType: 'text/html', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: undefined, location: 'https://example.invalid/b', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
			{ contentId: 'also-kept@archivebridge', location: 'https://example.invalid/c', mimeType: 'text/css', textEncoding: undefined, data: new Uint8Array(0) },
		],
		rootPartIndex: 0,
	}

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))
	assert.deepEqual(diagnostics, [])
	const contentIds = roundTripped?.parts.map((part) => part.contentId) ?? []
	assert.equal(contentIds[0], 'kept@archivebridge')
	assert.equal(contentIds[2], 'also-kept@archivebridge')
	assert.equal(new Set(contentIds).size, 3)
})

test('serializeMhtml points start at the root part’s Content-ID when rootPartIndex is not 0', () => {
	const document: MhtmlDocument = {
		parts: [
			{ contentId: undefined, location: 'https://example.invalid/style.css', mimeType: 'text/css', textEncoding: undefined, data: new TextEncoder().encode('body {}') },
			{
				contentId: 'the-root@archivebridge',
				location: 'https://example.invalid/',
				mimeType: 'text/html',
				textEncoding: undefined,
				data: new TextEncoder().encode('<html></html>'),
			},
		],
		rootPartIndex: 1,
	}

	const text = new TextDecoder().decode(serializeMhtml(document))
	assert.match(text, /start="<the-root@archivebridge>"/)
	assert.match(text, /type="text\/html"/)

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(document))
	assert.deepEqual(diagnostics, [])
	assert.equal(roundTripped?.rootPartIndex, 1)
})

// --- Header value representability / MIME parameter quoting ------------------

test('serializeMhtml rejects a control character in a header value it would write', () => {
	assert.throws(() => serializeMhtml(documentWithPart({ location: 'https://example.invalid/\u0000null' })), /control character/)
})

test('serializeMhtml rejects a non-ASCII header value rather than emitting a non-conforming raw-UTF-8 header', () => {
	// RFC 5322/2045 header field values are US-ASCII; representing anything else
	// conformingly needs RFC 2047/2231, which ArchiveBridge does not implement. A
	// WebArchive's WebResourceURL is not restricted this way, hence the check.
	assert.throws(() => serializeMhtml(documentWithPart({ location: 'https://example.invalid/café' })), /non-ASCII character/)
})

test('parse success does not imply serialize success: a tolerantly-parsed non-ASCII Content-Location is one the writer refuses', () => {
	// The rule above, but reached through a real parse rather than a hand-built model —
	// the tolerant-reader/strict-writer boundary itself (docs/architecture.md, "Parse
	// success does not imply serialize success"). A raw non-ASCII Content-Location is
	// not malformed, so it parses with *no* diagnostic at all; it is simply not
	// representable in a conforming header, so the writer refuses it. Callers must
	// treat that as a reachable outcome of real input, not an internal invariant break.
	const raw = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-Location: https://example.invalid/café/日本.html',
		'',
		'<html></html>',
		'--B--',
		'',
	].join('\r\n')

	const { document, diagnostics } = parseMhtml(new TextEncoder().encode(raw))
	assert.deepEqual(diagnostics, [])
	assert.ok(document)
	assert.equal(document.parts[0]?.location, 'https://example.invalid/café/日本.html')

	assert.throws(() => serializeMhtml(document), /non-ASCII character/)
})

test('serializeMhtml rejects a mimeType that is not a syntactically valid media type', () => {
	assert.throws(() => serializeMhtml(documentWithPart({ mimeType: 'texthtml' })), /not a valid MIME type\/subtype/)
	assert.throws(() => serializeMhtml(documentWithPart({ mimeType: 'text/ht ml' })), /not a valid MIME type\/subtype/)
})

test('serializeMhtml rejects a mimeType crafted to break out of the top-level Content-Type’s type parameter', () => {
	// Were this interpolated into `type="..."` unchecked, the emitted top-level
	// Content-Type would gain an attacker-chosen `boundary`, making the whole
	// envelope's framing something the document's own parts could then forge.
	assert.throws(() => serializeMhtml(documentWithPart({ mimeType: 'text/html"; boundary="evil' })), /not a valid MIME type\/subtype/)
})

test('serializeMhtml rejects an angle bracket inside a Content-ID, which its <...> wrapper cannot represent', () => {
	assert.throws(() => serializeMhtml(documentWithPart({ contentId: 'a<b@example.invalid' })), /angle bracket/)
})

test('serializeMhtml escapes a Content-ID whose RFC 5322 quoted-string local part needs quoted-pairs, and it survives a round trip', () => {
	// `<"a\"b"@example.invalid>` is a valid msg-id: a quoted-string local part
	// containing an escaped quote. Carried in RFC 2387's `start` parameter it needs
	// MIME quoted-pair escaping of both `"` and `\`, and the parser has to undo
	// exactly that to still resolve the root part.
	const contentId = '"a\\"b"@example.invalid'
	const document: MhtmlDocument = {
		parts: [
			{ contentId: undefined, location: 'https://example.invalid/style.css', mimeType: 'text/css', textEncoding: undefined, data: new TextEncoder().encode('body {}') },
			{ contentId, location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: undefined, data: new TextEncoder().encode('<html></html>') },
		],
		rootPartIndex: 1,
	}

	const bytes = serializeMhtml(document)
	assert.match(new TextDecoder().decode(bytes), /start="<\\"a\\\\\\"b\\"@example.invalid>"/)

	const { document: roundTripped, diagnostics } = parseMhtml(bytes)
	assert.deepEqual(diagnostics, [])
	assert.equal(roundTripped?.rootPartIndex, 1, 'start must still resolve the root part through the escaping')
	assert.equal(roundTripped?.parts[1]?.contentId, contentId)
})

test('serializeMhtml escapes a charset parameter value containing a quote and a backslash instead of breaking the header', () => {
	// Not an endorsement of such a charset label — the point is that the writer's
	// parameter quoting and the reader's quoted-pair unescaping agree, so no value
	// can terminate the parameter early and forge further parameters.
	const textEncoding = 'x-weird"\\label'

	const { document: roundTripped, diagnostics } = parseMhtml(serializeMhtml(documentWithPart({ textEncoding })))
	assert.deepEqual(diagnostics, [])
	assert.equal(roundTripped?.parts[0]?.textEncoding, textEncoding)
})
