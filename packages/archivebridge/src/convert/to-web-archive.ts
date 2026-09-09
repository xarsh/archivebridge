/**
 * MHTML -> WebArchive: the inverse of `to-mhtml.ts`. Finds `cid:`-referenced
 * `text/html` parts via `mhtml/frames.ts`, recursively rebuilds
 * `WebSubframeArchives`, rewrites each `cid:` reference in the emitted HTML
 * back to a plain resolved URL (WebArchive's `<iframe src>` is never
 * `cid:`-rewritten in real Safari/WebKit output), and reads the metadata
 * sidecar (if present) to repopulate `WebResourceResponse`/
 * `WebResourceFrameName`/`extra`. See docs/architecture.md, "Frame
 * representation" and "Direct WebArchive <-> MHTML conversion".
 *
 * **Subresource ownership is not a structural property of flat MHTML** —
 * unlike WebArchive, where every document level has its own explicit
 * `WebSubresources` array, MHTML has no field recording "this part belongs
 * to that frame" (docs/architecture.md, "Frame representation"). This
 * converter recovers it with a heuristic: each non-frame-root part is
 * assigned to the nearest preceding frame-root part in document order.
 * This exactly reconstructs the tree `to-mhtml.ts` produces (which
 * deliberately emits each frame's own parts contiguously, right after that
 * frame's main part, for this reason) and is a reasonable best-effort
 * grouping for other real MHTML too, but it is not a lossless inverse for
 * arbitrary foreign MHTML that interleaves resources across frames in a
 * different order — nothing is dropped in that case, a part just ends up
 * grouped under a different frame than a byte-identical origin capture
 * might have used.
 */

import { buildFrameTree, decodeCidUri, encodeCidUri, findFrameRootReferences, groupPartsByFrame, indexContentIds, type MhtmlFrameNode } from '../mhtml/frames.ts'
import { findFrameSrcLocations, rewriteFrameSrcAttributes } from '../mhtml/html-rewrite.ts'
import { findSidecarPart, findSidecarPartIndices, parseSidecarPart, type SidecarData } from '../mhtml/sidecar.ts'
import { isSafelyReencodable, textCodecFor } from '../mhtml/text-codec.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'

/**
 * A part's Content-Location if it has one, else a synthetic `cid:` URL (the
 * same fallback convention `MhtmlPart.location`'s own doc comment describes
 * for inline content with no natural URL). A part with *neither* a
 * Content-Location nor a Content-ID has no real identity to report at all —
 * `WebArchiveResource.url` is a required `string`, so this falls back to a
 * synthetic, per-part-index placeholder (never colliding with a real URL or
 * with another identity-less part's placeholder) and reports a diagnostic
 * every time, rather than silently returning `''` (which every identity-less
 * part in one document would share, itself an unreported
 * `duplicate-content-location`-shaped bug). The placeholder uses the `about:`
 * scheme deliberately: it is not a fetchable URL, consistent with an archive
 * never triggering a network request for a resource this converter had to
 * invent an identity for (docs/architecture.md#security-assumptions).
 */
function resourceUrlFor(part: MhtmlPart, partIndex: number, diagnostics: Diagnostic[]): string {
	if (part.location !== undefined) {
		return part.location
	}
	if (part.contentId !== undefined) {
		return encodeCidUri(part.contentId)
	}
	const placeholder = `about:archivebridge-unidentified-part-${partIndex}`
	diagnostics.push({
		type: 'malformed-resource',
		url: placeholder,
		message: 'MHTML part has neither a Content-Location nor a Content-ID; assigned a synthetic placeholder identity',
	})
	return placeholder
}

function partToWebArchiveResource(part: MhtmlPart, partIndex: number, sidecarData: SidecarData | undefined, diagnostics: Diagnostic[]): WebArchiveResource {
	const entry = part.contentId !== undefined ? sidecarData?.get(part.contentId) : undefined
	return {
		url: resourceUrlFor(part, partIndex, diagnostics),
		mimeType: part.mimeType,
		data: part.data,
		textEncoding: part.textEncoding,
		// Preserved whenever the sidecar explicitly carries it, regardless of whether this
		// part is currently resolved as a frame root: WebResourceFrameName has only ever been
		// observed on frame-root resources in real WebKit output, but ArchiveBridge's own
		// tolerant-preservation stance (docs/architecture.md, "Semantic losslessness") means a
		// value that was genuinely written to the sidecar for this Content-ID must round-trip
		// back out, not be discarded on the assumption that it "shouldn't" be there.
		frameName: entry?.webResourceFrameName,
		response: entry?.webResourceResponse,
		extra: entry?.resourceExtra ?? new Map(),
	}
}

/**
 * Converts a {@link MhtmlDocument} into a {@link WebArchiveDocument}. Always
 * succeeds with a document; diagnostics report degraded behavior (an
 * unresolved `cid:` reference, a truncated recursion, a malformed or
 * ambiguous sidecar) without failing the conversion — a foreign MHTML with
 * no sidecar at all is the common case and degrades to simply having no
 * residual `WebResourceResponse`/`WebResourceFrameName`/`extra` anywhere,
 * not an error (docs/architecture.md, "Metadata sidecar").
 */
export function convertMhtmlToWebArchive(document: MhtmlDocument): { readonly document: WebArchiveDocument; readonly diagnostics: readonly Diagnostic[] } {
	const diagnostics: Diagnostic[] = []

	const sidecarResult = findSidecarPart(document, diagnostics)
	const sidecarData = sidecarResult !== undefined ? parseSidecarPart(sidecarResult.part, diagnostics) : undefined

	const adjacency = findFrameRootReferences(document, diagnostics)
	const frameTree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)
	// Every part matching the sidecar media type is excluded here — not just the single part
	// `findSidecarPart` resolved — so a duplicate or malformed sidecar part never falls through
	// to being grouped as an ordinary page resource (docs/architecture.md, "The sidecar is
	// auxiliary archive metadata, not a saved-page resource").
	const resourceIndicesByOwner = groupPartsByFrame(document, frameTree, new Set(findSidecarPartIndices(document)))

	// Shares `findFrameRootReferences`'s own ambiguity analysis (mhtml/frames.ts) rather than
	// re-deriving it independently: a Content-ID claimed by more than one part must never resolve
	// a `cid:` reference to whichever part happened to be indexed last, and — since
	// `findFrameRootReferences` above already scanned every `text/html` part in the whole document
	// (not just ones reachable from the root) and reported `duplicate-content-id` for every
	// ambiguous Content-ID actually referenced by a frame `src` — this rewrite below must not
	// re-report the same ambiguous Content-ID a second time.
	const { indexByContentId: partIndexByContentId, ambiguousContentIds } = indexContentIds(document)

	function buildDocument(node: MhtmlFrameNode): WebArchiveDocument {
		const mainPart = document.parts[node.partIndex]
		if (mainPart === undefined) {
			throw new Error('convertMhtmlToWebArchive: frame tree referenced a part index outside document.parts')
		}

		let mainData = mainPart.data
		if (mainPart.mimeType.toLowerCase() === 'text/html') {
			const codec = textCodecFor(mainPart.textEncoding)
			const originalHtml = codec.decode(mainPart.data)
			const hasFrameSrc = findFrameSrcLocations(originalHtml).length > 0
			if (hasFrameSrc && !isSafelyReencodable(codec, mainPart.data)) {
				// This part's original bytes cannot be safely round-tripped through its own
				// declared encoding (e.g. a stripped BOM, or a malformed byte sequence tolerantly
				// decoded to U+FFFD) — rewriting even just the frame-src attribute would require
				// re-encoding the *whole* document, silently normalizing bytes the edit never
				// touched. Refuse the rewrite entirely rather than partially applying it; the
				// `cid:` reference is left exactly as it was, unresolved to any URL.
				diagnostics.push({ type: 'unsupported-encoding', encoding: mainPart.textEncoding ?? 'utf-8' })
			} else if (hasFrameSrc) {
				const rewrittenHtml = rewriteFrameSrcAttributes(originalHtml, (currentValue) => {
					const cid = decodeCidUri(currentValue)
					if (cid === undefined) {
						return undefined
					}
					if (ambiguousContentIds.has(cid)) {
						// `findFrameRootReferences` already scanned every `text/html` part in the
						// document (not just this reachable subtree) and reported
						// `duplicate-content-id` once for every ambiguous Content-ID actually
						// referenced by a frame `src` — reporting it again here would duplicate
						// that diagnostic for the same logical ambiguity.
						diagnostics.push({ type: 'unresolved-resource', url: currentValue })
						return undefined
					}
					const targetIndex = partIndexByContentId.get(cid)
					const target = targetIndex === undefined ? undefined : document.parts[targetIndex]
					if (target === undefined || targetIndex === undefined) {
						diagnostics.push({ type: 'unresolved-resource', url: currentValue })
						return undefined
					}
					return resourceUrlFor(target, targetIndex, diagnostics)
				})
				if (rewrittenHtml !== originalHtml) {
					const encoded = codec.encode(rewrittenHtml)
					if (encoded !== undefined) {
						mainData = encoded
					} else {
						diagnostics.push({ type: 'unsupported-encoding', encoding: mainPart.textEncoding ?? 'utf-8' })
					}
				}
			}
		}

		const mainResource = partToWebArchiveResource({ ...mainPart, data: mainData }, node.partIndex, sidecarData, diagnostics)
		const subresources = (resourceIndicesByOwner.get(node.partIndex) ?? [])
			.map((index) => ({ index, part: document.parts[index] }))
			.filter((entry): entry is { index: number; part: MhtmlPart } => entry.part !== undefined)
			.map(({ index, part }) => partToWebArchiveResource(part, index, sidecarData, diagnostics))
		const subframeArchives = node.children.map(buildDocument)
		const entry = mainPart.contentId !== undefined ? sidecarData?.get(mainPart.contentId) : undefined

		return { mainResource, subresources, subframeArchives, extra: entry?.documentExtra ?? new Map() }
	}

	return { document: buildDocument(frameTree), diagnostics }
}
