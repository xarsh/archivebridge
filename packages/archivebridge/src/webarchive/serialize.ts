/**
 * Minimal Safari WebArchive serializer. Produces a binary plist (`bplist00`)
 * with the same shape `parseWebArchive` reads: `WebMainResource` plus
 * optional `WebSubresources`/`WebSubframeArchives` collections, with resource
 * dictionaries carrying `WebResourceURL`, `WebResourceMIMEType`,
 * `WebResourceData`, and the optional `WebResourceTextEncodingName`/
 * `WebResourceFrameName`/`WebResourceResponse`/`extra` fields. Building the
 * plist is delegated to the `plist` package for the same reason parsing is —
 * see `webarchive/parse.ts` and CONTRIBUTING.md's dependency policy.
 *
 * Both collection keys are omitted entirely when empty rather than written as
 * an empty array, because that is what real WebKit output does: the root
 * dictionary of fixtures/webarchive/example-com.safari.webarchive carries only
 * `WebMainResource`, and so does the leaf frame of
 * fixtures/webarchive/frames-nested.safari.webarchive. `parseWebArchive`
 * treats an absent collection and an empty one identically, so this is a
 * shape-fidelity choice, not a semantic one.
 *
 * `extra` holds *unknown* plist keys only (see `model/webarchive.ts`), so a
 * reserved key inside it is an invalid constructed model and makes
 * serialization throw. Two ways of resolving such a collision silently were
 * both rejected: spreading `extra` last lets it overwrite a typed field, e.g.
 * an `extra` entry for `WebResourceURL` displacing `resource.url` — and since
 * a foreign metadata sidecar can supply `resourceExtra`/`documentExtra`, that
 * would be reachable from untrusted input through MHTML -> WebArchive
 * conversion. Spreading it first, so the typed field always wins, is no
 * better: it silently discards metadata the sidecar claimed would be
 * preserved. A collision has no correct resolution, so it is reported rather
 * than resolved.
 */

import { buildBinary, type PlistValue } from 'plist'
import { findReservedExtraKey, RESERVED_DOCUMENT_KEYS, RESERVED_RESOURCE_KEYS, type WebArchiveDocument, type WebArchiveResource } from '../model/webarchive.ts'

function serializeResource(resource: WebArchiveResource): Record<string, PlistValue> {
	const reserved = findReservedExtraKey(resource.extra, RESERVED_RESOURCE_KEYS)
	if (reserved !== undefined) {
		throw new Error(`serializeWebArchive cannot serialize a resource whose extra claims the reserved key ${JSON.stringify(reserved)} (WebResource ${JSON.stringify(resource.url)})`)
	}

	// `extra` is spread first purely as defense in depth: the check above already
	// guarantees it cannot collide, and this way a typed field could never be
	// displaced even if it somehow did. Key order in the emitted plist is not
	// semantic (docs/architecture.md, "Semantic losslessness").
	return {
		...Object.fromEntries(resource.extra),
		WebResourceURL: resource.url,
		WebResourceMIMEType: resource.mimeType,
		WebResourceData: resource.data,
		...(resource.textEncoding !== undefined ? { WebResourceTextEncodingName: resource.textEncoding } : {}),
		...(resource.frameName !== undefined ? { WebResourceFrameName: resource.frameName } : {}),
		...(resource.response !== undefined ? { WebResourceResponse: resource.response } : {}),
	}
}

function serializeDocument(document: WebArchiveDocument): Record<string, PlistValue> {
	const reserved = findReservedExtraKey(document.extra, RESERVED_DOCUMENT_KEYS)
	if (reserved !== undefined) {
		throw new Error(`serializeWebArchive cannot serialize a document whose extra claims the reserved key ${JSON.stringify(reserved)}`)
	}

	return {
		...Object.fromEntries(document.extra),
		WebMainResource: serializeResource(document.mainResource),
		...(document.subresources.length > 0 ? { WebSubresources: document.subresources.map(serializeResource) } : {}),
		...(document.subframeArchives.length > 0 ? { WebSubframeArchives: document.subframeArchives.map(serializeDocument) } : {}),
	}
}

/** Serializes a {@link WebArchiveDocument} into a Safari WebArchive binary plist. */
export function serializeWebArchive(document: WebArchiveDocument): Uint8Array {
	return buildBinary(serializeDocument(document))
}
