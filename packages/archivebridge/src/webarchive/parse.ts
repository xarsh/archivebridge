/**
 * Minimal Safari WebArchive parser (Apple property list, binary `bplist00`
 * or XML). A `.webarchive` file is a single top-level plist dictionary:
 *
 * - `WebMainResource` — a resource dictionary (see below) for the top-level
 *   document.
 * - `WebSubresources` — an optional array of resource dictionaries for
 *   everything else the page referenced (stylesheets, scripts, images, ...).
 * - `WebSubframeArchives` — an optional array of nested WebArchive
 *   dictionaries for iframes/framesets saved as their own sub-documents.
 *
 * A resource dictionary carries `WebResourceURL`, `WebResourceMIMEType`,
 * `WebResourceData` (raw bytes, already base64-decoded by the plist
 * parser), and optionally `WebResourceTextEncodingName`. Safari also writes
 * `WebResourceResponse` (an NSKeyedArchiver-serialized `NSURLResponse`, itself
 * a nested binary plist) and, on the main resource, `WebResourceFrameName`;
 * neither carries information this library's `Archive` model needs, so both
 * are read but otherwise ignored.
 *
 * Scope for this initial implementation: `WebMainResource` and
 * `WebSubresources` only. `WebSubframeArchives` is not handled yet, so every
 * archive parses with `frames: []` — the same starting point as `parseMhtml`.
 * See docs/architecture.md for the target `Archive` model this feeds into
 * and the diagnostics contract.
 *
 * Plist parsing itself (both the binary `bplist00` format and XML) is
 * delegated to the `plist` package rather than hand-rolled: binary plists in
 * particular are a non-trivial format (an offset table, variable-width
 * integers, object references) that this project's untrusted-input security
 * assumptions call for a battle-tested implementation rather than a
 * hand-written one. See CONTRIBUTING.md's dependency policy.
 */

import { parseBinary as parsePlistBinary, parse as parsePlistXml } from 'plist'
import type { Archive, Diagnostic, ParseResult, Resource } from '../model/archive.ts'

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
 * `plist`'s XML parser (`@xmldom/xmldom`) reports fatal parse errors by
 * writing straight to `console.error`, with no option to opt out short of
 * forking the dependency. The error still surfaces normally via the thrown
 * exception (caught by {@link parseWebArchive} and turned into a
 * `malformed-archive` diagnostic); this only suppresses the vendor's
 * redundant console output for the duration of that one synchronous call, so
 * malformed input produces a diagnostic and nothing else on stderr.
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

function asDict(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array || value instanceof Date) {
		return undefined
	}
	return value as Record<string, unknown>
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

/** Parses a single `WebResource` dictionary (main or sub-) into a {@link Resource}. */
function parseResource(value: unknown, diagnostics: Diagnostic[]): Resource | undefined {
	const dict = asDict(value)
	if (dict === undefined) {
		diagnostics.push({ type: 'malformed-resource', message: 'WebResource entry is not a dictionary' })
		return undefined
	}

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

	const textEncoding = asString(dict.WebResourceTextEncodingName)

	return {
		url,
		mimeType,
		data,
		...(textEncoding !== undefined ? { textEncoding } : {}),
	}
}

/**
 * Parses a Safari WebArchive byte stream into an {@link Archive}. Prefers
 * diagnostics over throwing: a malformed subresource is dropped with a
 * `malformed-resource` diagnostic rather than failing the whole archive, but
 * an unparseable plist or a missing/unusable `WebMainResource` has no
 * reasonable partial result and is reported as `malformed-archive` with
 * `archive: undefined`.
 */
export function parseWebArchive(bytes: Uint8Array): ParseResult {
	const diagnostics: Diagnostic[] = []

	let plist: unknown
	try {
		plist = parsePlistBytes(bytes)
	} catch (error) {
		diagnostics.push({
			type: 'malformed-archive',
			message: `failed to parse property list: ${error instanceof Error ? error.message : String(error)}`,
		})
		return { archive: undefined, diagnostics }
	}

	const root = asDict(plist)
	if (root === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'top-level property list is not a dictionary' })
		return { archive: undefined, diagnostics }
	}

	if (root.WebMainResource === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'WebArchive is missing WebMainResource' })
		return { archive: undefined, diagnostics }
	}

	const mainResource = parseResource(root.WebMainResource, diagnostics)
	if (mainResource === undefined) {
		diagnostics.push({ type: 'malformed-archive', message: 'WebMainResource could not be parsed' })
		return { archive: undefined, diagnostics }
	}

	// `resources` holds only subresources; the main resource is not duplicated into it.
	// See docs/architecture.md on why it must not appear in both places.
	const resources = new Map<string, Resource>()

	const subresources = asArray(root.WebSubresources) ?? []
	for (const entry of subresources) {
		const resource = parseResource(entry, diagnostics)
		if (resource === undefined) {
			continue
		}
		if (resource.url === mainResource.url || resources.has(resource.url)) {
			diagnostics.push({ type: 'duplicate-resource-url', url: resource.url })
			continue
		}
		resources.set(resource.url, resource)
	}

	const archive: Archive = {
		mainUrl: mainResource.url,
		mainResource,
		resources,
		frames: [],
	}

	return { archive, diagnostics }
}
