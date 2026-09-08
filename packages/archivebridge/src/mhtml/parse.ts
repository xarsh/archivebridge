/**
 * Minimal MHTML parser (RFC 2557 `multipart/related`, RFC 2045/2046 MIME).
 *
 * Scope for this initial implementation: a single-level `multipart/related`
 * message whose parts each carry a `Content-Location`. Nested frames
 * (`multipart/mixed` wrapping several `multipart/related` documents,
 * `Content-ID`-addressed parts) are not handled yet; every archive parses
 * with `frames: []`. See docs/architecture.md for the target `Archive`
 * model this feeds into and the diagnostics contract.
 *
 * Parsing works on raw bytes throughout, never on a whole-file text decode:
 * MHTML bodies can carry arbitrary 8-bit resource data (a raw/`8bit`
 * transfer-encoded image, for instance), and decoding that as UTF-8 or
 * Latin-1 up front is lossy for some byte values. Only genuinely ASCII-safe
 * spans (headers, quoted-printable/base64 bodies, which are ASCII by
 * construction) are ever converted to strings.
 *
 * Base64 decoding is delegated to `@exodus/bytes/base64.js` rather than the
 * platform `Uint8Array.fromBase64`: that method only landed in V8 14 (Node
 * 25+) and Node 24 — this project's current minimum — does not have it. See
 * CONTRIBUTING.md's dependency policy for when to revisit this and switch
 * back to the native API.
 */

import { fromBase64 } from '@exodus/bytes/base64.js'
import type { Archive, Diagnostic, ParseResult, Resource } from '../model/archive.ts'

const CR = 0x0d
const LF = 0x0a

/** Splits raw bytes into lines on LF, stripping a trailing CR. Handles both CRLF and LF-only input uniformly. */
function splitLines(bytes: Uint8Array): Uint8Array[] {
	const lines: Uint8Array[] = []
	let start = 0
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === LF) {
			const end = i > start && bytes[i - 1] === CR ? i - 1 : i
			lines.push(bytes.subarray(start, end))
			start = i + 1
		}
	}
	lines.push(bytes.subarray(start))
	return lines
}

/** Joins line byte-slices back together with a single LF between each (none trailing), never decoding to text. */
function joinLines(lines: readonly Uint8Array[]): Uint8Array {
	if (lines.length === 0) {
		return new Uint8Array(0)
	}

	let total = lines.length - 1
	for (const line of lines) {
		total += line.length
	}

	const out = new Uint8Array(total)
	let offset = 0
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined) {
			continue
		}
		out.set(line, offset)
		offset += line.length
		if (i < lines.length - 1) {
			out[offset] = LF
			offset += 1
		}
	}
	return out
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
function parseHeaders(lines: readonly Uint8Array[], start: number): HeaderBlock {
	const headers = new Map<string, string>()
	let lastKey: string | undefined
	let i = start

	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined || line.length === 0) {
			i += 1
			break
		}

		const text = headerDecoder.decode(line)

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

interface ContentType {
	readonly type: string
	readonly params: ReadonlyMap<string, string>
}

/** Splits a header value on top-level `;` separators, respecting `"quoted"` segments. */
function splitHeaderParams(value: string): string[] {
	const parts: string[] = []
	let current = ''
	let inQuotes = false

	for (const ch of value) {
		if (ch === '"') {
			inQuotes = !inQuotes
		}
		if (ch === ';' && !inQuotes) {
			parts.push(current)
			current = ''
			continue
		}
		current += ch
	}
	parts.push(current)
	return parts
}

function parseContentType(value: string): ContentType {
	const [typeSegment, ...paramSegments] = splitHeaderParams(value)
	const type = (typeSegment ?? '').trim().toLowerCase()
	const params = new Map<string, string>()

	for (const segment of paramSegments) {
		const eq = segment.indexOf('=')
		if (eq === -1) {
			continue
		}
		const key = segment.slice(0, eq).trim().toLowerCase()
		let paramValue = segment.slice(eq + 1).trim()
		if (paramValue.length >= 2 && paramValue.startsWith('"') && paramValue.endsWith('"')) {
			paramValue = paramValue.slice(1, -1)
		}
		params.set(key, paramValue)
	}

	return { type, params }
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

/** Splits the lines making up a `multipart/related` body into per-part line groups, delimited by `boundary`. */
function splitParts(lines: readonly Uint8Array[], start: number, boundary: string): Uint8Array[][] {
	const parts: Uint8Array[][] = []
	let i = start

	// Skip the preamble (ignored per RFC 2046) up to the first delimiter line.
	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line !== undefined && boundaryLineKind(line, boundary) === 'delimiter') {
			i += 1
			break
		}
	}

	let current: Uint8Array[] = []
	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line === undefined) {
			continue
		}
		const kind = boundaryLineKind(line, boundary)
		if (kind === 'delimiter') {
			parts.push(current)
			current = []
			continue
		}
		if (kind === 'close') {
			parts.push(current)
			return parts
		}
		current.push(line)
	}

	// No closing delimiter found; keep whatever was collected as a best-effort last part.
	parts.push(current)
	return parts
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
 * Decodes quoted-printable bytes per RFC 2045. Operates on already
 * LF-joined lines, so a soft line break is exactly `=` followed by LF; a
 * bare LF is a real, meaningful line break in the decoded content. A `=`
 * that isn't a valid soft break or `=XX` hex escape is passed through
 * literally rather than treated as fatal, matching the "recover, don't
 * throw" stance for non-conforming input.
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

interface ParsedPart {
	readonly resource: Resource
	/** Raw `Content-ID` header value (still `<...>`-wrapped), if present. Used only to resolve the RFC 2387 `start` parameter; it never leaks into `Resource` (see docs/architecture.md). */
	readonly contentId: string | undefined
}

/** Strips the RFC 2392 `<...>` wrapper from a Content-ID / `start` parameter value, if present. */
function normalizeCid(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length >= 2 && trimmed.startsWith('<') && trimmed.endsWith('>')) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function parsePart(partLines: readonly Uint8Array[], diagnostics: Diagnostic[]): ParsedPart | undefined {
	const { headers, bodyStart } = parseHeaders(partLines, 0)

	const url = headers.get('content-location')
	if (url === undefined) {
		diagnostics.push({ type: 'malformed-resource', message: 'part is missing a Content-Location header' })
		return undefined
	}

	const contentTypeHeader = headers.get('content-type')
	const contentType = contentTypeHeader === undefined ? undefined : parseContentType(contentTypeHeader)
	const mimeType = contentType?.type ?? DEFAULT_MIME_TYPE
	const textEncoding = contentType?.params.get('charset') ?? (contentType === undefined ? DEFAULT_TEXT_ENCODING : undefined)

	const transferEncoding = (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase()
	const body = partLines.slice(bodyStart)

	let data: Uint8Array
	switch (transferEncoding) {
		case 'quoted-printable':
			data = decodeQuotedPrintable(joinLines(body))
			break
		case 'base64': {
			const decoded = decodeBase64(joinLines(body))
			if (decoded === undefined) {
				diagnostics.push({ type: 'malformed-resource', url, message: 'invalid base64 body' })
				return undefined
			}
			data = decoded
			break
		}
		case '7bit':
		case '8bit':
		case 'binary':
			data = joinLines(body)
			break
		default:
			diagnostics.push({ type: 'unsupported-encoding', encoding: transferEncoding })
			return undefined
	}

	return {
		resource: {
			url,
			mimeType,
			data,
			...(textEncoding !== undefined ? { textEncoding } : {}),
		},
		contentId: headers.get('content-id'),
	}
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
 * A `start` parameter that doesn't match any part's Content-ID is reported
 * as `recovered-non-conforming-input` and falls through to the next
 * strategy rather than failing the archive.
 */
function findMainPartIndex(parts: readonly ParsedPart[], startCid: string | undefined, declaredMainUrl: string | undefined, diagnostics: Diagnostic[]): number | undefined {
	if (startCid !== undefined) {
		const index = parts.findIndex((part) => part.contentId !== undefined && normalizeCid(part.contentId) === startCid)
		if (index !== -1) {
			return index
		}
		diagnostics.push({
			type: 'recovered-non-conforming-input',
			message: `multipart/related start parameter references unknown Content-ID "${startCid}"`,
		})
	}

	if (declaredMainUrl !== undefined) {
		const index = parts.findIndex((part) => part.resource.url === declaredMainUrl)
		return index === -1 ? undefined : index
	}

	return parts.length > 0 ? 0 : undefined
}

/**
 * Parses an MHTML/MHT byte stream into an {@link Archive}. Prefers
 * diagnostics over throwing: a malformed part is dropped with a
 * `malformed-resource`/`unsupported-encoding` diagnostic rather than
 * failing the whole archive, but a missing/unparseable top-level
 * `multipart/related` envelope has no reasonable partial result and is
 * reported as `malformed-archive` with `archive: undefined`.
 */
export function parseMhtml(bytes: Uint8Array): ParseResult {
	const diagnostics: Diagnostic[] = []
	const lines = splitLines(bytes)
	const { headers, bodyStart } = parseHeaders(lines, 0)

	const contentTypeHeader = headers.get('content-type')
	if (contentTypeHeader === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'missing top-level Content-Type header' })
		return { archive: undefined, diagnostics }
	}

	const contentType = parseContentType(contentTypeHeader)
	if (contentType.type !== 'multipart/related') {
		diagnostics.push({ type: 'unsupported-feature', feature: `top-level Content-Type "${contentType.type}"` })
		return { archive: undefined, diagnostics }
	}

	const boundary = contentType.params.get('boundary')
	if (boundary === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'multipart/related is missing a boundary parameter' })
		return { archive: undefined, diagnostics }
	}

	const startParam = contentType.params.get('start')
	const startCid = startParam === undefined ? undefined : normalizeCid(startParam)
	const declaredMainUrl = headers.get('snapshot-content-location')

	const parts: ParsedPart[] = []
	for (const partLines of splitParts(lines, bodyStart, boundary)) {
		const part = parsePart(partLines, diagnostics)
		if (part !== undefined) {
			parts.push(part)
		}
	}

	const mainIndex = findMainPartIndex(parts, startCid, declaredMainUrl, diagnostics)
	const mainResource = mainIndex === undefined ? undefined : parts[mainIndex]?.resource
	// Even when no part matched, a declared main URL is still the archive's asserted main URL
	// (the final check below reports `malformed-archive` since `mainResource` is undefined).
	const mainUrl = mainResource?.url ?? declaredMainUrl

	// The main resource is kept out of `resources`: see docs/architecture.md on why it must
	// not appear in both places.
	const resources = new Map<string, Resource>()
	for (let i = 0; i < parts.length; i++) {
		if (i === mainIndex) {
			continue
		}
		const resource = parts[i]?.resource
		if (resource === undefined) {
			continue
		}
		if (resource.url === mainUrl || resources.has(resource.url)) {
			diagnostics.push({ type: 'duplicate-resource-url', url: resource.url })
			continue
		}
		resources.set(resource.url, resource)
	}

	if (mainUrl === undefined || mainResource === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'no main resource found in multipart/related body' })
		return { archive: undefined, diagnostics }
	}

	const archive: Archive = {
		mainUrl,
		mainResource,
		resources,
		frames: [],
	}

	return { archive, diagnostics }
}
