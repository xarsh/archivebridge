import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafelyReencodable, textCodecFor } from './text-codec.ts'

test('textCodecFor(undefined) and textCodecFor("utf-8") both decode/encode as UTF-8', () => {
	const text = 'plain ascii'
	for (const label of [undefined, 'utf-8', 'UTF-8']) {
		const codec = textCodecFor(label)
		const encoded = codec.encode(text)
		assert.ok(encoded)
		assert.deepEqual(encoded, new TextEncoder().encode(text))
		assert.equal(codec.decode(encoded), text)
	}
})

test('textCodecFor a recognized legacy encoding (iso-8859-1) decodes and encodes non-ASCII bytes losslessly', () => {
	const codec = textCodecFor('iso-8859-1')
	const text = 'café'
	const encoded = codec.encode(text)
	assert.ok(encoded)
	assert.deepEqual(
		encoded,
		Uint8Array.from(text, (ch) => ch.codePointAt(0) ?? 0),
	)
	assert.equal(codec.decode(encoded), text)
})

test('textCodecFor a recognized legacy encoding (shift_jis) round-trips non-Latin text', () => {
	const codec = textCodecFor('shift_jis')
	const text = 'こんにちは'
	const encoded = codec.encode(text)
	assert.ok(encoded)
	assert.equal(codec.decode(encoded), text)
	// Sanity check this actually produced a different (non-UTF-8) byte encoding, not a silent UTF-8 fallback.
	assert.notDeepEqual(encoded, new TextEncoder().encode(text))
})

test('textCodecFor is case-insensitive on the encoding label itself', () => {
	const text = 'café'
	const lower = textCodecFor('iso-8859-1').encode(text)
	const upper = textCodecFor('ISO-8859-1').encode(text)
	assert.deepEqual(lower, upper)
})

test('textCodecFor.encode returns undefined (never throws) when the encoding cannot faithfully represent the text', () => {
	// Shift_JIS/CP932 cannot represent an emoji; iconv-lite would silently substitute '?' for it
	// rather than throwing, so this must be caught by the codec's own round-trip verification, not
	// surfaced as a thrown exception.
	const codec = textCodecFor('shift_jis')
	assert.doesNotThrow(() => codec.encode('party 🎉 party'))
	assert.equal(codec.encode('party 🎉 party'), undefined)
})

test('textCodecFor.encode returns undefined (never throws, never silently falls back to UTF-8) for an unrecognized encoding label', () => {
	const codec = textCodecFor('x-totally-fake-charset-not-real')
	assert.doesNotThrow(() => codec.encode('anything'))
	assert.equal(codec.encode('anything'), undefined)
})

test('textCodecFor.decode still degrades leniently (never throws) for an unrecognized encoding label', () => {
	const codec = textCodecFor('x-totally-fake-charset-not-real')
	const bytes = new TextEncoder().encode('ascii text')
	assert.doesNotThrow(() => codec.decode(bytes))
	assert.equal(codec.decode(bytes), 'ascii text')
})

test('textCodecFor("iso-8859-1") canonicalizes to windows-1252 (WHATWG Encoding Standard semantics), not literal ISO-8859-1, for byte 0x80', () => {
	const codec = textCodecFor('iso-8859-1')
	const decoded = codec.decode(new Uint8Array([0x80]))
	// windows-1252 maps 0x80 to U+20AC (€); true ISO-8859-1 maps it to the C1 control U+0080.
	assert.equal(decoded, '€')
	assert.notEqual(decoded, '')
})

test('textCodecFor("iso-8859-1") round-trips € (U+20AC) via windows-1252 byte 0x80, matching TextDecoder/browser behavior', () => {
	const codec = textCodecFor('iso-8859-1')
	const encoded = codec.encode('€')
	assert.ok(encoded)
	assert.deepEqual(encoded, new Uint8Array([0x80]))
	assert.equal(codec.decode(encoded), '€')
})

test('textCodecFor canonicalizes iso-8859-1 aliases/case variations (latin1, LATIN1, ISO-8859-1, cp819) to the same windows-1252 behavior for byte 0x80', () => {
	for (const label of ['iso-8859-1', 'ISO-8859-1', 'latin1', 'LATIN1', 'cp819', 'l1']) {
		const codec = textCodecFor(label)
		assert.equal(codec.decode(new Uint8Array([0x80])), '€', `label ${label}`)
	}
})

test('textCodecFor still round-trips a byte 0x80-0x9F-free legacy string the same way regardless of the iso-8859-1/windows-1252 distinction (café unaffected)', () => {
	const codec = textCodecFor('iso-8859-1')
	const text = 'café'
	const encoded = codec.encode(text)
	assert.ok(encoded)
	assert.deepEqual(
		encoded,
		Uint8Array.from(text, (ch) => ch.codePointAt(0) ?? 0),
	)
	assert.equal(codec.decode(encoded), text)
})

test('isSafelyReencodable is true for plain ASCII UTF-8 bytes (no BOM, no malformed sequence)', () => {
	const codec = textCodecFor('utf-8')
	const bytes = new TextEncoder().encode('plain ascii, no surprises')
	assert.equal(isSafelyReencodable(codec, bytes), true)
})

test('isSafelyReencodable is false for UTF-8 bytes with a leading BOM: TextDecoder strips it on decode, and nothing re-adds it on encode', () => {
	const codec = textCodecFor('utf-8')
	const bom = new Uint8Array([0xef, 0xbb, 0xbf])
	const bytes = new Uint8Array([...bom, ...new TextEncoder().encode('hi')])
	assert.equal(codec.decode(bytes), 'hi') // BOM silently dropped from the decoded string
	assert.equal(isSafelyReencodable(codec, bytes), false)
})

test('isSafelyReencodable is false for a malformed (non-UTF-8) byte sequence that decodes leniently to a replacement character', () => {
	const codec = textCodecFor('utf-8')
	// 0xFF is never valid anywhere in a UTF-8 byte sequence.
	const bytes = new Uint8Array([0x68, 0xff, 0x69])
	assert.equal(isSafelyReencodable(codec, bytes), false)
})

test('isSafelyReencodable is true for a legacy (non-UTF-8) document with no BOM/malformed-byte concerns', () => {
	const codec = textCodecFor('iso-8859-1')
	const bytes = Uint8Array.from('café', (ch) => ch.codePointAt(0) ?? 0)
	assert.equal(isSafelyReencodable(codec, bytes), true)
})

test('isSafelyReencodable is false when the codec cannot encode at all (decode-only codec for an unrecognized label)', () => {
	const codec = textCodecFor('x-totally-fake-charset-not-real')
	const bytes = new TextEncoder().encode('anything')
	assert.equal(isSafelyReencodable(codec, bytes), false)
})

test('textCodecFor still supports an iconv-lite-only alias (ucs2) that the WHATWG Encoding Standard/TextDecoder does not recognize at all, by falling back to the literal label rather than narrowing coverage to canonicalizable labels', () => {
	assert.throws(() => new TextDecoder('ucs2'))
	const codec = textCodecFor('ucs2')
	const text = 'hi'
	const encoded = codec.encode(text)
	assert.ok(encoded, 'ucs2 must still be encodable via iconv-lite, not degrade to a decode-only best-effort codec')
	assert.deepEqual(encoded, new Uint8Array([0x68, 0x00, 0x69, 0x00])) // UTF-16LE
	assert.equal(codec.decode(encoded), text)
})
