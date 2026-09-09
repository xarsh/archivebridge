/**
 * The metadata sidecar: an optional MIME part ArchiveBridge-authored MHTML
 * may carry to preserve WebArchive-only fields (`WebResourceResponse`,
 * `WebResourceFrameName`, and any unrecognized/future WebArchive plist key)
 * that standard MHTML has no field for. See docs/architecture.md,
 * "Metadata sidecar".
 *
 * Format: a binary plist (`bplist00`), matching what `mhtml/parse.ts`/
 * `mhtml/serialize.ts` already base64-encode/decode for every other part.
 * Content-Type: `application/vnd.archivebridge.metadata` (an
 * ArchiveBridge-defined vendor-tree media type, not currently registered
 * with IANA). Discovery is by each part's *parsed* Content-Type — which, by
 * the time an `MhtmlPart` exists, is already `mhtml/parse.ts`'s lowercased
 * `type` (params like `charset` stripped, matching handled separately via
 * `textEncoding`) — never a raw header string comparison, and case-
 * insensitive per RFC 2045 §5.1 since the parser already lowercases it.
 *
 * The sidecar is auxiliary archive metadata, not a saved-page resource: it
 * must never be treated as an ordinary resource by `inspect` or
 * frame-reference resolution (see docs/architecture.md's "The sidecar is
 * auxiliary archive metadata, not a saved-page resource").
 *
 * Being ArchiveBridge-owned does not make a sidecar trusted: it arrives
 * inside an MHTML file like everything else, so its plist dictionaries are
 * narrowed through `plist-dict.ts` before any field is read, exactly as
 * `webarchive/parse.ts` narrows a `.webarchive`'s. A dictionary that fails
 * that narrowing takes the same whole-sidecar rejection path as any other
 * shape violation.
 */

import { buildBinary, type PlistValue, parseBinary } from 'plist'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { findReservedExtraKey, RESERVED_DOCUMENT_KEYS, RESERVED_RESOURCE_KEYS } from '../model/webarchive.ts'
import { asPlistDict } from '../plist-dict.ts'

export const SIDECAR_MEDIA_TYPE = 'application/vnd.archivebridge.metadata'
const SCHEMA_VERSION = 1

/** Media type comparison is case-insensitive per MIME's own rule (RFC 2045 §5.1) — a hand-constructed `MhtmlDocument` (not necessarily produced by `mhtml/parse.ts`, which already lowercases) may carry `Content-Type`s in any case. */
function isSidecarMediaType(mimeType: string): boolean {
	return mimeType.toLowerCase() === SIDECAR_MEDIA_TYPE
}

/** Every part index in `document` whose media type matches the sidecar media type, regardless of count or validity — unlike {@link findSidecarPart}, which only returns something in the exactly-one-match case. Used to keep every sidecar-shaped part (valid, malformed, or duplicate) out of ordinary resource/frame grouping: see docs/architecture.md, "The sidecar is auxiliary archive metadata, not a saved-page resource". */
export function findSidecarPartIndices(document: MhtmlDocument): readonly number[] {
	const indices: number[] = []
	document.parts.forEach((part, index) => {
		if (isSidecarMediaType(part.mimeType)) {
			indices.push(index)
		}
	})
	return indices
}

/** Residual WebArchive-only fields for one MHTML part (keyed by that part's Content-ID in {@link SidecarData}). */
export interface SidecarResourceEntry {
	readonly webResourceResponse: Uint8Array | undefined
	/** Only ever observed on frame-root resources in real WebKit output, but not restricted to them here: whatever value was actually present on the source `WebArchiveResource` is stored and round-tripped verbatim, regardless of which role that Content-ID's part later resolves to. */
	readonly webResourceFrameName: string | undefined
	/** `WebArchiveResource.extra` for this resource, if non-empty. */
	readonly resourceExtra: ReadonlyMap<string, PlistValue> | undefined
	/** `WebArchiveDocument.extra`, only when this Content-ID is a frame-root part, if non-empty. */
	readonly documentExtra: ReadonlyMap<string, PlistValue> | undefined
}

/** The sidecar's content: residual fields keyed by the normalized Content-ID of the MHTML part they describe. */
export type SidecarData = ReadonlyMap<string, SidecarResourceEntry>

function asPlistDictMap(value: unknown): ReadonlyMap<string, PlistValue> | undefined {
	const dict = asPlistDict(value)
	if (dict === undefined) {
		return undefined
	}
	const entries = Object.entries(dict) as [string, PlistValue][]
	return entries.length > 0 ? new Map(entries) : undefined
}

/**
 * Locates the metadata sidecar part in `document`, if any. Per
 * docs/architecture.md's "Cardinality": zero is the common case (no
 * residual metadata), one is parsed, and two-or-more is ambiguous input —
 * reported as `duplicate-metadata-sidecar` rather than merged, since which
 * one should "win" has no principled answer.
 */
export function findSidecarPart(document: MhtmlDocument, diagnostics: Diagnostic[]): { readonly part: MhtmlPart; readonly index: number } | undefined {
	const matches: { part: MhtmlPart; index: number }[] = []
	document.parts.forEach((part, index) => {
		if (isSidecarMediaType(part.mimeType)) {
			matches.push({ part, index })
		}
	})

	if (matches.length === 0) {
		return undefined
	}
	if (matches.length > 1) {
		diagnostics.push({ type: 'duplicate-metadata-sidecar', count: matches.length })
		return undefined
	}
	return matches[0]
}

/**
 * Parses a metadata sidecar part's binary plist body into {@link SidecarData}.
 * A sidecar that fails to parse, or doesn't have the expected shape, is
 * reported as `malformed-metadata-sidecar` and treated as absent — an
 * optional, auxiliary part being broken must never hard-fail the
 * surrounding document (docs/architecture.md, "Malformed sidecar").
 */
export function parseSidecarPart(part: MhtmlPart, diagnostics: Diagnostic[]): SidecarData | undefined {
	let plist: unknown
	try {
		plist = parseBinary(part.data)
	} catch (error) {
		diagnostics.push({ type: 'malformed-metadata-sidecar', message: `failed to parse property list: ${error instanceof Error ? error.message : String(error)}` })
		return undefined
	}

	const root = asPlistDict(plist)
	if (root === undefined) {
		diagnostics.push({ type: 'malformed-metadata-sidecar', message: 'metadata sidecar is not a dictionary' })
		return undefined
	}

	const version = root.ArchiveBridgeSchemaVersion
	if (version !== SCHEMA_VERSION) {
		diagnostics.push({
			type: 'malformed-metadata-sidecar',
			message:
				version === undefined
					? 'metadata sidecar is missing ArchiveBridgeSchemaVersion'
					: `metadata sidecar has unsupported ArchiveBridgeSchemaVersion ${JSON.stringify(version)} (supported: ${SCHEMA_VERSION})`,
		})
		return undefined
	}

	const resourcesDict = asPlistDict(root.resources)
	if (resourcesDict === undefined) {
		diagnostics.push({ type: 'malformed-metadata-sidecar', message: 'metadata sidecar is not a dictionary with a "resources" dictionary' })
		return undefined
	}

	const entries = new Map<string, SidecarResourceEntry>()
	for (const [contentId, value] of Object.entries(resourcesDict)) {
		const entry = validateSidecarResourceEntry(value)
		if (entry === undefined) {
			// Whole-sidecar rejection, not per-entry silent recovery: the sidecar is
			// ArchiveBridge-owned, small, versioned metadata, so a malformed entry means the
			// sidecar as a whole doesn't match the schema this version promises — partially
			// trusting the entries that do happen to look right risks silently reconstructing
			// incomplete metadata rather than surfacing that something is actually wrong.
			diagnostics.push({ type: 'malformed-metadata-sidecar', message: `metadata sidecar resource entry ${JSON.stringify(contentId)} has an invalid shape` })
			return undefined
		}
		entries.set(contentId, entry)
	}
	return entries
}

/**
 * Validates one `resources` dictionary entry against the sidecar schema.
 * Returns `undefined` for any shape violation: not a dictionary at all, a
 * known field present with the wrong plist value type — never silently
 * substituting `undefined` for a present-but-wrong-typed field (which would
 * be indistinguishable from that field having simply been absent) — or a
 * `resourceExtra`/`documentExtra` claiming a key that `WebArchiveResource`/
 * `WebArchiveDocument` already own as a typed field.
 *
 * That last check is what keeps the sidecar from being a route into
 * `webarchive/serialize.ts`'s reserved-key rejection: `extra` is defined as
 * the *unknown* plist keys only (see `model/webarchive.ts`), so a sidecar
 * supplying e.g. `resourceExtra: { WebResourceURL: ... }` is malformed
 * ArchiveBridge-owned metadata, not data to carry forward and discover is
 * unserializable later. Rejecting it here means the surrounding MHTML
 * conversion still succeeds with no residual metadata (the same
 * whole-sidecar-rejection policy every other shape violation gets), rather
 * than producing a `WebArchiveDocument` that throws on serialization.
 */
function validateSidecarResourceEntry(value: unknown): SidecarResourceEntry | undefined {
	const dict = asPlistDict(value)
	if (dict === undefined) {
		return undefined
	}
	if (dict.webResourceResponse !== undefined && !(dict.webResourceResponse instanceof Uint8Array)) {
		return undefined
	}
	if (dict.webResourceFrameName !== undefined && typeof dict.webResourceFrameName !== 'string') {
		return undefined
	}
	if (dict.resourceExtra !== undefined && asPlistDict(dict.resourceExtra) === undefined) {
		return undefined
	}
	if (dict.documentExtra !== undefined && asPlistDict(dict.documentExtra) === undefined) {
		return undefined
	}

	const resourceExtra = asPlistDictMap(dict.resourceExtra)
	const documentExtra = asPlistDictMap(dict.documentExtra)
	if (resourceExtra !== undefined && findReservedExtraKey(resourceExtra, RESERVED_RESOURCE_KEYS) !== undefined) {
		return undefined
	}
	if (documentExtra !== undefined && findReservedExtraKey(documentExtra, RESERVED_DOCUMENT_KEYS) !== undefined) {
		return undefined
	}

	return {
		webResourceResponse: dict.webResourceResponse as Uint8Array | undefined,
		webResourceFrameName: dict.webResourceFrameName as string | undefined,
		resourceExtra,
		documentExtra,
	}
}

/**
 * Builds a metadata sidecar `MhtmlPart` from `entries`. `contentId` and
 * `location` are left unset: `serializeMhtml` assigns every part a
 * Content-ID (existing or generated) regardless, and the sidecar has no
 * natural Content-Location (docs/architecture.md, `MhtmlPart.location`).
 *
 * Throws for an entry whose `resourceExtra`/`documentExtra` claims a reserved
 * WebArchive key — the writing-side mirror of {@link parseSidecarPart}'s
 * identical check. Without it, a hand-constructed `WebArchiveDocument` whose
 * `extra` violates the "unknown keys only" contract (see
 * `model/webarchive.ts`) would flow through `convertWebArchiveToMhtml` into a
 * sidecar that this module's own reader then classifies as
 * `malformed-metadata-sidecar` — and since that rejection is whole-sidecar,
 * *every* resource's residual metadata would silently vanish on the way back.
 * Enforcing it where the bytes are actually written makes "ArchiveBridge never
 * emits a sidecar it would itself reject" true by construction, rather than
 * depending on each caller to check first.
 */
export function buildSidecarPart(entries: SidecarData): MhtmlPart {
	const resources: Record<string, PlistValue> = {}
	for (const [contentId, entry] of entries) {
		const dict: Record<string, PlistValue> = {}
		if (entry.webResourceResponse !== undefined) {
			dict.webResourceResponse = entry.webResourceResponse
		}
		if (entry.webResourceFrameName !== undefined) {
			dict.webResourceFrameName = entry.webResourceFrameName
		}
		if (entry.resourceExtra !== undefined && entry.resourceExtra.size > 0) {
			const reserved = findReservedExtraKey(entry.resourceExtra, RESERVED_RESOURCE_KEYS)
			if (reserved !== undefined) {
				throw new Error(
					`buildSidecarPart cannot write a resourceExtra that claims the reserved WebArchive key ${JSON.stringify(reserved)} (Content-ID ${JSON.stringify(contentId)})`,
				)
			}
			dict.resourceExtra = Object.fromEntries(entry.resourceExtra)
		}
		if (entry.documentExtra !== undefined && entry.documentExtra.size > 0) {
			const reserved = findReservedExtraKey(entry.documentExtra, RESERVED_DOCUMENT_KEYS)
			if (reserved !== undefined) {
				throw new Error(
					`buildSidecarPart cannot write a documentExtra that claims the reserved WebArchive key ${JSON.stringify(reserved)} (Content-ID ${JSON.stringify(contentId)})`,
				)
			}
			dict.documentExtra = Object.fromEntries(entry.documentExtra)
		}
		resources[contentId] = dict
	}

	const plistDict: PlistValue = { ArchiveBridgeSchemaVersion: SCHEMA_VERSION, resources }

	return {
		contentId: undefined,
		location: undefined,
		mimeType: SIDECAR_MEDIA_TYPE,
		textEncoding: undefined,
		data: buildBinary(plistDict),
	}
}
