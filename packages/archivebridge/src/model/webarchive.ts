/**
 * WebArchive-native representation. Unlike MHTML, a real `.webarchive`
 * plist *is* naturally a recursive tree (`WebSubframeArchives` is an array
 * of full nested WebArchive dictionaries) — mirroring that shape here is a
 * format-native structure looking like its format, not the mistake the
 * removed cross-format `Archive`/`frames` model made. See
 * docs/architecture.md, "WebArchive-native representation".
 */

import type { PlistValue } from 'plist'
import type { Diagnostic } from './archive.ts'

/** A single `WebResource` dictionary (main or sub-) within a WebArchive plist. */
export interface WebArchiveResource {
	readonly url: string
	readonly mimeType: string
	readonly data: Uint8Array
	readonly textEncoding: string | undefined
	/**
	 * WebResourceFrameName. Present on frame-root resources; WebKit
	 * synthesizes a `<!--frameN-->` placeholder when no HTML `name`
	 * attribute was set, numbered sequentially across the whole document.
	 */
	readonly frameName: string | undefined
	/**
	 * WebResourceResponse: an opaque NSKeyedArchiver-serialized
	 * NSURLResponse blob. Observed only on subresources, never on any
	 * WebMainResource at any depth. Never interpreted, only preserved.
	 */
	readonly response: Uint8Array | undefined
	/**
	 * Any other plist key on this resource dictionary that isn't one of the
	 * fields above, preserved opaquely and unparsed.
	 */
	readonly extra: ReadonlyMap<string, PlistValue>
}

/** A parsed or constructed WebArchive document (top-level, or a nested `WebSubframeArchives` entry). */
export interface WebArchiveDocument {
	readonly mainResource: WebArchiveResource
	readonly subresources: readonly WebArchiveResource[]
	readonly subframeArchives: readonly WebArchiveDocument[]
	/**
	 * Any plist key on this *document* dictionary itself (sibling to
	 * `WebMainResource`/`WebSubresources`/`WebSubframeArchives`) that isn't
	 * one of those three. Empty for every real fixture observed so far, but
	 * preserved so a future undocumented document-level key isn't silently
	 * dropped.
	 */
	readonly extra: ReadonlyMap<string, PlistValue>
}

/**
 * The plist keys on a resource dictionary that {@link WebArchiveResource}'s
 * typed fields already own. They are *reserved*: `extra` is defined as the
 * unknown keys only, so a reserved key appearing inside it is a contradiction
 * — one dictionary key with two competing sources of truth.
 *
 * One definition, used by everything that has to agree on it: the parser
 * (which subtracts these when collecting `extra`), the serializer (which
 * rejects a model whose `extra` claims one), and the metadata sidecar (which
 * rejects sidecar-supplied `resourceExtra` claiming one, before it can become
 * a `WebArchiveResource` at all).
 */
export const RESERVED_RESOURCE_KEYS: ReadonlySet<string> = new Set([
	'WebResourceURL',
	'WebResourceMIMEType',
	'WebResourceData',
	'WebResourceTextEncodingName',
	'WebResourceResponse',
	'WebResourceFrameName',
])

/** The document-dictionary equivalent of {@link RESERVED_RESOURCE_KEYS}, for {@link WebArchiveDocument}'s typed fields. */
export const RESERVED_DOCUMENT_KEYS: ReadonlySet<string> = new Set(['WebMainResource', 'WebSubresources', 'WebSubframeArchives'])

/** The reserved key `extra` claims, if any — the check {@link RESERVED_RESOURCE_KEYS}/{@link RESERVED_DOCUMENT_KEYS} exist for. */
export function findReservedExtraKey(extra: ReadonlyMap<string, unknown>, reserved: ReadonlySet<string>): string | undefined {
	for (const key of extra.keys()) {
		if (reserved.has(key)) {
			return key
		}
	}
	return undefined
}

/** Result of parsing WebArchive bytes: a possibly-absent document plus whatever diagnostics were collected. */
export interface WebArchiveParseResult {
	readonly document: WebArchiveDocument | undefined
	readonly diagnostics: readonly Diagnostic[]
}
