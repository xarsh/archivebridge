/**
 * Public API of @xarsh/archivebridge.
 *
 * This module intentionally only exports what is actually implemented.
 * See docs/architecture.md for design rationale.
 */

export { convertWebArchiveToMhtml } from './convert/to-mhtml.ts'
export { convertMhtmlToWebArchive } from './convert/to-web-archive.ts'
export { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from './format/detect.ts'
/**
 * Exported for archive *producers*. An ArchiveBridge-authored capture
 * (Firefox today, Safari later) assembles an `MhtmlDocument` whose
 * generated content — a `<canvas>`'s pixels, for one — has no network URL
 * to be a `Content-Location`, so it is addressed by `Content-ID` and
 * referenced from the archived markup as a `cid:` URI. Writing that URI is
 * RFC 2392 spelling, including the percent-encoding a Content-ID may need
 * to be a valid URI, and it belongs to the one module that already owns
 * both directions of it — not to each capture adapter guessing at it. The
 * inverse, `decodeCidUri`, stays internal: nothing outside the library
 * reads a `cid:` reference back.
 */
export { encodeCidUri } from './mhtml/frames.ts'
/**
 * Exported for archive *producers*, and for the one thing a capture cannot
 * do for itself. An ArchiveBridge-authored capture that archives a page's
 * frames as parts of its own archive has to point each frame container at
 * the part holding that frame's document — an edit to untrusted HTML, which
 * `apps/extension` must not be doing with a regex or a parser of its own
 * (CONTRIBUTING.md, "Boundaries to keep"), and which the library already
 * owns the machinery for: parse5 for source offsets, a splice for the edit,
 * no reserialization of anything.
 *
 * It is a *second* entry point rather than a widening of the internal
 * value-keyed one because the two callers hold different join keys. A
 * converter matches frames by URL; a capture matches them by identity, and
 * two `<iframe>`s can share a `src`, so a value-keyed rewrite cannot
 * express "this container, not the identical one beside it". What the
 * library can verify is a DOM ordinal, so that — named as such — is what
 * the API takes; translating a browsing-context index into one stays with
 * the browser-specific code that can observe both. Nothing else about the
 * walk is exposed.
 */
export { type FrameContainerRewriteResult, rewriteFrameContainerSrcAttributes } from './mhtml/html-rewrite.ts'
export { extractMhtmlRootTitle } from './mhtml/html-title.ts'
export type { ContentType } from './mhtml/mime-header.ts'
/**
 * Exported for archive *producers*, for the same reason {@link encodeCidUri}
 * is. A capture adapter decides what media type and charset a fetched
 * resource is recorded with, and {@link serializeMhtml} *throws* on a part
 * whose `mimeType` is not a real RFC 2045 `token "/" token` — correct for
 * the library, and fatal to an entire save if one page-controlled
 * `Content-Type` reaches it. The rule the serializer enforces and the
 * grammar it parses already live in `mhtml/mime-header.ts`, so a producer
 * gets them from there rather than approximating either with a regex of its
 * own. What stays outside the library is the *policy* built on top of them:
 * which fallback media type an image or a stylesheet gets, and which charsets
 * a capture is willing to record, are the capture's decisions, not MHTML's.
 */
export { isValidMediaType, parseContentType } from './mhtml/mime-header.ts'
export { parseMhtml } from './mhtml/parse.ts'
export { serializeMhtml } from './mhtml/serialize.ts'
export type { ArchiveFormat, Diagnostic } from './model/archive.ts'
export type { MhtmlDocument, MhtmlParseResult, MhtmlPart } from './model/mhtml.ts'
export type { WebArchiveDocument, WebArchiveParseResult, WebArchiveResource } from './model/webarchive.ts'
export type { BlockedReferenceReason, MhtmlRenderResult, RenderMhtmlOptions, RenderStats, RenderWarning } from './view/render.ts'
export { NEUTRALIZED_URL, renderMhtml } from './view/render.ts'
export { parseWebArchive } from './webarchive/parse.ts'
export { serializeWebArchive } from './webarchive/serialize.ts'
