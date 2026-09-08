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
 * Scope for this initial implementation: `archive.frames` must be empty.
 * Nested-frame serialization (`multipart/mixed`-wrapped sub-documents) is not
 * implemented yet, matching parseMhtml (`src/mhtml/parse.ts`), which likewise
 * never populates `frames` for MHTML today.
 *
 * Base64 encoding is delegated to `@exodus/bytes/base64.js` rather than the
 * platform `Uint8Array.prototype.toBase64` — see `mhtml/parse.ts` and
 * CONTRIBUTING.md's dependency policy for why.
 */

import { toBase64 } from '@exodus/bytes/base64.js'
import type { Archive, Resource } from '../model/archive.ts'

const CRLF = '\r\n'
const BASE64_LINE_LENGTH = 76

/**
 * `url`, `mimeType`, and `textEncoding` are written verbatim into MIME
 * header lines below. An `Archive` can originate from an untrusted format
 * (e.g. a WebArchive plist, whose string values are not restricted to a
 * single line), so a CR or LF in any of them must be rejected here rather
 * than passed through — otherwise it would inject arbitrary header lines or
 * additional MIME parts into the serialized output. See
 * docs/architecture.md#security-assumptions.
 */
function assertNoHeaderLineBreak(resource: Resource): void {
	const fields: [name: string, value: string | undefined][] = [
		['url', resource.url],
		['mimeType', resource.mimeType],
		['textEncoding', resource.textEncoding],
	]
	for (const [name, value] of fields) {
		if (value !== undefined && /[\r\n]/.test(value)) {
			throw new Error(`serializeMhtml cannot represent a resource whose ${name} contains a line break`)
		}
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

function serializePart(resource: Resource, boundary: string, contentId: string | undefined): string {
	const contentType = resource.textEncoding === undefined ? resource.mimeType : `${resource.mimeType}; charset="${resource.textEncoding}"`

	const headers = [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64', `Content-Location: ${resource.url}`]
	if (contentId !== undefined) {
		headers.push(`Content-ID: <${contentId}>`)
	}

	return [`--${boundary}`, ...headers, '', wrapBase64(toBase64(resource.data))].join(CRLF)
}

/**
 * Serializes an {@link Archive} into standards-conforming MHTML bytes. The
 * root part carries a generated `Content-ID`, referenced by the top-level
 * `Content-Type`'s `start` parameter per RFC 2387, so the main resource is
 * unambiguous on parse independent of part order.
 *
 * Throws if `archive.frames` is non-empty; see the module doc comment.
 */
export function serializeMhtml(archive: Archive): Uint8Array {
	if (archive.frames.length > 0) {
		throw new Error('serializeMhtml does not support archives with frames yet')
	}

	assertNoHeaderLineBreak(archive.mainResource)
	for (const resource of archive.resources.values()) {
		assertNoHeaderLineBreak(resource)
	}

	const boundary = `----ArchiveBridge-${crypto.randomUUID()}`
	const rootContentId = `${crypto.randomUUID()}@archivebridge`

	const parts = [serializePart(archive.mainResource, boundary, rootContentId)]
	for (const resource of archive.resources.values()) {
		parts.push(serializePart(resource, boundary, undefined))
	}

	const header = ['MIME-Version: 1.0', `Content-Type: multipart/related; type="${archive.mainResource.mimeType}"; boundary="${boundary}"; start="<${rootContentId}>"`].join(CRLF)

	const document = [header, '', ...parts, `--${boundary}--`, ''].join(CRLF)

	return new TextEncoder().encode(document)
}
