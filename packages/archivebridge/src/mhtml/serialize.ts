/**
 * Minimal, standards-conforming MHTML serializer (RFC 2387 `multipart/related`,
 * RFC 2045/2046 MIME). Every resource is emitted with a `base64`
 * Content-Transfer-Encoding: it round-trips any byte sequence unambiguously,
 * with no quoted-printable escaping or raw-8bit line-ending edge cases to get
 * right. Output favors spec conformance over reproducing any particular
 * browser's MHTML quirks — see docs/architecture.md.
 *
 * The root part is identified via RFC 2387's `start` parameter (on the
 * top-level `Content-Type`) plus a matching `Content-ID` header on that
 * part, not `Snapshot-Content-Location` — that header is a Blink/Chromium
 * convention, not part of RFC 2387. `parseMhtml` still reads
 * `Snapshot-Content-Location` as a fallback for reader compatibility with
 * real-world Chrome-generated MHTML, but this serializer never writes it.
 *
 * Every emitted part carries a `Content-ID`: an existing one is preserved
 * unchanged (regenerating it would silently break any `cid:` reference to
 * it — see docs/architecture.md, "Content-ID: preservation, generation, and
 * identity"); a part with none gets a generated one. Not just the root part
 * — this is what lets any part be addressed precisely, e.g. by the metadata
 * sidecar (`mhtml/sidecar.ts`).
 *
 * **Reader tolerance is not writer licence.** `parseMhtml` deliberately
 * accepts input this serializer refuses to emit (duplicate Content-IDs, for
 * instance). An `MhtmlDocument` that cannot be written as a conforming MHTML
 * document makes `serializeMhtml` throw, rather than either emitting a
 * knowingly non-conforming document or silently "repairing" the model's
 * semantics — see docs/architecture.md's diagnostics/partial-failure policy,
 * which is about *parsing*, not about writing.
 */

import { toBase64 } from '@exodus/bytes/base64.js'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { describeHeaderValueProblem, findHeaderValueProblem, isValidMediaType, quoteMimeParameter } from './mime-header.ts'

const CRLF = '\r\n'
const BASE64_LINE_LENGTH = 76

/**
 * A UUID collision is fantastically unlikely, but "retry on collision" is
 * only correct if it terminates: a bounded number of attempts keeps
 * generation from becoming an unbounded loop on pathological input (see
 * docs/architecture.md#security-assumptions), and exhausting them is an
 * explicit failure rather than an emitted duplicate.
 */
const MAX_CONTENT_ID_ATTEMPTS = 8

function generateContentId(used: ReadonlySet<string>): string {
	for (let attempt = 0; attempt < MAX_CONTENT_ID_ATTEMPTS; attempt++) {
		const candidate = `part-${crypto.randomUUID()}@archivebridge`
		if (!used.has(candidate)) {
			return candidate
		}
	}
	throw new Error(`serializeMhtml could not generate a Content-ID distinct from every existing one after ${MAX_CONTENT_ID_ATTEMPTS} attempts`)
}

/** One part paired with the `Content-ID` it will actually be emitted with (its own, or a generated one). */
interface AssignedPart {
	readonly part: MhtmlPart
	readonly contentId: string
}

/**
 * Pairs every part with the `Content-ID` it will be emitted with.
 *
 * Existing IDs are preserved as-is, generated ones are guaranteed distinct
 * from every existing *and* every previously generated ID, and two parts
 * claiming the same existing ID is rejected outright: RFC 2045/2392 require a
 * Content-ID to identify exactly one MIME entity, `cid:` frame linkage
 * depends on that, and there is no way to emit an ambiguous document
 * conformingly. Regenerating one side of the duplicate instead would break
 * whichever existing `cid:` reference happened to mean the part that lost —
 * silently, in HTML this serializer does not rewrite.
 */
function assignContentIds(parts: readonly MhtmlPart[]): AssignedPart[] {
	const used = new Set<string>()
	for (const part of parts) {
		if (part.contentId === undefined) {
			continue
		}
		if (used.has(part.contentId)) {
			throw new Error(`serializeMhtml cannot serialize a document in which two parts claim the same Content-ID "${part.contentId}"`)
		}
		used.add(part.contentId)
	}

	return parts.map((part) => {
		if (part.contentId !== undefined) {
			return { part, contentId: part.contentId }
		}
		const generated = generateContentId(used)
		used.add(generated)
		return { part, contentId: generated }
	})
}

/**
 * `location`, `mimeType`, `textEncoding`, and `contentId` are written into
 * MIME header lines below, and an `MhtmlDocument` can originate from an
 * untrusted format (e.g. a WebArchive plist, whose string values are
 * restricted to nothing at all). Rejecting what cannot be written serves two
 * distinct purposes:
 *
 * - **Security.** A CR or LF would inject arbitrary header lines or whole
 *   MIME parts into the output (docs/architecture.md#security-assumptions).
 * - **Conformance.** Other control characters and non-ASCII cannot appear in
 *   an RFC 5322/2045 header field value at all; carrying them would need RFC
 *   2047/2231 encoding, which ArchiveBridge deliberately does not implement
 *   (see `mime-header.ts`). Emitting them raw would produce a document this
 *   serializer claims to be conforming and isn't.
 *
 * Everything that *can* be written is written, including values needing
 * quoted-pair escaping in a parameter (see {@link quoteMimeParameter}) — the
 * point is a boundary on representability, not a narrow allowlist of the
 * shapes ArchiveBridge itself happens to generate.
 */
function assertWritableHeaderValues(part: MhtmlPart, contentId: string): void {
	const fields: [name: string, value: string | undefined][] = [
		['location', part.location],
		['mimeType', part.mimeType],
		['textEncoding', part.textEncoding],
		['contentId', contentId],
	]
	for (const [name, value] of fields) {
		if (value === undefined) {
			continue
		}
		const problem = findHeaderValueProblem(value)
		if (problem !== undefined) {
			throw new Error(`serializeMhtml cannot represent a part whose ${name} contains a ${describeHeaderValueProblem(problem)}`)
		}
	}

	// The media type is written unquoted as the `Content-Type` field's own value and
	// quoted as the top-level `type` parameter; requiring a real `token "/" token`
	// (RFC 2045 §5.1) is what makes both spellings syntactically valid. `parseMhtml`
	// never produces an invalid one — it recovers to `text/plain` per RFC 2045 §5.2 —
	// so this only rejects a hand-constructed or foreign-format-derived model.
	if (!isValidMediaType(part.mimeType)) {
		throw new Error(`serializeMhtml cannot represent a part whose mimeType is not a valid MIME type/subtype: ${JSON.stringify(part.mimeType)}`)
	}

	// ArchiveBridge stores a Content-ID normalized, without the `<...>` wrapper that
	// is RFC 2045 header syntax, and re-adds the wrapper when writing the `Content-ID`
	// header and the `start` parameter. An angle bracket *inside* the value would make
	// that wrapping ambiguous — `parseMhtml`'s `normalizeCid` strips only the outer
	// pair — so it is rejected rather than emitted. Deliberately not validated here:
	// the full RFC 5322 `msg-id`/`addr-spec` grammar. Implementing it properly is
	// disproportionate, and an incomplete "looks like foo@bar" approximation would
	// reject valid preserved IDs (a quoted-string local part, for instance) for no
	// safety gain; representability is the boundary this function draws.
	if (/[<>]/.test(contentId)) {
		throw new Error(`serializeMhtml cannot represent a part whose contentId contains an angle bracket: ${JSON.stringify(contentId)}`)
	}
}

/** RFC 2045 requires base64 body lines no longer than 76 characters. */
function wrapBase64(base64: string): string {
	const lines: string[] = []
	for (let i = 0; i < base64.length; i += BASE64_LINE_LENGTH) {
		lines.push(base64.slice(i, i + BASE64_LINE_LENGTH))
	}
	return lines.join(CRLF)
}

function serializePart(part: MhtmlPart, boundary: string, contentId: string): string {
	assertWritableHeaderValues(part, contentId)

	const contentType = part.textEncoding === undefined ? part.mimeType : `${part.mimeType}; charset=${quoteMimeParameter(part.textEncoding)}`

	const headers = [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64']
	if (part.location !== undefined) {
		headers.push(`Content-Location: ${part.location}`)
	}
	headers.push(`Content-ID: <${contentId}>`)

	return [`--${boundary}`, ...headers, '', wrapBase64(toBase64(part.data))].join(CRLF)
}

/**
 * Serializes an {@link MhtmlDocument} into standards-conforming MHTML bytes.
 * The root part's `Content-ID` is referenced by the top-level
 * `Content-Type`'s `start` parameter per RFC 2387, so the main resource is
 * unambiguous on parse independent of part order.
 *
 * Throws, rather than emitting a non-conforming document, for a model that
 * cannot be written: duplicate Content-IDs, or a header value that cannot
 * appear in a MIME header field (see {@link assertWritableHeaderValues}).
 */
export function serializeMhtml(document: MhtmlDocument): Uint8Array {
	const boundary = `----ArchiveBridge-${crypto.randomUUID()}`

	let rootContentId: string | undefined
	let rootMimeType: string | undefined
	const serializedParts: string[] = []

	assignContentIds(document.parts).forEach(({ part, contentId }, index) => {
		if (index === document.rootPartIndex) {
			rootContentId = contentId
			rootMimeType = part.mimeType
		}
		serializedParts.push(serializePart(part, boundary, contentId))
	})

	// Unreachable for a document that satisfies MhtmlDocument's invariants (`model/mhtml.ts`);
	// guarded here as defense in depth against a hand-constructed invalid document.
	if (rootContentId === undefined || rootMimeType === undefined) {
		throw new Error('serializeMhtml: document.rootPartIndex does not index a part in document.parts')
	}

	const header = [
		'MIME-Version: 1.0',
		`Content-Type: multipart/related; type=${quoteMimeParameter(rootMimeType)}; boundary=${quoteMimeParameter(boundary)}; start=${quoteMimeParameter(`<${rootContentId}>`)}`,
	].join(CRLF)

	const body = [header, '', ...serializedParts, `--${boundary}--`, ''].join(CRLF)

	return new TextEncoder().encode(body)
}
