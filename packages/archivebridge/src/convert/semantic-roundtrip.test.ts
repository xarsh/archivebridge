/**
 * Deep *semantic* round-trip coverage for the real multi-frame fixtures,
 * complementing the spot-checks in `roundtrip.test.ts` and
 * `convert/to-mhtml.test.ts`/`convert/to-web-archive.test.ts` (which mostly
 * assert individual fields: a URL here, a frameName there). This file
 * exists because a prior status report claimed "full byte-level round trip
 * through the real multi-frame fixtures passes" without a test that
 * actually walked every field recursively — that claim did not hold up
 * (see docs/architecture.md, "Semantic losslessness": round-tripping
 * targets *meaning*, not byte-for-byte identity, so a "full byte-level"
 * claim was never accurate to begin with).
 *
 * "Semantic" here specifically means: every resource's URL, MIME type,
 * text encoding, `WebResourceFrameName`, `WebResourceResponse`, `extra`,
 * and the complete recursive frame tree shape must match exactly (real
 * `deepEqual`, no normalization) — except a `text/html` resource's own
 * frame-`src` attribute value, which is allowed to differ only in
 * surface form (quoting style, a `cid:` vs. a resolved URL) because a
 * round trip through `cid:` linkage is exactly what a frame reference is
 * expected to survive as, not literally. `MhtmlDocument`'s own generated
 * Content-IDs are a similar intentionally-non-semantic difference
 * (docs/architecture.md, "Content-ID: preservation, generation, and
 * identity") and are never compared by literal value here.
 *
 * **What this test does and does not prove for HTML resources.** For an
 * HTML resource, comparison is on the *decoded string* (per that
 * resource's own `textEncoding`, via `text-codec.ts`) with the one
 * frame-`src` attribute normalized out — not on the resource's raw bytes.
 * That means a passing assertion here does **not** prove byte-for-byte
 * identity of the underlying resource bytes: a BOM present on one side and
 * not the other, two different byte sequences that happen to decode to
 * the same Unicode string, or any other charset-level re-encoding detail
 * could all pass this comparison while differing at the byte level. This
 * file deliberately does not claim otherwise (a prior status report's
 * inaccurate "byte-level" claim is exactly why this file exists — see
 * below). Exact original-byte-preservation behavior (BOM handling,
 * malformed/tolerantly-decoded byte sequences, and refusing a rewrite
 * rather than silently normalizing bytes it doesn't touch) is covered by
 * focused tests near `mhtml/text-codec.ts` (`isSafelyReencodable`) and in
 * `convert/to-mhtml.test.ts`/`convert/to-web-archive.test.ts`'s "cannot be
 * safely re-encoded"/BOM/malformed-byte cases — not by this file.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { rewriteFrameSrcAttributes } from '../mhtml/html-rewrite.ts'
import { parseMhtml } from '../mhtml/parse.ts'
import { textCodecFor } from '../mhtml/text-codec.ts'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { serializeWebArchive } from '../webarchive/serialize.ts'
import { convertWebArchiveToMhtml } from './to-mhtml.ts'
import { convertMhtmlToWebArchive } from './to-web-archive.ts'

function loadFixture(dir: string, name: string): Uint8Array {
	return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${dir}/${name}`, import.meta.url)))
}

/** Blanks out every frame `src` attribute value so the one field a frame round trip is allowed to rewrite in surface form (`cid:...` vs. a resolved URL, or a quoting-style change) never masks a real difference anywhere else in the HTML. */
function normalizeFrameSrcForCompare(html: string): string {
	return rewriteFrameSrcAttributes(html, () => '#normalized-frame-src#')
}

function decodeResourceText(resource: WebArchiveResource): string {
	return textCodecFor(resource.textEncoding).decode(resource.data)
}

function assertSemanticResourceEqual(actual: WebArchiveResource, expected: WebArchiveResource, path: string): void {
	assert.equal(actual.url, expected.url, `${path}.url`)
	assert.equal(actual.mimeType.toLowerCase(), expected.mimeType.toLowerCase(), `${path}.mimeType`)
	assert.equal(actual.textEncoding, expected.textEncoding, `${path}.textEncoding`)
	assert.equal(actual.frameName, expected.frameName, `${path}.frameName`)
	assert.deepEqual(actual.response, expected.response, `${path}.response`)
	assert.deepEqual(actual.extra, expected.extra, `${path}.extra`)
	if (actual.mimeType.toLowerCase() === 'text/html') {
		assert.equal(
			normalizeFrameSrcForCompare(decodeResourceText(actual)),
			normalizeFrameSrcForCompare(decodeResourceText(expected)),
			`${path}.data (HTML, frame-src attribute normalized)`,
		)
	} else {
		assert.deepEqual(actual.data, expected.data, `${path}.data`)
	}
}

function assertSemanticDocumentEqual(actual: WebArchiveDocument, expected: WebArchiveDocument, path = 'document'): void {
	assertSemanticResourceEqual(actual.mainResource, expected.mainResource, `${path}.mainResource`)
	assert.deepEqual(actual.extra, expected.extra, `${path}.extra`)
	assert.equal(actual.subresources.length, expected.subresources.length, `${path}.subresources.length`)
	actual.subresources.forEach((sub, i) => {
		const expectedSub = expected.subresources[i]
		assert.ok(expectedSub, `${path}.subresources[${i}] missing in expected`)
		assertSemanticResourceEqual(sub, expectedSub, `${path}.subresources[${i}]`)
	})
	assert.equal(actual.subframeArchives.length, expected.subframeArchives.length, `${path}.subframeArchives.length`)
	actual.subframeArchives.forEach((child, i) => {
		const expectedChild = expected.subframeArchives[i]
		assert.ok(expectedChild, `${path}.subframeArchives[${i}] missing in expected`)
		assertSemanticDocumentEqual(child, expectedChild, `${path}.subframeArchives[${i}]`)
	})
}

for (const fixture of ['frames-nested.safari.webarchive', 'frames-cross-origin.safari.webarchive']) {
	test(`WebArchiveDocument -> MHTML -> WebArchiveDocument is semantically lossless, field-by-field and recursively, for fixtures/webarchive/${fixture}`, () => {
		const { document: original } = parseWebArchive(loadFixture('webarchive', fixture))
		assert.ok(original)

		const { document: mhtml, diagnostics: toMhtmlDiagnostics } = convertWebArchiveToMhtml(original)
		assert.deepEqual(toMhtmlDiagnostics, [])

		const { document: roundTripped, diagnostics: toWebArchiveDiagnostics } = convertMhtmlToWebArchive(mhtml)
		assert.deepEqual(toWebArchiveDiagnostics, [])

		assertSemanticDocumentEqual(roundTripped, original)
	})
}

test('MhtmlDocument -> WebArchive -> MhtmlDocument is semantically lossless for fixtures/mhtml/frames-nested.chrome.mhtml, compared via each side\'s own canonical WebArchive projection (Content-IDs are regenerated on this leg and are never semantic — docs/architecture.md, "Content-ID: preservation, generation, and identity")', () => {
	const { document: original } = parseMhtml(loadFixture('mhtml', 'frames-nested.chrome.mhtml'))
	assert.ok(original)

	const { document: originalAsWebArchive, diagnostics: originalDiagnostics } = convertMhtmlToWebArchive(original)
	assert.deepEqual(originalDiagnostics, [])

	// The actual round trip under test: MHTML -> WebArchive bytes -> MHTML.
	const { document: webDoc } = convertMhtmlToWebArchive(original)
	const reparsed = parseWebArchive(serializeWebArchive(webDoc))
	assert.ok(reparsed.document)
	assert.deepEqual(reparsed.diagnostics, [])
	const { document: roundTrippedMhtml, diagnostics: fromWebArchiveDiagnostics } = convertWebArchiveToMhtml(reparsed.document)
	assert.deepEqual(fromWebArchiveDiagnostics, [])

	const { document: roundTrippedAsWebArchive, diagnostics: reprojectDiagnostics } = convertMhtmlToWebArchive(roundTrippedMhtml)
	assert.deepEqual(reprojectDiagnostics, [])

	assertSemanticDocumentEqual(roundTrippedAsWebArchive, originalAsWebArchive)
})
