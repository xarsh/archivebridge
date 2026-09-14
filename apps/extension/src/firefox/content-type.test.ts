/**
 * The archive boundary's media-type rule, asserted against the shapes that
 * actually reach it.
 *
 * Every case here is one a page or a server can choose freely, and each of
 * the first three used to produce a `mimeType` that made `serializeMhtml`
 * throw — which fails the *whole save*, not the one resource. That is what
 * makes this a security-adjacent boundary rather than a formatting detail:
 * one attribute in a hostile page could deny the user the archive.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidMediaType, serializeMhtml } from '@xarsh/archivebridge'
import { readContentType } from './content-type.ts'

const FALLBACK = 'application/octet-stream'

test('a media type with more than one slash is refused, not truncated to its first two segments', () => {
	// The old reader destructured `mediaType.split('/')` into two names and
	// kept the *whole* string, so `text/css/garbage` passed as a media type
	// and reached the serializer.
	assert.deepEqual(readContentType('text/css/garbage', 'text/css'), { mimeType: 'text/css', textEncoding: undefined })
	assert.deepEqual(readContentType('text/css/garbage; charset=utf-8', 'text/css'), { mimeType: 'text/css', textEncoding: 'utf-8' })
})

test('a blob’s own Content-Type splits into a media type and a charset', () => {
	// Exactly what `new Blob([…], { type: 'text/plain;charset=utf-8' })`
	// produces, which is ordinary page behaviour rather than an attack.
	assert.deepEqual(readContentType('text/plain;charset=utf-8', FALLBACK), { mimeType: 'text/plain', textEncoding: 'utf-8' })
	// A blob created with no type at all reports an empty header, not a
	// missing one, so `?? fallback` never fires for it.
	assert.deepEqual(readContentType('', FALLBACK), { mimeType: FALLBACK, textEncoding: undefined })
	assert.deepEqual(readContentType(null, FALLBACK), { mimeType: FALLBACK, textEncoding: undefined })
})

test('parameters, quoting and spacing are read the way a MIME header defines them', () => {
	assert.deepEqual(readContentType('text/html; charset="utf-8"', FALLBACK), { mimeType: 'text/html', textEncoding: 'utf-8' })
	assert.deepEqual(readContentType('TEXT/HTML; CHARSET=Shift_JIS', FALLBACK), { mimeType: 'text/html', textEncoding: 'Shift_JIS' })
	assert.deepEqual(readContentType('text/css ; boundary=x ; charset=iso-8859-1', FALLBACK), { mimeType: 'text/css', textEncoding: 'iso-8859-1' })
	// A `;` inside a quoted parameter does not start a new parameter, so the
	// charset after it is still found.
	assert.deepEqual(readContentType('text/css; note="a;b"; charset=utf-8', FALLBACK), { mimeType: 'text/css', textEncoding: 'utf-8' })
})

test('a malformed media type or charset falls back instead of being carried into the archive', () => {
	for (const header of ['nonsense', '/', 'text/', '/css', 'text /css', 'text/cs s', 'text/css"', '()/css', 'imagé/png']) {
		assert.equal(readContentType(header, FALLBACK).mimeType, FALLBACK, `${header} must not be accepted as a media type`)
	}
	// A charset that is not an RFC 2045 token says nothing trustworthy about
	// the bytes, so it is dropped — the media type still stands.
	for (const header of ['text/css; charset=', 'text/css; charset="utf 8"', 'text/css; charset=日本語']) {
		assert.deepEqual(readContentType(header, FALLBACK), { mimeType: 'text/css', textEncoding: undefined }, `${header} must not contribute a charset`)
	}
})

test('whatever it returns can actually be written, which is the point of it', () => {
	const headers = [
		'text/css/garbage',
		'text/plain;charset=utf-8',
		'',
		'nonsense',
		'text/css; charset="a;b"',
		'image/png; charset=utf-8',
		'<script>/x',
		'text/plain; charset=utf-8; charset=latin1',
	]
	for (const header of headers) {
		const { mimeType, textEncoding } = readContentType(header, FALLBACK)
		assert.equal(isValidMediaType(mimeType), true, `${header} produced an unwritable media type`)
		assert.doesNotThrow(
			() => serializeMhtml({ parts: [{ contentId: undefined, location: 'https://example.invalid/r', mimeType, textEncoding, data: new Uint8Array([1]) }], rootPartIndex: 0 }),
			`${header} produced a part the serializer refuses`,
		)
	}
})
