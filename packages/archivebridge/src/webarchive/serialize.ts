/**
 * Minimal Safari WebArchive serializer. Produces a binary plist (`bplist00`)
 * with the same top-level shape `parseWebArchive` reads: `WebMainResource`
 * plus a `WebSubresources` array, both resource dictionaries carrying
 * `WebResourceURL`, `WebResourceMIMEType`, `WebResourceData`, and an optional
 * `WebResourceTextEncodingName`. Binary plist is what Safari itself writes;
 * building it is delegated to the `plist` package for the same reason
 * parsing is — see `webarchive/parse.ts` and CONTRIBUTING.md's dependency policy.
 *
 * Scope for this initial implementation: `archive.frames` must be empty,
 * matching `parseWebArchive`, which does not populate `WebSubframeArchives`
 * yet either. `WebResourceResponse` (Safari's NSKeyedArchiver-serialized
 * `NSURLResponse`) is never written — nothing in the `Archive` model carries
 * the information it would need, and `parseWebArchive` never reads it.
 */

import { buildBinary, type PlistValue } from 'plist'
import type { Archive, Resource } from '../model/archive.ts'

function serializeResource(resource: Resource): Record<string, PlistValue> {
	return {
		WebResourceURL: resource.url,
		WebResourceMIMEType: resource.mimeType,
		WebResourceData: resource.data,
		...(resource.textEncoding !== undefined ? { WebResourceTextEncodingName: resource.textEncoding } : {}),
	}
}

/**
 * Serializes an {@link Archive} into a Safari WebArchive binary plist.
 *
 * Throws if `archive.frames` is non-empty; see the module doc comment.
 */
export function serializeWebArchive(archive: Archive): Uint8Array {
	if (archive.frames.length > 0) {
		throw new Error('serializeWebArchive does not support archives with frames yet')
	}

	const plist: PlistValue = {
		WebMainResource: serializeResource(archive.mainResource),
		WebSubresources: [...archive.resources.values()].map(serializeResource),
	}

	return buildBinary(plist)
}
