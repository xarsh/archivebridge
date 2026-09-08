/**
 * Format-independent representation of a saved web page archive.
 *
 * MHTML and WebArchive both parse into this shape so that the rest of the
 * library (diagnostics, serialization, CLI, extension) never has to branch
 * on the original file format. Format-specific concepts (MIME multipart
 * boundaries, Content-ID, plist keys, ...) are resolved during parsing and
 * must not leak past this boundary. See docs/architecture.md.
 */

/** Archive formats ArchiveBridge understands. */
export type ArchiveFormat = 'mhtml' | 'webarchive'

/**
 * A single fetched resource (the top-level document, a stylesheet, an
 * image, ...). `data` is always the raw decoded bytes: base64 and
 * quoted-printable transfer encodings are undone during parsing, they are
 * not part of this model.
 */
export interface Resource {
	readonly url: string
	readonly mimeType: string
	readonly data: Uint8Array
	/** Charset for text resources, e.g. "utf-8". Absent when unknown or not applicable. */
	readonly textEncoding?: string
}

/**
 * A parsed archive. `frames` holds nested archives for iframes/framesets
 * that were themselves captured as sub-archives; most archives have none.
 */
export interface Archive {
	readonly mainUrl: string
	readonly mainResource: Resource
	readonly resources: ReadonlyMap<string, Resource>
	readonly frames: readonly Archive[]
}

/**
 * Non-fatal and fatal problems surfaced while parsing or converting an
 * archive. Parsing real-world archives should prefer returning diagnostics
 * over throwing, so a single malformed resource does not discard an
 * otherwise-readable archive.
 */
export type Diagnostic =
	| {
			readonly type: 'malformed-archive'
			readonly message: string
	  }
	| {
			readonly type: 'malformed-resource'
			readonly url?: string
			readonly message: string
	  }
	| {
			readonly type: 'unsupported-encoding'
			readonly encoding: string
	  }
	| {
			readonly type: 'unresolved-resource'
			readonly url: string
	  }
	| {
			readonly type: 'duplicate-resource-url'
			readonly url: string
	  }
	| {
			readonly type: 'unsupported-feature'
			readonly feature: string
	  }
	| {
			readonly type: 'recovered-non-conforming-input'
			readonly message: string
	  }

/**
 * Shared shape for future parse/convert entry points: a possibly-partial
 * archive plus whatever diagnostics were collected along the way. Kept here
 * as a type-only contract; no function returns this yet.
 */
export interface ParseResult {
	readonly archive: Archive | undefined
	readonly diagnostics: readonly Diagnostic[]
}
