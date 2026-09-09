/**
 * Minimal MHTML parser (RFC 2557 `multipart/related`, RFC 2045/2046 MIME).
 *
 * Produces an `MhtmlDocument`: a flat, order-preserving list of MIME parts
 * plus a resolved root index — the direct reflection of what a real MHTML
 * document is, per docs/architecture.md ("MHTML-native representation").
 * Frame relationships (`cid:`-linked `<iframe>` parts) are not resolved
 * here; see `mhtml/frames.ts`.
 *
 * Parsing works on raw bytes throughout, never on a whole-file text decode:
 * MHTML bodies can carry arbitrary 8-bit resource data (a raw/`8bit`
 * transfer-encoded image, for instance), and decoding that as UTF-8 or
 * Latin-1 up front is lossy for some byte values. Only genuinely ASCII-safe
 * spans (headers, quoted-printable/base64 bodies, which are ASCII by
 * construction) are ever converted to strings.
 *
 * Structural parsing (headers, boundary delimiters) is line-oriented, but a
 * part's body is *never* reconstructed from those lines: {@link MimeLine}
 * records keep each line's offsets into the original buffer, and a body is
 * extracted as one raw span of the source (see {@link rawBody}). Splitting a
 * message into lines and re-joining them with a canonical terminator would
 * silently rewrite a body's original CRLFs as LFs — for a `7bit`/`8bit`/
 * `binary` part that is a byte-level corruption of the resource, and for a
 * quoted-printable part it changes what its hard line breaks decode to.
 *
 * Base64 decoding is delegated to `@exodus/bytes/base64.js` rather than the
 * platform `Uint8Array.fromBase64`: that method only landed in V8 14 (Node
 * 25+) and Node 24 — this project's current minimum — does not have it. See
 * CONTRIBUTING.md's dependency policy for when to revisit this and switch
 * back to the native API.
 */

import { fromBase64 } from '@exodus/bytes/base64.js'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlParseResult, MhtmlPart } from '../model/mhtml.ts'
import { type ContentType, isValidMediaType, parseContentType } from './mime-header.ts'

const CR = 0x0d
const LF = 0x0a

/**
 * One line of the source message, remembering where it sat in the original
 * buffer so a body span can be taken from the source bytes directly rather
 * than rebuilt from line content.
 */
interface MimeLine {
	/** The line's content bytes, excluding its terminator (CRLF or a bare LF). */
	readonly content: Uint8Array
	/** Offset of `content`'s first byte within the buffer the line was split from. */
	readonly start: number
	/** Offset just past `content`'s last byte — i.e. at this line's terminator, if it has one. */
	readonly contentEnd: number
}

/** Splits raw bytes into lines on LF, treating a preceding CR as part of the terminator. Handles both CRLF and LF-only input uniformly. */
function splitLines(bytes: Uint8Array): MimeLine[] {
	const lines: MimeLine[] = []
	let start = 0
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === LF) {
			const contentEnd = i > start && bytes[i - 1] === CR ? i - 1 : i
			lines.push({ content: bytes.subarray(start, contentEnd), start, contentEnd })
			start = i + 1
		}
	}
	lines.push({ content: bytes.subarray(start), start, contentEnd: bytes.length })
	return lines
}

/**
 * The raw body bytes of one MIME entity: a single span of `source`, from the
 * first body line's first byte through the last body line's content —
 * excluding that last line's terminator, because per RFC 2046 the CRLF
 * immediately preceding a boundary delimiter line belongs to the delimiter,
 * not to the body part it follows. Every other byte in between, including any
 * CRLF or bare LF genuinely inside the body, is returned exactly as it
 * appeared in `source`.
 */
function rawBody(source: Uint8Array, lines: readonly MimeLine[], bodyStart: number): Uint8Array {
	const first = lines[bodyStart]
	const last = lines[lines.length - 1]
	if (first === undefined || last === undefined || last.contentEnd <= first.start) {
		return new Uint8Array(0)
	}
	return source.subarray(first.start, last.contentEnd)
}

// Headers are required by RFC 2045 to be US-ASCII; decoding them as UTF-8 is
// exact for conforming input and merely lenient (never throws) otherwise.
const headerDecoder = new TextDecoder('utf-8', { fatal: false })

interface HeaderBlock {
	readonly headers: ReadonlyMap<string, string>
	/** Index of the first body line, i.e. just past the blank line terminating the header block. */
	readonly bodyStart: number
}

/** Parses RFC 2045 headers (with folded continuation lines) starting at `lines[start]`, stopping at the first blank line. */
function parseHeaders(lines: readonly MimeLine[], start: number): HeaderBlock {
	const headers = new Map<string, string>()
	let lastKey: string | undefined
	let i = start

	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined || line.content.length === 0) {
			i += 1
			break
		}

		const text = headerDecoder.decode(line.content)

		if ((text.startsWith(' ') || text.startsWith('\t')) && lastKey !== undefined) {
			headers.set(lastKey, `${headers.get(lastKey)} ${text.trim()}`)
			continue
		}

		const colon = text.indexOf(':')
		if (colon === -1) {
			continue
		}

		const key = text.slice(0, colon).trim().toLowerCase()
		const value = text.slice(colon + 1).trim()
		headers.set(key, value)
		lastKey = key
	}

	return { headers, bodyStart: i }
}

type BoundaryLineKind = 'delimiter' | 'close'

/** RFC 2046 boundary lines are ASCII by construction, so only lines that look like one pay for a text decode. */
function boundaryLineKind(line: Uint8Array, boundary: string): BoundaryLineKind | undefined {
	if (line.length < 2 || line[0] !== 0x2d || line[1] !== 0x2d) {
		return undefined
	}
	const text = headerDecoder.decode(line).trimEnd()
	if (text === `--${boundary}--`) {
		return 'close'
	}
	if (text === `--${boundary}`) {
		return 'delimiter'
	}
	return undefined
}

interface MultipartBody {
	/** The lines of each collected body part, in document order. Empty when the boundary never opened. */
	readonly parts: readonly (readonly MimeLine[])[]
	/** Whether the declared boundary ever appeared as an opening delimiter line (RFC 2046's `dash-boundary`). */
	readonly opened: boolean
	/** Whether the closing `--boundary--` delimiter was found. */
	readonly closed: boolean
}

/**
 * Splits the lines making up a `multipart/related` body into per-part line
 * groups, delimited by `boundary`, reporting whether the opening and closing
 * delimiters were actually present.
 *
 * A boundary that never appears at all yields **no parts**, not one empty
 * one: RFC 2046's `multipart-body` grammar requires a `dash-boundary` before
 * the first body part, so with no delimiter anywhere there is no MIME entity
 * to parse — manufacturing an empty part there would turn an unparseable
 * envelope into a spurious, valid-looking one-part document.
 */
function splitParts(lines: readonly MimeLine[], start: number, boundary: string): MultipartBody {
	let i = start
	let opened = false

	// Skip the preamble (ignored per RFC 2046) up to the first delimiter line.
	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line !== undefined && boundaryLineKind(line.content, boundary) === 'delimiter') {
			opened = true
			i += 1
			break
		}
	}
	if (!opened) {
		return { parts: [], opened: false, closed: false }
	}

	const parts: MimeLine[][] = []
	let current: MimeLine[] = []
	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined) {
			continue
		}
		const kind = boundaryLineKind(line.content, boundary)
		if (kind === 'delimiter') {
			parts.push(current)
			current = []
			continue
		}
		if (kind === 'close') {
			parts.push(current)
			return { parts, opened: true, closed: true }
		}
		current.push(line)
	}

	// No closing delimiter found; keep whatever was collected as a best-effort last part.
	parts.push(current)
	return { parts, opened: true, closed: false }
}

function hexDigit(byte: number | undefined): number | undefined {
	if (byte === undefined) {
		return undefined
	}
	if (byte >= 0x30 && byte <= 0x39) {
		return byte - 0x30
	}
	if (byte >= 0x41 && byte <= 0x46) {
		return byte - 0x41 + 10
	}
	if (byte >= 0x61 && byte <= 0x66) {
		return byte - 0x61 + 10
	}
	return undefined
}

/**
 * Decodes quoted-printable bytes per RFC 2045. Operates on the part's *raw*
 * body span, so a soft line break is `=` followed by the line terminator in
 * whichever form the input actually used (CRLF for conforming input, a bare
 * LF for non-conforming input this reader still tolerates), and a hard line
 * break is passed through with its original bytes intact — never rewritten
 * to a canonical terminator the source didn't have. A `=` that isn't a valid
 * soft break or `=XX` hex escape is passed through literally rather than
 * treated as fatal, matching the "recover, don't throw" stance for
 * non-conforming input.
 */
function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
	const out: number[] = []

	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]
		if (byte === undefined) {
			break
		}
		if (byte !== 0x3d) {
			out.push(byte)
			continue
		}

		if (bytes[i + 1] === CR && bytes[i + 2] === LF) {
			i += 2
			continue
		}
		if (bytes[i + 1] === LF) {
			i += 1
			continue
		}

		const hi = hexDigit(bytes[i + 1])
		const lo = hexDigit(bytes[i + 2])
		if (hi === undefined || lo === undefined) {
			out.push(byte)
			continue
		}
		out.push(hi * 16 + lo)
		i += 2
	}

	return Uint8Array.from(out)
}

// RFC 2045 §6.8 base64 bodies are wrapped at 76 characters and may carry any
// amount of the MIME-permitted whitespace (space, tab, CR, LF, FF) around
// that wrapping; it's formatting, not part of the encoded data. `fromBase64`
// rejects whitespace outright, so it's stripped here; everything else
// (alphabet, padding correctness) is left to `fromBase64` to validate.
const MIME_BASE64_WHITESPACE = /[\t\n\f\r ]/g

/** Decodes a base64 body. The body is ASCII by construction, so a lossless byte->string conversion is safe here. */
function decodeBase64(bytes: Uint8Array): Uint8Array | undefined {
	const text = headerDecoder.decode(bytes).replace(MIME_BASE64_WHITESPACE, '')
	try {
		return fromBase64(text)
	} catch {
		return undefined
	}
}

const DEFAULT_MIME_TYPE = 'text/plain'
const DEFAULT_TEXT_ENCODING = 'us-ascii'

/** Strips the RFC 2392 `<...>` wrapper from a Content-ID / `start` parameter value, if present. */
function normalizeCid(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length >= 2 && trimmed.startsWith('<') && trimmed.endsWith('>')) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

interface ResolvedMediaType {
	readonly mimeType: string
	/**
	 * True when RFC 2045 §5.2's default was applied (`Content-Type` absent, or
	 * present but syntactically invalid) rather than a declared media type
	 * being honored. The caller needs this because §5.2's default is the whole
	 * of `text/plain; charset=us-ascii`: when it applies, the charset half
	 * applies too and any `charset` scraped from the invalid field is dropped —
	 * see {@link parsePart}.
	 */
	readonly defaulted: boolean
}

/**
 * Resolves a part's declared media type. RFC 2045 §5.2 makes `text/plain`
 * the default not only when `Content-Type` is absent but also — as an
 * explicit recommendation — when the header is present but syntactically
 * invalid, which is what this does: a media type that isn't a `token "/"
 * token` (per `mime-header.ts`'s `isValidMediaType`) is recovered to the
 * default rather than stored verbatim. That keeps the writer's rule that a
 * `Content-Type` must be emittable (`mhtml/serialize.ts`) from turning
 * tolerantly-parsed non-conforming input into a document ArchiveBridge can
 * parse but refuses to write back out.
 */
function resolveMediaType(contentType: ContentType | undefined, location: string | undefined, diagnostics: Diagnostic[]): ResolvedMediaType {
	if (contentType === undefined) {
		return { mimeType: DEFAULT_MIME_TYPE, defaulted: true }
	}
	if (isValidMediaType(contentType.type)) {
		return { mimeType: contentType.type, defaulted: false }
	}
	diagnostics.push({
		type: 'recovered-non-conforming-input',
		message: `part ${location === undefined ? '' : `for "${location}" `}declares a syntactically invalid media type ${JSON.stringify(contentType.type)}; defaulted to ${DEFAULT_MIME_TYPE}`,
	})
	return { mimeType: DEFAULT_MIME_TYPE, defaulted: true }
}

/**
 * Parses one MIME part into an `MhtmlPart`. Neither `Content-Location` nor
 * `Content-ID` is required for a part to parse successfully — absence of
 * either is not itself fatal (see docs/architecture.md, `MhtmlPart`'s
 * `location` field doc); only an unparseable/unsupported body fails a part.
 *
 * `source` is the buffer `partLines` were split from: the body is taken as a
 * raw span of it (see {@link rawBody}) so the resource's own bytes — CRLFs
 * included — survive parsing untouched.
 */
function parsePart(source: Uint8Array, partLines: readonly MimeLine[], diagnostics: Diagnostic[]): MhtmlPart | undefined {
	const { headers, bodyStart } = parseHeaders(partLines, 0)

	const location = headers.get('content-location')
	const contentIdHeader = headers.get('content-id')
	const contentId = contentIdHeader === undefined ? undefined : normalizeCid(contentIdHeader)

	const contentTypeHeader = headers.get('content-type')
	const contentType = contentTypeHeader === undefined ? undefined : parseContentType(contentTypeHeader)
	const { mimeType, defaulted } = resolveMediaType(contentType, location, diagnostics)
	// RFC 2045 §5.2's default is `text/plain; charset=us-ascii` as a *single*
	// default, recommended both when `Content-Type` is absent and when the
	// field is syntactically invalid — so it is applied whole, media type and
	// charset together, and a `charset` parsed out of an invalid field is
	// discarded rather than salvaged.
	//
	// Discarding it is the standards-oriented reading, not just the simpler
	// one. §5.1's grammar is `content := "Content-Type" ":" type "/" subtype
	// *(";" parameter)`: the parameters belong to the same production as the
	// media type, so if `type "/" subtype` doesn't parse, there is no valid
	// Content-Type field for those parameters to be parameters *of*. Trusting
	// half of a field already declared invalid would be an ArchiveBridge
	// tolerant-reader extension with no rule behind it — and §5.2's trigger is
	// an invalid header *field*, not an invalid media type with usable
	// parameters. Nothing is corrupted by the loss: the recovered media type is
	// `text/plain`, and only `text/html` parts are ever decoded and re-encoded
	// (`convert/to-mhtml.ts`'s `isHtml`, `mhtml/frames.ts`'s `isHtmlMimeType`),
	// so the charset here is a label carried through, never applied to bytes.
	//
	// A *valid* media type with no `charset` stays `undefined` on purpose, even
	// for `text/plain`: for `text/html` in particular, "no charset declared at
	// the MIME level" is meaningful information a consumer needs in order to
	// fall back to the document's own `<meta charset>`, and manufacturing
	// `us-ascii` there would erase that distinction.
	const textEncoding = defaulted ? DEFAULT_TEXT_ENCODING : contentType?.params.get('charset')

	const transferEncoding = (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase()
	const body = rawBody(source, partLines, bodyStart)

	let data: Uint8Array
	switch (transferEncoding) {
		case 'quoted-printable':
			data = decodeQuotedPrintable(body)
			break
		case 'base64': {
			const decoded = decodeBase64(body)
			if (decoded === undefined) {
				diagnostics.push({ type: 'malformed-resource', ...(location !== undefined ? { url: location } : {}), message: 'invalid base64 body' })
				return undefined
			}
			data = decoded
			break
		}
		case '7bit':
		case '8bit':
		case 'binary':
			// Byte-exact: `rawBody` already returned the entity body verbatim, and these
			// three encodings are identity transforms over it (RFC 2045 §6.2/§6.4).
			data = body
			break
		default:
			diagnostics.push({ type: 'unsupported-encoding', encoding: transferEncoding })
			return undefined
	}

	return { contentId, location, mimeType, textEncoding, data }
}

/**
 * Determines which parsed part is the "root" body part per RFC 2387, in
 * priority order:
 *
 * 1. The `start` parameter on the top-level `Content-Type`, matched against
 *    each part's `Content-ID` header (the standards-conforming mechanism;
 *    what `serializeMhtml` writes).
 * 2. `Snapshot-Content-Location`, matched against each part's
 *    `Content-Location` (a Blink/Chromium convention, not RFC 2387 — kept
 *    for reader compatibility with real-world Chrome-generated MHTML, which
 *    does not write `start`).
 * 3. The first successfully-parsed part.
 *
 * Both hints are genuinely *hints*: a `start` parameter or a
 * `Snapshot-Content-Location` that matches no part is reported as
 * `recovered-non-conforming-input` and falls through to the next strategy
 * rather than failing the archive. In particular a stale
 * `Snapshot-Content-Location` — a Blink compatibility mechanism
 * ArchiveBridge reads but never writes — must not be fatal to an archive
 * whose first part is perfectly usable. Only having no parts at all leaves
 * nothing to resolve.
 */
function findMainPartIndex(parts: readonly MhtmlPart[], startCid: string | undefined, declaredMainUrl: string | undefined, diagnostics: Diagnostic[]): number | undefined {
	if (startCid !== undefined) {
		const index = parts.findIndex((part) => part.contentId === startCid)
		if (index !== -1) {
			return index
		}
		diagnostics.push({
			type: 'recovered-non-conforming-input',
			message: `multipart/related start parameter references unknown Content-ID "${startCid}"`,
		})
	}

	if (declaredMainUrl !== undefined) {
		const index = parts.findIndex((part) => part.location === declaredMainUrl)
		if (index !== -1) {
			return index
		}
		diagnostics.push({
			type: 'recovered-non-conforming-input',
			message: `Snapshot-Content-Location references unknown Content-Location "${declaredMainUrl}"`,
		})
	}

	return parts.length > 0 ? 0 : undefined
}

/**
 * Flags duplicate `Content-Location`/`Content-ID` identities across `parts`,
 * without dropping either part: `MhtmlDocument.parts` is a lossless, direct
 * reflection of the underlying multipart structure (see
 * docs/architecture.md), so a duplicate identity is reported, not silently
 * resolved by discarding data.
 */
function checkDuplicateIdentities(parts: readonly MhtmlPart[], diagnostics: Diagnostic[]): void {
	const seenLocations = new Set<string>()
	const seenContentIds = new Set<string>()
	for (const part of parts) {
		if (part.location !== undefined) {
			if (seenLocations.has(part.location)) {
				diagnostics.push({ type: 'duplicate-content-location', url: part.location })
			}
			seenLocations.add(part.location)
		}
		if (part.contentId !== undefined) {
			if (seenContentIds.has(part.contentId)) {
				diagnostics.push({ type: 'duplicate-content-id', contentId: part.contentId })
			}
			seenContentIds.add(part.contentId)
		}
	}
}

/**
 * Parses an MHTML/MHT byte stream into an {@link MhtmlDocument}. Prefers
 * diagnostics over throwing: a malformed part is dropped with a
 * `malformed-resource`/`unsupported-encoding` diagnostic rather than
 * failing the whole document, but a missing/unparseable top-level
 * `multipart/related` envelope, or one with no resolvable root part, has no
 * reasonable partial result and is reported as `malformed-archive` with
 * `document: undefined` — see `MhtmlDocument`'s invariants in
 * `model/mhtml.ts`. A declared boundary that never opens a part is one such
 * case; a missing *closing* delimiter is not, and recovers with a
 * `recovered-non-conforming-input` diagnostic.
 */
export function parseMhtml(bytes: Uint8Array): MhtmlParseResult {
	const diagnostics: Diagnostic[] = []
	const lines = splitLines(bytes)
	const { headers, bodyStart } = parseHeaders(lines, 0)

	const contentTypeHeader = headers.get('content-type')
	if (contentTypeHeader === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'missing top-level Content-Type header' })
		return { document: undefined, diagnostics }
	}

	const contentType = parseContentType(contentTypeHeader)
	if (contentType.type !== 'multipart/related') {
		diagnostics.push({ type: 'unsupported-feature', feature: `top-level Content-Type "${contentType.type}"` })
		return { document: undefined, diagnostics }
	}

	const boundary = contentType.params.get('boundary')
	if (boundary === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'multipart/related is missing a boundary parameter' })
		return { document: undefined, diagnostics }
	}

	const startParam = contentType.params.get('start')
	const startCid = startParam === undefined ? undefined : normalizeCid(startParam)
	const declaredMainUrl = headers.get('snapshot-content-location')

	const multipart = splitParts(lines, bodyStart, boundary)
	if (!multipart.opened) {
		diagnostics.push({ type: 'malformed-archive', message: `multipart/related boundary "${boundary}" never appears as an opening delimiter` })
		return { document: undefined, diagnostics }
	}
	if (!multipart.closed) {
		diagnostics.push({ type: 'recovered-non-conforming-input', message: `multipart/related body has no closing "--${boundary}--" delimiter` })
	}

	const parts: MhtmlPart[] = []
	for (const partLines of multipart.parts) {
		const part = parsePart(bytes, partLines, diagnostics)
		if (part !== undefined) {
			parts.push(part)
		}
	}

	checkDuplicateIdentities(parts, diagnostics)

	const rootPartIndex = findMainPartIndex(parts, startCid, declaredMainUrl, diagnostics)

	if (rootPartIndex === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'no main resource found in multipart/related body' })
		return { document: undefined, diagnostics }
	}

	const document: MhtmlDocument = { parts, rootPartIndex }

	return { document, diagnostics }
}
