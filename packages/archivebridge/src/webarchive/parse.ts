/**
 * Minimal Safari WebArchive parser (Apple property list, binary `bplist00`
 * or XML). A `.webarchive` file is a single top-level plist dictionary:
 *
 * - `WebMainResource` — a resource dictionary (see below) for the top-level
 *   document.
 * - `WebSubresources` — an optional array of resource dictionaries for
 *   everything else the page referenced (stylesheets, scripts, images, ...).
 * - `WebSubframeArchives` — an optional array of nested WebArchive
 *   dictionaries for iframes/framesets saved as their own sub-documents,
 *   recursively parsed into nested `WebArchiveDocument`s (bounded by
 *   `MAX_FRAME_DEPTH` — see docs/architecture.md#security-assumptions).
 *
 * A resource dictionary carries `WebResourceURL`, `WebResourceMIMEType`,
 * `WebResourceData` (raw bytes, already base64-decoded by the plist
 * parser), and optionally `WebResourceTextEncodingName`. Safari also writes
 * `WebResourceResponse` (an NSKeyedArchiver-serialized `NSURLResponse`, itself
 * a nested binary plist) and, on frame-root resources, `WebResourceFrameName`
 * — both are preserved opaquely on `WebArchiveResource`. Any other dictionary
 * key (resource- or document-level) is preserved opaquely in `extra` — see
 * docs/architecture.md, "WebArchive-native representation".
 *
 * Plist parsing itself (both the binary `bplist00` format and XML) is
 * delegated to the `plist` package rather than hand-rolled: binary plists in
 * particular are a non-trivial format (an offset table, variable-width
 * integers, object references) that this project's untrusted-input security
 * assumptions call for a battle-tested implementation rather than a
 * hand-written one. See CONTRIBUTING.md's dependency policy.
 *
 * Every dictionary that comes back from it is narrowed through
 * `plist-dict.ts` before any field is read, so `dict.WebResourceURL` and
 * friends below can only ever resolve to an *own* key of the source plist
 * dictionary — never through a prototype an archive replaced with a
 * `__proto__` key. That module owns the reasoning and the one narrow
 * preservation exception it implies.
 */

import { type PlistValue, parseBinary as parsePlistBinary, parse as parsePlistXml } from 'plist'
import { MAX_FRAME_DEPTH } from '../limits.ts'
import type { Diagnostic } from '../model/archive.ts'
import { RESERVED_DOCUMENT_KEYS, RESERVED_RESOURCE_KEYS, type WebArchiveDocument, type WebArchiveParseResult, type WebArchiveResource } from '../model/webarchive.ts'
import { describePlistDictProblem, narrowPlistDict, type PlistDict } from '../plist-dict.ts'

const BINARY_PLIST_MAGIC = 'bplist00'

function isBinaryPlist(bytes: Uint8Array): boolean {
	if (bytes.length < BINARY_PLIST_MAGIC.length) {
		return false
	}
	for (let i = 0; i < BINARY_PLIST_MAGIC.length; i++) {
		if (bytes[i] !== BINARY_PLIST_MAGIC.charCodeAt(i)) {
			return false
		}
	}
	return true
}

/**
 * Parses an XML plist with the underlying parser's redundant stderr output
 * suppressed.
 *
 * `plist`'s XML path reports a fatal parse error *twice*: once by writing
 * `[xmldom fatalError] ...` straight to `console.error`, and once by throwing
 * — and only the throw is load-bearing here, since {@link parseWebArchive}
 * catches it and turns it into a `malformed-archive` diagnostic. Without this
 * wrapper, feeding ArchiveBridge a malformed `.webarchive` would print vendor
 * noise to stderr *in addition to* the diagnostic the caller is already
 * handling, which contradicts the library's contract that malformed input is
 * reported through `Diagnostic` and nothing else.
 *
 * There is no supported way to configure that output away. `@xmldom/xmldom`
 * itself does accept an `onError` callback that captures the diagnostic
 * cleanly, but `plist`'s `parse()` constructs `new DOMParser()` with no
 * arguments and exposes no parser options, so the callback is unreachable
 * from `plist`'s public API. The alternatives were all worse: importing
 * `@xmldom/xmldom` directly would mean depending on a transitive dependency
 * as if it were our own (and then hand-walking the plist DOM ourselves),
 * adding a dependency for cosmetic stderr behavior fails CONTRIBUTING.md's
 * dependency policy, and forking `plist` is disproportionate.
 *
 * Mutating global `console.error` from library code is a real wart, accepted
 * here because the window is closed tightly rather than merely briefly:
 * `parsePlistXml` is fully synchronous and invokes no caller-supplied code,
 * so on a single-threaded runtime nothing else can reach `console.error`
 * between the two assignments, and the `finally` restores the original even
 * if parsing throws. It is deliberately scoped to this one call rather than
 * installed anywhere broader.
 *
 * **Delete this wrapper if `plist` ever forwards parser options** (an
 * `onError`/`errorHandler` passthrough to `DOMParser`) — at that point the
 * supported hook makes the suppression unnecessary.
 */
function parseXmlPlistQuietly(text: string): unknown {
	const originalConsoleError = console.error
	console.error = () => {}
	try {
		return parsePlistXml(text)
	} finally {
		console.error = originalConsoleError
	}
}

/** Parses `bytes` as either a binary or an XML plist, based on the `bplist00` magic. */
function parsePlistBytes(bytes: Uint8Array): unknown {
	if (isBinaryPlist(bytes)) {
		return parsePlistBinary(bytes)
	}
	const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
	return parseXmlPlistQuietly(text)
}

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function asBytes(value: unknown): Uint8Array | undefined {
	return value instanceof Uint8Array ? value : undefined
}

/** Collects every dictionary key not in `known` into an opaque, preserved map — see `WebArchiveResource.extra`/`WebArchiveDocument.extra`. */
function collectExtra(dict: PlistDict, known: ReadonlySet<string>): ReadonlyMap<string, PlistValue> {
	const extra = new Map<string, PlistValue>()
	for (const [key, value] of Object.entries(dict)) {
		if (!known.has(key)) {
			extra.set(key, value as PlistValue)
		}
	}
	return extra
}

/**
 * An optional string-valued resource field. Absence is normal and silent;
 * *presence with the wrong plist type* is a `malformed-resource` diagnostic
 * and then treated as absent. Silently reading a wrong-typed value as
 * `undefined` (what `asString` alone did) makes a real type error
 * indistinguishable from the field simply not being there — but it is also
 * not worth failing an otherwise-usable resource over an optional field, so
 * this diagnoses and recovers rather than dropping the resource.
 */
function optionalString(dict: PlistDict, key: string, url: string, diagnostics: Diagnostic[]): string | undefined {
	const value = dict[key]
	if (value === undefined) {
		return undefined
	}
	if (typeof value === 'string') {
		return value
	}
	diagnostics.push({ type: 'malformed-resource', url, message: `${key} is present but is not a string; treated as absent` })
	return undefined
}

/** The `Data`-valued counterpart of {@link optionalString}, with the same absent-vs-wrong-type distinction. */
function optionalBytes(dict: PlistDict, key: string, url: string, diagnostics: Diagnostic[]): Uint8Array | undefined {
	const value = dict[key]
	if (value === undefined) {
		return undefined
	}
	if (value instanceof Uint8Array) {
		return value
	}
	diagnostics.push({ type: 'malformed-resource', url, message: `${key} is present but is not plist data; treated as absent` })
	return undefined
}

/**
 * An optional array-valued document field (`WebSubresources`,
 * `WebSubframeArchives`). A present-but-not-an-array value is a
 * `malformed-archive` diagnostic and then treated as absent: the key names a
 * whole collection, so nothing about it can be salvaged, but the document
 * around it is still parseable and is kept. (`malformed-archive` is used
 * non-fatally here — the `Diagnostic` union describes *what* was wrong, not
 * how fatal it is; behavior decides that. See docs/architecture.md,
 * "Diagnostics and partial failure".)
 */
function optionalArray(dict: PlistDict, key: string, diagnostics: Diagnostic[]): readonly unknown[] {
	const value = dict[key]
	if (value === undefined) {
		return []
	}
	const array = asArray(value)
	if (array !== undefined) {
		return array
	}
	diagnostics.push({ type: 'malformed-archive', message: `${key} is present but is not an array; treated as absent` })
	return []
}

/** Parses a single `WebResource` dictionary (main or sub-) into a {@link WebArchiveResource}. */
function parseResource(value: unknown, diagnostics: Diagnostic[]): WebArchiveResource | undefined {
	const narrowed = narrowPlistDict(value)
	if (narrowed.kind === 'error') {
		diagnostics.push({ type: 'malformed-resource', message: `WebResource entry ${describePlistDictProblem(narrowed.problem)}` })
		return undefined
	}
	const dict = narrowed.dict

	const url = asString(dict.WebResourceURL)
	if (url === undefined) {
		diagnostics.push({ type: 'malformed-resource', message: 'WebResource entry is missing WebResourceURL' })
		return undefined
	}

	const mimeType = asString(dict.WebResourceMIMEType)
	if (mimeType === undefined) {
		diagnostics.push({ type: 'malformed-resource', url, message: 'WebResource entry is missing WebResourceMIMEType' })
		return undefined
	}

	const data = asBytes(dict.WebResourceData)
	if (data === undefined) {
		diagnostics.push({ type: 'malformed-resource', url, message: 'WebResource entry is missing WebResourceData' })
		return undefined
	}

	return {
		url,
		mimeType,
		data,
		textEncoding: optionalString(dict, 'WebResourceTextEncodingName', url, diagnostics),
		frameName: optionalString(dict, 'WebResourceFrameName', url, diagnostics),
		response: optionalBytes(dict, 'WebResourceResponse', url, diagnostics),
		extra: collectExtra(dict, RESERVED_RESOURCE_KEYS),
	}
}

/**
 * Flags duplicate `WebResourceURL` identities within one archive level
 * (the main resource plus its own direct subresources — sibling
 * subframes intentionally have their own, separate identity space: two
 * frames legitimately fetching the same URL independently is not a
 * duplicate). Nothing is dropped; see `mhtml/parse.ts`'s
 * `checkDuplicateIdentities` for the same lossless-diagnostic policy.
 */
function checkDuplicateContentLocations(mainResource: WebArchiveResource, subresources: readonly WebArchiveResource[], diagnostics: Diagnostic[]): void {
	const seen = new Set([mainResource.url])
	for (const resource of subresources) {
		if (seen.has(resource.url)) {
			diagnostics.push({ type: 'duplicate-content-location', url: resource.url })
		}
		seen.add(resource.url)
	}
}

/**
 * Parses one WebArchive dictionary (top-level or a `WebSubframeArchives`
 * entry) into a {@link WebArchiveDocument}, recursing into subframes up to
 * `MAX_FRAME_DEPTH` — see docs/architecture.md#security-assumptions.
 */
function parseDocument(value: unknown, depth: number, diagnostics: Diagnostic[]): WebArchiveDocument | undefined {
	if (depth > MAX_FRAME_DEPTH) {
		diagnostics.push({ type: 'frame-depth-exceeded', depth })
		return undefined
	}

	const narrowed = narrowPlistDict(value)
	if (narrowed.kind === 'error') {
		diagnostics.push({ type: 'malformed-archive', message: `WebArchive entry ${describePlistDictProblem(narrowed.problem)}` })
		return undefined
	}
	const dict = narrowed.dict

	if (dict.WebMainResource === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'WebArchive is missing WebMainResource' })
		return undefined
	}

	const mainResource = parseResource(dict.WebMainResource, diagnostics)
	if (mainResource === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'WebMainResource could not be parsed' })
		return undefined
	}

	const subresources: WebArchiveResource[] = []
	for (const entry of optionalArray(dict, 'WebSubresources', diagnostics)) {
		const resource = parseResource(entry, diagnostics)
		if (resource !== undefined) {
			subresources.push(resource)
		}
	}
	checkDuplicateContentLocations(mainResource, subresources, diagnostics)

	const subframeArchives: WebArchiveDocument[] = []
	for (const entry of optionalArray(dict, 'WebSubframeArchives', diagnostics)) {
		const subframe = parseDocument(entry, depth + 1, diagnostics)
		if (subframe !== undefined) {
			subframeArchives.push(subframe)
		}
	}

	return {
		mainResource,
		subresources,
		subframeArchives,
		extra: collectExtra(dict, RESERVED_DOCUMENT_KEYS),
	}
}

/**
 * Parses a Safari WebArchive byte stream into a {@link WebArchiveDocument}.
 * Prefers diagnostics over throwing, at whatever granularity still leaves a
 * meaningful result:
 *
 * - A malformed subresource, or an optional resource field present with the
 *   wrong plist type, is diagnosed (`malformed-resource`) and skipped/treated
 *   as absent; the containing resource and document survive.
 * - `WebSubresources`/`WebSubframeArchives` present but not an array is
 *   diagnosed (`malformed-archive`) and treated as absent; the document
 *   survives.
 * - An unusable nested `WebSubframeArchives` entry is dropped — only that
 *   subframe, not its parent, which is still returned with its remaining
 *   subframes.
 * - Only an unparseable plist, or a missing/unusable **top-level**
 *   `WebMainResource`, leaves nothing to return: reported as
 *   `malformed-archive` with `document: undefined`.
 */
export function parseWebArchive(bytes: Uint8Array): WebArchiveParseResult {
	const diagnostics: Diagnostic[] = []

	let plist: unknown
	try {
		plist = parsePlistBytes(bytes)
	} catch (error) {
		diagnostics.push({
			type: 'malformed-archive',
			message: `failed to parse property list: ${error instanceof Error ? error.message : String(error)}`,
		})
		return { document: undefined, diagnostics }
	}

	const document = parseDocument(plist, 0, diagnostics)

	return { document, diagnostics }
}
