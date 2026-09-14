/**
 * The one place a `Content-Type` header — from a network response or from a
 * `blob:` one — becomes the two fields an `MhtmlPart` actually has.
 *
 * **Why this is its own module rather than a helper inside `resources.ts`.**
 * Two producers reach the archive boundary with a raw header value: the
 * background's privileged fetch (`resources.ts`) and a `blob:` read that
 * only the page principal could perform (`page-capture.ts`, whose result is
 * interpreted here by `mhtml-document.ts` — the injected function returns
 * the header uninterpreted, because it cannot import this module and must
 * not invent archive structure of its own). One parser for both is what
 * keeps a rule fixed in one of them from staying broken in the other.
 *
 * **Why the media-type check is the library's and not a regex here.**
 * `serializeMhtml` *throws* on a part whose `mimeType` is not an RFC 2045
 * `token "/" token`, and it is handed values a page or a server chose:
 * `text/css/garbage` from a hostile server, or the entirely ordinary
 * `text/plain;charset=utf-8` that `new Blob([…], { type })` produces and
 * that a blob response repeats verbatim. Both were measured to take the
 * whole save down before this module existed. `isValidMediaType` is the
 * serializer's own rule, so what this returns is writable by construction
 * rather than by a regex that agrees with it today.
 *
 * What stays *here* rather than in the library is policy: the fallback when
 * a response says nothing usable, and the rule that a recorded charset must
 * be an RFC 2045 `token`. Neither is MHTML's business — they are the
 * capture's.
 */

import { isValidMediaType, parseContentType } from '@xarsh/archivebridge'

/** RFC 2045 `token`, which is what a `charset` parameter has to be to be worth recording. A value that is not one is dropped rather than carried into the archive as a claim about the bytes. */
const MIME_TOKEN = /^[\w!#$%&'*+.^`|~-]+$/

/** A `Content-Type` split into the two fields `MhtmlPart` has. Both are writable by `serializeMhtml` by construction. */
export interface ResourceContentType {
	readonly mimeType: string
	readonly textEncoding: string | undefined
}

/**
 * Splits a `Content-Type` header value, falling back to `fallback` when the
 * header is absent, empty, or names a media type the archive could not
 * carry.
 *
 * `fallback` is the caller's choice of what an unusable header means — the
 * reference site it was found at, for a network resource — and is itself
 * required to be a valid media type, since it is what gets written when the
 * header is not.
 */
export function readContentType(header: string | null | undefined, fallback: string): ResourceContentType {
	const parsed = parseContentType(header ?? '')
	const mimeType = isValidMediaType(parsed.type) ? parsed.type : fallback
	const charset = parsed.params.get('charset')
	return { mimeType, textEncoding: charset !== undefined && MIME_TOKEN.test(charset) ? charset : undefined }
}
