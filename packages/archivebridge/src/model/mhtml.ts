/**
 * MHTML-native representation: one `multipart/related` envelope holding a
 * flat, ordered list of MIME parts, one of which is resolved as the root.
 * This mirrors what real MHTML actually is (RFC 2557) rather than inventing
 * a cross-format tree — see docs/architecture.md, "MHTML-native
 * representation" and "No format-neutral Archive/ArchiveView IR".
 *
 * Frame relationships (which parts are "the document for some <iframe>")
 * are not stored here: they're derived on demand from `cid:` references in
 * `text/html` part bodies. See `mhtml/frames.ts`.
 */

import type { Diagnostic } from './archive.ts'

/** A single MIME part within an MhtmlDocument's `multipart/related` envelope. */
export interface MhtmlPart {
	/** Content-ID, normalized (no `<...>` wrapper — see mhtml/parse.ts's `normalizeCid`). Not every part has one. */
	readonly contentId: string | undefined
	/**
	 * Content-Location: an absolute URL for ordinary resources, or a
	 * synthetic `cid:` URI for inline content with no natural URL (a real,
	 * observed producer convention). Not every part has one either: a
	 * foreign part carrying only a Content-ID, or ArchiveBridge's own
	 * metadata sidecar part, legitimately has none. Absence is not itself
	 * fatal to parsing — whichever specific operation actually needs an
	 * identity for a part is what reports a diagnostic if it can't proceed
	 * without one.
	 */
	readonly location: string | undefined
	readonly mimeType: string
	readonly textEncoding: string | undefined
	readonly data: Uint8Array
}

/**
 * A parsed or constructed MHTML document. Every `MhtmlDocument` that parsing
 * or construction successfully produces satisfies:
 *
 * ```
 * document.parts.length > 0
 * 0 <= document.rootPartIndex && document.rootPartIndex < document.parts.length
 * ```
 *
 * These are conditions on *valid* values of the type, not conditions a
 * caller needs to defensively check — code that receives an `MhtmlDocument`
 * is entitled to assume both hold. When input is malformed enough that a
 * root part can't be resolved, the correct outcome is no `MhtmlDocument` at
 * all (a `malformed-archive` diagnostic and an absent parse result), never a
 * value with a dangling `rootPartIndex` or an empty `parts` array.
 */
export interface MhtmlDocument {
	/** All MIME parts in original document order, including the root part. */
	readonly parts: readonly MhtmlPart[]
	/**
	 * Index into `parts` identifying the resolved root part (per RFC 2387's
	 * `start` parameter, the `Snapshot-Content-Location` fallback, or "first
	 * part"). Not necessarily `0`: `start` can name any part regardless of
	 * physical position.
	 */
	readonly rootPartIndex: number
}

/** Result of parsing MHTML bytes: a possibly-absent document plus whatever diagnostics were collected. */
export interface MhtmlParseResult {
	readonly document: MhtmlDocument | undefined
	readonly diagnostics: readonly Diagnostic[]
}
