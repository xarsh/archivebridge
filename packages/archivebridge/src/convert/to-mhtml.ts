/**
 * WebArchive -> MHTML: flattens a recursive `WebArchiveDocument` tree into
 * one flat `MhtmlDocument` (main + subresources + every subframe's main +
 * its subresources, all as sibling parts), rewriting each parent frame's
 * `<iframe src>` from its resolved URL to `cid:<child-content-id>`, and
 * writing a metadata sidecar part for any residual WebArchive-only fields
 * (`WebResourceResponse`, `WebResourceFrameName`, unrecognized plist keys).
 * See docs/architecture.md, "Frame representation" and "Direct WebArchive
 * <-> MHTML conversion".
 *
 * Every emitted part gets a freshly generated Content-ID: unlike parsing a
 * document that may already have preserved IDs, here every resource is new
 * to this MHTML document, so there is nothing to preserve (see
 * docs/architecture.md, "Content-ID: preservation, generation, and
 * identity").
 *
 * Emission order (main, then its own subresources, then each subframe
 * depth-first) is not mandated by any spec — MHTML has no structural
 * concept of frame ownership at all (docs/architecture.md, "Frame
 * representation") — but this grouping is what makes
 * `convertMhtmlToWebArchive`'s "nearest preceding frame-root" reconstruction
 * heuristic recover the original tree exactly for ArchiveBridge's own
 * output, which is the primary round-trip this converter is responsible for.
 */

import type { PlistValue } from 'plist'
import { MAX_FRAME_DEPTH } from '../limits.ts'
import { encodeCidUri } from '../mhtml/frames.ts'
import { findFrameSrcLocations, resolveDocumentBaseUrl, rewriteFrameSrcAttributes } from '../mhtml/html-rewrite.ts'
import { buildSidecarPart, type SidecarResourceEntry } from '../mhtml/sidecar.ts'
import { isSafelyReencodable, textCodecFor } from '../mhtml/text-codec.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'

function generateContentId(): string {
	return `part-${crypto.randomUUID()}@archivebridge`
}

function resolveUrl(value: string, base: string): string | undefined {
	try {
		return new URL(value, base).href
	} catch {
		return undefined
	}
}

function isHtml(mimeType: string): boolean {
	return mimeType.toLowerCase() === 'text/html'
}

function sidecarEntryFor(resource: WebArchiveResource, documentExtra: ReadonlyMap<string, PlistValue> | undefined): SidecarResourceEntry | undefined {
	const resourceExtra = resource.extra.size > 0 ? resource.extra : undefined
	const needed = resource.response !== undefined || resource.frameName !== undefined || resourceExtra !== undefined || (documentExtra !== undefined && documentExtra.size > 0)
	if (!needed) {
		return undefined
	}
	return {
		webResourceResponse: resource.response,
		webResourceFrameName: resource.frameName,
		resourceExtra,
		documentExtra: documentExtra !== undefined && documentExtra.size > 0 ? documentExtra : undefined,
	}
}

function subresourcePart(resource: WebArchiveResource): { readonly part: MhtmlPart; readonly contentId: string } {
	const contentId = generateContentId()
	return { contentId, part: { contentId, location: resource.url, mimeType: resource.mimeType, textEncoding: resource.textEncoding, data: resource.data } }
}

interface FlattenResult {
	readonly parts: readonly MhtmlPart[]
	readonly rootContentId: string
}

interface ChildFrame {
	readonly document: WebArchiveDocument
	readonly contentId: string
}

/**
 * Builds a URL -> queue-of-unconsumed-children index so sibling frames that
 * share the same resolved URL (a real, if unusual, possibility — two
 * `<iframe>`s pointing at the same page) are matched one-to-one with the
 * captured `subframeArchives` entries at the same URL, in document order,
 * rather than every occurrence collapsing onto whichever child a naive
 * `Array.find` happens to return first. See docs/architecture.md, "Frame
 * representation": distinct captured subframes are distinct MIME entities
 * even when they share a URL, and must not lose that identity here.
 */
function buildChildQueuesByUrl(children: readonly ChildFrame[]): Map<string, ChildFrame[]> {
	const queues = new Map<string, ChildFrame[]>()
	for (const child of children) {
		const queue = queues.get(child.document.mainResource.url)
		if (queue === undefined) {
			queues.set(child.document.mainResource.url, [child])
		} else {
			queue.push(child)
		}
	}
	return queues
}

function flattenDocument(document: WebArchiveDocument, depth: number, diagnostics: Diagnostic[], sidecarEntries: Map<string, SidecarResourceEntry>): FlattenResult {
	const mainContentId = generateContentId()

	const subresourceParts: MhtmlPart[] = []
	for (const resource of document.subresources) {
		const { part, contentId } = subresourcePart(resource)
		subresourceParts.push(part)
		const entry = sidecarEntryFor(resource, undefined)
		if (entry !== undefined) {
			sidecarEntries.set(contentId, entry)
		}
	}

	const children: ChildFrame[] = []
	const childParts: MhtmlPart[] = []
	if (document.subframeArchives.length > 0) {
		if (depth >= MAX_FRAME_DEPTH) {
			diagnostics.push({ type: 'frame-depth-exceeded', depth: depth + 1 })
		} else {
			for (const child of document.subframeArchives) {
				const result = flattenDocument(child, depth + 1, diagnostics, sidecarEntries)
				children.push({ document: child, contentId: result.rootContentId })
				childParts.push(...result.parts)
			}
		}
	}

	let mainData = document.mainResource.data
	const mainTextEncoding = document.mainResource.textEncoding
	const childQueuesByUrl = buildChildQueuesByUrl(children)
	if (isHtml(document.mainResource.mimeType)) {
		const codec = textCodecFor(document.mainResource.textEncoding)
		const originalHtml = codec.decode(document.mainResource.data)
		const hasFrameSrc = findFrameSrcLocations(originalHtml).length > 0
		if (hasFrameSrc && !isSafelyReencodable(codec, document.mainResource.data)) {
			// This resource's original bytes cannot be safely round-tripped through its own
			// declared encoding (e.g. a stripped BOM, or a malformed byte sequence tolerantly
			// decoded to U+FFFD) — rewriting even just the frame-src attribute would require
			// re-encoding the *whole* document, silently normalizing bytes the edit never
			// touched. Refuse the rewrite entirely (every captured child stays unmatched, and is
			// reported as `unconsumed-child-frame` below) rather than partially applying it.
			diagnostics.push({ type: 'unsupported-encoding', encoding: document.mainResource.textEncoding ?? 'utf-8' })
		} else if (hasFrameSrc) {
			const baseUrl = resolveDocumentBaseUrl(originalHtml, document.mainResource.url)
			const rewrittenHtml = rewriteFrameSrcAttributes(originalHtml, (currentValue) => {
				const resolved = resolveUrl(currentValue, baseUrl)
				const queue = resolved === undefined ? undefined : childQueuesByUrl.get(resolved)
				const match = queue?.shift()
				if (match === undefined) {
					diagnostics.push({ type: 'unresolved-resource', url: resolved ?? currentValue })
					return undefined
				}
				return encodeCidUri(match.contentId)
			})
			if (rewrittenHtml !== originalHtml) {
				const encoded = codec.encode(rewrittenHtml)
				if (encoded !== undefined) {
					mainData = encoded
				} else {
					diagnostics.push({ type: 'unsupported-encoding', encoding: document.mainResource.textEncoding ?? 'utf-8' })
				}
			}
		}
	}

	// Any captured child frame whose queue entry was never `shift()`-ed off above — because the
	// main resource wasn't HTML, had no frame-src at all, couldn't be safely rewritten, or simply
	// had fewer matching `<iframe>`/`<frame>` elements than captured same-URL siblings — is a
	// `WebSubframeArchives` entry with no source-HTML frame reference pointing at it. Its resource
	// data is still flattened into `childParts` above (nothing is dropped), just with no `cid:`
	// link from this document's HTML to it.
	for (const queue of childQueuesByUrl.values()) {
		for (const unconsumed of queue) {
			diagnostics.push({ type: 'unconsumed-child-frame', url: unconsumed.document.mainResource.url })
		}
	}

	const mainPart: MhtmlPart = {
		contentId: mainContentId,
		location: document.mainResource.url,
		mimeType: document.mainResource.mimeType,
		textEncoding: mainTextEncoding,
		data: mainData,
	}

	const mainEntry = sidecarEntryFor(document.mainResource, document.extra)
	if (mainEntry !== undefined) {
		sidecarEntries.set(mainContentId, mainEntry)
	}

	return { parts: [mainPart, ...subresourceParts, ...childParts], rootContentId: mainContentId }
}

/**
 * Converts a {@link WebArchiveDocument} into a canonical {@link MhtmlDocument}.
 * Always succeeds with a document for a *well-formed* input tree (flattening
 * one has no "unparseable envelope" failure mode the way parsing bytes does);
 * diagnostics report degraded behavior (an iframe that couldn't be resolved
 * to a captured subframe, a truncated recursion, an iframe rewrite that
 * couldn't be safely re-encoded in the document's original charset) without
 * failing the conversion.
 *
 * The one exception is a model that violates the `WebArchiveResource`/
 * `WebArchiveDocument` contract itself: an `extra` claiming a key the typed
 * fields already own makes `buildSidecarPart` throw, exactly as it makes
 * `serializeWebArchive` throw. That is unreachable from any parsed archive —
 * `parseWebArchive` subtracts the reserved keys when collecting `extra`, and
 * `parseSidecarPart` rejects a foreign sidecar that supplies one — so it
 * signals a programming error in a hand-constructed model, not bad input.
 */
export function convertWebArchiveToMhtml(document: WebArchiveDocument): { readonly document: MhtmlDocument; readonly diagnostics: readonly Diagnostic[] } {
	const diagnostics: Diagnostic[] = []
	const sidecarEntries = new Map<string, SidecarResourceEntry>()

	const { parts, rootContentId } = flattenDocument(document, 0, diagnostics, sidecarEntries)
	const allParts = [...parts]

	if (sidecarEntries.size > 0) {
		allParts.push(buildSidecarPart(sidecarEntries))
	}

	const rootPartIndex = allParts.findIndex((part) => part.contentId === rootContentId)

	return { document: { parts: allParts, rootPartIndex }, diagnostics }
}
